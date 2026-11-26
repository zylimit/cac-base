---
name: progress-recorder
description: 当产生关键决策、硬约束、任务完成或断点变更时，由 progress-recorder 子代理内部调用，对 progress.md 执行去重增量合并。
user-invocable: false
---

[任务]
    供 `progress-recorder` 子代理内部使用（终端用户请敲 `/record` 或 `/archive`）：接收主 Agent 显式传入的对话增量摘录（`delta`）与 `mode`，对项目根 `progress.md` 执行高置信语义抽取、去重与区块级增量合并。

[文件位置与顶格排版规范]
    - 目标文件：项目根 `progress.md`（归档文件为同级 `progress.archive.md`，严禁放进 `.cac/`）。
    - **顶格铁律**：写入文件的所有 `## ` 标题与 `- ` 列表项必须从第 0 列顶格开始（严禁全篇缩进 4 空格，否则 `progress-archive.mjs` 无法识别条目）。

[标准 `progress.md` 模板结构]
```markdown
# Project: <项目名称>
_Last updated: YYYY-MM-DD_

## Pinned
- <长期硬约束>（依据：<用户原话或外部限制>；适用范围：<边界>）

## Decisions
- YYYY-MM-DD: <决策结论>（依据：<取舍理由与被拒备选>；适用范围：<边界>；取代：<旧决策日期或「无」>）

## TODO
- [P0][OPEN][#1] <可执行待办>（Context：<文件路径或关联项>）

## In Progress
- **断点（YYYY-MM-DD）**：<当前停在何处、下一步入口、未提交状态>

## Done
- YYYY-MM-DD: [#N] <已完成事项摘要>（evidence：<commit / 测试结果 / 产物路径>）

## Risks & Assumptions
- Risk: <已知风险>（Mitigation：<缓解措施>）

## Notes
- YYYY-MM-DD: <简短备忘或 Needs-Confirmation 待确认项>

## Context Index
- Archive: ./progress.archive.md
```

[区块合并与防膨胀硬规则]
    1. **高置信门槛**：仅确定性拍板或用户明确纠正才进 `Pinned` / `Decisions`；带「可能/考虑/建议」的讨论一律降级入 `Notes` 并标 `Needs-Confirmation`。服务器端口、目录路径等静态事实进 `Context Index`，不塞满 `Pinned`。
    2. **`Pinned` 封顶 15 条**：满额需新增时，先将较弱条目合并或降级至 `Decisions`。
    3. **`Decisions` 必带三要素 + 取代检查**：每条必含「依据 / 适用范围 / 取代」，推翻或收窄旧决策时在旧条末尾追加 `→ 被 YYYY-MM-DD 取代`（历史原文不删）；若属复杂模块内部计算规则且已有 `docs/design/*.md`，此处只记一行指针避免双份漂移。
    4. **唯一当前断点**：写入新断点前，将旧断点中已完成的事实归入 `Done`，随后整条替换旧断点——`In Progress` 永远只保留当前最新 1 条断点（≤400 字）。
    5. **单条字数上限**：`Done` 与 `Notes` 单条 ≤120 字（必带客观 `evidence` 句柄，不虚构），`Decisions` 单条 ≤400 字，`TODO` `#ID` 全局单调递增不重用（兼顾归档指针中的最大编号）。
    6. **超线归档交给脚本**：当 `Notes + Done > 100` 条、`Decisions > 30` 条、已关闭 `TODO > 20` 条或单段体积超阈值时，因本角色无 `Bash` 权限，在回执 `Evidence` 明确报告超线区块，请主 Agent 运行 `node .cac/scripts/progress-archive.mjs` 机械归档（仅在脚本确不存在的环境下，才遵循「先追加 `progress.archive.md` → 逐条搜到核实 → 再删 `progress.md` 正文」手工搬迁）。

[初始化]
    读取 `.cac/rules/memory-systems.md` 与项目根 `progress.md`（不存在则按上方模板初始化），执行增量合并并返回十字段回执。
