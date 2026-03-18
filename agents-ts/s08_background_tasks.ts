/**
 * s08_background_tasks.ts - Background Tasks
 *
 * Run commands in background (non-blocking exec). A notification queue is
 * drained before each LLM call to deliver results.
 *
 *     Main event loop              Background process
 *     +-----------------+        +-----------------+
 *     | agent loop      |        | task executes   |
 *     | ...             |        | ...             |
 *     | [LLM call] <---+------- | enqueue(result) |
 *     |  ^drain queue   |        +-----------------+
 *     +-----------------+
 *
 *     Timeline:
 *     Agent ----[spawn A]----[spawn B]----[other work]----
 *                  |              |
 *                  v              v
 *               [A runs]      [B runs]        (parallel)
 *                  |              |
 *                  +-- notification queue --> [results injected]
 *
 * Key insight: "Fire and forget -- the agent doesn't block while the command runs."
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

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use background_run for long-running commands.`;

// -- BackgroundManager: non-blocking exec + notification queue --

type TaskStatus = "running" | "completed" | "timeout" | "error";

type TaskInfo = {
  status: TaskStatus;
  result: string | null;
  command: string;
};

type Notification = {
  task_id: string;
  status: TaskStatus;
  command: string;
  result: string;
};

export class BackgroundManager {
  // 任务记录，包含状态和结果
  private tasks: Record<string, TaskInfo> = {};
  //后台任务完成时，将结果放入通知队列，等待主循环在下次LLM调用前注入为用户消息
  private notificationQueue: Notification[] = [];

  run(command: string): string {
    //启动run，马上得到一个task_id
    const task_id = Math.random().toString(36).slice(2, 10);
    this.tasks[task_id] = { status: "running", result: null, command };

    //使用异步执行命令,超时时间300s,输出缓冲区最大50MB
    exec(command, { cwd: WORKDIR, timeout: 300_000, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      //当命令结束时，回调被触发
      let output: string;
      let status: TaskStatus;
      //判断回调参数
      if (err?.killed) {
        //超时
        output = "Error: Timeout (300s)";
        status = "timeout";
      } else if (err && !stderr && !stdout) {
        //执行错误
        output = `Error: ${err.message}`;
        status = "error";
      } else {
        //stdout和stderr合并起来看
        output = ((stdout || "") + (stderr || "")).trim().slice(0, 50000) || "(no output)";
        status = "completed";
      }

      this.tasks[task_id].status = status;
      this.tasks[task_id].result = output;
      //把结果放入通知队列，做了长度裁剪
      this.notificationQueue.push({
        task_id,
        status,
        command: command.slice(0, 80),
        result: output.slice(0, 500),
      });
    });
    //立刻返回一条字符串 ，不等上面的异步 exec完成（fire-and-forget）
    return `Background task ${task_id} started: ${command.slice(0, 80)}`;
  }

  check(task_id?: string): string {
    //如果提供了task_id，就返回该任务的状态和结果；否则列出所有任务的状态
    if (task_id) {
      const t = this.tasks[task_id];
      if (!t) return `Error: Unknown task ${task_id}`;
      return `[${t.status}] ${t.command.slice(0, 60)}\n${t.result ?? "(running)"}`;
    }
    const entries = Object.entries(this.tasks);
    if (!entries.length) return "No background tasks.";
    return entries.map(([id, t]) => `${id}: [${t.status}] ${t.command.slice(0, 60)}`).join("\n");
  }

  drainNotifications(): Notification[] {
    // Node.js is single-threaded; splice is atomic from the event-loop's perspective
    // 读取加清空 代替 锁+复制+清空
    return this.notificationQueue.splice(0);
  }
}

const BG = new BackgroundManager();

// -- Tool implementations --

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
    // 返回一个字符串占用多少“字节
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

const TOOL_HANDLERS: Record<string, (...args: any[]) => any> = {
  bash: async ({ command }: { command: string }) => await runBash(command),
  read_file: ({ path: p, limit }: { path: string; limit?: number }) => runRead(p, limit),
  write_file: ({ path: p, content }: { path: string; content: string }) => runWrite(p, content),
  edit_file: ({ path: p, old_text, new_text }: { path: string; old_text: string; new_text: string }) => runEdit(p, old_text, new_text),
  background_run: ({ command }: { command: string }) => BG.run(command),
  check_background: ({ task_id }: { task_id?: string }) => BG.check(task_id),
};

const TOOLS = [
  {
    name: "bash",
    description: "Run a shell command (blocking).",
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
    name: "background_run",
    description: "Run command in background. Returns task_id immediately.",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
  {
    name: "check_background",
    description: "Check background task status. Omit task_id to list all.",
    input_schema: { type: "object", properties: { task_id: { type: "string" } } },
  },
];

async function agentLoop(messages: any[]) {
  while (true) {
    // Drain background notifications and inject as user message before LLM call
    const notifs = BG.drainNotifications();
    // 通知注入机制
    if (notifs.length && messages.length) {
      // 主循环把完成结果注入到对话中
      const notifText = notifs.map((n) => `[bg:${n.task_id}] ${n.status}: ${n.result}`).join("\n");
      messages.push({ role: "user", content: `<background-results>\n${notifText}\n</background-results>` });
      messages.push({ role: "assistant", content: "Noted background results." });
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

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const history: any[] = [];
  const ask = () =>
    rl.question("\x1b[36ms08 >> \x1b[0m", async (line) => {
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
