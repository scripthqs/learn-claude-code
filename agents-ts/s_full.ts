/**
 * s_full.ts - Full Reference Agent
 *
 * Capstone implementation combining every mechanism from s01-s11.
 * Session s12 (task-aware worktree isolation) is taught separately.
 * NOT a teaching session -- this is the "put it all together" reference.
 *
 *     +------------------------------------------------------------------+
 *     |                        FULL AGENT                                 |
 *     |                                                                   |
 *     |  System prompt (s05 skills, task-first + optional todo nag)      |
 *     |                                                                   |
 *     |  Before each LLM call:                                            |
 *     |  +--------------------+  +------------------+  +--------------+  |
 *     |  | Microcompact (s06) |  | Drain bg (s08)   |  | Check inbox  |  |
 *     |  | Auto-compact (s06) |  | notifications    |  | (s09)        |  |
 *     |  +--------------------+  +------------------+  +--------------+  |
 *     |                                                                   |
 *     |  Tool dispatch (s02 pattern):                                     |
 *     |  +--------+----------+----------+---------+-----------+          |
 *     |  | bash   | read     | write    | edit    | TodoWrite |          |
 *     |  | task   | load_sk  | compress | bg_run  | bg_check  |          |
 *     |  | t_crt  | t_get    | t_upd    | t_list  | spawn_tm  |          |
 *     |  | list_tm| send_msg | rd_inbox | bcast   | shutdown  |          |
 *     |  | plan   | idle     | claim    |         |           |          |
 *     |  +--------+----------+----------+---------+-----------+          |
 *     |                                                                   |
 *     |  Subagent (s04):  spawn -> work -> return summary                 |
 *     |  Teammate (s09):  spawn -> work -> idle -> auto-claim (s11)      |
 *     |  Shutdown (s10):  request_id handshake                            |
 *     |  Plan gate (s10): submit -> approve/reject                        |
 *     +------------------------------------------------------------------+
 *
 *     REPL commands: /compact /tasks /team /inbox
 */

import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import readline from "readline";
import { v4 as uuidv4 } from "uuid";
import * as dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../.env"), override: true });

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

// ============================================================
// === SECTION: constants ===
// ============================================================

const WORKDIR = process.cwd();
const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
  apiKey: process.env.ANTHROPIC_API_KEY,
});
const MODEL = process.env.MODEL_ID!;

const TEAM_DIR = path.join(WORKDIR, ".team");
const INBOX_DIR = path.join(TEAM_DIR, "inbox");
const TASKS_DIR = path.join(WORKDIR, ".tasks");
const SKILLS_DIR = path.join(WORKDIR, "skills");
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");

const TOKEN_THRESHOLD = 100_000;
const POLL_INTERVAL = 5_000; // ms
const IDLE_TIMEOUT = 60_000; // ms

const VALID_MSG_TYPES = new Set(["message", "broadcast", "shutdown_request", "shutdown_response", "plan_approval_response"]);

// ============================================================
// === SECTION: types ===
// ============================================================

type TodoStatus = "pending" | "in_progress" | "completed";
type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";
type MemberStatus = "working" | "idle" | "shutdown";

type TodoItem = {
  content: string;
  status: TodoStatus;
  activeForm: string;
};

type Task = {
  id: number;
  subject: string;
  description: string;
  status: TaskStatus;
  owner: string | null;
  blockedBy: number[];
  blocks: number[];
};

type TeamMember = {
  name: string;
  role: string;
  status: MemberStatus;
};

type TeamConfig = {
  team_name: string;
  members: TeamMember[];
};

type BgTask = {
  status: "running" | "completed" | "error" | "timeout";
  command: string;
  result: string | null;
};

type BgNotification = {
  task_id: string;
  status: string;
  result: string;
};

type Message = {
  type: string;
  from: string;
  content: string;
  timestamp: number;
  [key: string]: any;
};

type ShutdownRecord = { target: string; status: "pending" | "approved" | "rejected" };
type PlanRecord = { from: string; plan: string; status: "pending" | "approved" | "rejected" };

// ============================================================
// === SECTION: base_tools ===
// ============================================================

function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(path.resolve(WORKDIR))) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

function runBash(command: string): Promise<string> {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return Promise.resolve("Error: Dangerous command blocked");
  }
  return new Promise((resolve) => {
    exec(command, { cwd: WORKDIR, timeout: 120_000, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err?.killed) return resolve("Error: Timeout (120s)");
      const out = ((stdout || "") + (stderr || "")).trim();
      resolve(out ? out.slice(0, 50000) : "(no output)");
    });
  });
}

function runRead(p: string, limit?: number): string {
  try {
    const content = fs.readFileSync(safePath(p), "utf8");
    const lines = content.split(/\r?\n/);
    if (limit && limit < lines.length) {
      return lines
        .slice(0, limit)
        .concat([`... (${lines.length - limit} more)`])
        .join("\n")
        .slice(0, 50000);
    }
    return content.slice(0, 50000);
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

function runWrite(p: string, content: string): string {
  try {
    const fp = safePath(p);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, "utf8");
    return `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${p}`;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

function runEdit(p: string, oldText: string, newText: string): string {
  try {
    const fp = safePath(p);
    const c = fs.readFileSync(fp, "utf8");
    if (!c.includes(oldText)) return `Error: Text not found in ${p}`;
    fs.writeFileSync(fp, c.replace(oldText, newText), "utf8");
    return `Edited ${p}`;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

// ============================================================
// === SECTION: todos (s03) ===
// ============================================================

class TodoManager {
  private items: TodoItem[] = [];

  update(items: TodoItem[]): string {
    let inProgress = 0;
    const validated: TodoItem[] = [];

    for (let i = 0; i < items.length; i++) {
      const content = String(items[i]?.content ?? "").trim();
      const status = String(items[i]?.status ?? "pending").toLowerCase() as TodoStatus;
      const activeForm = String(items[i]?.activeForm ?? "").trim();

      if (!content) throw new Error(`Item ${i}: content required`);
      if (!["pending", "in_progress", "completed"].includes(status)) throw new Error(`Item ${i}: invalid status '${status}'`);
      if (!activeForm) throw new Error(`Item ${i}: activeForm required`);
      if (status === "in_progress") inProgress++;

      validated.push({ content, status, activeForm });
    }

    if (validated.length > 20) throw new Error("Max 20 todos");
    if (inProgress > 1) throw new Error("Only one in_progress allowed");

    this.items = validated;
    return this.render();
  }

  render(): string {
    if (!this.items.length) return "No todos.";
    const lines = this.items.map((item) => {
      const m = { completed: "[x]", in_progress: "[>]", pending: "[ ]" }[item.status] ?? "[?]";
      const suffix = item.status === "in_progress" ? ` <- ${item.activeForm}` : "";
      return `${m} ${item.content}${suffix}`;
    });
    const done = this.items.filter((t) => t.status === "completed").length;
    lines.push(`\n(${done}/${this.items.length} completed)`);
    return lines.join("\n");
  }

  hasOpenItems(): boolean {
    return this.items.some((item) => item.status !== "completed");
  }
}

// ============================================================
// === SECTION: subagent (s04) ===
// ============================================================

async function runSubagent(prompt: string, agentType: string = "Explore"): Promise<string> {
  const subTools: any[] = [
    {
      name: "bash",
      description: "Run command.",
      input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
    {
      name: "read_file",
      description: "Read file.",
      input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  ];

  if (agentType !== "Explore") {
    subTools.push(
      {
        name: "write_file",
        description: "Write file.",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
      },
      {
        name: "edit_file",
        description: "Edit file.",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } },
          required: ["path", "old_text", "new_text"],
        },
      },
    );
  }

  const subHandlers: Record<string, (...a: any[]) => any> = {
    bash: async ({ command }: any) => await runBash(command),
    read_file: ({ path: p }: any) => runRead(p),
    write_file: ({ path: p, content }: any) => runWrite(p, content),
    edit_file: ({ path: p, old_text: o, new_text: n }: any) => runEdit(p, o, n),
  };

  const subMsgs: any[] = [{ role: "user", content: prompt }];
  let lastResponse: any = null;

  for (let i = 0; i < 30; i++) {
    const resp = await client.messages.create({
      model: MODEL,
      messages: subMsgs,
      tools: subTools,
      max_tokens: 8000,
    });
    subMsgs.push({ role: "assistant", content: resp.content });
    lastResponse = resp;

    if (resp.stop_reason !== "tool_use") break;

    const results: any[] = [];
    for (const b of resp.content) {
      if (b.type === "tool_use") {
        const h = subHandlers[b.name] ?? (() => "Unknown tool");
        let out: string;
        try {
          out = String(await h(b.input)).slice(0, 50000);
        } catch (e: any) {
          out = `Error: ${e.message}`;
        }
        results.push({ type: "tool_result", tool_use_id: b.id, content: out });
      }
    }
    subMsgs.push({ role: "user", content: results });
  }

  if (lastResponse) {
    return (
      lastResponse.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("") || "(no summary)"
    );
  }
  return "(subagent failed)";
}

// ============================================================
// === SECTION: skills (s05) ===
// ============================================================

type Skill = { meta: Record<string, string>; body: string };

class SkillLoader {
  private skills: Record<string, Skill> = {};

  constructor(skillsDir: string) {
    if (!fs.existsSync(skillsDir)) return;

    const findSkillFiles = (dir: string): string[] => {
      const results: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) results.push(...findSkillFiles(full));
        else if (entry.name === "SKILL.md") results.push(full);
      }
      return results;
    };

    for (const file of findSkillFiles(skillsDir).sort()) {
      const text = fs.readFileSync(file, "utf8");
      const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)/);
      const meta: Record<string, string> = {};
      let body = text;

      if (match) {
        for (const line of match[1].trim().split("\n")) {
          const idx = line.indexOf(":");
          if (idx !== -1) {
            meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
          }
        }
        body = match[2].trim();
      }

      const name = meta.name ?? path.basename(path.dirname(file));
      this.skills[name] = { meta, body };
    }
  }

  descriptions(): string {
    if (!Object.keys(this.skills).length) return "(no skills)";
    return Object.entries(this.skills)
      .map(([n, s]) => `  - ${n}: ${s.meta.description ?? "-"}`)
      .join("\n");
  }

  load(name: string): string {
    const s = this.skills[name];
    if (!s) {
      return `Error: Unknown skill '${name}'. Available: ${Object.keys(this.skills).join(", ")}`;
    }
    return `<skill name="${name}">\n${s.body}\n</skill>`;
  }
}

// ============================================================
// === SECTION: compression (s06) ===
// ============================================================

function estimateTokens(messages: any[]): number {
  return Math.floor(JSON.stringify(messages).length / 4);
}

function microcompact(messages: any[]): void {
  // Collect all tool_result parts
  const parts: any[] = [];
  for (const msg of messages) {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part?.type === "tool_result") parts.push(part);
      }
    }
  }
  // Keep only last 3, clear the rest
  if (parts.length <= 3) return;
  for (const part of parts.slice(0, -3)) {
    if (typeof part.content === "string" && part.content.length > 100) {
      part.content = "[cleared]";
    }
  }
}

async function autoCompact(messages: any[]): Promise<any[]> {
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const transcriptPath = path.join(TRANSCRIPT_DIR, `transcript_${Date.now()}.jsonl`);
  const lines = messages.map((m) => JSON.stringify(m)).join("\n");
  fs.writeFileSync(transcriptPath, lines, "utf8");

  const convText = JSON.stringify(messages).slice(0, 80000);
  const resp = await client.messages.create({
    model: MODEL,
    messages: [{ role: "user", content: `Summarize for continuity:\n${convText}` }],
    max_tokens: 2000,
  });

  const summary = (resp.content[0] as any).text;
  return [
    { role: "user", content: `[Compressed. Transcript: ${transcriptPath}]\n${summary}` },
    { role: "assistant", content: "Understood. Continuing with summary context." },
  ];
}

// ============================================================
// === SECTION: file_tasks (s07) ===
// ============================================================

class TaskManager {
  constructor() {
    fs.mkdirSync(TASKS_DIR, { recursive: true });
  }

  private nextId(): number {
    const files = fs.readdirSync(TASKS_DIR).filter((f) => f.match(/^task_\d+\.json$/));
    const ids = files.map((f) => parseInt(f.replace("task_", "").replace(".json", ""), 10));
    return (ids.length ? Math.max(...ids) : 0) + 1;
  }

  private taskPath(tid: number): string {
    return path.join(TASKS_DIR, `task_${tid}.json`);
  }

  private load(tid: number): Task {
    const p = this.taskPath(tid);
    if (!fs.existsSync(p)) throw new Error(`Task ${tid} not found`);
    return JSON.parse(fs.readFileSync(p, "utf8"));
  }

  private save(task: Task): void {
    fs.writeFileSync(this.taskPath(task.id), JSON.stringify(task, null, 2), "utf8");
  }

  create(subject: string, description: string = ""): string {
    const task: Task = {
      id: this.nextId(),
      subject,
      description,
      status: "pending",
      owner: null,
      blockedBy: [],
      blocks: [],
    };
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  get(tid: number): string {
    return JSON.stringify(this.load(tid), null, 2);
  }

  update(tid: number, status?: string, addBlockedBy?: number[], addBlocks?: number[]): string {
    const task = this.load(tid);

    if (status) {
      task.status = status as TaskStatus;

      if (status === "completed") {
        // Remove this task from other tasks' blockedBy lists
        const files = fs.readdirSync(TASKS_DIR).filter((f) => f.match(/^task_\d+\.json$/));
        for (const file of files) {
          const t: Task = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, file), "utf8"));
          if (t.blockedBy.includes(tid)) {
            t.blockedBy = t.blockedBy.filter((id) => id !== tid);
            fs.writeFileSync(path.join(TASKS_DIR, file), JSON.stringify(t, null, 2), "utf8");
          }
        }
      }

      if (status === "deleted") {
        fs.rmSync(this.taskPath(tid), { force: true });
        return `Task ${tid} deleted`;
      }
    }

    if (addBlockedBy?.length) {
      task.blockedBy = [...new Set([...task.blockedBy, ...addBlockedBy])];
    }
    if (addBlocks?.length) {
      task.blocks = [...new Set([...task.blocks, ...addBlocks])];
    }

    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  listAll(): string {
    const files = fs
      .readdirSync(TASKS_DIR)
      .filter((f) => f.match(/^task_\d+\.json$/))
      .sort();
    if (!files.length) return "No tasks.";

    return files
      .map((file) => {
        const t: Task = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, file), "utf8"));
        const m = ({ pending: "[ ]", in_progress: "[>]", completed: "[x]" } as Record<string, string>)[t.status] ?? "[?]";
        const owner = t.owner ? ` @${t.owner}` : "";
        const blocked = t.blockedBy?.length ? ` (blocked by: ${JSON.stringify(t.blockedBy)})` : "";
        return `${m} #${t.id}: ${t.subject}${owner}${blocked}`;
      })
      .join("\n");
  }

  claim(tid: number, owner: string): string {
    const task = this.load(tid);
    task.owner = owner;
    task.status = "in_progress";
    this.save(task);
    return `Claimed task #${tid} for ${owner}`;
  }
}

// ============================================================
// === SECTION: background (s08) ===
// ============================================================

class BackgroundManager {
  private tasks: Record<string, BgTask> = {};
  private notificationQueue: BgNotification[] = [];
  // Node.js is single-threaded; callbacks push to this array safely

  run(command: string, timeout: number = 120): string {
    const tid = uuidv4().slice(0, 8);
    this.tasks[tid] = { status: "running", command, result: null };

    exec(command, { cwd: WORKDIR, timeout: timeout * 1000, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      let output: string;
      let status: BgTask["status"];

      if (err?.killed) {
        output = `Error: Timeout (${timeout}s)`;
        status = "timeout";
      } else if (err && !stdout && !stderr) {
        output = `Error: ${err.message}`;
        status = "error";
      } else {
        output = ((stdout || "") + (stderr || "")).trim().slice(0, 50000) || "(no output)";
        status = "completed";
      }

      this.tasks[tid].status = status;
      this.tasks[tid].result = output;
      this.notificationQueue.push({ task_id: tid, status, result: output.slice(0, 500) });
    });

    return `Background task ${tid} started: ${command.slice(0, 80)}`;
  }

  check(tid?: string): string {
    if (tid) {
      const t = this.tasks[tid];
      if (!t) return `Unknown: ${tid}`;
      return `[${t.status}] ${t.result ?? "(running)"}`;
    }
    const entries = Object.entries(this.tasks);
    if (!entries.length) return "No bg tasks.";
    return entries.map(([k, v]) => `${k}: [${v.status}] ${v.command.slice(0, 60)}`).join("\n");
  }

  drain(): BgNotification[] {
    // splice(0) atomically reads and clears — safe in single-threaded Node.js
    return this.notificationQueue.splice(0);
  }
}

// ============================================================
// === SECTION: messaging (s09) ===
// ============================================================

class MessageBus {
  constructor() {
    fs.mkdirSync(INBOX_DIR, { recursive: true });
  }

  send(sender: string, to: string, content: string, msgType: string = "message", extra: Record<string, any> = {}): string {
    const msg: Message = {
      type: msgType,
      from: sender,
      content,
      timestamp: Date.now() / 1000,
      ...extra,
    };
    fs.appendFileSync(path.join(INBOX_DIR, `${to}.jsonl`), JSON.stringify(msg) + "\n", "utf8");
    return `Sent ${msgType} to ${to}`;
  }

  readInbox(name: string): Message[] {
    const p = path.join(INBOX_DIR, `${name}.jsonl`);
    if (!fs.existsSync(p)) return [];
    const msgs = fs
      .readFileSync(p, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean) as Message[];
    fs.writeFileSync(p, "", "utf8"); // drain
    return msgs;
  }

  broadcast(sender: string, content: string, names: string[]): string {
    let count = 0;
    for (const n of names) {
      if (n !== sender) {
        this.send(sender, n, content, "broadcast");
        count++;
      }
    }
    return `Broadcast to ${count} teammates`;
  }
}

// ============================================================
// === SECTION: shutdown + plan tracking (s10) ===
// ============================================================

const shutdownRequests: Record<string, ShutdownRecord> = {};
const planRequests: Record<string, PlanRecord> = {};

// ============================================================
// === SECTION: team (s09/s11) ===
// ============================================================

class TeammateManager {
  private config: TeamConfig;
  private configPath: string;

  constructor(
    private bus: MessageBus,
    private taskMgr: TaskManager,
  ) {
    fs.mkdirSync(TEAM_DIR, { recursive: true });
    this.configPath = path.join(TEAM_DIR, "config.json");
    this.config = this.loadConfig();
  }

  private loadConfig(): TeamConfig {
    if (fs.existsSync(this.configPath)) {
      return JSON.parse(fs.readFileSync(this.configPath, "utf8"));
    }
    return { team_name: "default", members: [] };
  }

  private saveConfig(): void {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), "utf8");
  }

  private findMember(name: string): TeamMember | undefined {
    return this.config.members.find((m) => m.name === name);
  }

  private setStatus(name: string, status: MemberStatus): void {
    const m = this.findMember(name);
    if (m) {
      m.status = status;
      this.saveConfig();
    }
  }

  spawn(name: string, role: string, prompt: string): string {
    const member = this.findMember(name);
    if (member) {
      if (member.status !== "idle" && member.status !== "shutdown") {
        return `Error: '${name}' is currently ${member.status}`;
      }
      member.status = "working";
      member.role = role;
    } else {
      this.config.members.push({ name, role, status: "working" });
    }
    this.saveConfig();

    // Fire and forget — runs as independent async task
    this.loop(name, role, prompt).catch((e) => console.error(`[${name}] error:`, e));
    return `Spawned '${name}' (role: ${role})`;
  }

  private async loop(name: string, role: string, prompt: string): Promise<void> {
    const teamName = this.config.team_name;
    const sysPrompt =
      `You are '${name}', role: ${role}, team: ${teamName}, at ${WORKDIR}. ` +
      `Use idle when done with current work. You may auto-claim tasks.`;
    const messages: any[] = [{ role: "user", content: prompt }];
    const tools = this.teammateTools();

    while (true) {
      // -- WORK PHASE --
      let idleRequested = false;

      for (let i = 0; i < 50; i++) {
        const inbox = this.bus.readInbox(name);
        for (const msg of inbox) {
          if (msg.type === "shutdown_request") {
            this.setStatus(name, "shutdown");
            return;
          }
          messages.push({ role: "user", content: JSON.stringify(msg) });
        }

        let response: any;
        try {
          response = await client.messages.create({
            model: MODEL,
            system: sysPrompt,
            messages,
            tools: tools as any,
            max_tokens: 8000,
          });
        } catch {
          this.setStatus(name, "shutdown");
          return;
        }

        messages.push({ role: "assistant", content: response.content });
        if (response.stop_reason !== "tool_use") break;

        const results: any[] = [];
        for (const block of response.content) {
          if (block.type !== "tool_use") continue;

          let output: string;
          if (block.name === "idle") {
            idleRequested = true;
            output = "Entering idle phase.";
          } else if (block.name === "claim_task") {
            output = this.taskMgr.claim(block.input.task_id, name);
          } else if (block.name === "send_message") {
            output = this.bus.send(name, block.input.to, block.input.content);
          } else {
            const dispatch: Record<string, (...a: any[]) => any> = {
              bash: async ({ command }: any) => await runBash(command),
              read_file: ({ path: p }: any) => runRead(p),
              write_file: ({ path: p, content }: any) => runWrite(p, content),
              edit_file: ({ path: p, old_text: o, new_text: n }: any) => runEdit(p, o, n),
            };
            try {
              output = String(await (dispatch[block.name] ?? (() => "Unknown tool"))(block.input));
            } catch (e: any) {
              output = `Error: ${e.message}`;
            }
          }

          console.log(`  [${name}] ${block.name}: ${String(output).slice(0, 120)}`);
          results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
        }
        messages.push({ role: "user", content: results });
        if (idleRequested) break;
      }

      // -- IDLE PHASE: poll inbox and task board --
      this.setStatus(name, "idle");
      let resume = false;
      const polls = Math.floor(IDLE_TIMEOUT / POLL_INTERVAL);

      for (let p = 0; p < polls; p++) {
        await sleep(POLL_INTERVAL);

        const inbox = this.bus.readInbox(name);
        if (inbox.length) {
          for (const msg of inbox) {
            if (msg.type === "shutdown_request") {
              this.setStatus(name, "shutdown");
              return;
            }
            messages.push({ role: "user", content: JSON.stringify(msg) });
          }
          resume = true;
          break;
        }

        const unclaimed = scanUnclaimedTasks();
        if (unclaimed.length) {
          const task = unclaimed[0];
          this.taskMgr.claim(task.id, name);

          // Identity re-injection for compressed contexts
          if (messages.length <= 3) {
            messages.unshift(
              {
                role: "user",
                content: `<identity>You are '${name}', role: ${role}, team: ${teamName}.</identity>`,
              },
              { role: "assistant", content: `I am ${name}. Continuing.` },
            );
          }

          messages.push({
            role: "user",
            content: `<auto-claimed>Task #${task.id}: ${task.subject}\n${task.description ?? ""}</auto-claimed>`,
          });
          messages.push({
            role: "assistant",
            content: `Claimed task #${task.id}. Working on it.`,
          });
          resume = true;
          break;
        }
      }

      if (!resume) {
        this.setStatus(name, "shutdown");
        return;
      }
      this.setStatus(name, "working");
    }
  }

  private teammateTools(): object[] {
    return [
      {
        name: "bash",
        description: "Run command.",
        input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
      {
        name: "read_file",
        description: "Read file.",
        input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
      {
        name: "write_file",
        description: "Write file.",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
      },
      {
        name: "edit_file",
        description: "Edit file.",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } },
          required: ["path", "old_text", "new_text"],
        },
      },
      {
        name: "send_message",
        description: "Send message.",
        input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" } }, required: ["to", "content"] },
      },
      { name: "idle", description: "Signal no more work.", input_schema: { type: "object", properties: {} } },
      {
        name: "claim_task",
        description: "Claim task by ID.",
        input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] },
      },
    ];
  }

  listAll(): string {
    if (!this.config.members.length) return "No teammates.";
    const lines = [`Team: ${this.config.team_name}`];
    for (const m of this.config.members) {
      lines.push(`  ${m.name} (${m.role}): ${m.status}`);
    }
    return lines.join("\n");
  }

  memberNames(): string[] {
    return this.config.members.map((m) => m.name);
  }
}

// ============================================================
// === SECTION: helpers ===
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scanUnclaimedTasks(): Task[] {
  if (!fs.existsSync(TASKS_DIR)) return [];
  return fs
    .readdirSync(TASKS_DIR)
    .filter((f) => f.match(/^task_\d+\.json$/))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), "utf8")) as Task)
    .filter((t) => t.status === "pending" && !t.owner && !t.blockedBy?.length);
}

// ============================================================
// === SECTION: global_instances ===
// ============================================================

const TODO = new TodoManager();
const SKILLS = new SkillLoader(SKILLS_DIR);
const TASK_MGR = new TaskManager();
const BG = new BackgroundManager();
const BUS = new MessageBus();
const TEAM = new TeammateManager(BUS, TASK_MGR);

// ============================================================
// === SECTION: system_prompt ===
// ============================================================

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.
Prefer task_create/task_update/task_list for multi-step work. Use TodoWrite for short checklists.
Use task for subagent delegation. Use load_skill for specialized knowledge.
Skills: ${SKILLS.descriptions()}`;

// ============================================================
// === SECTION: shutdown_protocol (s10) ===
// ============================================================

function handleShutdownRequest(teammate: string): string {
  const reqId = uuidv4().slice(0, 8);
  shutdownRequests[reqId] = { target: teammate, status: "pending" };
  BUS.send("lead", teammate, "Please shut down.", "shutdown_request", { request_id: reqId });
  return `Shutdown request ${reqId} sent to '${teammate}'`;
}

// ============================================================
// === SECTION: plan_approval (s10) ===
// ============================================================

function handlePlanReview(requestId: string, approve: boolean, feedback: string = ""): string {
  const req = planRequests[requestId];
  if (!req) return `Error: Unknown plan request_id '${requestId}'`;
  req.status = approve ? "approved" : "rejected";
  BUS.send("lead", req.from, feedback, "plan_approval_response", {
    request_id: requestId,
    approve,
    feedback,
  });
  return `Plan ${req.status} for '${req.from}'`;
}

// ============================================================
// === SECTION: tool_dispatch (s02) ===
// ============================================================

const TOOL_HANDLERS: Record<string, (...args: any[]) => any> = {
  bash: async ({ command }: any) => await runBash(command),
  read_file: ({ path: p, limit }: any) => runRead(p, limit),
  write_file: ({ path: p, content }: any) => runWrite(p, content),
  edit_file: ({ path: p, old_text: o, new_text: n }: any) => runEdit(p, o, n),
  TodoWrite: ({ items }: any) => TODO.update(items),
  task: async ({ prompt, agent_type }: any) => await runSubagent(prompt, agent_type ?? "Explore"),
  load_skill: ({ name }: any) => SKILLS.load(name),
  compress: () => "Compressing...",
  background_run: ({ command, timeout }: any) => BG.run(command, timeout ?? 120),
  check_background: ({ task_id }: any) => BG.check(task_id),
  task_create: ({ subject, description }: any) => TASK_MGR.create(subject, description ?? ""),
  task_get: ({ task_id }: any) => TASK_MGR.get(task_id),
  task_update: ({ task_id, status, add_blocked_by, add_blocks }: any) => TASK_MGR.update(task_id, status, add_blocked_by, add_blocks),
  task_list: () => TASK_MGR.listAll(),
  spawn_teammate: ({ name, role, prompt }: any) => TEAM.spawn(name, role, prompt),
  list_teammates: () => TEAM.listAll(),
  send_message: ({ to, content, msg_type }: any) => BUS.send("lead", to, content, msg_type ?? "message"),
  read_inbox: () => JSON.stringify(BUS.readInbox("lead"), null, 2),
  broadcast: ({ content }: any) => BUS.broadcast("lead", content, TEAM.memberNames()),
  shutdown_request: ({ teammate }: any) => handleShutdownRequest(teammate),
  plan_approval: ({ request_id, approve, feedback }: any) => handlePlanReview(request_id, approve, feedback ?? ""),
  idle: () => "Lead does not idle.",
  claim_task: ({ task_id }: any) => TASK_MGR.claim(task_id, "lead"),
};

const TOOLS = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
  {
    name: "read_file",
    description: "Read file contents.",
    input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] },
  },
  {
    name: "write_file",
    description: "Write content to file.",
    input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  },
  {
    name: "edit_file",
    description: "Replace exact text in file.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "TodoWrite",
    description: "Update task tracking list.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              activeForm: { type: "string" },
            },
            required: ["content", "status", "activeForm"],
          },
        },
      },
      required: ["items"],
    },
  },
  {
    name: "task",
    description: "Spawn a subagent for isolated exploration or work.",
    input_schema: {
      type: "object",
      properties: { prompt: { type: "string" }, agent_type: { type: "string", enum: ["Explore", "general-purpose"] } },
      required: ["prompt"],
    },
  },
  {
    name: "load_skill",
    description: "Load specialized knowledge by name.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  { name: "compress", description: "Manually compress conversation context.", input_schema: { type: "object", properties: {} } },
  {
    name: "background_run",
    description: "Run command in background thread.",
    input_schema: { type: "object", properties: { command: { type: "string" }, timeout: { type: "integer" } }, required: ["command"] },
  },
  {
    name: "check_background",
    description: "Check background task status.",
    input_schema: { type: "object", properties: { task_id: { type: "string" } } },
  },
  {
    name: "task_create",
    description: "Create a persistent file task.",
    input_schema: { type: "object", properties: { subject: { type: "string" }, description: { type: "string" } }, required: ["subject"] },
  },
  {
    name: "task_get",
    description: "Get task details by ID.",
    input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] },
  },
  {
    name: "task_update",
    description: "Update task status or dependencies.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "integer" },
        status: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"] },
        add_blocked_by: { type: "array", items: { type: "integer" } },
        add_blocks: { type: "array", items: { type: "integer" } },
      },
      required: ["task_id"],
    },
  },
  { name: "task_list", description: "List all tasks.", input_schema: { type: "object", properties: {} } },
  {
    name: "spawn_teammate",
    description: "Spawn a persistent autonomous teammate.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" }, role: { type: "string" }, prompt: { type: "string" } },
      required: ["name", "role", "prompt"],
    },
  },
  { name: "list_teammates", description: "List all teammates.", input_schema: { type: "object", properties: {} } },
  {
    name: "send_message",
    description: "Send a message to a teammate.",
    input_schema: {
      type: "object",
      properties: { to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string", enum: [...VALID_MSG_TYPES] } },
      required: ["to", "content"],
    },
  },
  { name: "read_inbox", description: "Read and drain the lead's inbox.", input_schema: { type: "object", properties: {} } },
  {
    name: "broadcast",
    description: "Send message to all teammates.",
    input_schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
  },
  {
    name: "shutdown_request",
    description: "Request a teammate to shut down.",
    input_schema: { type: "object", properties: { teammate: { type: "string" } }, required: ["teammate"] },
  },
  {
    name: "plan_approval",
    description: "Approve or reject a teammate's plan.",
    input_schema: {
      type: "object",
      properties: { request_id: { type: "string" }, approve: { type: "boolean" }, feedback: { type: "string" } },
      required: ["request_id", "approve"],
    },
  },
  { name: "idle", description: "Enter idle state.", input_schema: { type: "object", properties: {} } },
  {
    name: "claim_task",
    description: "Claim a task from the board.",
    input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] },
  },
];

// ============================================================
// === SECTION: agent_loop ===
// ============================================================

async function agentLoop(messages: any[]): Promise<void> {
  let roundsWithoutTodo = 0;

  while (true) {
    // s06: compression pipeline
    microcompact(messages);
    if (estimateTokens(messages) > TOKEN_THRESHOLD) {
      console.log("[auto-compact triggered]");
      const compacted = await autoCompact(messages);
      messages.splice(0, messages.length, ...compacted);
    }

    // s08: drain background notifications
    const notifs = BG.drain();
    if (notifs.length) {
      const txt = notifs.map((n) => `[bg:${n.task_id}] ${n.status}: ${n.result}`).join("\n");
      messages.push({ role: "user", content: `<background-results>\n${txt}\n</background-results>` });
      messages.push({ role: "assistant", content: "Noted background results." });
    }

    // s09: check lead inbox
    const inbox = BUS.readInbox("lead");
    if (inbox.length) {
      messages.push({ role: "user", content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>` });
      messages.push({ role: "assistant", content: "Noted inbox messages." });
    }

    // LLM call
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: TOOLS as any,
      max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return;

    // Tool execution
    const results: any[] = [];
    let usedTodo = false;
    let manualCompress = false;

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      if (block.name === "compress") manualCompress = true;

      const handler = TOOL_HANDLERS[block.name];
      let output: string;
      try {
        output = handler ? String(await handler(block.input)) : `Unknown tool: ${block.name}`;
      } catch (e: any) {
        output = `Error: ${e.message}`;
      }

      console.log(`> ${block.name}: ${output.slice(0, 200)}`);
      results.push({ type: "tool_result", tool_use_id: block.id, content: output });

      if (block.name === "TodoWrite") usedTodo = true;
    }

    // s03: nag reminder when todo workflow is active
    roundsWithoutTodo = usedTodo ? 0 : roundsWithoutTodo + 1;
    if (TODO.hasOpenItems() && roundsWithoutTodo >= 3) {
      results.unshift({ type: "text", text: "<reminder>Update your todos.</reminder>" });
    }

    messages.push({ role: "user", content: results });

    // s06: manual compress
    if (manualCompress) {
      console.log("[manual compact]");
      const compacted = await autoCompact(messages);
      messages.splice(0, messages.length, ...compacted);
    }
  }
}

// ============================================================
// === SECTION: repl ===
// ============================================================

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const history: any[] = [];

  const ask = () =>
    rl.question("\x1b[36ms_full >> \x1b[0m", async (line) => {
      const query = line.trim();

      if (!query || ["q", "exit"].includes(query.toLowerCase())) {
        rl.close();
        return;
      }

      // REPL shortcuts
      if (query === "/compact") {
        if (history.length) {
          console.log("[manual compact via /compact]");
          const compacted = await autoCompact(history);
          history.splice(0, history.length, ...compacted);
        }
        return ask();
      }
      if (query === "/tasks") {
        console.log(TASK_MGR.listAll());
        console.log();
        return ask();
      }
      if (query === "/team") {
        console.log(TEAM.listAll());
        console.log();
        return ask();
      }
      if (query === "/inbox") {
        console.log(JSON.stringify(BUS.readInbox("lead"), null, 2));
        console.log();
        return ask();
      }

      history.push({ role: "user", content: query });
      await agentLoop(history);

      const last = history[history.length - 1];
      if (Array.isArray(last.content)) {
        for (const block of last.content) {
          if (block.type === "text") console.log(block.text);
        }
      }
      console.log();
      ask();
    });

  ask();
}

main();
