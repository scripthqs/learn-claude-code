/**
 * s11_autonomous_agents.ts - Autonomous Agents
 *
 * Idle cycle with task board polling, auto-claiming unclaimed tasks, and
 * identity re-injection after context compression. Builds on s10's protocols.
 *
 *     Teammate lifecycle:
 *     +-------+
 *     | spawn |
 *     +---+---+
 *         |
 *         v
 *     +-------+  tool_use    +-------+
 *     | WORK  | <----------- |  LLM  |
 *     +---+---+              +-------+
 *         |
 *         | stop_reason != tool_use
 *         v
 *     +--------+
 *     | IDLE   | poll every 5s for up to 60s
 *     +---+----+
 *         |
 *         +---> check inbox -> message? -> resume WORK
 *         |
 *         +---> scan .tasks/ -> unclaimed? -> claim -> resume WORK
 *         |
 *         +---> timeout (60s) -> shutdown
 *
 *     Identity re-injection after compression:
 *     messages = [identity_block, ...remaining...]
 *     "You are 'coder', role: backend, team: my-team"
 *
 * Key insight: "The agent finds work itself."
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

const WORKDIR = process.cwd();
const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
  apiKey: process.env.ANTHROPIC_API_KEY,
});
const MODEL = process.env.MODEL_ID!;
const TEAM_DIR = path.join(WORKDIR, ".team"); //团队目录
const INBOX_DIR = path.join(TEAM_DIR, "inbox"); //收件箱目录
const TASKS_DIR = path.join(WORKDIR, ".tasks"); //任务看板目录

const POLL_INTERVAL = 5000; // ms 空闲时轮询间隔
const IDLE_TIMEOUT = 60000; // ms 空闲超时时间

const SYSTEM = `You are a team lead at ${WORKDIR}. Teammates are autonomous -- they find work themselves.`;

const VALID_MSG_TYPES = new Set(["message", "broadcast", "shutdown_request", "shutdown_response", "plan_approval_response"]);

// -- Types --

type MsgType = "message" | "broadcast" | "shutdown_request" | "shutdown_response" | "plan_approval_response";

type Message = {
  type: MsgType;
  from: string;
  content: string;
  timestamp: number;
  [key: string]: any;
};

type MemberStatus = "working" | "idle" | "shutdown";

type TeamMember = {
  name: string;
  role: string;
  status: MemberStatus;
};

type TeamConfig = {
  team_name: string;
  members: TeamMember[];
};

type Task = {
  id: number;
  subject: string;
  description?: string;
  status: "pending" | "in_progress" | "completed";
  owner?: string;
  blockedBy?: number;
};

type ShutdownRecord = {
  target: string;
  status: "pending" | "approved" | "rejected";
};

type PlanRecord = {
  from: string;
  plan: string;
  status: "pending" | "approved" | "rejected";
};

// -- Request trackers --
// Node.js is single-threaded so no locks needed
const shutdownRequests: Record<string, ShutdownRecord> = {};
const planRequests: Record<string, PlanRecord> = {};

// -- MessageBus: JSONL inbox per teammate --

// 用文件实现异步消息队列，主循环和队友循环都通过它收发消息。
class MessageBus {
  private dir: string;

  constructor(inboxDir: string) {
    this.dir = inboxDir;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  send(sender: string, to: string, content: string, msgType: string = "message", extra: Record<string, any> = {}): string {
    if (!VALID_MSG_TYPES.has(msgType)) {
      return `Error: Invalid type '${msgType}'. Valid: ${[...VALID_MSG_TYPES].join(", ")}`;
    }
    // 构造消息对象，包含 type, from, content, timestamp 以及额外字段
    const msg: Message = {
      type: msgType as MsgType,
      from: sender,
      content,
      timestamp: Date.now() / 1000,
      ...extra,
    };
    // 每个成员都有自己的收件箱文件，消息以 JSONL 格式追加写入
    const inboxPath = path.join(this.dir, `${to}.jsonl`);
    fs.appendFileSync(inboxPath, JSON.stringify(msg) + "\n", "utf8");
    return `Sent ${msgType} to ${to}`;
  }

  readInbox(name: string): Message[] {
    const inboxPath = path.join(this.dir, `${name}.jsonl`);
    if (!fs.existsSync(inboxPath)) return [];
    const content = fs.readFileSync(inboxPath, "utf8").trim();
    const messages: Message[] = [];
    //把JSON对象解析成对象数组并返回
    for (const line of content.split("\n")) {
      if (line.trim()) {
        try {
          messages.push(JSON.parse(line));
        } catch {}
      }
    }
    // 然后清空文件
    fs.writeFileSync(inboxPath, "", "utf8"); // drain
    return messages;
  }

  broadcast(sender: string, content: string, teammates: string[]): string {
    let count = 0;
    for (const name of teammates) {
      if (name !== sender) {
        this.send(sender, name, content, "broadcast");
        count++;
      }
    }
    return `Broadcast to ${count} teammates`;
  }
}

const BUS = new MessageBus(INBOX_DIR);

// -- Task board --

//任务看板
function scanUnclaimedTasks(): Task[] {
  //  扫描所有 status=pending 且没有 owner 的任务
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  const files = fs
    .readdirSync(TASKS_DIR)
    .filter((f) => f.match(/^task_\d+\.json$/))
    .sort();
  // 未认领任务
  const unclaimed: Task[] = [];
  for (const file of files) {
    const task: Task = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, file), "utf8"));
    // 返回 status 是 pending，且没有 owner 和 blockedBy 的任务
    if (task.status === "pending" && !task.owner && !task.blockedBy) {
      unclaimed.push(task);
    }
  }
  return unclaimed;
}

// 操作未认领的任务
function claimTask(taskId: number, owner: string): string {
  // 把任务标记为 in_progress，设置 owner
  // Node.js is single-threaded — file read-modify-write is safe within one event loop tick
  const taskPath = path.join(TASKS_DIR, `task_${taskId}.json`);
  if (!fs.existsSync(taskPath)) return `Error: Task ${taskId} not found`;
  const task: Task = JSON.parse(fs.readFileSync(taskPath, "utf8"));
  task.owner = owner;
  task.status = "in_progress";
  fs.writeFileSync(taskPath, JSON.stringify(task, null, 2), "utf8");
  return `Claimed task #${taskId} for ${owner}`;
}

// -- Identity re-injection after context compression --
// 身份重注入与睡眠
function makeIdentityBlock(name: string, role: string, teamName: string): any {
  // 用于在上下文被压缩后把身份信息注回去
  return {
    role: "user",
    content: `<identity>You are '${name}', role: ${role}, team: ${teamName}. Continue your work.</identity>`,
  };
}

// -- sleep helper (replaces time.sleep in idle phase) --
// 在空闲轮询阶段使用的睡眠函数，返回一个 Promise，在指定时间后解析
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -- Autonomous TeammateManager --
//维护团队成员和状态持久化的辅助函数
class TeammateManager {
  private dir: string;
  private configPath: string;
  private config: TeamConfig;

  constructor(teamDir: string) {
    this.dir = teamDir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.configPath = path.join(this.dir, "config.json");
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
    const member = this.findMember(name);
    if (member) {
      member.status = status;
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

    // Fire and forget — autonomous loop runs independently
    this.loop(name, role, prompt).catch((e) => console.error(`[${name}] loop error:`, e));

    return `Spawned '${name}' (role: ${role})`;
  }

  // 实现队友的工作/空闲生命周期
  private async loop(name: string, role: string, prompt: string): Promise<void> {
    const teamName = this.config.team_name;

    // 构建系统提示词
    const sysPrompt =
      `You are '${name}', role: ${role}, team: ${teamName}, at ${WORKDIR}. ` +
      `Use idle tool when you have no more work. You will auto-claim new tasks.`;

    const messages: any[] = [{ role: "user", content: prompt }];
    const tools = this.teammateTools();

    // Outer loop: WORK -> IDLE -> WORK -> ... -> shutdown
    while (true) {
      // -- WORK PHASE --
      this.setStatus(name, "working");
      let idleRequested = false;

      for (let i = 0; i < 50; i++) {
        // drain inbox
        // 先读取并清空收件箱，处理所有消息
        const inbox = BUS.readInbox(name);
        for (const msg of inbox) {
          // 如果收到 shutdown_request，直接进入 shutdown 状态并退出循环
          if (msg.type === "shutdown_request") {
            this.setStatus(name, "shutdown");
            return;
          }
          messages.push({ role: "user", content: JSON.stringify(msg) });
        }

        let response: any;
        try {
          //调用LLM
          response = await client.messages.create({
            model: MODEL,
            system: sysPrompt,
            messages,
            tools: tools as any,
            max_tokens: 8000,
          });
        } catch {
          // 调用失败，进入空闲状态
          this.setStatus(name, "idle");
          return;
        }

        messages.push({ role: "assistant", content: response.content });
        if (response.stop_reason !== "tool_use") break;

        const results: any[] = [];
        for (const block of response.content) {
          if (block.type === "tool_use") {
            let output: string;
            // 如果工具调用是 idle，说明模型自己想进入空闲，设置 idleRequested 标志，稍后进入空闲阶段
            if (block.name === "idle") {
              idleRequested = true;
              output = "Entering idle phase. Will poll for new tasks.";
            } else {
              try {
                output = await this.execTool(name, block.name, block.input);
              } catch (e: any) {
                output = `Error: ${e.message}`;
              }
            }
            console.log(`  [${name}] ${block.name}: ${String(output).slice(0, 120)}`);
            results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
          }
        }
        messages.push({ role: "user", content: results });
        if (idleRequested) break;
      }

      // -- IDLE PHASE: poll inbox and task board --
      this.setStatus(name, "idle");
      let resume = false;
      const polls = Math.floor(IDLE_TIMEOUT / POLL_INTERVAL); //60s/5s = 12次轮询机会

      for (let p = 0; p < polls; p++) {
        await sleep(POLL_INTERVAL); //等待 5 秒

        // Check inbox first
        const inbox = BUS.readInbox(name); //检查收件箱
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

        // Check task board
        const unclaimed = scanUnclaimedTasks();
        if (unclaimed.length) {
          const task = unclaimed[0];
          claimTask(task.id, name);

          const taskPrompt = `<auto-claimed>Task #${task.id}: ${task.subject}\n` + `${task.description ?? ""}</auto-claimed>`;

          // Re-inject identity if context is very short (after compression)
          if (messages.length <= 3) {
            messages.unshift({ role: "assistant", content: `I am ${name}. Continuing.` }, makeIdentityBlock(name, role, teamName));
            // unshift reverses order, so fix: identity first, then assistant ack
            // correct order: [identity, assistant_ack, ...rest]
            const [asst, identity] = messages.splice(0, 2);
            messages.unshift(identity, asst);
          }

          messages.push({ role: "user", content: taskPrompt });
          messages.push({ role: "assistant", content: `Claimed task #${task.id}. Working on it.` });
          resume = true;
          break;
        }
      }

      if (!resume) {
        this.setStatus(name, "shutdown");
        return;
      }
      // loop continues → back to WORK PHASE
    }
  }

  private async execTool(sender: string, toolName: string, args: Record<string, any>): Promise<string> {
    switch (toolName) {
      case "bash":
        return await runBash(args.command);
      case "read_file":
        return runRead(args.path);
      case "write_file":
        return runWrite(args.path, args.content);
      case "edit_file":
        return runEdit(args.path, args.old_text, args.new_text);
      case "send_message":
        return BUS.send(sender, args.to, args.content, args.msg_type ?? "message");
      case "read_inbox":
        return JSON.stringify(BUS.readInbox(sender), null, 2);
      case "claim_task":
        return claimTask(args.task_id, sender);

      case "shutdown_response": {
        const { request_id: reqId, approve, reason = "" } = args;
        if (reqId in shutdownRequests) {
          shutdownRequests[reqId].status = approve ? "approved" : "rejected";
        }
        BUS.send(sender, "lead", reason, "shutdown_response", { request_id: reqId, approve });
        return `Shutdown ${approve ? "approved" : "rejected"}`;
      }

      case "plan_approval": {
        const planText: string = args.plan ?? "";
        const reqId = uuidv4().slice(0, 8);
        planRequests[reqId] = { from: sender, plan: planText, status: "pending" };
        BUS.send(sender, "lead", planText, "plan_approval_response", {
          request_id: reqId,
          plan: planText,
        });
        return `Plan submitted (request_id=${reqId}). Waiting for approval.`;
      }

      default:
        return `Unknown tool: ${toolName}`;
    }
  }

  private teammateTools(): object[] {
    return [
      {
        name: "bash",
        description: "Run a shell command.",
        input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
      {
        name: "read_file",
        description: "Read file contents.",
        input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
      {
        name: "write_file",
        description: "Write content to file.",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
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
        name: "send_message",
        description: "Send message to a teammate.",
        input_schema: {
          type: "object",
          properties: {
            to: { type: "string" },
            content: { type: "string" },
            msg_type: { type: "string", enum: [...VALID_MSG_TYPES] },
          },
          required: ["to", "content"],
        },
      },
      {
        name: "read_inbox",
        description: "Read and drain your inbox.",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "shutdown_response",
        description: "Respond to a shutdown request.",
        input_schema: {
          type: "object",
          properties: {
            request_id: { type: "string" },
            approve: { type: "boolean" },
            reason: { type: "string" },
          },
          required: ["request_id", "approve"],
        },
      },
      {
        name: "plan_approval",
        description: "Submit a plan for lead approval.",
        input_schema: {
          type: "object",
          properties: { plan: { type: "string" } },
          required: ["plan"],
        },
      },
      {
        name: "idle",
        description: "Signal that you have no more work. Enters idle polling phase.",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "claim_task",
        description: "Claim a task from the task board by ID.",
        input_schema: {
          type: "object",
          properties: { task_id: { type: "integer" } },
          required: ["task_id"],
        },
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

const TEAM = new TeammateManager(TEAM_DIR);

// -- Base tool implementations --

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

// -- Lead-specific protocol handlers --

function handleShutdownRequest(teammate: string): string {
  const reqId = uuidv4().slice(0, 8);
  shutdownRequests[reqId] = { target: teammate, status: "pending" };
  BUS.send("lead", teammate, "Please shut down gracefully.", "shutdown_request", {
    request_id: reqId,
  });
  return `Shutdown request ${reqId} sent to '${teammate}'`;
}

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

function checkShutdownStatus(requestId: string): string {
  return JSON.stringify(shutdownRequests[requestId] ?? { error: "not found" });
}

// -- Lead tool dispatch (14 tools) --

const TOOL_HANDLERS: Record<string, (...args: any[]) => any> = {
  bash: async ({ command }: any) => await runBash(command),
  read_file: ({ path: p, limit }: any) => runRead(p, limit),
  write_file: ({ path: p, content }: any) => runWrite(p, content),
  edit_file: ({ path: p, old_text: o, new_text: n }: any) => runEdit(p, o, n),
  spawn_teammate: ({ name, role, prompt }: any) => TEAM.spawn(name, role, prompt),
  list_teammates: () => TEAM.listAll(),
  send_message: ({ to, content, msg_type }: any) => BUS.send("lead", to, content, msg_type ?? "message"),
  read_inbox: () => JSON.stringify(BUS.readInbox("lead"), null, 2),
  broadcast: ({ content }: any) => BUS.broadcast("lead", content, TEAM.memberNames()),
  shutdown_request: ({ teammate }: any) => handleShutdownRequest(teammate),
  shutdown_response: ({ request_id }: any) => checkShutdownStatus(request_id ?? ""),
  plan_approval: ({ request_id, approve, feedback }: any) => handlePlanReview(request_id, approve, feedback ?? ""),
  idle: () => "Lead does not idle.",
  claim_task: ({ task_id }: any) => claimTask(task_id, "lead"),
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
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
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
    name: "spawn_teammate",
    description: "Spawn an autonomous teammate.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" }, role: { type: "string" }, prompt: { type: "string" } },
      required: ["name", "role", "prompt"],
    },
  },
  {
    name: "list_teammates",
    description: "List all teammates.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "send_message",
    description: "Send a message to a teammate.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string" },
        content: { type: "string" },
        msg_type: { type: "string", enum: [...VALID_MSG_TYPES] },
      },
      required: ["to", "content"],
    },
  },
  {
    name: "read_inbox",
    description: "Read and drain the lead's inbox.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "broadcast",
    description: "Send a message to all teammates.",
    input_schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
  },
  {
    name: "shutdown_request",
    description: "Request a teammate to shut down.",
    input_schema: { type: "object", properties: { teammate: { type: "string" } }, required: ["teammate"] },
  },
  {
    name: "shutdown_response",
    description: "Check shutdown request status.",
    input_schema: { type: "object", properties: { request_id: { type: "string" } }, required: ["request_id"] },
  },
  {
    name: "plan_approval",
    description: "Approve or reject a teammate's plan.",
    input_schema: {
      type: "object",
      properties: {
        request_id: { type: "string" },
        approve: { type: "boolean" },
        feedback: { type: "string" },
      },
      required: ["request_id", "approve"],
    },
  },
  {
    name: "idle",
    description: "Enter idle state (for lead -- rarely used).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "claim_task",
    description: "Claim a task from the board by ID.",
    input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] },
  },
];

// -- Agent loop --

async function agentLoop(messages: any[]): Promise<void> {
  while (true) {
    const inbox = BUS.readInbox("lead");
    if (inbox.length) {
      messages.push({
        role: "user",
        content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>`,
      });
      messages.push({ role: "assistant", content: "Noted inbox messages." });
    }

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

// -- Main --

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const history: any[] = [];

  const ask = () =>
    rl.question("\x1b[36ms11 >> \x1b[0m", async (line) => {
      const query = line.trim();

      if (!query || query.toLowerCase() === "q" || query.toLowerCase() === "exit") {
        rl.close();
        return;
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
      if (query === "/tasks") {
        fs.mkdirSync(TASKS_DIR, { recursive: true });
        const files = fs
          .readdirSync(TASKS_DIR)
          .filter((f) => f.match(/^task_\d+\.json$/))
          .sort();
        for (const file of files) {
          const t: Task = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, file), "utf8"));
          const marker: Record<string, string> = {
            pending: "[ ]",
            in_progress: "[>]",
            completed: "[x]",
          };
          const owner = t.owner ? ` @${t.owner}` : "";
          console.log(`  ${marker[t.status] ?? "[?]"} #${t.id}: ${t.subject}${owner}`);
        }
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
