---
name: test-builder
description: 当需要为 HIGH Task 补独立回归测试、锁定缺陷红灯（red-locks-the-bug）或执行 Phase/发版前测试卡点时使用。写测者必须独立于被测代码作者。
argument-hint: "[被测模块或需求范围]"
---

[任务]
    由**独立于被测代码作者的 fresh `tester` 子代理**为高风险契约、解析器、权限与状态机编写并实跑可重跑回归测试，输出运行器原始证据，守住「写测独立」与「永不假绿」铁律。

[依赖检测]
    启动时自动执行（先 `Read .cac/rules/subagent-dispatch.md`）：
    - 必需：被测源码与业务预期来源（`Product-Spec.md`、`DEV-PLAN.md`、`docs/design/*.md` 或派单 `Business Context`）；测试运行器若尚未搭建，按 `templates/test-scaffold.md` 最小化初始化并先验空套件能跑通。
    - 战术记忆：若存在 `.cac/agent-memory/tester/MEMORY.md`，先 `Read` 提取本项目 flaky 区域、历史回归点与测试夹具坑优先覆盖。

[文件结构]
    test-builder/
    ├── SKILL.md
    └── templates/
        └── test-scaffold.md     # Python pytest / Node test / Vitest 最小可用测试基建参考

[第一性原则]
    1. **写测独立（铁律）**：断言必须从 `Product-Spec.md`「规则与例外」及 `docs/design/*.md` 独立推导，**严禁照着业务源码写断言**。
    2. **契约与高危边界优先，控制测试体量**：测试代码总量不超过有效业务代码的 `1/2`，不做 getter/setter 凑覆盖率；优先把预算砸在 **泄密、毁数据、跨模块序列化契约、解析器容错、去重幂等键、Windows/POSIX 路径与换行兼容** 五大高危区。
    3. **风险标签与规则追溯标签**：
       - 每个测试文件头标注 `# risk: high|medium|low` 或 `// risk: high|medium|low`；
       - 验证 `docs/design/*.md` 规则的用例标注 `# rule: <编号>` 或 `// rule: <编号>`，供 `node .cac/scripts/design-trace.mjs` 双向核对。
    4. **严格数据隔离**：涉及文件写入、SQLite/数据库或起服务的测试，必须在 `os.tmpdir()` 下创建带进程号/随机串的独立临时子目录，测试结束仅清理该子目录，严禁读写用户真实配置或生产库。
    5. **真跑真证据，杜绝假绿**：空测试计划、全 `SKIPPED`、运行器报错退 `3` 一律不得报通过；必须在同一轮回执中附上刚跑出的真实命令、退出码与 passed/failed 计数。

[失败三分流]
    1. **业务代码缺陷** → 保留失败用例与完整运行器输出交回主 Agent（若处于 `red-locks-the-bug` 第一步，真红灯即达标交付；否则由主 Agent 派 `bug-fixer` 修复，严禁 `tester` 自行改业务源码或放宽断言凑绿）。
    2. **测试自身夹具或语法问题** → `tester` 当场修正测试代码并重跑验证。
    3. **Spec 与真实业务矛盾** → 该条用例显式 `skip` 注明原因，在回执 `Counter-examples` 按四段式报「❓ 需求存疑」交主 Agent 回流 `/product-spec-builder`。

[交付与战术笔记沉淀]
    - 如有 `docs/design/*.md`，加跑 `node .cac/scripts/design-trace.mjs` 核查规则测试覆盖缺口；
    - 收工前将本轮新发现的易碎边界或夹具注意事项浓缩（单条一行）追加至 `.cac/agent-memory/tester/MEMORY.md`（单文件 ≤5KB）。

[初始化]
    执行 `[依赖检测]`，探测现有测试运行器与目录规范。
