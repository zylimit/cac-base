---
name: record
description: 当用户敲 /record 或要求“记一下”、“把本轮决策和进度记进 progress.md”时使用。收集显式增量并派发 progress-recorder 合并落账。
argument-hint: "[要重点记录的事项（可选）]"
---

[任务]
    作为用户侧 `/record` 入口，收齐本轮尚未落账的决策、硬约束、完成项、断点与待办，派发专职 `progress-recorder` 子代理增量合并至项目根 `progress.md`，并在超线时衔接机械归档。

[工作流程]
    1. **整理显式对话增量（无 `fork` 克隆适配）**：
       - 先 `Read .cac/rules/memory-systems.md` 与 `.cac/rules/subagent-dispatch.md`；
       - `codeagent` 宿主不支持克隆当前会话历史，主 Agent 必须在七字段派单的 `Business Context` 中**原样摘录本轮用户拍板原话、决策依据/适用范围/取代关系、已完成事项及客观证据句柄（commit / 测试结果 / 文件路径）**；
       - 若本轮纯属闲聊或只读查看、无任何决策/约束/进度增量，直接回复「本轮无新增项目决策或进度需要入账」，不空派子代理。
    2. **派发 `progress-recorder`**：传入 `mode: record`、项目根路径与结构化增量摘录。
    3. **验收与自动超线巡检**：
       - 收回执后 `Read` 核查 `progress.md` 实际变更，向用户一行汇报写入了哪个区块几条记录；
       - 若存在 `.cac/scripts/progress-archive.mjs`，顺手运行 `node .cac/scripts/progress-archive.mjs --check`：若报超线待归档，紧接着执行 `/archive` 机械搬运收口，不攒历史包袱。

[初始化]
    提取本轮增量（若用户在 `/record` 后附了文字则以其为核心重点），执行 `[工作流程]`。
