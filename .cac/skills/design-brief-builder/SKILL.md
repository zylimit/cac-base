---
name: design-brief-builder
description: 当用户需要确定界面交互体验、设计风格或提出“高级感/简洁/现代”等模糊视觉诉求时使用。支持 Web/桌面/终端/Agent 四轨形态，产出 Design-Brief.md 与 DESIGN.md。
---

[任务]
    从真实使用情境与首屏首要动作出发，把用户的直觉感受翻译成可执行的界面规格，产出两份互补文档：
    - **`Design-Brief.md`**（管怎么运作：产品形态、信息架构、`SCREEN-N` 页面八态、`CMP-N` 组件、交互原语、UX 文案、无障碍与响应式；终端/Agent 形态走 `§A`）。
    - **`DESIGN.md`**（管怎么看：YAML 前言具名设计 token + 八段标准 prose 视觉规范 + `Do's and Don'ts` 反面护栏）。
    支持 **0-1 模式**与**增量迭代模式**（局部改动只更新受影响的那一份文档，不强制两份重写）。

[依赖检测]
    启动时自动执行（先 `Read .cac/rules/dev-workflow-details.md` 及 `../product-spec-builder/references/interview-principles.md`）：
    - 优先读取 `Product-Spec.md`（提取受众、使用情境、首要动作、关键流程）；若缺失但会话已有明确任务片段也可局部推进，完全无业务依据时提示先调用 `/product-spec-builder`。
    - 先辨认表面形态：**GUI 界面型 / 终端 CLI 型 / 对话式 Agent 型 / 宿主嵌入扩展型**（可组合），严禁看到产品就默认套传统网页侧边栏。

[文件结构]
    design-brief-builder/
    ├── SKILL.md
    ├── references/
    │   ├── question-bank.md        # 六阶段分轨反含糊题库（GUI 与 终端/Agent 双轨）
    │   ├── workflow-0-1.md         # 0-1 推进流程与完成度判据
    │   ├── workflow-iteration.md   # 迭代冲突检测与单双文件同步规则
    │   ├── style-vocabulary.md     # 风格词汇、锚点对比对与五类 AI 界面通病清单
    │   ├── ui-quality-floor.md     # 界面质量地板（MUST / SHOULD / NEVER）
    │   ├── agent-ux-patterns.md    # AI/Agent 交互词汇、人在回路审批面与专属视觉纪律
    │   └── visual-methods.md       # 表面辨认、真实内容骨架与构成选择法
    └── templates/
        ├── design-brief-template.md
        └── design-md-template.md

[第一性原则]
    1. **形态与任务先于颜色**：密度、字号、命中区与对比度由使用环境（站坐、单双手、打断频率、光线、屏宽）与首屏唯一首要动作推导，一上来聊配色的先拉回情境。
    2. **一个具体参照物胜过十个形容词**：「瑞士手表纸质说明书」或「Bloomberg 密集行情屏」天然自带整套正向规则与否定护栏；用选择题（2–3 个对立真实锚点 + 推荐）引导，禁中间值骑墙。
    3. **捕捉不代笔，委托即担当**：用户有想法时翻译成具体属性并读回确认；用户明确委托（「视觉你定」）时直接给出有理有据的专业方案，说明适用范围与可调项，不强塞偏好问卷。
    4. **主动排雷五类 AI 界面通病**（详见 `references/style-vocabulary.md`）：默认排除紫靛主色、`#F4F1EA` 奶油底配 `#D97757` 陶土橙、满屏同圆角灰影 SaaS 卡片套、ALL-CAPS 小眉标、中点串 `A · B · C`、按钮尾巴 `→`。**把大胆花在一处，其余保持安静**。
    5. **方向进 Brief，数值进 DESIGN.md Token**：`Design-Brief.md` 用 `{colors.primary}` 引用 token，不散写裸 hex；每个 `### SCREEN-N` 必写齐 `**必需状态**`（空/加载/成功/错误/冲突/离线/无权限 + AI 工作中）与 `**响应式**`。

[感受词翻译速查]
    | 用户模糊词 | 追问与翻译出的可执行属性 |
    |---|---|
    | **简洁 / 干净** | 追问是字段更少、留白更大还是配色更克制 → 落为单主动作 + 克制色板（≤5 色）+ 明确字重层级 |
    | **高级感** | 追问是 Apple 式大留白克制，还是精密仪器式锐利高对比 → 落为负空间节奏 + 细发丝线替代厚阴影 |
    | **专业 / 工程感** | `tabular-nums` 等宽数字对齐 + 紧凑行高 + 方角或小圆角（≤6px）+ 零装饰动画 |
    | **透明可信（AI/Agent）** | 动作前预览 diff + 不可逆审批门 + 随时可中断 + AI 活动独占唯一识别色（人接手即退回常规色） |

[生成与机器校验]
    1. 按 `templates/design-brief-template.md` 输出 `Design-Brief.md`（核对 Surface Closure：每条 P0 需求均有 `SCREEN-N` 或 `§A` 单元承接）。
    2. 按 `templates/design-md-template.md` 输出 `DESIGN.md`（YAML 前言必含 `colors.primary` 与 `colors.surface`，八段标题严格按序：`Overview → Colors → Typography → Layout → Elevation & Depth → Shapes → Components → Do's and Don'ts`，正文所有 `{token.path}` 在前言均可解析）。
    3. **必跑静态闸**：执行 `node .cac/scripts/predev-lint.mjs`，修复全部 error 至 `rc 0` 后交付。
    4. 将形态、密度、主题与核心参照决策同步记入 `progress.md` Decisions，引导下一步调用 `/design-maker` 生成可交互离线 HTML 原型或 `/dev-planner` 排期。

[初始化]
    执行 `[依赖检测]`，按是否存在 `Design-Brief.md` 进入 `references/workflow-0-1.md` 或 `references/workflow-iteration.md`。
