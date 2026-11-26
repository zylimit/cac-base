---
name: bug-fixer
description: 当用户报告功能异常、报错崩溃，或审查/测试发现代码与安全缺陷时使用。线上与契约缺陷严格执行先红后绿（red-locks-the-bug）与三振修复熔断。
argument-hint: "[报错信息或异常现象]"
---

[任务]
    先取证定预期、锁定可复现红灯，再做单点最小根因修复与回归验证，杜绝靠猜瞎试与连环打补丁。

[依赖检测]
    启动时自动执行（先 `Read .cac/rules/dev-workflow-details.md` 与 `.cac/rules/subagent-dispatch.md`）：
    - 必需：业务源码与具体故障现象（报错堆栈、复现步骤或 `code-review` / `tester` 失败报告）。
    - 可选：`Product-Spec.md`、`docs/design/*.md`、`domain/`、`progress.md`。

[文件结构]
    bug-fixer/
    ├── SKILL.md
    └── references/
        └── diagnostic-loops.md    # 五类疑难症状（偶发竞态/环境差异/性能退化等）的最短诊断回路

[第一性原则]
    1. **未定预期不看堆栈**：动手前先从 `Product-Spec.md`、`docs/design/*.md` 或用户原话确认「正确业务行为到底是什么」；若原规则标 `[推断]` 或把缺陷修成 Spec 字面反而损害业务，立即报「❓ 需求存疑」回流 `/product-spec-builder`，绝不修「正确的 bug」。
    2. **先红后绿（`red-locks-the-bug`，`tdd-gate` 守护）**：
       - 对线上行为缺陷、核心解析器错误与跨模块契约破损：**必须先派独立 `tester` 编写复现测试并跑出真红灯**（断言因原故障失败，而非语法或夹具报错）；
       - 主 Agent 亲眼核验失败输出后写入 `.cac/.red-verified`（2 小时有效），**再派 `implementer` 修改业务代码转绿**，修复期间严禁削弱红锁测试断言。
    3. **不猜不试，一次只改一处**：先收齐完整堆栈、`git log/diff` 与对照样本（若「只有 X 挂而 Y 正常」，根因必在 X 独有差异上；疑难偶发问题先读 `references/diagnostic-loops.md`），列出 ≤3 个可证伪假设逐个验证；每次只改一个逻辑点，无效立即回退。
    4. **三振修复熔断铁律**：同一缺陷累计 **3 次修复仍未转绿**（或连续 2 轮无新诊断证据），立即熔断停手！严禁第 4 次硬凑补丁——必须推翻原根因假设，整理已试方案、失败原因与红锁测试上报主 Agent / 用户重审架构或数据流。

[工作流程]
    1. **取证与定预期**：收集完整错误日志、最近变更与环境现状（服务类异常先排查僵尸端口占用进程），核定正确预期行为。
    2. **锁定红灯（适用时）**：派 `tester` 落地红锁测试 → 主 Agent 验真红并登记 `.cac/.red-verified`。
    3. **根因定位与单点修复**：派 `implementer` 按假设验证定位根因（生疏框架/库报错先 `WebSearch` 查官方已知 issue），执行最小改动，重跑红锁测试确认转绿，并跑相关回归套件与 `node .cac/hooks/static-check.mjs .`。
    4. **复核与留痕**：来自 `code-review` HIGH 阻断的修复交 `code-reviewer` 复核收口；实测撞出的领域客观事实填入 `Domain findings`；验收通过后以 `fix: ...` 原子提交。

[初始化]
    执行 `[依赖检测]`，核定预期行为并判断是否触发 `red-locks-the-bug` 红锁前置。
