# progress.md — cac-base 项目记忆

> 本文件为 `cac-base` 框架自身的开发记忆，安装器通过 `exclusions.json` 与 `NEVER_INSTALL` 双重排除，绝不复制进下游目标项目。

## Pinned（必守约束）

- 原生独立与根目录零入侵：直接面向 `codeagent`（仅 `.cac/` 隐藏配置树，主控宪法位于无头 `.cac/rules/AGENTS.md`）直写，目标项目根目录零新增文件，零 `.claude/` 同步壳、零跨宿主映射层。
- 零 npm 依赖：全仓仅使用 Node >= 20 内置模块，Windows PowerShell 不依赖 Git Bash / `jq` / Python 即可全功能运行。
- 严格只读外部参考：同级参考仓库 `../cc-base` 与 `../codeagent-base` 严禁任何修改。
- 规则加载实证约束：`codeagent 1.2615.02.05` 不自动加载 `.cac/{AGENTS,CLAUDE,CODEAGENT}.md`，但会在会话启动时原生自动注入**无 `paths:` 头**的 `.cac/rules/*.md`（主控宪法 `.cac/rules/AGENTS.md`）；带 `paths:` 头的 `.cac/rules/*.md` 启动不自动注入，由 `.cac/rules/AGENTS.md` 强制前置 `Read` 指针驱动。
- 写测与审查独立：`tester` 与 `code-reviewer` 必须与 `implementer` 为不同 fresh 子代理实例。

## Decisions

- 2026-11-27: 加固 `cac-base` v1.2.1 安装器、设置合并器与清单排除规则，实现重复安装、跨版本升级、悬空坏链自愈、崩溃锁接管与 `cac-base-link -> cac-base` 跨模式反向切换 100% 幂等成功且零穿透污染 `.claude/`。
  - 依据：当目标仓库曾安装 `cac-base-link`（`.cac/skills` 与 `.cac/agents` 为指向 `../.claude/{skills,agents}` 的符号链接/Windows Junction，且含 `.cac/hooks/cc-bridge.mjs` 桥接器）或存在悬空死链、阻碍目录创建的同名文件时，直接穿透路径读写会导致假冲突或覆写污染 `.claude/` 下的外部文件；通过引入 `unlinkSymlinkOrJunctionSafe`（Windows 优先 `rmdirSync` 仅拆重解析点、POSIX `unlinkSync`，严禁 `rmSync({recursive:true})`）、`planInstall` 浅到深 `unlinkedDirs` 预扫描与零穿透 `'create'` 判定、叶子符号链接拆链写入、`retiredFiles` 退役受管文件（`cc-bridge.mjs`/`root.mjs`/`ps-floor.mjs`）清理及空父目录回收，配合 `settings-merge.mjs` 剥离 `cc-bridge.mjs` 与清理空事件键，彻底消除跨模式切换死角。
  - 适用范围：`scripts/lib/{installer,settings-merge,manifest}.mjs`、`.gitignore`、`.cac/.gitignore`、`.cac/harness/exclusions.json`、`package.json`、`README.md`、`.cac/FRAMEWORK-MANIFEST.json`。
  - 取代：未区分目录/叶子符号链接直接 `existsSync`/`copyFileSync` 读写、未剥离 `cc-bridge.mjs` 遗留桥接 Hook 及未自动退役旧清单废弃受管文件的 v1.2.0 安装实现。
- 2026-11-27: 闭环 `cac-base` v1.2.0 三阶段审查检出的全部 12 项问题（3 HIGH / 5 MEDIUM / 4 LOW），保持 194 个受管文件清单零漂移零泄漏。
  - 依据：三阶段审查发现模板路径笔误（`feedback-topic-template.md`）、遗留子命令引用与裸词误装风险（`cac-base.mjs package`）、`pre-commit-check.mjs` 与 `red-blue-pack.mjs` 未接入外层父目录 `.git` 边界守卫、无首提空仓 `HEAD` 暂存改动不可见、软链子目录 `findCacProjectRoot` 绕过与 `tmpKey` 排除、Windows `relToProject` 大小写及 `session-start` `trackedSubdir` 误告警、`audit/README.md` 残留旧版单文件与虚构白名单描述，以及 4 处悬空引用与 `rules-audit` 扫描目录缺口。
  - 适用范围：`.cac/skills/{feedback-writer,readable-docs}/SKILL.md`、`.cac/skills/red-blue-review/{SKILL.md,RED-BLUE-REVIEW.md,red-blue-pack.mjs}`、`.cac/skills/product-spec-builder/references/discovery-methods.md`、`scripts/cac-base.mjs`、`.cac/hooks/{pre-commit-check,session-start}.mjs`、`.cac/hooks/lib/io.mjs`、`.cac/harness/lib/core.mjs`、`.cac/harness/ext/{rules.mjs,rules/harness-large-repo.md}`、`.cac/harness/audit/README.md`、`docs/HOST-CONTRACT.md`、`.cac/FRAMEWORK-MANIFEST.json`。
  - 取代：未拦裸词误输 `package` 的 CLI 解析、无 `gitStateOf`/`--relative -- .` 的提交钩子与证据打包器、仅对比 `HEAD` 的空仓 diff 计算、单遍词法向上查找的 `findCacProjectRoot`，以及含虚构 `instructions-allowlist.json` 的旧版审计文档。
- 2026-11-26: 将 `cc-base` 全量原文手搓细节（主控宪法 `CLAUDE.md` 全文含 `SiteMaster` ASCII 开场白、7 份核心细则、2 份大仓扩展细则、22 个 Skill 全量正文与新增 12 份案例/参考/适配器文档）1:1 无损融合至 `cac-base` 原生 `.cac/` 体系，补登 `workflow-orchestration` 至 `doctor.mjs` 核心细则清单并定版 `v1.2.0`（194 个受管文件、0 seeded 文件）。
  - 依据：早期重写阶段对主控宪法、细则与技能正文做过结构提炼，损失了 `cc-base` 大量实战沉淀的判据例子、话术护栏与 `SiteMaster` 标志性开场白；在保持 `.cac/rules/AGENTS.md` 绝无 YAML frontmatter、异构宿主查证真机探针铁律、9 角色显式上下文摘录编排、`SessionStart` 开场快照零工具秒回与 `.cac/` 根硬边界等 `cac-base` 专属实证能力不丢分毫的前提下，1:1 无损补齐全部原文血肉。
  - 适用范围：`.cac/rules/AGENTS.md`、`.cac/rules/*.md`（含新增 `workflow-orchestration.md`）、`.cac/harness/ext/rules/*.md`、`.cac/skills/**`、`.cac/harness/adapters.json`、`.cac/harness/audit/README.md`、`.cac/scripts/doctor.mjs`、`.cac/FRAMEWORK-MANIFEST.json`、`package.json`、`ARCHITECTURE.md`、`README.md`。
  - 取代：v1.0.0–v1.1.1 中经压缩改写的精简版 `.cac/rules/AGENTS.md`（92 行）与缩写版规则/技能文本，以及 `doctor.mjs` 仅校验 6 份核心细则的旧清单。
- 2026-11-26: 锁死 `.cac/` 项目根硬边界防外层父目录 `.git` 越界逃逸，并在 `SessionStart` 预注入项目启动快照实现新项目开场寒暄零工具调用秒回（升级至 `v1.1.1`）。
  - 依据：Windows 真机新项目实跑暴露外层祖先目录误建 `.git` 时，`git rev-parse --show-toplevel` 与无路径限定的 `git status --porcelain` 会越界跳往父目录，把兄弟项目脏文件误报为当前工作树改动或触发 `raise` 升档；同时 `v1.1.0` 根目录零入侵使新目录仅含隐藏的 `.cac/`，常规 `ls` 返回空引发模型连发 8 次工具探测甚至越界翻阅父目录。通过在 `io.mjs`/`tier.mjs`/`core.mjs` 引入 `gitStateOf` 与 `.cac` 祖先边界锁死（并免疫用户全局 `~/.cac`）、子目录 `porcelainZ` 限定 `-- .` 剥离前缀，搭配 `session-start.mjs` 毫秒级启动快照与 `.cac/rules/AGENTS.md` 硬规则，彻底闭环两类问题。
  - 适用范围：`.cac/hooks/lib/{io,tier}.mjs`、`.cac/hooks/{session-start,three-file-sync-gate,precompact-gate}.mjs`、`.cac/harness/lib/core.mjs`、`.cac/rules/AGENTS.md`、`package.json`、`ARCHITECTURE.md`。
  - 取代：未校验 `ownRepo` 直接调用 `git rev-parse --show-toplevel` / 无前缀剥离的 `porcelainZ`，以及开场未预注目录快照需模型自行探测目录的旧实现。
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

- `cac-base` v1.2.1 独立三阶段代码审查关联问题（F-02 `setup.ps1` 裸词误输守卫、F-06 `doctor.mjs` 外部目录无参自寻根与 `~/.local/bin` CLI 探测、F-08 `acquireInstallLock` 10 分钟陈旧锁接管/残留目录锁防护与叶子物理目录 `.bak-<ts>` 腾退、F-09 `runUninstall` 跨引擎误卸载防护与 `.cac/{skills,agents}` 残留软链拆解、F-10 `isReleaseExcludedRel` 补入 `cac-link-new`）已全部修复并刷新 `FRAMEWORK-MANIFEST.json`，待独立 `cac-tester` 补充回归断言与 `cac-reviewer` 复核闭环。

## TODO

- [P0][DONE][#1] 完成核心引擎、三哨兵、18 个 Hook 与 Git Hooks 实现
- [P0][DONE][#2] 完成 9 个 Sub-Agent、22 个原生 Skill 与前期/设计静态脚本
- [P0][DONE][#3] 完成活文档三件套与 `readable-docs` 47 模块全栈迁移适配
- [P0][DONE][#4] 完成纯 Node 安装器、`setup.ps1`/`setup.sh`、`doctor.mjs`、可选大仓包 `ext/` 与 CI
- [P0][DONE][#5] 生成 `FRAMEWORK-MANIFEST.json`，由独立 `cac-tester` 编写全量 `node:test` 套件（10 套件 68 用例）并全绿
- [P0][DONE][#6] 由独立 `cac-reviewer` 完成三阶段审查并闭环全部 14 项问题（含新增 7 组防回退回归断言）
- [P0][DONE][#7] v1.1.0 主控宪法迁入 `.cac/rules/AGENTS.md`（根目录零文件入侵）及全链路护栏/清单/CI 同步
- [P0][DONE][#8] v1.1.1 修复外层父目录 `.git` 向上逃逸误报与 `SessionStart` 启动快照预注（新空项目开场零工具秒回）
- [P0][DONE][#9] v1.2.0 全量无损融合 `cc-base` 主控宪法/细则/22 技能原文血肉与新增 12 份参考示例，`doctor.mjs` 升至 7 核心细则并重算 194 受管文件清单
- [P0][DONE][#10] v1.2.0 闭环三阶段审查全部 12 项问题（3 HIGH / 5 MEDIUM / 4 LOW）并重算 `FRAMEWORK-MANIFEST.json`
- [P0][DONE][#11] v1.2.1 加固安装器安全拆链、退役受管文件清理、`cc-bridge.mjs` Hook 剥离与 `*.cac-link-new` 排除规则，打通 `cac-base-link <-> cac-base` 零污染切换

## Done

- 2026-11-26: 完成旧版 `codeagent-base`（`31d7dd3`）与蓝本 `cc-base`（`99bcc91`）全量只读审计与 Gap 对比报告。
- 2026-11-26: 完成 Windows PowerShell `codeagent 1.2615.02.05` 真机沙箱抓包核验，沉淀 `docs/HOST-CONTRACT.md`。
- 2026-11-26: 完成 `cac-base` v1.0.0 全仓原生构建（核心治理引擎 + 三哨兵 + 18 Hook + 9 Sub-Agent + 22 Skill + 活文档三件套 + `readable-docs` 47 模块 + 单一 Node 双平台安装器 + 可选大仓包 `ext/`）。
- 2026-11-26: 完成独立测试与三阶段代码审查闭环（修复并锁死 Windows `npx.cmd` `EINVAL`、Bash/PowerShell 双安全地板闸边界、唯一实例 `agent_id` 作者记账、`stop_hook_active` 防重入等全部 14 项问题，68/68 测试通过，`pack-check` 0 漂移 0 泄漏）。
- 2026-11-26: 基于内网真机禁工具沙箱实证（`[HIT-4-CAC-RULES]`）与 `--debug-file` 启动扫描实证（`.claude/` 零命中），完成 v1.1.0 主控宪法迁移至 `.cac/rules/AGENTS.md`（无 frontmatter 启动自动注入），实现目标项目根目录零文件入侵与多底座同仓绝缘共存；闭环全部 5 项审查问题，通过 10 套件 77 用例独立回归测试与 `pack-check` 七项门禁。
- 2026-11-26: 完成 v1.1.1 修复外层父目录 `.git` 越界逃逸与新空项目开场连发工具探测问题（新增 `gitStateOf` 与 `.cac/` 根边界锁死、子目录 `porcelainZ` 限定与前缀剥离、`SessionStart` 毫秒级启动快照预注与未独立 `git init` 提示、`.cac/rules/AGENTS.md` 开场零探测与工作目录硬边界规则）。
- 2026-11-26: 完成 v1.2.0 `cc-base` 全量原文血肉 1:1 无损融合（无头 `.cac/rules/AGENTS.md` 完整承载 SiteMaster 10 条手搓铁律、22 条 Skill 调用规则、9 角色调度表、开发测试与项目记忆细则、开场零探测硬边界与完整 ASCII 开场白；`doctor.mjs` 补登第 7 份核心细则 `workflow-orchestration`；`FRAMEWORK-MANIFEST.json` 重算为 194 个受管文件、0 seeded 文件）。
- 2026-11-27: 完成 v1.2.0 三阶段审查全部 12 项问题修复（修正 `feedback-entry-template.md` 路径、清理 `cac-base.mjs package` 并加裸词误输 `exit 2` 守卫、`pre-commit-check` 与 `red-blue-pack` 接入外层父目录 `.git` 阻断与 `--relative -- .` 限定、`core.mjs` 空仓 `EMPTY_TREE_SHA` 暂存可见性、`findCacProjectRoot` 软链 `realpath` 二次查找与 `tmpKey` 排除、Windows `relToProject` 大小写不敏感与 `session-start` 豁免 `trackedSubdir`、`audit/README.md` 去虚构白名单并对齐三哨兵契约、4 处 LOW 细节收口及刷新 `FRAMEWORK-MANIFEST.json`）。
- 2026-11-27: 完成 v1.2.1 安装器、设置合并器与清单规则加固（新增 `unlinkSymlinkOrJunctionSafe`、`planInstall` 浅到深 `unlinkedDirs` 目录链接拆解与叶子符号链接防穿透、`retiredFiles` 退役托管文件自动清理及空父目录回收、获锁前 `.cac`/`.runtime` 软链拆解与阻碍文件 `.bak` 腾退、`runUninstall` 全链路 `lstat` 守卫、`settings-merge.mjs` 剥离 `cc-bridge.mjs` 并清理空事件键、全仓排除 `*.cac-link-new` 及刷新 `FRAMEWORK-MANIFEST.json`）。
- 2026-11-27: 修复 v1.2.1 三阶段审查关联问题 F-02/F-06/F-08/F-09/F-10（`setup.ps1` 裸词误输 `exit 2` 守卫；`doctor.mjs` 未显式传参时自动回退 `selfRoot` 寻根并补充 `~/.local/bin` 与 Windows 用户目录 `codeagent` 探测；`installer.mjs` 新增 10 分钟陈旧锁超时与残留目录锁接管、叶子物理目录冲突判定与 `.bak-<ts>` 重命名防 `EISDIR`、`runUninstall` 校验 `engine` 拒绝跨引擎误卸载并拆解残留 `.cac/{skills,agents}` 软链；`cac-base.mjs` 发布排除补入 `*.cac-link-new` 并重算 `FRAMEWORK-MANIFEST.json`）。
