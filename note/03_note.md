# TodoWrite

TodoWrite为模型提供了一个可见的计划。所有任务都以待处理状态开始

"没有计划的 agent 走哪算哪" -- 先列步骤再动手, 完成率翻倍。

- TodoManager 存储带状态的项目。同一时间只允许一个 in_progress。
- todo 工具和其他工具一样加入 dispatch map。
- nag reminder: 模型连续 3 轮以上不调用 todo 时注入提醒。
