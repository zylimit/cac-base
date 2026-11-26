---
paths:
  - "Product-Spec.md"
  - "Product-Spec-CHANGELOG.md"
  - "DEV-PLAN.md"
  - "Architecture-Design.md"
  - "DFX-Spec.md"
  - "Design-Brief.md"
---

# 开发全流程细则（dev-workflow-details）

> 本文件由 `.cac/rules/AGENTS.md` 下沉；进入任一开发阶段前必须完整 `Read` 本文件。

## 1. 阶段推进与签字闸

### 1.1 需求收集与交付（`product-spec-builder`）
1. 触发：用户表达新产品想法（0→1 模式）或修改需求/加功能/改 UI（迭代模式）。
2. 生成后主 Agent 先跑静态门（机器能挑的错绝不拿给用户挑）：
   - `node .cac/scripts/predev-lint.mjs`（校验必需段、`[确认]/[推断]/[默认]` 标记、待定问题表、无占位符残留）；若安装了大仓包可加跑 `node .cac/harness/harness.mjs spec-lint --file Product-Spec.md`。
   - 若用户未明说不出人读文档：无 `docs/readable-src/config.json` 则跑 `node .cac/scripts/readable-docs.mjs init` + `build`，已有则跑 `build`，生成 `docs/readable/index.html` 人读版需求规格。
3. **用户签字闸（案例复述）**：不发空洞的「请批准」，而是按 Spec 用用户自己的业务案例讲一遍上线后那次会怎么发生，并列出 `[推断]` N 条、`[待定]` M 条。用户挑不出错即为批准；挑出错回 `product-spec-builder` 修订再复述。**未过复述严禁进入 `dev-planner`**。

### 1.2 架构设计（`arch-designer`，M/L 档推荐）
- 前置：`Product-Spec.md` 已批准。
- 主 Agent 直接执行（文档类）：规模判档（S/M/L）→ 业务事件检验模块边界 → 七大设计原则自检 + Threat Model 九面扫描 → 产出 `Architecture-Design.md`；L 档同步产出 `.cac/harness/module-catalog.json` 骨架（装有 `--with-harness` 时跑 `catalog-lint`）。

### 1.3 DFX 质量属性设计（`dfx-designer`，可选）
- 前置：`Product-Spec.md`。
- 主 Agent 直接执行：隐含行业合规扫描 → 13 维质量属性过堂（场景六要素 + 度量指标 + 对策 + 验证落点）→ 安全威胁表 + AI 能力护栏表 → 产出 `DFX-Spec.md`，跑 `node .cac/scripts/predev-lint.mjs` 校验。

### 1.4 界面规范与原型（`design-brief-builder` + `design-maker`，可选）
- `design-brief-builder`：形态先于视觉（Web/桌面/终端/Agent 四轨），采访首要动作与反参考护栏，产出 `Design-Brief.md`（信息架构 + SCREEN 八态 + 交互原语 + 可访问性）与 `DESIGN.md`（视觉 token 与规则），跑 `node .cac/scripts/predev-lint.mjs`。
- `design-maker`：支持「离线逻辑沙盘」（仅验业务规则状态）或「方向样张 3 选 1 → 两遍法生成可运行原生 HTML 原型/提示词」，生成后跑 `node .cac/scripts/ui-audit.mjs <目录> --strict`（无浏览器引擎返回 `rc 3` 必须如实告知「UI 审计缺席」，不冒充通过）与 `node .cac/scripts/ui-slop-scan.mjs`。

### 1.5 开发计划（`dev-planner`）
- 前置：`Product-Spec.md` 已签字。
- 依赖 DAG 硬约束 +「价值 × 关键未知」排序，每个 Phase 写明「验证的假设」，每个 Task 无占位符且粒度适中。
- 产出 `DEV-PLAN.md` 后必须跑 `node .cac/scripts/plan-lint.mjs`，退出码为 `0` 才可进入 `dev-builder`。

### 1.6 项目开发闭环（`dev-builder`）
1. **逐 Task 定档派发**（主 Agent 按预计/实际 `git diff --stat` 与触及路径机械定档，拿不准按高一档，写入派单 `Goal` 首行）：
   - **LOW**（<50 行，不碰契约/解析器/鉴权/迁移/支付/hooks，不引新依赖）：派 `implementer` → 自检 + `static-check.mjs` + 跑现有测试 → 主 Agent 核查 diff 与运行器输出验收 → 提交。
   - **MEDIUM**（50–300 行，或碰上述一类路径，或引新依赖）：`implementer` → `code-reviewer`（Stage 0 + Stage 1 规格符合性）→ 仅 HIGH 阻断，修完同轮复核一次收口 → `echo clean > .cac/.needs-review` → 提交。
   - **HIGH**（>300 行，或碰两类以上上述路径，或线上 bug/数据迁移/安全）：`implementer` → `code-reviewer` 全三 Stage → HIGH 修复复核 → 派独立 `tester` 补关键逻辑回归测试 → `echo clean > .cac/.needs-review` → 提交。
2. **Medium / Low Finding 收敛**：记入 `progress.md` 残留随后续 Task 顺手修，不无限开新轮次。
3. **需求存疑回流**：子代理回执带 `Counter-examples` 或审查报「❓ 需求存疑」，暂停该点回流 `product-spec-builder` 迭代模式更新 Spec + CHANGELOG 并复述确认。
4. **人读文档随 Task 走**：项目含 `docs/readable-src/config.json` 且 Task 触及建表定义、读写表代码、模块文件/接口/跨模块引用时，派单 `Verification` 必带 `node .cac/scripts/readable-docs.mjs build`、补说明、`check` 报「不一致 0 条」，并守住派单前 `readable-docs.mjs structure` 的结构基线（循环依赖、越层引用、未归属文件、>1000 行文件不许悄悄增加）。
5. **Phase 完成四步走**：
   - 第 1 步：全 Phase 范围 Code Review；
   - 第 2 步：测试完整性（派独立 `tester` 核跨 Task 契约/导入/边界；若有 `docs/design/*.md` 加跑 `node .cac/scripts/design-trace.mjs`）；
   - 第 3 步：全量编译/静态验证（`node .cac/hooks/static-check.mjs`）；
   - 第 4 步：功能冒烟测试。
   中间有任何代码改动，四步重跑；收尾按 `PASS / CONCERNS / FAIL / WAIVED` 四态写回 `DEV-PLAN.md` 该 Phase 标题（安全与数据丢失类严禁 `WAIVED`）。

### 1.7 发布与分支收尾（`release-builder` / `branch-finisher`）
- 两者均设 `disable-model-invocation: true`，主 Agent **禁止代触发**，只能请用户亲自输入 `/release-builder` 或 `/branch-finisher`。
- **请用户敲 `/release-builder` 之前，主 Agent 必须先亲查 4 项并把结果写进回复**：
  1. `.cac/.needs-review` 已清空或为 `clean`；
  2. `git status --short` 为空；
  3. 远端分支与本地 `HEAD` 同步（若有上游）；
  4. 若有 `docs/readable-src/config.json`，`node .cac/scripts/readable-docs.mjs check` 报「不一致 0 条」。
- 部署由 `deployer` 执行后，主 Agent 独立核查**部署三件套**（构建产物/容器时间戳与版本 tag、健康检查端点响应、live 关键路径冒烟），绝不盲信 `deployer` 自报。

## 2. 项目进度检测显示格式

会话初始化或用户询问进度时，先跑 `node .cac/scripts/project-status.mjs`，按以下格式展示：

```markdown
📊 **项目进度检测**
- Product Spec：[已完成 / 未创建]
- Design Brief：[已生成 / 未创建]
- DEV-PLAN：[已生成 / 未创建]
- 项目代码：[已创建 / 未创建]
- 现在到哪：[<project-status.mjs 第一行输出>]
- 活文档状态：[<project-status.mjs 第二行输出>]

**当前阶段**：[阶段名]
**下一步建议**：[具体可执行指令]
```
