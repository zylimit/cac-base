---
name: evolution-engine
description: 当会话触发进化催办或用户要求扫描规则毕业与技能优化建议时使用。由 evolution-runner 只读聚类 .cac/feedback/ 并生成提案。
---

[任务]
    扫描 `.cac/feedback/` 中尚未毕业的行为修正记录，通过**现有框架文本 Grep 查重 + 同族失败模式聚类 + 真实事故代价门槛**，识别三类进化提案（规则毕业 / Skill 段落优化 / 新 Skill 候选），经用户逐条拍板后落地并记入 `.cac/EVOLUTION.md` 台账。

[运行位置分流（防下游升级冲突！）]
    - **在框架源仓（`cac-base`）运行**：若需汇总下游项目经验，先由主 Agent 运行 `node .cac/scripts/collect-feedback.mjs <下游项目路径...>` 收集条目（带 `origin` 来源），毕业提案直接落入本仓 `.cac/rules/AGENTS.md`、`.cac/rules/*.md` 或 `.cac/skills/*/SKILL.md`。
    - **在下游业务项目运行**：下游项目的 `.cac/{rules,skills,agents}` 受 `FRAMEWORK-MANIFEST.json` 校验管理，直接涂改会在下次升级时产生冲突——因此通用 AI 方法类教训只标「待回流 `cac-base`」保留在 `.cac/feedback/`，仅项目私有约束落入 `progress.md` Pinned/Decisions 或 `domain/`。

[四步只读扫描规程（由 `evolution-runner` 执行）]
    1. **筛选待裁定候选**：读取 `.cac/feedback/FEEDBACK-INDEX.md` 与各条目 frontmatter，筛选 `graduated: false` 且 `skipped != true` 的条目。
    2. **现状查重（Grep 实证，严禁凭印象）**：对每条候选在 `.cac/rules/AGENTS.md`、`.cac/rules/*.md`、`.cac/skills/*/SKILL.md`、`.cac/agents/*.md` 中检索核心规则是否已成文：
       - 已完整成文 → 列为「既成事实核销」（附精确 `file:line`，直接标毕业不重复加字）；
       - 部分成文 → 指明已覆盖处与缺失切口；
       - 完全未成文 → 进入下一步实证门槛评估。
    3. **同族聚类与实证代价门槛**：
       - 将同一本质失败模式的不同表述归并同族计算（单条 `occurrences >= 3`、同族合计 `>= 3` 条，或单次已造成明确返工/空转/阻塞真事故的条目进入提案；仅有口头微调而无实际事故代价的标「暂不成文」避免规则膨胀）；
       - 同一 `source_skill` 下 3 条以上未毕业条目指向同一薄弱环节 → 列为「Skill 优化提案」；
       - 跨 3 条以上反复出现且无现有 Skill 覆盖的操作流 → 列为「新 Skill 候选」（确认后交 `/skill-builder` 创建）。
    4. **结构化提案输出**：若无达标项直报「无进化建议」；若有达标项，按「规则毕业 / Skill 优化 / 新 Skill 提议 / 既成事实核销」分组列出目标文件、拟改摘要与一句可证伪理由交主 Agent 呈请用户逐条确认。

[用户拍板后的落账闭环（主 Agent 执行）]
    用户逐条确认「采纳 / 跳过」后，主 Agent 执行：
    1. 采纳项修改目标规则或 Skill 文件，将对应 `.cac/feedback/*.md` 的 `graduated` 置为 `true`；跳过项将 `skipped` 置为 `true`。
    2. 同步更新 `.cac/feedback/FEEDBACK-INDEX.md` 行首状态前缀：`✅[已毕业] `、`⏭[已跳过] ` 或 `⏸[暂不成文] `。
    3. 在 `.cac/EVOLUTION.md` 进化记录表追加一行（编号 `E-YYYYMMDD-NN`、来源、裁定、落点与依据）——**没有台账记录绝不静默改规则**。

[初始化]
    检查当前是在主 Agent 编排入口（派发 `evolution-runner` 只读扫描）还是已在 `evolution-runner` 内部（直接执行 `[四步只读扫描规程]`）。
