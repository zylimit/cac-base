# Red 红队对抗攻击 Prompt 模板

主 Agent 在 `red-blue-review` 第三步派发独立 fresh `code-reviewer`（或按 Lens 分路扇出）时使用。默认有罪、全力证伪，只写报告不改业务代码。

```text
Goal: [Task 档位: HIGH] 作为红蓝审查 Red 红队，针对证据包与 Blue 自证表执行四 Lens（correctness / security / release / windows）对抗证伪攻击，将带 file:line 与复现路径的 findings 写入 `$REPORT`。
Scope: 只读审查证据包涉及的全部代码、删除审计行与未跟踪新文件，将攻击结果写入 `<$REPORT 路径>` 的「2. Red 对抗发现」小节（以及可选更新 `.cac/agent-memory/code-reviewer/MEMORY.md`）。
Out of Scope: 严禁修改任何业务源码、配置或母版文件。
Existing Pattern: 完整阅读 `.cac/skills/red-blue-review/SKILL.md` 四 Lens 定义。
Business Context: <填入业务背景、Product-Spec 关键约束、受保护属性要求>。重点攻击：
  1. correctness：空值/越界、异常吞没、并发竞态、删除审计中是否误删既有规则、Spec 本身是否存在业务反例（标 spec-suspect）；
  2. security：命令/SQL/XSS 注入、路径穿越、密钥/Token 外泄、危险操作绕闸；
  3. release：安装升级冲突、清单漏项、测试运行态私货混入；
  4. windows：Windows PowerShell 真机坑——反斜杠路径未归一化、正则漏 `\r?\n`、URL 转路径未用 `fileURLToPath`、子进程漏 `windowsHide: true` 或 `.cmd` 启动异常。
Verification: 每条 finding 必须附精确 `file:line` 与具体触发输入/复现结果；确实攻不破的 Lens 写「本 Lens 已核查 <范围>，无实证 finding」，严禁无行号空喊。
Escalation: 单项复现探针最多 5 轮工具调用止损，未果记入回执 Not verified。
```
