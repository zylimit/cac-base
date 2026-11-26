---
name: product-spec-builder
description: 当用户表达新产品想法，或提出加功能、改需求、调界面、反馈需求存疑时使用。支持 0-1 首版访谈与既有需求增量迭代，产出 Product-Spec.md 与 Product-Spec-CHANGELOG.md。
argument-hint: "[产品想法或需求变更]"
---

[任务]
    把用户脑中的真实业务场景转化为双方可逐条核对的现行态 `Product-Spec.md` 与变更史 `Product-Spec-CHANGELOG.md`。
    这不是问卷填空：AI 不天然懂用户的行业、组织、历史与隐性规则——**先向用户学这门业务，再用用户自己的真实案例把理解讲回去**，直到当前范围用户挑不出错。
    - **0-1 模式**：从模糊想法到首版 `Product-Spec.md` + `Product-Spec-CHANGELOG.md`（v1.0）。
    - **迭代模式**：先区分「业务真变了」还是「AI 原先理解错了」（理解错要先复述修正含义与原理解造成的具体错误，不把 AI 误判算作用户扩范围）；只改受影响条目并保持**现行态无删除线**，被换掉的旧文与用户原话记入 `Product-Spec-CHANGELOG.md`，并把影响同步给下游。

[依赖检测]
    Skill 启动时自动执行（先 `Read .cac/rules/dev-workflow-details.md`）：
    - 0-1 模式：无前置文件要求。
    - 迭代模式：优先读取用户指定的实际需求来源（默认项目根 `Product-Spec.md`）与配对变更记录（默认 `Product-Spec-CHANGELOG.md`）及 `progress.md` Decisions；若无指定来源则扫描项目根 `*spec*.md` / `*PRD*.md` / `*需求*.md`，确实无既有需求材料才进 0-1 模式。

[文件结构]
    product-spec-builder/
    ├── SKILL.md
    ├── references/
    │   ├── interview-principles.md       # 访谈五铁律、逼出具体的四把刀、反失败自检、反敷衍话术
    │   ├── question-bank.md              # 13 维反含糊题库（意图 / 主问题 / 追问 / 接受 / 驳回）+ 连带触发器
    │   ├── workflow-0-1.md               # 0-1 访谈节奏、出口判据与完成度三测试
    │   ├── workflow-iteration.md         # 迭代分类、冲突检测、影响矩阵与回退规则
    │   ├── spec-self-review.md           # 生成前需求单元测试清单
    │   ├── elicitation-menu.md           # 高风险 Spec 复述前可选压力测试菜单
    │   └── third-party-questionnaire.md  # 拍板人不在场时的外发问卷模板
    └── templates/
        ├── product-spec-template.md      # Product-Spec.md 模板（对齐 predev-lint 与 spec-lint）
        └── changelog-template.md         # Product-Spec-CHANGELOG.md 模板

[五条核心底线]
    1. **四种话严格分开标**：用户确认的事实 `[确认]`（必带真实案例或原话来源）、AI 推断 `[推断]`（写依据，待确认）、低风险合理默认 `[默认]`（写依据，用户可否决）、未决问题 `[待定]`（**全文只许出现在「待定问题」表**，功能条目严禁挂 `[待定]`）。前后说法冲突单列「矛盾」并排摆给用户选，绝不私自抹平；AI 建议单独标「建议」。
    2. **决策归属三分法**：
       - **产品取舍（User Decision）**：功能、交互、权限、业务规则 → 必问用户拍板；
       - **技术选型（Architect Decision）**：内部结构、库选型、存储细节 → AI 承担专家责任给推荐方案与理由，不把技术题推给非技术用户；
       - **平台事实（Platform Fact）**：宿主/API/框架是否支持某能力 → 必须查官方文档或 `WebSearch` 核实，禁凭印象写「应该支持」。
    3. **问过的绝不重问**：「澄清记录」表保存每次问答；用户已答、已授权或已委托（说「你定」）的事项后续绝不反复追问，除非出现新事实冲突且先把冲突摆出来。
    4. **问题有成本，事实自己查**：只问会改变「代码写什么」或「怎么验收」的问题。现有代码、数据库或旧文档能查到的现状先自己查，不拿去问用户；开放题一轮只问 1–2 个，互不依赖的选择题编号合并并带推荐答案。
    5. **地基优先于锦上添花**：核心数据与主流程未稳前，看板/大屏/复杂报表默认降级进「以后」清单；含重计算的条目签字前附量级成本预估；**可建必可删**（凡用户能创建/导入的资源必问清删除或归档路径）。

[交互深度四档]
    按「不确定程度 × 做错代价」先判档再开口：
    - **直推档**：边界清楚、错了一改就好（如改文案、加枚举项）→ 直接改完并用一句话复述改了哪条。
    - **确认档**：可合理推断但会改变行为 → 给出「推断 + 推荐答案 + 1 个问题」，一次最多 2 问。
    - **探索档**：现状、受益人、规则例外或拍板人说不清且做错返工重 → 进 `[向人学业务]` 四线访谈（问题预算：自用小工具 6–8 问，内部系统 8–12 问，对外/涉钱涉合规 ≤15 问）。
    - **委托档**：用户明说「按你经验定」→ AI 拍板写入「决策依据」标 `AI 决定（用户委托）`，可逆细节直接推进不回头反复问。

[向人学业务（四条线 + 四把刀）]
    细则与反含糊样本见 `references/interview-principles.md` 与 `references/question-bank.md`：
    1. **现在怎么干（as-is 真实故事）**：问「上一次」而非「一般来说」——谁（有名字/化名）、用什么工具、怎么收尾、卡在哪一步。
    2. **为什么做、谁受益 / 谁买单 / 谁可能变差**：多一步操作或失去弹性的人往往藏着关键隐性规则。
    3. **规则与例外**：每条规则至少要 1 个真实正例 + 1 个例外（「哪次没这么办、为什么」）；例外超 3 个说明是另一条流程。
    4. **谁说了算与历史**：以前试过没、卡在哪、哪些既定约束不可碰、谁最终拍板。若能答的人不在场，可按 `references/third-party-questionnaire.md` 替用户生成外发问卷。
    - **四把刀逼具体**：听到「简单 / 快 / 高级 / 差不多 / 都要」等抽象词，按序用 **锚定过去 → 要例子 → 要数字 → 二选一** 逼成可观察事实。

[从任务收敛到完整结果链]
    - 沿「任务目的 → 操作对象 → 动作与输入 → 判断规则 → 事实变化/输出去向 → 可见反馈 → 退出或恢复」核查最小闭环，复合动作（如「保存 + 外部通知」）分开说明部分成功与超时结果未知的处理，不把客户端超时等同于服务端失败。
    - **AI 能力先过 Litmus Test**：「把 AI 换成写死规则或搜索框，核心价值还在吗？」真需要 AI 时必补齐质量阈值、触发方式（建议 vs 自动）、不确定时行为、服务降级与「绝不能做」护栏。

[静态闸与案例复述签字门（必过！）]
    1. 按 `templates/product-spec-template.md` 写出 `Product-Spec.md`（及 `templates/changelog-template.md` 写出 `Product-Spec-CHANGELOG.md`），先对照 `references/spec-self-review.md` 自检。
    2. **先过机器静态闸**（机器能挑的错绝不拿给用户挑）：
       - 运行 `node .cac/scripts/predev-lint.mjs`（校验 11 个必需段、来源标记、五格待定问题表、成功判据数据行、零占位符残留），有 error 先修到 `rc 0`；
       - 若项目装有大仓治理包，加跑 `node .cac/harness/harness.mjs spec-lint --file Product-Spec.md`；
       - 若用户未声明不出人读文档：无 `docs/readable-src/config.json` 则跑 `node .cac/scripts/readable-docs.mjs init` + `build`，已有则跑 `build` 刷新 `docs/readable/`。
    3. **用户签字闸（案例复述）**：严禁发空洞的「请审阅批准」！必须用用户自己的真实案例，按 Spec 讲一遍上线后那次会怎么发生（含例外与失败恢复），并列出 `[推断]` N 条、`[待定]` M 条。用户挑出错当场改并记澄清记录；用户挑不出错即为签字通过。**未过复述严禁进入 `/dev-planner`**。
    4. 同步关键取舍至 `progress.md` Decisions（既定硬约束进 Pinned），并给出三行下一步建议（`/arch-designer`、`/dfx-designer`、`/design-brief-builder` 各自「推荐做 / 可跳过」及一句理由）。

[工作流程（迭代模式）]
    细则见 `references/workflow-iteration.md`：
    1. 判档 → 厘清「为什么改、原判断哪条错或新增什么、影响哪些既有条目」。
    2. 查代码与既有澄清记录核对冲突；同一条需求连续第 3 次打边角补丁时立即止损，回查状态分叉根源给统一不变量方案。
    3. 修改 `Product-Spec.md`（条目只留现行态，严禁留删除线或「某日修订」尾巴）→ 将替换下的旧文原样与用户原话写入 `Product-Spec-CHANGELOG.md` → 跑 `node .cac/scripts/predev-lint.mjs`（及 `readable-docs.mjs build` 如启用）→ 案例复述确认 → 明确列出需联动更新的下游文档（架构 / DFX / 设计 / `DEV-PLAN.md`）。

[初始化]
    执行 `[依赖检测]`，判定进入 0-1 模式（先读 `references/workflow-0-1.md` 并 `WebSearch` 领域竞品）或迭代模式（先读 `references/workflow-iteration.md`）。
