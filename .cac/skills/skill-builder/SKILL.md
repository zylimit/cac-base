---
name: skill-builder
description: 当用户要求创建新技能，或进化引擎（EVOLUTION.md）提议沉淀新 Skill 时使用。按 cac-base 原生规范生成 SKILL.md 并完成静态校验。
---

[任务]
    根据用户明确需求或 `.cac/EVOLUTION.md` 经确认的新技能提案，在 `.cac/skills/<skill-name>/` 下创建结构统一、Frontmatter 合规、跨平台零旧路径残留的原生 `cac-base` Skill。

[依赖检测]
    启动时自动执行：
    - 读取 `templates/skill-template.md` 骨架；
    - 若源于进化提案，读取 `.cac/EVOLUTION.md` 与对应 `.cac/feedback/*.md` 原始记录；
    - 按交互形态挑选 1–2 个现有 `.cac/skills/*/SKILL.md` 对照风格（采集访谈型看 `product-spec-builder`，自主分析型看 `dev-planner`/`code-review`，执行操作型看 `dev-builder`/`release-builder`，诊断修复型看 `bug-fixer`）。

[文件结构]
    skill-builder/
    ├── SKILL.md
    └── templates/
        └── skill-template.md      # cac-base 原生 Skill 骨架模板

[原生合规红线（CSO 与宿主契约）]
    1. **Frontmatter 精简合规**：
       - 必填 `name`（kebab-case，与目录名一致）与 `description`；
       - `description` 遵守 **CSO 规范**：以「当……时使用」触发场景开头，清晰精炼 **≤180 字符**；
       - 按需使用 `codeagent` 原生支持的字段：`argument-hint`、`disable-model-invocation: true`（高危发布/合并专用）、`user-invocable: false`（仅内部子代理调用）；**严禁使用异构宿主专属的 `context: fork`**。
    2. **路径与跨平台纯净**：一律使用 `.cac/`、`AGENTS.md`、`node .cac/scripts/*.mjs`、`node .cac/harness/harness.mjs`，严禁出现异构目录名或 `.sh` 旧脚本硬绑定。
    3. **参考资料按条件加载**：若附带 `references/` 或 `templates/`，必须在主 `SKILL.md` 中写明每份附属文件的精确读取时机，核心公共底线留在 `SKILL.md` 入口，分支细则下沉 `references/`。
    4. **最小必要不重复宪法**：`AGENTS.md` 已有的全局十条铁律不整段照抄，只写本技能特有的领域判据与可执行步骤。

[工作流程]
    1. **明确边界**：确认解决什么问题、触发时机（自动 vs 手动斜杠）、前置输入、输出产物与验收方式；生疏领域先 `WebSearch` 查证行业最佳实践。
    2. **填充骨架**：基于 `templates/skill-template.md` 编写 `.cac/skills/<skill-name>/SKILL.md`（及必要的 `templates/`、`references/`）。
    3. **静态校验与注册**：
       - 检查 `description` 字数 ≤180、必需段落齐全、引用路径全部真实存在；
       - 若项目装有治理引擎（`node .cac/harness/harness.mjs validate`）或 `node .cac/scripts/doctor.mjs`，实跑确认 0 违规；
       - 提醒或经用户确认后在 `AGENTS.md` `[Skill 路由表]` 补充一行路由入口。

[初始化]
    执行 `[依赖检测]`，进入 `[工作流程]` 第 1 步。
