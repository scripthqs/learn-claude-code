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

const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use the todo tool to plan multi-step tasks. Mark in_progress before starting, completed when done.
Prefer tools over prose.`;

type TodoStatus = "pending" | "in_progress" | "completed";
type TodoItem = { id: string; text: string; status: TodoStatus };

class TodoManager {
  private items: TodoItem[] = [];

  update(items: unknown[]): string {
    if (items.length > 20) {
      throw new Error("Max 20 todos allowed");
    }

    const validated: TodoItem[] = [];
    let inProgressCount = 0;

    for (let i = 0; i < items.length; i += 1) {
      const raw = (items[i] ?? {}) as Record<string, unknown>;
      const id = String(raw.id ?? String(i + 1));
      const text = String(raw.text ?? "").trim();
      const status = String(raw.status ?? "pending").toLowerCase();

      if (!text) {
        throw new Error(`Item ${id}: text required`);
      }
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Item ${id}: invalid status '${status}'`);
      }
      if (status === "in_progress") {
        inProgressCount += 1;
      }

      validated.push({ id, text, status: status as TodoStatus });
    }

    if (inProgressCount > 1) {
      throw new Error("Only one task can be in_progress at a time");
    }

    this.items = validated;
    return this.render();
  }

  render(): string {
    if (this.items.length === 0) {
      return "No todos.";
    }

    const lines: string[] = [];
    for (const item of this.items) {
      const marker = {
        pending: "[ ]",
        in_progress: "[>]",
        completed: "[x]",
      }[item.status];
      lines.push(`${marker} #${item.id}: ${item.text}`);
    }

    const done = this.items.filter((t) => t.status === "completed").length;
    lines.push(`\n(${done}/${this.items.length} completed)`);
    return lines.join("\n");
  }
}

const TODO = new TodoManager();

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
  todo: (kw) => TODO.update((kw.items as unknown[]) ?? []),
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
  {
    name: "todo",
    description: "Update task list. Track progress on multi-step tasks.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
              },
            },
            required: ["id", "text", "status"],
          },
        },
      },
      required: ["items"],
    },
  },
];

async function agentLoop(messages: Anthropic.MessageParam[]) {
  let roundsSinceTodo = 0;

  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: TOOLS,
      max_tokens: 8000,
    });

    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") {
      return;
    }

    const results: any[] = [];
    let usedTodo = false;

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

      console.log(`> ${block.name}: ${output.slice(0, 200)}`);
      results.push({ type: "tool_result", tool_use_id: block.id, content: output });
      if (block.name === "todo") {
        usedTodo = true;
      }
    }

    roundsSinceTodo = usedTodo ? 0 : roundsSinceTodo + 1;
    if (roundsSinceTodo >= 3) {
      results.unshift({ type: "text", text: "<reminder>Update your todos.</reminder>" });
    }

    messages.push({ role: "user", content: results });
  }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const history: Anthropic.MessageParam[] = [];

  const ask = () => {
    rl.question("\x1b[36ms03 >> \x1b[0m", async (query) => {
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
