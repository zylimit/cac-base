// tier.mjs — 档位（fast / standard / strict）的唯一解析器。
//
// 依赖方向只许「治理引擎 → .cac/hooks/lib/tier.mjs」，绝不反向 import 引擎代码。
// 合并规则「只抬不降」（秩 fast < standard < strict）：
//   1. profile.default      —— .cac/harness/profile.json 默认档
//   2. 会话覆盖             —— .cac/.runtime/tier.json（8h 硬上限或显式 sticky，到期自动回落）
//   3. 治理面自动升档       —— 工作树修改 raise.paths 命中的家底文件 → 自动抬到 raise.to (strict)
//   4. 安全地板（floor）    —— BUILTIN_FLOOR 永远按最严档执行，任何档位或 overrides 均不可降级
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { porcelainZ, toPosix } from './io.mjs';

export const TIERS = ['fast', 'standard', 'strict'];
export const MAX_FAST_SECONDS = 8 * 3600;

/** 档位秩：越大越严；未知档位返回 -1。 */
export function rank(tier) {
  return TIERS.indexOf(String(tier));
}

/** 内置默认档位表（与分发包 .cac/harness/profile.json 保持一致）。 */
export const DEFAULT_PROFILE = {
  version: 1,
  default: 'standard',
  floor: [
    'secret-exfil-guard',
    'dangerous-command-guard',
    'release-gate',
    'postcompact-reinject',
  ],
  hooks: {
    'stop-gate': { kind: 'guard', fast: 'off', standard: 'advise', strict: 'block' },
    'three-file-sync-gate': { kind: 'guard', fast: 'advise', standard: 'advise', strict: 'block' },
    'design-detail-sync': { kind: 'guard', fast: 'advise', standard: 'advise', strict: 'block' },
    'precompact-gate': { kind: 'guard', fast: 'advise', standard: 'block', strict: 'block' },
    'pre-commit-check': { kind: 'guard', fast: 'advise', standard: 'block', strict: 'block' },
    'no-direct-code-guard': { kind: 'guard', fast: 'advise', standard: 'block', strict: 'block' },
    'tdd-gate': { kind: 'guard', fast: 'off', standard: 'advise', strict: 'block' },
    'subagent-bookkeeping': { kind: 'guard', fast: 'off', standard: 'advise', strict: 'block' },
    'mark-review-needed': { kind: 'recorder', fast: 'on', standard: 'on', strict: 'on' },
    'record-authorship': { kind: 'recorder', fast: 'on', standard: 'on', strict: 'on' },
    'auto-push': { kind: 'recorder', fast: 'off', standard: 'off', strict: 'off' },
    'kill-dev-ports': { kind: 'recorder', fast: 'off', standard: 'on', strict: 'on' },
    'detect-feedback-signal': { kind: 'recorder', fast: 'off', standard: 'on', strict: 'on' },
    'session-start': { kind: 'recorder', fast: 'on', standard: 'on', strict: 'on' },
  },
  raise: {
    to: 'strict',
    paths: [
      '.cac/hooks/**',
      '.cac/githooks/**',
      '.cac/harness/**',
      '.cac/skills/**',
      '.cac/agents/**',
      '.cac/rules/**',
      '.cac/rules/AGENTS.md',
      '.cac/settings.json',
      '.github/**',
    ],
  },
  overrides: {},
};

/** 不可旁路的安全地板集合：profile.floor 只能追加，不能移出内置项。 */
export const BUILTIN_FLOOR = new Set(DEFAULT_PROFILE.floor);

const GUARDS = new Set([
  'dangerous-command-guard',
  'no-direct-code-guard',
  'pre-commit-check',
  'precompact-gate',
  'release-gate',
  'secret-exfil-guard',
  'stop-gate',
  'subagent-bookkeeping',
  'tdd-gate',
  'three-file-sync-gate',
  'design-detail-sync',
]);

const GUARD_MODES = new Set(['off', 'advise', 'block']);
const RECORDER_MODES = new Set(['off', 'on']);

const rootCache = new Map();
function repoRootOf(dir) {
  if (rootCache.has(dir)) return rootCache.get(dir);
  let out = dir;
  try {
    const top = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
    });
    if (top.status === 0 && String(top.stdout || '').trim()) out = String(top.stdout).trim();
  } catch (_e) { /* keep dir */ }
  rootCache.set(dir, out);
  return out;
}

function defaultRoot() {
  const env = process.env.CODEAGENT3_PROJECT_DIR || process.env.CAC_PROJECT_DIR;
  if (env && env.trim()) return env.trim();
  try {
    const top = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
    });
    if (top.status === 0 && String(top.stdout || '').trim()) return String(top.stdout).trim();
  } catch (_e) { /* fallback cwd */ }
  return process.cwd();
}

const quarantined = new Set();
function quarantine(root, kind, file, reason) {
  if (quarantined.has(file)) return;
  quarantined.add(file);
  try {
    const fp = path.join(root, '.cac', 'harness', 'state', 'quarantine.jsonl');
    const rel = toPosix(path.relative(root, file)) || toPosix(file);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.appendFileSync(fp, JSON.stringify({
      ts: new Date().toISOString(),
      kind: String(kind),
      path: rel,
      reason: String(reason).slice(0, 500),
    }) + '\n', 'utf8');
  } catch (_e) { /* 隔离账本写失败不影响主判定 */ }
}

/** 读 .cac/harness/profile.json；缺失或损坏时回退内置默认表并留痕。 */
export function loadProfile(root = defaultRoot()) {
  const fp = path.join(root, '.cac', 'harness', 'profile.json');
  let raw;
  try {
    raw = fs.readFileSync(fp, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { profile: DEFAULT_PROFILE, present: false, corrupt: false, path: fp };
    quarantine(root, 'profile', fp, `读不出来：${(e && e.code) || 'IO'}`);
    return { profile: DEFAULT_PROFILE, present: true, corrupt: true, path: fp };
  }
  try {
    const clean = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
    const v = JSON.parse(clean.replace(/\r/g, ''));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('不是 JSON 对象');
    return { profile: v, present: true, corrupt: false, path: fp };
  } catch (e) {
    quarantine(root, 'profile', fp, `坏 JSON，按内置默认档位表跑：${(e && e.message) || e}`);
    return { profile: DEFAULT_PROFILE, present: true, corrupt: true, path: fp };
  }
}

/** 读运行态会话覆盖 .cac/.runtime/tier.json（8h 硬上限读侧复夹 + sticky 严格校验）。 */
export function readSession(root = defaultRoot(), now = Date.now()) {
  const fp = path.join(root, '.cac', '.runtime', 'tier.json');
  let raw;
  try {
    raw = fs.readFileSync(fp, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    quarantine(root, 'tier', fp, `读不出来：${(e && e.code) || 'IO'}`);
    return null;
  }
  let v;
  try {
    const clean = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
    v = JSON.parse(clean.replace(/\r/g, ''));
  } catch (e) {
    quarantine(root, 'tier', fp, `坏 JSON，本次视为无覆盖回默认档：${(e && e.message) || e}`);
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v) || rank(v.tier) < 0) {
    quarantine(root, 'tier', fp, `档位字段非法（tier=${v && v.tier}），本次视为无覆盖回默认档`);
    return null;
  }
  let exp = Number(v.expires_epoch);
  if (v.tier === 'fast' && v.sticky === true && v.expires_epoch === null
      && Number.isFinite(Number(v.set_epoch)) && v.set_epoch !== null
      && typeof v.reason === 'string' && v.reason.trim()) {
    return v;
  }
  if (v.tier === 'fast') {
    const setAt = Number(v.set_epoch);
    if (!Number.isFinite(setAt) || !Number.isFinite(exp)) {
      quarantine(root, 'tier', fp, 'fast 会话缺 set_epoch/expires_epoch（8h 上限无处算），本次视为无覆盖回默认档');
      return null;
    }
    const cap = Math.min(setAt, Math.floor(now / 1000)) + MAX_FAST_SECONDS;
    if (exp > cap) {
      exp = cap;
      v = { ...v, expires_epoch: cap };
    }
  }
  if (Number.isFinite(exp) && exp * 1000 <= now) return null;
  return v;
}

function globToRe(glob) {
  const norm = toPosix(glob);
  let re = '';
  for (let i = 0; i < norm.length; i++) {
    const c = norm[i];
    if (c === '*') {
      if (norm[i + 1] === '*') {
        if (norm[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

const STATE_PREFIXES = [
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
const STATE_FILES = new Set([
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

function isRuntimeState(rawPath) {
  const p = toPosix(rawPath);
  if (STATE_FILES.has(p) || p.endsWith('/signals.jsonl')) return true;
  return STATE_PREFIXES.some((pre) => p.startsWith(pre));
}

const dirtyCache = new Map();
function dirtyPaths(root) {
  if (dirtyCache.has(root)) return dirtyCache.get(root);
  const st = porcelainZ(root, ['-uall']);
  const out = [];
  if (st.error && st.error.code === 'ENOENT' && !dirtyCache.has('__git_warned__')) {
    dirtyCache.set('__git_warned__', true);
    process.stderr.write('[tier] 找不到 git，治理面自动升档本轮跳过（按当前档跑）\n');
  }
  if (st.status === 0) {
    for (const p of st.paths) {
      if (!isRuntimeState(p)) out.push(p);
    }
  }
  dirtyCache.set(root, out);
  return out;
}

function raisedBy(root, profile) {
  const raise = (profile && profile.raise) || {};
  const pats = Array.isArray(raise.paths) ? raise.paths : [];
  if (!pats.length || rank(raise.to) < 0) return [];
  const res = pats.map(globToRe);
  return dirtyPaths(root).filter((p) => res.some((re) => re.test(p)));
}

/**
 * 计算当前生效档位。
 * @returns {{tier:string, source:'default'|'session'|'raise', raisedBy?:string[], expiresEpoch?:number|null, sticky?:true}}
 */
export function effectiveTier({ projectDir = defaultRoot(), now = Date.now() } = {}) {
  const resolvedRoot = repoRootOf(projectDir);
  const { profile } = loadProfile(resolvedRoot);
  const session = readSession(resolvedRoot, now);
  const def = rank(profile.default) >= 0 ? profile.default : DEFAULT_PROFILE.default;
  const tier = session ? session.tier : def;
  const source = session && session.tier !== def ? 'session' : 'default';
  const out = { tier, source };
  if (session && session.sticky === true) {
    out.sticky = true;
    out.expiresEpoch = null;
  } else if (session && Number.isFinite(Number(session.expires_epoch))) {
    out.expiresEpoch = Number(session.expires_epoch);
  }

  const raise = profile.raise || {};
  if (rank(raise.to) > rank(tier)) {
    const hits = raisedBy(resolvedRoot, profile);
    if (hits.length) {
      out.tier = raise.to;
      out.source = 'raise';
      out.raisedBy = hits;
    }
  }
  return out;
}

function isGuard(id, profile) {
  const row = profile && profile.hooks && profile.hooks[id];
  if (row && row.kind) return row.kind === 'guard';
  return GUARDS.has(id);
}

export function kindOf(id, root = defaultRoot()) {
  const { profile } = loadProfile(root);
  return isGuard(id, profile) ? 'guard' : 'recorder';
}

function strictestFor(guard) {
  return guard ? 'block' : 'on';
}

const warned = new Set();
function warnUnregistered(id) {
  if (warned.has(id)) return;
  warned.add(id);
  try {
    fs.writeSync(2, `[tier] 闸 ${id} 不在 profile.hooks 表里，本次按最严档跑；请补登记或确认是否属于 floor。\n`);
  } catch (_e) { /* ignore */ }
}

/**
 * 解析某个 hook 当前应运行的模式（'off' | 'advise' | 'block' | 'on'）。
 * 优先级：BUILTIN_FLOOR / profile.floor → overrides → 档位表（含治理面自动升档）。
 */
export function gateMode(id, ctx = {}) {
  const root = ctx.projectDir || defaultRoot();
  const { profile } = loadProfile(root);
  const guard = isGuard(id, profile);

  const floor = Array.isArray(profile.floor) ? profile.floor : [];
  if (BUILTIN_FLOOR.has(id) || floor.includes(id)) return strictestFor(guard);

  const legal = guard ? GUARD_MODES : RECORDER_MODES;
  const ov = profile.overrides && profile.overrides[id];
  if (typeof ov === 'string' && legal.has(ov)) return ov;

  const row = profile.hooks && profile.hooks[id];
  if (!row) {
    warnUnregistered(id);
    return strictestFor(guard);
  }

  const session = readSession(root, ctx.now);
  const base = session ? session.tier : (rank(profile.default) >= 0 ? profile.default : DEFAULT_PROFILE.default);
  const to = (profile.raise || {}).to;
  const pick = (t) => {
    const v = row[t];
    return (typeof v === 'string' && legal.has(v)) ? v : strictestFor(guard);
  };
  if (rank(to) <= rank(base) || pick(to) === pick(base)) return pick(base);

  return pick(effectiveTier({ projectDir: root, now: ctx.now }).tier);
}

export function fastModeActive(ctx = {}) {
  return effectiveTier(ctx).tier === 'fast';
}
