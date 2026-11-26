// ext/review.mjs — S20 structured disagreement review engine, `review-pack`, and `authorship`.
// Depends on ../lib/core.mjs and ./{catalog,graph,quality,evidence}.mjs.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  TIER_RANK,
  changedPaths, emit, errDetail, git, gitFingerprint, headCommit, isGitRepo, isStateExcluded,
  normalizeTier, projectRoot, readStdin, readTextFile, recordCorruptState, splitNul, toPosixPath,
  withDirLock,
} from '../lib/core.mjs';
import { loadCatalogFlag } from './catalog.mjs';
import { analyzeImpact } from './graph.mjs';
import { hasCodeChange, writeReceipt } from './quality.mjs';
import {
  contextPackDir, endsWithNewline, readTaskRecord, relFromRoot, stateDir, writeAtomic,
} from './evidence.mjs';

// ---------------------------------------------------------------------------
// S20.1 the review team
// ---------------------------------------------------------------------------
const REVIEW_STAGES = { 1: 'code', 2: 'functional', 3: 'trust' };

const LENS_LIBRARY = {
  correctness: { stage: 1, attribute: null, asks: 'does it do what the requirement says, at the boundaries and in the error paths, not only on the happy path' },
  architecture: { stage: 1, attribute: 'maintainability', asks: 'is the change inside its declared boundary, is every new edge in the catalog, does it respect the layer direction' },
  maintainability: { stage: 1, attribute: 'maintainability', asks: 'will the next person understand this without archaeology: duplication, dead code, naming that lies, comments that explain what instead of why' },
  testing: { stage: 2, attribute: 'reliability', asks: 'does a test fail without the fix, is every case reachable from an anchor, is a failure classified rather than retried' },
  performance: { stage: 2, attribute: 'performance', asks: 'what is the complexity class on the growth path, what allocates per call, does it meet a stated budget rather than feeling fast' },
  reliability: { stage: 3, attribute: 'reliability', asks: 'what happens under partial failure: is the effect idempotent, is an error handled or propagated, is anything swallowed' },
  resilience: { stage: 3, attribute: 'resilience', asks: 'is every outbound call bounded by a timeout, every retry by a budget with backoff, every queue and cache by a limit, is the degraded mode declared' },
  security: { stage: 3, attribute: 'security', asks: 'STRIDE across the trust boundary this change touches: authn, authz, injection sinks, secrets, transport, supply chain' },
  privacy: { stage: 3, attribute: 'privacy', asks: 'what personal data is touched, logged, exported or retained, on what basis, and can its deletion be proven' },
};

const REVIEW_PROFILES = {
  personal: ['correctness'],
  team: ['correctness', 'testing', 'architecture'],
  production: ['correctness', 'testing', 'architecture', 'security', 'reliability', 'performance'],
  regulated: Object.keys(LENS_LIBRARY),
};

const DEFAULT_PROFILE = 'team';
const DEFAULT_MAX_ROUNDS = 3;
const LOCATION_RE = /^[^\s:]+:\d+/;
const SEVERITIES = ['error', 'warning', 'info'];
const BACKLOG_PROTECTED_LENSES = new Set(['security', 'safety', 'privacy']);
const BACKLOG_FORBIDDEN_RE = /\b(security|safety|privacy|pii|secret|credential)\b/i;

function stageOf(name) {
  return LENS_LIBRARY[name] ? LENS_LIBRARY[name].stage : 1;
}

function reviewProfile(catalog) {
  const r = (catalog && catalog.review) || {};
  const name = r.profile || (catalog && catalog.profile) || DEFAULT_PROFILE;
  return REVIEW_PROFILES[name] ? name : DEFAULT_PROFILE;
}

function maxRoundsOf(catalog) {
  const n = catalog && catalog.review && catalog.review.maxRounds;
  return (typeof n === 'number' && n > 0) ? n : DEFAULT_MAX_ROUNDS;
}

function reviewLenses(catalog, { affected = null } = {}) {
  const explicit = catalog && catalog.review && Array.isArray(catalog.review.lenses)
    ? catalog.review.lenses.filter((x) => typeof x === 'string' && x.trim())
    : null;
  if (explicit && explicit.length) return explicit;
  const base = REVIEW_PROFILES[reviewProfile(catalog)];
  if (!affected || !catalog || !Array.isArray(catalog.modules)) return base.slice();
  const mods = catalog.modules.filter((m) => affected.includes(m.id));
  if (mods.length === 0) return base.slice();
  return base.filter((name) => {
    const attr = LENS_LIBRARY[name] && LENS_LIBRARY[name].attribute;
    if (!attr) return true;
    return mods.some((m) => TIER_RANK[normalizeTier((m.attributes || {})[attr]).tier] >= TIER_RANK.low);
  });
}

function lensExclusions(catalog, affected) {
  const explicit = catalog && catalog.review && Array.isArray(catalog.review.lenses)
    ? catalog.review.lenses : null;
  if (explicit && explicit.length) return [];
  const base = REVIEW_PROFILES[reviewProfile(catalog)];
  const kept = new Set(reviewLenses(catalog, { affected }));
  return base.filter((n) => !kept.has(n)).map((n) => ({
    lens: n,
    reason: 'no affected module declares ' + LENS_LIBRARY[n].attribute + ' at low or above',
  }));
}

function stagePassed(session, stage) {
  const lenses = (session && session.lenses) || {};
  return ((session && session.requiredLenses) || [])
    .filter((n) => stageOf(n) === stage)
    .every((n) => {
      const rec = lenses[n];
      if (!rec || rec.unable) return false;
      return !((rec.findings || []).some((f) => f.severity === 'error'));
    });
}

function currentStage(session) {
  const required = (session && session.requiredLenses) || [];
  let current = 1;
  for (;;) {
    const here = required.filter((n) => stageOf(n) === current);
    if (here.length && !stagePassed(session, current)) return current;
    if (current >= 3) return current;
    current++;
  }
}

// ---------------------------------------------------------------------------
// S20.2 session state
// ---------------------------------------------------------------------------
function reviewFilePath() {
  return path.join(stateDir(), 'review.json');
}
function authorshipFilePath() {
  return path.join(stateDir(), 'authorship.jsonl');
}
function authorshipLockPath() {
  return path.join(stateDir(), 'authorship.lock');
}
function reviewPackDir() {
  return contextPackDir();
}

function readReviewState() {
  const fp = reviewFilePath();
  const read = readTextFile(fp);
  if (read.absent) return { session: null, corrupt: null };
  let detail = read.error ? errDetail(read.error) : null;
  if (!detail) {
    try { return { session: JSON.parse(read.text), corrupt: null }; } catch (e) {
      detail = errDetail(e);
    }
  }
  recordCorruptState({ kind: 'review', path: fp, reason: detail });
  return { session: null, corrupt: { path: relFromRoot(fp), detail } };
}

function corruptSession(sub, corrupt, extra = {}) {
  process.stderr.write('review ' + sub + ': ' + corrupt.path + ' exists and cannot be read ('
    + corrupt.detail + '); the session is damaged, not absent -- do not open a new one over it\n');
  return emit({ ok: false, sub, ...extra, error: 'corrupt-state', path: corrupt.path, detail: corrupt.detail }, 3);
}

function saveReview(session) {
  writeAtomic(reviewFilePath(), JSON.stringify(session, null, 2) + '\n');
  return session;
}

function freshness(session, diffHash) {
  if (!session) {
    return { ok: false, missing: true, reason: 'no review session; open one with "harness.mjs review start"' };
  }
  if (session.diffHash !== diffHash) {
    return {
      ok: false,
      stale: true,
      reason: 'the working tree moved since this review opened (session ' + String(session.diffHash).slice(0, 12)
        + ', tree ' + String(diffHash).slice(0, 12) + '); re-open it with "harness.mjs review start"',
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// S20.3 report validators
// ---------------------------------------------------------------------------
function validateClaims(payload) {
  const claims = Array.isArray(payload && payload.claims) ? payload.claims : [];
  if (claims.length === 0) {
    return { ok: false, claims, reason: 'blue must state at least one claim: {"claims":[{"statement":"...","evidence":"..."}]}' };
  }
  const bad = [];
  claims.forEach((c, i) => {
    const statement = c && (c.statement || c.claim);
    const evidence = c && c.evidence;
    if (typeof statement !== 'string' || !statement.trim()) bad.push({ index: i, why: 'no statement' });
    else if (typeof evidence !== 'string' || !evidence.trim()) bad.push({ index: i, why: 'no evidence' });
  });
  if (bad.length) {
    return {
      ok: false, claims, bad,
      reason: bad.length + ' claim(s) carry no statement or no evidence; a claim with no command, '
        + 'no exit code and no file:line is an opinion, and the whole report is rejected',
    };
  }
  return { ok: true, claims: claims.map((c) => ({ statement: String(c.statement || c.claim), evidence: String(c.evidence) })) };
}

function validateFindings(payload) {
  const findings = Array.isArray(payload && payload.findings) ? payload.findings : [];
  const unlocated = [];
  const badSeverity = [];
  findings.forEach((f, i) => {
    const located = f && ((typeof f.location === 'string' && LOCATION_RE.test(f.location.trim()))
      || (typeof f.reproduction === 'string' && f.reproduction.trim()));
    if (!located) unlocated.push(i);
    if (!f || !SEVERITIES.includes(f.severity)) badSeverity.push(i);
  });
  if (unlocated.length) {
    return {
      ok: false, findings, unlocated,
      reason: unlocated.length + ' finding(s) carry neither a file:line location nor a reproduction '
        + '(index ' + unlocated.join(', ') + ')',
    };
  }
  if (badSeverity.length) {
    return {
      ok: false, findings, badSeverity,
      reason: 'finding(s) at index ' + badSeverity.join(', ') + ' need severity ' + SEVERITIES.join(' | '),
    };
  }
  return {
    ok: true,
    findings: findings.map((f) => ({
      severity: f.severity,
      location: typeof f.location === 'string' ? f.location : null,
      reproduction: typeof f.reproduction === 'string' ? f.reproduction : null,
      summary: typeof f.summary === 'string' ? f.summary : '',
    })),
  };
}

function backlogViolations(payload, now = Date.now()) {
  const errors = [];
  const missing = ['owner', 'expiry', 'summary', 'lens']
    .filter((k) => !(payload && typeof payload[k] === 'string' && payload[k].trim()));
  if (missing.length) {
    errors.push('a backlog entry needs ' + missing.join(', ') + ' (owner, expiry as an ISO date, summary, lens)');
    return errors;
  }
  const expiryMs = Date.parse(payload.expiry);
  if (Number.isNaN(expiryMs) || expiryMs <= now) {
    errors.push('expiry must be a future ISO timestamp; an undated debt is never repaid');
  }
  const lens = String(payload.lens).trim().toLowerCase();
  if (BACKLOG_PROTECTED_LENSES.has(lens) || BACKLOG_FORBIDDEN_RE.test(String(payload.summary))) {
    errors.push('a security, safety or privacy finding cannot be backlogged: carrying one is '
      + 'the waiver this engine refuses to grant anywhere else');
  }
  return errors;
}

// ---------------------------------------------------------------------------
// S20.4 authorship ledger
// ---------------------------------------------------------------------------
function parseAuthorshipLines(raw) {
  return String(raw == null ? '' : raw).replace(/\r\n/g, '\n').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (_e) { return { corrupt: true, raw: l }; }
  });
}

function readAuthorship() {
  let raw;
  try {
    raw = fs.readFileSync(authorshipFilePath(), 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { records: [], unreadable: null };
    return { records: [], unreadable: String((e && e.code) || (e && e.message) || e) };
  }
  return { records: parseAuthorshipLines(raw), unreadable: null };
}

function appendAuthorship(record) {
  fs.mkdirSync(stateDir(), { recursive: true });
  return withDirLock(authorshipLockPath(), () => {
    const file = authorshipFilePath();
    if (fs.existsSync(file) && !endsWithNewline(file)) fs.appendFileSync(file, '\n', 'utf8');
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
    return record;
  });
}

function authorSetFor(records, changed) {
  const authors = new Map();
  for (const r of (records || [])) {
    if (!r || r.corrupt) continue;
    const id = typeof r.agentId === 'string' ? r.agentId.trim() : '';
    if (!id) continue;
    const hit = (Array.isArray(r.files) ? r.files : [])
      .map(toPosixPath)
      .filter((f) => changed.has(f));
    if (!hit.length) continue;
    if (!authors.has(id)) authors.set(id, { agentId: id, agentTypes: [], files: [] });
    const a = authors.get(id);
    const type = typeof r.agentType === 'string' && r.agentType ? r.agentType : null;
    if (type && !a.agentTypes.includes(type)) a.agentTypes.push(type);
    for (const f of hit) if (!a.files.includes(f)) a.files.push(f);
  }
  return authors;
}

function selfReviewedLenses(session, authors) {
  const out = [];
  for (const [lens, rec] of Object.entries((session && session.lenses) || {})) {
    const id = rec && typeof rec.agentId === 'string' ? rec.agentId : '';
    if (!id) continue;
    const a = authors.get(id);
    if (!a) continue;
    out.push({ lens, agentId: id, files: a.files.slice(0, 10) });
  }
  return out;
}

function authorshipStatus(session, authors, ledger = {}) {
  const withAgent = Object.entries((session && session.lenses) || {})
    .filter(([, v]) => v && typeof v.agentId === 'string' && v.agentId).map(([l]) => l);
  const withoutAgent = Object.entries((session && session.lenses) || {})
    .filter(([, v]) => !(v && typeof v.agentId === 'string' && v.agentId)).map(([l]) => l);
  if (ledger.unreadable) {
    return {
      enforced: false,
      reason: 'the authorship ledger exists but could not be read (' + ledger.unreadable + ')',
      lensesWithoutAgent: withoutAgent,
      authors: [],
    };
  }
  if (authors.size === 0) {
    return {
      enforced: false,
      reason: (ledger.records
        ? 'the authorship ledger holds ' + ledger.records + ' record(s) but none names a file this diff touches'
        : 'no authorship was ever recorded (nobody called "harness.mjs authorship record")')
        + ', so the reviewer-is-not-the-author rule could not be applied to this verdict',
      lensesWithoutAgent: withoutAgent,
      authors: [],
    };
  }
  if (withAgent.length === 0) {
    return {
      enforced: false,
      reason: 'authorship is on record for this diff, but no lens was reported with --agent',
      lensesWithoutAgent: withoutAgent,
      authors: [...authors.values()].map((a) => a.agentId),
    };
  }
  return {
    enforced: true,
    reason: null,
    lensesWithoutAgent: withoutAgent,
    authors: [...authors.values()].map((a) => a.agentId),
  };
}

// ---------------------------------------------------------------------------
// S20.5 verdict
// ---------------------------------------------------------------------------
function computeVerdict(session, { maxRounds = DEFAULT_MAX_ROUNDS, authors = new Map(), now = '' } = {}) {
  const entries = Object.entries((session && session.lenses) || {});
  const required = (session && session.requiredLenses) || [];
  const stage = currentStage(session);
  const stageLenses = required.filter((n) => stageOf(n) === stage);
  const missing = stageLenses.filter((l) => !(session.lenses || {})[l]);
  const errors = entries.flatMap(([lens, v]) => ((v && v.findings) || [])
    .filter((f) => f.severity === 'error').map((f) => ({ lens, ...f })));
  const unable = entries.filter(([, v]) => v && v.unable).map(([l]) => l);

  const blockers = [];
  if (!session || !session.blue) {
    blockers.push('blue never stated what it verified; run "harness.mjs review blue" first');
  }
  if (missing.length) {
    blockers.push('stage ' + stage + ' (' + REVIEW_STAGES[stage] + ') lens(es) never reported: '
      + missing.join(', ') + '; a review that did not look cannot conclude');
  }

  let verdict = null;
  if (blockers.length === 0) {
    if (errors.length) verdict = 'FIX_REQUIRED';
    else if (unable.length) verdict = 'NEEDS_MORE_EVIDENCE';
    else verdict = 'ACCEPT';
  }

  const selfReviewed = selfReviewedLenses(session, authors);
  if (verdict === 'ACCEPT' && selfReviewed.length) {
    verdict = null;
    for (const s of selfReviewed) {
      blockers.push('lens "' + s.lens + '" was reported by ' + s.agentId + ', who authored '
        + s.files.slice(0, 3).join(', ') + (s.files.length > 3 ? ' and ' + (s.files.length - 3) + ' more' : '')
        + ' in this change; self-review is not independent review, so it cannot carry an ACCEPT');
    }
  }

  const round = ((session && session.lineage) || []).length + 1;
  const escalate = verdict === 'FIX_REQUIRED' && round >= maxRounds;
  const isFinal = stage >= 3 || !required.some((n) => stageOf(n) > stage);

  return {
    ok: blockers.length === 0,
    verdict,
    blockers,
    stage,
    stageName: REVIEW_STAGES[stage],
    isFinal,
    round,
    maxRounds,
    escalate,
    errors: errors.slice(0, 20),
    errorCount: errors.length,
    unableLenses: unable,
    missingLenses: missing,
    selfReviewed,
    requiredLenses: required,
    recordedLenses: entries.map(([l]) => l),
    at: now,
  };
}

function verdictAdvice(v) {
  if (!v.ok) {
    return v.selfReviewed.length
      ? 'no verdict: part of the review was carried by the author of the change; '
        + 'have an independent agent report ' + v.selfReviewed.map((s) => s.lens).join(', ') + ' again'
      : 'no verdict: a review that did not look cannot conclude';
  }
  if (v.escalate) {
    return 'round ' + v.round + ' of ' + v.maxRounds + ': this change has been rejected ' + v.round
      + ' times. Stop and escalate to a person.';
  }
  if (v.verdict === 'ACCEPT') {
    return v.isFinal
      ? 'every stage passed, every convened lens reported, and none of them found an error'
      : 'stage ' + v.stage + ' (' + v.stageName + ') passed; report the stage ' + (v.stage + 1) + ' lenses to advance';
  }
  if (v.verdict === 'FIX_REQUIRED') {
    return 'fix the errors and re-open the review; a lens that found an error is not outvoted by lenses that found nothing';
  }
  return 'a lens could not reach a conclusion; give it what it needs rather than accepting around it';
}

// ---------------------------------------------------------------------------
// S20.6 review CLI
// ---------------------------------------------------------------------------
function nowIso() {
  return new Date().toISOString();
}

function changedSet() {
  const cp = changedPaths();
  const list = Array.isArray(cp) ? cp : cp.paths;
  return new Set(list.filter((p) => !isStateExcluded(p)).map(toPosixPath));
}

function reviewStart(flags) {
  if (!isGitRepo()) {
    return emit({
      ok: false, degraded: true, reason: 'non-git',
      detail: 'a review binds the diff it judged, and a non-git tree has no diff to bind to',
    }, 3);
  }
  if (!hasCodeChange()) {
    return emit({ ok: false, degraded: true, reason: 'no-change', detail: 'there is nothing under review' }, 3);
  }
  const loaded = loadCatalogFlag(flags);
  const catalog = loaded.ok ? loaded.catalog : null;
  let affected = null;
  if (catalog) {
    const cp = changedPaths();
    affected = analyzeImpact(Array.isArray(cp) ? cp : cp.paths, catalog, {}).affected;
  }

  const prior = readReviewState();
  if (prior.corrupt) return corruptSession('start', prior.corrupt);
  const previous = prior.session;
  const lineage = (previous && Array.isArray(previous.lineage)) ? previous.lineage : [];
  const carried = (previous && previous.verdict && previous.verdict.verdict === 'FIX_REQUIRED')
    ? lineage.concat([{ at: previous.verdict.at, diffHash: previous.diffHash, errors: previous.verdict.errorCount }])
    : lineage;

  const session = saveReview({
    version: 1,
    diffHash: gitFingerprint(),
    baseCommit: headCommit(),
    startedAt: nowIso(),
    scope: typeof flags.scope === 'string' ? flags.scope : '',
    packPath: typeof flags.pack === 'string' ? flags.pack : null,
    profile: reviewProfile(catalog),
    catalogPresent: !!catalog,
    affected,
    requiredLenses: reviewLenses(catalog, { affected }),
    excludedLenses: lensExclusions(catalog, affected),
    lineage: carried,
    blue: null,
    lenses: {},
    backlog: (previous && Array.isArray(previous.backlog)) ? previous.backlog : [],
    verdict: null,
  });

  process.stderr.write('review opened against diff ' + session.diffHash.slice(0, 12)
    + ' (profile ' + session.profile + (session.catalogPresent ? '' : ', no catalog') + ')\n');
  process.stderr.write('  convened: ' + session.requiredLenses.join(', ') + '\n');
  return emit({
    ok: true, sub: 'start', path: relFromRoot(reviewFilePath()),
    diffHash: session.diffHash, profile: session.profile, catalogPresent: session.catalogPresent,
    affected: session.affected, requiredLenses: session.requiredLenses,
    excludedLenses: session.excludedLenses, round: session.lineage.length + 1,
    maxRounds: maxRoundsOf(catalog),
  }, 0);
}

function readJsonStdin(shape) {
  const raw = readStdin();
  try {
    return { ok: true, value: raw.trim() ? JSON.parse(raw) : {} };
  } catch (e) {
    return { ok: false, error: 'stdin-parse-error', detail: String((e && e.message) || e), shape };
  }
}

function reviewBlue() {
  const parsed = readJsonStdin('{"claims":[{"statement":"...","evidence":"..."}]}');
  if (!parsed.ok) return emit({ ok: false, sub: 'blue', ...parsed }, 3);
  const state = readReviewState();
  if (state.corrupt) return corruptSession('blue', state.corrupt);
  const session = state.session;
  const f = freshness(session, isGitRepo() ? gitFingerprint() : '');
  if (!f.ok) {
    process.stderr.write('review blue: ' + f.reason + '\n');
    return emit({ ok: false, sub: 'blue', ...f }, f.stale ? 4 : 3);
  }
  const v = validateClaims(parsed.value);
  if (!v.ok) {
    process.stderr.write('review blue rejected: ' + v.reason + '\n');
    return emit({ ok: false, sub: 'blue', reason: v.reason, bad: v.bad || [] }, 1);
  }
  session.blue = { at: nowIso(), claims: v.claims };
  saveReview(session);
  return emit({ ok: true, sub: 'blue', claims: v.claims.length }, 0);
}

function reviewLens(flags, name) {
  if (!name) {
    return emit({
      ok: false, sub: 'lens', error: 'lens-name-required',
      detail: 'usage: review lens <name> [--agent <id>] < findings.json',
    }, 3);
  }
  const parsed = readJsonStdin('{"findings":[{"severity":"error","location":"file:line","summary":"..."}]}');
  if (!parsed.ok) return emit({ ok: false, sub: 'lens', lens: name, ...parsed }, 3);
  const state = readReviewState();
  if (state.corrupt) return corruptSession('lens', state.corrupt, { lens: name });
  const session = state.session;
  const f = freshness(session, isGitRepo() ? gitFingerprint() : '');
  if (!f.ok) {
    process.stderr.write('review lens: ' + f.reason + '\n');
    return emit({ ok: false, sub: 'lens', lens: name, ...f }, f.stale ? 4 : 3);
  }
  if (!session.requiredLenses.includes(name)) {
    const reason = 'lens "' + name + '" was not convened for this review; it requires '
      + session.requiredLenses.join(', ');
    process.stderr.write('review lens rejected: ' + reason + '\n');
    return emit({ ok: false, sub: 'lens', lens: name, reason }, 1);
  }
  const stage = stageOf(name);
  const current = currentStage(session);
  if (stage > current) {
    const missing = session.requiredLenses.filter((n) => stageOf(n) === current && !session.lenses[n]);
    const reason = 'lens "' + name + '" belongs to stage ' + stage + ' (' + REVIEW_STAGES[stage]
      + ') and this review is still at stage ' + current + ' (' + REVIEW_STAGES[current] + '): '
      + (missing.length
        ? missing.join(', ') + ' have not reported yet'
        : 'stage ' + current + ' reported findings it did not pass, so fix those and re-open the review');
    process.stderr.write('review lens rejected: ' + reason + '\n');
    return emit({
      ok: false, sub: 'lens', lens: name, stageGated: true, stage, currentStage: current, reason,
      missingLenses: missing,
    }, 1);
  }
  const v = validateFindings(parsed.value);
  if (!v.ok) {
    process.stderr.write('review lens rejected: ' + v.reason + '\n');
    return emit({
      ok: false, sub: 'lens', lens: name, reason: v.reason,
      unlocated: v.unlocated || [], badSeverity: v.badSeverity || [],
    }, 1);
  }
  const unable = !!(parsed.value && parsed.value.unable);
  session.lenses[name] = {
    at: nowIso(),
    agentId: typeof flags.agent === 'string' && flags.agent.trim() ? flags.agent.trim() : null,
    unable,
    unableReason: (parsed.value && typeof parsed.value.unableReason === 'string') ? parsed.value.unableReason : null,
    findings: v.findings,
  };
  saveReview(session);
  return emit({
    ok: true, sub: 'lens', lens: name, stage, findings: v.findings.length, unable,
    agentId: session.lenses[name].agentId,
    errors: v.findings.filter((x) => x.severity === 'error').length,
  }, 0);
}

function reviewVerdictCmd(flags) {
  const state = readReviewState();
  if (state.corrupt) return corruptSession('verdict', state.corrupt);
  const session = state.session;
  const f = freshness(session, isGitRepo() ? gitFingerprint() : '');
  if (!f.ok) {
    process.stderr.write('review verdict: ' + f.reason + '\n');
    return emit({ ok: false, sub: 'verdict', ...f }, f.stale ? 4 : 3);
  }
  const loaded = loadCatalogFlag(flags);
  const catalog = loaded.ok ? loaded.catalog : null;
  const ledger = readAuthorship();
  const authors = authorSetFor(ledger.records, changedSet());
  const authorship = authorshipStatus(session, authors, {
    unreadable: ledger.unreadable,
    records: ledger.records.filter((r) => r && !r.corrupt).length,
  });
  const v = computeVerdict(session, { maxRounds: maxRoundsOf(catalog), authors, now: nowIso() });
  const advice = verdictAdvice(v);

  if (!v.ok) {
    for (const b of v.blockers) process.stderr.write('  BLOCKER  ' + b + '\n');
    process.stderr.write(advice + '\n');
    return emit({
      ok: false, sub: 'verdict', ...v, authorshipEnforced: authorship.enforced,
      authorshipReason: authorship.reason, lensesWithoutAgent: authorship.lensesWithoutAgent,
      authors: authorship.authors, advice,
    }, 1);
  }

  session.verdict = {
    at: v.at, verdict: v.verdict, reviewer: typeof flags.reviewer === 'string' ? flags.reviewer : 'reviewer',
    notes: typeof flags.notes === 'string' ? flags.notes : '',
    round: v.round, escalate: v.escalate, stage: v.stage, isFinal: v.isFinal,
    errorCount: v.errorCount, unableLenses: v.unableLenses, lensCoverage: v.requiredLenses,
    authorshipEnforced: authorship.enforced,
  };
  saveReview(session);

  let receipt = null;
  if (v.verdict === 'ACCEPT' && v.isFinal) {
    const task = readTaskRecord();
    receipt = writeReceipt({
      taskId: (task && task.id) ? task.id : 'review-' + String(session.diffHash).slice(0, 8),
      reviewer: session.verdict.reviewer,
      verdict: 'ACCEPT',
      scope: {
        description: session.scope || 'working tree',
        lenses: v.requiredLenses,
        stage: v.stage,
        authorshipEnforced: authorship.enforced,
      },
    });
  }

  return emit({
    ok: true, sub: 'verdict', ...v,
    authorshipEnforced: authorship.enforced, authorshipReason: authorship.reason,
    lensesWithoutAgent: authorship.lensesWithoutAgent, authors: authorship.authors,
    receipt: receipt ? { taskId: receipt.taskId, diffHash: receipt.diffHash } : null,
    advice,
  }, v.verdict === 'ACCEPT' ? 0 : 2);
}

function reviewBacklog(flags, act) {
  const state = readReviewState();
  if (state.corrupt) return corruptSession('backlog', state.corrupt, { act });
  const session = state.session;
  if (act === 'list') {
    const now = Date.now();
    const entries = ((session && session.backlog) || []).map((e) => ({
      ...e, expired: !(Date.parse(e.expiry) > now),
    }));
    const expired = entries.filter((e) => e.expired).length;
    return emit({ ok: true, sub: 'backlog', act: 'list', count: entries.length, expired, entries }, 0);
  }
  if (act === 'add') {
    const parsed = readJsonStdin('{"owner":"...","expiry":"2099-12-31","summary":"...","lens":"...","location":"file:line"}');
    if (!parsed.ok) return emit({ ok: false, sub: 'backlog', act, ...parsed }, 3);
    const f = freshness(session, isGitRepo() ? gitFingerprint() : '');
    if (!f.ok) {
      process.stderr.write('review backlog add: ' + f.reason + '\n');
      return emit({ ok: false, sub: 'backlog', act, ...f }, f.stale ? 4 : 3);
    }
    const errors = backlogViolations(parsed.value);
    if (errors.length) {
      for (const e of errors) process.stderr.write('backlog rejected: ' + e + '\n');
      return emit({ ok: false, sub: 'backlog', act, errors }, 1);
    }
    const entry = {
      at: nowIso(),
      owner: String(parsed.value.owner),
      expiry: String(parsed.value.expiry),
      lens: String(parsed.value.lens),
      summary: String(parsed.value.summary),
      location: typeof parsed.value.location === 'string' ? parsed.value.location : null,
    };
    session.backlog = (session.backlog || []).concat([entry]);
    saveReview(session);
    return emit({ ok: true, sub: 'backlog', act, entry, count: session.backlog.length }, 0);
  }
  return emit({
    ok: false, sub: 'backlog', error: 'backlog-action',
    detail: 'usage: review backlog list|add', got: act || null,
  }, 3);
}

function reviewStatus() {
  const state = readReviewState();
  if (state.corrupt) return corruptSession('status', state.corrupt);
  const session = state.session;
  const diffHash = isGitRepo() ? gitFingerprint() : null;
  if (!session) {
    return emit({ ok: false, sub: 'status', note: 'no-review-session', session: null, diffHash }, 0);
  }
  const stale = session.diffHash !== diffHash;
  const stage = currentStage(session);
  const ledger = readAuthorship();
  const authors = authorSetFor(ledger.records, changedSet());
  const authorship = authorshipStatus(session, authors, {
    unreadable: ledger.unreadable,
    records: ledger.records.filter((r) => r && !r.corrupt).length,
  });
  return emit({
    ok: true, sub: 'status', stale, diffHash, sessionDiffHash: session.diffHash,
    startedAt: session.startedAt, profile: session.profile, catalogPresent: session.catalogPresent,
    stage, stageName: REVIEW_STAGES[stage],
    requiredLenses: session.requiredLenses,
    reportedLenses: Object.keys(session.lenses || {}),
    missingLenses: session.requiredLenses.filter((n) => stageOf(n) === stage && !(session.lenses || {})[n]),
    blue: !!session.blue,
    round: (session.lineage || []).length + 1,
    backlog: (session.backlog || []).length,
    verdict: session.verdict ? session.verdict.verdict : null,
    authorshipEnforced: authorship.enforced, authorshipReason: authorship.reason,
    lensesWithoutAgent: authorship.lensesWithoutAgent,
  }, 0);
}

function cmdReview(flags = {}, positional = []) {
  const sub = positional[0] || 'status';
  if (sub === 'start') return reviewStart(flags);
  if (sub === 'blue') return reviewBlue();
  if (sub === 'lens') return reviewLens(flags, positional[1]);
  if (sub === 'verdict') return reviewVerdictCmd(flags);
  if (sub === 'backlog') return reviewBacklog(flags, positional[1] || 'list');
  if (sub === 'status') return reviewStatus();
  if (sub === 'team') {
    const loaded = loadCatalogFlag(flags);
    const catalog = loaded.ok ? loaded.catalog : null;
    let affected = null;
    if (catalog && isGitRepo()) {
      const cp = changedPaths();
      affected = analyzeImpact(Array.isArray(cp) ? cp : cp.paths, catalog, {}).affected;
    }
    const convened = reviewLenses(catalog, { affected });
    return emit({
      ok: true, sub: 'team', profile: reviewProfile(catalog), catalogPresent: !!catalog, affected,
      convened: convened.map((n) => ({ lens: n, stage: stageOf(n), asks: LENS_LIBRARY[n] ? LENS_LIBRARY[n].asks : null })),
      excluded: lensExclusions(catalog, affected),
      stages: REVIEW_STAGES,
      maxRounds: maxRoundsOf(catalog),
    }, 0);
  }
  return emit({
    error: 'review-subcommand',
    detail: 'usage: review start|blue|lens <name>|verdict|backlog list|add|status|team', got: sub || null,
  }, 3);
}

// ---------------------------------------------------------------------------
// S20.7 review-pack
// ---------------------------------------------------------------------------
function parseNameStatus(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const st = tokens[i];
    if (!/^[A-Z]\d*$/.test(st)) continue;
    const kind = st[0];
    if ((kind === 'R' || kind === 'C') && tokens[i + 2] !== undefined) {
      out.push({ status: kind, from: tokens[i + 1], path: tokens[i + 2] });
      i += 2;
    } else if (tokens[i + 1] !== undefined) {
      out.push({ status: kind, path: tokens[i + 1] });
      i += 1;
    }
  }
  return out;
}

function deletionAudit(entries) {
  const deleted = entries.filter((e) => e.status === 'D').map((e) => e.path);
  const movedAway = entries.filter((e) => e.status === 'R').map((e) => e.from + ' -> ' + e.path);
  return { deleted, movedAway };
}

function intFlag(v, dflt) {
  if (typeof v !== 'string') return dflt;
  const n = parseInt(v, 10);
  return (Number.isNaN(n) || n < 0) ? dflt : n;
}

function cmdReviewPack(flags = {}) {
  const cwd = projectRoot();
  if (!isGitRepo(cwd)) {
    return emit({
      ok: false, degraded: true, reason: 'non-git',
      detail: 'there is no diff to pack outside a git repository',
    }, 3);
  }
  const base = typeof flags.base === 'string' && flags.base ? flags.base : 'HEAD';
  const maxDiffLines = intFlag(flags['max-diff-lines'], 800);
  const text = (r) => (r.stdout || Buffer.alloc(0)).toString('utf8');
  const commits = text(git(['log', '--oneline', base + '..HEAD'], { cwd })).trim();
  const stat = text(git(['diff', '--stat', base], { cwd })).trim();
  const nameStatus = parseNameStatus(splitNul(
    git(['-c', 'core.quotePath=false', 'diff', '--name-status', '-z', base], { cwd }).stdout || Buffer.alloc(0),
  ));
  const audit = deletionAudit(nameStatus);
  const untracked = splitNul(
    git(['-c', 'core.quotePath=false', 'ls-files', '-z', '--others', '--exclude-standard'], { cwd }).stdout,
  ).filter((p) => !isStateExcluded(p));
  const full = text(git(['diff', base], { cwd }));
  const lines = full === '' ? 0 : full.replace(/\r\n/g, '\n').split('\n').length;

  const dir = reviewPackDir();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = String(base).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40)
    + '-' + gitFingerprint().slice(0, 12);
  let diffSection;
  let spillPath = null;
  if (lines > maxDiffLines) {
    spillPath = path.join(dir, 'review-diff-' + stamp + '.patch');
    writeAtomic(spillPath, full);
    diffSection = 'The diff is ' + lines + ' lines, past the ' + maxDiffLines
      + '-line inline budget, and was written to ' + relFromRoot(spillPath) + '. Read it there.';
  } else {
    diffSection = full || '(no tracked changes)';
  }

  const body = [
    '# Review evidence pack',
    '',
    'Base: ' + base,
    'Head: ' + (headCommit(cwd) || 'n/a'),
    'Diff hash: ' + gitFingerprint(),
    'Generated: ' + nowIso(),
    '',
    '## Commits',
    '',
    commits || '(none)',
    '',
    '## Diffstat',
    '',
    stat || '(empty)',
    '',
    '## Deletions and renames -- review what left, not only what arrived',
    '',
    audit.deleted.length ? audit.deleted.join('\n') : '(no deleted files)',
    '',
    audit.movedAway.length ? audit.movedAway.join('\n') : '(no renames)',
    '',
    '## Untracked new files',
    '',
    untracked.length ? untracked.join('\n') : '(none)',
    '',
    '## Diff',
    '',
    diffSection,
    '',
  ].join('\n');
  const outPath = path.join(dir, 'review-pack-' + stamp + '.md');
  writeAtomic(outPath, body);
  process.stderr.write('review pack written to ' + relFromRoot(outPath) + '\n');
  return emit({
    ok: true, base, packPath: relFromRoot(outPath),
    commits: commits ? commits.replace(/\r\n/g, '\n').split('\n').length : 0,
    deleted: audit.deleted, movedAway: audit.movedAway, untracked,
    diffLines: lines, spilled: spillPath ? relFromRoot(spillPath) : null,
    diffHash: gitFingerprint(),
  }, 0);
}

// ---------------------------------------------------------------------------
// S20.8 authorship CLI
// ---------------------------------------------------------------------------
function cmdAuthorship(flags = {}, positional = []) {
  const sub = positional[0] || 'show';
  if (sub === 'record') {
    const parsed = readJsonStdin('{"agentId":"...","agentType":"implementer","files":["src/a.ts"]}');
    if (!parsed.ok) return emit({ ok: false, sub, ...parsed }, 3);
    const input = parsed.value;
    const missing = [];
    const agentId = (input && typeof input.agentId === 'string') ? input.agentId.trim() : '';
    const files = (input && Array.isArray(input.files))
      ? input.files.filter((f) => typeof f === 'string' && f.trim()).map((f) => toPosixPath(f.trim()))
      : [];
    if (!agentId) missing.push('agentId');
    if (!files.length) missing.push('files');
    if (missing.length) {
      process.stderr.write('authorship record is incomplete; missing: ' + missing.join(', ') + '\n');
      return emit({ ok: false, sub, error: 'authorship-incomplete', missing }, 3);
    }
    const record = {
      at: nowIso(),
      agentId,
      agentType: (input && typeof input.agentType === 'string' && input.agentType.trim())
        ? input.agentType.trim() : null,
      baseCommit: headCommit(),
      files,
    };
    try {
      appendAuthorship(record);
    } catch (e) {
      process.stderr.write('authorship record could not be appended: ' + String((e && e.message) || e) + '\n');
      return emit({
        ok: false, sub, error: 'authorship-append-failed',
        detail: String((e && e.message) || e),
      }, 3);
    }
    return emit({ ok: true, sub, path: relFromRoot(authorshipFilePath()), record }, 0);
  }
  if (sub === 'show') {
    if (!isGitRepo()) {
      return emit({
        ok: false, sub, degraded: true, reason: 'non-git',
        detail: 'without a diff there is no set of changed files to attribute',
      }, 3);
    }
    const ledger = readAuthorship();
    if (ledger.unreadable) {
      process.stderr.write('authorship show: the ledger exists but could not be read ('
        + ledger.unreadable + ')\n');
      return emit({
        ok: false, sub, degraded: true, error: 'authorship-unreadable',
        detail: ledger.unreadable,
      }, 3);
    }
    const changed = changedSet();
    const authors = authorSetFor(ledger.records, changed);
    const attributed = new Set();
    for (const a of authors.values()) for (const f of a.files) attributed.add(f);
    return emit({
      ok: true, sub,
      records: ledger.records.filter((r) => r && !r.corrupt).length,
      corruptLines: ledger.records.filter((r) => r && r.corrupt).length,
      changedFiles: changed.size,
      authors: [...authors.values()],
      unattributed: [...changed].filter((f) => !attributed.has(f)).sort(),
      path: relFromRoot(authorshipFilePath()),
    }, 0);
  }
  return emit({
    error: 'authorship-subcommand', detail: 'usage: authorship record|show',
    got: sub || null,
  }, 3);
}

export {
  REVIEW_STAGES, LENS_LIBRARY, REVIEW_PROFILES, LOCATION_RE, SEVERITIES,
  BACKLOG_PROTECTED_LENSES, BACKLOG_FORBIDDEN_RE, DEFAULT_MAX_ROUNDS,
  stageOf, reviewProfile, maxRoundsOf, reviewLenses, lensExclusions, stagePassed, currentStage,
  reviewFilePath, authorshipFilePath, reviewPackDir, readReviewState, saveReview, freshness,
  validateClaims, validateFindings, backlogViolations,
  parseAuthorshipLines, readAuthorship, appendAuthorship, authorSetFor, selfReviewedLenses,
  authorshipStatus, computeVerdict, verdictAdvice,
  parseNameStatus, deletionAudit,
  cmdReview, cmdReviewPack, cmdAuthorship,
};
