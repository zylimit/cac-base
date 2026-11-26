---
paths:
  - ".cac/harness/**"
---

# 质量属性分档与证据门禁规范（quality-attributes）

> 本文件由 `.cac/rules/AGENTS.md` 下沉，随 `--with-harness`（Windows `-WithHarness`）装入 `.cac/rules/quality-attributes.md`；主控声明模块 `attributes`、配置 `checks`、`waiver` 或解读 `verify`/`gate`/`fitness` 时必须先完整 `Read` 本文件。

## 1. 八项质量属性与受保护铁律

取自 ISO/IEC 25010 可在仓库侧持有客观证据的八个维度：
- **受保护三属性（无旁路铁律）**：
  - `security`：网络与信息安全（鉴权、注入面、依赖漏洞、密钥防泄漏、传输加密 `https://`/`wss://`、SBOM）。
  - `safety`：功能安全（危险指令拦截、失效保护、高危模块欠账挂单纪律）。
  - `privacy`：隐私与数据合规（PII 最小采集、日志脱敏、运行态按龄销毁合规）。
  **硬红线**：凡 `class` 或 `attributes[]` 涉及 `security / safety / privacy` 的检查，在 `fast` 档（即使标了 `allowFastSkip: true`）、`waiver`（无论按 `checkId` 还是 `attribute:<mod>/<attr>`）以及 `review backlog` 中**一律禁止跳过、豁免或挂账**！
- **其余五项工程属性**：`resilience`（韧性：有界重试退避、熔断、进程守护）、`reliability`（可靠性：不静默吞错、回归与变异测试、契约测试）、`availability`（可用性）、`performance`（性能）、`maintainability`（可维护性）。

## 2. 六档强度矩阵

| 档位 | 门禁执法 | 语义与约束 |
|---|---|---|
| `critical` | `block`（阻断） | 缺 PASS 认领证据即 `BLOCKED_BY_ATTRIBUTES`（`rc 2`），**任何属性均永不可豁免** |
| `high` | `block`（阻断） | 缺证据阻断；仅非受保护属性可用 `attribute:<module>/<attr>` 结构化 waiver 限时推迟 |
| `medium` | `warn`（告警） | 计入缺口报告，不阻断门禁 |
| `low` | `record`（记录） | 记录备查，激活对应 `review` 评审透镜 |
| `minimal` | `listed`（列示） | 必填 `{ "tier": "minimal", "reason": "..." }`，否则 `catalog-lint` 报 `UNJUSTIFIED_TIER` |
| `none` | `opted-out`（退出） | 必填 `{ "tier": "none", "reason": "..." }`，留痕声明不适用 |

## 3. 覆盖判定三原则（`verify` / `gate` / `attributes`）

1. **反证压过佐证**：模块 `verification` 列表中认领某属性的 check 必须**至少一个 `PASS` 且零个 `FAIL`/`BLOCKED`** 才算 `covered: true`。
2. **声明未接线 = 可见缺口**：声明了 `critical`/`high` 却无任何 check 在 `attributes[]` 中认领该属性，`attributes` 静态审计报 `rc 1`，`verify`/`gate` 报 `BLOCKED_BY_ATTRIBUTES`（`rc 2`），绝不静默算绿。
3. **`SKIPPED` 不产生证据**：被 `fast` 或 `waiver` 跳过的 check 既不提供正向覆盖，也不消除 `critical`/`high` 属性本身的证据义务。

## 4. 内置零依赖 `fitness` 规则与外部 `adapters`

- **内置 `fitness`（`node .cac/harness/harness.mjs fitness [--all]`）**：
  - `no-secret-literal`（`security`，`error`）：硬编码密钥、Token、私钥头。
  - `no-pii-in-logs`（`privacy`，`error`）：日志打印 email / ssn / 卡号 / 手机号 / 证件号。
  - `no-insecure-transport`（`security`，`warning`，`minimumTier: high`）：高安全模块中的非本地明文 `http://` 或 `ws://`（排除 `localhost`/`127.0.0.1` 与标准命名空间，**绝不误报 `https://` / `wss://`**）。
  - `no-silent-failure`（`reliability`，`error`）：空 `catch {}` 或 `except: pass`。
  - `no-unbounded-retry`（`resilience`，`warning`）：无上限死循环重试。
  - `no-unreferenced-deferral`（`safety`，`warning`，`minimumTier: high`）：高安全模块未关联单号的待办标记。
  支持行内 `harness-fitness:ignore` 单点压制与 `.cac/harness/fitness-rules.json` 扩展。
- **外部工具接线（`adapters list` / `adapters add <id>`）**：内置 `sast-semgrep`、`sca-osv-scanner`、`scan-trivy`、`secrets-gitleaks`、`sbom-syft`、`pii-presidio`、`mutation-stryker`、`contract-schemathesis`、`load-k6`、`iac-checkov`、`slo-openslo` 映射表；工具未安装时运行态报 `BLOCKED`（`command-missing`），绝不假绿。
