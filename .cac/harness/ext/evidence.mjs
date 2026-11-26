// ext/evidence.mjs — S17 the evidence layer: `gate`, hash-chained `ledger`, `gate-audit`, `retention`, `risk`.
// Depends on ../lib/{core,tier}.mjs and ./{catalog,graph,quality}.mjs.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  TIER_ENFORCEMENT,
  changedPaths, emit, errDetail, gitFingerprint, headCommit, isStateExcluded, matchAny,
  normalizeTier, parseCsv, projectRoot, quarantineFilePath, readTextFile, recordCorruptState,
  repoRelative, sha256, sha256Lf, toPosixPath, withDirLock,
} from '../lib/core.mjs';
import { governancePaths } from '../lib/tier.mjs';
import { loadCatalogFlag } from './catalog.mjs';
import { analyzeImpact } from './graph.mjs';
import {
  claimingChecks, fastModeActive, loadWaivers, requiredChecks, resolveCheck, runCheck,
  verifyPlan, waiversDir,
} from './quality.mjs';

// ---------------------------------------------------------------------------
// S17.1 runtime state locations + atomic write
// ---------------------------------------------------------------------------
function stateDir() {
  return path.join(projectRoot(), '.cac', 'harness', 'state');
}
function ledgerFilePath() {
  return path.join(stateDir(), 'ledger.jsonl');
}
function ledgerLockPath() {
  return path.join(stateDir(), 'ledger.lock');
}
function taskFilePath() {
  return path.join(stateDir(), 'task.json');
}
function evidenceDir() {
  return path.join(projectRoot(), '.cac', 'harness', 'evidence');
}
function contextPackDir() {
  return path.join(stateDir(), 'context');
}

function relFromRoot(p) {
  return repoRelative(p);
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, file);
}

function readJsonFile(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_e) { return fallback; }
}

function readTaskState() {
  const fp = taskFilePath();
  const read = readTextFile(fp);
  if (read.absent) return { task: null, corrupt: null };
  let detail = read.error ? errDetail(read.error) : null;
  if (!detail) {
    try { return { task: JSON.parse(read.text), corrupt: null }; } catch (e) {
      detail = errDetail(e);
    }
  }
  recordCorruptState({ kind: 'task', path: fp, reason: detail });
  return { task: null, corrupt: { path: relFromRoot(fp), detail } };
}

function readTaskRecord() {
  return readTaskState().task;
}

// ---------------------------------------------------------------------------
// S17.2 ledger (append-only, hash-chained; a break fails closed)
// ---------------------------------------------------------------------------
const GENESIS = '0'.repeat(64);

function chainHash(prev, contentHash) {
  return sha256(String(prev) + '\0' + String(contentHash));
}

function ledgerLine(record, prev) {
  const contentHash = sha256Lf(JSON.stringify(record));
  return { ...record, contentHash, prev, chain: chainHash(prev, contentHash) };
}

function parseLedgerLines(raw) {
  return String(raw == null ? '' : raw).replace(/\r\n/g, '\n').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (_e) { return { corrupt: true, raw: l }; }
  });
}

function readLedgerState() {
  let raw;
  try {
    raw = fs.readFileSync(ledgerFilePath(), 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { entries: [], unreadable: null };
    return { entries: [], unreadable: String((e && e.code) || (e && e.message) || e) };
  }
  return { entries: parseLedgerLines(raw), unreadable: null };
}

function endsWithNewline(file) {
  let fd;
  try {
    const size = fs.statSync(file).size;
    if (size === 0) return true;
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(1);
    fs.readSync(fd, buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } catch (_e) {
    return true;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_e) { /* ignore */ } }
  }
}

function appendLedger(record) {
  fs.mkdirSync(stateDir(), { recursive: true });
  return withDirLock(ledgerLockPath(), () => {
    const state = readLedgerState();
    if (state.unreadable) {
      throw new Error('ledger is present but unreadable (' + state.unreadable
        + '); appending onto a tail nobody can read would break the chain');
    }
    const file = ledgerFilePath();
    const last = state.entries.length ? state.entries[state.entries.length - 1] : null;
    const prev = (last && typeof last.chain === 'string') ? last.chain : GENESIS;
    const line = ledgerLine(record, prev);
    if (!endsWithNewline(file)) fs.appendFileSync(file, '\n', 'utf8');
    fs.appendFileSync(file, JSON.stringify(line) + '\n', 'utf8');
    return line;
  });
}

function verifyLedgerChain(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const breaks = [];
  let prev = GENESIS;
  list.forEach((e, i) => {
    const line = i + 1;
    if (!e || typeof e !== 'object' || e.corrupt) {
      breaks.push({ line, reason: 'unparseable-line', at: null });
      return;
    }
    const { contentHash, prev: recordedPrev, chain, ...rest } = e;
    const at = typeof e.at === 'string' ? e.at : null;
    if (sha256Lf(JSON.stringify(rest)) !== contentHash) {
      breaks.push({ line, reason: 'content-hash-mismatch', at });
    }
    if (recordedPrev !== prev) {
      breaks.push({ line, reason: 'chain-predecessor-mismatch', at });
    }
    if (chainHash(prev, contentHash) !== chain) {
      breaks.push({ line, reason: 'chain-hash-mismatch', at });
    }
    prev = typeof chain === 'string' ? chain : prev;
  });
  return { ok: breaks.length === 0, entries: list.length, breaks, head: prev };
}

function evidenceFindings(entries, { readFile } = {}) {
  const read = typeof readFile === 'function'
    ? readFile
    : (rel) => fs.readFileSync(path.join(projectRoot(), rel), 'utf8');
  const breaks = [];
  let checked = 0;
  (entries || []).forEach((e, i) => {
    if (!e || e.corrupt || e.command !== 'gate') return;
    for (const r of (e.results || [])) {
      if (!r || typeof r.evidence !== 'string' || !r.evidence) continue;
      if (typeof r.evidenceSha256 !== 'string' || !r.evidenceSha256) continue;
      checked++;
      const at = { line: i + 1, check: r.id === undefined ? null : r.id, evidence: r.evidence };
      let content;
      try {
        content = read(r.evidence);
      } catch (err) {
        breaks.push({ ...at, reason: 'evidence-missing', detail: String((err && err.code) || 'read-error') });
        continue;
      }
      if (sha256Lf(content) !== r.evidenceSha256) {
        breaks.push({ ...at, reason: 'evidence-tampered', detail: sha256Lf(content).slice(0, 12) });
      }
    }
  });
  return { ok: breaks.length === 0, checked, breaks };
}

function ledgerReport({ entries = [], unreadable = null, evidence = null, path: file = '' } = {}) {
  if (unreadable) {
    return {
      result: {
        ok: false, entries: null, breaks: [], head: null,
        unreadable, evidence: null, path: file,
      },
      code: 3,
    };
  }
  const chain = verifyLedgerChain(entries);
  const ok = chain.ok && (evidence === null || evidence.ok);
  return {
    result: {
      ok, entries: chain.entries, breaks: chain.breaks, head: chain.head, unreadable: null,
      evidence: evidence === null ? null : { checked: evidence.checked, breaks: evidence.breaks },
      path: file,
    },
    code: ok ? 0 : 1,
  };
}

function cmdLedger(flags = {}) {
  const state = readLedgerState();
  const skipEvidence = flags['no-verify-evidence'] === true || flags['no-verify-evidence'] === 'true';
  const evidence = (state.unreadable || skipEvidence) ? null : evidenceFindings(state.entries);
  const { result, code } = ledgerReport({ ...state, evidence, path: relFromRoot(ledgerFilePath()) });
  const where = relFromRoot(ledgerFilePath());
  if (state.unreadable) {
    process.stderr.write('ledger at ' + where + ' exists but could not be read (' + state.unreadable + ')\n');
    process.stderr.write('an unreadable ledger is not an intact one: nothing recorded in it can be checked, '
      + 'so treat every earlier verification as unproven until the file is readable again\n');
  } else if (!result.ok) {
    const total = result.breaks.length + (evidence ? evidence.breaks.length : 0);
    process.stderr.write('ledger integrity broken (' + total + ' break(s)) at ' + where + '\n');
    for (const b of result.breaks.slice(0, 10)) {
      process.stderr.write('  line ' + b.line + ': ' + b.reason + (b.at ? ' (' + b.at + ')' : '') + '\n');
    }
    if (result.breaks.length > 10) process.stderr.write('  ... ' + (result.breaks.length - 10) + ' more chain break(s)\n');
    for (const b of (evidence ? evidence.breaks.slice(0, 10) : [])) {
      process.stderr.write('  line ' + b.line + ': ' + b.reason + ' for check ' + b.check + ' (' + b.evidence + ')\n');
    }
    process.stderr.write('every verification recorded here is unproven; do not hand-repair the file\n');
  }
  return emit(result, code);
}

// ---------------------------------------------------------------------------
// S17.3 gate (verify + evidence on disk + planHash + one ledger entry)
// ---------------------------------------------------------------------------
function buildPlan(affected, catalog) {
  const byId = new Map(((catalog && catalog.modules) || []).map((m) => [m.id, m]));
  const planned = new Map();
  for (const id of (affected || [])) {
    const m = byId.get(id);
    if (!m) continue;
    for (const ref of requiredChecks(m.riskTier, m, catalog)) {
      const spec = resolveCheck(ref, catalog);
      const checkId = String(spec.id || spec.command || ref);
      if (!planned.has(checkId)) planned.set(checkId, { checkId, modules: [] });
      const entry = planned.get(checkId);
      if (!entry.modules.includes(id)) entry.modules.push(id);
    }
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const entries = [...planned.values()]
    .map((e) => ({ checkId: e.checkId, modules: e.modules.slice().sort(cmp) }))
    .sort((a, b) => cmp(a.checkId, b.checkId));
  return {
    entries,
    hash: sha256Lf(JSON.stringify(entries.map((e) => [e.checkId, e.modules]))),
    empty: entries.length === 0,
  };
}

function evidenceFilePath(id) {
  const safeId = String(id == null ? '' : id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'check';
  const base = path.join(evidenceDir(), safeId + '-' + Date.now());
  fs.mkdirSync(evidenceDir(), { recursive: true });
  for (let n = 0; ; n++) {
    const file = n === 0 ? base + '.log' : base + '-' + n + '.log';
    try {
      fs.closeSync(fs.openSync(file, 'wx'));
      return file;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
    }
  }
}

function runCheckWithEvidence(spec, opts) {
  const started = Date.now();
  const res = runCheck(spec, { ...opts, capture: true });
  const durationMs = Date.now() - started;
  const { stdout, stderr, ...rest } = res;
  const out = { ...rest, durationMs };
  if (res.state !== 'PASS' && res.state !== 'FAIL') {
    return { ...out, evidence: null, evidenceSha256: null };
  }
  const output = String(stdout || '') + (stderr ? '\n--- stderr ---\n' + String(stderr) : '');
  try {
    const file = evidenceFilePath(res.id);
    writeAtomic(file, output);
    return { ...out, evidence: relFromRoot(file), evidenceSha256: sha256Lf(output) };
  } catch (e) {
    return { ...out, evidence: null, evidenceSha256: null, evidenceError: String((e && e.message) || e) };
  }
}

function gateReason(gate, run) {
  if (gate === 'FAIL') return 'at-least-one-check-failed';
  if (gate === 'BLOCKED') {
    return run.emptyPlan
      ? 'empty-plan: modules were affected but no check resolved, so nothing was established'
      : 'at-least-one-check-blocked';
  }
  if (gate === 'BLOCKED_BY_ATTRIBUTES') {
    return run.attributeGaps.length + ' blocking quality-attribute gap(s): checks that prove '
      + 'nothing about a critical/high attribute do not close the gate';
  }
  if (!run.checks.length) return 'no-affected-module';
  if (run.checks.every((c) => c.state === 'SKIPPED')) return 'every-check-skipped';
  return 'all-executed-checks-passed';
}

function suppressionOf(recorded, raw) {
  const reason = (recorded && typeof recorded.reason === 'string') ? recorded.reason : '';
  if (reason.startsWith('waiver:')) {
    return {
      by: 'waiver',
      scope: reason.slice('waiver:'.length),
      from: (raw && typeof raw.state === 'string') ? raw.state : null,
    };
  }
  if (reason === 'fast-mode') return { by: 'fast-mode', scope: null, from: null };
  return null;
}

function waiversApplied(checks, waivers) {
  const out = [];
  for (const c of (checks || [])) {
    if (typeof c.reason !== 'string' || !c.reason.startsWith('waiver:')) continue;
    const scope = c.reason.slice('waiver:'.length);
    const w = (waivers || []).find((x) => x && x.scope === scope) || null;
    out.push({
      check: c.id,
      scope,
      waiver: (w && w._path) ? relFromRoot(w._path) : null,
      expiry: (w && typeof w.expiry === 'string') ? w.expiry : null,
    });
  }
  return out;
}

function cmdGate(flags) {
  const loaded = loadCatalogFlag(flags);
  if (!loaded.ok) {
    return emit({
      gate: 'DEGRADED', degraded: true, reason: loaded.error, detail: loaded.detail,
      modules: [], results: [],
    }, 3);
  }
  const catalog = loaded.catalog;

  let changed;
  let nonGit = false;
  let scopeSource = 'computed';
  let scopeRequested = null;
  if (typeof flags.changed === 'string') {
    changed = parseCsv(flags.changed);
    scopeSource = 'caller';
    scopeRequested = changed.slice(0, 50);
  } else {
    const cp = changedPaths();
    if (Array.isArray(cp)) { changed = cp; }
    else { changed = cp.paths; nonGit = !!cp.nonGit; }
  }
  if (nonGit) {
    return emit({ gate: 'DEGRADED', degraded: true, reason: 'non-git', modules: [], results: [] }, 3);
  }

  const fastActive = fastModeActive();
  const imp = analyzeImpact(changed, catalog, { nonGit });
  const plan = buildPlan(imp.affected, catalog);
  const run = verifyPlan(changed, catalog, { fastActive, nonGit, runCheckFn: runCheckWithEvidence });

  const attrBlocked = Array.isArray(run.attributeGaps) && run.attributeGaps.length > 0;
  const gate = (run.state === 'FAIL' || run.state === 'BLOCKED') ? run.state
    : attrBlocked ? 'BLOCKED_BY_ATTRIBUTES' : 'PASS';
  const everySkipped = run.checks.length > 0 && run.checks.every((c) => c.state === 'SKIPPED');
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const record = {
    command: 'gate',
    at: new Date().toISOString(),
    gate,
    reason: gateReason(gate, run),
    baseCommit: headCommit(),
    diffHash: gitFingerprint(),
    planHash: plan.hash,
    scopeSource,
    scopeRequested,
    modules: run.affected.slice().sort(cmp),
    degraded: !!run.degraded,
    fastActive,
    skippedByFastMode: run.checks.filter((c) => c.reason === 'fast-mode').map((c) => c.id),
    results: run.checks.map((c) => ({
      id: c.id,
      module: c.module === undefined ? null : c.module,
      state: c.state,
      reason: c.reason === undefined ? null : c.reason,
      exit: c.exit === undefined ? null : c.exit,
      durationMs: c.durationMs === undefined ? null : c.durationMs,
      evidence: c.evidence === undefined ? null : c.evidence,
      evidenceSha256: c.evidenceSha256 === undefined ? null : c.evidenceSha256,
      suppressed: suppressionOf(c, null),
    })),
    attributeCoverage: run.attributes,
    attributeGaps: run.attributeGaps,
    waivers: waiversApplied(run.checks, loadWaivers()),
  };
  let line = null;
  let ledgerError = null;
  try {
    line = appendLedger(record);
  } catch (e) {
    ledgerError = String((e && e.message) || e);
  }
  if (ledgerError) {
    process.stderr.write('gate ran but could not append its record to the ledger: ' + ledgerError + '\n');
    process.stderr.write('an unrecorded verification is not evidence; nothing downstream may treat this run as proof\n');
    return emit({ ...record, ledger: { path: relFromRoot(ledgerFilePath()), chain: null, error: ledgerError } },
      gate === 'PASS' ? 3 : 2);
  }
  return emit({ ...record, ledger: { path: relFromRoot(ledgerFilePath()), chain: line.chain, error: null } },
    gate === 'PASS' ? (everySkipped ? 3 : 0) : 2);
}

// ---------------------------------------------------------------------------
// S17.4 gate-audit
// ---------------------------------------------------------------------------
function auditGates(entries, catalog) {
  const declared = Object.keys((catalog && catalog.checks) || {});
  const executed = new Set();
  const intervened = new Set();
  const suppressed = new Map();
  let gateRuns = 0;
  for (const e of (entries || [])) {
    if (!e || e.corrupt || e.command !== 'gate') continue;
    gateRuns++;
    for (const r of (e.results || [])) {
      const supp = (r && r.suppressed) ? r.suppressed : null;
      const state = (supp && supp.from) ? supp.from : r.state;
      if (state === 'PASS' || state === 'FAIL') executed.add(r.id);
      if (state === 'FAIL' || state === 'BLOCKED') intervened.add(r.id);
      if (!supp) continue;
      if (!suppressed.has(r.id)) suppressed.set(r.id, { check: r.id, occurrences: 0, by: new Set(), suppressedStates: new Set() });
      const bucket = suppressed.get(r.id);
      bucket.occurrences++;
      bucket.by.add(supp.by);
      if (supp.from) bucket.suppressedStates.add(supp.from);
    }
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const neverIntervened = declared.filter((id) => !intervened.has(id)).sort(cmp);
  const neverExecuted = declared.filter((id) => !executed.has(id)).sort(cmp);
  const suppressedList = [...suppressed.values()]
    .map((b) => ({ check: b.check, occurrences: b.occurrences, by: [...b.by].sort(cmp), suppressedStates: [...b.suppressedStates].sort(cmp) }))
    .sort((a, b) => cmp(a.check, b.check));
  const advice = neverIntervened.length
    ? 'These checks have never failed or blocked. Either they are genuinely stable, or they never actually run. '
      + 'Confirm with evidence before keeping them -- a gate that has caught nothing is cost plus false confidence.'
    : 'Every declared check has intervened at least once.';
  return {
    scope: 'catalog checks in the harness ledger (hook gates are audited by .cac/scripts/gate-audit.mjs)',
    gateRuns,
    declaredChecks: declared.length,
    neverIntervened,
    neverExecuted,
    suppressed: suppressedList,
    advice: suppressedList.length
      ? advice + ' Separately, ' + suppressedList.length + ' check(s) were suppressed rather than silent: see suppressed[].'
      : advice,
  };
}

function cmdGateAudit(flags) {
  const loaded = loadCatalogFlag(flags);
  if (!loaded.ok) {
    return emit({ ok: false, degraded: true, error: loaded.error, detail: loaded.detail }, 3);
  }
  const state = readLedgerState();
  if (state.unreadable) {
    process.stderr.write('gate-audit cannot read the ledger (' + state.unreadable
      + '); with no history there is nothing to audit, and an empty history would read as "no check ever ran"\n');
    return emit({ ok: false, degraded: true, error: 'ledger-unreadable', detail: state.unreadable }, 3);
  }
  return emit({ ok: true, ...auditGates(state.entries, loaded.catalog) }, 0);
}

// ---------------------------------------------------------------------------
// S17.5 retention
// ---------------------------------------------------------------------------
function planRetention(files, { protectedPaths = new Set(), keep = 0, cutoffMs = 0 } = {}) {
  const sorted = (files || []).slice().sort((a, b) => (b.mtimeMs - a.mtimeMs)
    || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const out = [];
  sorted.forEach((f, i) => {
    if (protectedPaths.has(f.path)) return;
    const overCount = i >= keep;
    const overAge = f.mtimeMs < cutoffMs;
    if (!overCount && !overAge) return;
    out.push({ path: f.path, reason: overCount ? 'over-count' : 'over-age' });
  });
  return out;
}

function ledgerReferencedEvidence(entries) {
  const out = new Set();
  for (const e of (entries || [])) {
    if (!e || e.corrupt) continue;
    for (const r of (e.results || [])) {
      if (r && typeof r.evidence === 'string' && r.evidence) out.add(r.evidence);
    }
  }
  return out;
}

function listDirFiles(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (_e) { return []; }
  const out = [];
  for (const n of names.sort()) {
    const abs = path.join(dir, n);
    try {
      const st = fs.statSync(abs);
      if (st.isFile()) out.push({ path: relFromRoot(abs), mtimeMs: st.mtimeMs });
    } catch (_e) { /* vanished */ }
  }
  return out;
}

function intFlag(v, dflt) {
  if (typeof v !== 'string') return dflt;
  const n = parseInt(v, 10);
  return (Number.isNaN(n) || n < 0) ? dflt : n;
}

function retentionRefusal(unreadable, chain) {
  if (unreadable) return { reason: 'ledger-unreadable', detail: unreadable };
  if (chain && !chain.ok) {
    const first = chain.breaks[0];
    return {
      reason: 'ledger-chain-broken',
      detail: chain.breaks.length + ' break(s), first at line ' + first.line + ': ' + first.reason,
    };
  }
  return null;
}

function cmdRetention(flags) {
  const apply = flags.apply === true || flags.apply === 'true';
  const maxAgeDays = intFlag(flags['max-age-days'], 30);
  const maxEvidence = intFlag(flags['max-evidence'], 400);
  const maxPacks = intFlag(flags['max-packs'], 60);
  const cutoffMs = Date.now() - maxAgeDays * 86400000;
  const limits = { maxAgeDays, maxEvidence, maxPacks };
  const dirs = {
    evidence: relFromRoot(evidenceDir()),
    contextPacks: relFromRoot(contextPackDir()),
  };

  const state = readLedgerState();
  const refused = retentionRefusal(state.unreadable, state.unreadable ? null : verifyLedgerChain(state.entries));
  if (refused) {
    process.stderr.write('retention refused to sweep: ' + refused.reason + ' (' + refused.detail + ')\n');
    process.stderr.write('the set of files the ledger protects cannot be established, and an unknown '
      + 'protected set is not an empty one; nothing was removed\n');
    return emit({
      ok: false, applied: apply, refused, candidates: 0, removed: 0, protectedByLedger: null,
      limits, dirs, plan: [], errors: [],
    }, 3);
  }
  const protectedPaths = ledgerReferencedEvidence(state.entries);

  const plan = [
    ...planRetention(listDirFiles(evidenceDir()), { protectedPaths, keep: maxEvidence, cutoffMs }),
    ...planRetention(listDirFiles(contextPackDir()), { protectedPaths, keep: maxPacks, cutoffMs }),
  ];

  let removed = 0;
  const errors = [];
  if (apply) {
    for (const item of plan) {
      try { fs.unlinkSync(path.join(projectRoot(), item.path)); removed++; }
      catch (e) { errors.push({ path: item.path, error: String((e && e.message) || e) }); }
    }
    for (const err of errors) process.stderr.write('retention could not remove ' + err.path + ': ' + err.error + '\n');
  }
  return emit({
    ok: errors.length === 0,
    applied: apply,
    refused: null,
    candidates: plan.length,
    removed,
    protectedByLedger: protectedPaths.size,
    limits,
    dirs,
    plan: plan.slice(0, 100),
    errors,
  }, errors.length === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// S17.6 risk
// ---------------------------------------------------------------------------
function readWaiverFiles() {
  const dir = waiversDir();
  let names;
  try { names = fs.readdirSync(dir); } catch (_e) { return []; }
  const out = [];
  for (const n of names.sort()) {
    if (!n.endsWith('.json')) continue;
    const fp = path.join(dir, n);
    const obj = readJsonFile(fp, null);
    if (obj && typeof obj === 'object') out.push({ ...obj, _path: fp });
  }
  return out;
}

const GOVERNANCE_LIST_CAP = 20;

function governanceSurface(changed, globs = governancePaths()) {
  const out = [];
  for (const p of (changed || [])) {
    const rel = toPosixPath(p);
    if (isStateExcluded(rel)) continue;
    if (matchAny(rel, globs)) out.push(rel);
  }
  return out.sort();
}

function riskFindings({
  ledgerEntries = [],
  ledgerUnreadable = null,
  evidenceBreaks = [],
  catalog = null,
  waivers = [],
  task = null,
  changed = [],
  quarantine = null,
  fastActive = false,
  now = Date.now(),
} = {}) {
  const findings = [];

  if (ledgerUnreadable) {
    findings.push({
      severity: 'error', code: 'LEDGER_UNREADABLE',
      message: 'the verification ledger exists but could not be read (' + ledgerUnreadable
        + '); nothing recorded in it can be checked, and an unreadable ledger is not an intact one',
    });
  }

  for (const b of (evidenceBreaks || [])) {
    findings.push({
      severity: 'error',
      code: b.reason === 'evidence-missing' ? 'EVIDENCE_MISSING' : 'EVIDENCE_TAMPERED',
      check: b.check === undefined ? null : b.check,
      message: 'the evidence log for check "' + b.check + '" (' + b.evidence + ') '
        + (b.reason === 'evidence-missing'
          ? 'is gone, so the recorded digest proves nothing about a file nobody can read'
          : 'no longer matches the digest recorded beside it, so its verdict rests on output that has since changed'),
    });
  }

  const chain = verifyLedgerChain(ledgerEntries);
  if (!chain.ok) {
    findings.push({
      severity: 'error', code: 'LEDGER_BROKEN',
      message: 'the verification ledger chain is broken (' + chain.breaks.length
        + ' break(s), first at line ' + chain.breaks[0].line + ': ' + chain.breaks[0].reason
        + '); treat every recorded green as unproven and re-run the gates',
    });
  }

  if (quarantine && quarantine.unreadable) {
    findings.push({
      severity: 'warning', code: 'QUARANTINE_UNREADABLE', path: quarantine.unreadable.path,
      detail: quarantine.unreadable.detail,
      message: quarantine.unreadable.path + ' exists and cannot be read (' + quarantine.unreadable.detail
        + '), so however many damaged artefacts were recorded in it, none of them are being reported here',
    });
  }
  if (quarantine && quarantine.count > 0) {
    findings.push({
      severity: 'warning', code: 'QUARANTINED_STATE', count: quarantine.count,
      files: quarantine.files, path: quarantine.lastPath || null,
      message: quarantine.count + ' corruption detection(s) across ' + quarantine.files
        + ' file(s) are recorded in ' + relFromRoot(quarantineFilePath()) + ', most recently '
        + (quarantine.lastKind ? quarantine.lastKind + ' ' : '') + (quarantine.lastPath || 'an unnamed file')
        + '; each was refused where it mattered and left on disk as evidence -- read it, then repair or delete it',
    });
  }

  for (const w of waivers) {
    const expiryMs = Date.parse(w && w.expiry);
    if (!Number.isNaN(expiryMs) && expiryMs <= now) {
      findings.push({
        severity: 'error', code: 'EXPIRED_WAIVER',
        message: 'waiver ' + (w._path ? relFromRoot(w._path) : (w.scope || 'unknown'))
          + ' expired on ' + w.expiry + ' and is now inert; delete it or renew it with a fresh justification',
      });
    }
  }

  if (catalog) {
    for (const m of (catalog.modules || [])) {
      for (const [attr, req] of Object.entries(m.attributes || {})) {
        const { tier } = normalizeTier(req);
        if (TIER_ENFORCEMENT[tier] !== 'block') continue;
        if (claimingChecks(m, catalog, attr).length > 0) continue;
        findings.push({
          severity: 'error', code: 'UNWIRED_ATTRIBUTE', module: m.id, attribute: attr, tier,
          message: 'module "' + m.id + '" declares ' + attr + ' at tier ' + tier
            + ' but no check in its verification plan claims that attribute',
        });
      }
    }
  }

  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const streak = new Map();
  const suppressedFails = new Map();
  for (const e of ledgerEntries.slice(-30)) {
    if (!e || e.corrupt || e.command !== 'gate') continue;
    for (const r of (e.results || [])) {
      const supp = (r && r.suppressed) ? r.suppressed : null;
      const state = (supp && supp.from) ? supp.from : r.state;
      if (state === 'FAIL') streak.set(r.id, (streak.get(r.id) || 0) + 1);
      else if (state === 'PASS') streak.set(r.id, 0);
      if (supp && supp.by === 'waiver') {
        const b = suppressedFails.get(r.id) || { occurrences: 0, executed: 0 };
        b.occurrences++;
        if (supp.from === 'FAIL' || supp.from === 'BLOCKED') b.executed++;
        suppressedFails.set(r.id, b);
      }
    }
  }
  for (const id of [...streak.keys()].sort(cmp)) {
    const n = streak.get(id);
    if (n < 3) continue;
    findings.push({
      severity: 'warning', code: 'FAIL_STREAK', check: id,
      message: 'check "' + id + '" failed ' + n + ' times in a row; stop re-running it and go find the root cause',
    });
  }
  for (const id of [...suppressedFails.keys()].sort(cmp)) {
    const b = suppressedFails.get(id);
    findings.push({
      severity: 'warning', code: 'SUPPRESSED_FAILURE', check: id, occurrences: b.occurrences,
      message: b.executed > 0
        ? 'check "' + id + '" failed or blocked ' + b.executed + ' time(s) in the recent ledger and a waiver '
          + 'rewrote each one to SKIPPED; that failure is deferred, not absent, and the waiver expires'
        : 'check "' + id + '" was excused by a waiver ' + b.occurrences + ' time(s) in the recent ledger and '
          + 'never ran; nobody knows whether it would pass, and the waiver expires',
    });
  }

  const gates = ledgerEntries.filter((e) => e && !e.corrupt && e.command === 'gate');
  const latestGate = gates.length ? gates[gates.length - 1] : null;
  if (latestGate && latestGate.fastActive && (latestGate.skippedByFastMode || []).length) {
    findings.push({
      severity: 'error', code: 'FAST_MODE_DEBT',
      message: 'the newest gate ran under Fast Mode and skipped ['
        + latestGate.skippedByFastMode.join(', ') + ']; that evidence was deferred, not waived -- '
        + 'turn Fast Mode off and run a full gate before treating the work as verified',
    });
  }
  if (fastActive) {
    findings.push({
      severity: 'warning', code: 'FAST_MODE_OPEN',
      message: 'Fast Mode is open; evidence is being deferred, and the window closes on its own expiry, not on the work being done',
    });
  }

  const governance = governanceSurface(changed);
  if (governance.length) {
    findings.push({
      severity: 'warning', code: 'GOVERNANCE_SURFACE_CHANGED', count: governance.length,
      files: governance.slice(0, GOVERNANCE_LIST_CAP),
      message: 'this change edits ' + governance.length + ' file(s) of the governance surface '
        + '(hooks, harness, skills, agents, rules, AGENTS.md, CI) -- the judge rather than the '
        + 'judged; review it at the strictest tier this repository has, because a gate cannot '
        + 'catch a change to itself',
    });
  }

  if (task && task.state === 'active') {
    const startedMs = Date.parse(task.startedAt);
    if (!Number.isNaN(startedMs)) {
      const ageH = Math.round((now - startedMs) / 3600000);
      if (ageH > 72) {
        findings.push({
          severity: 'warning', code: 'STALE_TASK', task: task.id || null,
          message: 'task "' + (task.id || 'unknown') + '" has been active for ' + ageH
            + 'h; close it or restate the goal -- a task nobody finished is a plan nobody follows',
        });
      }
    }
  }

  const errorCount = findings.filter((f) => f.severity === 'error').length;
  return {
    ok: errorCount === 0,
    findings,
    counts: { error: errorCount, warning: findings.length - errorCount },
  };
}

function readQuarantine() {
  const fp = quarantineFilePath();
  const read = readTextFile(fp);
  if (read.absent) return null;
  if (read.error) {
    return {
      count: 0, files: 0, lastPath: null, lastKind: null,
      unreadable: { path: relFromRoot(fp), detail: errDetail(read.error) },
    };
  }
  const lines = read.text.replace(/\r\n/g, '\n').split('\n').filter(Boolean);
  if (!lines.length) return null;
  const paths = new Set();
  let lastPath = null;
  let lastKind = null;
  for (const l of lines) {
    let o = null;
    try { o = JSON.parse(l); } catch (_e) { continue; }
    if (o && typeof o.path === 'string') { paths.add(o.path); lastPath = o.path; lastKind = o.kind || null; }
  }
  return { count: lines.length, files: paths.size, lastPath, lastKind };
}

function cmdRisk(flags) {
  const loaded = loadCatalogFlag(flags);
  const catalog = loaded.ok ? loaded.catalog : null;
  const state = readLedgerState();
  const cp = changedPaths();
  const waivers = readWaiverFiles();
  const task = readTaskRecord();
  const fastActive = fastModeActive();
  const quarantine = readQuarantine();
  const res = riskFindings({
    ledgerEntries: state.entries,
    ledgerUnreadable: state.unreadable,
    evidenceBreaks: state.unreadable ? [] : evidenceFindings(state.entries).breaks,
    catalog,
    waivers,
    task,
    changed: Array.isArray(cp) ? cp : cp.paths,
    quarantine,
    fastActive,
  });
  if (!res.ok) {
    for (const f of res.findings.filter((x) => x.severity === 'error')) {
      process.stderr.write(f.code + ': ' + f.message + '\n');
    }
  }
  return emit({ ...res, catalogPresent: loaded.ok }, res.ok ? 0 : 1);
}

export {
  GENESIS,
  stateDir, ledgerFilePath, ledgerLockPath, taskFilePath, evidenceDir, contextPackDir, relFromRoot,
  writeAtomic, sha256Lf, readJsonFile, readTaskState, readTaskRecord,
  chainHash, ledgerLine, parseLedgerLines, readLedgerState, endsWithNewline, appendLedger,
  verifyLedgerChain, evidenceFindings, ledgerReport, cmdLedger,
  buildPlan, evidenceFilePath, runCheckWithEvidence, gateReason, suppressionOf, waiversApplied, cmdGate,
  auditGates, cmdGateAudit,
  planRetention, ledgerReferencedEvidence, listDirFiles, retentionRefusal, cmdRetention,
  readWaiverFiles, readQuarantine, governanceSurface, riskFindings, cmdRisk,
};
