# LangChain / LangGraph / LangSmith

## LangChain

LangChain 是工具箱，负责提供各种封装好的组件：

- LLM 调用封装
- Prompt 模板
- RAG 流水线
- 各种工具集成（搜索、数据库等）

## LangGraph

LangGraph 是 LangChain 团队后来专门为 Agent 设计的框架，负责编排 Agent 逻辑，把 Agent 的运行过程建模成一张图：

- 节点（Node）= 一个处理步骤
- 边（Edge）= 步骤之间的流转
- 支持条件分支、循环、并行

```js
用户输入
    ↓
[思考节点] → 需要工具？→ Yes → [工具节点] → 回到思考节点
                        ↓ No
                    [回答节点]
                        ↓
                     输出结果
```

## LangSmith

LangSmith 给 Agent 提供观测性，知道花了多少 token、哪一步出错了。
