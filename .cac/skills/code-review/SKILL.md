---
name: code-review
description: 当 MEDIUM/HIGH Task 完成、Phase 收尾或用户要求审查代码质量与规格符合性时使用。由只读 code-reviewer 按三阶段缺陷优先策略执行。
argument-hint: "[审查范围（可选，默认本轮改动）]"
---

[任务]
    对照 `Product-Spec.md`、派单包 `Business Context`、`docs/design/*.md` 与视觉规范，采用对抗证伪立场执行**三阶段分级代码审查**，输出带精确 `file:line` 与复现依据的结构化报告。
    - 本技能由 `code-reviewer` 子代理执行（**只审不改业务代码铁律**），修复路由与放行裁定归主 Agent。

[依赖检测]
    启动时自动执行：
    - 必需：被审代码范围与 `Product-Spec.md`（子代理执行时须具备派单包 `Business Context`，缺失则回 `NEEDS_CONTEXT`）。
    - 战术记忆：若存在 `.cac/agent-memory/code-reviewer/MEMORY.md`，先 `Read` 提取本项目历史高发缺陷模式纳入重点核查。
    - 可选：`DEV-PLAN.md`、`docs/design/*.md`、`Design-Brief.md`、`DESIGN.md`、`docs/readable-src/config.json`、`.cac/evidence/ui-audit/ui-audit.json`。

[三阶段分级审查清单]
    按派单 `Goal` 首行的 Task 档位决定深度：`MEDIUM` 跑 **Stage 0 + Stage 1**；`HIGH`（或未标档位 / Phase 收尾）跑 **Stage 0 + Stage 1 + Stage 2**。
    - **早停止损规则**：Stage 0 未过则停在 Stage 0；Stage 1 发现 `HIGH` 阻断级问题则立即停在 Stage 1 出报告（标注 `Stage 2 未执行`），不空耗轮次。

    1. **Stage 0 · 静态闸先行**：
       - 运行 `node .cac/hooks/static-check.mjs .`（及项目自带类型/语法检查）；机器能抓出的语法与类型错误直接打回，零错误才进 Stage 1。
    2. **Stage 1 · 规格符合性与业务边界（做对了没有）**：
       - **逐条核对 Spec 与交付清单**：每条输出四态之一——`✅ 完整实现（附 file:line 与验证证据）` / `⚠️ 部分实现（缺口说明）` / `❌ 未实现` / `❓ 需求存疑`；
       - **业务含义与反例对抗**：构造边界/例外场景核对 `Business Context`——若代码符合 Spec 字面但在真实例外下会产出错误业务结果，单列 `Counter-examples` 报「❓ 需求存疑」（四段式：情境 → 按 Spec 会怎样 → 业务上应怎样 → 依据）；
       - **设计详述一致性**：触及 `docs/design/*.md` 代码范围时，核对判据、执行顺序、常量值与取代记录（辅以 `node .cac/scripts/design-trace.mjs`）；
       - **人读文档核对**：存在 `docs/readable-src/config.json` 时，运行 `node .cac/scripts/readable-docs.mjs check` 与 `structure`，检查是否 0 条不一致、新增说明是否准确非套话、结构指标是否较基线恶化；
       - **UI 一致性与质量地板**（涉界面时）：按 `设计稿 → DESIGN.md → Design-Brief.md → Product-Spec.md` 优先级核查 token 使用、八态完备性与 `../design-brief-builder/references/ui-quality-floor.md` MUST 项。
    3. **Stage 2 · 代码质量、安全与测试真伪（做好了没有）**：
       - **安全与跨平台红线**：扫描命令注入、SQL 拼接、`innerHTML`/XSS、硬编码密钥/绝对路径、前端公开环境变量泄密、Windows 路径反斜杠/CRLF 漏处理、子进程漏 `windowsHide: true`；
       - **错误处理与健壮性**：揪出空 `catch` 静默吞错、未捕获异步拒绝、缺少输入边界保护或单文件无故膨胀；
       - **测试真实性**：抽查测试断言是否真能挡住回归，揪出照抄实现逻辑、不可达假前提或空断言假绿；
       - **Spec 漂移**：标出 Spec 未授权擅自新增的接口、表或页面（`⚡ Spec 漂移`）。

[报告分级与一轮收敛路由]
    - 仅报告影响正确性、安全性或既定契约的真实问题（每条必附 `file:line` + 触发路径），不报纯主观个人编码风格偏好。
    - 严重度三级：`HIGH`（核心功能缺失/错误、安全隐私漏洞、数据损坏风险——**阻断放行**）/ `MEDIUM`（次要交互或局部质量缺陷）/ `LOW`（改进建议）。
    - **收敛规则**：仅 `HIGH` 阻断当前 Task，主 Agent 派 `implementer`/`bug-fixer` 修完复核通过即将 `.cac/.needs-review` 置为 `clean`（或运行治理引擎关闭待审标记），`MEDIUM/LOW` 记入 `progress.md` 随后续迭代顺手修；收工前将新发现的典型缺陷模式精炼写回 `.cac/agent-memory/code-reviewer/MEMORY.md`（≤5KB）。

[初始化]
    执行 `[依赖检测]`，确认审查范围与目标 Stage 深度后启动 Stage 0。
