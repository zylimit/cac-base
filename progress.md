# progress.md — cac-base 项目记忆

> 本文件为 `cac-base` 框架自身的开发记忆，安装器通过 `exclusions.json` 与 `NEVER_INSTALL` 双重排除，绝不复制进下游目标项目。

## Pinned（必守约束）

- 原生独立与根目录零入侵：直接面向 `codeagent`（仅 `.cac/` 隐藏配置树，主控宪法位于无头 `.cac/rules/AGENTS.md`）直写，目标项目根目录零新增文件，零 `.claude/` 同步壳、零跨宿主映射层。
- 零 npm 依赖：全仓仅使用 Node >= 20 内置模块，Windows PowerShell 不依赖 Git Bash / `jq` / Python 即可全功能运行。
- 严格只读外部参考：同级参考仓库 `../cc-base` 与 `../codeagent-base` 严禁任何修改。
- 规则加载实证约束：`codeagent 1.2615.02.05` 不自动加载 `.cac/{AGENTS,CLAUDE,CODEAGENT}.md`，但会在会话启动时原生自动注入**无 `paths:` 头**的 `.cac/rules/*.md`（主控宪法 `.cac/rules/AGENTS.md`）；带 `paths:` 头的 `.cac/rules/*.md` 启动不自动注入，由 `.cac/rules/AGENTS.md` 强制前置 `Read` 指针驱动。
- 写测与审查独立：`tester` 与 `code-reviewer` 必须与 `implementer` 为不同 fresh 子代理实例。

## Decisions

- 2026-11-26: 固化「异构宿主与 CLI 规则必先查官方文档并跑真机探针实测」至 `.cac/rules/AGENTS.md` 铁律 3（同步登记 `.cac/feedback/verify-before-claiming.md` 并毕业），并闭环三阶段代码审查全部 5 项问题（哨兵已删未暂存文件跳过与 `gitIndexSet()` 暂存索引集、下游 `rules-audit` 外部安装器识别与大小写不敏感去重、`.cac/rules/AGENTS.md` 严禁任何 `---` YAML frontmatter 头、清理虚构 `harness validate` 命令、`manifest.mjs` 根指令禁装保护+`seeded` 双向漂移检查与 `gate.yml` 外部根文件全链路共存断言）。
  - 依据：用户明确纠正跨宿主规则或目录约定严禁凭单一宿主经验类推臆断，必须先调搜索引擎查官方文档并跑真机探针实测；同时三阶段审查发现 2 HIGH / 2 MEDIUM / 1 LOW 共 5 处边界漏洞需代码与静态护栏双重封堵。
  - 适用范围：`.cac/rules/AGENTS.md`、`.cac/feedback/`、`.cac/harness/audit/*`、`.cac/harness/ext/rules*`、`.cac/scripts/doctor.mjs`、`.cac/skills/{skill-builder,feedback-writer}/SKILL.md`、`scripts/lib/manifest.mjs`、`.github/workflows/gate.yml`。
  - 取代：仅泛泛提查证而未禁止跨宿主经验类推的旧版铁律 3 表述，以及仅检测未加引号 `paths:` 键名的宽松头校验。
- 2026-11-26: 主控宪法从仓库根 `AGENTS.md` 迁移至无 YAML frontmatter 的 `.cac/rules/AGENTS.md`（v1.1.0 根目录零文件入侵架构），纳入 `FRAMEWORK-MANIFEST.json` 常规受管文件并移除 `seededRootFiles` 特例。
  - 依据：Windows 内网真机 PowerShell 禁工具沙箱（根目录零 `.md` + `--disallowedTools "Read Glob Grep Bash"`）实测输出 `[HIT-4-CAC-RULES]`，证实 `.cac/{AGENTS,CLAUDE,CODEAGENT}.md` 均不自动加载，而无 `paths:` frontmatter 的 `.cac/rules/*.md` 启动原生自动注入；迁入 `.cac/rules/AGENTS.md` 后默认安装仅生成 `.cac/`，与 `cc-base` / `agy-base` / Cursor / Codex 及下游自有根 `AGENTS.md` 零冲突共存，并由 `doctor.mjs` 与 `check-syntax.mjs` 硬拦误加 `paths:` 头。
  - 适用范围：`.cac/rules/AGENTS.md`、`.cac/rules/*.md`、`exclusions.json`、`profile.json`、`manifest.mjs`、`installer.mjs`、`doctor.mjs`、`check-syntax.mjs`、`ext/{memory,rules,evidence,selftest}.mjs`、CI 与根文档。
  - 取代：v1.0.0 将主控宪法置于仓库根 `AGENTS.md` 并通过 `seededRootFiles` 分发的设计。
- 2026-11-26: 采用单一纯 Node 安装与体检内核（`scripts/cac-base.mjs` + `.cac/scripts/doctor.mjs`），`setup.ps1` 与 `setup.sh` 仅做参数透传薄壳。
  - 依据：根治 `cc-base` 双份 600+ 行脚本手写漂移与 `jq`/Git Bash 依赖，同时修复旧 `codeagent-base` 版本正则与参数解析缺陷。
  - 适用范围：全框架安装、升级、卸载、清单校验与体检。
  - 取代：旧 `codeagent-base` 双安装器（`scripts/lib/installer.mjs` + `.cac/base/install.mjs`）。
- 2026-11-26: 按 Windows PowerShell `codeagent 1.2615.02.05` 真机抓包锁定 Hook 与权限契约（见 `docs/HOST-CONTRACT.md`）。
  - 依据：实测确认 `CODEAGENT3_PROJECT_DIR` 环境变量、子代理事件携带 `agent_id`+`agent_type`、`SubagentStop`/`Stop` 携带 `stop_hook_active`+`last_assistant_message`、`PreToolUse` 双阻断通道（`exit 2` 与 `permissionDecision:"deny"`）、`Stop` 阻断用 `{decision:"block",reason}`（不带 `continue:false`）、`Skill` 调用经 `PreToolUse(Skill)` 且原生支持 `disable-model-invocation: true`。
  - 适用范围：`.cac/settings.json`、`.cac/hooks/**`、`.cac/agents/**`、`.cac/skills/**`、`.cac/rules/AGENTS.md`。
  - 取代：旧仓未经 Windows 实测的假设协议。
- 2026-11-26: 默认轻装分发 + 可选包拆离（`--with-harness` 装 `.cac/harness/ext/`，`--with-tests` 装 `.cac/tests/`）；`auto-push` 默认三档全 `off`；`tsc` 去除 `npx.cmd` 改由 `process.execPath` 直接运行 `node_modules/typescript/bin/tsc` 防 Windows Node 20.12+/22 `EINVAL`。
  - 依据：避免污染中小业务仓库，防止未经授权推送，根治 CVE-2024-27980 后 Windows `spawnSync('npx.cmd', {shell:false})` 抛 `EINVAL`。
  - 适用范围：`exclusions.json`、`profile.json`、`installer.mjs`、`pre-commit-check.mjs`、`static-check.mjs`。
  - 取代：旧 `codeagent-base` 32 子命令全量强装与裸 `npx.cmd` 调用。

## 当前断点

- `cac-base` v1.1.0（主控宪法迁入 `.cac/rules/AGENTS.md` 根目录零文件入侵模式 + 同仓多底座零冲突共存）已完成全链路实现、两轮独立三阶段审查（`0 open findings`）、全量独立回归测试（10 套件 77 用例全绿）与 `pack-check` / `doctor` 体检，就绪提交推送远端仓库。

## TODO

- [P0][DONE][#1] 完成核心引擎、三哨兵、18 个 Hook 与 Git Hooks 实现
- [P0][DONE][#2] 完成 9 个 Sub-Agent、22 个原生 Skill 与前期/设计静态脚本
- [P0][DONE][#3] 完成活文档三件套与 `readable-docs` 47 模块全栈迁移适配
- [P0][DONE][#4] 完成纯 Node 安装器、`setup.ps1`/`setup.sh`、`doctor.mjs`、可选大仓包 `ext/` 与 CI
- [P0][DONE][#5] 生成 `FRAMEWORK-MANIFEST.json`，由独立 `cac-tester` 编写全量 `node:test` 套件（10 套件 68 用例）并全绿
- [P0][DONE][#6] 由独立 `cac-reviewer` 完成三阶段审查并闭环全部 14 项问题（含新增 7 组防回退回归断言）
- [P0][DONE][#7] v1.1.0 主控宪法迁入 `.cac/rules/AGENTS.md`（根目录零文件入侵）及全链路护栏/清单/CI 同步

## Done

- 2026-11-26: 完成旧版 `codeagent-base`（`31d7dd3`）与蓝本 `cc-base`（`99bcc91`）全量只读审计与 Gap 对比报告。
- 2026-11-26: 完成 Windows PowerShell `codeagent 1.2615.02.05` 真机沙箱抓包核验，沉淀 `docs/HOST-CONTRACT.md`。
- 2026-11-26: 完成 `cac-base` v1.0.0 全仓原生构建（核心治理引擎 + 三哨兵 + 18 Hook + 9 Sub-Agent + 22 Skill + 活文档三件套 + `readable-docs` 47 模块 + 单一 Node 双平台安装器 + 可选大仓包 `ext/`）。
- 2026-11-26: 完成独立测试与三阶段代码审查闭环（修复并锁死 Windows `npx.cmd` `EINVAL`、Bash/PowerShell 双安全地板闸边界、唯一实例 `agent_id` 作者记账、`stop_hook_active` 防重入等全部 14 项问题，68/68 测试通过，`pack-check` 0 漂移 0 泄漏）。
- 2026-11-26: 基于内网真机禁工具沙箱实证（`[HIT-4-CAC-RULES]`）与 `--debug-file` 启动扫描实证（`.claude/` 零命中），完成 v1.1.0 主控宪法迁移至 `.cac/rules/AGENTS.md`（无 frontmatter 启动自动注入），实现目标项目根目录零文件入侵与多底座同仓绝缘共存；闭环全部 5 项审查问题，通过 10 套件 77 用例独立回归测试与 `pack-check` 七项门禁。
