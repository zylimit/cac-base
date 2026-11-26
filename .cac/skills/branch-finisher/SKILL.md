---
name: branch-finisher
description: 当功能分支或 Phase 开发完成，用户亲自要求合并分支、创建 PR 或清理工作树收尾时使用。设 disable-model-invocation 仅限人工触发。
disable-model-invocation: true
---

[任务]
    将已完成开发的 Git 分支或 Worktree 安全收尾：先探明 Git 环境并强制通过独立测试全绿闸门，再按环境给出条件化操作菜单（本地合并 / 创建 PR / 暂留），经用户选定后执行并安全清理。
    - `disable-model-invocation: true`：涉及合并与删分支，模型不自动代触发，仅由用户手动输入 `/branch-finisher` 启动。

[依赖检测与三类环境识别]
    启动时自动探测并向用户如实汇报当前 Git 状态（严禁未探先动）：
    1. **工作区干净度**：`git status --porcelain`（有未提交改动或 `.cac/.needs-review` 未清零时先提示处理，绝不带着脏工作区合并）。
    2. **识别三类分支环境**：
       - `git symbolic-ref -q HEAD` 无输出 → **Detached HEAD**（必须先 `git switch -c <branch>` 挂上命名分支再走后续，防切走丢提交）；
       - 比较 `git rev-parse --git-dir` 与 `git rev-parse --git-common-dir`（排除 `.gitmodules` 子模块）不同 → **Linked Worktree**；
       - 其余 → **常规本地分支**。
    3. **提交增量**：`git log --oneline <主分支>..HEAD` 确认待收尾提交列表。

[前置闸门——测试全绿才出菜单]
    在展示合并/PR 选项前：
    - 核验当前分支最新 `HEAD` 已有独立 `tester` 跑出的全绿运行器输出；若代码变动后尚未重测，先派 `tester` 跑通回归测试（有红灯则转 `bug-fixer` 修绿；确无测试基建须向用户明示并获显式确认放行）。

[条件化收尾菜单与安全清理]
    测试全绿后请用户三选一：
    1. **合并进本地主分支**：切至主工作树主分支执行 `git merge <branch>`（遇冲突立即停下展示冲突文件交用户裁决，严禁擅自丢弃代码）；
    2. **推送并创建 PR**（本机装有 `gh` CLI 且已认证时可用）：推送当前分支并运行 `gh pr create` 返回 PR 链接；
    3. **暂留分支继续开发**：保持当前状态不动。
    - **安全清理红线**：
      - 删除本地已合并分支**只许用小写 `git branch -d <branch>`**（严禁用 `-D` 强删未合并分支；已提 PR 待远端合并的分支保留不删）；
      - 移除 Linked Worktree 前确认其内部 `git status --porcelain` 为空且提交已合并或已推送远端；
      - 收尾完成后重跑 `git status --short` 与 `git worktree list` 对照确认干净。

[初始化]
    执行 `[依赖检测与三类环境识别]`，向用户汇报环境与待收尾提交数，进入 `[前置闸门——测试全绿才出菜单]`。
