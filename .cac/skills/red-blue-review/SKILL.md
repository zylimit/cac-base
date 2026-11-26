---
name: red-blue-review
description: 当发版前、合并前或改动核心治理家底需要高强度对抗审查时使用。通过 red-blue-pack.mjs 采集证据包，执行 Blue→Red→Judge 三遍实证裁决。
argument-hint: "[BASE..HEAD 或 --working]"
---

[任务]
    针对高风险代码变更、发版候选或 `.cac/` 家底大改，执行 **Blue（陈述辩护证据）→ Red（四视角证伪攻击）→ Judge（主 Agent 单一实证裁决）** 三遍红蓝对抗审查，把「看着没问题」变成可复现的 `file:line` 客观裁决。

[依赖检测]
    启动时自动执行（先 `Read .cac/rules/subagent-dispatch.md`）：
    - 必需：当前处于 Git 仓库内，且存在待审提交范围（`BASE..HEAD`）或未提交工作树改动（`--working`）。
    - 可选：`Product-Spec.md`、`DEV-PLAN.md`、`Architecture-Design.md`、`docs/design/*.md`。

[文件结构]
    red-blue-review/
    ├── SKILL.md                     # 三遍编排规程与裁决铁律
    ├── red-blue-pack.mjs            # 纯 Node 跨平台证据采集脚本（零 bash 依赖，支持 Windows PowerShell）
    ├── RED-BLUE-REVIEW.md           # 审查报告空白母版（严禁就地填写，每次拷至独立路径使用）
    └── prompts/
        ├── blue-team-prompt.md      # Blue 防守自证提示词模板
        ├── red-team-prompt.md       # Red 对抗证伪提示词模板（四视角 Lens）
        └── judge-prompt.md          # Judge 单一实证裁决提示词模板

[第一性原则]
    1. **自述不作数，落点才算数**：无论是 Blue 的自证还是 Red 的指控，凡给不出精确 `file:line` 或可复现命令路径的空泛说辞，Judge 一律不予采信。
    2. **一个 Error Finding 绝不被干净 Lens 否决**：哪怕其余三个 Lens 全部零问题，只要任一 Lens（尤其 `security` 或 `windows`）抓到有实证的阻断缺陷，就必须判 `FIX_REQUIRED`，严禁用「整体表现良好」和稀泥放行。
    3. **删除审计防家底退化**：当改动触及 `.cac/`（含 `.cac/rules/AGENTS.md`）或公共契约时，重点核查证据包中的「删除审计」清单，防止既有安全护栏或业务规则被静默误删。
    4. **母版零污染**：`.cac/skills/red-blue-review/RED-BLUE-REVIEW.md` 永远保持空白母版，每次审查必须先复制到 `.cac/.runtime/red-blue-review-<标识>.md`（或系统临时目录）再读写。

[四步对抗工作流]
    1. **第一步：创建本次报告副本并采集纯 Node 证据包**：
       - 复制母版 `.cac/skills/red-blue-review/RED-BLUE-REVIEW.md` 到 `.cac/.runtime/red-blue-review-<时间戳或分支名>.md`（记为 `$REPORT`）；
       - 运行 `node .cac/skills/red-blue-review/red-blue-pack.mjs [BASE] [HEAD]`（审未提交工作树传 `--working`）：若 ref 无效脚本会非零退出报错，先核准参数，绝不拿着空包往下走。
    2. **第二步：Blue Pass（摆靶子自证）**：
       - 参照 `prompts/blue-team-prompt.md` 派 fresh 子代理（或整理自证表），逐项列出「改了什么 / 跑过什么验证 / 证据落点 `file:line`」写入 `$REPORT` 的 Blue 节——明确该表仅作红队攻击靶子，不作放行依据。
    3. **第三步：Red Pass（四 Lens 证伪攻击）**：
       - 参照 `prompts/red-team-prompt.md` 派独立 fresh `code-reviewer`（大规模改动经用户同意也可按 Lens 并行扇出多路只读子代理），围绕四个 Lens 往死角挑刺并写入 `$REPORT`：
         - **`correctness`**：逻辑分支遗漏、空值/越界、并发竞态、与 `Product-Spec.md` 或 `docs/design/` 矛盾；
         - **`security`**：命令/SQL/XSS 注入、越权、密钥与路径泄露、破坏性操作无护栏；
         - **`release`**：安装升级冲突、产物缺漏、私货混入、无回退路径；
         - **`windows`**：Windows PowerShell 兼容坑、反斜杠路径未 `toPosix`、CRLF 正则失效、`fileURLToPath` 漏用、子进程漏 `windowsHide: true` 或 `.cmd` 启动报错。
    4. **第四步：Judge Pass（主 Agent 单一实证裁决）**：
       - 主 Agent 参照 `prompts/judge-prompt.md` 亲自核验 `$REPORT` 中每条 Red finding 的 `file:line` 与复现结果，逐条判定「采信 / 驳回 / 需求存疑（`spec-suspect`）」；
       - 输出最终三态结论写入 `$REPORT`：
         - **`ACCEPT`**：无采信的阻断缺陷，可放行合并或发版（同步将 `.cac/.needs-review` 置为 `clean`）；
         - **`FIX_REQUIRED`**：列出必修改造清单（含 `file:line`），派 `bug-fixer` / `implementer` 修复后重审；
         - **`NEEDS_MORE_EVIDENCE`**：关键风险面缺少实测复现证据，指明补测动作后重判。
       - 裁定过程中撞出的真实领域客观现象，按 `.cac/rules/domain-rulings.md` 分诊处理。

[初始化]
    执行 `[依赖检测]`，确认审查范围后运行 `node .cac/skills/red-blue-review/red-blue-pack.mjs` 生成证据包。
