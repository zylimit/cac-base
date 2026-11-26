# progress.md — cac-base 项目记忆

> 本文件为 `cac-base` 框架自身的开发记忆，安装器通过 `exclusions.json` 与 `NEVER_INSTALL` 双重排除，绝不复制进下游目标项目。

## Pinned（必守约束）

- 原生独立维护：直接面向 `codeagent`（`.cac/` + 根 `AGENTS.md`）直写，零 `.claude/` 同步壳、零跨宿主映射层。
- 零 npm 依赖：全仓仅使用 Node >= 20 内置模块，Windows PowerShell 不依赖 Git Bash / `jq` / Python 即可全功能运行。
- 严格只读外部参考：同级参考仓库 `../cc-base` 与 `../codeagent-base` 严禁任何修改。
- 规则加载实证约束：`codeagent 1.2615.02.05` 自动加载根 `AGENTS.md`，但不按 `paths:` 自动注入 `.cac/rules/*.md`——所有下沉细则由 `AGENTS.md` 强制前置 `Read` 指针驱动。
- 写测与审查独立：`tester` 与 `code-reviewer` 必须与 `implementer` 为不同 fresh 子代理实例。

## Decisions

- 2026-11-26: 采用单一纯 Node 安装与体检内核（`scripts/cac-base.mjs` + `.cac/scripts/doctor.mjs`），`setup.ps1` 与 `setup.sh` 仅做参数透传薄壳。
  - 依据：根治 `cc-base` 双份 600+ 行脚本手写漂移与 `jq`/Git Bash 依赖，同时修复旧 `codeagent-base` 版本正则与参数解析缺陷。
  - 适用范围：全框架安装、升级、卸载、清单校验与体检。
  - 取代：旧 `codeagent-base` 双安装器（`scripts/lib/installer.mjs` + `.cac/base/install.mjs`）。
- 2026-11-26: 按 Windows PowerShell `codeagent 1.2615.02.05` 真机抓包锁定 Hook 与权限契约（见 `docs/HOST-CONTRACT.md`）。
  - 依据：实测确认 `CODEAGENT3_PROJECT_DIR` 环境变量、子代理事件携带 `agent_id`+`agent_type`、`SubagentStop`/`Stop` 携带 `stop_hook_active`+`last_assistant_message`、`PreToolUse` 双阻断通道（`exit 2` 与 `permissionDecision:"deny"`）、`Stop` 阻断用 `{decision:"block",reason}`（不带 `continue:false`）、`Skill` 调用经 `PreToolUse(Skill)` 且原生支持 `disable-model-invocation: true`。
  - 适用范围：`.cac/settings.json`、`.cac/hooks/**`、`.cac/agents/**`、`.cac/skills/**`、`AGENTS.md`。
  - 取代：旧仓未经 Windows 实测的假设协议。
- 2026-11-26: 默认轻装分发 + 可选包拆离（`--with-harness` 装 `.cac/harness/ext/`，`--with-tests` 装 `.cac/tests/`）；`auto-push` 默认三档全 `off`；`tsc` 去除 `npx.cmd` 改由 `process.execPath` 直接运行 `node_modules/typescript/bin/tsc` 防 Windows Node 20.12+/22 `EINVAL`。
  - 依据：避免污染中小业务仓库，防止未经授权推送，根治 CVE-2024-27980 后 Windows `spawnSync('npx.cmd', {shell:false})` 抛 `EINVAL`。
  - 适用范围：`exclusions.json`、`profile.json`、`installer.mjs`、`pre-commit-check.mjs`、`static-check.mjs`。
  - 取代：旧 `codeagent-base` 32 子命令全量强装与裸 `npx.cmd` 调用。

## 当前断点

- `cac-base` v1.0.0 全栈实现、独立回归测试（10 套件 68 用例全绿）、三阶段对抗审查（14/14 发现全部闭环）与打包体检（`pack-check` / `doctor` 全绿）已收口完成；待用户在 Windows 本机按需执行 `setup.ps1` 实装试用。

## TODO

- [P0][DONE][#1] 完成核心引擎、三哨兵、18 个 Hook 与 Git Hooks 实现
- [P0][DONE][#2] 完成 9 个 Sub-Agent、22 个原生 Skill 与前期/设计静态脚本
- [P0][DONE][#3] 完成活文档三件套与 `readable-docs` 47 模块全栈迁移适配
- [P0][DONE][#4] 完成纯 Node 安装器、`setup.ps1`/`setup.sh`、`doctor.mjs`、可选大仓包 `ext/` 与 CI
- [P0][DONE][#5] 生成 `FRAMEWORK-MANIFEST.json`，由独立 `cac-tester` 编写全量 `node:test` 套件（10 套件 68 用例）并全绿
- [P0][DONE][#6] 由独立 `cac-reviewer` 完成三阶段审查并闭环全部 14 项问题（含新增 7 组防回退回归断言）

## Done

- 2026-11-26: 完成旧版 `codeagent-base`（`31d7dd3`）与蓝本 `cc-base`（`99bcc91`）全量只读审计与 Gap 对比报告。
- 2026-11-26: 完成 Windows PowerShell `codeagent 1.2615.02.05` 真机沙箱抓包核验，沉淀 `docs/HOST-CONTRACT.md`。
- 2026-11-26: 完成 `cac-base` v1.0.0 全仓原生构建（核心治理引擎 + 三哨兵 + 18 Hook + 9 Sub-Agent + 22 Skill + 活文档三件套 + `readable-docs` 47 模块 + 单一 Node 双平台安装器 + 可选大仓包 `ext/`）。
- 2026-11-26: 完成独立测试与三阶段代码审查闭环（修复并锁死 Windows `npx.cmd` `EINVAL`、Bash/PowerShell 双安全地板闸边界、唯一实例 `agent_id` 作者记账、`stop_hook_active` 防重入等全部 14 项问题，68/68 测试通过，`pack-check` 0 漂移 0 泄漏）。
