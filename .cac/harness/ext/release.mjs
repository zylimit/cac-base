// ext/release.mjs — S27 release readiness assembly (read-only: never tags, pushes, publishes or writes).
// Ensures review-queue & audit logs never deadlock release when `.needs-review` is clean.
// Depends on ../lib/core.mjs and ./{catalog,evidence,spec,memory}.mjs.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  HARNESS_DIR, changedPaths, emit, git, gitFingerprint, globToRegExp, headCommit, isGitRepo,
  isStateExcluded, projectRoot, sha256, toPosixPath, whichCmd,
} from '../lib/core.mjs';
import { loadCatalog } from './catalog.mjs';
import { readLedgerState } from './evidence.mjs';
import { dodStatus } from './spec.mjs';
import { fastModeState, pendingReviewCount } from './memory.mjs';

const REMOTE_TIMEOUT_MS = 20000;
const CI_TIMEOUT_MS = 25000;
const DOD_TIMEOUT_MS = 300000;
const LIST_CAP = 10;

function result(id, status, summary, evidence, nextStep) {
  return {
    id,
    status,
    blocking: true,
    summary,
    evidence: evidence === undefined ? null : evidence,
    nextStep: nextStep || null,
  };
}

function capped(list) {
  return list.length <= LIST_CAP ? list.slice() : list.slice(0, LIST_CAP).concat(['... ' + (list.length - LIST_CAP) + ' more']);
}

function errHead(r) {
  const s = String((r && r.stderr) || '').replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
  return s.length ? s[0].slice(0, 200) : null;
}

// ===========================================================================
// S27.2 check 1 -- worktree
// ===========================================================================
function checkWorktree() {
  const changed = changedPaths();
  if (changed && changed.nonGit) {
    return result('worktree', 'DEGRADED', 'not a git repository, so there is no commit to judge', null, null);
  }
  const list = Array.isArray(changed) ? changed : changed.paths;
  const dirty = list.filter((p) => !isStateExcluded(p)).map(toPosixPath).sort();
  if (dirty.length === 0) {
    return result('worktree', 'PASS', 'no uncommitted changes outside runtime state', { dirty: 0 }, null);
  }
  return result('worktree', 'FAIL',
    dirty.length + ' uncommitted path(s); what would ship is not what was tested',
    { dirty: dirty.length, paths: capped(dirty) },
    'git status --porcelain');
}

// ===========================================================================
// S27.3 check 2 -- remote
// ===========================================================================
function currentBranch() {
  const cwd = projectRoot();
  const r = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  if (r.status !== 0) return null;
  const name = r.stdout.toString('utf8').trim();
  return (!name || name === 'HEAD') ? null : name;
}

function hasOrigin() {
  const cwd = projectRoot();
  const r = git(['remote'], { cwd });
  if (r.status !== 0) return false;
  return r.stdout.toString('utf8').replace(/\r\n/g, '\n').split('\n').map((s) => s.trim()).includes('origin');
}

function lsRemoteBranch(branch) {
  const r = spawnSync('git', ['ls-remote', '--exit-code', 'origin', 'refs/heads/' + branch], {
    cwd: projectRoot(),
    input: '',
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: REMOTE_TIMEOUT_MS,
  });
  if (r.error || r.signal) {
    return { reachable: false, detail: r.signal ? ('timed out after ' + REMOTE_TIMEOUT_MS + 'ms') : String(r.error.message) };
  }
  if (r.status === 2) return { reachable: true, missing: true };
  if (r.status !== 0) return { reachable: false, detail: errHead(r) || ('git ls-remote exited ' + r.status) };
  const line = String(r.stdout || '').replace(/\r\n/g, '\n').split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
  const sha = line.split(/\s+/)[0] || '';
  if (!/^[0-9a-f]{40}$/.test(sha)) return { reachable: false, detail: 'unreadable ls-remote output' };
  return { reachable: true, sha };
}

function divergenceStep(remoteSha, branch) {
  const cwd = projectRoot();
  const known = git(['cat-file', '-e', remoteSha + '^{commit}'], { cwd });
  if (known.status !== 0) return 'git fetch origin  # origin has a commit this clone has never seen';
  const ancestor = git(['merge-base', '--is-ancestor', remoteSha, 'HEAD'], { cwd });
  if (ancestor.status === 0) return 'git push origin ' + branch + '  # local is ahead of origin';
  return 'git fetch origin && git log --oneline HEAD..origin/' + branch + '  # the two have diverged';
}

function checkRemote() {
  const head = headCommit();
  if (!head) return result('remote', 'DEGRADED', 'no HEAD commit to compare', null, null);
  const branch = currentBranch();
  if (!branch) {
    return result('remote', 'DEGRADED', 'detached HEAD, so there is no branch to compare against origin', { head }, null);
  }
  if (!hasOrigin()) {
    return result('remote', 'DEGRADED', 'no origin remote; local vs remote is UNKNOWN, which is not a pass', { branch }, null);
  }
  const remote = lsRemoteBranch(branch);
  if (!remote.reachable) {
    return result('remote', 'DEGRADED',
      'origin could not be reached; local vs remote is UNKNOWN, which is not a pass',
      { branch, detail: remote.detail }, null);
  }
  if (remote.missing) {
    return result('remote', 'FAIL', 'origin has no branch ' + branch + '; this commit exists nowhere but here',
      { branch, head }, 'git push -u origin ' + branch);
  }
  if (remote.sha === head) {
    return result('remote', 'PASS', 'origin/' + branch + ' is this exact commit', { branch, head }, null);
  }
  return result('remote', 'FAIL', 'origin/' + branch + ' is a different commit than local HEAD',
    { branch, head, remote: remote.sha }, divergenceStep(remote.sha, branch));
}

// ===========================================================================
// S27.4 check 3 -- dod
// ===========================================================================
function harnessEntry() {
  return path.join(HARNESS_DIR, 'harness.mjs');
}

function checkDod() {
  const root = projectRoot();
  const r = spawnSync(process.execPath, [harnessEntry(), 'dod'], {
    cwd: root,
    input: '',
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: DOD_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CODEAGENT3_PROJECT_DIR: root, CAC_PROJECT_DIR: root },
  });
  if (r.error || r.signal) {
    return result('dod', 'DEGRADED', 'dod could not be run to a verdict',
      { detail: r.signal ? ('timed out after ' + DOD_TIMEOUT_MS + 'ms') : String(r.error.message) },
      'node .cac/harness/harness.mjs dod');
  }
  let body = null;
  try { body = JSON.parse(String(r.stdout || '').trim()); } catch (_e) { body = null; }
  const code = typeof r.status === 'number' ? r.status : null;
  const status = code === null ? 'FAIL' : dodStatus(code);
  const failures = (body && Array.isArray(body.blockingFailures)) ? body.blockingFailures : [];
  const steps = (body && Array.isArray(body.steps)) ? body.steps.length : null;
  if (status === 'PASS') {
    return result('dod', 'PASS', 'every blocking governance step passed', { exit: code, steps }, null);
  }
  if (status === 'DEGRADED') {
    return result('dod', 'DEGRADED', 'no blocking step reached a verdict, so nothing was established',
      { exit: code, steps }, null);
  }
  return result('dod', 'FAIL',
    failures.length ? ('blocking step(s) failed: ' + failures.join(', ')) : 'dod did not reach a satisfied verdict',
    { exit: code, steps, blockingFailures: capped(failures) },
    'node .cac/harness/harness.mjs dod' + (failures.length ? ' --only ' + failures.join(',') : ''));
}

// ===========================================================================
// S27.5 check 4 -- manifest (.cac/FRAMEWORK-MANIFEST.json)
// ===========================================================================
const MANIFEST_FILE = 'FRAMEWORK-MANIFEST.json';

const MANIFEST_RULES = [
  { pattern: 'FRAMEWORK-MANIFEST.json', keep: false },
  { pattern: 'FRAMEWORK-MANIFEST-OPTIONAL.json', keep: false },
  { pattern: 'FRAMEWORK-MANIFEST.txt', keep: false },
  { pattern: 'FRAMEWORK-MANIFEST-OPTIONAL.txt', keep: false },
  { pattern: 'settings.json', keep: false },
  { pattern: 'settings-windows.json', keep: false },
  { pattern: 'settings.local.json', keep: false },
  { pattern: '.credentials.json', keep: false },
  { pattern: 'EVOLUTION.md', keep: false },
  { pattern: '.needs-review', keep: false },
  { pattern: '.needs-review.lock', keep: false },
  { pattern: '.tdd-exempt', keep: false },
  { pattern: '.red-verified', keep: false },
  { pattern: '.static-gate', keep: false },
  { pattern: '.degraded-review', keep: false },
  { pattern: '.fast-mode', keep: false },
  { pattern: '.subagent-reminded', keep: false },
  { pattern: '.three-file-sync-advised', keep: false },
  { pattern: '.tdd-gate-advised', keep: false },
  { pattern: '.stop-gate-strikes', keep: false },
  { pattern: '.stop-gate-advised', keep: false },
  { pattern: '.precompact-block-epoch', keep: false },
  { pattern: '.async-verify-last', keep: false },
  { pattern: 'signals.jsonl', keep: false },
  { pattern: '*/signals.jsonl', keep: false },
  { pattern: 'evidence/*', keep: false },
  { pattern: 'harness/module-catalog.json', keep: false },
  { pattern: 'harness/receipts/*', keep: false },
  { pattern: 'harness/state/*', keep: false },
  { pattern: 'harness/waivers/*', keep: false },
  { pattern: 'harness/trend/*', keep: false },
  { pattern: 'harness/evidence/*', keep: false },
  { pattern: 'harness/ext/*', keep: false },
  { pattern: 'rules/harness-large-repo.md', keep: false },
  { pattern: 'rules/quality-attributes.md', keep: false },
  { pattern: '.runtime/*', keep: false },
  { pattern: 'worktrees/*', keep: false },
  { pattern: 'tests/*', keep: false },
  { pattern: 'research/*', keep: false },
  { pattern: 'agent-memory/*', keep: false },
  { pattern: '*.bak', keep: false },
  { pattern: '*.cac-base-new', keep: false },
  { pattern: '*.framework-new', keep: false },
  { pattern: '.DS_Store', keep: false },
  { pattern: '*/.DS_Store', keep: false },
  { pattern: 'Thumbs.db', keep: false },
  { pattern: '*/Thumbs.db', keep: false },
  { pattern: '*.swp', keep: false },
  { pattern: 'feedback/templates/*', keep: true },
  { pattern: 'feedback/*', keep: false },
];

function caseGlobToRegExp(pattern) {
  const alts = String(pattern).split('|').map((part) => {
    let re = '';
    for (const ch of part) {
      if (ch === '*') re += '.*';
      else if (ch === '?') re += '.';
      else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return re;
  });
  return new RegExp('^(?:' + alts.join('|') + ')$');
}

const MANIFEST_MATCHERS = MANIFEST_RULES.map((r) => ({ re: caseGlobToRegExp(r.pattern), keep: r.keep }));

function loadExtraMatchers(root) {
  const exclPath = path.join(root, '.cac', 'harness', 'exclusions.json');
  if (!fs.existsSync(exclPath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(exclPath, 'utf8'));
    if (!raw || typeof raw !== 'object') return [];
    const keepFirst = [];
    const extra = [];
    if (Array.isArray(raw.templateInitFiles)) {
      for (const item of raw.templateInitFiles) {
        if (!item || typeof item !== 'object') continue;
        if (typeof item.template === 'string') {
          const tpl = toPosixPath(item.template);
          if (tpl.startsWith('.cac/')) keepFirst.push({ re: globToRegExp(tpl.slice(5)), keep: true });
        }
        if (typeof item.target === 'string') {
          const tgt = toPosixPath(item.target);
          if (tgt.startsWith('.cac/')) extra.push({ re: globToRegExp(tgt.slice(5)), keep: false });
        }
      }
    }
    if (Array.isArray(raw.mergedFiles)) {
      for (const mf of raw.mergedFiles) {
        if (typeof mf !== 'string') continue;
        const norm = toPosixPath(mf);
        if (norm.startsWith('.cac/')) extra.push({ re: globToRegExp(norm.slice(5)), keep: false });
      }
    }
    if (raw.optionalPackages && typeof raw.optionalPackages === 'object' && !Array.isArray(raw.optionalPackages)) {
      for (const pkgPath of Object.values(raw.optionalPackages)) {
        if (typeof pkgPath !== 'string') continue;
        const norm = toPosixPath(pkgPath).replace(/\/+$/, '');
        if (norm.startsWith('.cac/')) {
          const sub = norm.slice(5);
          extra.push({ re: globToRegExp(sub), keep: false });
          extra.push({ re: globToRegExp(sub + '/**'), keep: false });
        }
      }
    }
    if (Array.isArray(raw.alwaysExclude)) {
      for (const g of raw.alwaysExclude) {
        if (typeof g !== 'string') continue;
        const norm = toPosixPath(g);
        if (norm.startsWith('.cac/')) extra.push({ re: globToRegExp(norm.slice(5)), keep: false });
        else if (norm.startsWith('**/') || !norm.includes('/')) extra.push({ re: globToRegExp(norm), keep: false });
      }
    }
    if (Array.isArray(raw.entries)) {
      for (const e of raw.entries) {
        if (!e || typeof e.pattern !== 'string' || e.mainTree === false) continue;
        extra.push({ re: caseGlobToRegExp(e.pattern), keep: Boolean(e.keep) });
      }
    }
    return [...keepFirst, ...extra];
  } catch (_e) {
    return [];
  }
}

function manifestIncludes(rel, extraMatchers = []) {
  for (const m of MANIFEST_MATCHERS) {
    if (m.re.test(rel)) return m.keep;
  }
  for (const m of extraMatchers) {
    if (m.re.test(rel)) return m.keep;
  }
  return true;
}

function normalizedSha(file) {
  const buf = fs.readFileSync(file);
  const out = Buffer.allocUnsafe(buf.length);
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0x0d) out[n++] = buf[i];
  }
  return sha256(out.subarray(0, n));
}

function walkCacTree(dir, base, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_e) { return out; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walkCacTree(abs, base, out);
    else if (e.isFile()) out.push(toPosixPath(path.relative(base, abs)));
  }
  return out;
}

/**
 * Parse `.cac/FRAMEWORK-MANIFEST.json` (or tab-separated lines in pure unit tests) into Map<relInCac, sha256>.
 */
function parseManifest(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '').trim();
  const map = new Map();
  if (!raw) return map;
  if (raw.startsWith('{')) {
    const parsed = JSON.parse(raw);
    const files = Array.isArray(parsed && parsed.files) ? parsed.files : [];
    for (const f of files) {
      if (!f || typeof f.path !== 'string' || typeof f.sha256 !== 'string') continue;
      const p = toPosixPath(f.path);
      const rel = p.startsWith('.cac/') ? p.slice(5) : p;
      map.set(rel, f.sha256.trim());
    }
    return map;
  }
  for (const line of raw.split('\n')) {
    const s = line.replace(/\r$/, '');
    if (!s || s.startsWith('#')) continue;
    const tab = s.indexOf('\t');
    if (tab < 0) continue;
    const key = toPosixPath(s.slice(0, tab));
    map.set(key.startsWith('.cac/') ? key.slice(5) : key, s.slice(tab + 1).trim());
  }
  return map;
}

function manifestFindings(declared, actual) {
  const missing = [];
  const stale = [];
  const changed = [];
  for (const [rel, sha] of actual) {
    if (!declared.has(rel)) missing.push(rel);
    else if (declared.get(rel) !== sha) changed.push(rel);
  }
  for (const rel of declared.keys()) {
    if (!actual.has(rel)) stale.push(rel);
  }
  return { missing: missing.sort(), stale: stale.sort(), changed: changed.sort() };
}

function checkManifest() {
  const root = projectRoot();
  const cacDir = path.join(root, '.cac');
  const manifestPath = path.join(cacDir, MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) {
    return result('manifest', 'DEGRADED',
      'no .cac/' + MANIFEST_FILE + '; this tree does not distribute a framework layer', null, null);
  }
  let declared;
  try { declared = parseManifest(fs.readFileSync(manifestPath, 'utf8')); } catch (e) {
    return result('manifest', 'DEGRADED', 'manifest present but unreadable',
      { detail: String((e && e.message) || e) }, null);
  }
  const extra = loadExtraMatchers(root);
  const actual = new Map();
  for (const rel of walkCacTree(cacDir, cacDir, [])) {
    if (!manifestIncludes(rel, extra)) continue;
    try { actual.set(rel, normalizedSha(path.join(cacDir, rel))); } catch (_e) { /* vanished */ }
  }
  const f = manifestFindings(declared, actual);
  const total = f.missing.length + f.stale.length + f.changed.length;
  if (total === 0) {
    return result('manifest', 'PASS', declared.size + ' framework file(s) match the manifest',
      { declared: declared.size, onDisk: actual.size }, null);
  }
  return result('manifest', 'FAIL',
    'manifest does not match live .cac/ tree: ' + f.missing.length + ' unlisted, '
      + f.stale.length + ' listed but absent, ' + f.changed.length + ' with a different digest',
    {
      declared: declared.size, onDisk: actual.size,
      missingFromManifest: capped(f.missing), staleInManifest: capped(f.stale), digestChanged: capped(f.changed),
    },
    'node scripts/cac-base.mjs manifest --write');
}

// ===========================================================================
// S27.6 checks 5 and 6 -- review queue and tier
// ===========================================================================
function checkReviewQueue() {
  const pending = pendingReviewCount();
  if (pending === 0) {
    return result('review-queue', 'PASS', 'nothing waiting for review', { pending: 0 }, null);
  }
  return result('review-queue', 'FAIL', pending + ' file(s) still queued for review',
    { pending }, 'echo clean > .cac/.needs-review  # after independent code-reviewer passes');
}

function checkTier() {
  const state = fastModeState();
  if (!state.active) {
    return result('tier', 'PASS', state.tier + '; the review and test gates were in force',
      { tier: state.tier, source: state.source, active: false }, null);
  }
  return result('tier', 'FAIL',
    'fast, so this batch skipped the review and test gates -- that is debt, not a state',
    { tier: state.tier, source: state.source, active: true, remainingHours: state.remainingHours },
    'node .cac/harness/harness.mjs tier set standard');
}

// ===========================================================================
// S27.7 check 7 -- ci
// ===========================================================================
const CI_BAD = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);
const CI_GOOD = new Set(['success']);

function ghRunsForCommit(sha) {
  const r = spawnSync('gh',
    ['run', 'list', '--commit', sha, '--limit', '20', '--json', 'databaseId,status,conclusion,workflowName'],
    {
      cwd: projectRoot(),
      input: '',
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: CI_TIMEOUT_MS,
      env: { ...process.env, GH_PAGER: 'cat', GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
    });
  if (r.error || r.signal) {
    return { ok: false, detail: r.signal ? ('timed out after ' + CI_TIMEOUT_MS + 'ms') : String(r.error.message) };
  }
  if (r.status !== 0) return { ok: false, detail: errHead(r) || ('gh exited ' + r.status) };
  let runs = null;
  try { runs = JSON.parse(String(r.stdout || '').trim()); } catch (_e) { runs = null; }
  if (!Array.isArray(runs)) return { ok: false, detail: 'gh returned output this could not read as JSON' };
  return { ok: true, runs };
}

function ciBuckets(runs) {
  const bad = [];
  const good = [];
  const inconclusive = [];
  for (const run of runs) {
    const name = String((run && run.workflowName) || 'workflow');
    const conclusion = String((run && run.conclusion) || '');
    if (String((run && run.status) || '') !== 'completed') inconclusive.push(name + ': ' + (run.status || 'unknown'));
    else if (CI_BAD.has(conclusion)) bad.push(name + ': ' + conclusion);
    else if (CI_GOOD.has(conclusion)) good.push(name + ': ' + conclusion);
    else inconclusive.push(name + ': ' + (conclusion || 'no conclusion'));
  }
  return { bad, good, inconclusive };
}

function checkCi() {
  const head = headCommit();
  if (!head) return result('ci', 'DEGRADED', 'no HEAD commit, so CI status is UNKNOWN -- unknown is not a pass', null, null);
  if (!hasOrigin()) {
    return result('ci', 'DEGRADED', 'no origin remote, so CI status is UNKNOWN -- unknown is not a pass', { head }, null);
  }
  if (!whichCmd('gh')) {
    return result('ci', 'DEGRADED', 'gh is not installed, so CI status is UNKNOWN -- unknown is not a pass',
      { head }, 'install gh, then: gh run list --commit ' + head);
  }
  const q = ghRunsForCommit(head);
  if (!q.ok) {
    return result('ci', 'DEGRADED', 'CI could not be queried, so its status is UNKNOWN -- unknown is not a pass',
      { head, detail: q.detail }, 'gh auth status && gh run list --commit ' + head);
  }
  if (q.runs.length === 0) {
    return result('ci', 'DEGRADED',
      'CI has never run this commit (unpushed, or no workflow matched), so its status is UNKNOWN -- unknown is not a pass',
      { head, runs: 0 }, 'git push && gh run list --commit ' + head);
  }
  const b = ciBuckets(q.runs);
  if (b.bad.length) {
    return result('ci', 'FAIL', 'CI failed on this commit: ' + b.bad.join('; '),
      { head, runs: q.runs.length, failed: capped(b.bad) },
      'gh run list --commit ' + head);
  }
  if (b.inconclusive.length) {
    return result('ci', 'DEGRADED',
      'CI reached no conclusion for ' + b.inconclusive.length + ' run(s), so its status is UNKNOWN -- unknown is not a pass',
      { head, runs: q.runs.length, inconclusive: capped(b.inconclusive) },
      'gh run list --commit ' + head);
  }
  return result('ci', 'PASS', 'CI passed on this commit: ' + b.good.join('; '), { head, runs: q.runs.length }, null);
}

// ===========================================================================
// S27.8 check 8 -- gate-fresh
// ===========================================================================
const GATE_STEP = 'node .cac/harness/harness.mjs gate';

function gateEstablished(rec) {
  if (!rec || rec.reason === 'every-check-skipped') return false;
  if (rec.scopeSource === 'caller') return false;
  const results = Array.isArray(rec.results) ? rec.results : [];
  if (results.length === 0) return true;
  return results.some((r) => r && r.state !== 'SKIPPED');
}

function checkGateFresh() {
  if (!isGitRepo()) {
    return result('gate-fresh', 'DEGRADED',
      'not a git repository, so there is no working tree for a gate to be bound to', null, null);
  }
  const loaded = loadCatalog();
  if (!loaded.ok) {
    return result('gate-fresh', 'DEGRADED',
      'no module catalog, so there is no verification gate for this tree to be fresh against',
      { catalog: loaded.error }, null);
  }
  const state = readLedgerState();
  if (state.unreadable) {
    return result('gate-fresh', 'FAIL',
      'the verification ledger exists but could not be read (' + state.unreadable + ')',
      { detail: state.unreadable }, GATE_STEP);
  }
  const diffHash = gitFingerprint();
  const gates = state.entries.filter((e) => e && !e.corrupt && e.command === 'gate');
  const bound = gates.filter((e) => e.diffHash === diffHash && e.gate === 'PASS');
  const established = bound.filter(gateEstablished);
  if (established.length) {
    const latest = established[established.length - 1];
    return result('gate-fresh', 'PASS', 'a passing gate ran against this exact working tree',
      { diffHash, planHash: latest.planHash || null, gateRecords: gates.length }, null);
  }
  if (bound.length) {
    return result('gate-fresh', 'FAIL',
      bound.length + ' passing gate record(s) bind this tree, but none of them ran a check',
      { diffHash, boundToThisTree: bound.length, gateRecords: gates.length }, GATE_STEP);
  }
  return result('gate-fresh', 'FAIL',
    'no passing gate record is bound to this working tree, so what would ship was never verified',
    { diffHash, gateRecords: gates.length }, GATE_STEP);
}

// ===========================================================================
// S27.9 verdict and entry point
// ===========================================================================
const RELEASE_CHECKS = [
  checkWorktree, checkRemote, checkDod, checkManifest, checkReviewQueue, checkTier, checkCi, checkGateFresh,
];

function releaseVerdict(checks) {
  const failed = checks.filter((c) => c.status === 'FAIL');
  const established = checks.filter((c) => c.status !== 'DEGRADED').length;
  if (failed.length) {
    return {
      ok: false,
      exit: 1,
      blockers: failed.map((c) => ({ id: c.id, why: c.summary, nextStep: c.nextStep })),
      established,
    };
  }
  if (checks.length && established === 0) return { ok: false, exit: 3, blockers: [], established, degraded: true };
  return { ok: true, exit: 0, blockers: [], established };
}

const NOTE = 'assembly only: this command never tags, pushes, publishes or writes -- releasing stays a human decision';

const TRUST_BOUNDARY = {
  producerIdentityAuthenticated: false,
  ciProvenanceVerified: false,
  externalSignatureVerified: false,
  releaseAuthorized: false,
};

const TRUST_NOTE = 'Trust boundary: this is a release candidate attestation, not a release '
  + 'authorization -- producer identity, CI provenance and external signatures are all unverified here';

function cmdRelease() {
  if (!isGitRepo()) {
    process.stderr.write('Release readiness: cannot be assessed (not a git repository)\n');
    process.stderr.write(TRUST_NOTE + '\n');
    return emit({
      ok: false, degraded: true, error: 'non-git', checks: [], blockers: [], established: 0,
      trustBoundary: { ...TRUST_BOUNDARY }, note: NOTE,
    }, 3);
  }
  const checks = RELEASE_CHECKS.map((fn) => fn());
  for (const c of checks) {
    process.stderr.write(' ' + c.status.padEnd(9) + c.id.padEnd(14) + c.summary + '\n');
  }
  const verdict = releaseVerdict(checks);
  const degraded = checks.filter((c) => c.status === 'DEGRADED').map((c) => c.id);
  if (verdict.ok) {
    process.stderr.write('Release readiness: every blocking check passed'
      + (degraded.length ? ' (UNKNOWN, not passed: ' + degraded.join(', ') + ')' : '') + '\n');
  } else if (verdict.blockers.length) {
    process.stderr.write('Release readiness: NOT ready (' + verdict.blockers.map((b) => b.id).join(', ') + ')\n');
    for (const b of verdict.blockers) process.stderr.write('   ' + b.id + ' -> ' + b.nextStep + '\n');
  } else {
    process.stderr.write('Release readiness: nothing could be established (every check is UNKNOWN)\n');
  }
  process.stderr.write(TRUST_NOTE + '\n');
  return emit({
    ok: verdict.ok,
    ...(verdict.degraded ? { degraded: true } : {}),
    checks,
    blockers: verdict.blockers,
    degradedChecks: degraded,
    established: verdict.established,
    trustBoundary: { ...TRUST_BOUNDARY },
    note: NOTE,
  }, verdict.exit);
}

export {
  MANIFEST_RULES, RELEASE_CHECKS, NOTE, TRUST_BOUNDARY, TRUST_NOTE,
  caseGlobToRegExp, manifestIncludes, normalizedSha, parseManifest, manifestFindings,
  ciBuckets, releaseVerdict, result, capped,
  checkWorktree, checkRemote, checkDod, checkManifest, checkReviewQueue, checkTier, checkCi,
  gateEstablished, checkGateFresh,
  cmdRelease,
};
