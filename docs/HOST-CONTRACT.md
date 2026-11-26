# HOST-CONTRACT — CodeAgent CLI (`codeagent`) 真机实证契约

> 实测基线：Windows 11 PowerShell + `codeagent` `1.2615.02.05 (codeAgentCLI)`（2026-11-26 真机沙箱抓包验证）。  
> 本文件记录所有经真机证实的宿主协议事实与设计边界，杜绝猜测。

## 1. CLI 与环境事实（`[确认]`）

| 维度 | 真机实测事实 | `cac-base` 工程落地 |
|---|---|---|
| 可执行程序名 | Windows 下命令名为 **`codeagent`**（版本串 `1.2615.02.05 (codeAgentCLI)`，非 `cac`） | `doctor.mjs` 与安装脚本按序探测 `codeagent` → `codeAgentCLI` → `codeagentcli` → `cac` |
| 配置目录 | 项目级 `.cac/`，用户级 `~/.cac`（`CODEAGENT3_CONFIG_DIR`） | 原生使用 `.cac/` 维护全量框架配置 |
| 非交互 / 追踪模式 | 支持 `-p / --print`、`--output-format json\|stream-json`、`--include-hook-events`、`--show-execution-trace`、`--worktree` | 支持自动化 CLI 真触发探针测试 |
| 权限模式 | `--permission-mode` 支持 `acceptEdits / bypassPermissions / default / dontAsk / plan / auto`（Windows 默认会话为 `auto`） | 只读子代理声明 `permission_mode: plan` + 最小 `tools` 白名单 |
| Hook 注入环境变量 | 注入 **`CODEAGENT3_PROJECT_DIR`**（Windows 下亦为正斜杠路径，如 `C:/Users/.../proj`）、`CODEAGENT3_CONFIG_DIR`、`CODEAGENT3_WINDOWS_SHELL_TYPE`（如 `bash`）、`CODEAGENT3_X_AUTH_TOKEN` | 项目根解析优先级：`CODEAGENT3_PROJECT_DIR` → `CAC_PROJECT_DIR` → `stdin.cwd` → `git rev-parse --show-toplevel` → `process.cwd()`；`secret-exfil-guard` 额外保护 `CODEAGENT3_X_AUTH_TOKEN` / `X_AUTH_TOKEN` / `DEVUC_REFRESH_TOKEN` / `ENTERPRISE_API_KEY` |

## 2. 规则、权限与技能加载事实（`[确认]`）

1. **隐藏目录顶层候选文件不自动加载**：在 Windows 内网真机 PowerShell 沙箱（根目录零 `.md` 文件 + `--disallowedTools "Read Glob Grep Bash"` 禁用全部文件读取与搜索工具）中实测，`.cac/AGENTS.md`、`.cac/CLAUDE.md`、`.cac/CODEAGENT.md` **均不会**被 `codeagent 1.2615.02.05` 自动加载。
2. **无 `paths:` YAML frontmatter 的 `.cac/rules/*.md` 启动原生自动注入（核心实证！）**：同一禁工具沙箱实测输出 `[HIT-4-CAC-RULES]`（及探针暗号 `[AGENTS-MD-OK]`），证实**不含 `paths:` frontmatter 的 `.cac/rules/*.md` 会在会话启动时被 `codeagent` 原生自动注入系统规则**！
   - **落地对策（v1.1.0 根目录零文件入侵架构）**：将主控宪法收纳于 **`.cac/rules/AGENTS.md`**（大写 `A` 字典序排在所有小写细则之前，且无 `---` YAML frontmatter、严禁出现 `paths:` 字段，由 `doctor.mjs` 与 `check-syntax.mjs` 双重硬检守护）。默认安装 `cac-base` 后目标项目**根目录零新增文件**（仅创建 `.cac/`），与 `cc-base`（`.claude/`）、`agy-base`、Cursor、Codex 以及业务项目自有的根 `AGENTS.md` 彻底零文件冲突共存；同时 `.cac/rules/AGENTS.md` 纳入 `.cac/FRAMEWORK-MANIFEST.json` 常规受管文件享受三路 LF-SHA256 无损升级（本地改动自动旁落 `.cac/rules/AGENTS.md.cac-base-new`）。
3. **带 `paths:` YAML frontmatter 的 `.cac/rules/*.md` 不自动加载**：实测读取 `src/hello.txt` 后，`.cac/rules/src-rule.md`（含 `paths: ["src/**"]`）既不会在会话启动时自动注入，也不会在触及匹配路径时自动注入。
   - **落地对策**：6 份核心细则与 2 份大仓扩展细则保留 `paths:` frontmatter（避免启动时全量灌入浪费上下文），同时在 `.cac/rules/AGENTS.md` 中对每份细则写死**强制前置 `Read` 指针**（执行对应阶段或派单前必须显式 `Read` 对应 `.cac/rules/*.md`）。
4. **与 `.claude/` 同仓物理绝缘**：通过 `--debug-file` 抓取完整启动扫描日志（`settings`、`loadSkillsDir`、`markdownConfigLoader`、`changeDetector`、`skillChangeDetector` 共 900 行）实测确认，`codeagent` 全程对同目录下的 `.claude/`、`CLAUDE.md`、`.claude/rules/` **0 扫描、0 命中**（同时支持项目私有目录 `.cac/local/{agents,commands}`）。因此 `cac-base`（`.cac/`）与 `cc-base`（`.claude/`，含复用它的 Cursor / Antigravity）可在同一业务仓库物理级绝缘共存（注：若同仓配置 Antigravity，应使用 `.agents/rules/*.md` 而非项目根 `AGENTS.md`，避免被 `codeagent` 连带读取根 `AGENTS.md`）。
5. **`permissions.deny` 原生生效**：`.cac/settings.json` 中 `"Read(.env)"` 等规则在进入 `PreToolUse` 前即由宿主直接拦截（`File is in a directory that is denied by your permission settings.`）。
6. **`disable-model-invocation: true` 原生生效**：Skill frontmatter 声明 `disable-model-invocation: true` 时，模型自动调 `Skill` 工具会被宿主拒绝（`Permission for this action has been denied`），仅允许用户手动敲 `/skill-name` 调用。

## 3. Hook 事件、工具名与 I/O 协议事实（`[确认]`）

### 3.1 注册形态与进程执行
- `.cac/settings.json` 中 `string form`（`"type": "command", "command": "node .cac/hooks/<name>.mjs"`）在 Windows PowerShell 启动的 `codeagent` 中 **100% 正常触发**，且 `cwd` 为项目根目录。
- Windows 下默认 `CODEAGENT3_WINDOWS_SHELL_TYPE=bash`（Git Bash），但也可能运行 PowerShell 命令；因此安全地板闸同时解析 **POSIX Bash 与 Windows PowerShell** 语法。

### 3.2 实测工具名与 `tool_input` 结构
| 动作 | `tool_name` | `tool_input` 实测字段 |
|---|---|---|
| 执行命令 | `Bash`（兼容匹配 `Bash\|PowerShell\|Shell`） | `{ command: string, description?: string }` |
| 读文件 | `Read` | `{ file_path: "C:\\..." }`（Windows 下传反斜杠绝对路径） |
| 搜文件/内容 | `Glob` / `Grep` | `{ pattern: string, path?: string }` |
| 改/写文件 | `Edit` / `Write` | `{ file_path: "C:\\...", ... }` |
| 派发子代理 | `Agent`（兼容匹配 `Agent\|Task`） | `{ description: string, prompt: string, subagent_type: string, run_in_background?: boolean }` |
| 调用技能 | `Skill` | `{ skill: string, args?: string }` |

### 3.3 子代理身份透传（支撑 `no-direct-code-guard` 硬拦）
- 主 Agent 工具调用事件：**不含** `agent_id` 与 `agent_type`。
- 子代理内部触发的 `PreToolUse` / `PostToolUse` 事件：**原生携带 `"agent_id": "<hex>"` 与 `"agent_type": "<role-name>"`**！
- 因此 `no-direct-code-guard.mjs` 在 `standard` 与 `strict` 档均可精准拦截主 Agent 直接写业务代码，同时对 `agent_type` 属于写码子代理（`implementer` / `tester`）的事件精准放行，零误伤。

### 3.4 `SubagentStart` / `SubagentStop` / `Stop` Stdin 结构
- **`SubagentStart`**：`{ session_id, transcript_path, cwd, agent_id, agent_type, hook_event_name: "SubagentStart" }`
- **`SubagentStop`**：`{ session_id, transcript_path, cwd, agent_id, agent_type, hook_event_name: "SubagentStop", stop_hook_active: boolean, agent_transcript_path: "...\\subagents\\agent-<id>.jsonl", last_assistant_message: string }`
- **`Stop`**：`{ session_id, transcript_path, cwd, permission_mode, hook_event_name: "Stop", stop_hook_active: boolean, last_assistant_message: string }`

### 3.5 阻断与上下文注入协议
1. **`PreToolUse` 阻断（双通道均实证有效）**：
   - **通道 A（退出码）**：向 `stderr` 输出原因并设 `process.exitCode = 2`。
   - **通道 B（JSON 决策）**：`exit 0` 并输出 `{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "..." } }`。
2. **`Stop` / `SubagentStop` / `PreCompact` 阻断**：
   - 输出 `{ decision: "block", reason: "..." }`（`exit 0`，**不设 `continue: false`**——顶层 `continue: false` 的语义是立即终止本轮会话而非打回重做）。
   - 必须检查 `if (ev && ev.stop_hook_active) return;`（配合三振熔断），防止重入死循环。
3. **上下文注入（`SessionStart` / `UserPromptSubmit` / `PostCompact` / `SubagentStop`）**：
   - 输出 `{ hookSpecificOutput: { hookEventName, additionalContext: "..." } }`；提示用户信息使用 `{ systemMessage: "..." }`。

## 4. 宿主不支持 / 明确降级与替代项

| `cc-base` 机制 | `codeagent` 状态 | `cac-base` 原生替代方案 |
|---|---|---|
| `.claude/rules/` `paths:` 自动注入 | 带 `paths:` 头不自动注入；无 `paths:` 头的 `.cac/rules/*.md` 启动自动注入 | 主控宪法放无头的 `.cac/rules/AGENTS.md` 启动自动注入；下沉细则带 `paths:` 头并由宪法前置指针显式 `Read` |
| `Dynamic Workflows` (`code-review-fanout.js`) | CC 专属 | 主 Agent 按维度并行调多次 `Agent(subagent_type: "code-reviewer")` + 主 Agent 汇总裁定（须用户 opt-in） |
| `UserPromptExpansion` 事件 | 无独立展开事件 | 双重防线：`PreToolUse(Skill)` 匹配 `skill === "release-builder"` + `UserPromptSubmit` 匹配 `/release-builder` |
| `PostToolUse` `asyncRewake: true` | 无后台唤醒 | 由 `PreToolUse(Bash)` 的 `pre-commit-check` 同步门与 `/gate` 兜底 |
| `subagent_type: "fork"` | 无会话克隆 | 主 Agent 显式传递本轮决策/反馈结构化摘录与相关文件路径给 `progress-recorder` / `feedback-observer` |
| Agent `memory: project` | 无自动挂载 | `code-reviewer` / `tester` 启动时显式读写 `.cac/agent-memory/<role>/MEMORY.md`（单文件 ≤5KB、角色总计 ≤50KB，超限搬 `docs/agent-notes/<role>/`） |
| `statusLine` / `terminalSequence` | 无状态栏配置 | 由 `SessionStart` 横幅 + `node .cac/scripts/project-status.mjs` + `harness tier status` 提供 |
