# cac-base 架构文档

> 面向 **Windows PowerShell / WSL / Linux** 下 **CodeAgent CLI (`codeagent` / `.cac/`)** 的原生独立全栈工程治理框架。  
> 版本：1.2.0（2026-11-26） | 能力与方法论蓝本：`cc-base`（2026-11-25） | 宿主实证契约：[docs/HOST-CONTRACT.md](docs/HOST-CONTRACT.md)

---

## 1. 核心定位与设计哲学

1. **原生独立与根目录零入侵**：完全围绕 `codeagent` 原生配置树 `.cac/` 直写，主控宪法置于无 `paths:` 头的 `.cac/rules/AGENTS.md`（会话启动原生自动注入）；目标项目根目录零新增文件，与多 AI 工具零冲突共存，无 `.claude/` 同步链、无跨宿主工具名动态转译包袱。
2. **零 npm 依赖，纯 Node >= 20 跨平台统一内核**：所有 Hook、治理引擎、安装器、活文档归档、`readable-docs` 生成器、审计哨兵与测试套件 100% 采用 Node.js 内置模块实现——在**纯 Windows PowerShell（无需 Git Bash、无需 `jq`、无需 Python）**与 WSL/Linux 下行为逐字节对等。
3. **核心轻装 + 大仓按需加装**：默认安装仅向目标项目注入 `.cac/` 隐藏配置树（根目录零文件入侵）；60 万行级大仓治理引擎（`.cac/harness/ext/`）与框架自测（`.cac/tests/`）通过 `--with-harness` / `--with-tests` 按需安装，放置 `module-catalog.json` 才启用大仓门禁。
4. **Hook 与引擎进程级隔离 + 单一档位解析器**：`fast / standard / strict` 三档强度与不可旁路的 `BUILTIN_FLOOR` 安全地板集中在 `.cac/hooks/lib/tier.mjs` 单一解析，Hook 绝不静态 `import` 引擎，防止引擎异常连带击穿会话护栏。

---

## 2. 分层架构

| 层级 | 路径 | 职责 |
|---|---|---|
| **主控宪法与细则** | `.cac/rules/AGENTS.md` + `.cac/rules/*.md` | 无头 `.cac/rules/AGENTS.md` 启动自动注入（1:1 完整承载 SiteMaster 人设与开场白、四分类话术、交互深度四档、10 条铁律、审批三档、22 Skill 路由、9 角色调度、强制前置 `Read` 协议及开场零探测硬边界）；7 份核心细则（含 `workflow-orchestration.md`）与 2 份大仓扩展细则带 `paths:` 头按需加载防上下文膨胀 |
| **全流程技能链** | `.cac/skills/`（22 个） | 从需求访谈、架构/DFX、界面规范与原型、开发计划、Task 三档编码闭环、审查/红蓝对抗、独立测试、发布收尾，到人读文档、领域口径与记忆进化 |
| **主从 Sub-Agent** | `.cac/agents/`（9 个） | 单层扁平编排：`implementer` / `code-reviewer` / `tester` / `deployer` / `researcher` / `feedback-observer` / `evolution-runner` / `progress-recorder` / `domain-recorder` |
| **三层强制防线** | `.cac/hooks/` + `.cac/githooks/` + `.github/workflows/gate.yml` | 会话内实时拦截（含 Bash + PowerShell 双壳密钥/危险命令地板闸、主从写码隔离、红锁、待审三振、三文件同步）+ Git 提交推送门 + 双平台 CI |
| **活文档与人读文档** | `.cac/scripts/`（含 `readable/` 47 模块） | `project-status` / `progress-archive` / `plan-archive` 治理活文档膨胀；`readable-docs` + `page-shots` 从 DDL/代码/Spec/架构零丢字生成离线 HTML 工程文档并随提交核对结构退化 |
| **治理引擎与三哨兵** | `.cac/harness/`（核心 4 命令 + `audit/` + 可选 `ext/`） | 五值退出码（`0=clean / 1=violation / 2=blocked / 3=degraded / 4=stale`）+ 单行 JSON 契约；三哨兵独立防密钥/指令注入/语法损坏；大仓影响闭包、diff-bound 回执、五性覆盖门 |
| **事务安装与自检** | `setup.ps1` / `setup.sh` + `scripts/cac-base.mjs` + `.cac/scripts/doctor.mjs` | 逐段 Windows 安全路径校验、原子独占锁、`install.marker` 中断留痕、LF-SHA256 三路无损升级（用户改动旁落 `*.cac-base-new`）、`settings.json` 纯 Node 无损合并、全量清单体检 |
