// ext/quality.mjs — S7 diff-bound receipts, S8 four-state quality gate, S10 waivers, S11 attributes.
// Enforces non-bypassable protection on `security / safety / privacy` across BOTH `class` and `attributes[]`
// in `fast` (`allowFastSkip`), `waiver` (by checkId or attribute), and deduplicates `attributes` reporting.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  HARNESS_DIR, TIER_ENFORCEMENT,
  changedPaths, emit, errDetail, gitFingerprint, headCommit, isGitRepo, isStateExcluded,
  normalizeTier, parseCsv, projectRoot, readDirNames, readStdin, readTextFile,
  recordCorruptState, repoRelative, sha256, stableJson, whichCmd,
} from '../lib/core.mjs';
import { loadCatalogFlag } from './catalog.mjs';
import { analyzeImpact } from './graph.mjs';
import { tierState } from '../lib/tier.mjs';

// ===========================================================================
// S7 receipt
// ===========================================================================
function receiptsDir() {
  return path.join(projectRoot(), '.cac', 'harness', 'receipts');
}

function safeTaskId(id) {
  const s = String(id == null ? '' : id).replace(/[^A-Za-z0-9._-]/g, '_');
  return (s === '' || s === '.' || s === '..') ? '' : s;
}

function contentHash(r) {
  return sha256(stableJson({ ...r, contentHash: undefined }));
}

function engineFiles() {
  const names = [];
  for (const dir of ['lib', 'ext']) {
    try {
      for (const f of fs.readdirSync(path.join(HARNESS_DIR, dir))) {
        if (f.endsWith('.mjs')) names.push(dir + '/' + f);
      }
    } catch (_e) { /* missing optional dir */ }
  }
  return ['harness.mjs'].concat(names).sort();
}

function engineHash() {
  const digests = engineFiles().map((rel) => sha256(fs.readFileSync(path.join(HARNESS_DIR, ...rel.split('/')))));
  return sha256(digests.join(''));
}

function hasCodeChange() {
  const cp = changedPaths();
  const list = Array.isArray(cp) ? cp : cp.paths;
  return list.some((p) => !isStateExcluded(p));
}

function writeReceipt(input, { timestamp } = {}) {
  const input0 = input && typeof input === 'object' ? input : {};
  const taskId = safeTaskId(input0.taskId);
  if (!taskId) throw new Error('writeReceipt: taskId required (allowed chars: A-Za-z0-9._-)');
  const receipt = {
    taskId,
    baseCommit: headCommit(),
    diffHash: gitFingerprint(),
    engineHash: engineHash(),
    reviewer: typeof input0.reviewer === 'string' ? input0.reviewer : 'unknown',
    verdict: typeof input0.verdict === 'string' ? input0.verdict : 'pass',
    scope: input0.scope === undefined ? null : input0.scope,
    timestamp: timestamp || new Date().toISOString(),
  };
  receipt.contentHash = contentHash(receipt);
  const dir = receiptsDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, taskId + '.json'), JSON.stringify(receipt, null, 2) + '\n', 'utf8');
  return receipt;
}

function receiptIntact(r) {
  return !!r && typeof r === 'object' && typeof r.contentHash === 'string'
    && contentHash(r) === r.contentHash;
}

function matchReceipts(receipts, D, engine = null) {
  const list = Array.isArray(receipts) ? receipts : [];
  for (const r of list) {
    if (!receiptIntact(r) || r.diffHash !== D) continue;
    if (engine && typeof r.engineHash === 'string' && r.engineHash !== engine) continue;
    return { matched: r.taskId || true, hadReceipts: true };
  }
  return { matched: null, hadReceipts: list.length > 0 };
}

function loadReceipts() {
  const dir = receiptsDir();
  const listing = readDirNames(dir);
  if (listing.error) {
    const detail = errDetail(listing.error);
    recordCorruptState({ kind: 'receipt', path: dir, reason: detail });
    return { receipts: [], unreadable: [repoRelative(dir)] };
  }
  if (listing.absent) return { receipts: [], unreadable: [] };
  const receipts = [];
  const unreadable = [];
  for (const n of listing.names.sort()) {
    if (!n.endsWith('.json')) continue;
    const fp = path.join(dir, n);
    try {
      receipts.push(JSON.parse(fs.readFileSync(fp, 'utf8')));
    } catch (e) {
      unreadable.push(repoRelative(fp));
      recordCorruptState({ kind: 'receipt', path: fp, reason: errDetail(e) });
    }
  }
  return { receipts, unreadable };
}

function verifyReceipt(flags = {}) {
  if (!isGitRepo()) {
    return { result: { state: 'DEGRADED', note: 'non-git', diffHash: null, degraded: true }, code: 3 };
  }
  const D = gitFingerprint();

  if (typeof flags.task === 'string' && flags.task) {
    const id = safeTaskId(flags.task);
    const file = path.join(receiptsDir(), id + '.json');
    const read = readTextFile(file);
    if (read.absent) {
      return { result: { state: 'STALE', note: 'receipt-missing', task: flags.task, diffHash: D }, code: 4 };
    }
    let receipt = null;
    let detail = read.error ? errDetail(read.error) : null;
    if (!detail) {
      try { receipt = JSON.parse(read.text); } catch (e) { detail = errDetail(e); }
    }
    if (detail) {
      recordCorruptState({ kind: 'receipt', path: file, reason: detail });
      process.stderr.write('receipt verify: ' + repoRelative(file) + ' exists and cannot be read (' + detail + ')\n');
      return {
        result: { state: 'STALE', note: 'receipt-unreadable', task: flags.task, diffHash: D, unreadable: [repoRelative(file)] },
        code: 4,
      };
    }
    if (!receiptIntact(receipt)) {
      return { result: { state: 'STALE', note: 'tampered', task: flags.task, diffHash: D }, code: 4 };
    }
    const engineNow = engineHash();
    const boundEngine = typeof receipt.engineHash === 'string' ? receipt.engineHash : null;
    if (boundEngine && boundEngine !== engineNow) {
      return {
        result: {
          state: 'STALE', note: 'engine-moved', task: flags.task, diffHash: D,
          engineHash: boundEngine, currentEngineHash: engineNow,
        },
        code: 4,
      };
    }
    if (receipt.diffHash === D) {
      return { result: { state: 'PASS', matched: receipt.taskId, diffHash: D, engineHash: boundEngine }, code: 0 };
    }
    return { result: { state: 'STALE', note: 'diff-moved', task: flags.task, diffHash: D, receiptDiffHash: receipt.diffHash }, code: 4 };
  }

  const loaded = loadReceipts();
  if (loaded.unreadable.length) {
    process.stderr.write(
      'receipt verify: ' + loaded.unreadable.length + ' receipt path(s) exist and cannot be read ('
      + loaded.unreadable.join(', ') + ')\n',
    );
    return { result: { state: 'STALE', note: 'receipt-unreadable', diffHash: D, unreadable: loaded.unreadable }, code: 4 };
  }
  if (!hasCodeChange()) {
    return { result: { state: 'PASS', note: 'no-change', diffHash: D }, code: 0 };
  }
  if (loaded.receipts.length === 0) {
    return { result: { state: 'PASS', note: 'no-receipts', diffHash: D }, code: 0 };
  }
  const engineNow = engineHash();
  const m = matchReceipts(loaded.receipts, D, engineNow);
  if (m.matched) {
    return { result: { state: 'PASS', matched: m.matched, diffHash: D }, code: 0 };
  }
  const engineMoved = loaded.receipts.some((r) =>
    receiptIntact(r) && r.diffHash === D && typeof r.engineHash === 'string' && r.engineHash !== engineNow,
  );
  return {
    result: { state: 'STALE', note: engineMoved ? 'engine-moved' : 'no-matching-receipt', diffHash: D },
    code: 4,
  };
}

function cmdReceipt(flags, positional = []) {
  const sub = positional[0];
  if (sub === 'write') {
    const raw = readStdin();
    let input;
    try { input = raw.trim() ? JSON.parse(raw) : {}; } catch (e) {
      return emit({ error: 'receipt-parse-error', detail: String((e && e.message) || e) }, 3);
    }
    let receipt;
    try { receipt = writeReceipt(input); } catch (e) {
      return emit({ error: 'receipt-write-error', detail: String((e && e.message) || e) }, 3);
    }
    return emit(receipt, 0);
  }
  if (sub === 'verify') {
    const { result, code } = verifyReceipt(flags);
    return emit(result, code);
  }
  return emit({ error: 'receipt-subcommand', detail: 'usage: receipt write|verify', got: sub || null }, 3);
}

function cmdVerify(flags) {
  const { result, code } = verifyPlanCmd(flags);
  return emit(result, code);
}

// ===========================================================================
// S8 quality
// ===========================================================================
const WIN_SHIM_DIRS = [
  ['LOCALAPPDATA', ['Microsoft', 'WinGet', 'Links']],
  ['USERPROFILE', ['scoop', 'shims']],
  ['ChocolateyInstall', ['bin']],
];

function shimDirs() {
  const override = String(process.env.CAC_HARNESS_SHIM_DIRS || '').trim();
  if (override) return override.split(path.delimiter).map((d) => d.trim()).filter(Boolean);
  if (process.platform !== 'win32') return [];
  const out = [];
  for (const [envVar, parts] of WIN_SHIM_DIRS) {
    const base = process.env[envVar];
    if (base) out.push(path.join(base, ...parts));
  }
  return out;
}

function findShim(exe) {
  if (!exe || exe.includes('/') || exe.includes('\\')) return null;
  const exts = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim()).filter(Boolean)
    : [];
  for (const dir of shimDirs()) {
    for (const name of [exe].concat(exts.map((e) => exe + e))) {
      try {
        if (fs.statSync(path.join(dir, name)).isFile()) return dir;
      } catch (_e) { /* not here */ }
    }
  }
  return null;
}

function pathPrefixedEnv(dir) {
  const env = { ...process.env };
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  env[key] = dir + path.delimiter + (env[key] || '');
  return env;
}

function spawnCmd(command, { pathPrefix = null } = {}) {
  const cwd = projectRoot();
  const extra = pathPrefix ? { env: pathPrefixedEnv(pathPrefix) } : {};
  const r = process.platform === 'win32'
    ? spawnSync('cmd', ['/c', command], { cwd, maxBuffer: 1 << 28, windowsVerbatimArguments: true, windowsHide: true, ...extra })
    : spawnSync('sh', ['-c', command], { cwd, maxBuffer: 1 << 28, windowsHide: true, ...extra });
  return {
    code: r.status,
    stdout: r.stdout ? r.stdout.toString('utf8') : '',
    stderr: r.stderr ? r.stderr.toString('utf8') : '',
  };
}

function isProtectedClass(cls) {
  return cls === 'security' || cls === 'safety' || cls === 'privacy';
}

/**
 * True when a check spec is protected either by its `class` OR by claiming `security|safety|privacy` in `attributes[]`.
 * Ensures protected attributes can NEVER be skipped by `allowFastSkip` or waived by `checkId`.
 */
function isProtectedCheck(spec) {
  if (!spec || typeof spec !== 'object') return false;
  if (isProtectedClass(spec.class)) return true;
  if (Array.isArray(spec.attributes) && spec.attributes.some(isProtectedClass)) return true;
  return false;
}

function protectedReasonLabel(spec) {
  if (spec && isProtectedClass(spec.class)) return spec.class;
  if (spec && Array.isArray(spec.attributes)) {
    const hit = spec.attributes.find(isProtectedClass);
    if (hit) return hit;
  }
  return 'security';
}

function checkIdentity(check) {
  return {
    id: check && check.id ? check.id : (check && check.command) || 'check',
    class: check && check.class,
    ...(Array.isArray(check && check.attributes) ? { attributes: check.attributes } : {}),
    cmd: check && check.command,
  };
}

function runCheck(check, { fastActive = false, capture = false } = {}) {
  const base = checkIdentity(check);
  if (!check || !check.command) return { ...base, state: 'BLOCKED', reason: 'no-command' };
  const exe = String(check.command).trim().split(/\s+/)[0];
  let shim = null;
  if (!whichCmd(exe)) {
    shim = findShim(exe);
    if (!shim) return { ...base, state: 'BLOCKED', reason: 'command-missing:' + exe };
  }
  // Protected checks (class OR attributes claiming security/safety/privacy) NEVER skip in fast mode!
  if (fastActive && !isProtectedCheck(check) && check.allowFastSkip) {
    return { ...base, state: 'SKIPPED', reason: 'fast-mode' };
  }
  const r = spawnCmd(check.command, { pathPrefix: shim });
  const found = shim ? { shim: repoRelative(shim) } : {};
  const res = r.code === 0
    ? { ...base, ...found, state: 'PASS', exit: 0 }
    : { ...base, ...found, state: 'FAIL', exit: r.code };
  return capture ? { ...res, stdout: r.stdout, stderr: r.stderr } : res;
}

function aggregateStates(states) {
  if (states.some((s) => s === 'FAIL')) return 'FAIL';
  if (states.some((s) => s === 'BLOCKED')) return 'BLOCKED';
  return 'PASS';
}

function requiredChecks(risk, module, catalog) {
  if (module && Array.isArray(module.verification)) return module.verification;
  const riskChecks = (catalog && catalog.riskChecks && typeof catalog.riskChecks === 'object') ? catalog.riskChecks : {};
  return (risk && Array.isArray(riskChecks[risk])) ? riskChecks[risk] : [];
}

function resolveCheck(ref, catalog) {
  if (ref && typeof ref === 'object') return ref;
  const defs = (catalog && catalog.checks && typeof catalog.checks === 'object') ? catalog.checks : {};
  const def = defs[ref];
  if (def && typeof def === 'object') return { id: ref, ...def };
  return { id: String(ref), command: undefined };
}

function verifyPlan(changed, catalog, { fastActive = false, nonGit = false, runCheckFn = null } = {}) {
  const run = typeof runCheckFn === 'function' ? runCheckFn : runCheck;
  const imp = analyzeImpact(changed, catalog, { nonGit });
  const byId = new Map((catalog.modules || []).map((m) => [m.id, m]));
  const entries = [];
  const seen = new Set();
  for (const id of imp.affected) {
    const m = byId.get(id);
    if (!m) continue;
    const risk = m.riskTier;
    for (const ref of requiredChecks(risk, m, catalog)) {
      const spec = resolveCheck(ref, catalog);
      const key = id + '::' + (spec.id || spec.command || JSON.stringify(ref));
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ module: id, spec });
    }
  }
  const waiverState = loadWaiverState();
  const waivers = waiverState.waivers;
  const { plan, waiversBlocked } = waivePlan(entries, waivers);
  const checks = [];
  for (const p of plan) {
    if (p.waiver) {
      checks.push({
        module: p.module,
        ...checkIdentity(p.spec),
        state: 'SKIPPED',
        reason: 'waiver:' + p.waiver.scope,
      });
      continue;
    }
    checks.push({ module: p.module, ...run(p.spec, { fastActive }) });
  }
  const attrs = assessAttributes(imp.affected, catalog, checks, waivers);
  const emptyPlan = imp.affected.length > 0 && checks.length === 0;
  return {
    state: emptyPlan ? 'BLOCKED' : aggregateStates(checks.map((c) => c.state)),
    checks,
    affected: imp.affected,
    degraded: imp.degraded,
    emptyPlan,
    attributes: attrs.attributes,
    attributeGaps: attrs.blockingGaps,
    ...(waiversBlocked.length ? { waiversBlocked } : {}),
    ...(waiverState.corrupt.length ? { corruptWaivers: waiverState.corrupt } : {}),
  };
}

function fastModeActive() {
  return tierState().fast;
}

function verifyPlanCmd(flags) {
  const loaded = loadCatalogFlag(flags);
  if (!loaded.ok) {
    return { result: { state: 'DEGRADED', degraded: true, error: loaded.error, detail: loaded.detail, checks: [], affected: [] }, code: 3 };
  }
  let changed;
  let nonGit = false;
  if (typeof flags.changed === 'string') {
    changed = parseCsv(flags.changed);
  } else {
    const cp = changedPaths();
    if (Array.isArray(cp)) changed = cp;
    else { changed = cp.paths; nonGit = !!cp.nonGit; }
  }
  if (nonGit) {
    return { result: { state: 'DEGRADED', degraded: true, note: 'non-git', checks: [], affected: [] }, code: 3 };
  }
  const fastActive = fastModeActive();
  const plan = verifyPlan(changed, loaded.catalog, { fastActive, nonGit });
  const attrBlocked = Array.isArray(plan.attributeGaps) && plan.attributeGaps.length > 0;
  const gate = (plan.state === 'FAIL' || plan.state === 'BLOCKED') ? plan.state
    : attrBlocked ? 'BLOCKED_BY_ATTRIBUTES' : 'PASS';
  const everySkipped = plan.checks.length > 0 && plan.checks.every((c) => c.state === 'SKIPPED');
  const code = gate !== 'PASS' ? 2 : everySkipped ? 3 : 0;
  return {
    result: { ...plan, gate, fastActive, ...(everySkipped ? { note: 'every-check-skipped' } : {}) },
    code,
  };
}

// ===========================================================================
// S10 waiver (security / safety / privacy strictly unwaivable)
// ===========================================================================
const WAIVER_FORBIDDEN_RE = /\b(safety|security|privacy|pii|secret|credential|destructive|push|deploy|production)\b/i;

function waiversDir() {
  return path.join(projectRoot(), '.cac', 'harness', 'waivers');
}

function validateWaiver(w) {
  const errors = [];
  if (!w || typeof w !== 'object' || Array.isArray(w)) return ['waiver must be an object'];
  if (w.version !== 1) errors.push('version must be 1');
  for (const k of ['owner', 'reason', 'scope', 'expiry', 'compensation', 'created_at']) {
    if (typeof w[k] !== 'string' || !String(w[k]).trim()) errors.push(k + ' required (non-empty string)');
  }
  const createdMs = Date.parse(w.created_at);
  if (typeof w.created_at === 'string' && Number.isNaN(createdMs)) {
    errors.push('created_at must be ISO timestamp');
  }
  const expMs = Date.parse(w.expiry);
  if (typeof w.expiry === 'string') {
    if (Number.isNaN(expMs)) errors.push('expiry must be ISO timestamp');
    else if (expMs <= Date.now()) errors.push('expiry must be in the future (not expired)');
  }
  const blob = (String(w.reason || '') + ' ' + String(w.scope || '')).toLowerCase();
  if (WAIVER_FORBIDDEN_RE.test(blob)) {
    errors.push('forbidden keyword in reason|scope (safety|security|privacy|pii|secret|credential|destructive|push|deploy|production)');
  }
  return errors;
}

function loadWaiverState() {
  const dir = waiversDir();
  const listing = readDirNames(dir);
  if (listing.error) {
    const detail = errDetail(listing.error);
    recordCorruptState({ kind: 'waiver', path: dir, reason: detail });
    return { waivers: [], corrupt: [repoRelative(dir)] };
  }
  if (listing.absent) return { waivers: [], corrupt: [] };
  const out = [];
  const corrupt = [];
  for (const n of listing.names.sort()) {
    if (!n.endsWith('.json')) continue;
    const fp = path.join(dir, n);
    let obj;
    try {
      obj = JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch (e) {
      corrupt.push(repoRelative(fp));
      recordCorruptState({ kind: 'waiver', path: fp, reason: errDetail(e) });
      continue;
    }
    if (validateWaiver(obj).length) continue;
    out.push({ ...obj, _path: fp });
  }
  return { waivers: out, corrupt };
}

function loadWaivers() {
  return loadWaiverState().waivers;
}

function findWaiverForCheck(checkId, waivers) {
  const id = String(checkId == null ? '' : checkId);
  const list = Array.isArray(waivers) ? waivers : [];
  for (const w of list) {
    if (w && w.scope === id) return w;
  }
  return null;
}

function waivePlan(entries, waivers) {
  const plan = [];
  const waiversBlocked = [];
  for (const e of (Array.isArray(entries) ? entries : [])) {
    const spec = (e && e.spec) || {};
    const { id } = checkIdentity(spec);
    const hit = findWaiverForCheck(id, waivers);
    if (hit && isProtectedCheck(spec)) {
      waiversBlocked.push({
        check: id,
        module: (e && e.module !== undefined) ? e.module : null,
        class: protectedReasonLabel(spec),
        scope: hit.scope,
      });
      plan.push({ module: e && e.module, spec, waiver: null });
      continue;
    }
    plan.push({ module: e && e.module, spec, waiver: hit || null });
  }
  return { plan, waiversBlocked };
}

function applyWaiver(result, waivers) {
  if (!result || typeof result !== 'object') return result;
  const state = result.state;
  if (state !== 'FAIL' && state !== 'BLOCKED') return result;
  if (isProtectedCheck(result)) return result;
  const hit = findWaiverForCheck(result.id, waivers);
  if (!hit) return result;
  return { ...result, state: 'SKIPPED', reason: 'waiver:' + hit.scope };
}

function cmdWaiver(flags = {}, positional = []) {
  const sub = positional[0] || flags.sub || 'list';
  if (sub === 'list') {
    const state = loadWaiverState();
    const list = state.waivers.map((w) => {
      const { _path, ...rest } = w;
      return { path: _path ? repoRelative(_path) : null, ...rest };
    });
    return emit({
      ok: true,
      waivers: list,
      ...(state.corrupt.length ? { corruptWaivers: state.corrupt } : {}),
    }, 0);
  }
  if (sub === 'check') {
    const file = (typeof flags.file === 'string' && flags.file) || positional[1] || '';
    if (!file) return emit({ ok: false, valid: false, errors: ['--file or path required'], waiver: null }, 1);
    let obj;
    try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { return emit({ ok: false, valid: false, errors: ['read/parse: ' + String((e && e.message) || e)], waiver: null }, 1); }
    const errors = validateWaiver(obj);
    const valid = errors.length === 0;
    return emit({ ok: valid, valid, errors, waiver: obj }, valid ? 0 : 1);
  }
  if (sub === 'create') {
    const now = new Date().toISOString();
    const waiver = {
      version: 1,
      owner: typeof flags.owner === 'string' ? flags.owner : '',
      reason: typeof flags.reason === 'string' ? flags.reason : '',
      scope: typeof flags.scope === 'string' ? flags.scope : '',
      expiry: typeof flags.expiry === 'string' ? flags.expiry : '',
      compensation: typeof flags.compensation === 'string' ? flags.compensation : '',
      created_at: now,
    };
    const errors = validateWaiver(waiver);
    if (errors.length) {
      process.stderr.write('waiver create rejected: ' + errors.join('; ') + '\n');
      return emit({ ok: false, errors, waiver }, 1);
    }
    waiver.contentHash = contentHash(waiver);
    if (flags['dry-run'] === true || flags.dryRun === true) {
      return emit({ ok: true, dryRun: true, path: null, waiver }, 0);
    }
    const dir = waiversDir();
    fs.mkdirSync(dir, { recursive: true });
    const ts = now.replace(/[:.]/g, '-');
    const h10 = String(waiver.contentHash).slice(0, 10);
    const fname = ts + '-' + h10 + '.json';
    const fp = path.join(dir, fname);
    fs.writeFileSync(fp, JSON.stringify(waiver, null, 2) + '\n', 'utf8');
    return emit({ ok: true, path: repoRelative(fp), waiver }, 0);
  }
  return emit({ error: 'waiver-subcommand', detail: 'usage: waiver list|check|create', got: sub || null }, 3);
}

// ===========================================================================
// S11 attributes (single-pass non-duplicate assessment + protected attribute waiver block)
// ===========================================================================
function claimingChecks(module, catalog, attr) {
  const out = [];
  for (const ref of requiredChecks(module && module.riskTier, module, catalog)) {
    const spec = resolveCheck(ref, catalog);
    if (Array.isArray(spec.attributes) && spec.attributes.includes(attr)) out.push(spec.id);
  }
  return out;
}

function assessAttributes(affectedIds, catalog, checkResults, waivers = []) {
  const byId = new Map((catalog.modules || []).map((m) => [m.id, m]));
  const attributes = [];
  const blockingGaps = [];
  const seenModAttr = new Set();

  for (const moduleId of (affectedIds || [])) {
    const m = byId.get(moduleId);
    if (!m || !m.attributes) continue;
    for (const [attr, req] of Object.entries(m.attributes)) {
      const dedupKey = `${moduleId}\0${attr}`;
      if (seenModAttr.has(dedupKey)) continue;
      seenModAttr.add(dedupKey);

      const { tier, reason } = normalizeTier(req);
      const enforcement = TIER_ENFORCEMENT[tier] || 'warn';
      if (tier === 'none') {
        attributes.push({ module: moduleId, attribute: attr, tier, enforcement, covered: true, evidence: [], reason: 'opted out: ' + reason });
        continue;
      }
      const claiming = claimingChecks(m, catalog, attr);
      const evidence = claiming.map((id) => {
        const r = checkResults.find((c) => c.module === moduleId && c.id === id);
        return { check: id, state: r ? r.state : 'MISSING' };
      });
      const passing = evidence.filter((e) => e.state === 'PASS');
      const contradicting = evidence.filter((e) => e.state === 'FAIL' || e.state === 'BLOCKED');
      const covered = passing.length > 0 && contradicting.length === 0;
      const entry = {
        module: moduleId,
        attribute: attr,
        tier,
        enforcement,
        covered,
        evidence,
        reason: contradicting.length > 0
          ? 'contradicted by ' + contradicting.map((e) => e.check + '(' + e.state + ')').join(',')
          : covered
            ? 'evidenced by ' + passing.map((e) => e.check).join(',')
            : claiming.length === 0
              ? 'no check in this module verification list claims ' + attr
              : 'claiming checks have not passed for the current change',
      };
      if (!covered && enforcement === 'block') {
        // Protected attributes (security / safety / privacy) and critical tier can NEVER be waived!
        const w = (tier === 'high' && !isProtectedClass(attr))
          ? findWaiverForCheck('attribute:' + moduleId + '/' + attr, waivers)
          : null;
        if (w) {
          entry.waived = true;
          entry.reason = entry.reason + '; deferred by waiver:' + w.scope;
        } else {
          blockingGaps.push({ module: moduleId, attribute: attr, tier, reason: entry.reason });
        }
      }
      attributes.push(entry);
    }
  }
  return { attributes, blockingGaps };
}

function cmdAttributes(flags) {
  const loaded = loadCatalogFlag(flags);
  if (!loaded.ok) {
    return emit({ ok: false, degraded: true, error: loaded.error, detail: loaded.detail }, 3);
  }
  const catalog = loaded.catalog;
  const only = typeof flags.module === 'string' ? flags.module : null;
  const report = [];
  let unwiredBlocking = 0;
  const byTier = {};
  const seenModAttr = new Set();

  for (const m of (catalog.modules || [])) {
    if (only && m.id !== only) continue;
    for (const [attr, req] of Object.entries(m.attributes || {})) {
      const dedupKey = `${m.id}\0${attr}`;
      if (seenModAttr.has(dedupKey)) continue;
      seenModAttr.add(dedupKey);

      const { tier, reason } = normalizeTier(req);
      const enforcement = TIER_ENFORCEMENT[tier] || 'warn';
      byTier[tier] = (byTier[tier] || 0) + 1;
      if (tier === 'none') {
        report.push({ module: m.id, attribute: attr, tier, enforcement, wired: [], reason });
        continue;
      }
      const wired = claimingChecks(m, catalog, attr);
      const entry = { module: m.id, attribute: attr, tier, enforcement, wired };
      if (wired.length === 0) {
        entry.gap = 'declared but no claiming check is wired';
        if (enforcement === 'block') unwiredBlocking++;
      }
      report.push(entry);
    }
  }
  return emit({
    ok: unwiredBlocking === 0,
    declared: report.length,
    byTier,
    unwiredBlocking,
    attributes: report,
  }, unwiredBlocking === 0 ? 0 : 1);
}

export {
  receiptsDir, safeTaskId, contentHash, engineFiles, engineHash, hasCodeChange, writeReceipt,
  receiptIntact, matchReceipts, loadReceipts, verifyReceipt, cmdReceipt, cmdVerify,
  shimDirs, findShim, pathPrefixedEnv,
  isProtectedClass, isProtectedCheck, checkIdentity,
  runCheck, aggregateStates, requiredChecks, resolveCheck, verifyPlan, fastModeActive, verifyPlanCmd,
  WAIVER_FORBIDDEN_RE, waiversDir, validateWaiver, loadWaiverState, loadWaivers, findWaiverForCheck,
  waivePlan, applyWaiver, cmdWaiver,
  claimingChecks, assessAttributes, cmdAttributes,
};
