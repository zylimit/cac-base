---
paths:
  - ".cac/**"
  - "Product-Spec.md"
  - "DEV-PLAN.md"
---

本文件由 `.cac/rules/AGENTS.md` 下沉；主控命中指针时必须完整读取本文件再行动，不得凭指针行猜测内容。

[文件结构]
    project/
    ├── Product-Spec.md                    # 产品需求文档（只放现行态）
    ├── Product-Spec-CHANGELOG.md          # 需求变更记录（被换掉的旧文与用户原话只在这里留一份）
    ├── Architecture-Design.md             # 架构设计文档（可选，M/L 档项目）
    ├── DFX-Spec.md                        # DFX 质量属性设计（可选，与架构设计配套）
    ├── Design-Brief.md                    # 设计规范文档（可选，体验脊柱：信息架构 / 页面规格 / 八态 / 文案 / 可访问性）
    ├── DESIGN.md                          # 视觉 token 与规则（可选，与 Design-Brief 配套，Google design.md 规范，代码直接读 token）
    ├── DEV-PLAN.md                        # 分阶段开发计划
    ├── DEV-PLAN.archive.md                # 做完的 Phase 原文（攒多了由 plan-archive.mjs 搬来，原文件留指针；搬过才有）
    ├── progress.md                        # 项目记忆：Pinned / Decisions / TODO / 断点 / Done，只留仍在生效的
    ├── progress.archive.md                # 过线的决策与完成原文（progress-archive.mjs 搬来；搬过才有，recap 不读）
    ├── domain/                            # 领域口径库（可选，副产品；一域一文件，见 .cac/rules/domain-rulings.md）
    ├── docs/design/                       # 设计详述（可选，一个复杂模块一份 <模块名>-设计.md：规则编号 + 代码位置 + 常量 + 测试，见 .cac/rules/design-detail.md）
    ├── docs/readable/                     # 人读文档的页面（默认有，用户明说不出的没有；readable-docs.mjs build 生成，入库不手改；给没参与开发的人用浏览器看）
    ├── docs/readable-src/                 # 人读文档的配置 config.json、项目判断 map.json 与 AI 写的说明 notes/（随上一行；notes/ 只经 note put 落盘）
    ├── docs/agent-notes/                  # 角色超限战术笔记归档（code-reviewer/、tester/，可选）
    ├── <project-name>/                    # 项目代码（以项目名命名的子文件夹，或 src/、app/、server/、packages/ 等源码目录）
    │   ├── src/
    │   ├── package.json
    │   └── ...
    ├── .gitignore
    └── .cac/                              # cac-base 原生工程治理配置树（根目录零额外框架文件入侵，与异构工具零冲突共存）
        ├── .gitignore                     # 排除全部本地运行态与升级备份文件
        ├── settings.json                  # 权限护栏（deny/ask）与全套纯 Node Hook 注册表
        ├── FRAMEWORK-MANIFEST.json        # 核心资产 LF-SHA256 清单（供三路无损升级与 doctor.mjs 校验）
        ├── FRAMEWORK-MANIFEST-OPTIONAL.json # 可选包清单（仅使用过 --with-tests / --with-harness 时存在）
        ├── rules/                         # 主控宪法 + 下沉细则：AGENTS.md 为无 paths 头的主控宪法（codeagent 会话启动原生自动注入）；其余按需下沉细则（file-structure / workflow-orchestration / dev-workflow-details / subagent-dispatch / memory-systems / domain-rulings / design-detail；大仓细则 harness-large-repo / quality-attributes 位于 harness/ext/rules/，随 --with-harness 装入）
        ├── hooks/                         # 闸门钩子（stop-gate / no-direct-code-guard / tdd-gate / pre-commit-check / three-file-sync-gate / dangerous-command-guard / secret-exfil-guard / precompact-gate / postcompact-reinject / release-gate / subagent-bookkeeping / session-start / record-authorship / mark-review-needed / detect-feedback-signal / static-check / auto-push / kill-dev-ports，全部纯 Node .mjs，单运行时跨平台，共用逻辑在 hooks/lib/）
        ├── githooks/                      # 纯 Node 跨平台 Git Hooks（由 node .cac/scripts/install-githooks.mjs 显式开启）
        ├── harness/                       # 核心含 harness.mjs + lib/{core,tier}.mjs + profile.json（档位表）+ exclusions.json + adapters.json + audit/ 三哨兵；大仓治理引擎在 harness/ext/（含 ext/rules/ 两份细则），目标项目默认不装、setup --with-harness 才装，module-catalog.json 放置即启用
        ├── agents/
        │   ├── implementer.md             # 实现者 Sub-Agent（编码）
        │   ├── code-reviewer.md           # 审查者 Sub-Agent（审查）
        │   ├── tester.md                  # 测试者 Sub-Agent（写测/跑测，独立于实现者）
        │   ├── deployer.md                # 部署者 Sub-Agent（打包/部署）
        │   ├── researcher.md              # 研究探索 Sub-Agent（只读广度普查）
        │   ├── feedback-observer.md       # 反馈观察 Sub-Agent
        │   ├── evolution-runner.md        # 进化引擎 Sub-Agent
        │   ├── domain-recorder.md         # 领域口径 Sub-Agent
        │   └── progress-recorder.md       # 项目记忆 Sub-Agent
        ├── EVOLUTION.md                   # 进化引擎记录
        ├── feedback/                      # 经验教训与 FEEDBACK-INDEX.md
        ├── scripts/                       # 纯 Node 质量脚本（doctor.mjs 自检 / plan-lint.mjs / predev-lint.mjs 前期五文档闸 / ui-audit.mjs 设计稿渲染审计 / ui-slop-scan.mjs / page-shots.mjs 把页面截成图给 Agent 读（用本机已有的浏览器，不用另装东西）/ gate-audit.mjs / collect-feedback.mjs 收下游 feedback / install-githooks.mjs / progress-archive.mjs 归档搬运 / plan-archive.mjs 做完的 Phase 归档 / project-status.mjs 现在到哪与活文档体积 / design-trace.mjs 设计详述规则 ↔ 测试 ↔ 常量核对 / readable-docs.mjs 人读文档生成器（取事实、出页面、说明落盘、核对，模块在 scripts/readable/）/ supervisor.mjs 进程守护 / test-age.mjs；快速档开关走 harness.mjs tier set fast）
        ├── tests/                         # 框架自测套件（selftest 引擎自测 / 安装器与跨平台 / hook 行为与地板闸 / 档位 / 审计三哨兵 / 活文档归档 / 前期文档闸与设计详述追踪 / 人读文档生成器 / PowerShell 语法解析），node .cac/tests/run-all.mjs 统一跑——清单以目录实际内容为准，不在本文件逐个列
        └── skills/
            ├── product-spec-builder/      # 需求收集（含 examples/ 与 references/ 追问题库与访谈方法）
            ├── arch-designer/             # 架构设计（不变量 + 模块划分 + C4 + ADR + 押后决定；templates 含设计详述模板，examples 含派工示例）
            ├── dfx-designer/              # DFX 设计（13 维质量属性定档 + 合规扫描 + 威胁表；examples 含派工示例）
            ├── design-brief-builder/      # 设计规范（Design-Brief.md + DESIGN.md，references 含风格词汇表 / 质量地板 / Agent 交互模式 / 方向示例）
            ├── design-maker/              # 设计图制作（odc 为主，点名时走画布或提示词；方向样张 + 两遍法 + ui-audit 验收）
            ├── dev-planner/               # 开发计划
            ├── dev-builder/               # 项目开发
            ├── bug-fixer/                 # Bug 修复
            ├── code-review/               # 代码审查
            ├── test-builder/              # 系统测试
            ├── release-builder/           # 构建发布
            ├── red-blue-review/           # 红蓝对抗审查（纯 Node red-blue-pack.mjs + prompts 三角色提示词）
            ├── branch-finisher/           # 开发分支收尾
            ├── skill-builder/             # 创建新 Skill
            ├── feedback-writer/           # 记录用户反馈
            ├── evolution-engine/          # 进化引擎扫描
            ├── domain-rulings/            # 领域口径库入口（四象限分诊 / 查 / 待复核 / 手工收录）
            ├── readable-docs/             # 人读文档入口（数据库设计、人读版需求规格与架构设计：跑生成器、提业务分组与模块划分、写说明、核对）
            ├── progress-recorder/         # 项目记忆维护（sub-agent 调用）
            ├── record/                    # /record 入口：派 progress-recorder 合并本轮增量
            ├── archive/                   # /archive 入口：跑 progress-archive.mjs 归档
            └── recap-project/             # /recap-project 入口：恢复项目上下文

[三层隔离红线]
    - **稳定框架层**（`.cac/{agents,skills,hooks,harness,scripts,rules}`，含主控宪法 `.cac/rules/AGENTS.md`）：升级时按 LF-SHA256 比对——未改动文件自动更新，用户本地改动过的文件保留不动并将新版旁落 `*.cac-base-new`，绝不静默覆盖。
    - **项目资产层**（`Product-Spec.md`、`Product-Spec-CHANGELOG.md`、`DEV-PLAN.md`、`progress.md`、`domain/`、`docs/`、`.cac/feedback/FEEDBACK-INDEX.md`）：归目标业务项目私有，框架安装与升级绝不覆盖或清空，框架自身的记忆与台账也绝不拷入目标项目。
    - **本机运行态层**（`.cac/.runtime/`、`.cac/.needs-review*`、`.cac/evidence/`、`.cac/harness/{state,receipts,waivers,trend,evidence}/`、`.cac/agent-memory/`）：一律由 `.cac/.gitignore` 忽略，绝不入库、绝不随框架分发。
