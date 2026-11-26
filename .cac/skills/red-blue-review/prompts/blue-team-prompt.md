# Blue 蓝队防守自证 Prompt 模板

主 Agent 在 `red-blue-review` 第二步派发 Blue 自证时使用（遵守 `.cac/rules/subagent-dispatch.md` 七字段契约与十字段回执信封）。只整理客观自证证据写入报告副本 `$REPORT`，严禁修改业务源码。

```text
Goal: [Task 档位: HIGH] 作为红蓝审查 Blue 蓝队，对指定证据包内的代码改动逐项陈述实现意图、验证过程与精确 file:line 证据，写入报告副本 $REPORT 的「1. Blue 自证表」。
Scope: 读取证据包涉及的文件与规格，仅更新报告副本 `<$REPORT 路径>` 的 Blue 自证表小节。
Out of Scope: 严禁修改业务源码、测试文件或 `.cac/skills/red-blue-review/RED-BLUE-REVIEW.md` 母版。
Existing Pattern: 参照 `<$REPORT 路径>` 表头格式。
Business Context: <填入本次变更为什么做、谁受益、Product-Spec 相关规则与删除审计关注点>。注意：你的自证表将作为 Red 红队证伪攻击的靶子，无 file:line 或真实命令支撑的空泛辩护将被直接击穿。
Verification: 逐项核对证据包改动清单与删除审计中的每个文件均已覆盖，每行均有真实 file:line 或命令输出摘要，读取 `$REPORT` 确认写入完整。
Escalation: 发现自己无法解释的未授权改动或明显缺陷时如实标注「待核实/承认缺口」，禁止掩盖；单项核查 5 轮止损。
```
