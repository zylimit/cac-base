---
name: release-builder
description: 当用户亲自触发打包、构建发布产物或上线部署时使用。设 disable-model-invocation 仅限人工敲斜杠触发，强制执行隐私审计与部署三件套独立验收。
disable-model-invocation: true
argument-hint: "[版本号或部署目标（可选）]"
---

[任务]
    受控执行版本打包、构建、隐私安全审计与上线部署，确保发布产物可安装、可运行、零敏感私货泄露，并由主 Agent 独立核验**部署三件套**。
    - **人工触发铁律（`disable-model-invocation: true`）**：模型严禁代调本技能！当用户口头说「发版 / 打包 / 部署上线」时，主 Agent 必须**先完成下方前置自核四项**并把真实检查结果贴在回复里，再请用户亲自输入 `/release-builder`。

[主 Agent 前置必核四项 + 档位门禁]
    在请用户敲 `/release-builder` 前，以及本技能启动的第一步，主 Agent 必须亲查并确认：
    1. **待审清零**：`.cac/.needs-review` 不存在或内容为 `clean`；且当前治理档位非 `fast`（`node .cac/harness/harness.mjs tier status`，`fast` 档严禁发版，须先切回 `standard`/`strict`）。
    2. **工作树干净**：`git status --short` 输出为空。
    3. **远端同步**：若配置了上游分支，本地 `HEAD` 与远端分支无未拉取分叉。
    4. **人读文档同步**：若存在 `docs/readable-src/config.json`，`node .cac/scripts/readable-docs.mjs check` 报「不一致 0 条」；若存在 `docs/design/*.md`，加跑 `node .cac/scripts/design-trace.mjs`。
    5. **独立测试卡点已过**：相关回归测试已由 `tester` 实跑全绿，严禁跳过测试直接打包。

[第一性原则]
    1. **Dev 能跑 ≠ 安装包能用**：构建打包完成后必须针对**最终产物包/容器/全局安装态**做冒烟验证，不能拿开发态 `npm run dev` 代替。
    2. **产物隐私与安全零容忍（绝对地板）**：对构建输出目录及待分发压缩包实跑扫描——严禁混入 `.env*`、`*.db`/`*.sqlite`、`*.pem`/`*.key`、API Token（`sk-*`、`X_AUTH_TOKEN`、`ENTERPRISE_API_KEY`）、开发者本机绝对路径（`/home/`、`/Users/`、`C:\Users\`）或 `.cac/.runtime/` 运行态缓存。命中任一立即中止重打。
    3. **执行归 `deployer`，验收归主 Agent**：具体打包与部署动作按七字段契约派发 fresh `deployer` 子代理执行（提醒其先 `Read .cac/skills/release-builder/SKILL.md`）；远端变更前必先实查目标现况与备份路径。
    4. **卡死先查进程死锁**：打包器 CPU 0% 长时间挂起多为符号链接环或交互式弹窗阻塞（Windows 下确保子进程 `windowsHide: true` 且非交互模式），满 5 轮无进展立即止损诊断。

[部署验收三件套（主 Agent 独立亲核，绝不盲信子代理自报！）]
    涉及服务部署上线时，主 Agent 必须独立取证核实以下三项全过才算发布成功：
    1. **精确产物指纹与容器创建时间戳**：核对新镜像 tag / 产物 SHA256 及容器精确 `Created` 时间晚于本次构建（严禁只看模糊的 `Up X minutes`）。
    2. **健康探针实测**：请求真实健康检查端点，确认 HTTP 200 与预期版本号。
    3. **Live 核心业务冒烟**：对线上真实入口发起最小无害业务验证，确认新能力真实可用。

[回退预案]
    - **Web / 服务端**：切回上一版已验证 tag/镜像并复核健康探针（注意不可逆 DB 迁移须走前向修复或备份恢复，不能仅回退二进制）。
    - **Desktop / 离线安装包**：立即撤下问题分发包，修复后递增版本号重出安装包。
    - **CLI / 包仓库**：对问题版本执行 `deprecate` 告警，修复后发布补丁版本。

[工作流程]
    1. 核验前置四项、档位门禁与测试绿灯证据 → 与用户确认目标版本号、打包/发布渠道与回退方案。
    2. 派发 `deployer` 执行版本号更新、生产构建、产物目录隐私扫描与安装/部署，收回十字段回执。
    3. 主 Agent 独立核查产物隐私扫描结果与**部署三件套**，清理临时目录，将发布记录同步至 `progress.md` Done。

[初始化]
    先核对 `[主 Agent 前置必核四项 + 档位门禁]`，任一未过先停下修复；全过后再确认本次发布渠道与目标版本。
