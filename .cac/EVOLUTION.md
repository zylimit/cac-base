# EVOLUTION — 反馈聚类与规则进化台账

> 本文件记录 `.cac/feedback/` 行为修正经 `evolution-engine` 扫描、查重与用户确认后的晋升、合并、暂缓或拒绝裁定。  
> 核心原则：**没有实证代价不轻易加规则，没有台账记录不静默改宪法**，防止规则库无序膨胀。

## 1. 运作与晋升协议

1. **立即生效层（`.cac/feedback/`）**：用户当场纠正后立即修改当前产物，并由 `feedback-observer` 去重登记至 `.cac/feedback/` 及 `FEEDBACK-INDEX.md`，无需等待多次重复即对当前项目生效。
2. **聚类扫描层（`evolution-runner` + `evolution-engine`）**：
   - 先对 `AGENTS.md`、`.cac/rules/*.md`、`.cac/skills/*/SKILL.md`、`.cac/agents/*.md` 做 Grep 现状核查（已成文的按既成事实核销毕业，不重复堆砌）；
   - 按同一失败模式同族归并，核查真实返工/事故代价后生成提案（规则毕业 / Skill 段落优化 / 新 Skill 候选 / 暂不成文）；
   - 下游业务项目中的通用 AI 方法教训标「待回流 `cac-base`」，由框架源仓通过 `node .cac/scripts/collect-feedback.mjs` 汇总升级，避免直接涂改受清单管理的框架文件产生升级冲突。
3. **用户拍板落账**：所有规则晋升或跳过决定均须用户确认，落定后同步更新目标文件、`FEEDBACK-INDEX.md` 状态前缀与下方进化记录表。

## 2. 记录条目格式

```markdown
### E-YYYYMMDD-NN <进化主题>
- **日期**：YYYY-MM-DD
- **来源**：`.cac/feedback/<file>.md`（`source_skill` / `origin`）
- **裁定**：晋升规则 | 优化技能 | 新建技能 | 既成事实核销 | 暂不成文 | 拒绝
- **落点**：目标文件路径与段落（未改文件填 `无`）
- **依据**：一句话可证伪的事故代价或裁定理由
```

## 3. 进化记录

| 编号 | 日期 | 来源条目 | 裁定 | 落点 | 一句话依据 |
|---|---|---|---|---|---|
