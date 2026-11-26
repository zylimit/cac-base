---
name: workflow-0-1
description: design-brief-builder 0-1 模式标准流程与交付自检。
---

[0-1 推进七步]
    1. **读取上游**：从 `Product-Spec.md` 吸收受众、使用情境、首要动作、关键流程与失败路径，绝不重问已答项；`WebSearch` 同赛道标杆产品作为锚点备选。
    2. **先定形态与情境（Phase 1）**：确认 GUI / 终端 / Agent 形态与各端首要动作。
    3. **收敛气质、参照与反参考（Phase 2–3）**：锁定 ≤5 个情绪词、1 个具体参照物与反参考禁区，排除 `style-vocabulary.md` 中的 AI 默认套路。
    4. **拍板视觉轴与核心状态（Phase 4–5）**：逐轴二选一（或按用户委托专业拍板），补齐核心呈现与八态 / Agent 审批面。
    5. **落定信息架构与组件（Phase 6）**：完成 `SCREEN-N` / `CMP-N` 编号与 Surface Closure 核对，向用户一句话复述视觉契约确认。
    6. **双文档生成与机器门禁**：按模板写出 `Design-Brief.md` 与 `DESIGN.md`（零外部 CDN 字体，全部 `{token}` 可解析），运行 `node .cac/scripts/predev-lint.mjs` 直至 `rc 0`。
    7. **交接引导**：同步关键决策至 `progress.md` Decisions，引导进入 `/design-maker` 或 `/dev-planner`。
