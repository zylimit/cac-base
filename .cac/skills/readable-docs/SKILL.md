---
name: readable-docs
description: 当需要生成或刷新离线人读工程文档（数据库设计、人读版需求规格、架构模块导读），或核对表读写关系、模块依赖与文档一致性时使用。
---

[任务]
    驱动 `node .cac/scripts/readable-docs.mjs` 生成浏览器离线直开的 HTML 工程交接文档（`docs/readable/`，写给未参与开发、手头无 AI 的接手工程师阅读）。
    - **事实由脚本机械提取**（PostgreSQL DDL 表列外键、代码读写哪张表、文件引用关系、路由接口、零丢字排版的 `Product-Spec.md`）；
    - **AI 只补写机器提取不到的业务语义说明**（表存什么、列怎么算、业务分组、模块职责与全库/全系统导读），经 `note put` 盖指纹落盘于 `docs/readable-src/notes/`；一旦底层源码或建表语句变更，过期说明自动标为「待更新」。
    - 支持两种工作方式：**随日常开发跟 Task 走**（默认）与 **存量项目分批补齐**。

[依赖检测]
    启动时自动执行：
    - 检查本机 Node >= 20 与 `.cac/scripts/readable-docs.mjs`；
    - 按项目实际资产启用对应分册：有 `Product-Spec.md` 即出人读版需求规格；配置了 `codeRoots`（JS/TS/Python 等）即出架构设计；有 `.sql` 建表定义即出数据库设计（缺某类来源时如实告知，将对应配置留空，不硬凑）。

[文件结构]
    readable-docs/
    ├── SKILL.md
    └── references/
        ├── dispatch-templates.md    # 存量项目分批派 Sub-Agent 写表/列/模块说明与提模块划分的派单模板
        ├── reading-the-numbers.md   # build 报数行、check 不一致项、structure 基线与 page-shots 解读手册
        └── sample-notes.md          # 表/列/分组/模块/导读说明的正面范例与反面禁区

[跟着日常开发走（全链路接线）]
    1. **起头初始化**：`Product-Spec.md` 生成后或进入 `/dev-builder` 时（除非用户明确声明不出人读文档并记入 `progress.md` Pinned），若无 `docs/readable-src/config.json`，运行 `node .cac/scripts/readable-docs.mjs init` + `build` 生成首版页面。
    2. **配置随目录生长**：运行 `node .cac/scripts/readable-docs.mjs init --suggest` 检查新出现的 DDL、源码目录或架构文档，该纳入的补入 `config.json`，明确不纳入的加入 `ignore`。
    3. **每个 Task 随改随补**：触及建表定义、读写表代码或新增模块文件/接口/跨模块依赖的 Task，`implementer` 必须在收工前跑 `build`、经 `note put` 补齐或更新对应说明、确认 `check` 报「不一致 0 条」，且 `structure` 结构指标（循环依赖、越层引用、未归属文件、>1000 行文件）不劣于派单前基线。
    4. **Phase 收尾与发版前门禁**：Phase 四步走第 2 步与 `/release-builder` 前置自查均强制核验 `node .cac/scripts/readable-docs.mjs check` 报「不一致 0 条」。

[存量项目一次补齐五步法]
    所有命令均在项目根运行 `node .cac/scripts/readable-docs.mjs <子命令>`：
    1. **`init` 与核对 `config.json`**：按执行顺序排全 `ddl`，列全所有读写数据库的 `codeRoots`，把构建产物与本地缓存目录排入 `ignore`。
    2. **首轮 `build` 读报数行**：对照 `references/reading-the-numbers.md` 处理未解析语句、代码内建表或漏配目录。
    3. **提议业务分组与模块划分（`docs/readable-src/map.json`）**：`tableGroups` 按业务事项而非表名前缀分组；平铺目录提议 `layers` 与 `modules`（`status` 一律填 `"proposed"`，不擅自填 `"confirmed"`），确保「未归属文件」与「项目判断对不上」清零（大项目可按 `references/dispatch-templates.md` 派子代理分析）。
    4. **先做小样确认口吻，再分批铺开写说明**：
       - 严格遵守 `references/sample-notes.md`：先讲业务再讲技术，表与模块首段一句话 ≤60 字说清职责，列说明写清枚举全集与空值含义，例子一律用合成脱敏数据，拿不准写「待确认：…」，绝不编造；
       - 先写 1 个分组（3–5 张表）+ 导读请用户审阅详略口吻，点头后再按批次派 fresh 子代理铺开，经 `note put --file <path>` 落盘；
       - 铺完后跑 `build`，并用 `node .cac/scripts/page-shots.mjs docs/readable index.html ...` 截长图检查排版与横向溢出（若本机无浏览器退 `rc 3`，诚实向用户说明「页面渲染截图未执行」，绝不冒充看过）。
    5. **终验 `check` 与汇报四类账单**：确认 `node .cac/scripts/readable-docs.mjs check` 报「不一致 0 条」，向用户分开汇报：① 源码机械提取事实数；② `proposed` 分组/模块划分待确认项；③ 草稿说明段数与「待确认」清单；④ 写说明时撞见的代码与注释/Spec 不一致线索。

[红线纪律]
    - **`docs/readable/` 是纯生成物，入库但严禁手改 HTML**；合并分支冲突后直接重跑 `build` 覆盖刷新。
    - **`docs/readable-src/notes/` 严禁直接用 `Edit`/`Write` 涂改**，必须统一走 `readable-docs.mjs note put` 重算指纹；`note confirm` 仅在用户人工抽审认可后执行，AI 绝不代签。
    - 写模块或表说明时如果一句话怎么都写不顺、必须用「以及/另外还管」拼凑几件不相干的事，说明模块边界或分组划错了——应调整 `map.json` 划分或如实向用户指出耦合事实，严禁为了消掉循环依赖数字而把不相干模块强行合并遮丑。

[初始化]
    执行 `[依赖检测]`，判断当前走 `[跟着日常开发走]` 还是 `[存量项目一次补齐五步法]`。
