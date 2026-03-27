# skills

```js
skill-name/
├── SKILL.md (必需)
│   ├── YAML 前置元数据 (必需)
│   │   ├── name: (必需)
│   │   └── description: (必需)
│   └── Markdown 指令 (必需)
└── 打包资源 (可选)
    ├── scripts/     - 可执行代码
    ├── references/  - 上下文文档
    └── assets/      - 输出文件（模板等）
```

## skills.md格式

```js
---
name: your-skill-name
description: 这个技能做什么以及何时使用。包括触发上下文、文件类型、任务类型和用户可能提及的关键词。
---

# Your Skill Name

[指令部分]
Claude 的清晰、分步指导。

[示例部分]
具体的输入/输出示例。
```

### 前置元数据要求

字段 必需 约束

- name 是 小写，允许连字符，最多 64 字符
- description 是 最多 1024 字符，必须包含 WHAT 和 WHEN

## 打包资源

### scripts

可执行脚本(python,bash)，用于确定性可靠性任务

- 相同代码被重复编写
- 需要确定性可靠性
- 容易出错的复杂操作

优点：

- token高效
- 确定性结果
- 可以在不加载到上下文的情况下执行

### references

根据需要加载到上下文中的文档

- 数据库结构
- API文档
- 领域知识
- 公司政策
- 详细工作流程指南

如果文件较大（>10k 字），在 SKILL.md 中包含 grep 搜索模式。

仅在 SKILL.md 中保留基本程序指令；将详细参考资料移到 references 文件。

### assets

不加载到上下文但在输出中使用的文件

- 模板ppt、文档
- logo、图标
- 样板代码
- 字体代码
- 字体

将输出资源与文档分离，使 agent 能够使用而不加载
