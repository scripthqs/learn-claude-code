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
const SKILLS_DIR = path.join(WORKDIR, "skills");

// -- SkillLoader: scan skills/<name>/SKILL.md with YAML frontmatter --
class SkillLoader {
  skills: Record<string, { meta: Record<string, string>; body: string; path: string }> = {};
  skillsDir: string;

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir;
    this._loadAll();
  }

  //把技能载入内存缓存
  private _loadAll() {
    if (!fs.existsSync(this.skillsDir)) return;
    //读取指定文件夹下 指定文件 返回路径的数组
    const entries = this._rglob(this.skillsDir, "SKILL.md");
    // 需要把扫描到的文件按确定顺序排列，readdirSync不承诺返回有确定顺序，排序后能够解决“非确定性/不可重现”的问题，
    entries.sort();
    for (const f of entries) {
      const text = fs.readFileSync(f, "utf8");
      // 解析 SKILL.md 前置 YAML 区块
      const { meta, body } = this._parseFrontmatter(text);
      // 从完整文件路径获取文件名
      const name = meta.name ?? path.basename(path.dirname(f));
      this.skills[name] = { meta, body, path: f };
    }
  }

  private _rglob(dir: string, filename: string): string[] {
    const results: string[] = [];
    const walk = (d: string) => {
      //同步读取目录下的所有条目（文件和子目录），并返回一个包含这些条目的数组。参数 withFileTypes: true 表示返回的数组中的每个元素都是一个 fs.Dirent 对象，包含了该条目的类型信息（如是否是文件、目录等）。
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.isFile() && ent.name === filename) results.push(full);
      }
    };
    try {
      walk(dir);
    } catch (e) {
      // ignore
    }
    return results;
  }

  private _parseFrontmatter(text: string): { meta: any; body: string } {
    // 用正则匹配以---开头和结尾的前置内容
    // ^---\n三横线开头
    // ([\s\S]*?)非贪婪地捕获前置块内容：正则量词尽可能少地匹配字符
    // \n---\n三横线结尾
    // ([\s\S]*)捕获主体内容：[\s\S]匹配任意字符（包括换行），*表示匹配零次或多次
    // 可以用成熟的 YAML 解析库来处理更复杂的情况 js-yaml
    const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!m) return { meta: {}, body: text.trim() };
    // m 是数组 [完整匹配, 前置块内容, 主体内容] 例如：["---\ntitle: Example\n---\nThis is the body.", "title: Example", "This is the body."]
    const metaBlock = m[1].trim();
    const body = m[2].trim();
    const meta: Record<string, string> = {};
    for (const line of metaBlock.split(/\r?\n/)) {
      if (line.includes(":")) {
        const [k, ...rest] = line.split(":");
        meta[k.trim()] = rest.join(":").trim();
      }
    }
    return { meta, body };
  }

  // 获取所有技能的描述信息，返回一个字符串列表，每行包含技能名称、描述和标签（如果有）。如果没有技能可用，则返回 "(no skills available)"。
  getDescriptions(): string {
    const keys = Object.keys(this.skills);
    if (keys.length === 0) return "(no skills available)";
    const lines: string[] = [];
    for (const name of keys) {
      const skill = this.skills[name];
      const desc = skill.meta.description ?? "No description";
      const tags = skill.meta.tags ?? "";
      let line = `  - ${name}: ${desc}`;
      if (tags) line += ` [${tags}]`;
      lines.push(line);
    }
    return lines.join("\n");
  }

  // 根据技能名称获取技能内容，返回一个包含技能名称和主体内容的字符串。如果技能不存在，则返回一个错误消息，提示未知技能并列出可用技能。
  getContent(name: string): string {
    const skill = this.skills[name];
    if (!skill) return `Error: Unknown skill '${name}'. Available: ${Object.keys(this.skills).join(", ")}`;
    return `<skill name="${name}">\n${skill.body}\n</skill>`;
  }
}

const SKILL_LOADER = new SkillLoader(SKILLS_DIR);

// 技能描述拼进 SYSTEM 提示，让模型知道有哪些技能可用
const SYSTEM = `You are a coding agent at ${WORKDIR}.\nUse load_skill to access specialized knowledge before tackling unfamiliar topics.\n\nSkills available:\n${SKILL_LOADER.getDescriptions()}`;

// -- Tool implementations --
function safePath(p: string): string {
  const full = path.resolve(WORKDIR, p);
  const rel = path.relative(WORKDIR, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return full;
}

function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) return "Error: Dangerous command blocked";
  try {
    const r = execSync(command, { cwd: WORKDIR, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 120000 });
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
    const text = fs.readFileSync(safePath(filePath), "utf8");
    let lines = text.split(/\r?\n/);
    if (limit && limit < lines.length) lines = [...lines.slice(0, limit), `... (${lines.length - limit} more)`];
    return lines.join("\n").slice(0, 50000);
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

type ToolInput = Record<string, unknown>;
type ToolHandler = (input: ToolInput) => string;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: (kw) => runBash(String(kw.command ?? "")),
  read_file: (kw) => runRead(String(kw.path ?? ""), kw.limit as number | undefined),
  write_file: (kw) => runWrite(String(kw.path ?? ""), String(kw.content ?? "")),
  edit_file: (kw) => runEdit(String(kw.path ?? ""), String(kw.old_text ?? ""), String(kw.new_text ?? "")),
  load_skill: (kw) => SKILL_LOADER.getContent(String(kw.name ?? "")),
};

const TOOLS: Anthropic.Tool[] = [
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
    name: "load_skill",
    description: "Load specialized knowledge by name.",
    input_schema: { type: "object", properties: { name: { type: "string", description: "Skill name to load" } }, required: ["name"] },
  },
];

async function agentLoop(messages: Anthropic.MessageParam[]) {
  while (true) {
    const response = await client.messages.create({ model: MODEL, system: SYSTEM, messages, tools: TOOLS, max_tokens: 8000 });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return;
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const handler = TOOL_HANDLERS[block.name];
      let output: string;
      try {
        output = handler ? handler(block.input as ToolInput) : `Unknown tool: ${block.name}`;
      } catch (e: any) {
        output = `Error: ${String(e.message ?? e)}`;
      }
      console.log(`> ${block.name}: ${String(output).slice(0, 200)}`);
      results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
    }
    messages.push({ role: "user", content: results });
  }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const history: Anthropic.MessageParam[] = [];
  const ask = () => {
    rl.question("\x1b[36ms05 >> \x1b[0m", async (query) => {
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
          if (typeof block === "object" && block && "type" in block && (block as any).type === "text") {
            console.log((block as any).text);
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
