---
name: changelog-template
description: Product-Spec-CHANGELOG.md 变更记录模板。每次迭代更新 Product-Spec.md 时成对维护。
---

# 需求变更记录模板

文件名：`Product-Spec-CHANGELOG.md`（与 `Product-Spec.md` 成对同步，`three-file-sync-gate` 守护）。
`Product-Spec.md` 正文永远只保留现行做法，不留删除线与历史尾巴；所有被替换的旧文原句与促成变更的用户原话完整保存在本文件中。

```markdown
# Product-Spec 变更记录

## [v1.1] - YYYY-MM-DD
- **为什么改**：[触发原因——用户新认识 / 修正 AI 原误解 / 下游审查或测试撞出反例 / 外部合规约束]
- **原判断哪里错**：[原 Spec 条目与当时依据、错在何处；纯新增填「新增需求，无旧判断」]
- **影响范围**：[受影响的 Spec 条目、Design-Brief SCREEN、架构模块、DEV-PLAN Phase/Task]
- **分类与阶段回退**：[澄清 | 加范围 | 减范围 | 行为变化 | 数据权限变化 | 验收变化 | 纠正] → [不回退 | 回 design-brief-builder | 回 arch-designer | 回 dev-planner]

### 新增
- [REQ-XXX-NNN] [新增内容摘要]（`[确认]` / `[推断]`）

### 修改
- [条目编号或标题]：[现行新写法]
  - **旧文原样**：[被替换掉的原句，一字不改贴入]
  - **用户原话**：[促成改动的原话摘录与日期]

### 删除
- [作废条目编号与标题]：[删除原因；编号永久封存不复用]

---

## [v1.0] - YYYY-MM-DD
- 首版 `Product-Spec.md` 签字基线建立。
```
