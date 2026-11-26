// lib/core.mjs — 治理引擎底层公共原语：仅依赖 Node >= 20 内置模块，供 harness.mjs、lib/tier.mjs 与可选包 ext/*.mjs 单向复用。
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HARNESS_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ===========================================================================
// S1 common
// ===========================================================================
function readStdin() {
  try {
    if (process.stdin.isTTY) return '';
    return fs.readFileSync(0, 'utf8');
  } catch (_e) {
    return '';
  }
}

function toPosixPath(p) {
  return String(p).replace(/\\/g, '/');
}

function stableJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function sha256Lf(text) {
  return sha256(Buffer.from(String(text).replace(/\r\n/g, '\n'), 'utf8'));
}

function emit(obj, code = 0) {
  try {
    fs.writeSync(1, JSON.stringify(obj) + '\n');
  } catch (_e) {
    process.stdout.write(JSON.stringify(obj) + '\n');
  }
  process.exit(code);
}

function die(msg, code = 1) {
  try {
    fs.writeSync(2, String(msg).replace(/\n?$/, '\n'));
  } catch (_e) {
    process.stderr.write(String(msg).replace(/\n?$/, '\n'));
  }
  process.exit(code);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, Number(ms) || 0));
}

function withDirLock(lockPath, fn, { timeoutMs = 10000, staleMs = 60000, pollMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      break;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      let ageMs = 0;
      try { ageMs = Date.now() - fs.statSync(lockPath).mtimeMs; } catch (_e) { continue; }
      if (ageMs > staleMs) {
        try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch (_e) { /* retry */ }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error('could not acquire lock ' + lockPath + ' within ' + timeoutMs
          + 'ms (current holder is ' + ageMs + 'ms old)');
      }
      sleepSync(pollMs);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  }
}

// ===========================================================================
// S2 git (shell: false, windowsHide: true, maxBuffer: 1 << 28)
// ===========================================================================
function git(args, opts = {}) {
  return spawnSync('git', args, {
    shell: false,
    windowsHide: true,
    maxBuffer: 1 << 28,
    ...opts,
  });
}

function normDirKey(p) {
  if (!p) return '';
  let abs = path.resolve(String(p));
  try {
    abs = fs.realpathSync.native ? fs.realpathSync.native(abs) : fs.realpathSync(abs);
  } catch (_e) {
    try { abs = fs.realpathSync(abs); } catch (_e2) { /* keep abs */ }
  }
  const posix = toPosixPath(abs).replace(/\/+$/, '') || '/';
  return process.platform === 'win32' ? posix.toLowerCase() : posix;
}

function sameDir(a, b) {
  if (!a || !b) return false;
  return normDirKey(a) === normDirKey(b);
}

function isSameOrSubPath(child, base) {
  const c = normDirKey(child);
  const b = normDirKey(base);
  if (!c || !b) return false;
  if (c === b) return true;
  return b === '/' ? c.startsWith('/') : c.startsWith(b + '/');
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

function findCacProjectRoot(startDir, stopAt = null) {
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
  const lexA = toPosixPath(resolvedStart).replace(/\/+$/, '') || '/';
  const lexB = toPosixPath(realStart).replace(/\/+$/, '') || '/';
  const sameSpelling = process.platform === 'win32'
    ? lexA.toLowerCase() === lexB.toLowerCase()
    : lexA === lexB;
  if (!sameSpelling) {
    return walkUp(realStart, false);
  }
  return null;
}

function isGitRepo(cwd = projectRoot()) {
  const rev = git(['-c', 'core.quotePath=false', 'rev-parse', '--show-toplevel'], { cwd });
  if (rev.status !== 0 || !rev.stdout) return false;
  const topLevel = rev.stdout.toString('utf8').trim();
  if (!topLevel) return false;
  if (sameDir(topLevel, cwd) || fs.existsSync(path.join(cwd, '.git'))) return true;
  // 若当前目录已有 .cac 但未独立 git init（躺在某个外层父目录 .git 下），仅当其已被外层仓库索引追踪时才视为有效 Git 子目录
  if (fs.existsSync(path.join(cwd, '.cac'))) {
    return git(['ls-files', '--error-unmatch', '.'], { cwd }).status === 0;
  }
  return true;
}

function headCommit(cwd = projectRoot()) {
  if (!isGitRepo(cwd)) return null;
  const r = git(['rev-parse', 'HEAD'], { cwd });
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout.toString('utf8').trim() || null;
}

const STATE_EXCLUDE = [
  ':(exclude).cac/.needs-review',
  ':(exclude).cac/.needs-review.lock',
  ':(exclude).cac/.fast-mode',
  ':(exclude).cac/.tdd-exempt',
  ':(exclude).cac/.red-verified',
  ':(exclude).cac/.tdd-gate-advised',
  ':(exclude).cac/.stop-gate-strikes',
  ':(exclude).cac/.stop-gate-advised',
  ':(exclude).cac/.three-file-sync-advised',
  ':(exclude).cac/.precompact-block-epoch',
  ':(exclude).cac/.subagent-reminded',
  ':(exclude).cac/signals.jsonl',
  ':(exclude).cac/.runtime/**',
  ':(exclude).cac/evidence/**',
  ':(exclude).cac/harness/receipts/**',
  ':(exclude).cac/harness/waivers/**',
  ':(exclude).cac/harness/trend/**',
  ':(exclude).cac/harness/state/**',
  ':(exclude).cac/harness/evidence/**',
  ':(exclude).cac/agent-memory/**',
  ':(exclude).cac/worktrees/**',
];

const STATE_EXCLUDE_PATHS = new Set([
  '.cac/.needs-review',
  '.cac/.needs-review.lock',
  '.cac/.fast-mode',
  '.cac/.tdd-exempt',
  '.cac/.red-verified',
  '.cac/.tdd-gate-advised',
  '.cac/.stop-gate-strikes',
  '.cac/.stop-gate-advised',
  '.cac/.three-file-sync-advised',
  '.cac/.precompact-block-epoch',
  '.cac/.subagent-reminded',
  '.cac/signals.jsonl',
]);

const STATE_EXCLUDE_PREFIXES = [
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

function isStateExcluded(p) {
  const n = toPosixPath(p);
  if (STATE_EXCLUDE_PATHS.has(n) || n.endsWith('/signals.jsonl')) return true;
  return STATE_EXCLUDE_PREFIXES.some((pre) => n.startsWith(pre));
}

function splitNul(buf) {
  if (!buf) return [];
  return buf.toString('utf8').split('\0').map((s) => toPosixPath(s.trim())).filter(Boolean);
}

const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function changedPaths(cwd = projectRoot()) {
  if (!isGitRepo(cwd)) return { paths: [], nonGit: true };
  const baseRef = headCommit(cwd) ? 'HEAD' : EMPTY_TREE_SHA;
  const tracked = splitNul(git(['-c', 'core.quotePath=false', 'diff', '--name-only', '-z', '--relative', baseRef, '--', '.'], { cwd }).stdout);
  const untracked = splitNul(git(['-c', 'core.quotePath=false', 'ls-files', '-z', '--others', '--exclude-standard', '--', '.'], { cwd }).stdout);
  const seen = new Set();
  const out = [];
  for (const p of tracked.concat(untracked)) {
    if (!seen.has(p) && !isStateExcluded(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

function hashUntracked(cwd = projectRoot()) {
  const list = splitNul(git(['-c', 'core.quotePath=false', 'ls-files', '-z', '--others', '--exclude-standard', '--', '.'], { cwd }).stdout)
    .filter((p) => !isStateExcluded(p))
    .sort();
  const parts = [];
  for (const p of list) {
    let content;
    try { content = fs.readFileSync(path.join(cwd, p)); } catch (_e) { continue; }
    parts.push(Buffer.from('U ' + p + ' ' + sha256(content) + '\n', 'utf8'));
  }
  return Buffer.concat(parts);
}

function canonicalDiff(cwd = projectRoot()) {
  if (!isGitRepo(cwd)) return { buf: Buffer.from('NON_GIT'), nonGit: true };
  const baseRef = headCommit(cwd) ? 'HEAD' : EMPTY_TREE_SHA;
  const tracked = git(['diff', '--binary', '--no-ext-diff', '--relative', baseRef, '--', '.', ...STATE_EXCLUDE], { cwd }).stdout || Buffer.alloc(0);
  const untracked = hashUntracked(cwd);
  return { buf: Buffer.concat([tracked, untracked]), nonGit: false };
}

function gitFingerprint(cwd = projectRoot()) {
  return sha256(canonicalDiff(cwd).buf);
}

// ===========================================================================
// S3 glob (zero-dep; cached RegExp)
// ===========================================================================
const GLOB_CACHE = new Map();

function globToRegExp(rawGlob) {
  const glob = toPosixPath(rawGlob);
  const hit = GLOB_CACHE.get(glob);
  if (hit) return hit;
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  const compiled = new RegExp(re + '$');
  GLOB_CACHE.set(glob, compiled);
  return compiled;
}

function matchAny(p, globs) {
  const norm = toPosixPath(p);
  return (globs || []).some((g) => globToRegExp(g).test(norm));
}

function specificity(glob) {
  return String(glob).replace(/[*?]/g, '').length;
}

// ===========================================================================
// S9 config
// ===========================================================================
const DEFAULTS = {
  contextPack: { maxTotalChars: 120000, maxFiles: 40, maxFileChars: 6000, maxDiffChars: 40000 },
  maxTrackedPaths: 100000,
};

function projectRoot() {
  const envDir = process.env.CODEAGENT3_PROJECT_DIR || process.env.CAC_PROJECT_DIR;
  if (envDir && envDir.trim()) return envDir.trim();
  const cwd = process.cwd();
  const directCac = findCacProjectRoot(cwd, cwd);
  if (directCac) return directCac;
  const top = git(['-c', 'core.quotePath=false', 'rev-parse', '--show-toplevel'], { cwd });
  const topDir = (top.status === 0 && top.stdout && top.stdout.toString('utf8').trim())
    ? top.stdout.toString('utf8').trim()
    : null;
  const cacFromCwd = findCacProjectRoot(cwd, topDir);
  if (cacFromCwd) return cacFromCwd;
  const inferredRoot = path.dirname(path.dirname(HARNESS_DIR));
  if (path.basename(path.dirname(HARNESS_DIR)) === '.cac' && isSameOrSubPath(cwd, inferredRoot)) {
    return inferredRoot;
  }
  if (topDir) return topDir;
  return cwd;
}

function catalogFilePath() {
  return path.join(projectRoot(), '.cac', 'harness', 'module-catalog.json');
}

function resolveThroughLinks(p) {
  const abs = path.resolve(String(p));
  let cur = abs;
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail) : real;
    } catch (_e) {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

function escapesBase(rel) {
  if (rel === '..' || rel.startsWith('..' + path.sep) || rel.startsWith('../')) return true;
  return path.isAbsolute(rel);
}

function repoRelative(p) {
  const raw = String(p);
  const abs = path.isAbsolute(raw) ? raw : path.resolve(raw);
  const relSpelling = path.relative(path.resolve(projectRoot()), abs);
  if (relSpelling === '') return '.';
  if (!escapesBase(relSpelling)) return toPosixPath(relSpelling);
  const relIdentity = path.relative(resolveThroughLinks(projectRoot()), resolveThroughLinks(abs));
  if (relIdentity === '') return '.';
  if (!escapesBase(relIdentity)) return toPosixPath(relIdentity);
  return toPosixPath(abs);
}

function loadHarnessConfig() {
  const cp = catalogFilePath();
  const present = fs.existsSync(cp);
  if (!present) {
    return { contextPack: { ...DEFAULTS.contextPack }, catalogPresent: false };
  }
  let contextPack = { ...DEFAULTS.contextPack };
  try {
    const raw = JSON.parse(fs.readFileSync(cp, 'utf8'));
    if (raw && typeof raw.contextPack === 'object' && raw.contextPack) {
      contextPack = { ...DEFAULTS.contextPack, ...raw.contextPack };
    }
  } catch (_e) { /* schema validated by catalog-lint */ }
  return { contextPack, catalogPresent: true };
}

function readTextFile(file) {
  try { return { text: fs.readFileSync(file, 'utf8'), absent: false, error: null }; } catch (e) {
    if (e && e.code === 'ENOENT') return { text: null, absent: true, error: null };
    return { text: null, absent: false, error: e };
  }
}

function readDirNames(dir) {
  try { return { names: fs.readdirSync(dir), absent: false, error: null }; } catch (e) {
    if (e && e.code === 'ENOENT') return { names: null, absent: true, error: null };
    return { names: null, absent: false, error: e };
  }
}

function errDetail(e) {
  const msg = String((e && e.message) || e);
  const root = projectRoot();
  if (!root) return msg;
  return msg.split(root + path.sep).join('').split(root).join('.');
}

function quarantineFilePath() {
  return path.join(projectRoot(), '.cac', 'harness', 'state', 'quarantine.jsonl');
}

function recordCorruptState({ kind, path: file, reason }) {
  const rel = repoRelative(file);
  const fp = quarantineFilePath();
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.appendFileSync(fp, JSON.stringify({
      ts: new Date().toISOString(),
      kind: String(kind),
      path: rel,
      reason: String(reason).slice(0, 500),
    }) + '\n', 'utf8');
  } catch (e) {
    process.stderr.write('could not record damaged state of ' + rel + ': ' + String((e && e.message) || e) + '\n');
  }
}

// ===========================================================================
// Shared vocabulary
// ===========================================================================
function parseCsv(v) {
  if (typeof v !== 'string') return [];
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

const ATTRIBUTES = ['security', 'resilience', 'privacy', 'safety', 'reliability', 'availability', 'performance', 'maintainability'];
const TIERS = ['critical', 'high', 'medium', 'low', 'minimal', 'none'];
const TIER_ENFORCEMENT = {
  critical: 'block',
  high: 'block',
  medium: 'warn',
  low: 'record',
  minimal: 'listed',
  none: 'opted-out',
};
const TIER_RANK = { critical: 5, high: 4, medium: 3, low: 2, minimal: 1, none: 0 };

function normalizeTier(req) {
  if (typeof req === 'string') return { tier: req, reason: '' };
  if (req && typeof req === 'object') return { tier: String(req.tier || ''), reason: String(req.reason || '') };
  return { tier: '', reason: '' };
}

const DENY = [
  /(^|\/)\.git\//,
  /(^|\/)node_modules\//,
  /(^|\/)(dist|build|out|release|\.next|\.venv)\//,
  /(^|\/)\.cac\/(\.runtime|evidence|worktrees|agent-memory|harness\/receipts|harness\/waivers|harness\/trend|harness\/state|harness\/evidence)\//,
  /(^|\/)\.env(\.|$)/,
  /\.(pem|key|p12|pfx|ppk)$/,
  /(^|\/)id_(rsa|ed25519)/,
  /(^|\/)\.?credentials\.json$/,
  /(^|\/)\.(ssh|aws|azure|gnupg|kube)\//,
];

function isDenied(p) {
  const n = toPosixPath(p);
  if (/(^|\/)\.env\.(example|sample|template|dist)$/i.test(n)) return false;
  return DENY.some((r) => r.test(n));
}

const SOURCE_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx',
  '.py', '.go', '.java', '.kt', '.kts', '.cs', '.rs', '.rb', '.php', '.swift', '.scala',
]);

function whichCmd(exe) {
  if (!exe) return false;
  if (exe.includes('/') || exe.includes('\\')) return fs.existsSync(exe);
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD;.PS1').split(';').map((s) => s.trim()).filter(Boolean)
    : [''];
  for (const d of dirs) {
    if (process.platform === 'win32' && fs.existsSync(path.join(d, exe))) return true;
    for (const ext of exts) {
      if (fs.existsSync(path.join(d, exe + ext))) return true;
    }
  }
  return false;
}

export {
  HARNESS_DIR, EMPTY_TREE_SHA,
  readStdin, toPosixPath, stableJson, sha256, sha256Lf, emit, die, sleepSync, withDirLock,
  git, sameDir, findCacProjectRoot, isGitRepo, headCommit, isStateExcluded, splitNul, changedPaths, canonicalDiff, gitFingerprint,
  globToRegExp, matchAny, specificity,
  DEFAULTS, projectRoot, catalogFilePath, repoRelative, loadHarnessConfig,
  readTextFile, readDirNames, errDetail, quarantineFilePath, recordCorruptState,
  parseCsv,
  ATTRIBUTES, TIERS, TIER_ENFORCEMENT, TIER_RANK, normalizeTier,
  isDenied, SOURCE_EXTS, whichCmd,
};
