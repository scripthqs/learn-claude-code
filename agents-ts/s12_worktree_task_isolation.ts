/**
 * s12_worktree_task_isolation.ts - Worktree + Task Isolation
 *
 * Directory-level isolation for parallel task execution.
 * Tasks are the control plane and worktrees are the execution plane.
 *
 *     .tasks/task_12.json
 *       {
 *         "id": 12,
 *         "subject": "Implement auth refactor",
 *         "status": "in_progress",
 *         "worktree": "auth-refactor"
 *       }
 *
 *     .worktrees/index.json
 *       {
 *         "worktrees": [
 *           {
 *             "name": "auth-refactor",
 *             "path": ".../.worktrees/auth-refactor",
 *             "branch": "wt/auth-refactor",
 *             "task_id": 12,
 *             "status": "active"
 *           }
 *         ]
 *       }
 *
 * Key insight: "Isolate by directory, coordinate by task ID."
 */

import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { execSync, exec } from "child_process";
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

// -- Types --

type TaskStatus = "pending" | "in_progress" | "completed";

type Task = {
  id: number;
  subject: string;
  description: string;
  status: TaskStatus;
  owner: string;
  worktree: string;
  blockedBy: number[];
  created_at: number;
  updated_at: number;
};

type WorktreeStatus = "active" | "kept" | "removed";

type WorktreeEntry = {
  name: string;
  path: string;
  branch: string;
  task_id: number | null;
  status: WorktreeStatus;
  created_at: number;
  removed_at?: number;
  kept_at?: number;
};

type WorktreeIndex = {
  worktrees: WorktreeEntry[];
};

type EventPayload = {
  event: string;
  ts: number;
  task: Record<string, any>;
  worktree: Record<string, any>;
  error?: string;
};

// -- Detect git repo root --

// 检测 git 仓库根目录
function detectRepoRoot(cwd: string): string | null {
  try {
    const result = execSync("git rev-parse --show-toplevel", {
      cwd,
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    })
      .toString()
      .trim();
    return fs.existsSync(result) ? result : null;
    // 确认路径真实存在才返回，否则返回 null
  } catch {
    return null;
  }
}

const REPO_ROOT = detectRepoRoot(WORKDIR) ?? WORKDIR;
// 优先用 git 仓库根目录
// 如果不在 git 仓库里，就用当前工作目录兜底
// .tasks/ 和 .worktrees/ 应该放在仓库根目录
// 不应该放在 src/ 里

const SYSTEM =
  `You are a coding agent at ${WORKDIR}. ` +
  "Use task + worktree tools for multi-task work. " +
  "For parallel or risky changes: create tasks, allocate worktree lanes, " +
  "run commands in those lanes, then choose keep/remove for closeout. " +
  "Use worktree_events when you need lifecycle visibility.";
// 1. 你在哪个目录工作
// 2. 怎么用 task + worktree 工具
// 3. 并行或有风险的改动要用 worktree 隔离
// 4. 最后选择保留或删除 worktree

// -- EventBus: append-only lifecycle events for observability --

// 记录操作日志, 只追加，不清空, 所有事件一个文件
class EventBus {
  private filePath: string;
  // 事件日志文件路径
  // 实际值：REPO_ROOT/.worktrees/events.jsonl

  constructor(eventLogPath: string) {
    this.filePath = eventLogPath;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    // 确保 .worktrees/ 目录存在
    // recursive: true 表示父目录不存在也一并创建
    // 相当于 mkdir -p

    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, "", "utf8");
    }
    // 文件不存在就创建一个空文件
    // 避免后续读取时报错
  }

  // 写入一条事件
  emit(event: string, task: Record<string, any> = {}, worktree: Record<string, any> = {}, error?: string): void {
    const payload: EventPayload = {
      event,
      ts: Date.now() / 1000,
      task,
      worktree,
    };
    if (error) payload.error = error;
    // 只有出错时才加 error 字段
    // 不出错就不加，保持日志简洁
    fs.appendFileSync(this.filePath, JSON.stringify(payload) + "\n", "utf8");
    // 追加一行到 events.jsonl
    // 和 MessageBus 的 send 方法一样的模式
  }

  // 读取最近的事件
  listRecent(limit: number = 20): string {
    const n = Math.max(1, Math.min(limit, 200));
    const lines = fs.readFileSync(this.filePath, "utf8").split("\n").filter(Boolean);
    // 读取整个文件
    // 按换行分割成数组
    // filter(Boolean) 过滤掉空行
    // （文件末尾通常有一个空行）
    const recent = lines.slice(-n);
    // 取最后 n 行
    // slice(-20) = 取最后20条
    // 最新的事件在文件末尾
    const items = recent.map((line) => {
      try {
        return JSON.parse(line); // 解析成对象
      } catch {
        return { event: "parse_error", raw: line };
      }
    });
    return JSON.stringify(items, null, 2);
    // 返回格式化的 JSON 字符串
    // null, 2 表示缩进2个空格，方便阅读
  }
}

// -- TaskManager: persistent task board with optional worktree binding --
// 管理 .tasks/ 目录里的任务文件
class TaskManager {
  private dir: string;
  private nextId: number;

  constructor(tasksDir: string) {
    this.dir = tasksDir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.nextId = this.maxId() + 1;
  }

  private maxId(): number {
    const files = fs.readdirSync(this.dir).filter((f) => f.match(/^task_\d+\.json$/));
    const ids = files.map((f) => parseInt(f.replace("task_", "").replace(".json", ""), 10));
    return ids.length ? Math.max(...ids) : 0;
  }

  private taskPath(taskId: number): string {
    return path.join(this.dir, `task_${taskId}.json`);
  }

  private load(taskId: number): Task {
    const p = this.taskPath(taskId);
    if (!fs.existsSync(p)) throw new Error(`Task ${taskId} not found`);
    return JSON.parse(fs.readFileSync(p, "utf8"));
  }

  private save(task: Task): void {
    fs.writeFileSync(this.taskPath(task.id), JSON.stringify(task, null, 2), "utf8");
  }

  exists(taskId: number): boolean {
    return fs.existsSync(this.taskPath(taskId));
  }

  create(subject: string, description: string = ""): string {
    const task: Task = {
      id: this.nextId,
      subject,
      description,
      status: "pending",
      owner: "",
      worktree: "",
      blockedBy: [],
      created_at: Date.now() / 1000,
      updated_at: Date.now() / 1000,
    };
    this.save(task);
    this.nextId++;
    return JSON.stringify(task, null, 2);
  }

  get(taskId: number): string {
    return JSON.stringify(this.load(taskId), null, 2);
  }

  update(taskId: number, status?: string, owner?: string): string {
    const task = this.load(taskId);
    if (status) {
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Invalid status: ${status}`);
      }
      task.status = status as TaskStatus;
    }
    if (owner !== undefined) task.owner = owner;
    task.updated_at = Date.now() / 1000;
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  bindWorktree(taskId: number, worktree: string, owner: string = ""): string {
    const task = this.load(taskId);
    task.worktree = worktree; // 记录绑定的 worktree 名字
    if (owner) task.owner = owner;
    if (task.status === "pending") task.status = "in_progress";
    // 绑定 worktree 意味着开始工作了
    // 自动把状态从 pending 改成 in_progress
    task.updated_at = Date.now() / 1000;
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  unbindWorktree(taskId: number): string {
    const task = this.load(taskId);
    task.worktree = ""; // 清空 worktree 绑定
    task.updated_at = Date.now() / 1000;
    this.save(task);
    return JSON.stringify(task, null, 2);
    // worktree 删除后调用
    // 任务状态由调用方决定（可能是 completed，可能继续 in_progress）
  }

  listAll(): string {
    const files = fs
      .readdirSync(this.dir)
      .filter((f) => f.match(/^task_\d+\.json$/))
      .sort();
    // 读取所有任务文件，按文件名排序
    // sort() 默认字符串排序
    // task_1, task_10, task_2 → 注意：字符串排序可能不是数字顺序
    // 但任务数量通常不多，影响不大
    if (!files.length) return "No tasks.";
    const lines = files.map((f) => {
      const t: Task = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8"));
      const marker: Record<string, string> = {
        pending: "[ ]",
        in_progress: "[>]",
        completed: "[x]",
      };
      const owner = t.owner ? ` owner=${t.owner}` : "";
      const wt = t.worktree ? ` wt=${t.worktree}` : "";
      // 有值才显示，没有就不显示，保持输出简洁
      return `${marker[t.status] ?? "[?]"} #${t.id}: ${t.subject}${owner}${wt}`;
    });
    return lines.join("\n");
  }
}

// -- WorktreeManager: create/list/run/remove git worktrees + lifecycle index --

// 封装所有 git worktree 操作
class WorktreeManager {
  private repoRoot: string; // git 仓库根目录
  private tasks: TaskManager; // 任务管理器，用来绑定/解绑任务
  private events: EventBus; // 事件总线，记录操作日志
  private dir: string; // .worktrees/ 目录路径
  private indexPath: string; // .worktrees/index.json 路径
  public gitAvailable: boolean; // 是否在 git 仓库里

  constructor(repoRoot: string, tasks: TaskManager, events: EventBus) {
    this.repoRoot = repoRoot;
    this.tasks = tasks;
    this.events = events;
    this.dir = path.join(repoRoot, ".worktrees");
    this.indexPath = path.join(this.dir, "index.json");
    fs.mkdirSync(this.dir, { recursive: true });
    // 确保 .worktrees/ 目录存在
    if (!fs.existsSync(this.indexPath)) {
      fs.writeFileSync(this.indexPath, JSON.stringify({ worktrees: [] }, null, 2), "utf8");
      // index.json 不存在就创建一个空的
      // { worktrees: [] } 是初始结构
    }
    this.gitAvailable = this.isGitRepo();
    // 检测是否在 git 仓库里
    // 结果存起来，后续每次操作前检查
  }

  private isGitRepo(): boolean {
    try {
      execSync("git rev-parse --is-inside-work-tree", {
        cwd: this.repoRoot,
        timeout: 10000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return true;
    } catch {
      return false;
    }
  }

  private runGit(args: string[]): string {
    if (!this.gitAvailable) {
      throw new Error("Not in a git repository. worktree tools require git.");
    }
    try {
      const result = execSync(`git ${args.join(" ")}`, {
        cwd: this.repoRoot,
        timeout: 120000,
        stdio: ["pipe", "pipe", "pipe"],
      })
        .toString()
        .trim();
      return result || "(no output)";
    } catch (e: any) {
      const msg = e.stdout?.toString() + e.stderr?.toString();
      throw new Error(msg?.trim() || `git ${args.join(" ")} failed`);
    }
  }

  private loadIndex(): WorktreeIndex {
    return JSON.parse(fs.readFileSync(this.indexPath, "utf8"));
    // 每次操作都重新读文件
    // 保证拿到最新状态
  }

  private saveIndex(data: WorktreeIndex): void {
    fs.writeFileSync(this.indexPath, JSON.stringify(data, null, 2), "utf8");
  }

  private find(name: string): WorktreeEntry | undefined {
    return this.loadIndex().worktrees.find((wt) => wt.name === name);
    // 按名字查找 worktree
    // 找不到返回 undefined
  }

  private validateName(name: string): void {
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(name ?? "")) {
      throw new Error("Invalid worktree name. Use 1-40 chars: letters, numbers, ., _, -");
    }
    // 正则校验：只允许字母数字和 . _ -
    // 长度 1-40
    // 防止路径注入，比如 name="../../etc/passwd"
  }

  create(name: string, taskId?: number, baseRef: string = "HEAD"): string {
    this.validateName(name); // 校验名字格式
    if (this.find(name)) throw new Error(`Worktree '${name}' already exists in index`);
    if (taskId !== undefined && !this.tasks.exists(taskId)) {
      throw new Error(`Task ${taskId} not found`);
    }
    // 防止重复创建同名 worktree

    const wtPath = path.join(this.dir, name);
    // worktree 的实际目录：.worktrees/auth-refactor
    const branch = `wt/${name}`;
    // worktree 对应的分支名：wt/auth-refactor
    // 统一加 wt/ 前缀，和普通分支区分

    this.events.emit("worktree.create.before", taskId !== undefined ? { id: taskId } : {}, { name, base_ref: baseRef });
    // 记录操作开始

    try {
      this.runGit(["worktree", "add", "-b", branch, wtPath, baseRef]);
      // 执行：git worktree add -b wt/auth-refactor .worktrees/auth-refactor HEAD
      // -b branch：创建新分支
      // wtPath：worktree 的目录
      // baseRef：从哪个提交开始，默认 HEAD（当前最新）

      const entry: WorktreeEntry = {
        name,
        path: wtPath,
        branch,
        task_id: taskId ?? null,
        status: "active",
        created_at: Date.now() / 1000,
      };

      const idx = this.loadIndex();
      idx.worktrees.push(entry);
      this.saveIndex(idx);
      // 把新 worktree 记录到 index.json

      if (taskId !== undefined) {
        this.tasks.bindWorktree(taskId, name);
        // 同时更新任务文件，记录绑定关系
      }

      this.events.emit("worktree.create.after", taskId !== undefined ? { id: taskId } : {}, {
        name,
        path: wtPath,
        branch,
        status: "active",
      });

      return JSON.stringify(entry, null, 2);
    } catch (e: any) {
      this.events.emit(
        "worktree.create.failed",
        taskId !== undefined ? { id: taskId } : {},
        { name, base_ref: baseRef },
        String(e.message),
      );
      throw e;
    }
  }

  listAll(): string {
    const wts = this.loadIndex().worktrees;
    if (!wts.length) return "No worktrees in index.";
    return wts
      .map((wt) => {
        const suffix = wt.task_id != null ? ` task=${wt.task_id}` : "";
        return `[${wt.status ?? "unknown"}] ${wt.name} -> ${wt.path} (${wt.branch ?? "-"})${suffix}`;
      })
      .join("\n");
  }

  status(name: string): string {
    const wt = this.find(name);
    if (!wt) return `Error: Unknown worktree '${name}'`;
    if (!fs.existsSync(wt.path)) return `Error: Worktree path missing: ${wt.path}`;
    try {
      const result = execSync("git status --short --branch", {
        cwd: wt.path,
        timeout: 60000,
        stdio: ["pipe", "pipe", "pipe"],
      })
        .toString()
        .trim();
      return result || "Clean worktree";
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  }
  // 在指定 worktree 目录执行
  run(name: string, command: string): string {
    const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
    if (dangerous.some((d) => command.includes(d))) {
      return "Error: Dangerous command blocked";
    }
    const wt = this.find(name);
    if (!wt) return `Error: Unknown worktree '${name}'`;
    if (!fs.existsSync(wt.path)) return `Error: Worktree path missing: ${wt.path}`;

    try {
      const result = execSync(command, {
        cwd: wt.path, // 关键：在 worktree 目录里执行
        timeout: 300000,
        maxBuffer: 50 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      })
        .toString()
        .trim();
      return result.slice(0, 50000) || "(no output)";
    } catch (e: any) {
      if (e.killed) return "Error: Timeout (300s)";
      const out = ((e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? "")).trim();
      return out.slice(0, 50000) || `Error: ${e.message}`;
    }
  }
  // 删除 worktree 目录 + 标记 status=removed
  // 任务完成，代码已合并，不需要了
  remove(name: string, force: boolean = false, completeTask: boolean = false): string {
    const wt = this.find(name);
    if (!wt) return `Error: Unknown worktree '${name}'`;

    this.events.emit("worktree.remove.before", wt.task_id != null ? { id: wt.task_id } : {}, { name, path: wt.path });

    try {
      const args = ["worktree", "remove"];
      if (force) args.push("--force");
      args.push(wt.path);
      this.runGit(args);

      if (completeTask && wt.task_id != null) {
        const taskId = wt.task_id;
        const before: Task = JSON.parse(this.tasks.get(taskId));
        this.tasks.update(taskId, "completed");
        this.tasks.unbindWorktree(taskId);
        this.events.emit("task.completed", { id: taskId, subject: before.subject, status: "completed" }, { name });
      }

      const idx = this.loadIndex();
      for (const item of idx.worktrees) {
        if (item.name === name) {
          item.status = "removed";
          item.removed_at = Date.now() / 1000;
        }
      }
      this.saveIndex(idx);

      this.events.emit("worktree.remove.after", wt.task_id != null ? { id: wt.task_id } : {}, { name, path: wt.path, status: "removed" });

      return `Removed worktree '${name}'`;
    } catch (e: any) {
      this.events.emit("worktree.remove.failed", wt.task_id != null ? { id: wt.task_id } : {}, { name, path: wt.path }, String(e.message));
      throw e;
    }
  }
  // 不删除目录 + 标记 status=kept
  // 任务完成，但想保留这个分支继续参考
  keep(name: string): string {
    const wt = this.find(name);
    if (!wt) return `Error: Unknown worktree '${name}'`;

    const idx = this.loadIndex();
    let kept: WorktreeEntry | undefined;
    for (const item of idx.worktrees) {
      if (item.name === name) {
        item.status = "kept";
        item.kept_at = Date.now() / 1000;
        kept = item;
      }
    }
    this.saveIndex(idx);

    this.events.emit("worktree.keep", wt.task_id != null ? { id: wt.task_id } : {}, { name, path: wt.path, status: "kept" });

    return kept ? JSON.stringify(kept, null, 2) : `Error: Unknown worktree '${name}'`;
  }
}
// -- Instantiate singletons --

const TASKS = new TaskManager(path.join(REPO_ROOT, ".tasks"));
const EVENTS = new EventBus(path.join(REPO_ROOT, ".worktrees", "events.jsonl"));
const WORKTREES = new WorktreeManager(REPO_ROOT, TASKS, EVENTS);

// -- Base tools --

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

// -- Tool dispatch --
// 工具被调用时实际执行的代码
const TOOL_HANDLERS: Record<string, (...args: any[]) => any> = {
  bash: async ({ command }: any) => await runBash(command),
  read_file: ({ path: p, limit }: any) => runRead(p, limit),
  write_file: ({ path: p, content }: any) => runWrite(p, content),
  edit_file: ({ path: p, old_text: o, new_text: n }: any) => runEdit(p, o, n),
  task_create: ({ subject, description }: any) => TASKS.create(subject, description ?? ""),
  task_list: () => TASKS.listAll(),
  task_get: ({ task_id }: any) => TASKS.get(task_id),
  task_update: ({ task_id, status, owner }: any) => TASKS.update(task_id, status, owner),
  task_bind_worktree: ({ task_id, worktree, owner }: any) => TASKS.bindWorktree(task_id, worktree, owner ?? ""),
  worktree_create: ({ name, task_id, base_ref }: any) => WORKTREES.create(name, task_id, base_ref ?? "HEAD"),
  worktree_list: () => WORKTREES.listAll(),
  worktree_status: ({ name }: any) => WORKTREES.status(name),
  worktree_run: ({ name, command }: any) => WORKTREES.run(name, command),
  worktree_keep: ({ name }: any) => WORKTREES.keep(name),
  worktree_remove: ({ name, force, complete_task }: any) => WORKTREES.remove(name, force ?? false, complete_task ?? false),
  worktree_events: ({ limit }: any) => EVENTS.listRecent(limit ?? 20),
};
//  告诉 Claude 有哪些工具，怎么用
const TOOLS = [
  {
    name: "bash",
    description: "Run a shell command in the current workspace (blocking).",
    // description 是给 Claude 看的，Claude 靠这个决定什么时候用这个工具
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
    name: "task_create",
    description: "Create a new task on the shared task board.",
    input_schema: { type: "object", properties: { subject: { type: "string" }, description: { type: "string" } }, required: ["subject"] },
  },
  {
    name: "task_list",
    description: "List all tasks with status, owner, and worktree binding.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "task_get",
    description: "Get task details by ID.",
    input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] },
  },
  {
    name: "task_update",
    description: "Update task status or owner.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "integer" },
        status: { type: "string", enum: ["pending", "in_progress", "completed"] },
        owner: { type: "string" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "task_bind_worktree",
    description: "Bind a task to a worktree name.",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "integer" }, worktree: { type: "string" }, owner: { type: "string" } },
      required: ["task_id", "worktree"],
    },
  },
  {
    name: "worktree_create",
    description: "Create a git worktree and optionally bind it to a task.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" }, task_id: { type: "integer" }, base_ref: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "worktree_list",
    description: "List worktrees tracked in .worktrees/index.json.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "worktree_status",
    description: "Show git status for one worktree.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "worktree_run",
    description: "Run a shell command in a named worktree directory.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" }, command: { type: "string" } },
      required: ["name", "command"],
    },
  },
  {
    name: "worktree_remove",
    description: "Remove a worktree and optionally mark its bound task completed.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" }, force: { type: "boolean" }, complete_task: { type: "boolean" } },
      required: ["name"],
    },
  },
  {
    name: "worktree_keep",
    description: "Mark a worktree as kept in lifecycle state without removing it.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "worktree_events",
    description: "List recent worktree/task lifecycle events from .worktrees/events.jsonl.",
    input_schema: { type: "object", properties: { limit: { type: "integer" } } },
  },
];

// -- Agent loop --

async function agentLoop(messages: any[]): Promise<void> {
  while (true) {
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
  console.log(`Repo root for s12: ${REPO_ROOT}`);
  if (!WORKTREES.gitAvailable) {
    console.log("Note: Not in a git repo. worktree_* tools will return errors.");
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const history: any[] = [];

  const ask = () =>
    rl.question("\x1b[36ms12 >> \x1b[0m", async (line) => {
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
