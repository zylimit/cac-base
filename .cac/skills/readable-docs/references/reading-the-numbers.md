# `readable-docs.mjs` 与 `page-shots.mjs` 输出解读手册

## 1. `build` 报数行怎么看
- **未解析的语句 / 没扫成的文件**：查看首页清单定位具体 SQL 方言或未闭合字符串源码，向用户报告，不擅自删改业务 DDL 迁就生成器。
- **代码里建的表**：源码含 `CREATE TABLE` 但未列入 `config.json` 的 `ddl`，按执行顺序补入 `ddl`。
- **未归属的文件 / 项目判断里对不上的**：更新 `docs/readable-src/map.json` 的 `modules[].paths` 或修正写错的表名/模块 ID，直至这两项归 `0`。
- **循环依赖 / 越层引用**：客观反映代码真实耦合现状，照实呈现给用户，**严禁为了数字好看把两个循环引用的模块合并掩盖问题**。
- **退出码 `3`**：落盘前完整性或脱敏自检拦截（未覆盖旧页面），按报错点名的页码与行号排查，绝不强行绕过。

## 2. `check` 不一致类型处理
- `stale-page` / `missing-page` / `extra-page` / `note-mismatch` / `spec-*`：来源变了未重出或有人手改了 `docs/readable/` → 重新运行 `node .cac/scripts/readable-docs.mjs build` 并暂存生成页。
- `note-stale` / `note-orphan`：底层表列或模块接口变了导致说明指纹过期 → 跑 `pending` 查看旧文，对照最新源码重写后 `note put`（已删表的孤儿说明执行 `note drop`）。
- 注：尚未编写的说明在 `pending` 计缺口数，但不算 `check` 不一致。

## 3. `structure` 结构基线与 `page-shots.mjs` 视觉抽检
- 派单前跑 `node .cac/scripts/readable-docs.mjs structure` 记录基线，收单后重跑比对，防止单个 Task 悄悄新增循环依赖、越层引用或 >1000 行巨型文件。
- 运行 `node .cac/scripts/page-shots.mjs docs/readable index.html ...`（输出默认在 `.cac/evidence/page-shots/`）核查长表横向溢出；若本机无 Chrome/Edge 返回退出码 `3`，必须如实声明「页面截图核查缺席」，不得用 `check 0 条` 冒充视觉已审。
