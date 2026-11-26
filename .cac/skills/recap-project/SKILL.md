---
name: recap-project
description: 当用户敲 /recap-project、说“恢复上下文/现在做到哪了”，或新会话启动与压缩后接续项目状态时使用。同步读取活文档三件套汇报现状。
---

[任务]
    快速、准确地从磁盘活文档恢复项目完整上下文，向用户汇报当前进度、有效硬约束、断点与下一步可执行指令。除超线时先触发一次 `/archive` 外，全程只读不改文件、不派子代理。

[读取顺序与三文件同步铁律]
    1. **先跑机器状态探针**：若存在 `.cac/scripts/project-status.mjs`，先运行 `node .cac/scripts/project-status.mjs` 获取当前阶段与活文档体积；若第二行提示某份活文档已超归档线，先按 `/archive` 跑脚本瘦身后再往下读，避免被巨量陈旧历史淹没上下文。
    2. **同步精读现行三件套**（存在即读，缺哪份标未创建；**只读 `progress.md` 而不看需求与变更史不算完成恢复！不读 `progress.archive.md`**）：
       - `progress.md` → 重点提取 `Pinned`、`Decisions`（未标被取代的现行条目）、`In Progress` 当前断点、未关闭 `TODO`；
       - `Product-Spec.md` → 掌握现行需求边界与核心规则；
       - `Product-Spec-CHANGELOG.md` → 掌握最近一次需求演进方向与下游待同步项；
       - 辅助检查：`git status --short` 与当前分支状态。

[汇报结构（严格区分 `[确认]` / `[推断]` / `[建议]`）]
    按 `.cac/rules/dev-workflow-details.md` 标准进度面板呈现，并补充四项精炼摘要：
    1. **现在在哪**：`project-status.mjs` 阶段判定 + 当前 Git 分支/工作树干净度 + 最近完成项 + 当前断点位置；
    2. **生效硬约束与关键决策**：仅提炼直接约束下一步工作的 `Pinned` 与现行 `Decisions`；
    3. **待办与账实偏差预警**：列出最高优 `OPEN/DOING` TODO，并主动点出任何账实不符（如工作树有未提交代码但断点未记、Phase 实已做完未标 `✅`、待审标记 `.cac/.needs-review` 未清）；
    4. **下一步具体建议**：给出 1 条立即可执行的下一步命令或动作供用户确认。

[初始化]
    立即执行 `[读取顺序与三文件同步铁律]`，无需寒暄开场白。
