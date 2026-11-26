---
name: design-maker
description: 当需要生成可交互 HTML 设计原型、用离线逻辑沙盘检验业务规则状态，或输出完整界面生成提示词时使用。零外部依赖，通过 ui-audit 与 ui-slop-scan 验收。
---

[任务]
    将需求与视觉规范落地为**零外部 CDN、单文件离线自包含、浏览器双击即开**的可交互 HTML 原型或提示词，一物两用（干系人直接点击体验评审 + 开发编码最高优先级参照）。
    原生支持三条零依赖主路径（无需预装任何外部设计守护进程）：
    1. **原生单文件 HTML 原型模式（默认主力）**：读取 `Product-Spec.md`、`Design-Brief.md`、`DESIGN.md` → 两遍法写 `demo/design-plan.md` 并排雷 AI 通病 →（方向未定时先出 3 份首屏方向样张 `demo/directions/direction-{1,2,3}.html` 三选一）→ 直接生成单文件自包含 `demo/index.html`（覆盖全部 `SCREEN-N` 与八态、真实业务样本、可重置模拟边界）。
    2. **离线逻辑沙盘模式**：仅需检验某条复杂业务规则、并发事件顺序或状态归属时（无需先出 `Design-Brief.md`/`DESIGN.md`），直接生成 `demo/logic-<问题名>.html` 供业务方自由触发事件与重置验证。
    3. **提示词模式**：当用户希望将完整规格粘贴到外部生成工具（如 v0、Lovable、AI Studio 等）时，输出结构化 `demo/design-prompt.md` + `demo/design-plan.md`。
    - *可选增强*：若用户显式点名使用本机已安装的 Open Design CLI（`odc`），可调用 `odc` 生成 HTML 后拷回 `demo/index.html`，同样必须通过下方全部本地验收闸门。

[依赖检测]
    启动时自动执行（先 `Read .cac/rules/dev-workflow-details.md`）：
    - **逻辑沙盘模式**：只需 `Product-Spec.md` 或会话中已确认的业务规则片段，不要求 `Design-Brief.md` / `DESIGN.md`。
    - **完整原型 / 提示词模式**：必需 `Product-Spec.md` 与 `Design-Brief.md`（缺失则提示先调用 `/product-spec-builder` 或 `/design-brief-builder`）；推荐具备 `DESIGN.md`（缺失则从 Brief 临时提炼 CSS 变量并标注「待补 `DESIGN.md`」）。

[文件结构]
    design-maker/
    ├── SKILL.md
    └── references/
        ├── logic-prototype.md          # 离线业务逻辑沙盘构造法（单问题状态机 + 异常 + 重置）
        ├── prototype-construction.md   # 关键屏 → CSS 变量 token → 语义组件 → 八态展开与无障碍核查
        └── task-walkthrough.md         # 带业务目标的任务试走与问题回填规程

[第一性原则]
    1. **100% 离线自包含（零外部 CDN 铁律）**：输出的 HTML 必须将全部 CSS 与 JS 内联，使用本地系统字体栈与内联 SVG——**严禁任何 Google Fonts、`unpkg`、`cdn.jsdelivr` 等外部资源请求**，断网环境下双击即可完整运行。
    2. **两遍法反模板化**：动笔写 HTML 前，先写 `demo/design-plan.md`（CSS 变量 token 映射、每屏 ASCII 线框、唯一大胆焦点、唯一编排动效），再对照 `../design-brief-builder/references/style-vocabulary.md` 五类 AI 通病逐项自审纠偏。
    3. **全 SCREEN 与八态可交互**：`Design-Brief.md` 中每个 `SCREEN-N` 均可切换浏览，且提供独立的「原型状态/演示控制台」可真实触发切换八态（空/加载/成功/错误/冲突/离线/无权限/AI 工作中）与「重置演示数据」，不把假静态卡片堆砌冒充交互原型。
    4. **原型模拟边界透明**：清楚区分「真实本地状态流转」与「模拟后端动作（不真实发请求/不扣款）」，并在提交未知态保留用户输入不静默吞没。
    5. **真实样本数据**：使用 `Product-Spec.md` 案例中的真实业务术语、长短混合标题与带单位数值，严禁 `Lorem ipsum`。

[三阶段工作流（完整原型模式）]
    1. **Phase 1 · 覆盖矩阵与两遍法计划**：
       - 对齐 `SCREEN-N` × 八态 × 关键业务流程，写出 `demo/design-plan.md` 并完成 AI 通病自审；
       - 若视觉方向尚未拍板，先产出首屏 3 个差异化方向样张（`demo/directions/direction-{1,2,3}.html`）或三段具象对比请用户选定。
    2. **Phase 2 · 原型构造（详见 `references/prototype-construction.md`）**：
       - 将 `DESIGN.md` token 集中声明为 `:root` CSS Custom Properties，严禁在规则里散写未声明的裸 hex；
       - 使用语义化原生标签（`<button>`、`<label>`、`<table>`、`<dialog>`）编写完整可交互单文件 `demo/index.html`（或提示词模式下写出 `demo/design-prompt.md`）。
    3. **Phase 3 · 双重机器闸 + 任务试走验收（严禁假绿！）**：
       - **完整性与零外链核查**：校验 `</html>` 闭合、`<style>`/`<script>` 配平、无外部 CDN 引用、全 SCREEN 与状态词命中；
       - **静态反套路闸**：运行 `node .cac/scripts/ui-slop-scan.mjs --paths demo`（修清全部 error 至 `rc 0`）；
       - **DOM 渲染审计闸**：运行 `node .cac/scripts/ui-audit.mjs demo --widths 1280,390 --out .cac/evidence/ui-audit --strict`：
         - 若返回 `rc 0`：确认横向溢出、小控件折行、对比度不足与空白渲染均为 0；
         - **若返回 `rc 3`（本机无 Playwright/Chrome 浏览器引擎）**：**严禁冒充通过！必须在交付报告中显式写明「UI 渲染审计缺席（rc 3，未执行 ≠ 通过）」**；
       - **带目的任务试走**（详见 `references/task-walkthrough.md`）：按真实用户目标走通正常与异常恢复路径，将发现的规则缺口回填 `Product-Spec.md` 或 `Design-Brief.md`。
       - 向用户交付产物路径、验收证据与未验证边界（本技能只落盘文件，不擅自执行 `git commit`），引导下一步进入 `/dev-planner`。

[初始化]
    执行 `[依赖检测]`，确认本次走「原生单文件 HTML 原型」「离线逻辑沙盘（先读 `references/logic-prototype.md`）」还是「提示词模式」。
