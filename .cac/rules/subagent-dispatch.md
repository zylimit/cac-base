---
paths:
  - ".cac/agents/**"
---

# Sub-Agent 派发与回执验收契约（subagent-dispatch）

> 本文件由 `AGENTS.md` 下沉；派发任何 Sub-Agent 或验收其回执前必须完整 `Read` 本文件。

## 1. 派发形态与隔离原则

1. **单层扁平直派（默认）**：使用宿主 `Agent` 工具（`subagent_type: "<角色名>"`）启动专职子代理。每个 Task 必须用 **fresh 实例**，严禁跨 Task 复用旧实例，防止错误假设跨任务传染。Sub-Agent 严禁再调用 `Agent` 拉下级子代理。
2. **多视角并行扇出（仅限只读广度，须用户 opt-in）**：
   - 判据轴 = **单元决策是否需要共享契约自洽**。跨 Task 编码必须**串行**；代码审查多维度、独立模块写测、代码库广度调研可并行派多个 fresh 只读/测试子代理，由主 Agent 收齐证据统一裁定。
   - 多子代理消耗显著更多 Token，达到并行扇出规模（≥3 路）时必须先向用户提议、确认后再跑。
3. **记录类角色的显式上下文传递**：
   - `codeagent` 无会话上下文克隆（`fork`），因此派发 `progress-recorder`、`feedback-observer`、`domain-recorder` 时，主 Agent 必须在派单中**原样摘录用户原话/本轮关键决策与涉及的文件路径**，禁止模糊概括导致失真。
4. **写测独立铁律**：`tester` 必须是与编写该段代码的 `implementer` 不同的 fresh 实例；断言只从 `Product-Spec.md`、`DEV-PLAN.md`、`docs/design/*.md` 推导，绝不照抄实现源码。

## 2. 派单包七字段（缺一不可）

每次调用 `Agent` 的 `prompt` 必须包含以下七个字段：

1. **Goal**：完成后必须成立的可验收结果（首行标明 `[Task 档位: LOW | MEDIUM | HIGH]`）。
2. **Scope**：允许读取和修改的文件路径、模块边界。
3. **Out of Scope**：明确禁止顺手触碰的文件、重构或额外需求。
4. **Existing Pattern**：应遵循的现有实现入口、类型、命名约定（传**文件路径**让子代理自己 `Read`，不要把大段历史总结塞进 prompt）。
5. **Business Context**（**编码 / 审查 / 测试类严禁写 `N/A`**）：
   - 为什么做、谁受益；
   - `Product-Spec.md`「规则与例外」相关条目；
   - `progress.md` Pinned / Decisions 适用条目（带日期）与相关 `.cac/feedback/` 教训；
   - 若有 `domain/`，抄入匹配的领域口径条目；
   - 若触及 `docs/design/*.md` 代码范围，抄入对应规则编号与一句话判据。
6. **Verification**：
   - 最小客观核查命令与期望退出码；
   - LOW/MEDIUM 单子预期 ≤8 次工具调用，HIGH 单子写明工具调用预算；
   - 改受保护业务路径一律走 `Edit`/`Write` 工具，**严禁在 `Bash` 中用重定向、`tee`、`sed -i`、脚本写业务源码绕闸**；
   - 临时文件必须在系统临时目录下自建独立子目录，收尾只删该子目录，严禁通配符删共用目录；
   - 若有 `docs/readable-src/config.json` 且触及表/代码结构，附上 `node .cac/scripts/readable-docs.mjs build` + `check` 报 0 条 + 派单前 `structure` 基线。
7. **Escalation**：
   - 遇到 Spec 歧义、超出 Scope、需破坏性权限时立即返回 `NEEDS_CONTEXT` 或 `BLOCKED`；
   - **单项核查 5 轮止损铁律**：截图、起服务、外部探针等单项核查最多试 **5 轮工具调用**，未果即跳过并如实列入回执 `Not verified`，立即交付主体报告，绝不空耗轮次。

## 3. 统一十字段回执信封

所有专职 Sub-Agent 最终回复必须以如下信封开头（`strict` 档下 `subagent-bookkeeping.mjs` 会校验执行类角色的 `Status` 与 `Evidence`）：

```text
Status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
Changed: 实际新增/修改的文件清单（只读角色写 None）
Verified: 实际跑过且拿到真实输出与退出码的核查项
Not verified: 未执行或因环境受限跳过的核查项（无则写 None）
Business assumptions: Spec 未写明而自行补充的假设（无则写 None）
Design rules: 触及 docs/design/ 时写改了/新增哪几条规则或「规则未动」（不涉及写 None）
Counter-examples: 代码符合 Spec 但违背真实业务的反例（四段式：情境→Spec→业务→依据；无则写 None）
Domain findings: 本次实测撞出的领域现象线索+客观证据（只报线索不报定论；无则写 None）
Needs review by: code-reviewer | tester | main-agent | None
Evidence: 关键命令、退出码、文件路径与核心输出摘要（不贴超长原始日志）
```

## 4. 主 Agent 验收与升级阶梯

1. **对着 diff 与运行器输出判，不对着子代理自述判**。
2. **新建文件验证禁令**：尚未 `git add` 的新建文件，`git diff` 输出为空且退出码为 `0`（与未改动完全一样）！验收新建文件必须用 `git status --short`（认 `??`）+ 行数统计 + 内容锚点。
3. **`BLOCKED / NEEDS_CONTEXT` 升级阶梯（严禁同 prompt 原样重发）**：
   - 第 1 阶：补齐缺失上下文/文件路径后派新的 fresh 实例；
   - 第 2 阶：任务过大则砍小范围重新切分再派；
   - 第 3 阶：属疑难缺陷则转入 `bug-fixer` 先取证立假设；
   - 第 4 阶：三步仍不通，携带证据上报用户拍板。
   每次重派必须至少改变一项（上下文 / 范围 / 角色）。
