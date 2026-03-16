import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import * as dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR = process.cwd();
const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
  apiKey: process.env.ANTHROPIC_API_KEY,
});
const MODEL = process.env.MODEL_ID!;

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use the task tool to delegate exploration or subtasks.`;
const SUBAGENT_SYSTEM = `You are a coding subagent at ${WORKDIR}. Complete the given task, then summarize your findings.`;

function safePath(p: string): string {
  const fullPath = path.resolve(WORKDIR, p);
  const rel = path.relative(WORKDIR, fullPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return fullPath;
}

function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }

  try {
    const output = execSync(command, {
      cwd: WORKDIR,
      encoding: "utf8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = output.trim();
    return out ? out.slice(0, 50000) : "(no output)";
  } catch (e: any) {
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
    if (e.killed || /timed out/i.test(String(e.message))) {
      return "Error: Timeout (120s)";
    }
    return out ? out.slice(0, 50000) : String(e.message);
  }
}

function runRead(filePath: string, limit?: number): string {
  try {
    let lines = fs.readFileSync(safePath(filePath), "utf8").split(/\r?\n/);
    if (limit && limit < lines.length) {
      lines = [...lines.slice(0, limit), `... (${lines.length - limit} more)`];
    }
    return lines.join("\n").slice(0, 50000);
  } catch (e: any) {
    return `Error: ${String(e.message ?? e)}`;
  }
}

function runWrite(filePath: string, content: string): string {
  try {
    const fullPath = safePath(filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf8");
    return `Wrote ${content.length} bytes`;
  } catch (e: any) {
    return `Error: ${String(e.message ?? e)}`;
  }
}

function runEdit(filePath: string, oldText: string, newText: string): string {
  try {
    const fullPath = safePath(filePath);
    const content = fs.readFileSync(fullPath, "utf8");
    if (!content.includes(oldText)) {
      return `Error: Text not found in ${filePath}`;
    }
    fs.writeFileSync(fullPath, content.replace(oldText, newText), "utf8");
    return `Edited ${filePath}`;
  } catch (e: any) {
    return `Error: ${String(e.message ?? e)}`;
  }
}

type ToolInput = Record<string, unknown>;
type ToolHandler = (input: ToolInput) => string;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: (kw) => runBash(String(kw.command ?? "")),
  read_file: (kw) => runRead(String(kw.path ?? ""), kw.limit as number | undefined),
  write_file: (kw) => runWrite(String(kw.path ?? ""), String(kw.content ?? "")),
  edit_file: (kw) => runEdit(String(kw.path ?? ""), String(kw.old_text ?? ""), String(kw.new_text ?? "")),
};

//自带了工具 不含task
const CHILD_TOOLS: Anthropic.Tool[] = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read file contents.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, limit: { type: "integer" } },
      required: ["path"],
    },
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
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
];

// 生成一个全新上下文的子 agent，父 agent 和子 agent 共享文件系统，但不共享对话历史。
const PARENT_TOOLS: Anthropic.Tool[] = [
  ...CHILD_TOOLS,
  {
    name: "task",
    description: "Spawn a subagent with fresh context. It shares the filesystem but not conversation history.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        description: {
          type: "string",
          description: "Short description of the task",
        },
      },
      required: ["prompt"],
    },
  },
];

async function runSubagent(prompt: string): Promise<string> {
  const subMessages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
  let summaryText = "";

  // 子代理最多执行 30 轮，避免死循环。
  for (let i = 0; i < 30; i += 1) {
    // 子代理不拿 history，所以是“fresh context”。
    const response = await client.messages.create({
      model: MODEL,
      system: SUBAGENT_SYSTEM,
      messages: subMessages,
      // 子代理只能调用 CHILD_TOOLS，不包含 task。
      tools: CHILD_TOOLS,
      max_tokens: 8000,
    });

    subMessages.push({ role: "assistant", content: response.content });
    summaryText = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    if (response.stop_reason !== "tool_use") {
      break;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") {
        continue;
      }

      const handler = TOOL_HANDLERS[block.name];
      let output: string;
      try {
        output = handler ? handler(block.input as ToolInput) : `Unknown tool: ${block.name}`;
      } catch (e: any) {
        output = `Error: ${String(e.message ?? e)}`;
      }

      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output.slice(0, 50000),
      });
    }

    subMessages.push({ role: "user", content: results });
  }

  return summaryText || "(no summary)";
}

async function agentLoop(messages: Anthropic.MessageParam[]) {
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: PARENT_TOOLS,
      max_tokens: 8000,
    });
    // 先把大模型的回复添加到 messages 中，这样在处理工具调用时，如果需要再次生成文本（如 task 的结果），就能看到之前的上下文和回复内容。
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      return;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];

    //如果stop_reason==='tool_use'，说明模型发起了工具调用，需要外部执行后继续。

    // 遍历 response.content 中的每个块，
    for (const block of response.content) {
      if (block.type !== "tool_use") {
        continue;
      }
      // 如果块的类型是 "tool_use"，则根据块的 name 查找对应的工具处理函数，并执行相应的操作（如运行 bash 命令、读写文件等）。

      let output: string;
      //判断如果工具调用的名字是 "task"，则说明模型想要生成一个子代理来完成一个子任务。这时我们调用 runSubagent 函数，传入 task 的 prompt，运行一个全新的子代理来处理这个子任务，并把结果作为 output。
      if (block.name === "task") {
        const input = block.input as ToolInput;
        const desc = String(input.description ?? "subtask");
        const prompt = String(input.prompt ?? "");
        console.log(`> task (${desc}): ${prompt.slice(0, 80)}`);
        output = await runSubagent(prompt);
      } else {
        const handler = TOOL_HANDLERS[block.name];
        output = handler ? handler(block.input as ToolInput) : `Unknown tool: ${block.name}`;
      }

      console.log(`  ${String(output).slice(0, 200)}`);
      results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
    }

    messages.push({ role: "user", content: results });
  }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const history: Anthropic.MessageParam[] = [];

  const ask = () => {
    rl.question("\x1b[36ms04 >> \x1b[0m", async (query) => {
      if (!query || ["q", "exit"].includes(query.trim().toLowerCase())) {
        rl.close();
        return;
      }
      // 把用户输入的 query 添加到 history 中，作为用户消息的一部分。这些消息将被传递给模型，以便它能够基于上下文生成回复。
      history.push({ role: "user", content: query });
      try {
        //进入父代理循环
        await agentLoop(history);
      } catch (err) {
        console.error("agentLoop error:", err);
      }

      const last = history[history.length - 1]?.content;
      if (Array.isArray(last)) {
        for (const block of last) {
          if (typeof block === "object" && block && "type" in block && block.type === "text") {
            console.log(block.text);
          }
        }
      }

      console.log();
      ask();
    });
  };

  ask();
}

main();
