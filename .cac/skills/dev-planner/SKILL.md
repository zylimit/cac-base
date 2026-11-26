---
name: dev-planner
description: 当需求已签字确认、需要拆解分阶段开发计划，或需求变更后需同步更新排期时使用。产出零占位符的 DEV-PLAN.md 并通过 plan-lint.mjs 双向核验。
---

[任务]
    读取已签字确认的需求来源（默认 `Product-Spec.md`）与可选上游文档（`Architecture-Design.md`、`DFX-Spec.md`、`Design-Brief.md`、`DESIGN.md`、`demo/`），构建功能依赖 DAG，按**「核心价值 × 关键未知先行」**拆解 Phase 与可直接派单的 Task，输出 `DEV-PLAN.md`，并通过 `node .cac/scripts/plan-lint.mjs` 静态门校验（退出码 `0` 方可进入 `/dev-builder`）。
    - *轻量豁免*：能用一句话说清 diff 的单文件微小改动无需写 `DEV-PLAN.md`，直接走 `/dev-builder`；完整结果只需 1 个 Task 时，用 1 个 `## Phase 1: ...` 承载该 Task 即可，严禁为凑数硬拆多个空洞 Phase。

[依赖检测]
    启动时自动执行（先 `Read .cac/rules/dev-workflow-details.md`）：
    - 必需：已确认并通过案例复述签字的 `Product-Spec.md`（或用户指定的实际需求文档）；若尚未签字确认，提示先完成 `/product-spec-builder` 复述签字门。
    - 可选：`Architecture-Design.md`（按模块边界与依赖方向排 Phase）、`DFX-Spec.md`（将 critical/high 验证落点折入对应 Phase 验收，不拖到最末）、`Design-Brief.md` / `DESIGN.md` / `demo/`（按 `SCREEN-N` 拆前端任务）、`docs/readable-src/config.json`（开发规则附人读文档同步要求）。

[文件结构]
    dev-planner/
    ├── SKILL.md
    ├── references/
    │   └── acceptance-and-dependencies.md   # 验收证据反推、功能前置 vs 验证前置、多消费者兼容迁移排法
    └── templates/
        └── dev-plan-template.md             # DEV-PLAN.md 标准模板（100% 对齐 plan-lint.mjs 锚点）

[第一性原则]
    1. **每个 Phase 可编译、可运行、可见业务结果**：严禁排一个「纯搭架子什么都跑不起来」的空转基础设施 Phase；最小骨架只做到跑通第一条核心价值链路为止。
    2. **价值与高风险未知优先**：去掉它产品就不成立的主链路排最前；Spec 中的 `[推断]`、`[默认]`、首次使用的技术或外部接口集成作为 `**验证的假设**` 排在纯功能堆叠之前趁早实证。
    3. **绝对零占位符（`plan-lint.mjs` 硬拦）**：正文中严禁出现 `TBD`、`TODO`、`待补充`、`待确定`、`类似 Task`、`类似 Phase`、`按需调整`、`做相应修改`、`implement later`。
    4. **按 fresh 子代理标准写满 Task 要素**：假设接单的 `implementer` 对历史对话零记忆——每条 `- **Task N.M：...**` 必须写清**精确文件路径 + 具体函数/字段改动 + 可执行验证命令**，并附齐 `Business Context`、`依赖类型`、`证据产生者`（对应 LOW/MEDIUM/HIGH 三档）三个子项，方便主 Agent 直接抄入七字段派单包。
    5. **REQ 双向闭环与归档兼容**：
       - Spec 中声明的所有 `[REQ-模块-编号]` 必须被某个 `- **Task N.M：...**` 引用；本期确不计划的 REQ 必须在 `## 范围外（本次不计划）` 小节逐条写明 `- REQ-XXX-001：原因与回归条件`（空原因或与 Task 重复均会被 `plan-lint.mjs` 拦截）；
       - 历史已完成 Phase 超 20 个或超 64KB 时，由 `node .cac/scripts/plan-archive.mjs` 自动搬入 `DEV-PLAN.archive.md` 并在 `## 已归档 Phase` 留下 `→ DEV-PLAN.archive.md（REQ：…）` 指针，`plan-lint.mjs` 原生识别该后缀，绝不手工乱删已完成 Phase。

[工作流程]
    1. **生成模式**：
       - 读取 Spec 与「待定问题」表（阻塞本期的先请用户拍板，非阻塞的在 `## 开工前置` 注明采用的默认做法）；新引入技术栈时先 `WebSearch` 核实版本兼容性；
       - 建依赖 DAG + 价值与未知排序（细则见 `references/acceptance-and-dependencies.md`），校准每 Phase 粒度（通常 2–4 个内聚交付项、3–8 个关键文件）；
       - 按 `templates/dev-plan-template.md` 写出根目录 `DEV-PLAN.md`；
       - **必跑机器闸**：执行 `node .cac/scripts/plan-lint.mjs DEV-PLAN.md Product-Spec.md`（若需求文件为其他路径则显式传该路径），修复所有报错至退出码 `0` 后交付，引导调用 `/dev-builder`。
    2. **迭代模式**：
       - 对照更新后的 `Product-Spec.md` 与 `Product-Spec-CHANGELOG.md` 定位受影响的 Phase；
       - 已完成（标 `✅`）的 Phase 保留历史结论不涂改，因需求变更产生的新增/修正工作必须新建独立 Task 或新 Phase 承接；
       - 若已完成 Phase 过多，运行 `node .cac/scripts/plan-archive.mjs` 机械归档后再跑 `node .cac/scripts/plan-lint.mjs` 确认退出码 `0`。

[初始化]
    执行 `[依赖检测]`，按是否存在 `DEV-PLAN.md` 进入生成模式或迭代模式。
