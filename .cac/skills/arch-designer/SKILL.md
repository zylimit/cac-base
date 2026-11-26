---
name: arch-designer
description: 当 Product-Spec.md 已签字、需要做软件架构设计，或用户提出架构设计、模块划分、分层边界、ADR 评审时使用。产出 Architecture-Design.md（L 档含 module-catalog.json）。
---

[任务]
    读取已确认的需求来源（默认 `Product-Spec.md`），通过**业务事件边界追演 + 七大设计原则自检 + 同场景候选评估**，输出只写稳定不变量的 `Architecture-Design.md`（模块边界 / 单向依赖规则 / 一致性约定 / 运行与部署包络 / ADR 关键决策 / 押后决定）。
    L 档中大型项目同步产出 `.cac/harness/module-catalog.json` 骨架，让模块依赖与分层禁边接入 `harness.mjs arch-check` 机器门禁。复杂规则密集模块按需建立 `docs/design/<模块名>-设计.md`（遵循 `.cac/rules/design-detail.md`）。

[依赖检测]
    启动时自动执行（先 `Read .cac/rules/dev-workflow-details.md`）：
    - 必需：权威需求来源（默认 `Product-Spec.md` 或用户指定的 PRD/Spec）；若完全缺失业务依据则引导先调 `/product-spec-builder`。
    - 可选：已有代码库（棕地演进模式，若装有大仓引擎先跑 `node .cac/harness/harness.mjs arch-check` 摸底）、`docs/readable/`、`DFX-Spec.md`、`Design-Brief.md`。

[文件结构]
    arch-designer/
    ├── SKILL.md
    ├── references/
    │   ├── collaboration-walkthrough.md      # 业务路径与异常断点追演法
    │   └── decision-evaluation.md            # 同场景候选对比、敏感假设与最小反证实验
    └── templates/
        ├── architecture-design-template.md   # Architecture-Design.md 模板（对齐 predev-lint 与 adr-check）
        └── design-detail-template.md         # docs/design/<模块名>-设计.md 模板（对齐 design-trace.mjs）

[规模判档（宁轻勿重）]
    - **S 档**（单模块 / ≤5 功能 / 单人短周期）：一页架构速写（范式 + 技术栈 + 目录骨架 + ≤3 条关键结论 + 包络与押后各一行），不硬拆多模块、不强造 catalog。
    - **M 档**（2–6 模块 / 明确职责隔离）：完整 `Architecture-Design.md`（含模块划分表、C4 图、一致性约定、重大 ADR、押后决定）。
    - **L 档**（≥7 模块 / 多人协作 / 大仓演进）：完整 `Architecture-Design.md` + **必产出 `.cac/harness/module-catalog.json` 骨架**（声明 `modules`、`dependsOn`、`forbiddenDependencies`、`layers`、`riskTier`）。

[第一性原则]
    1. **不变量测试**：只写「两个独立开发单元各自决定会做出不兼容选择」的跨单元契约与边界；纯模块内部细节归入「押后决定」保持文档精薄。
    2. **先追演业务事件，再划模块边界**：选代表性业务路径走通「谁触发 → 谁校验并修改哪个权威事实（single writer）→ 下游谁只读消费 → 断网超时/部分成功时谁保存了什么、怎么恢复」（细则见 `references/collaboration-walkthrough.md`）。默认**模块化单体优先**，无真实故障隔离或组织运维理由不拆微服务。
    3. **依赖严格单向无环**：高层与底层均依赖抽象（DIP），领域核心不直接耦合框架/驱动/UI；发现环路立即重划职责。
    4. **重大取舍才写 ADR，且必带执法与退出条件**：只有「撤回代价高 + 背景不写后人难懂 + 确有实质备选对比过」三者俱全才立 `### ADR-N`（细则见 `references/decision-evaluation.md`）。每条 ADR 必须包含 `**背景`、`**决策**`、`**被拒备选`、`**执法方式**`（指明 `arch-check` / `layers` / `forbiddenDependencies` / `fitness` 或 `人工评审`）、`**revisit-if**`（写客观触发条件，禁写「三个月后再看」）、`**reversal**`（撤回步骤与工期，不可逆标「单向门」交用户拍板）。
    5. **运行与部署包络不留白**：环境、部署拓扑、基础设施、运维四项逐一标明「决定 / 押后 / 未定」，严禁整段空白。
    6. **状态归属清晰**：涉及异步/并发编辑时，区分业务权威事实、临时草稿态、视图偏好与请求代次（防止迟到的旧请求响应静默覆盖用户新编辑）。

[七大设计原则推演与自检]
    模块划分成形后逐条自检：
    1. **开闭（OCP）**：只对已确认或已出现第二种实现的易变轴留策略/插件扩展点，不为假想需求过度抽象。
    2. **依赖倒置（DIP）**：分层只许外向内依赖，对应 `layers` 规则。
    3. **单一职责（SRP）**：每个模块有唯一变化原因，能用一句话说清对哪件业务事负责。
    4. **接口隔离（ISP）**：模块对外暴露按消费者裁剪的窄契约，不造大而全胖接口。
    5. **迪米特（LoD）**：禁止跨模块穿透内部私有目录，跨界禁边写入 `forbiddenDependencies`。
    6. **里氏替换（LSP）**：契约演进与多实现不得收窄输入、放宽输出或篡改错误语义。
    7. **合成复用（CARP）**：模块间优先组合委派，避免深层继承树。

[工作流程]
    1. **启动与判档**：执行 `[依赖检测]`，判 S/M/L 档并与用户确认推进方式（Coaching 逐步共创 vs Fast 起草后审阅）；对生疏框架/中间件先 `WebSearch` 核实当前版本与已知坑。
    2. **边界与决策推演**：先問两件事——「哪个环节挂 1 小时谁最疼」「团队几个人维护、熟悉什么栈」；追演核心业务路径划出模块表与 single writer，每轮聚焦 1–2 个核心选型（给 2–3 个具名候选 + trade-off），完成七原则自检与包络扫描。
    3. **生成与机器校验**：
       - 按 `templates/architecture-design-template.md` 输出根目录 `Architecture-Design.md`（L 档同步生成 `.cac/harness/module-catalog.json`）；
       - 必跑 `node .cac/scripts/predev-lint.mjs`（校验 5 个必需段、ADR 四要素、零占位符残留），修至 `rc 0`；
       - 若项目装有 `--with-harness` 大仓扩展包，加跑 `node .cac/harness/harness.mjs catalog-lint` 与 `adr-check`；
       - 将重大架构决策同步写入 `progress.md` Decisions（含依据、适用范围、取代关系）。
    4. **签字与下一步引导**：核对单向门清单交用户确认，引导下一步调用 `/dfx-designer`、`/design-brief-builder` 或 `/dev-planner`（复杂规则模块提示按 `templates/design-detail-template.md` 建 `docs/design/<模块名>-设计.md`）。

[初始化]
    执行 `[工作流程]` 第 1 步。
