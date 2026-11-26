# audit —— 跑在引擎之外的独立审计脚本

`harness.mjs` 是治理引擎；这个目录是**不依赖它**的三只哨兵。

## 为什么故意不 import 引擎

1. **引擎坏了它们还得能跑**。`cac-base` 的模块化治理引擎（入口 `harness.mjs` + 核心共享库 `lib/*` + 可选大仓包 `ext/*`）
   一旦自身任一模块出现语法错或依赖缺失，所有走它的检查会同时失灵——而「检查失灵」绝不能与「检查通过」
   混淆。三只独立哨兵采用严格的**进程隔离设计**（零引擎 import、各自独立运行）：`check-syntax.mjs`
   要能在 `harness.mjs`、`lib/*` 或 `ext/*` 已经语法崩坏时独立告诉你它崩了。
2. **它们是 git hook / CI 的第一道**。这一层要能在没有 catalog、没有配置、
   甚至没装任何东西的仓库里直接 `node <path>` 就跑起来。引擎的定向能力
   （impact / verify / arch-check）无 catalog 一律 rc 3 降级，兜底面不能跟着降级。
3. **不受档位调节**。引擎侧的检查按模块档位收放（见 `.cac/harness/ext/rules/quality-attributes.md`），
   这是对的——但一个能被调到静音的底线不叫底线。这三只没有档位可调。

代价是有重叠（尤其 `scan-secrets` 与 fitness 的 `no-secret-literal`）。重叠是故意的。

## 三只哨兵

| 脚本 | 回答的问题 | 扫描面 |
|---|---|---|
| `scan-instructions.mjs` | 自动进模型上下文的指令文件里，有没有注入 / 凭据 / 外传 / 隐藏字符？ | `.cac/rules/AGENTS.md`、`.cac/rules/**.md`、`.cac/harness/ext/rules/**.md`、`**/skills/*/SKILL.md`、`.cac/agents/*.md`、`.cac/settings(.local).json`、子模块或异构根 `AGENTS.md`、`GEMINI.md`、`.cursorrules`、`.cursor/rules/**`、`.github/copilot-instructions.md`、`.windsurfrules` |
| `scan-secrets.mjs` | 提交面上有没有凭据字面量？ | 全部 tracked（或 staged）文本文件 |
| `check-syntax.mjs` | 框架自己的资产还解析得动吗？ | `.mjs/.cjs/.js`、`.json`、`.sh`、`.ps1`、SKILL.md 与 agents 的 frontmatter |

### scan-instructions.mjs

指令文件是**执行邻接**的输入：cac-base 会在人未必打开过它们的情况下把 `.cac/rules/AGENTS.md`、
各条 rules、每个 SKILL.md、每个 agent 定义送进模型上下文。2026 年的实测结论是
这已经是活跃攻击面——AI 指令文件里被发现过外泄的 API key 和被改写的模型 base URL，
README / 指令注入是被记录在案的劫持编码助手的手法。所以这个脚本把这些文件
**当不可信输入**扫，而不是当自家文档。

八条规则（除最后一条外都是 error 级）：

| 规则 | 抓什么 |
|---|---|
| `endpoint-override` | 端点与凭据落点的环境名被赋值——名字按「厂商词 + 前后缀通配 + 落点词」认（`ANTHROPIC_BEDROCK_BASE_URL` 这种中缀形态、`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` 这两个无前缀凭据落点都在内），另认 Windows 的 `setx NAME value` 空格形态和各类 `*_PROXY` |
| `embedded-credential` | 与 `scan-secrets` 同一张格式表：`sk-ant-` / `sk-proj-` / `sk-` / `ghp_` / `github_pat_` / `glpat-` / `AKIA` / `AIza` / `hf_` / `npm_` / `xox?-` / JWT 三段式、PEM 私钥块 |
| `instruction-override` | `ignore previous instructions` 一类话术——仓库提供的文本是权限最低的一层，声称自己更高的文本就是注入 |
| `exfiltration-command` | `curl` / `Invoke-WebRequest` 带上传参数（`-d` / `--data` / `-F` / `-T` / `-Method Post`），`wget` 按它自己的上传参数认（`--post-data` / `--body-file`；`-T` 在 wget 是超时，不是上传），或 `nc` 反连 |
| `silent-execution` | 下载管道直灌 shell（`curl ... \| sh`、`iex (iwr ...)`) |
| `hidden-characters` | 零宽与双向控制字符——人看不见而模型读得到的文本，按构造就是为了逃过审查 |
| `gate-disable-instruction` | `--no-verify`、`skip the hook/gate/check/test`、`disable the lint`——教唆绕自己的闸。**只认肯定祈使**：同一子句里带 never / do not / must not / forbidden / 禁止 / 不许的反向禁令不报，命中数计进 `counts.prohibitionSkips` |
| `secret-file-read`（warning） | 文本点名 `.env` / `id_rsa` / `.ssh/` / `.aws/credentials` / `.npmrc` |

`.cac/settings.json` 也在扫描面内：它不是散文，但 `env` 块正是改写 `ANTHROPIC_BASE_URL` / `CODEAGENT_BASE_URL`
的落点，而 `codeagent` 读它同样不需要人先打开。JSON 的键带引号（`"KEY": "v"`），
`endpoint-override` 因此在名字和分隔符之间容一个可选引号——只认 `KEY=` 的写法会把
整个 JSON 形态放过去。

### scan-secrets.mjs

不分级、不看 catalog、给 git hook 和 CI 用的兜底面。二进制按 NUL 字节探测跳过
（不靠扩展名猜），超过 1 MB 的文件**记进 `degraded` 并让整次运行退 3**——
「文件里有 token 但没人看过」和「扫过了很干净」必须是两个退出码。
`*.example` / `*.sample` / `*.template` / `.env.example` 走白名单（这是范围之外，
不是没扫成，仍按 rc 0 算）。submodule（gitlink，mode 160000）同属「范围之外」而不是
「没扫成」——它在本仓根本没有字节。把它记成降级会让任何带 submodule 的仓恒退 3，
而恒红的闸等于没有闸，接闸的人下一步就是忽略 rc 3。

规则分两类，处理方式不同：

- **confident**（`ghp_` / `github_pat_` / `glpat-` / `sk-ant-` / `sk-proj-` / `sk-` /
  `AKIA` / `aws_secret_access_key` 的 40 字符值 / `AIza` / `hf_` / `npm_` / `xox?-` /
  stripe live key / JWT / PEM 块）——形状本身就没有无辜解释，**不做上下文豁免**。
  这张表是这只脚本的价值所在：只认 `ghp_` 而不认 `sk-ant-` / `github_pat_` 的表，
  对今天真正在泄的东西一律报干净。
- **heuristic**（`password=` / `api_key=` 这类赋值猜测，只有 `generic-assignment` 一条）——
  同一行出现 `example` / `placeholder` / `process.env` 等占位语境时跳过；此外**值必须是字面量**：
  裸值只许由 `[A-Za-z0-9_+=-]` 组成（带 `.` `(` `[` `$` `/` 的是表达式、路径或变量引用，
  `password = self.password.encode(...)` / `passwd = fallback_getpass(prompt, stream)` /
  `api_key = os.environ["X"]` 全是「从别处读密钥」这个正确写法），且必须字母数字混合、
  不同字符数 ≥6（`the-value-you-copied` 这种散文词组不算凭据）。
  引号不再是判据本身——dotenv 与 YAML 最常见的写法本就不带引号；但「不带引号」放开时
  必须把「值得是字面量」这条一起接住，否则规则会淹掉：同一份 250 万行零密钥真实语料
  （python stdlib / dist-packages / node_modules / TypeScript），**放宽引号后 277 命中、
  加上字面量判据后 4 命中，真阳性一条不少**。

### check-syntax.mjs

cac-base 把行为写在配置里：hook 与工程脚本统一是纯 Node `.mjs`（外加安装入口 `.sh`/`.ps1`），引擎是 `.mjs`，接线是 `.json`，
而每个 skill 与 agent 是一份靠 YAML frontmatter 决定「是否被加载」的 Markdown。
**畸形 frontmatter 不报错，skill 只是不存在了**——这是本仓最贵的静默失败，
所以它单独占一类检查。

- `.mjs/.cjs/.js` → `node --check`
- `.json` → `JSON.parse`
- `.sh` → `bash -n`
- `.ps1` → `[System.Management.Automation.Language.Parser]::ParseFile`（批量一次调用）
- SKILL.md / `.cac/agents/*.md` / `.cac/rules/*.md`（注：主控 `.cac/rules/AGENTS.md` 强制要求无 frontmatter 头以保持宿主启动自动注入，其余细则 frontmatter 可选）→ frontmatter 能否被解析（`---` 包裹，
  `key: value`、嵌套映射、列表项、注释、可跨行的引号标量、块标量）

这里没有 YAML 解析器（零依赖，而且手搓一个的下场就是和真正的加载器意见相左），
所以子集收窄到 `codeagent` frontmatter 实际用到的构造（额外支持单行简单字符串数组如 `["a", "b"]`）。**超出子集的写法
（流式集合 `{}` `[]`、锚点 / 别名 / 标签、显式键、合并键、指令行）报
`UNDECIDABLE`**——不判对也不判错，只说这个检查器不裁定，同样计退出码 3。

判失败的是这些（每条都对着 `yaml.safe_load` 逐条核过，方向全是「真 YAML 非法而这里
放过了」的假阴——那是最坏的一种错，读起来是绿的、真加载器却把整个 skill 丢掉）：

- 裸值里出现 `": "` 或以 `:` 结尾。**这是本仓最可能踩的一格**：skill / agent 的
  `description:` 就是长句散文，补一个 ASCII 冒号（`description: ... 触发: 用户要求审查代码`）
  就非法，而畸形 frontmatter 不报错、skill 只是不存在了。
- 裸值以 YAML 保留指示符 `@` / 反引号 / `%` 开头，或以 `- ` 开头（那是序列项），
  或块标量头写坏（`|literal` 这种指示符后直接接文本）。
- 缩进栈对不上的错误 dedent（4 空格进去、2 空格出来）——只跟上一个 key 比缩进看不出来。
- 块标量正文的缩进区里出现制表符；以及顶层的制表符缩进、跨行未闭合的引号。
- 已经带标量值的 key 底下再出现 `key: value`（标量之下不能挂映射）。

`--staged` / `--paths` 与另外两只同义：`--staged` 从索引取内容（外部解析器只能读真文件，
所以索引内容会落进临时副本再交给 `node --check` / `bash -n` / PowerShell 解析器，
报错里的临时路径会被换回原路径），`--paths` 只收窄文件集、不改内容来源。

**规模边界**：每个文件起一次子进程，实测 500 个 `.mjs` + 300 个 `.sh` 耗 **8.8 s**
（node v24 / Linux）。按这个斜率，几千个文件的仓库用 `--staged` 或 `--paths` 收窄到
待提交集才跑得动，全量扫适合放进 CI 而不是每次 commit。批量化解析是后续的事。

**缺检查器 = SKIPPED，不是 PASS**：没有 bash 或没有 pwsh 时，该类被显式打印为
`SKIPPED`、写进 JSON 的 `skipped` 字段，**并让 `ok` 为 false、退出码为 3**。
26 个 `.ps1` 一个没验却报 rc 0 `ok:true`，读起来就是「验过了，没问题」——
而实际发生的是没人打开过它们。
PowerShell 侧包一层「wrapper 永远 exit 0、坏文件走 stdout」，这样
**语法错**和**检查器自己炸了**不会被混为一谈——后者报成 `ps1-checker` 失败。

## 共同契约

- **stdout 永远是单行 JSON**，人读诊断一律走 stderr；`--json` 关掉 stderr 人读行。
- 退出码：`0` **范围内全扫过且干净** / `1` 有命中 / `2` 参数错（拼错的 flag、悬空的
  `--paths`、`--paths` 点名的路径一个都不存在）/ `3` **降级**——非 git 仓（**拒绝猜文件集**）、
  该扫却没扫成（超限、读不动、整类没检查器、超出可判定子集、`--paths` 部分路径不存在）。
  `0` 和 `3` 的分界就是这三只存在的理由：**没扫到永远不许读作干净**，
  所以 `ok` 在降级时同样是 false。命中优先于降级（真命中更可执行，且 git hook 本来就卡 1）。
- **「没东西可扫」不是降级**。清单取到了、里面没有本检查器认识的类（只提交文档的 commit、
  空暂存集、全是图片的仓），报 `notes` 里的 `nothing-in-scope` 并**退 0**，输出里
  `listed` 与 `in-scope` 两个数都在。把它算降级会让每个文档 commit 都亮一次黄灯，
  而恒亮的灯和不亮没区别——这三只自己就是靠「恒红=没红」这条立论的。
  唯一的例外是 `listing-empty-but-repo-nonempty`：tracked 模式一个都没列出来、
  但 HEAD 里明明有文件——那是清单机制不再描述这个仓（子目录那个 bug 从外面看就长这样），
  单列一个 kind、退 3，不和 `nothing-in-scope` 混。
- **一律以仓根为基准**：先 `git rev-parse --show-toplevel` 定位再进去跑，文件清单、
  内容读取、报告路径共用一个原点。`git ls-files` 在子目录只列该子树、且按该子目录相对命名，
  所以从 `.cac/` 里跑曾经让三只同时报 rc 0 `ok:true`——同一个仓、同样的三处真缺陷，
  换个当前目录就全绿。**当前目录不许参与安全判定**。
- `--staged`、`--paths` 与 `--json` **三只哨兵（`scan-secrets`、`scan-instructions`、`check-syntax`）全部支持**。
  其中 `--staged` 的文件名**和内容都来自索引**（`git diff --cached` + `git show :<path>`）：
  从索引取名单、却从工作树读内容，会同时制造漏报和误报（暂存了密钥再把磁盘擦干净会放过去，
  只存在于磁盘上的改动会拦住一次并不包含它的 commit）。默认模式走 `git ls-files` + 工作树，
  两者都用 `-c core.quotePath=false` + `-z`，非 ASCII 文件名不会被转义打断。
  代价：`--staged` 每个文件起一次 `git show`，面向的本来就是体量小的待提交集。
- `--paths`（三只哨兵全部支持 `--paths a,b` 或 `--paths=a,b`）**只收窄文件集，
  不改内容来源**。`--staged --paths X` 仍然判索引——让 `--paths` 悄悄把 `--staged` 吃掉，
  等于给「工作树内容冒充待提交内容」留后门。
  点名的路径不存在时按**程度**分档：**部分**不存在 → 剩下的照扫、缺的逐条进 `degraded`
  的 `path-not-found`、退 3（不许把「只扫到一半」读成扫完了）；**一个都不存在** → 退 2，
  因为这时候这条命令面对的根本不是这个仓（跑错目录、参数写错、清单过期），属参数错。
  两种情况都不会静默：扫零个「你要我扫的文件」然后报干净，正是这一族脚本要防的那种绿。
- 源码为 UTF-8 无 BOM，零 npm 依赖，仅使用 Node >= 20 内置模块，所有子进程显式 `shell: false, windowsHide: true`。
- **命中不回显原文**：凭据类命中的 excerpt 会做 REDACTED 处理。扫描器把密钥
  原样打进 CI 日志，等于替攻击者又发布了一次。
- 用 `fs.writeSync` 而不是 `process.stdout.write` 输出契约行——管道上的异步写
  遇到进程退出会截断，截断的 JSON 是看不见的失败。

## 豁免与压制：按「被扫文件可不可信」分治，杜绝静默盲区

**`scan-instructions.mjs` 既不设行内忽略注释，也不设外部静默白名单文件**。
这个脚本的全部立论是「被扫指令文件不可信」：若允许行内 `ignore` 标记，能写进注入载荷的人同样能写进那行静音；
若引入外部白名单文件，容易演变为无人复核的过期盲区或随仓自带的免检后门。
因此 `scan-instructions.mjs` 直接在规则求值层采用三项确定性机制区分「攻击载荷」与「正当治理禁令/配置」：

1. **肯定式指令匹配（`affirmativeOnly`）**：`endpoint-override`、`instruction-override`、
   `exfiltration-command`、`silent-execution`、`gate-disable-instruction` 五条行为诱导类规则声明
   `affirmativeOnly: true`；而 `embedded-credential` 与 `hidden-characters` 不设语境豁免，任何位置出现均直接报 error。
2. **禁止语境豁免（`PROHIBITION`）**：对 `affirmativeOnly` 规则，扫描器检查命中位置前同一子句
   （按 `[.;:!?。；！？]` 切分）及整行是否包含禁止/拦截语境词（英文 `never` / `do not` / `must not` /
   `forbidden` / `prohibited` / `block` / `deny` 等，中文 `禁止` / `不许` / `不得` / `不要` / `严禁` /
   `拦截` / `阻断` / `拒绝` / `切勿` 等）。命中禁止语境说明该行是在声明安全红线（如「严禁使用 `--no-verify`」
   或「禁止改写 `ANTHROPIC_BASE_URL`」），自动跳过报错并将跳过次数显式计入 JSON 输出的 `counts.prohibitionSkips`。
3. **路径与配置级例外正则（`except`）**：对 `secret-file-read`（warning），内置 `except` 正则豁免合法样例模板路径
   （`.env.example` / `.sample` / `.template` / `.dist`）以及 `.cac/settings.json` 中宿主权限拒绝声明（`"Read(...)"`）；
   仅当剥除 `except` 匹配片段后该行仍命中敏感文件路径时才报 warning。

**`scan-secrets.mjs` 支持有痕行内压制**（本行或上一行含 `scan-secrets:ignore` 或 `harness-fitness:ignore`）：
仅压制文件内容规则（凭据字面量与非本地明文传输 `no-insecure-transport`；凭据文件路径规则 `no-credentials-files`
按文件名拦截，不受正文注释豁免），且**每一条被压掉的命中都打进 stderr 的 ` mute ` 行并记入 JSON 的
`suppressed`（计入 `counts.suppressed`）**，只记 `file/line/rule`、不回显凭据原文。无痕压制一律不允许。

## 怎么跑

```bash
node .cac/harness/audit/scan-instructions.mjs                    # 全部 tracked + 未跟踪指令文件
node .cac/harness/audit/scan-instructions.mjs --staged           # 只看待提交索引中的指令文件
node .cac/harness/audit/scan-instructions.mjs --paths .cac/rules/AGENTS.md --json
node .cac/harness/audit/scan-secrets.mjs --json                  # 机器消费
node .cac/harness/audit/scan-secrets.mjs --staged --paths a.ts   # 指定路径扫暂存索引
node .cac/harness/audit/check-syntax.mjs
node .cac/harness/audit/check-syntax.mjs --staged                # 待提交内容的语法（git hook 用这个）
node .cac/harness/audit/check-syntax.mjs --paths a.mjs,b.sh      # 只验点名的几个

node --test .cac/tests/audit.test.mjs                            # 三只哨兵的回归测试与缺陷红锁
```

## 与 harness `fitness` 的分工

| | `fitness`（引擎内） | `scan-secrets`（本目录） |
|---|---|---|
| 位置 | `verify` 质量门内 | git hook / CI 第一道 |
| 分级 | 按 module-catalog 的模块档位收放，属性声明 `none` 即静音 | 无档位、无开关 |
| 依赖 | catalog（无 catalog 时失去分级） | 无 |
| 语义 | 「这个模块持有它档位要求的证据吗」 | 「有没有凭据要被提交，是或否」 |
| 规则面 | 五性五条（密钥 / 日志 PII / 静默吞错 / 无界重试 / 未挂单 TODO） | 只管凭据字面量 |

要真证据（历史提交里的密钥、SAST、依赖漏洞），接
`.cac/harness/adapters.json` 里的 `secrets-gitleaks` / `sast-semgrep` 等外部工具，
按属性走 verify 门。见 `.cac/harness/ext/rules/quality-attributes.md`。

## 已知盲区（别把这三只当证明）

1. **正则不是证明**。这里做的是词法扫描：能减少「没人查过」的面，不能证明
   「不存在」。没被命中只说明没匹配上已知形状。
2. **扫的是工作树，不是历史**。已经提交进 git 历史的密钥，这里一个都看不见——
   那是 `gitleaks` 之类工具的活。轮换密钥永远比删文件重要。
3. **`scan-instructions` 只认路径形状**。用别的名字加载的指令文件（自定义
   `--append-system-prompt`、MCP 服务器下发的提示词、issue / PR 正文）不在扫描面内。
   模式表在脚本顶部，新载体要手工加。
4. **`scan-secrets` 的凭据文件路径规则只认常见扩展名与文件名**。`no-credentials-files` 拦截
   `.env*`（排除 `.example`/`.sample`/`.template`/`.dist`）、`id_rsa*`、`id_ed25519*`、
   `credentials.json` 及 `*.pem|p12|pfx|key|ppk`，但自定义命名的二进制密钥库（如 `keystore.dat`）
   若既不命中路径后缀又含 NUL 字节被二进制跳过，仍会漏检。
5. **`check-syntax` 只证明「解析得动」**。解析通过的 hook 仍然可能逻辑全错，
   frontmatter 解析通过也不代表 `name` / `description` 写对了（这一层归引擎
   `harness.mjs skills-lint`）。
6. **`node --check` 的解析目标随 node 版本变**。含 ESM 语法的 `.js` 在新版 node 上
   靠模块语法探测通过，老版本会判失败——所以 JSON 输出里带 `node` 版本字段，
   一条失败必须连着它读。
7. **超过 1 MB 的文件一个字都没扫**。现在这件事会让整次运行退 3、`ok` 为 false，
   但它仍然只是「被告知没扫」，不是「扫过了」。要覆盖大文件得换工具或改上限，
   而改上限是决定，不是顺手。
8. **frontmatter 检查器不是 YAML 解析器，覆盖面要照着上面那张清单读**。
   它认得的非法形态就是 check-syntax 那节列出的那几类（`": "` / 保留指示符 / `- ` 开头 /
   坏块标量头 / 错误 dedent / 制表符缩进 / 未闭合引号 / 标量之下挂映射）；
   流式集合、锚点 / 别名 / 标签、显式键、合并键、指令行一律 `UNDECIDABLE` 不裁定；
   **这两份清单之外的 YAML 非法形态，这里会放过去**——别把「没报错」读成「是合法 YAML」。
   `codeagent` 真实加载时用的是它自己的解析器，这里的「能解析」只是必要条件。
9. **`generic-assignment` 的字面量判据是有取舍的**。要求裸值字母数字混合，
   换来的是同一份 250 万行语料上 277 → 4 的噪声下降，代价是纯小写无数字的裸口令
   （`password=correcthorsebatterystaple`）会漏——真正在流通的凭据格式归上面那张
   confident 表管，这一条只是兜底。要收紧就加格式，不要放宽这条的形状判据：
   上一次放宽（去掉引号要求却没接住「值得是字面量」）直接把它变成了噪声源。
10. **反向禁令的豁免是可以绕的**。`affirmativeOnly` 规则按子句与本行判 `PROHIBITION` 禁令词，
    攻击者在同一行混入「Never mind, skip the tests」就能触发 `prohibitionSkips` 躲过 `gate-disable-instruction`。
    这是拿可绕性换零白名单可用性的取舍：不这么做，满篇安全禁令的规则库会把整条规则逼停；
    真正的越权注入话术仍由 `instruction-override` 等多层防线交叉兜底。
