// io.mjs — hook 侧最小 I/O 契约（stdin / stdout / stderr / 退出码 / 外部命令 / 路径 / 档位总闸）。
//
// 进程级隔离铁律：绝不静态或动态 import .cac/harness/lib/*。当治理引擎损坏或未装大仓包时，
// 会话内 Hook 护栏仍必须独立存活并准确报出降级/阻断。
//
// 输出一律 fs.writeSync：管道下 process.stdout.write 异步退出会截断 JSON。
// 所有子进程调用统一 shell: false + windowsHide: true。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isatty } from 'node:tty';

/** 反斜杠→正斜杠（无条件归一，兼容 Windows PowerShell 传入的反斜杠路径）。 */
export function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

/**
 * 读文本文件：仅 ENOENT 视为 absent，其余 I/O 错误单独返回，避免把「损坏/无权限」伪装成「未创建」。
 * @returns {{text:(string|null),absent:boolean,error:(Error|null)}}
 */
export function readTextFile(file) {
  try {
    return { text: fs.readFileSync(file, 'utf8'), absent: false, error: null };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { text: null, absent: true, error: null };
    return { text: null, absent: false, error: e };
  }
}

const STDIN_WAIT_MAX_MS = 3000;
const STDIN_RETRY_MS = 5;

/**
 * 同步循环读取 fd 0 直至 EOF；大事件分块到达遇 EAGAIN / EWOULDBLOCK 时用 Atomics.wait 等待重试，
 * 杜绝读半截吞错放行。终端交互（isatty(0)）直接返回空串。
 */
export function readStdinRaw() {
  if (isatty(0)) return '';
  const chunks = [];
  const buf = Buffer.alloc(64 * 1024);
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  let waited = 0;
  for (;;) {
    let n;
    try {
      n = fs.readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      const again = e && (e.code === 'EAGAIN' || e.code === 'EWOULDBLOCK');
      if (again && waited < STDIN_WAIT_MAX_MS) {
        Atomics.wait(sleeper, 0, 0, STDIN_RETRY_MS);
        waited += STDIN_RETRY_MS;
        continue;
      }
      break;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 读完 stdin 并解析 JSON：空输入 → {}；解析失败或非普通对象 → null。 */
export function readStdinJson() {
  const raw = readStdinRaw();
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
  } catch (_e) {
    return null;
  }
}

/**
 * 提取子代理标识；主 Agent 事件返回空串。
 * 优先级：ev.agent_id → agent_transcript_path/transcript_path 中的 subagents/<id> → parent_tool_call_id。
 */
export function subagentIdOf(ev) {
  if (!ev || typeof ev !== 'object') return '';
  if (ev.agent_id) return String(ev.agent_id);
  const tp = toPosix(String(ev.agent_transcript_path || ev.transcript_path || ''));
  const m = /(?:^|\/)subagents\/([^/]+?)(?:\.jsonl)?$/.exec(tp);
  if (m) return m[1];
  if (ev.parent_tool_call_id) return String(ev.parent_tool_call_id);
  return '';
}

/** 跑外部命令：一律 shell: false + windowsHide: true + argv 数组。 */
export function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, {
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    ...opts,
  });
  return {
    status: (r.status === null || r.status === undefined) ? -1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error || null,
  };
}

/** git 子命令封装；git 缺失或启动失败时 status = -1。 */
export function git(args, opts = {}) {
  return run('git', args, opts);
}

/** 规范化目录身份键（解析符号链接/8.3 短路径、正斜杠化、Windows 下忽略盘符与目录大小写）。 */
function normDirKey(p) {
  if (!p) return '';
  let abs = path.resolve(String(p));
  try {
    abs = fs.realpathSync.native ? fs.realpathSync.native(abs) : fs.realpathSync(abs);
  } catch (_e) {
    try { abs = fs.realpathSync(abs); } catch (_e2) { /* keep abs */ }
  }
  const posix = toPosix(abs).replace(/\/+$/, '') || '/';
  return process.platform === 'win32' ? posix.toLowerCase() : posix;
}

/** 判断两个路径是否指向同一目录。 */
export function sameDir(a, b) {
  if (!a || !b) return false;
  return normDirKey(a) === normDirKey(b);
}

function resolveRealPathBestEffort(p) {
  const abs = path.resolve(String(p));
  let cur = abs;
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native ? fs.realpathSync.native(cur) : fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail) : real;
    } catch (_e) {
      try {
        const realFallback = fs.realpathSync(cur);
        return tail.length ? path.join(realFallback, ...tail) : realFallback;
      } catch (_e2) {
        const parent = path.dirname(cur);
        if (parent === cur) return abs;
        tail.unshift(path.basename(cur));
        cur = parent;
      }
    }
  }
}

/**
 * 从 startDir 向上（不超过 stopAt）寻找最近的 .cac 项目根目录。
 * 绝不将用户全局配置目录 ~/.cac 或系统临时根 os.tmpdir() 误判为项目根；
 * 当 startDir 含软链而词法父链未命中 .cac 时，自动沿物理 realpath 二次向上查找以防绕过 .cac 逃逸至外层 .git。
 */
export function findCacProjectRoot(startDir, stopAt = null) {
  if (!startDir) return null;
  const resolvedStart = path.resolve(String(startDir));
  const stopKey = stopAt ? normDirKey(resolveRealPathBestEffort(stopAt)) : '';
  const homeKey = normDirKey(os.homedir());
  const tmpKey = normDirKey(os.tmpdir());

  const walkUp = (fromAbs, preserveRawStart) => {
    let cur = fromAbs;
    for (;;) {
      const curKey = normDirKey(cur);
      if (curKey === homeKey || curKey === tmpKey) break;
      if (fs.existsSync(path.join(cur, '.cac'))) {
        const isProjectCac = curKey !== homeKey && curKey !== tmpKey;
        if (isProjectCac) {
          return preserveRawStart && cur === fromAbs && fs.existsSync(path.join(String(startDir), '.cac'))
            ? String(startDir)
            : cur;
        }
      }
      if (stopKey && curKey === stopKey) break;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    return null;
  };

  const direct = walkUp(resolvedStart, true);
  if (direct) return direct;

  const realStart = resolveRealPathBestEffort(resolvedStart);
  const lexA = toPosix(resolvedStart).replace(/\/+$/, '') || '/';
  const lexB = toPosix(realStart).replace(/\/+$/, '') || '/';
  const sameSpelling = process.platform === 'win32'
    ? lexA.toLowerCase() === lexB.toLowerCase()
    : lexA === lexB;
  if (!sameSpelling) {
    return walkUp(realStart, false);
  }
  return null;
}

/**
 * 探测目录 root 的 Git 边界状态，区分自有仓库与外层祖先目录误建的 .git：
 * - ownRepo: topLevel 与 root 为同一目录，或 root/.git 存在（兼容 submodule/worktree）
 * - inheritedParentGit: inGit && !ownRepo && root/.cac 存在（外层父目录有 .git，当前 .cac 项目尚未独立 git init）
 * - trackedSubdir: !ownRepo 时当前子目录是否有已被外层仓库索引追踪的文件（区分有意 monorepo 子包与未初始化空项目）
 */
export function gitStateOf(root) {
  const target = root ? String(root) : process.cwd();
  const rev = git(['-c', 'core.quotePath=false', 'rev-parse', '--show-toplevel', '--show-prefix'], { cwd: target });
  if (rev.status !== 0) {
    return {
      inGit: false,
      ownRepo: false,
      topLevel: null,
      prefix: '',
      inheritedParentGit: false,
      trackedSubdir: false,
      status: rev.status,
      error: rev.error,
      stderr: rev.stderr,
    };
  }
  const lines = String(rev.stdout || '').replace(/\r/g, '').split('\n');
  const topLevel = (lines[0] || '').trim() || null;
  const prefix = toPosix(lines[1] || '');
  if (!topLevel) {
    return {
      inGit: false,
      ownRepo: false,
      topLevel: null,
      prefix: '',
      inheritedParentGit: false,
      trackedSubdir: false,
      status: rev.status,
      error: rev.error,
      stderr: rev.stderr,
    };
  }
  const ownRepo = sameDir(topLevel, target) || fs.existsSync(path.join(target, '.git'));
  const hasCac = fs.existsSync(path.join(target, '.cac'));
  const inheritedParentGit = Boolean(!ownRepo && hasCac);
  const trackedSubdir = !ownRepo
    ? git(['ls-files', '--error-unmatch', '.'], { cwd: target }).status === 0
    : false;
  return {
    inGit: true,
    ownRepo,
    topLevel,
    prefix: ownRepo ? '' : prefix,
    inheritedParentGit,
    trackedSubdir,
    status: 0,
    error: null,
    stderr: '',
  };
}

/**
 * 项目根目录解析优先级（HOST-CONTRACT §1）：
 * CODEAGENT3_PROJECT_DIR → CAC_PROJECT_DIR → ev.cwd → 最近的 .cac 项目根 → git rev-parse --show-toplevel → process.cwd()
 * 绝不越过含 .cac/ 的项目目录向上逃逸到外层父目录的 show-toplevel。
 */
export function projectDir(ev = null) {
  const envDir = process.env.CODEAGENT3_PROJECT_DIR || process.env.CAC_PROJECT_DIR;
  if (envDir && envDir.trim()) return envDir.trim();
  if (ev && typeof ev === 'object' && typeof ev.cwd === 'string' && ev.cwd.trim()) {
    return ev.cwd.trim();
  }
  const cwd = process.cwd();
  const directCac = findCacProjectRoot(cwd, cwd);
  if (directCac) return directCac;
  const top = git(['-c', 'core.quotePath=false', 'rev-parse', '--show-toplevel'], { cwd });
  const topDir = (top.status === 0 && top.stdout.trim()) ? top.stdout.trim() : null;
  const cacRoot = findCacProjectRoot(cwd, topDir);
  if (cacRoot) return cacRoot;
  if (topDir) return topDir;
  return cwd;
}

/** 待审清单文本 → 尚未清空的文件行（去空白行与 'clean' 标记）。 */
export function pendingReviewLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && l !== 'clean');
}

/** 读 .cac/.needs-review 取待审文件列表；不存在或读失败返回空数组。 */
export function pendingReviewFiles(root) {
  return pendingReviewLines(readTextFile(path.join(root, '.cac', '.needs-review')).text);
}

/** 单行 JSON 到 stdout。 */
export function emit(obj) {
  fs.writeSync(1, JSON.stringify(obj) + '\n');
}

/** 纯文本到 stdout（供独立 CLI 脚本如 static-check 输出报告）。 */
export function out(text) {
  fs.writeSync(1, String(text) + '\n');
}

/** 上下文注入（HOST-CONTRACT §3.5：SessionStart / UserPromptSubmit / PostCompact / SubagentStop 等）。 */
export function context(hookEventName, text, extraTopLevel = {}) {
  emit({
    ...extraTopLevel,
    hookSpecificOutput: {
      hookEventName,
      additionalContext: String(text),
    },
  });
}

/** 一行诊断到 stderr。 */
export function say(text) {
  fs.writeSync(2, String(text) + '\n');
}

/**
 * Stop / SubagentStop / PreCompact / UserPromptSubmit 阻断契约（HOST-CONTRACT §3.5）：
 * 输出 { decision: 'block', reason }，exit 0，绝不写 continue: false（continue: false 会直接终止会话）。
 */
export function block(reason) {
  emit({ decision: 'block', reason: String(reason) });
  process.exitCode = 0;
}

/**
 * PreToolUse JSON 决策阻断通道（HOST-CONTRACT §3.5 通道 B）：
 * 输出 permissionDecision: 'deny' 并保持 exit 0。
 */
export function denyTool(reason) {
  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: String(reason),
    },
  });
  process.exitCode = 0;
}

const CAC_RUNTIME_STATE_PREFIXES = [
  '.cac/.runtime/',
  '.cac/evidence/',
  '.cac/harness/receipts/',
  '.cac/harness/waivers/',
  '.cac/harness/trend/',
  '.cac/harness/state/',
  '.cac/harness/evidence/',
  '.cac/agent-memory/',
  '.cac/worktrees/',
];

const CAC_RUNTIME_STATE_FILES = new Set([
  '.cac/.needs-review',
  '.cac/.needs-review.lock',
  '.cac/.red-verified',
  '.cac/.tdd-exempt',
  '.cac/.tdd-gate-advised',
  '.cac/.stop-gate-strikes',
  '.cac/.stop-gate-advised',
  '.cac/.three-file-sync-advised',
  '.cac/.precompact-block-epoch',
  '.cac/.subagent-reminded',
  '.cac/.fast-mode',
  '.cac/.static-gate',
  '.cac/.degraded-review',
  '.cac/.async-verify-last',
  '.cac/signals.jsonl',
  '.cac/settings.local.json',
  '.cac/.credentials.json',
]);

/** 判断相对项目根路径是否属于 .cac 运行态文件。 */
export function isCacRuntimeState(rawPath) {
  const p = toPosix(rawPath);
  if (CAC_RUNTIME_STATE_FILES.has(p) || p.endsWith('/signals.jsonl')) return true;
  return CAC_RUNTIME_STATE_PREFIXES.some((pre) => p.startsWith(pre));
}

/**
 * 解析 `git status --porcelain -z`：NUL 分隔、core.quotePath=false 保全中文与空格文件名，
 * R/C 记录附带的旧路径一并计入改动集。
 * 当 root 位于外层 Git 仓库子目录（prefix 非空）时，自动限定 `-- .` 并用 relToProject 剥去前缀，
 * 过滤掉一切外层父目录或隔壁兄弟项目的文件，永远只返回相对 root 自身的路径。
 */
export function porcelainZ(root, extraArgs = []) {
  const gs = gitStateOf(root);
  if (!gs.inGit) {
    return { status: gs.status, error: gs.error, stderr: gs.stderr, paths: [] };
  }
  const effectivePrefix = gs.ownRepo ? '' : gs.prefix;
  const scopedArgs = effectivePrefix && !extraArgs.includes('--')
    ? [...extraArgs, '--', '.']
    : extraArgs;
  const st = git(['-c', 'core.quotePath=false', 'status', '--porcelain', '-z', ...scopedArgs], { cwd: root });
  const recs = String(st.stdout || '').split('\0');
  const paths = [];
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    if (!rec) continue;
    const status = rec.slice(0, 2);
    const p1 = relToProject(rec.slice(3), effectivePrefix);
    if (p1) paths.push(p1);
    if (/^[RC]/.test(status) || /^.[RC]/.test(status)) {
      i += 1;
      if (recs[i]) {
        const p2 = relToProject(recs[i], effectivePrefix);
        if (p2) paths.push(p2);
      }
    }
  }
  return { status: st.status, error: st.error, stderr: st.stderr, paths };
}

/**
 * 改动路径归类（供 three-file-sync-gate 与 precompact-gate 共用口径）。
 * @returns {'progress'|'spec'|'changelog'|'ignore'|'code'|'other'}
 */
export function classifyChange(rawPath) {
  const p = toPosix(rawPath);
  if (p === 'progress.md') return 'progress';
  if (p === 'Product-Spec.md') return 'spec';
  if (p === 'Product-Spec-CHANGELOG.md') return 'changelog';
  if (/(^|\/)(\.cac\/(\.runtime|evidence|harness\/(state|receipts|waivers|trend|evidence)|worktrees|agent-memory)|node_modules|out|dist|build|release)\//.test(p)) {
    return 'ignore';
  }
  if (/(^|\/)\.cac\/\.(needs-review|needs-review\.lock|tdd-exempt|red-verified|static-gate|degraded-review|fast-mode|subagent-reminded|three-file-sync-advised|tdd-gate-advised|stop-gate-strikes|stop-gate-advised|precompact-block-epoch|async-verify-last|credentials\.json)$/.test(p)) {
    return 'ignore';
  }
  if (/(^|\/)\.cac\/settings\.local\.json$/.test(p) || /(^|\/)signals\.jsonl$/.test(p)) {
    return 'ignore';
  }
  if (/\.(sh|ps1|mjs|cjs|ts|tsx|js|jsx|py|css|go|rs|java|kt|cs)$/.test(p) || /(^|\/)\.cac\//.test(p)) {
    return 'code';
  }
  return 'other';
}

/** 剥掉仓根到项目子目录的前缀；不在项目子树内返回 null（Windows 下大小写不敏感匹配）。 */
export function relToProject(p, prefix) {
  const norm = toPosix(p);
  if (!prefix) return norm;
  const normPrefix = toPosix(prefix);
  if (process.platform === 'win32') {
    return norm.toLowerCase().startsWith(normPrefix.toLowerCase())
      ? norm.slice(normPrefix.length)
      : null;
  }
  return norm.startsWith(normPrefix) ? norm.slice(normPrefix.length) : null;
}

/** 异常首行摘要。 */
export function errText(e) {
  return String((e && (e.stack || e.message)) || e || 'unknown').split(/\r?\n/)[0];
}

/** fail-closed 闸包装：主体抛错时当场落 decision:block JSON，杜绝假绿。 */
export function runFailClosed(main, reason) {
  const fail = (e) => {
    try {
      emit({ decision: 'block', reason: `${reason}（闸自身异常：${errText(e)}）` });
    } catch (_e) { /* stdout 不可写时无其他通道 */ }
    process.exit(0);
  };
  try {
    const r = main();
    if (r && typeof r.then === 'function') r.then(undefined, fail);
  } catch (e) {
    fail(e);
  }
}

/** fail-open 闸/记账包装：异常时往 stderr 留一行诊断后放行（若已定下拦停退出码则保持不翻案）。 */
export function runFailOpen(main) {
  const fail = (e) => {
    try { say(`[hook] 内部异常，已放行：${errText(e)}`); } catch (_e) { /* ignore */ }
    if (!process.exitCode) process.exitCode = 0;
  };
  try {
    const r = main();
    if (r && typeof r.then === 'function') r.then(undefined, fail);
  } catch (e) {
    fail(e);
  }
}

const FALLBACK_GUARDS = new Set([
  'dangerous-command-guard', 'no-direct-code-guard', 'pre-commit-check',
  'precompact-gate', 'release-gate', 'secret-exfil-guard', 'stop-gate',
  'subagent-bookkeeping', 'tdd-gate', 'three-file-sync-gate', 'design-detail-sync',
]);
const FALLBACK_ADVISE = new Set([
  'stop-gate', 'subagent-bookkeeping', 'tdd-gate', 'three-file-sync-gate', 'design-detail-sync',
]);

/** 档位总闸：动态加载 tier.mjs，缺失/损坏时退回内置 standard 口径。 */
export async function gateModeOf(hookId, projectRoot) {
  try {
    const m = await import('./tier.mjs');
    return m.gateMode(hookId, projectRoot ? { projectDir: projectRoot } : {});
  } catch (_e) {
    if (hookId === 'auto-push') return 'off';
    if (FALLBACK_ADVISE.has(hookId)) return 'advise';
    return FALLBACK_GUARDS.has(hookId) ? 'block' : 'on';
  }
}

/** 仅判断当前 hook 是否处于 off 静默档。 */
export async function fastOff(hookId, projectRoot) {
  return (await gateModeOf(hookId, projectRoot)) === 'off';
}
