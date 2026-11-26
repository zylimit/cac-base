---
paths:
  - ".cac/feedback/**"
  - ".cac/agent-memory/**"
---

本文件由 `.cac/rules/AGENTS.md` 下沉；主控命中指针时必须完整读取本文件再行动，不得凭指针行猜测内容。（frontmatter 的 `paths` 声明本细则作用域并避免 `codeagent` 会话启动时全量自动灌入浪费上下文；碰 `.cac/feedback/` 或 `.cac/agent-memory/` 下文件、或判断某条该记哪儿时，按 `.cac/rules/AGENTS.md` 前置指针显式 `Read` 本文件。）

[三套系统的边界（feedback / 用户 memory / agent memory）]
    - feedback 记录到 .cac/feedback/ 目录，由 evolution-engine 扫描并生成进化建议，用于改进 Skill 和规则
    - memory 记录到用户的 memory/ 目录，用于跨 session 记住用户偏好和项目上下文
    - 用户修正 AI 行为时，必须走 feedback 流程（派发 feedback-observer），不能只写 memory；纠正分两类落地——**业务规则**（这个项目里的事实、取舍、既定）进 progress.md Decisions / Pinned 三要素，下一角色靠派单包 Business Context 拿到；**工作方法**（AI 该怎么问、怎么做）进 feedback，feedback 的 applied_to 记它落到了哪里，pending 表示还没生效
    - 一条 feedback 的 scope / exceptions / supersedes 是它能不能被正确使用的前提：没有范围的规则会被用到不该用的地方，没有取代关系的新规则会和旧规则并存打架
    - **agent memory（第三类，别和前两者混）**：`codeagent` 无 `memory: project` 自动挂载，改为 `code-reviewer` / `tester` 启动时显式 `Read`、收工前按需更新 `.cac/agent-memory/<角色>/MEMORY.md` 持久战术记忆——存的是角色自己的战术笔记（本项目高发缺陷模式 / flaky 区），由角色自维护、无人工审核，不承载框架规则（那是 feedback 的事），也不承载项目事实。**单文件封顶 5KB、每角色合计封顶 50KB**：超了就是文档不是记忆，搬到 `docs/agent-notes/<角色>/` 并在该角色 `MEMORY.md` 里留相对路径指针（2026-09-15 首批搬了六份，最大的一份 43KB）。fresh 实例一旦每次读取过厚的 `MEMORY.md` 与它点开的文件，「fresh」就变假，也会把「每单 ≤ 6 次工具调用」直接撑爆。
    - **宿主本地偏好记忆的边界**：用户级本地目录（如 `~/.cac/` 或宿主本地环境偏好）只许存机器本地琐碎（构建命令、调试线索）；**决策 / 约束 / 完成事项只认 `progress.md`**——三文件同步铁律不因任何本地 memory 存了什么而豁免，恢复上下文以 `/recap-project` 三份文件为准、不以本地 memory 为准。
    - **领域口径（跟领域走，不跟项目走也不跟 AI 走）**：「这个域里事情怎么算」进项目根 domain/——不进 feedback（那是 AI 工作方法）、不进 progress.md（那是项目决策）、不进 agent memory（那是角色战术笔记）。判法是问「这条当初是谁知道的」：双方都不知、要共同查证才得出的才是口径，细则见 .cac/rules/domain-rulings.md。
