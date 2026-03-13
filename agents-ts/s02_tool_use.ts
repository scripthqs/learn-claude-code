import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import * as dotenv from "dotenv";

// 读取上一级的 .env
dotenv.config({ path: path.resolve(__dirname, "../.env") });

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL = process.env.MODEL_ID!;
const WORKDIR = process.cwd();
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks. Act, don't explain.`;

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

// 防止目录穿越（path traversal）。
function safePath(p: string): string {
  const fullPath = path.resolve(WORKDIR, p);
  const rel = path.relative(WORKDIR, fullPath);
  // rel 以 ".." 开头，或是绝对路径，说明不在 WORKDIR 内，抛出错误
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }

  return fullPath;
}

function runBash(cmd: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => cmd.includes(d))) {
    return "Error: Dangerous command blocked";
  }
  try {
    const output = execSync(cmd, {
      cwd: WORKDIR,
      encoding: "utf8",
      timeout: 120_000,
    });

    const out = output.trim();
    return out ? out.slice(0, 50000) : "(no output)";
  } catch (e: any) {
    return e.stdout?.trim() || e.message;
  }
}

function runRead(filePath: string, limit?: number): string {
  try {
    const text = fs.readFileSync(safePath(filePath), "utf8");
    let lines = text.split(/\r?\n/);
    if (limit && limit < lines.length) {
      lines = [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`];
    }
    return lines.join("\n").slice(0, 50000);
  } catch (e: any) {
    return `Error: ${String(e.message ?? e)}`;
  }
}

function runWrite(filePath: string, content: string): string {
  try {
    const fullPath = safePath(filePath);
    // 写文件前先确保父目录存在，避免 writeFileSync 因目录不存在而失败。
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf8");
    return `Wrote ${content.length} bytes to ${filePath}`;
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

const TOOLS: Anthropic.Tool[] = [
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

async function agentLoop(messages: Anthropic.MessageParam[]) {
  console.log("messages", JSON.stringify(messages, null, 2));
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: TOOLS,
      max_tokens: 8000,
    });

    console.log("智能体响应", JSON.stringify(response, null, 2));

    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      const handler = TOOL_HANDLERS[block.name];
      const output = handler ? handler(block.input as ToolInput) : `Unknown tool: ${block.name}`;
      console.log(`> ${block.name}: ${output.slice(0, 200)}`);

      results.push({ type: "tool_result", tool_use_id: block.id, content: output });
    }

    messages.push({ role: "user", content: results });
  }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const history: Anthropic.MessageParam[] = [];

  const ask = () => {
    rl.question("\x1b[36ms02 >> \x1b[0m", async (query) => {
      if (!query || ["q", "exit"].includes(query.trim().toLowerCase())) {
        rl.close();
        return;
      }

      history.push({ role: "user", content: query });
      try {
        await agentLoop(history);
      } catch (err) {
        console.error("agentLoop error:", err);
      }

      const last = history[history.length - 1]?.content;
      if (Array.isArray(last)) {
        for (const block of last) {
          if (typeof block === "object" && block && "text" in block) {
            console.log((block as { text: string }).text);
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
