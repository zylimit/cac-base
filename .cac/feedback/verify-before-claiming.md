---
type: process
description: "涉及异构宿主/CLI/IDE 规则或目录约定，必须先调搜索引擎查官方文档并跑真机探针实测，严禁凭单一宿主经验类推臆断"
created: 2026-11-26
updated: 2026-11-26
occurrences: 1
graduated: true
skipped: false
origin: local
source_skill: "N/A"
scope: "主 Agent 与所有 Sub-Agent 在涉及异构宿主（CodeAgent / Antigravity / Cursor / Codex 等）、CLI 参数、规则加载路径或目录约定时的判断、回答与架构决策"
exceptions: "none"
supersedes: "none"
applied_to: ".cac/rules/AGENTS.md:[十条核心铁律] 第 3 条 & progress.md:Decisions (2026-11-26)"
---

# 异构宿主与 CLI 规则必先查官方文档并跑真机探针实测

**问题描述**：分析多套脚手架（`cac-base` / `agy-base` 等）在根目录规则文件（如 `AGENTS.md`）与隐藏规则目录上的加载行为时，AI 未第一时间检索各宿主官方文档与实测证据，而是凭单一宿主经验做跨宿主类推与印象化推断；经用户当场纠正，要求凡涉及外部工具、异构宿主与 CLI 约定必须先调搜索引擎查证官方文档并结合真机探针实测说话。

**触发场景**：对比多套 AI 编程宿主/IDE/CLI 的配置文件加载优先级、规则注入时机、环境变量名、Hook I/O 结构或命令行开关时，极易将 A 宿主的机制直接套用到 B 宿主。

**正确做法**：
1. 凡涉及异构宿主/CLI/IDE 的规则加载、目录约定、配置字段或参数行为，先调搜索引擎查阅对应工具官方文档/源码说明；
2. 本地或沙箱具备运行条件时，构造最小真机探针（如禁工具沙箱暗号注入、Hook 事件落盘）实测确认；
3. 未经官方文档与实测双重确认的跨宿主细节一律显式标注 `[待定]`，严禁当作 `[确认]` 事实下结论或写进交付物。

**适用范围与例外**：适用于主 Agent 与所有 Sub-Agent 的调研、问答、架构设计与代码审查环节；无例外（`none`）。

**本次落地**：2026-11-26 已在 `.cac/rules/AGENTS.md` `[十条核心铁律]` 第 3 条（「查证后再结论」）补强硬性要求：「涉及异构宿主/CLI/IDE 规则或目录约定，必须先调搜索引擎查官方文档并跑真机探针实测，严禁凭单一宿主经验类推臆断。」并同步记入 `progress.md` Decisions。
