import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "child_process";
import * as path from "path";
// 逐行读取终端输入
import * as readline from "readline";
import * as dotenv from "dotenv";

// 读取上一级的 .env
dotenv.config({ path: path.resolve(__dirname, "../.env") });

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

// process：获取当前进程的环境信息

const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL = process.env.MODEL_ID!;
const SYSTEM = `You are a coding agent at ${process.cwd()}. Use bash to solve tasks. Act, don't explain.`;

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
];

function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }
  try {
    // execSync：当前进出运行shell命令，encoding：指定输出编码，timeout：设置命令执行的超时时间（单位为毫秒），trim()：去除命令输出的前后空白字符
    return execSync(command, { encoding: "utf-8", timeout: 120000 }).trim();
  } catch (e: any) {
    return e.stdout?.trim() || e.message;
  }
}

async function agentLoop(messages: Anthropic.MessageParam[]) {
  console.log("messages", JSON.stringify(messages, null, 2));

  while (true) {
    // response会返回一个对象，其中content属性包含模型生成的回复内容，stop_reason属性指示生成停止的原因（如达到最大令牌数、工具使用等）。如果stop_reason不是"tool_use"，则退出循环。
    const response = await client.messages.create({
      model: MODEL,
      // system（系统角色，提供背景信息和指导原则），user（用户角色，包含用户输入的内容），assistant（助手角色，包含模型生成的回复）。
      system: SYSTEM,
      // messages数组中的每个元素都应该包含一个role属性（值为system、user或assistant）和一个content属性（包含相应角色的文本内容）。
      messages,
      // tools:把可用外部能力（名字、说明、输入结构）告诉模型，使其能以结构化方式请求工具调用，而不是输出自由文本命令。
      tools: TOOLS,
      max_tokens: 8000,
    });

    // console.log("智能体响应", JSON.stringify(response, null, 2));

    messages.push({ role: "assistant", content: response.content });
    // stop_reason：表明模型停止生成的原因，常见值包括 "completed"（完成文本）、"tool_use"（模型发起工具调用，需要外部执行后继续）等。
    if (response.stop_reason !== "tool_use") return;

    const results: Anthropic.ToolResultBlockParam[] = [];
    // 块数组
    for (const block of response.content) {
      // block.type：指示块的类型，如 "text"（普通文本）、"tool_use"（工具调用请求）等。根据类型不同，处理方式也不同。
      if (block.type === "tool_use") {
        const command = (block.input as { command: string }).command;
        // \x1b[33m：设置文本颜色为黄色，\x1b[0m：重置文本格式。这样输出的命令会以黄色显示，突出显示在终端中。
        console.log(`\x1b[33m$ ${command}\x1b[0m`);

        const output = runBash(command);
        console.log(output.slice(0, 200));
        // results数组中添加一个新的对象，表示工具调用的结果。这个对象包含三个属性：type（固定为 "tool_result"），tool_use_id（对应于原始工具调用块的ID），content（工具执行后的输出结果）。
        results.push({ type: "tool_result", tool_use_id: block.id, content: output });
      }
    }
    // messages数组中添加一个新的用户消息，内容是工具调用的结果。这使得模型在下一轮生成时可以看到工具执行的结果，并基于此继续对话。
    messages.push({ role: "user", content: results });
  }
}

async function main() {
  // 逐行读取终端输入
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // history数组用于存储对话历史，每条消息都包含一个角色（user或assistant）和相应的内容。这些消息将被传递给模型，以便它能够基于上下文生成回复。
  const history: Anthropic.MessageParam[] = [];
  const ask = () => {
    //  \x1b转义字符 等同于 ESC
    rl.question("\x1b[36ms01 >> \x1b[0m", async (query) => {
      // query:用户输入的查询字符串。通过rl.question方法获取用户输入，并在回调函数中处理这个输入。
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
      const last = history[history.length - 1].content;
      if (Array.isArray(last)) {
        for (const block of last) {
          if (typeof block === "object" && "text" in block) {
            console.log("最终的回复", block.text);
          }
        }
      }
      console.log();
      // 递归调用ask函数，继续等待用户输入。这使得整个程序能够持续运行，直到用户选择退出。
      ask();
    });
  };
  ask();
}

main();
