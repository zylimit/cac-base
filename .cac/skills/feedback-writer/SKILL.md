---
name: feedback-writer
description: 当用户纠正 AI 工作方法、沟通方式或流程疏漏时，由 feedback-observer 子代理内部调用，去重写入 .cac/feedback/ 并更新索引。
user-invocable: false
---

[任务]
    供 `feedback-observer` 子代理内部调用：分析主 Agent 显式传入的用户纠正上下文，识别针对 **AI 工作方式、验证纪律、流程缺口** 的有效信号，去重写入 `.cac/feedback/*.md` 并同步登记 `.cac/feedback/FEEDBACK-INDEX.md`。

[五类触发信号（无真实信号绝不硬凑）]
    1. **用户当场纠正 AI 行为**（「不是这样」「别跳过这一步」「不要替我改这个」）。
    2. **Skill 未覆盖场景**：执行某 Skill 时撞见指引空白导致 AI 临场乱猜。
    3. **高频重复手工指令**：用户连续 3 次以上用自然语言重复要求同一套未被固化的流程动作。
    4. **跨阶段同类质量复发**：连续多个 Task 复现同一类低级疏漏（如漏 `windowsHide`、漏跑静态闸）。
    5. **Skill 阶段效能复盘**：仅在整个 Skill 完整结束且有明确得失证据时记录四维评分（精准度/覆盖度/效率/满意度，有修正则对应项 ≤3 分）。
    - *边界过滤*（详见 `.cac/rules/memory-systems.md`）：纯项目业务取舍归 `progress.md` Decisions，产品需求变更归 `Product-Spec.md`，跨仓库领域计算公式归 `domain/`，一律不进 `.cac/feedback/`。

[去重写入与索引同步流程]
    1. 读取 `.cac/feedback/FEEDBACK-INDEX.md`（若不存在则按 `.cac/feedback/templates/feedback-index-template.md` 创建）。
    2. **查重合并优先**：
       - 已有同主题条目 → 在原文件递增 `occurrences`、更新 `updated` 日期，并在正文追加本次新触发场景与「本次落地」证据；
       - 修正或推翻旧条目 → 新建条目并在 frontmatter `supersedes` 写旧文件名，同时在旧条目注明被新文件取代；
       - 全新主题 → 按 `.cac/feedback/templates/feedback-entry-template.md` 创建 kebab-case `.md` 文件（必填 `type`、`description`、`created`、`updated`、`occurrences`、`graduated: false`、`scope`、`exceptions`、`supersedes`、`applied_to`）。
    3. 若主 Agent 未传入「已落地的改变」，`applied_to` 填 `pending` 并在回执中醒目提示主 Agent 尚未将纠正落地到当前产物。
    4. 在 `.cac/feedback/FEEDBACK-INDEX.md` 同步新增或更新对应索引行（`harness validate` 机器强校漏登）。

[回执要求]
    按十字段信封返回，在 `Evidence` 中给出清晰的一行落账摘要与建议修改的 `rule / skill` 段落落点（或「当前产物已够，无需动框架本体」），供主 Agent 向用户回显「这次纠正改了……」。

[初始化]
    读取 `.cac/rules/memory-systems.md` 与 `.cac/feedback/FEEDBACK-INDEX.md`，判定信号并执行去重写入。
