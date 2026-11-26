<!-- 空白母版，严禁就地填写！请先复制到 .cac/.runtime/red-blue-review-<标识>.md 再写入本次三遍结果。 -->

# 红蓝对抗审查报告

- **审查范围**：`<BASE>..<HEAD>`
- **BASE / HEAD SHA**：`<base-sha>` / `<head-sha>`
- **日期**：`<YYYY-MM-DD>`

---

## 1. Blue 自证表（仅作红队靶子，不作放行依据）

| 改了什么（文件与意图） | 实际跑过的验证命令 | 客观证据落点（file:line / 输出摘要） |
|---|---|---|
| | | |

---

## 2. Red 对抗发现（每条须带复现路径或精确 file:line，否则无效）

### Lens A · correctness（逻辑 / 边界 / 并发 / 与 Spec 或设计详述矛盾）
| 问题描述 | 复现路径或 file:line | 严重度（HIGH/MEDIUM/LOW） |
|---|---|---|
| | | |

### Lens B · security（注入 / 越权 / 密钥泄露 / 破坏性操作无护栏）
| 问题描述 | 复现路径或 file:line | 严重度（HIGH/MEDIUM/LOW） |
|---|---|---|
| | | |

### Lens C · release（安装升级冲突 / 产物缺漏 / 私货混入 / 回退障碍）
| 问题描述 | 复现路径或 file:line | 严重度（HIGH/MEDIUM/LOW） |
|---|---|---|
| | | |

### Lens D · windows（PowerShell / 反斜杠路径 / CRLF / fileURLToPath / windowsHide）
| 问题描述 | 复现路径或 file:line | 严重度（HIGH/MEDIUM/LOW） |
|---|---|---|
| | | |

---

## 3. Judge 单一实证裁定（主 Agent 裁决，一个 Error Finding 不被干净 Lens 否决）

**最终结论**：`ACCEPT` | `FIX_REQUIRED` | `NEEDS_MORE_EVIDENCE`

### 逐条裁定记录
| Red Finding | 裁定（采信 / 驳回 / spec-suspect） | 实证依据与理由 |
|---|---|---|
| | | |

### 必修改造清单（FIX_REQUIRED 时填写）
| # | 须修内容 | file:line | 修复与复验要求 |
|---|---|---|---|
| 1 | | | |

### 待补证据（NEEDS_MORE_EVIDENCE 时填写）
- 缺失证据与补验方式：
