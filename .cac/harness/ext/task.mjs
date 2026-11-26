// ext/task.mjs — S18 the seven-field task envelope (`task start|status|complete`) and blast-radius `budget`.
// Depends on ../lib/core.mjs and ./{catalog,graph,quality,evidence}.mjs.

import process from 'node:process';
import {
  changedPaths, emit, errDetail, git, gitFingerprint, headCommit, isGitRepo, isStateExcluded,
  projectRoot, readStdin, splitNul,
} from '../lib/core.mjs';
import { loadCatalogFlag } from './catalog.mjs';
import { analyzeImpact } from './graph.mjs';
import { loadReceipts, receiptIntact, safeTaskId } from './quality.mjs';
import {
  buildPlan, evidenceFindings, readLedgerState, readTaskState, relFromRoot, taskFilePath,
  verifyLedgerChain, writeAtomic,
} from './evidence.mjs';

// ---------------------------------------------------------------------------
// S18.1 task envelope
// ---------------------------------------------------------------------------
const TASK_REQUIRED_FIELDS = [
  'id', 'goal', 'scope', 'outOfScope', 'existingPattern', 'businessContext', 'verification', 'escalation',
];

function validateEnvelope(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, missing: TASK_REQUIRED_FIELDS.slice(), detail: 'envelope must be a JSON object' };
  }
  const missing = TASK_REQUIRED_FIELDS.filter((f) => typeof input[f] !== 'string' || !input[f].trim());
  if (missing.length === 0 && !safeTaskId(input.id)) {
    return { ok: false, missing: ['id'], detail: 'id must contain at least one of [A-Za-z0-9._-]' };
  }
  return { ok: missing.length === 0, missing, detail: null };
}

function buildTaskRecord(envelope, { now, baseCommit }) {
  return {
    ...envelope,
    id: safeTaskId(envelope.id).slice(0, 120),
    state: 'active',
    baseCommit,
    startedAt: now,
  };
}

function acceptingReceipt(receipts, diffHash) {
  const accepting = new Set(['accept', 'pass']);
  for (const r of (receipts || [])) {
    if (!receiptIntact(r)) continue;
    if (r.diffHash !== diffHash) continue;
    if (accepting.has(String(r.verdict || '').trim().toLowerCase())) return r;
  }
  return null;
}

function completeBlockers({
  latestGate = null,
  currentDiffHash = '',
  currentPlanHash = null,
  receipts = [],
  receiptsUnreadable = [],
  ledgerOk = true,
  evidenceOk = true,
  planEmpty = true,
} = {}) {
  const blockers = [];
  const gateFresh = !!latestGate && latestGate.gate === 'PASS' && latestGate.diffHash === currentDiffHash;
  if (!gateFresh) {
    blockers.push('no PASS gate record bound to the current diffHash'
      + (latestGate ? ' (newest gate: ' + latestGate.gate + ' on ' + String(latestGate.diffHash).slice(0, 12) + ')' : ' (no gate has ever run)')
      + '; run: harness.mjs gate');
  } else {
    if (latestGate.scopeSource !== 'computed') {
      blockers.push('that PASS gate ran over '
        + (latestGate.scopeSource === 'caller'
          ? 'a scope the caller supplied with --changed'
          : 'a scope of unrecorded provenance (the record predates scope tracking)')
        + ', so it says nothing about the real change surface; run: harness.mjs gate with no --changed');
    }
    if (currentPlanHash !== null && latestGate.planHash !== currentPlanHash) {
      blockers.push('that PASS gate verified plan ' + String(latestGate.planHash).slice(0, 12)
        + ', but the current change surface resolves to plan ' + String(currentPlanHash).slice(0, 12)
        + '; run: harness.mjs gate with no --changed');
    }
    const results = Array.isArray(latestGate.results) ? latestGate.results : [];
    if (results.length > 0 && results.every((r) => r && r.state === 'SKIPPED')) {
      blockers.push('every check in that PASS gate was skipped (fast mode or a waiver), so it '
        + 'established nothing: the evidence was deferred, not obtained');
    }
  }
  if (receiptsUnreadable.length) {
    blockers.push('receipt-unreadable: ' + receiptsUnreadable.length + ' receipt file(s) exist and '
      + 'cannot be read (' + receiptsUnreadable.join(', ') + '), so the receipt pile cannot be judged '
      + 'at all; read them, then repair or remove them by hand');
  }
  if (!acceptingReceipt(receipts, currentDiffHash)) {
    blockers.push('no fresh accepting review receipt bound to the current diffHash; '
      + 'have the reviewer write one: harness.mjs receipt write');
  }
  if (!ledgerOk) {
    blockers.push('the ledger chain is broken, so every recorded verification is unproven, and '
      + 'running more gates cannot mend it: a person has to decide whether to retire '
      + '.cac/harness/state/ledger.jsonl (which discards every proof it held) and rebuild '
      + 'from there, or to find out who edited it');
  }
  if (!evidenceOk) {
    blockers.push('an evidence log the ledger points at is missing or no longer matches its '
      + 'recorded digest, so the verdict resting on it is unproven; see: harness.mjs ledger');
  }
  if (planEmpty) {
    blockers.push('the verification plan is empty: nothing would have run, so nothing was established');
  }
  return blockers;
}

function latestGateRecord(entries) {
  const gates = (entries || []).filter((e) => e && !e.corrupt && e.command === 'gate');
  return gates.length ? gates[gates.length - 1] : null;
}

function corruptTask(sub, corrupt) {
  process.stderr.write('task ' + sub + ': ' + corrupt.path + ' exists and cannot be read ('
    + corrupt.detail + '); the record is damaged, not absent -- do not start a fresh one over it\n');
  return emit({ ok: false, error: 'corrupt-state', path: corrupt.path, detail: corrupt.detail }, 3);
}

function writeTaskRecord(record) {
  const fp = taskFilePath();
  try {
    writeAtomic(fp, JSON.stringify(record, null, 2) + '\n');
    return null;
  } catch (e) {
    return { path: relFromRoot(fp), detail: errDetail(e) };
  }
}

function unwritableTask(sub, failed) {
  process.stderr.write('task ' + sub + ': ' + failed.path + ' could not be written ('
    + failed.detail + '); nothing was recorded\n');
  return emit({ ok: false, error: 'corrupt-state', path: failed.path, detail: failed.detail }, 3);
}

function cmdTask(flags = {}, positional = []) {
  const sub = positional[0] || 'status';

  if (sub === 'start') {
    const raw = readStdin();
    let input;
    try { input = raw.trim() ? JSON.parse(raw) : {}; } catch (e) {
      return emit({ error: 'task-parse-error', detail: String((e && e.message) || e) }, 3);
    }
    const v = validateEnvelope(input);
    if (!v.ok) {
      process.stderr.write('task envelope is incomplete; missing: ' + v.missing.join(', ')
        + (v.detail ? ' (' + v.detail + ')' : '') + '\n');
      return emit({ error: 'task-envelope-incomplete', missing: v.missing, detail: v.detail }, 3);
    }
    const prior = readTaskState();
    if (prior.corrupt) return corruptTask('start', prior.corrupt);
    const record = buildTaskRecord(input, { now: new Date().toISOString(), baseCommit: headCommit() });
    const failed = writeTaskRecord(record);
    if (failed) return unwritableTask('start', failed);
    return emit({ ok: true, path: relFromRoot(taskFilePath()), task: record }, 0);
  }

  if (sub === 'status') {
    const state = readTaskState();
    if (state.corrupt) return corruptTask('status', state.corrupt);
    const task = state.task;
    return emit({
      ok: !!task,
      active: !!(task && task.state === 'active'),
      task,
      diffHash: isGitRepo() ? gitFingerprint() : null,
      note: task ? null : 'no-task-record',
    }, 0);
  }

  if (sub === 'complete') {
    const loaded = loadCatalogFlag(flags);
    if (!loaded.ok) {
      return emit({ ok: false, degraded: true, error: loaded.error, detail: loaded.detail }, 3);
    }
    const state = readTaskState();
    if (state.corrupt) return corruptTask('complete', state.corrupt);
    const task = state.task;
    if (!task || task.state !== 'active') {
      return emit({
        ok: false, task: task ? task.id : null,
        blockers: ['no active task: run "harness.mjs task start" with a seven-field envelope first'],
      }, 2);
    }
    if (typeof flags.changed === 'string') {
      process.stderr.write('task complete does not take --changed: the whole point of this gate is that '
        + 'the change surface is measured, not supplied\n');
      return emit({
        ok: false, task: task.id, error: 'task-scope-not-caller-specified',
        detail: 'run it with no --changed; use gate --changed to verify a subset without closing anything',
      }, 3);
    }
    if (!isGitRepo()) {
      process.stderr.write('task complete: this tree is not a git repository, so there is no diff to bind '
        + 'evidence to and the gate and receipt bindings this command checks cannot be trusted here\n');
      return emit({
        ok: false, degraded: true, reason: 'non-git', task: task.id, diffHash: null, blockers: [],
      }, 3);
    }
    const ledger = readLedgerState();
    if (ledger.unreadable) {
      process.stderr.write('task complete: the ledger exists but cannot be read (' + ledger.unreadable
        + '), so no recorded verification can be checked here\n');
      return emit({
        ok: false, degraded: true, reason: 'ledger-unreadable', task: task.id,
        diffHash: gitFingerprint(), blockers: [],
      }, 3);
    }
    const cp = changedPaths();
    const changed = Array.isArray(cp) ? cp : cp.paths;
    const imp = analyzeImpact(changed, loaded.catalog, {});
    const plan = buildPlan(imp.affected, loaded.catalog);
    const currentDiffHash = gitFingerprint();
    const receiptLedger = loadReceipts();
    const blockers = completeBlockers({
      latestGate: latestGateRecord(ledger.entries),
      currentDiffHash,
      currentPlanHash: plan.hash,
      receipts: receiptLedger.receipts,
      receiptsUnreadable: receiptLedger.unreadable,
      ledgerOk: verifyLedgerChain(ledger.entries).ok,
      evidenceOk: evidenceFindings(ledger.entries).ok,
      planEmpty: plan.empty,
    });
    if (blockers.length) {
      for (const b of blockers) process.stderr.write('task complete blocked: ' + b + '\n');
      return emit({ ok: false, task: task.id, diffHash: currentDiffHash, blockers }, 2);
    }
    const done = { ...task, state: 'complete', completedAt: new Date().toISOString() };
    const failed = writeTaskRecord(done);
    if (failed) return unwritableTask('complete', failed);
    return emit({ ok: true, task: done.id, diffHash: currentDiffHash, blockers: [] }, 0);
  }

  return emit({ error: 'task-subcommand', detail: 'usage: task start|status|complete', got: sub || null }, 3);
}

// ---------------------------------------------------------------------------
// S18.2 budget
// ---------------------------------------------------------------------------
const BUDGET_DEFAULTS = {
  maxChangedFiles: 30,
  maxChangedLines: 1000,
  maxModulesTouched: 5,
  maxNewFiles: 15,
};

const BUDGET_METRICS = [
  ['changedFiles', 'maxChangedFiles'],
  ['changedLines', 'maxChangedLines'],
  ['modulesTouched', 'maxModulesTouched'],
  ['newFiles', 'maxNewFiles'],
];

function assessBudget(metrics, limits) {
  const findings = [];
  for (const [metric, key] of BUDGET_METRICS) {
    const limit = limits ? limits[key] : undefined;
    const actual = metrics ? metrics[metric] : undefined;
    if (typeof limit !== 'number' || typeof actual !== 'number') continue;
    if (actual > limit) findings.push({ metric, actual, limit });
  }
  return { ok: findings.length === 0, findings };
}

function countDiffLines() {
  const cwd = projectRoot();
  let added = 0;
  let removed = 0;
  const args = ['diff', '--numstat'];
  if (headCommit(cwd)) args.push('HEAD');
  const out = (git(args, { cwd }).stdout || Buffer.alloc(0)).toString('utf8');
  for (const line of out.replace(/\r\n/g, '\n').split('\n')) {
    const m = /^(\d+)\t(\d+)\t/.exec(line);
    if (m) { added += Number(m[1]); removed += Number(m[2]); }
  }
  return { added, removed };
}

function cmdBudget(flags) {
  const loaded = loadCatalogFlag(flags);
  if (!loaded.ok) {
    return emit({ ok: false, degraded: true, error: loaded.error, detail: loaded.detail }, 3);
  }
  const cwd = projectRoot();
  if (!isGitRepo(cwd)) {
    return emit({ ok: false, degraded: true, reason: 'non-git' }, 3);
  }
  const cp = changedPaths();
  const changed = (Array.isArray(cp) ? cp : cp.paths).filter((p) => !isStateExcluded(p));
  const untracked = splitNul(
    git(['-c', 'core.quotePath=false', 'ls-files', '-z', '--others', '--exclude-standard'], { cwd }).stdout,
  ).filter((p) => !isStateExcluded(p));
  const imp = analyzeImpact(changed, loaded.catalog, {});
  const { added, removed } = countDiffLines();
  const metrics = {
    changedFiles: changed.length,
    changedLines: added + removed,
    added,
    removed,
    modulesTouched: imp.direct.length,
    newFiles: untracked.length,
    affectedModules: imp.affected.length,
  };
  const limits = { ...BUDGET_DEFAULTS, ...(loaded.catalog.budget || {}) };
  const res = assessBudget(metrics, limits);
  if (!res.ok) {
    for (const f of res.findings) {
      process.stderr.write('budget: ' + f.metric + ' = ' + f.actual + ' (limit ' + f.limit + ')\n');
    }
  }
  return emit({
    ...res,
    metrics,
    limits,
    degraded: !!imp.degraded,
    advice: res.ok
      ? 'blast radius is within the declared budget'
      : 'blast radius is past the declared budget: split this into smaller tasks, or widen the '
        + 'scope deliberately (plan + ADR + owner). This is a signal to stop and think for a '
        + 'second, not a prohibition -- a wide change is sometimes the right one.',
  }, res.ok ? 0 : 1);
}

export {
  TASK_REQUIRED_FIELDS, validateEnvelope, buildTaskRecord, acceptingReceipt, completeBlockers,
  latestGateRecord, cmdTask,
  BUDGET_DEFAULTS, BUDGET_METRICS, assessBudget, countDiffLines, cmdBudget,
};
