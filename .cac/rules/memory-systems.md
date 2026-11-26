---
paths:
  - ".cac/feedback/**"
  - ".cac/agent-memory/**"
---

# 多套记忆系统边界规范（memory-systems）

> 本文件由 `AGENTS.md` 下沉；写 feedback、维护 `progress.md`、动 `.cac/agent-memory/` 或判断知识归属前必须完整 `Read` 本文件。

## 五类记忆各司其职（严禁混装）

| 记忆载体 | 存什么 | 跟谁走 | 谁维护 | 硬边界 |
|---|---|---|---|---|
| **`progress.md`** | 项目决策（Decisions 三要素）、硬约束（Pinned ≤15 条）、当前断点（仅留 1 条）、TODO、近期完成（Done） | 跟当前仓库走 | `progress-recorder`（归档由 `progress-archive.mjs` 跑） | 决策/约束/完成**只认 `progress.md`**，不因任何其他 memory 豁免三文件同步 |
| **`.cac/feedback/`** | 用户对 **AI 工作方法** 的纠正、偏好与流程教训（含 `scope / exceptions / supersedes / applied_to`） | 跟 AI 框架进化走 | `feedback-observer` 写入，`evolution-runner` 聚类毕业 | 每条必有合规 frontmatter 并登记 `.cac/feedback/FEEDBACK-INDEX.md` |
| **`domain/`** | **这个业务领域里事情是怎么算的**（跨仓库仍成立的客观口径，七栏结构） | 跟业务领域走 | 主 Agent 裁定后派 `domain-recorder` | 无三类硬依据（实测/外网标准/内部规范）拒收；不存项目临时范围限制 |
| **`docs/design/`** | 本仓库复杂模块如何把规则落成代码、常量与测试（`<模块名>-设计.md`） | 跟本仓库模块走 | 主 Agent / `implementer`，`design-trace.mjs` 核对 | 代码改则设计详述必同步（`design-detail-sync` 守护） |
| **`.cac/agent-memory/<role>/MEMORY.md`** | `code-reviewer` / `tester` 的项目战术笔记（本项目高发缺陷模式、flaky 区、测试夹具坑） | 跟本机/项目角色走 | 角色启动时显式 `Read`、收工时精炼更新 | **单文件封顶 5KB，每角色总计封顶 50KB**；超限即搬入 `docs/agent-notes/<role>/` 并在 `MEMORY.md` 留一行指针 |

## 用户纠正的分流判据

1. **当前项目业务事实/取舍**（「这个接口用 IP 不用名称」）→ 当场改当前产物 + 进 `progress.md` Decisions（若属跨项目通用领域算法，再判是否收进 `domain/`）。
2. **AI 工作方式/沟通/验证纪律**（「以后发版前先自查四项再让我敲命令」）→ 当场改当前做法 + 派 `feedback-observer` 记入 `.cac/feedback/`（用户明说「以后都这样」时顺手更新对应 rule/skill）+ 回显「这次纠正改了 X 文件 Y 段」。
3. **宿主原生本地 auto-memory**（如 `~/.cac/` 下自动记忆）：只许存机器本地琐碎线索，绝不能替代 `progress.md` 或 `.cac/feedback/`。
