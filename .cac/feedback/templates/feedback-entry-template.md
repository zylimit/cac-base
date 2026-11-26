---
type: process                  # process | code-quality | safety | preference | skill-eval（必填）
description: "[一句话摘要——用于索引快速扫描]"
created: YYYY-MM-DD
updated: YYYY-MM-DD
occurrences: 1                 # 同主题再次触发时递增（必填）
graduated: false               # 晋升进 .cac/rules/AGENTS.md / rules / skills 后改 true（必填）
skipped: false                 # 经用户确认跳过或暂不成文时改 true
origin: local                  # 本项目自产填 local；collect-feedback.mjs 汇总下游时填下游目录名
source_skill: "[skill-name 或 N/A]"
scope: "[适用范围——哪些阶段 / 角色 / 项目类型适用]"
exceptions: "[例外——哪些情况不适用，防误伤；没有写 none]"
supersedes: "[取代或修正哪条旧规则 / 旧 feedback 文件名；没有写 none]"
applied_to: "[本次纠正已落到哪里——文件:段落 / progress.md Decisions 日期 / 派单包；未落地写 pending]"
scores:                        # 可选——仅 Skill 效能评估时填写
  accuracy: 4
  coverage: 4
  efficiency: 4
  satisfaction: 4
  evidence: "[每个分数的一句话客观依据]"
---

# [问题标题]

**问题描述**：[AI 做了什么、用户如何纠正，尽量保留用户原话摘录]

**触发场景**：[在什么阶段、什么任务上下文中容易复发]

**正确做法**：[学到了什么、后续遇到同类场景应当具体怎么做]

**适用范围与例外**：[与 frontmatter 一致并展开说明：何时严格执行、何时豁免]

**本次落地**：[本次纠正已实际修改了哪个文件哪一段或哪条决策，供主 Agent 向用户回显「这次纠正改了…」；多次触发时按日期追加新证据]
