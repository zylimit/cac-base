---
name: dev-builder
description: 当 DEV-PLAN.md 就绪、用户要求开始编码或推进下一个 Phase/Task 时使用。按 Task 三档派发编码闭环并执行 Phase 四步走验收。
---

[任务]
    驱动项目进入受控编码与验收闭环：
    - **初始化模式**：无业务源码 + 有 `DEV-PLAN.md` → 搭建工程骨架、安装技术栈依赖、初始化人读文档基线（如适用），推进 `Phase 1`。
    - **持续开发模式**：有源码 + 有 `DEV-PLAN.md` → 逐个 Task 按 `LOW / MEDIUM / HIGH` 三档派发 fresh 子代理完成「实现 → 审查 → 独立测试 → 提交」闭环，并在每个 Phase 收尾执行**四步走**客观验收。

[依赖检测]
    启动时自动执行（必先 `Read .cac/rules/dev-workflow-details.md` 与 `.cac/rules/subagent-dispatch.md`）：
    - 必需：`Product-Spec.md`、`DEV-PLAN.md`（先跑 `node .cac/scripts/plan-lint.mjs` 确认退出码 `0`）；缺失则分别引导 `/product-spec-builder` 或 `/dev-planner`。
    - 可选参照（优先级从高到低）：`demo/` 设计稿 → `DESIGN.md` → `Design-Brief.md` → `Product-Spec.md`；以及 `Architecture-Design.md`、`DFX-Spec.md`、`domain/`、`docs/design/*.md`。
    - 人读文档起头检查：除非 `progress.md` Pinned 明确记录不出人读文档，否则无 `docs/readable-src/config.json` 时先跑 `node .cac/scripts/readable-docs.mjs init` + `build`；已有配置时跑 `init --suggest` 补齐新出现的建表或代码目录。

[第一性原则]
    1. **主 Agent 绝不亲手写业务源码（铁律 1）**：编码一律按七字段契约派发 fresh `implementer` 实例；`no-direct-code-guard` 实时守护，严禁在 `Bash` 中重定向绕闸。
    2. **Task 机械定档、串行收口**：
       - **LOW**（预计/实际 diff <50 行，不碰契约/解析器/鉴权/数据迁移/支付/hooks，不引新依赖）：派 `implementer` → 自检 + `node .cac/hooks/static-check.mjs .` + 跑现有测试 → 主 Agent 亲验 diff 与输出 → 原子提交。
       - **MEDIUM**（50–300 行，或碰上述任一敏感路径，或引新依赖）：`implementer` → `code-reviewer`（Stage 0 + Stage 1 规格符合性）→ 仅 `HIGH` 阻断，修完同轮复核一次收口 → 标记 `.cac/.needs-review` 为 `clean` → 原子提交。
       - **HIGH**（>300 行，或碰两类以上敏感路径，或线上缺陷/迁移/安全）：`implementer` → `code-reviewer` 全三 Stage → `HIGH` 修复复核 → 派**不同于作者的独立 `tester`** 补回归测试 → 标记 `.cac/.needs-review` 为 `clean` → 原子提交。
       *(注：`fast` 档下按 `tier.mjs` 策略走快速开发链，但地板安全闸永不降级，发版前必须切回 `standard`/`strict` 清偿审查与测试。)*
    3. **改动前查引用，失败必须可见**：删改公共常量/接口/字段前先全仓 `Grep` 引用点一次性同步；涉及持久化结构变更必须配套存量数据兼容或迁移；业务代码禁空 `catch` 静默吞错。
    4. **跨平台与测试数据隔离**：Windows PowerShell 与 Linux 双端兼容（子进程 `windowsHide: true`）；启动真实服务或数据库的脚本必须使用系统临时目录下的独立隔离目录，严禁污染用户真实库。
    5. **人读文档与设计详述随 Task 同步**：
       - 触及表结构、读写表代码或模块文件/接口/依赖时，派单前记下 `readable-docs.mjs check` / `pending` / `structure` 基线，`implementer` 随单 `build` + `note put` 补说明，主 Agent 亲验 `check` 报「不一致 0 条」且结构指标未恶化；
       - 触及 `docs/design/*.md` 代码范围时，同步维护设计详述规则与常量表。
    6. **新建文件验收禁只看 `git diff`**：未暂存新文件在 `git diff` 下为空，主 Agent 验收必须跑 `git status --short` + 行数与内容核查。

[Phase 完成四步走（缺一不可，中途改码则四步重跑）]
    当前 Phase 全部 Task 完成后，主 Agent 依次执行并采集当场真实输出：
    1. **全 Phase Code Review**：派 `code-reviewer` 对照该 Phase 交付清单与边界核查有无遗漏或越界改动。
    2. **测试完整性卡点**：派独立 `tester` 验证跨 Task 契约、错误态/空态与边界覆盖；若存在 `docs/design/*.md` 跑 `node .cac/scripts/design-trace.mjs`；若存在 `docs/readable-src/config.json` 跑 `node .cac/scripts/readable-docs.mjs check`（确保 0 条不一致）并比对 Phase 前后 `structure` 变化。
    3. **全量编译与静态检查**：运行 `node .cac/hooks/static-check.mjs .` 及项目类型检查/语法校验，确认 0 错误。
    4. **真实功能冒烟**：拉起服务（常驻服务可用 `node .cac/scripts/supervisor.mjs` 托管）跑通核心接口或真实浏览器交互路径；本机确无浏览器引擎时如实注明「浏览器交互冒烟缺席」，绝不假装点过。
    - **四态写回 `DEV-PLAN.md`**：将结论（`PASS` / `CONCERNS` / `FAIL` / `WAIVED`，安全与数据丢失类严禁 `WAIVED`）写回 Phase 标题行，如 `## Phase 2: 派单核心 ✅（2026-11-26，PASS）`，并派 `progress-recorder` 更新断点与完成记录。

[需求存疑与领域线索回流]
    - 子代理回执出现 `Counter-examples` 或「❓ 需求存疑」时，暂停该争议点回流 `/product-spec-builder` 迭代模式更新 Spec + CHANGELOG；
    - 回执带客观实测依据的 `Domain findings` 时，按 `/domain-rulings` 四象限分诊决定是否派 `domain-recorder` 入库。

[初始化]
    执行 `[依赖检测]`，运行 `node .cac/scripts/project-status.mjs` 定位当前应执行的 Phase 与 Task。
