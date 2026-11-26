---
name: dev-plan-template
description: DEV-PLAN.md 标准输出模板（锚点与格式严格对齐 node .cac/scripts/plan-lint.mjs 与 plan-archive.mjs）。
---

# DEV-PLAN 输出模板

文件名：`DEV-PLAN.md`（放项目根目录）。
- **`plan-lint.mjs` 强制核查锚点（字面不可更改）**：
  1. 至少 1 个顶层阶段标题 `## Phase N: 阶段名称`（`N` 为正整数）；
  2. 每个 Phase 内必齐五个加粗字段：`**交付内容**`、`**验证的假设**`、`**关键文件**`、`**Task 清单**`、`**验收标准**`；
  3. 每个 Phase 内至少 1 条任务行 `- **Task N.M：任务标题**`；
  4. 严禁未完成占位词（`TBD` / `TODO` / `待补充` / `待确定` / `类似 Task` / `类似 Phase` / `按需调整` / `做相应修改` / `implement later`）；
  5. 若 `Product-Spec.md` 含 `[REQ-...]` 声明，每条 REQ 要么出现在某条 `- **Task N.M：...**` 行（或 `## 已归档 Phase` 指针行的 `（REQ：…）` 后缀），要么在 `## 范围外（本次不计划）` 下带明确原因声明。

```markdown
# Development Plan — [项目名称]

> 记录项目分阶段开发计划、当前推进状态与验收结论。

## 开工前置

- [列出押后待定项当前采用的默认做法、待实证的核心推断；若无前置待定项可整节省略]

---

## Phase 1: [核心价值流程名称]

**交付内容**：
- [动词开头，描述用户或调用方能完成的可观察业务结果]

**验证的假设**：
- [无；或写明 Spec 中哪条 `[推断]`/`[默认]` 或哪项技术未知 → 本 Phase 用什么客观现象证明成立]

**关键文件**：
- `src/path/to/module.ts` — [职责说明；若多 Task 触及同一文件须标明唯一写入 owner Task]

**Task 清单**：
- **Task 1.1：[明确改动标题（关联 REQ-CORE-001）]** — 修改/创建 `src/path/to/module.ts`（具体函数/数据结构）+ 验证命令 `npm test -- tests/module.test.ts`
  - Business Context：[为谁解决什么问题；Spec 规则与例外摘要；1 组区分对错的输入→期望输出样例——供主 Agent 直接抄入七字段派单]
  - 依赖类型：[功能前置：Task X.Y / 无；验证前置：隔离测试库等 / 无]
  - 证据产生者：[LOW 档：`implementer` 自检；MEDIUM 档：`implementer` + `code-reviewer` Stage 0+1；HIGH 档：`implementer` + `code-reviewer` 全三 Stage + 独立 `tester`]

**验收标准**：
- [编译/语法检查 0 错误 + 测试运行器全绿 + 核心流程冒烟可观察结果]

---

## 范围外（本次不计划）

<!-- 仅当 Spec 有 REQ 编号未纳入本期 Task 时保留本节，每条必须写明原因与回归条件；无则整节删除 -->
- REQ-AUX-002：已押后——二期报表能力，待一期核心单据流转稳定后排入下一版计划

---

## 技术栈

| 层级 | 技术选型 | 版本 | 用途说明 |
|------|----------|------|----------|
| 运行时/框架 | [名称] | [版本] | [用途] |

## 数据库表（如有，无则删除）

| 表名 | 首次创建 Phase | 用途与单一写入模块 |
|------|----------------|--------------------|
| `orders` | Phase 1 | [用途说明] |

## 开发规则

- 按 Task 定档（LOW / MEDIUM / HIGH）执行编码、独立审查与独立测试闭环
- 每个 Phase 收尾必过四步走：全 Phase Code Review → 独立测试完整性（含 `design-trace.mjs`）→ 全量编译静态检查 → 功能冒烟，结论以 `PASS / CONCERNS / FAIL / WAIVED` 写回 Phase 标题
- 若启用人读文档（存在 `docs/readable-src/config.json`），触及表/模块边界的 Task 随单运行 `node .cac/scripts/readable-docs.mjs build` 并确保 `check` 报「不一致 0 条」
- Commit 格式：`phase-N: 简要描述`
```
