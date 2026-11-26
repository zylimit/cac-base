---
name: archive
description: 当用户敲 /archive 或提示 progress.md、DEV-PLAN.md 过长需要归档瘦身时使用。调用纯 Node 归档脚本无损搬迁历史记录。
---

[任务]
    将 `progress.md` 中超阈值的历史记录原文无损搬迁至 `progress.archive.md`，并将 `DEV-PLAN.md` 中过多已完成 Phase 原文无损搬迁至 `DEV-PLAN.archive.md`（保留 REQ 覆盖指针）。机械搬运一律优先交由纯 Node 脚本执行，杜绝大模型手敲搬运丢字。

[工作流程]
    1. **同轮先后顺序**：若本轮还有未落账的进度，先走 `/record` 落账，再执行本归档流程。
    2. **归档 `progress.md`**：
       - 若存在 `.cac/scripts/progress-archive.mjs`，主 Agent 直接运行 `node .cac/scripts/progress-archive.mjs`，读取输出与退出码（未达归档线则如实回复当前条数与体积，不硬搬）；
       - 仅在脚本不存在的裸环境下，才派 `progress-recorder`（`mode: archive`）按「先写归档、逐条搜到核实、再删正文」规程搬运。
    3. **归档 `DEV-PLAN.md` 并复核双向覆盖**：
       - 若项目存在 `DEV-PLAN.md` 且存在 `.cac/scripts/plan-archive.mjs`，运行 `node .cac/scripts/plan-archive.mjs`；
       - 只要发生了 Phase 搬迁，**必须紧接着运行 `node .cac/scripts/plan-lint.mjs`** 校验退出码仍为 `0`（确认 `## 已归档 Phase` 指针行的 `（REQ：…）` 后缀完整承接了需求覆盖）；
       - 若脚本提示存在「排在已完成 Phase 之前却未标 `✅` 的 Phase」或「非整数 Phase 编号」，原样列出请用户核定，严禁私自篡改未标 `✅` 的 Phase。
    4. **保护红线**：`progress.md` 的 `Pinned` 与未关闭 `TODO`、`DEV-PLAN.md` 中未标 `✅` 的 Phase 与 `## 范围外（本次不计划）` 永远不搬；`*.archive.md` 只增不删。

[初始化]
    执行 `[工作流程]`，逐项向用户汇报实际搬迁条数与瘦身后的活文档状态。
