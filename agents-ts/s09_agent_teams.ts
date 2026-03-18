/**
 * s09_agent_teams.ts - Agent Teams
 *
 * Persistent named agents with file-based JSONL inboxes. Each teammate runs
 * its own agent loop in a separate async context. Communication via append-only inboxes.
 *
 *     Subagent (s04):  spawn -> execute -> return summary -> destroyed
 *     Teammate (s09):  spawn -> work -> idle -> work -> ... -> shutdown
 *
 *     .team/config.json                   .team/inbox/
 *     +----------------------------+      +------------------+
 *     | {"team_name": "default",   |      | alice.jsonl      |
 *     |  "members": [              |      | bob.jsonl        |
 *     |    {"name":"alice",        |      | lead.jsonl       |
 *     |     "role":"coder",        |      +------------------+
 *     |     "status":"idle"}       |
 *     |  ]}                        |      sendMessage("alice", "fix bug"):
 *     +----------------------------+        appendFileSync("alice.jsonl", msg)
 *
 *                                         readInbox("alice"):
 *     spawnTeammate("alice","coder",...)    msgs = lines.map(JSON.parse)
 *          |                               writeFileSync("alice.jsonl", "")
 *          v                               return msgs  // drain
 *     Async: alice             Async: bob
 *     +------------------+    +------------------+
 *     | agentLoop        |    | agentLoop        |
 *     | status: working  |    | status: idle     |
 *     | ... runs tools   |    | ... waits ...    |
 *     | status -> idle   |    |                  |
 *     +------------------+    +------------------+
 *
 *     5 message types:
 *     +-------------------------+-----------------------------------+
 *     | message                 | Normal text message               |
 *     | broadcast               | Sent to all teammates             |
 *     | shutdown_request        | Request graceful shutdown (s10)   |
 *     | shutdown_response       | Approve/reject shutdown (s10)     |
 *     | plan_approval_response  | Approve/reject plan (s10)         |
 *     +-------------------------+-----------------------------------+
 *
 * Key insight: "Teammates that can talk to each other."
 */

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
const TEAM_DIR = path.join(WORKDIR, ".team");
const INBOX_DIR = path.join(TEAM_DIR, "inbox");

const SYSTEM = `You are a team lead at ${WORKDIR}. Spawn teammates and communicate via inboxes.`;

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
// idle: 空闲的，working: 工作中，shutdown: 已关闭
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

// -- MessageBus: JSONL inbox per teammate --
//  通信系统:使用文件不用内存，程序重启后消息不丢失，配合 config.json 实现持久化。
class MessageBus {
  private dir: string;

  constructor(inboxDir: string) {
    this.dir = inboxDir;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  // 发送消息:追加到目标的jsonl文件
  send(sender: string, to: string, content: string, msgType: string = "message", extra: Record<string, any> = {}): string {
    if (!VALID_MSG_TYPES.has(msgType)) {
      return `Error: Invalid type '${msgType}'. Valid: ${[...VALID_MSG_TYPES].join(", ")}`;
    }
    const msg: Message = {
      type: msgType as MsgType,
      from: sender,
      content,
      timestamp: Date.now() / 1000,
      ...extra,
    };
    const inboxPath = path.join(this.dir, `${to}.jsonl`);
    fs.appendFileSync(inboxPath, JSON.stringify(msg) + "\n", "utf8");
    return `Sent ${msgType} to ${to}`;
  }

  // 读取并清空收件箱
  readInbox(name: string): Message[] {
    const inboxPath = path.join(this.dir, `${name}.jsonl`);
    if (!fs.existsSync(inboxPath)) return [];
    const content = fs.readFileSync(inboxPath, "utf8").trim();
    const messages: Message[] = [];
    for (const line of content.split("\n")) {
      if (line.trim()) {
        try {
          messages.push(JSON.parse(line));
        } catch {}
      }
    }
    // drain
    fs.writeFileSync(inboxPath, "", "utf8");
    return messages;
  }

  //  给所有人各发一条
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

// -- TeammateManager: persistent named agents with config.json --

//  团队管理：管理成员状态和启动 Agent 循环
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

  spawn(name: string, role: string, prompt: string): string {
    const member = this.findMember(name);
    if (member) {
      if (member.status !== "idle" && member.status !== "shutdown") {
        // 是否已存在且空闲
        return `Error: '${name}' is currently ${member.status}`;
      }
      member.status = "working";
      member.role = role;
    } else {
      this.config.members.push({ name, role, status: "working" });
    }

    this.saveConfig(); //把状态改成 "working"，写入 config.json

    // Node.js has no threads — run teammate loop as an independent async task
    this.teammateLoop(name, role, prompt).catch((e) => console.error(`[${name}] loop error:`, e)); // 启动 teammateLoop（独立异步任务，不等待）

    //立即返回结果，不等待 teammateLoop 完成
    return `Spawned '${name}' (role: ${role})`;
  }

  // 是每个 Teammate 自己的 Agent 循环：
  private async teammateLoop(name: string, role: string, prompt: string): Promise<void> {
    //communicate：通信
    const sysPrompt = `You are '${name}', role: ${role}, at ${WORKDIR}. Use send_message to communicate. Complete your task.`;
    const messages: any[] = [{ role: "user", content: prompt }];
    const tools = this.teammateTools();

    // 限制最多循环次数
    for (let i = 0; i < 50; i++) {
      // drain inbox before each LLM call
      const inbox = BUS.readInbox(name); //先读收件箱
      for (const msg of inbox) {
        // 注入收件箱消息到对话历史
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
        break;
      }

      messages.push({ role: "assistant", content: response.content });
      if (response.stop_reason !== "tool_use") break;

      const results: any[] = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          let output: string;
          try {
            output = await this.execTool(name, block.name, block.input); //执行工具
          } catch (e: any) {
            output = `Error: ${e.message}`;
          }
          console.log(`  [${name}] ${block.name}: ${String(output).slice(0, 120)}`);
          results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
        }
      }
      messages.push({ role: "user", content: results });
    }

    const member = this.findMember(name);
    if (member && member.status !== "shutdown") {
      member.status = "idle";
      this.saveConfig();
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

// -- Lead tool dispatch (9 tools) --

const TOOL_HANDLERS: Record<string, (...args: any[]) => any> = {
  bash: async ({ command }: { command: string }) => await runBash(command),
  read_file: ({ path: p, limit }: { path: string; limit?: number }) => runRead(p, limit),
  write_file: ({ path: p, content }: { path: string; content: string }) => runWrite(p, content),
  edit_file: ({ path: p, old_text: o, new_text: n }: any) => runEdit(p, o, n),
  spawn_teammate: ({ name, role, prompt }: { name: string; role: string; prompt: string }) => TEAM.spawn(name, role, prompt),
  list_teammates: () => TEAM.listAll(),
  send_message: ({ to, content, msg_type }: any) => BUS.send("lead", to, content, msg_type ?? "message"),
  read_inbox: () => JSON.stringify(BUS.readInbox("lead"), null, 2),
  broadcast: ({ content }: { content: string }) => BUS.broadcast("lead", content, TEAM.memberNames()),
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
    description: "Spawn a persistent teammate that runs its own agent loop.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" }, role: { type: "string" }, prompt: { type: "string" } },
      required: ["name", "role", "prompt"],
    },
  },
  {
    name: "list_teammates",
    description: "List all teammates with name, role, status.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "send_message",
    description: "Send a message to a teammate's inbox.",
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
];

// -- Agent loop --

async function agentLoop(messages: any[]): Promise<void> {
  while (true) {
    // drain lead inbox before each LLM call
    //  队长的主循环，每轮开始先读收件箱
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
    rl.question("\x1b[36ms09 >> \x1b[0m", async (line) => {
      const query = line.trim();

      if (!query || query.toLowerCase() === "q" || query.toLowerCase() === "exit") {
        rl.close();
        return;
      }

      // debug shortcuts
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
