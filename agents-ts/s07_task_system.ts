import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import readline from "readline";
import * as dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../.env"), override: true });

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR = process.cwd();
const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
  apiKey: process.env.ANTHROPIC_API_KEY,
});
const MODEL = process.env.MODEL_ID!;
const TASKS_DIR = path.join(WORKDIR, ".tasks");

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use task tools to plan and track work.`;

type Task = {
  id: number;
  subject: string;
  description?: string;
  status: "pending" | "in_progress" | "completed";
  blockedBy: number[];
  blocks: number[];
  owner?: string;
};

export class TaskManager {
  dir: string;
  private _nextId: number;

  constructor(tasksDir: string) {
    this.dir = tasksDir;
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
    this._nextId = this._maxId() + 1;
  }

  private _maxId(): number {
    const files = fs.readdirSync(this.dir).filter((f) => f.startsWith("task_") && f.endsWith(".json"));
    const ids = files.map((f) => parseInt(f.split("_")[1], 10));
    return ids.length ? Math.max(...ids) : 0;
  }

  private _pathFor(id: number) {
    return path.join(this.dir, `task_${id}.json`);
  }

  private _load(id: number): Task {
    const p = this._pathFor(id);
    if (!fs.existsSync(p)) throw new Error(`Task ${id} not found`);
    return JSON.parse(fs.readFileSync(p, "utf8"));
  }

  private _save(task: Task) {
    const p = this._pathFor(task.id);
    fs.writeFileSync(p, JSON.stringify(task, null, 2), "utf8");
  }

  create(subject: string, description = ""): string {
    const task: Task = {
      id: this._nextId,
      subject,
      description,
      status: "pending",
      blockedBy: [],
      blocks: [],
      owner: "",
    };
    this._save(task);
    this._nextId += 1;
    return JSON.stringify(task, null, 2);
  }

  get(id: number): string {
    return JSON.stringify(this._load(id), null, 2);
  }

  update(id: number, opts: { status?: Task["status"]; addBlockedBy?: number[]; addBlocks?: number[] } = {}): string {
    const task = this._load(id);
    if (opts.status) {
      if (!["pending", "in_progress", "completed"].includes(opts.status)) throw new Error(`Invalid status: ${opts.status}`);
      task.status = opts.status;
      if (opts.status === "completed") this._clearDependency(id);
    }
    if (opts.addBlockedBy) {
      task.blockedBy = Array.from(new Set([...task.blockedBy, ...opts.addBlockedBy]));
    }
    if (opts.addBlocks) {
      task.blocks = Array.from(new Set([...task.blocks, ...opts.addBlocks]));
      for (const blockedId of opts.addBlocks) {
        try {
          const blocked = this._load(blockedId);
          if (!blocked.blockedBy.includes(id)) {
            blocked.blockedBy.push(id);
            this._save(blocked);
          }
        } catch (e) {
          // ignore missing
        }
      }
    }
    this._save(task);
    return JSON.stringify(task, null, 2);
  }

  private _clearDependency(completedId: number) {
    const files = fs.readdirSync(this.dir).filter((f) => f.startsWith("task_") && f.endsWith(".json"));
    for (const f of files) {
      const p = path.join(this.dir, f);
      const t: Task = JSON.parse(fs.readFileSync(p, "utf8"));
      if (t.blockedBy.includes(completedId)) {
        t.blockedBy = t.blockedBy.filter((x) => x !== completedId);
        fs.writeFileSync(p, JSON.stringify(t, null, 2), "utf8");
      }
    }
  }

  listAll(): string {
    const files = fs
      .readdirSync(this.dir)
      .filter((f) => f.startsWith("task_") && f.endsWith(".json"))
      .sort();
    if (!files.length) return "No tasks.";
    const lines: string[] = [];
    for (const f of files) {
      const t: Task = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8"));
      const marker = t.status === "pending" ? "[ ]" : t.status === "in_progress" ? "[>]" : "[x]";
      const blocked = t.blockedBy && t.blockedBy.length ? ` (blocked by: ${JSON.stringify(t.blockedBy)})` : "";
      lines.push(`${marker} #${t.id}: ${t.subject}${blocked}`);
    }
    return lines.join("\n");
  }
}

export const TASKS = new TaskManager(TASKS_DIR);

// -- Helpers --
function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(path.resolve(WORKDIR))) throw new Error(`Path escapes workspace: ${p}`);
  return resolved;
}

function runBash(command: string): Promise<string> {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) return Promise.resolve("Error: Dangerous command blocked");
  return new Promise((resolve) => {
    exec(command, { cwd: WORKDIR, timeout: 120_000, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && err.killed) return resolve("Error: Timeout (120s)");
      const out = (stdout || "") + (stderr || "");
      resolve(out.trim() ? out.trim().slice(0, 50000) : "(no output)");
    });
  });
}

function runRead(p: string, limit?: number): string {
  try {
    const content = fs.readFileSync(safePath(p), "utf8");
    const lines = content.split(/\r?\n/);
    if (limit && limit < lines.length)
      return lines
        .slice(0, limit)
        .concat([`... (${lines.length - limit} more)`])
        .join("\n")
        .slice(0, 50000);
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
    return `Wrote ${Buffer.byteLength(content, "utf8")} bytes`;
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

export const TOOL_HANDLERS: Record<string, (...args: any[]) => any> = {
  bash: async ({ command }: { command: string }) => await runBash(command),
  read_file: ({ path: p, limit }: { path: string; limit?: number }) => runRead(p, limit),
  write_file: ({ path: p, content }: { path: string; content: string }) => runWrite(p, content),
  edit_file: ({ path: p, old_text, new_text }: { path: string; old_text: string; new_text: string }) => runEdit(p, old_text, new_text),
  task_create: ({ subject, description }: { subject: string; description?: string }) => TASKS.create(subject, description || ""),
  task_update: ({ task_id, status, addBlockedBy, addBlocks }: any) => TASKS.update(task_id, { status, addBlockedBy, addBlocks }),
  task_list: () => TASKS.listAll(),
  task_get: ({ task_id }: { task_id: number }) => TASKS.get(task_id),
};

export const TOOLS = [
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
    name: "task_create",
    description: "Create a new task.",
    input_schema: { type: "object", properties: { subject: { type: "string" }, description: { type: "string" } }, required: ["subject"] },
  },
  {
    name: "task_update",
    description: "Update a task's status or dependencies.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "integer" },
        status: { type: "string", enum: ["pending", "in_progress", "completed"] },
        addBlockedBy: { type: "array", items: { type: "integer" } },
        addBlocks: { type: "array", items: { type: "integer" } },
      },
      required: ["task_id"],
    },
  },
  { name: "task_list", description: "List all tasks with status summary.", input_schema: { type: "object", properties: {} } },
  {
    name: "task_get",
    description: "Get full details of a task by ID.",
    input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] },
  },
];

async function agentLoop(messages: any[]) {
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: TOOLS as any,
      max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return;
    const results: any[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const handler = TOOL_HANDLERS[block.name];
        let output: string;
        try {
          output = handler ? await handler(block.input) : `Unknown tool: ${block.name}`;
        } catch (e: any) {
          output = `Error: ${e.message}`;
        }
        console.log(`> ${block.name}: ${String(output).slice(0, 200)}`);
        results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
      }
    }
    messages.push({ role: "user", content: results });
  }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const history: any[] = [];
  const ask = () =>
    rl.question("\x1b[36ms07 >> \x1b[0m", async (line) => {
      const query = line.trim();
      if (!query || query.toLowerCase() === "q" || query.toLowerCase() === "exit") {
        rl.close();
        return;
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
