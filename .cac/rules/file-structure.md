---
paths:
  - ".cac/**"
  - "Product-Spec.md"
  - "DEV-PLAN.md"
---

# 标准项目文件结构规范（file-structure）

> 本文件由 `.cac/rules/AGENTS.md` 下沉；生成或核对目录结构前必须完整 `Read` 本文件。

## 目标业务项目目录树

```text
project-root/
├── Product-Spec.md                     # 现行产品需求规格（只放现行态）
├── Product-Spec-CHANGELOG.md           # 需求变更史（保留被替换的旧文与用户原话）
├── Architecture-Design.md              # 架构设计文档（可选，M/L 档项目）
├── DFX-Spec.md                         # 13 维质量属性与威胁设计（可选）
├── Design-Brief.md                     # 交互体验规范（可选：信息架构 / SCREEN 八态 / 交互原语）
├── DESIGN.md                           # 视觉设计 token 与规则（可选，与 Design-Brief 配套）
├── DEV-PLAN.md                         # 分阶段开发计划（只留未完成与近期最多 20 个已完成 Phase）
├── DEV-PLAN.archive.md                 # 已归档的历史完成 Phase（由 plan-archive.mjs 自动搬入）
├── progress.md                         # 项目工作记忆（Pinned / Decisions / 断点 / TODO / Done 现行态）
├── progress.archive.md                 # 已归档的历史记忆（由 progress-archive.mjs 自动搬入，recap 不读）
├── domain/                             # 领域口径库（可选副产品，按域分文件，存在即维护）
├── docs/
│   ├── design/                         # 复杂模块算法与业务规则详述（可选，<模块名>-设计.md）
│   ├── readable/                       # 人读工程文档静态网页（readable-docs.mjs build 原子生成，入库不手改）
│   ├── readable-src/                   # 人读文档配置 config.json、项目判断 map.json 与指纹说明 notes/
│   └── agent-notes/                    # 角色超限战术笔记归档（code-reviewer/、tester/，可选）
├── <project-code-dirs>/                # 业务源码目录（如 src/、app/、server/、packages/ 等）
└── .cac/                               # cac-base 原生工程治理配置树（根目录零额外框架文件入侵）
    ├── .gitignore                      # 排除全部本地运行态与备份文件
    ├── settings.json                   # 权限护栏（deny/ask）与全套 Node Hook 注册表
    ├── FRAMEWORK-MANIFEST.json         # 核心资产 LF-SHA256 清单（供无损升级与 doctor 校验）
    ├── FRAMEWORK-MANIFEST-OPTIONAL.json# 可选包清单（仅使用过 --with-tests / --with-harness 时存在）
    ├── EVOLUTION.md                    # 反馈聚类与规则进化记录
    ├── rules/                          # 规则目录（主控宪法 + 6 核心按需细则 + 2 大仓可选细则）
    │   ├── AGENTS.md                   # 主控宪法（无 paths 头，codeagent 会话启动原生自动注入）
    │   └── *.md                        # 按需下沉细则（6 份核心细则 + --with-harness 可选加装 2 份）
    ├── agents/                         # 9 个专职 Sub-Agent 定义
    ├── skills/                         # 22 个原生全流程 Skill（含 references/ 与 templates/）
    ├── hooks/                          # 纯 Node 会话闸门（*.mjs）与进程隔离公共库 hooks/lib/
    ├── githooks/                       # 纯 Node 跨平台 Git Hooks（install-githooks.mjs 显式开启）
    ├── harness/                        # 治理引擎（harness.mjs + profile.json + exclusions.json + audit/ 三哨兵 + 可选 ext/）
    ├── scripts/                        # 纯 Node 工程脚本（doctor / 活文档三件套 / readable-docs / lint / supervisor 等）
    ├── feedback/                       # 本项目积累的 AI 行为修正与 FEEDBACK-INDEX.md
    └── tests/                          # 框架自测套件（--with-tests 按需安装）
```

## 三层隔离红线

1. **稳定框架层**（`.cac/{agents,skills,hooks,harness,scripts,rules}`，含主控宪法 `.cac/rules/AGENTS.md`）：升级时未改动文件自动更新，用户本地改动旁落 `*.cac-base-new` 绝不静默覆盖。
2. **项目资产层**（`Product-Spec.md`、`DEV-PLAN.md`、`progress.md`、`domain/`、`docs/`、`.cac/feedback/FEEDBACK-INDEX.md`）：归目标项目私有，框架安装升级绝不覆盖或清空。
3. **本机运行态层**（`.cac/.runtime/`、`.cac/.needs-review*`、`.cac/evidence/`、`.cac/harness/{state,receipts,waivers,trend,evidence}/`、`.cac/agent-memory/`）：一律被 `.cac/.gitignore` 忽略，绝不入库、绝不随框架分发。
