# cac-base

面向 **Windows PowerShell / WSL / Linux** 下 **CodeAgent CLI (`codeagent`)** 的原生独立全栈工程治理框架。

## 核心特性

- **目标项目根目录零文件入侵（多 AI 工具零冲突共存）**：基于 Windows 真机实证（无 `paths:` 头的 `.cac/rules/*.md` 在会话启动时由 `codeagent` 原生自动注入），主控宪法收纳于 `.cac/rules/AGENTS.md` 并纳入清单三路 SHA256 无损升级；安装后目标项目根目录仅生成 `.cac/` 隐藏目录（零根文件新增），与 `cc-base`、`agy-base`、Cursor、Codex 及项目自有的根 `AGENTS.md` 彻底零冲突共存。
- **全流程产品工程闭环（22 个原生 Skill + 9 个专职 Sub-Agent）**：覆盖需求澄清（`product-spec-builder`）、架构与质量属性（`arch-designer` / `dfx-designer`）、界面规范与原型（`design-brief-builder` / `design-maker`）、开发计划（`dev-planner`）、按 Task 风险三档推进的开发审查测试闭环（`dev-builder` / `code-review` / `test-builder` / `bug-fixer` / `red-blue-review`）以及受控发布收尾（`release-builder` / `branch-finisher`）。
- **三档强度（`fast / standard / strict`）与不可旁路安全地板**：内置 Bash + PowerShell 双壳硬化的密钥外泄闸（`secret-exfil-guard`）、危险命令闸（`dangerous-command-guard`）、发布前置闸（`release-gate`）与主从写码隔离闸（`no-direct-code-guard`）；修改 `.cac/` 家底自动升 `strict` 档。
- **活文档契约与人读工程文档（`readable-docs`）**：`project-status.mjs`、`progress-archive.mjs`、`plan-archive.mjs` 让 `Product-Spec.md`、`DEV-PLAN.md`、`progress.md` 始终保持精炼现行态；`readable-docs.mjs` 从数据库 DDL、业务源码与规格文档自动生成零丢字、带指纹核对的离线静态网页文档。
- **纯 Node >= 20 零依赖跨平台内核**：Windows PowerShell 无需安装 Git Bash、`jq` 或 Python 即可完整运行安装、升级、Hook 守门、`doctor` 体检与全量自测；安装器原生支持幂等重复安装、三路 SHA256 无损升级、崩溃死锁接管、悬空死链自愈，以及从 `cac-base-link` 链接版一键无损切回独立版 `cac-base`（`lstat` 级安全拆链、自动剥离 `cc-bridge.mjs` 桥接 Hook 并退役旧版受管文件，绝不穿透符号链接/Junction 污染同仓其他工具目录）。

## 快速安装

### Windows PowerShell
```powershell
pwsh -File .\setup.ps1 -Target D:\path\to\your-project
# 预览计划（零写入）：
pwsh -File .\setup.ps1 -Target D:\path\to\your-project -DryRun
# 按需加装大仓治理引擎与自测套件：
pwsh -File .\setup.ps1 -Target D:\path\to\your-project -WithHarness -WithTests
```

### WSL / Linux / macOS
```bash
./setup.sh /path/to/your-project
# 预览计划（零写入）：
./setup.sh --dry-run /path/to/your-project
# 按需加装大仓治理引擎与自测套件：
./setup.sh --with-harness --with-tests /path/to/your-project
```

## 常用维护命令

```bash
# 安装完整性与清单全量 SHA256 自检
node .cac/scripts/doctor.mjs

# 查看项目当前阶段与活文档体积/待归档状态
node .cac/scripts/project-status.mjs

# 查看或切换治理档位
node .cac/harness/harness.mjs tier status
node .cac/harness/harness.mjs tier set fast --hours 4 --reason "原型快速验证"
node .cac/harness/harness.mjs tier set standard

# 框架仓库自测与打包前全量门禁
npm test
npm run test:all
npm run pack-check
```

## 关键文档

- [.cac/rules/AGENTS.md](.cac/rules/AGENTS.md) — SiteMaster 主控宪法与全流程路由表（无 frontmatter 会话启动原生自动注入，下辖 7 份核心按需细则与 2 份大仓扩展细则）
- [ARCHITECTURE.md](ARCHITECTURE.md) — 框架分层架构说明
- [docs/HOST-CONTRACT.md](docs/HOST-CONTRACT.md) — Windows PowerShell `codeagent` 真机实证协议契约
