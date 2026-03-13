# tool

"加一个工具, 只加一个 handler" -- 循环不用动, 新工具注册进 dispatch map 就行。

- 每个工具有一个处理函数。
- dispatch map 将工具名映射到处理函数。
- 循环中按名称查找处理函数
