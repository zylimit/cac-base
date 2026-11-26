---
paths:
  - ".cac/harness/**"
---

# 大仓治理引擎规范（harness-large-repo）

> 本文件由 `AGENTS.md` 下沉，随 `--with-harness`（Windows `-WithHarness`）装入 `.cac/rules/harness-large-repo.md`；主控触及大仓治理或 `.cac/harness/module-catalog.json` 存在时必须先完整 `Read` 本文件再行动。

## 1. 启用条件（两件事齐备才启用）

1. 先运行 `./setup.sh --with-harness`（Windows PowerShell：`pwsh -File setup.ps1 -WithHarness`）安装 `.cac/harness/ext/` 扩展包与大仓规则；
2. 再放置合规的 `.cac/harness/module-catalog.json`（可用 `node .cac/harness/harness.mjs init` 推断草案，人工审定 `riskTier`、`attributes`、`dependsOn`、`forbiddenDependencies` 后 `--apply` 落盘并跑 `catalog-lint` 校验）。
3. **默认透明**：无 `module-catalog.json` 时大仓定向闸默认关闭，小项目零负担；若放置了 `module-catalog.json` 却未装 `.cac/harness/ext/`，`doctor.mjs` 直接判红点名自相矛盾，大仓子命令统一返回 `rc 3`（`degraded`）绝不假绿。

## 2. `module-catalog.json` 核心结构与全量归类

- **顶层字段**：`version`（必填 `1`）、`modules[]`（必填）、`global[]`（改动触发全模块保守 fanout，如 `package.json`/`tsconfig.json`）、`ignored[]`（排除路径，如 `README.md`/`docs/**`）、`riskChecks{low,medium,high}`、`checks{id:{command,class?,allowFastSkip?,attributes?}}`、`layers[]`（由外向内排列，内层禁止反向依赖外层）、`contextPack`、`budget`、`review`、`maxTrackedPaths`。
- **路径分类优先级**：`module > ignored > global > unmapped`；多模块命中取 `specificity`（非通配字面长度）最高者。
- **`catalog-lint` 硬校验**：拦截 `CATCH_ALL`（`**/*` 等吞整树通配）、`UNMAPPED`（未归属 tracked 文件）、`OVERLAP`（多模块重叠认领）、`DANGLING_DEP`、`UNKNOWN_ATTRIBUTE`、`UNKNOWN_TIER`、`UNJUSTIFIED_TIER`（`none|minimal` 必须附书面 `reason`）、`SELF_FORBIDDEN`、`FORBIDDEN_DECLARED`、`UNKNOWN_LAYER`。
- **保守扩张铁律**：命中 `unmapped`、`global`、非 git 或清单截断时，一律全模块 fanout 并标 `degraded: true`（宁可全跑，绝不漏测）。

## 3. 四十项子命令速查与退出码契约

统一入口：`node .cac/harness/harness.mjs <subcommand> [flags]`（stdout 单行 JSON，仓库内路径统一正斜杠相对路径，不外泄本机绝对路径）。
标准退出码：`0`=通过/干净，`1`=静态违规/断裂，`2`=门禁阻断/用法错误（未知 `--flag` 一律 `rc 2`），`3`=降级未验（永不当 `0`），`4`=证据过期或回执损坏（`STALE`）。

- **核心常驻（4 项，免装 `ext` 可跑）**：`doctor`、`diff-hash`、`selftest`、`tier <status|set|explain|validate>`。
- **目录与依赖图（5 项）**：`init [--apply]`、`catalog-lint`、`impact`、`arch-check [--record]`（递归展开目录源码文件解析跨模块依赖，越禁边零容忍）、`arch-trend [--gate]`（per-edge 债务棘轮，旧债只减不增）、`cochange [--gate]`。
- **质量门、豁免与证据链（9 项）**：`context-pack`、`verify`（四态聚合 + 质量属性覆盖门，空计划=`BLOCKED` 全跳过=`rc 3`）、`gate`（落盘原始日志至 `.cac/harness/evidence/` 并追加哈希链账本 `.cac/harness/state/ledger.jsonl`）、`ledger`、`receipt <write|verify>`、`waiver <list|check|create>`、`attributes`、`gate-audit`（审 catalog check 介入史，与审 hook 闸的 `.cac/scripts/gate-audit.mjs` 互补）、`retention [--apply]`、`risk`。
- **任务、规格与静态 DoD（6 项）**：`task <start|status|complete>`（七字段信封 + 五重完成硬闸）、`budget`、`spec-lint`、`trace`、`spec`、`dod`（串联 `catalog-lint`/`spec-lint`/`trace`/`attributes`/`arch-check`/`adr-check`/`fitness --all`/`ledger`/`arch-trend --gate`/`rules-audit`/`skills-lint`/`agents-md-lint`/`tier validate`）。
- **扫描、评审、记忆与发版装配（14 项）**：`fitness [--all]`、`adapters <list|add>`、`adr-check`、`review <start|blue|lens|verdict|backlog|status|team>`、`review-pack`、`authorship <record|show>`（联动 `record-authorship.mjs`，`review verdict` 自动拦截作者自审 `ACCEPT`）、`invariants`（联动 `postcompact-reinject.mjs`）、`recap`、`archive [--apply]`、`sync-check [--staged]`、`rules-audit`、`skills-lint`、`agents-md-lint`（`high`/`critical` 模块目录必须携带含 Purpose/Boundaries/Invariants/Verification 四节的 `AGENTS.md`）、`release`（只读发版就绪八项装配，输出恒带 `trustBoundary` 四个 `false` 声明）。
