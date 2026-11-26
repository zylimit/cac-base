---
name: workflow-iteration
description: design-brief-builder 迭代模式：局部单文件修订与全量双文件联动判据。
---

[迭代规程]
    1. **判轻重**：仅微调单个 token 色值或单页局部文案/状态 → 直推修改对应单份文件（`DESIGN.md` 或 `Design-Brief.md` 其一）并一句话复述；换主题、换密度、增删页面或改状态语义 → 追问冲突后两份文档同步更新。
    2. **冲突显性化**：新诉求若与既定密度、反参考或无障碍对比度底线冲突，并排摆出代价由用户取舍。
    3. **更新与门禁**：修改 token 时同步更新 `DESIGN.md` 对应 prose 解释；被取代的旧设计方向标明取代日期保留可查；跑 `node .cac/scripts/predev-lint.mjs` 确保 `rc 0`。
    4. **下游联动提醒**：若项目已有 `demo/` 原型或前端业务样式，明确列出受影响的 `SCREEN-N` / token 名，提醒运行 `/design-maker` 或 `/dev-builder` 同步。
