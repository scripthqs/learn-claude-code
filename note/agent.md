# agent

1. 每个代理都是一个持续调用模型直到说“停止”为止的循环。
2. 使用专业的工具来做专业的事
3. 先制定计划再动手，完成率翻倍
4. 大任务拆小，每个小任务做自己的事
5. 用到什么知识的适合，再去加载对应的知识
6. 上下文会满，要想办法腾地方
7. 大目标要拆成小任务, 排好序, 记在磁盘上
8. 慢操作丢后台, agent 继续下一步
9. "任务太大一个人干不完, 要能分给队友" -- 持久化队友 + JSONL 邮箱。
10. "队友之间要有统一的沟通规矩" -- 一个 request-response 模式驱动所有协商。
11. "队友自己看看板, 有活就认领" -- 不需要领导逐个分配, 自组织。
12. "各干各的目录, 互不干扰" -- 任务管目标, worktree 管目录, 按 ID 绑定。

LLM(大模型)：生成自然语言/结构化输出的模型。根据输入的prompt计算并返回响应（文本或结构化块）。

Prompt 有三类

- system:全局行为指令（身份、风格、限制），每次调用都发给模型
- user:用户提问或任务说明（可多次追加）
- assistant：模型的历史回复（保持上下文）

tokens: 模型内部计量单位（影响费用/上下文长度），通常 1 token ≈ 3–4 个字符。

response 结构: 除纯文本外，平台会返回一个结构化对象，可能包含：content（文本或块数组）、stop_reason、usage（tokens 用量）等。

stop_reason：表明模型停止生成的原因，常见值包括 "completed"（完成文本）、"tool_use"（模型发起工具调用，需要外部执行后继续）等。

tool calling（tool_use / tool_result）: 当模型决定需要外部能力时，输出一个 tool_use 块（声明要调用哪个工具和输入）；客户端执行后把结果以 tool_result 注入回对话，模型继续推理。

```js
messages = [
  { role: "system", content: "You are a coding agent..." },
  { role: "user", content: "列出当前目录Python文件" },
];
// tool_use 块：
{"type":"tool_use","id":"tu_1","name":"bash","input":{"command":"ls -la *.py"}}
// 客户端执行后回传：
{"type":"tool_result","tool_use_id":"tu_1","content":"file1.py\nfile2.py\n..."}
```

工具调用协议（tools）

tools:把可用外部能力（名字、说明、输入结构）告诉模型，使其能以结构化方式请求工具调用，而不是输出自由文本命令。

常见的tool_use: bash,read_file,write_file,edit_file,list_dir,git,fetch,http_request,db_query,run_test,package_manage,code_eval,file_search,image_generation,summarize,send_email

input_schema:用 JSON Schema 描述工具的输入字段与类型，减少解析错误并让模型以正确结构生成参数。

流程：客户端把 tools 发给模型 → 模型返回 tool_use → 客户端执行对应 handler → 将 tool_result 作为新的 user/assistant 内容送回模型 → 循环直到完成。

建议：尽量用严格 schema（必填字段、类型），并在执行端做白名单/权限控制

```json
{
  "name": "bash",
  "description": "Run a shell command",
  "input_schema": {
    "type": "object",
    "properties": { "command": { "type": "string" } },
    "required": ["command"]
  }
}
```

SDK调用: 官方 SDK 简化签名、错误和重试，通常接受 model、system、messages、tools 等参数

消息是 JSON：messages 是数组，每项一般有 role 与 content，content 可以是字符串或结构化块数组。

JSON Schema 就是“描述 JSON 数据结构和规则”的标准

JSON Schema 基础：核心字段 type、properties、required。

```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string" },
    "start_line": { "type": "integer" },
    "end_line": { "type": "integer" }
  },
  "required": ["path"]
}
// 使用明确字段名（不要把所有参数塞到一个 free-text 字段）。
// 用 required 强制关键参数。
// 对可能的枚举值使用 enum。
// 对路径/命令做额外校验（不只是 schema，执行前再验证、安全检查）。

// ==>
// 合法的json
{ "path": "src/app.ts", "start_line": 1, "end_line": 100 }
//不合法的json，缺少了path
{ "start_line": 1 }
```

## node fs

```ts
fs.readdirSync(d, { withFileTypes: true });
//withFileTypes:默认是false 返回该目录下的条目名
//返回 string[]
["SKILL.md", "README.md", "utils", "index.ts"]
//withFileTypes:true
//返回 fs.Dirent[]
[
  { name: "SKILL.md", isFile: [Function], isDirectory: [Function], isSymbolicLink: [Function], ... },
  { name: "utils",  isFile: [Function], isDirectory: [Function], ... }
]

// 返回的 name 只是文件/目录名；若需要完整路径 需要实用
// path.join(dir, ent.name)

// fs.readdirSync() 不承诺返回有确定顺序，遍历结果会受操作系统、文件系统、创建、缓存等影响
```

path.dirname： —— 取目录
path.resolve：就是终端模拟cd
path.join: 拼路径，会自动处理分隔符，多了去掉、少了补上，保证结果是格式正确的路径。

```js
path.dirname("/a/b/c.txt");
// /a/b
```

```bash
# path.resolve 就是在终端里 cd
cd /home/project
cd /etc/passwd    # 绝对路径，直接跳到根目录
# 当前位置：/etc/passwd

cd /home/project
cd ../../etc      # ../往上跳
# 当前位置：/etc

# 和 path.resolve 完全一致
# path.resolve("/home/project", "/etc/passwd")  // → "/etc/passwd"
# path.resolve("/home/project", "../../etc")    // → "/etc"
```

```js
path.join("/home/project", "/etc/passwd");
// → "/home/project/etc/passwd"
//                 ↑ 两个 / 合并成一个
path.join("/home/project/", "/etc/passwd");
// → "/home/project/etc/passwd"
//                 ↑ 同样合并
path.join("/home/project", "etc/passwd");
// → "/home/project/etc/passwd"
//                 ↑ 自动加上
```

## 管理数据

任务管理、购物车（管理商品）、用户系统（管理用户）、聊天记录（管理消息）

1. 数据建模 → 这个东西有哪些属性？ → Type/Interface
2. 操作建模 → 用户能做什么？ → 方法签名
3. 存储选型 → 数据放哪里？ → 文件/DB/内存
4. 逐个实现 → 从简单到复杂 → CRUD 顺序写
5. 处理关联 → 数据之间有依赖吗？ → 双向更新/级联

## 工具类实现 IPO 模型

Input（输入）→ Process（处理）→ Output（输出）
