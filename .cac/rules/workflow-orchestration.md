---
paths:
  - ".cac/agents/**"
  - ".cac/skills/code-review/**"
---

本文件由 `.cac/rules/AGENTS.md` 下沉；主控命中指针时必须完整读取本文件再行动，不得凭指针行猜测内容。（frontmatter 的 `paths` 声明本细则作用域并避免 `codeagent` 会话启动时全量自动灌入浪费上下文；提议或执行并行多路编排前必须按 `.cac/rules/AGENTS.md` 前置指针显式 `Read` 本文件。）

    **并行扇出编排模式（规模化 fan-out 的上层；codeagent 原生并行 Agent 承载）**：
    `codeagent` 无动态工作流脚本（如 `code-review-fanout.js`），规模化并行扇出由**主 Agent 在同一轮并发调用多次 `Agent` 工具**（如并行发起多路 `Agent(subagent_type: "code-reviewer")` / `"tester"` / `"researcher"`）并在主会话收齐结果汇总裁定。**并行扇出不取代单次直派，是它在「多个无依赖单位」时的规模化上层。**
    - **判据轴 = 这些单元的决策要不要自洽**（不是"任务多少"）：
      - **要自洽（共享上下文/契约）** → 编码这类 → **别用并行扇出**，串行直派。
      - **不要自洽（只读/可独立汇总）** → 审查维度、测试目标、代码库探索、研究广度 → **并行 fan-out 甜区**。
    - **三个推荐场景**：① **code-review 多维 + 对抗验证**——主 Agent 按多视角 lens（correctness / security / repro / windows）并行发起多次 `Agent(subagent_type: "code-reviewer")` 各自独立深挖与复现验证，收齐证据句柄后由主 Agent 在主会话统一汇总裁定，以视角多样性补足单审查员盲区（须用户 opt-in）。② **test-builder 批量写测**——并行对多个无耦合高价值逻辑各派独立 fresh `tester`（天然独立于 implementer 作者）。③ **代码库探索/研究**——并行派多个 `researcher` 做 breadth-first 普查。
    - **集成点 `subagent_type`**：并行 `Agent` 调用直接从同一 `.cac/agents/` 注册表复用框架现有专职角色（`code-reviewer` / `tester` / `implementer` / `researcher`，带各自角色约束与技能指引）。**编排升维，工人不变**，隔离 / 职责边界 / 写测独立全保住。
    - **三铁律不动**：① **主 Agent 仍是唯一编排者**——并行扇出由主 Agent 统一发起和汇聚，严禁 Sub-Agent 套娃自拉 Sub-Agent。② **验收判断权留主 Agent**——各路子代理按十字段回执信封回传「结论 + 证据句柄」，主 Agent 凭客观证据定夺（= 翻证据外包 / 下判断自留）。③ 写测独立性靠每次独立 fresh `Agent` 实例 + 不同角色（`tester` ≠ `implementer`）。
    - **成本闸门（硬约束）**：多 Agent 耗 token **~15x**（实证量级），只对高价值任务划算。并行扇出 **必须用户显式 opt-in**，不静默触发——达到 fan-out 规模时主 Agent 先提议、用户确认再跑。worktree 隔离有额外启动与磁盘成本，只在确需并行写隔离时用；单 Phase 仅 1-2 个单位时不划算，直接单次 `Agent` 直派。
    - **异步形态**：`Agent` 支持后台并发运行（`run_in_background`）并在完成时自动回传通知。编排上可以先派后收，但**验收必须等结果到手**——"已派发"不是"已完成"；并行 fan-out 收齐所有单元结果后再进汇总判断。
    - **worktree 操作纪律**：确需 worktree 隔离（如 `codeagent --worktree` 或手工管理 worktree）时的三条铁律：① Step0 先检测当前是否已在 worktree 中，已在则不再嵌套创建（注意排除 submodule 误判，别把 submodule 当成 worktree）；② 目录优先级——已声明目录 > 现存 `.cac/worktrees` / `.worktrees` > 配置指定目录 > 默认，选定后须 `git check-ignore` 确认该 worktree 路径不入版本控制（防把 worktree 提交进仓库）；③ 优先用宿主原生 `--worktree` 隔离能力，没有再退回 git 命令。
