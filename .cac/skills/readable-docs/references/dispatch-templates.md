# 存量项目分批写说明与提议模块划分的派单模板

存量项目表或模块较多时，主 Agent 按分组/按层分批派发 fresh 子代理（遵循 `.cac/rules/subagent-dispatch.md` 七字段契约），每批控制在 3–8 张表或 6–10 个模块。

## 模板一：分批补写数据库表与列说明（派 `implementer`）

```text
Goal: [Task 档位: LOW] 为人读工程文档「<分组标题>」分组下的 <N> 张表补齐表说明与缺失列说明，并通过 note put 校验落盘。
Scope: 仅读取源码与规格，在系统临时目录自建独立子目录组装说明文本，通过 `node .cac/scripts/readable-docs.mjs note put --file <临时文件>` 写入 `docs/readable-src/notes/`。
Out of Scope: 严禁手改 `docs/readable/`、`docs/readable-src/notes/*.md`、业务源码或运行 `build` / `git commit`。
Existing Pattern: 先完整 Read `.cac/skills/readable-docs/SKILL.md` 的 `[存量项目一次补齐五步法]` 与 `.cac/skills/readable-docs/references/sample-notes.md`。
Business Context: 为未参与开发的接手团队编写数据库业务字典。叫法对齐 `Product-Spec.md` 与已落盘的 `doc:db` 导读；你负责的表为：`<表1>`, `<表2>`...
Verification:
  1. 运行 `node .cac/scripts/readable-docs.mjs pending --json` 获取你负责各表的 `missingColumns` 与 `writers` 上下文；
  2. 精读各表主要写入源码（查清写入时机、状态枚举全集、JSON 字段结构），按 `## table:<表名>` 与 `## column:<表名>.<列名>` 组装说明（例子必须合成脱敏，严禁含真实人名/内网 IP/密钥；拿不准写「待确认：…」）；
  3. 逐表运行 `node .cac/scripts/readable-docs.mjs note put --file <临时文件>` 直至退出码 0，重跑 `pending --json` 确认负责的表均已清零，最后删除自建临时子目录。
Escalation: 发现代码实际逻辑与注释或 Product-Spec.md 冲突时，不私自选边，记录到回执 Evidence/Domain findings 交主 Agent；单项核查超 5 轮止损。
```

## 模板二：平铺代码库提议模块划分（派 `researcher` 或只读分析）

- 基于 `node .cac/scripts/readable-docs.mjs build --facts-json` 提取的文件头注释、路由前缀、读写表归属互证，输出 `layers` 与 `modules`（`status: "proposed"`）及划分理由、存疑文件与真实循环依赖清单；严禁为抹掉循环依赖把不相干业务硬塞进同一模块。

## 模板三：分批补写架构模块说明

- 先读 `pending --json` 中 `modules[]` 的接口、依赖与读写表上下文及对应文件头注释，按 `## module:<id>` 编写（首段 ≤60 字单句说清管哪件业务事，不以「本模块」起头、不机械复述文件列表、不描述网页当下排版），由 `note put` 统一盖指纹落盘。
