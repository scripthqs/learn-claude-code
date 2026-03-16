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
const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL, apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.MODEL_ID!;

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.`;

const THRESHOLD = 50000;
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");
const KEEP_RECENT = 3;

// 将消息数组转换成字符串，计算大概的token数量。这里简单地将字符串长度除以4作为估算，因为平均每个token大约是4个字符。更准确的判断token数量的方法是使用专门的tokenizer库
function estimateTokens(messages: any[]): number {
  return JSON.stringify(messages).length / 4;
}

// 识别并压缩历史中较早的工具调用结果，保留最近的KEEP_RECENT条完整结果，其他的替换为简短的占位符。
function microCompact(messages: any[]): any[] {
  const toolResults: Array<[number, number, any]> = [];
  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (let partIdx = 0; partIdx < msg.content.length; partIdx++) {
        const part = msg.content[partIdx];
        if (part && typeof part === "object" && part.type === "tool_result") {
          toolResults.push([msgIdx, partIdx, part]);
        }
      }
    }
  }
  if (toolResults.length <= KEEP_RECENT) return messages;

  const toolNameMap: Record<string, string> = {};
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && block.type === "tool_use") {
          toolNameMap[String(block.id)] = block.name;
        }
      }
    }
  }

  const toClear = toolResults.slice(0, -KEEP_RECENT);
  for (const [_mi, _pi, result] of toClear) {
    if (typeof result.content === "string" && result.content.length > 100) {
      const toolId = result.tool_use_id ?? "";
      const toolName = toolNameMap[toolId] ?? "unknown";
      result.content = `[Previous: used ${toolName}]`;
    }
  }
  return messages;
}

// 保留长期可追溯的全文（磁盘），同时把内存中传给模型的上下文缩短以节省 token
async function autoCompact(messages: any[]): Promise<any[]> {
  try {
    fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  } catch (e) {
    // ignore
  }
  const transcriptPath = path.join(TRANSCRIPT_DIR, `transcript_${Date.now()}.jsonl`);
  try {
    // 磁盘持久化
    const fd = fs.openSync(transcriptPath, "w");
    for (const msg of messages) {
      fs.writeSync(fd, JSON.stringify(msg) + "\n");
    }
    fs.closeSync(fd);
    console.log(`[transcript saved: ${transcriptPath}]`);
  } catch (e) {
    console.warn("Failed to write transcript:", e);
  }

  const conversationText = JSON.stringify(messages).slice(0, 80000);
  // 调用模型摘要
  const response = await client.messages.create({
    model: MODEL,
    messages: [
      {
        role: "user",
        content:
          "Summarize this conversation for continuity. Include: 1) What was accomplished, 2) Current state, 3) Key decisions made. Be concise but preserve critical details.\n\n" +
          conversationText,
      },
    ],
    max_tokens: 2000,
  });
  const summary = (response.content && response.content[0] && (response.content[0] as any).text) || String(response.content);
  return [
    { role: "user", content: `[Conversation compressed. Transcript: ${transcriptPath}]\n\n${summary}` },
    //维持语境的连贯性，让模型知道之前的对话已经被压缩了，但重要的信息已经保存在摘要里了。
    { role: "assistant", content: "Understood. I have the context from the summary. Continuing." },
  ];
}

function safePath(p: string): string {
  const full = path.resolve(WORKDIR, p);
  const rel = path.relative(WORKDIR, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`Path escapes workspace: ${p}`);
  return full;
}

function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) return "Error: Dangerous command blocked";
  try {
    const r = execSync(command, { cwd: WORKDIR, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 120000 as any });
    const out = String(r).trim();
    return out ? out.slice(0, 50000) : "(no output)";
  } catch (e: any) {
    if (e.killed || /timed out/i.test(String(e.message))) return "Error: Timeout (120s)";
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
    return out ? out.slice(0, 50000) : String(e.message);
  }
}

function runRead(filePath: string, limit?: number): string {
  try {
    const full = safePath(filePath);
    const text = fs.readFileSync(full, "utf8");
    const lines = text.split(/\r?\n/);
    let out = lines;
    if (limit && limit < lines.length) out = [...lines.slice(0, limit), `... (${lines.length - limit} more)`];
    return out.join("\n").slice(0, 50000);
  } catch (e: any) {
    return `Error: ${String(e.message ?? e)}`;
  }
}

function runWrite(filePath: string, content: string): string {
  try {
    const full = safePath(filePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
    return `Wrote ${content.length} bytes`;
  } catch (e: any) {
    return `Error: ${String(e.message ?? e)}`;
  }
}

function runEdit(filePath: string, oldText: string, newText: string): string {
  try {
    const full = safePath(filePath);
    const content = fs.readFileSync(full, "utf8");
    if (!content.includes(oldText)) return `Error: Text not found in ${filePath}`;
    fs.writeFileSync(full, content.replace(oldText, newText), "utf8");
    return `Edited ${filePath}`;
  } catch (e: any) {
    return `Error: ${String(e.message ?? e)}`;
  }
}

const TOOL_HANDLERS: Record<string, (kw: any) => string> = {
  bash: (kw) => runBash(String(kw.command ?? "")),
  read_file: (kw) => runRead(String(kw.path ?? ""), kw.limit as number | undefined),
  write_file: (kw) => runWrite(String(kw.path ?? ""), String(kw.content ?? "")),
  edit_file: (kw) => runEdit(String(kw.path ?? ""), String(kw.old_text ?? ""), String(kw.new_text ?? "")),
  compact: (_kw) => "Manual compression requested.",
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
    name: "compact",
    description: "Trigger manual conversation compression.",
    input_schema: { type: "object", properties: { focus: { type: "string", description: "What to preserve in the summary" } } },
  },
];

async function agentLoop(messages: any[]) {
  while (true) {
    microCompact(messages);
    if (estimateTokens(messages) > THRESHOLD) {
      console.log("[auto_compact triggered]");
      const compacted = await autoCompact(messages);
      messages.length = 0;
      messages.push(...compacted);
    }
    const response = await client.messages.create({ model: MODEL, system: SYSTEM, messages, tools: TOOLS as any, max_tokens: 8000 });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return;
    const results: any[] = [];
    let manualCompact = false;
    for (const block of response.content) {
      if (block.type === "tool_use") {
        let output: string;
        if (block.name === "compact") {
          manualCompact = true;
          output = "Compressing...";
        } else {
          const handler = TOOL_HANDLERS[block.name];
          try {
            output = handler ? handler(block.input) : `Unknown tool: ${block.name}`;
          } catch (e: any) {
            output = `Error: ${String(e.message ?? e)}`;
          }
        }
        console.log(`> ${block.name}: ${String(output).slice(0, 200)}`);
        results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
      }
    }
    messages.push({ role: "user", content: results });
    if (manualCompact) {
      console.log("[manual compact]");
      const compacted = await autoCompact(messages);
      messages.length = 0;
      messages.push(...compacted);
    }
  }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const history: any[] = [];
  const ask = () => {
    rl.question("\x1b[36ms06 >> \x1b[0m", async (query) => {
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
          if (block && (block as any).text) console.log((block as any).text);
        }
      }
      console.log();
      ask();
    });
  };
  ask();
}

main();
