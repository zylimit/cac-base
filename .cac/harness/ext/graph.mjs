// ext/graph.mjs — S5 impact, S12 arch-check, S16 arch-trend, S26 cochange.
// Fixes legacy EISDIR defect: recursively walks directories and always stats isFile() before reading source.

import fs from 'node:fs';
import path from 'node:path';
import {
  SOURCE_EXTS,
  changedPaths, emit, errDetail, git, headCommit, isGitRepo, isStateExcluded, parseCsv,
  projectRoot, readTextFile, recordCorruptState, repoRelative, toPosixPath,
} from '../lib/core.mjs';
import { classifyPath, loadCatalogFlag, moduleForPath, trackedFiles } from './catalog.mjs';

// ===========================================================================
// S5 impact
// ===========================================================================
function reverseClosure(seeds, catalog) {
  const rev = new Map();
  for (const m of (catalog.modules || [])) {
    for (const d of (m.dependsOn || [])) {
      if (!rev.has(d)) rev.set(d, []);
      rev.get(d).push(m.id);
    }
  }
  const out = new Set(seeds);
  const q = [...out];
  while (q.length) {
    const cur = q.pop();
    for (const consumer of (rev.get(cur) || [])) {
      if (!out.has(consumer)) { out.add(consumer); q.push(consumer); }
    }
  }
  return out;
}

function analyzeImpact(changed, catalog, { nonGit = false, truncated = false } = {}) {
  const reasons = new Set();
  const direct = new Set();
  for (const rawP of (changed || [])) {
    const p = toPosixPath(rawP);
    if (isStateExcluded(p)) continue;
    const cls = classifyPath(p, catalog);
    if (cls.kind === 'ignored') continue;
    if (cls.kind === 'global') reasons.add('global:' + p);
    else if (cls.kind === 'unmapped') reasons.add('unmapped:' + p);
    else direct.add(cls.moduleId);
  }
  if (nonGit) reasons.add('non-git');
  if (truncated) reasons.add('truncated');

  const allIds = (catalog.modules || []).map((m) => m.id);
  const degraded = reasons.size > 0;
  const affected = degraded ? allIds : [...reverseClosure(direct, catalog)];

  const verification = {};
  const riskChecks = (catalog.riskChecks && typeof catalog.riskChecks === 'object') ? catalog.riskChecks : {};
  const byId = new Map((catalog.modules || []).map((m) => [m.id, m]));
  for (const id of affected) {
    const m = byId.get(id);
    if (!m) continue;
    if (Array.isArray(m.verification)) verification[id] = m.verification;
    else if (m.riskTier && Array.isArray(riskChecks[m.riskTier])) verification[id] = riskChecks[m.riskTier];
  }

  return {
    affected,
    direct: [...direct],
    expansionReasons: [...reasons],
    verification,
    degraded,
  };
}

function cmdImpact(flags) {
  const loaded = loadCatalogFlag(flags);
  if (!loaded.ok) {
    return emit({ affected: [], direct: [], expansionReasons: [loaded.error], verification: {}, degraded: true }, 3);
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
  const result = analyzeImpact(changed, loaded.catalog, { nonGit });
  return emit(result, nonGit ? 3 : 0);
}

// ===========================================================================
// S12 arch-check (recursive directory expansion + multi-language import analysis)
// ===========================================================================
const JS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

const IMPORT_PATTERNS = [
  {
    exts: /\.(m|c)?(j|t)sx?$/,
    patterns: [
      /\bimport\s+(?:[\w*{}\n\r\t, ]+\s+from\s+)?["']([^"']+)["']/g,
      /\bexport\s+(?:[\w*{}\n\r\t, ]+\s+)?from\s+["']([^"']+)["']/g,
      /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
      /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    ],
  },
  { exts: /\.py$/, patterns: [/^[ \t]*from[ \t]+([.\w]+)[ \t]+import\b/gm, /^[ \t]*import[ \t]+([.\w]+)/gm] },
  { exts: /\.go$/, patterns: [/^[ \t]*(?:[\w.]+[ \t]+)?"([^"]+)"/gm] },
  { exts: /\.(java|kt|kts|scala)$/, patterns: [/^[ \t]*import[ \t]+(?:static[ \t]+)?([\w.]+)/gm] },
  { exts: /\.cs$/, patterns: [/^[ \t]*using[ \t]+(?:static[ \t]+)?([\w.]+)[ \t]*;/gm] },
  { exts: /\.rs$/, patterns: [/^[ \t]*use[ \t]+([\w:]+)/gm] },
  { exts: /\.rb$/, patterns: [/\brequire(?:_relative)?\s+["']([^"']+)["']/g] },
  { exts: /\.php$/, patterns: [/^[ \t]*use[ \t]+([\w\\]+)/gm] },
  { exts: /\.swift$/, patterns: [/^[ \t]*import[ \t]+([\w.]+)/gm] },
];

function extractImports(file, content) {
  const found = new Set();
  for (const group of IMPORT_PATTERNS) {
    if (!group.exts.test(file)) continue;
    for (const pattern of group.patterns) {
      pattern.lastIndex = 0;
      let m = pattern.exec(content);
      while (m) {
        if (m[1]) found.add(m[1]);
        m = pattern.exec(content);
      }
    }
  }
  return [...found];
}

function resolveRelativeImport(root, fromFile, spec) {
  const base = path.resolve(path.dirname(path.resolve(root, fromFile)), spec);
  const candidates = [base, ...JS_EXTS.map((e) => base + e)];
  const rewritten = base.replace(/\.(js|mjs|cjs|jsx)$/, '');
  if (rewritten !== base) for (const e of JS_EXTS) candidates.push(rewritten + e);
  for (const e of JS_EXTS) candidates.push(path.join(base, 'index' + e));
  candidates.push(base + '.py', path.join(base, '__init__.py'));
  for (const c of candidates) {
    let st;
    try { st = fs.statSync(c); } catch (_e) { continue; }
    if (!st.isFile()) continue;
    const rel = toPosixPath(path.relative(root, c));
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    return rel;
  }
  return null;
}

function moduleForSpecifier(catalog, spec) {
  let best = null;
  let bestLen = -1;
  for (const m of (catalog.modules || [])) {
    for (const p of (m.provides || [])) {
      if (spec !== p && !spec.startsWith(p + '/') && !spec.startsWith(p + '.')) continue;
      if (p.length > bestLen) { best = m; bestLen = p.length; }
    }
  }
  return best ? best.id : null;
}

function layerViolation(catalog, fromModule, toModule) {
  const order = Array.isArray(catalog.layers) ? catalog.layers : [];
  if (!order.length || !fromModule || !toModule || !fromModule.layer || !toModule.layer) return null;
  const fi = order.indexOf(fromModule.layer);
  const ti = order.indexOf(toModule.layer);
  if (fi === -1 || ti === -1 || ti >= fi) return null;
  return 'layer ' + fromModule.layer + ' may not depend on outer layer ' + toModule.layer;
}

function findCycles(edges) {
  const cycles = [];
  const state = new Map();
  const stack = [];
  const visit = (node) => {
    state.set(node, 1);
    stack.push(node);
    for (const next of (edges.get(node) || [])) {
      if (state.get(next) === 1) {
        const start = stack.indexOf(next);
        if (start !== -1) cycles.push([...stack.slice(start), next]);
      } else if (!state.has(next)) visit(next);
    }
    stack.pop();
    state.set(node, 2);
  };
  for (const node of edges.keys()) if (!state.has(node)) visit(node);
  return cycles;
}

/**
 * Expand candidate relative paths (files OR directories) into concrete repo-relative source files.
 * Guarantees directories are recursively traversed and NEVER passed directly to fs.readFileSync (fixes EISDIR).
 * @param {string} root
 * @param {string[]} candidates
 * @returns {string[]}
 */
function expandSourceFiles(root, candidates) {
  const seen = new Set();
  const out = [];
  const addFile = (rel) => {
    const norm = toPosixPath(rel);
    if (seen.has(norm) || isStateExcluded(norm)) return;
    const dot = norm.lastIndexOf('.');
    if (dot < 0 || !SOURCE_EXTS.has(norm.slice(dot).toLowerCase())) return;
    seen.add(norm);
    out.push(norm);
  };
  const walkDir = (absDir) => {
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch (_e) { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      if (ent.name === '.git' || ent.name === 'node_modules') continue;
      const full = path.join(absDir, ent.name);
      if (ent.isDirectory()) walkDir(full);
      else if (ent.isFile()) {
        const rel = toPosixPath(path.relative(root, full));
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) addFile(rel);
      }
    }
  };

  for (const raw of (candidates || [])) {
    const clean = toPosixPath(raw).replace(/\/\*\*$/, '').replace(/\/\*$/, '').replace(/\/+$/, '');
    if (!clean) continue;
    const abs = path.join(root, clean);
    let st;
    try { st = fs.statSync(abs); } catch (_e) { continue; }
    if (st.isDirectory()) walkDir(abs);
    else if (st.isFile()) addFile(clean);
  }
  return out;
}

/**
 * Pure/filesystem architecture check usable both from CLI (`cmdArchCheck`) and programmatic callers (`scanArch`).
 * Accepts optional `candidatePaths` (files or directories); recursively traverses directories without EISDIR.
 */
function scanArch(root, catalog, { candidatePaths = null, truncated = false, maxFiles = 20000 } = {}) {
  const declared = new Map((catalog.modules || []).map((m) => [m.id, new Set(m.dependsOn || [])]));
  const byId = new Map((catalog.modules || []).map((m) => [m.id, m]));
  const actual = new Map((catalog.modules || []).map((m) => [m.id, new Set()]));
  const forbidden = new Map();
  const undeclared = new Map();

  let rawCandidates = candidatePaths;
  if (!rawCandidates) {
    // Fallback to module paths when candidatePaths not provided (recursively walks directories!)
    rawCandidates = [];
    for (const m of (catalog.modules || [])) {
      for (const p of (m.paths || [])) rawCandidates.push(p);
    }
  }
  const sourceList = expandSourceFiles(root, rawCandidates);

  let scanned = 0;
  let unresolved = 0;
  let truncatedScan = Boolean(truncated);

  for (const rel of sourceList) {
    if (scanned >= maxFiles) { truncatedScan = true; break; }
    const owner = moduleForPath(rel, catalog);
    if (!owner) continue;
    let content;
    try {
      const abs = path.join(root, rel);
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > 1500000) continue;
      content = fs.readFileSync(abs, 'utf8');
    } catch (_e) {
      continue;
    }
    scanned++;
    for (const spec of extractImports(rel, content)) {
      let target = null;
      if (spec.startsWith('.')) {
        const resolved = resolveRelativeImport(root, rel, spec);
        target = resolved ? moduleForPath(resolved, catalog) : null;
        if (!resolved) unresolved++;
      } else {
        target = moduleForSpecifier(catalog, spec);
        if (!target) unresolved++;
      }
      if (!target || target === owner) continue;
      actual.get(owner).add(target);
      const key = owner + '->' + target;
      const site = rel + ': ' + spec;
      const rule = (byId.get(owner).forbiddenDependencies || []).includes(target)
        ? owner + ' forbids depending on ' + target
        : layerViolation(catalog, byId.get(owner), byId.get(target));
      if (rule) {
        const entry = forbidden.get(key) || { from: owner, to: target, rule, evidence: [] };
        if (entry.evidence.length < 5) entry.evidence.push(site);
        forbidden.set(key, entry);
        continue;
      }
      if (declared.get(owner).has(target)) continue;
      const entry = undeclared.get(key) || { from: owner, to: target, evidence: [] };
      if (entry.evidence.length < 5) entry.evidence.push(site);
      undeclared.set(key, entry);
    }
  }

  const unusedDeclarations = [];
  for (const [id, deps] of declared) {
    for (const d of deps) {
      if (!(actual.get(id) || new Set()).has(d)) unusedDeclarations.push({ from: id, to: d });
    }
  }
  const cycles = findCycles(actual);
  const resolvedEdges = [...actual.values()].reduce((a, s) => a + s.size, 0);
  const notes = [];
  if (scanned > 0 && resolvedEdges === 0) {
    notes.push(
      'no cross-module import edge resolved across ' + scanned + ' scanned files; '
      + (unresolved > 0
        ? unresolved + ' specifiers unattributed -- add `provides` prefixes for package-name imports'
        : 'expected only when modules are genuinely self-contained'),
    );
  }
  if (truncatedScan) notes.push('scan truncated at ' + Math.min(maxFiles, sourceList.length) + ' files; coverage incomplete');

  const ok = forbidden.size === 0 && undeclared.size === 0 && cycles.length === 0;
  const sortEdges = (a, z) => (a.from + '->' + a.to).localeCompare(z.from + '->' + z.to);

  return {
    ok,
    scannedFiles: scanned,
    truncated: truncatedScan,
    unresolvedImports: unresolved,
    resolvedEdges,
    notes,
    edges: [...actual].map(([id, s]) => ({ module: id, dependsOn: [...s].sort() })),
    forbiddenDependencies: [...forbidden.values()].sort(sortEdges),
    undeclaredDependencies: [...undeclared.values()].sort(sortEdges),
    unusedDeclarations: unusedDeclarations.sort(sortEdges),
    cycles,
    _undeclaredKeys: [...undeclared.keys()].sort(),
    _forbiddenKeys: [...forbidden.keys()].sort(),
  };
}

function cmdArchCheck(flags) {
  const loaded = loadCatalogFlag(flags);
  if (!loaded.ok) {
    return emit({ ok: false, degraded: true, error: loaded.error, detail: loaded.detail }, 3);
  }
  const root = projectRoot();
  if (!isGitRepo(root)) {
    return emit({ ok: false, degraded: true, error: 'non-git', detail: 'arch-check enumerates tracked files via git' }, 3);
  }
  const catalog = loaded.catalog;
  const maxFiles = (() => {
    const n = parseInt(flags['max-files'], 10);
    return (!Number.isNaN(n) && n > 0) ? n : 20000;
  })();

  const t = trackedFiles(catalog.maxTrackedPaths);
  const report = scanArch(root, catalog, { candidatePaths: t.paths, truncated: t.truncated, maxFiles });

  let recordedTo = null;
  if (flags.record === true) {
    try {
      recordedTo = appendTrendRecord({
        at: new Date().toISOString(),
        headCommit: headCommit(root),
        scannedFiles: report.scannedFiles,
        truncated: report.truncated,
        resolvedEdges: report.resolvedEdges,
        undeclared: report.undeclaredDependencies.length,
        forbidden: report.forbiddenDependencies.length,
        cycles: report.cycles.length,
        unused: report.unusedDeclarations.length,
        unresolved: report.unresolvedImports,
        undeclaredEdges: report._undeclaredKeys,
        forbiddenEdges: report._forbiddenKeys,
        cycleKeys: [...new Set(report.cycles.map(cycleKey))].sort(),
      });
      recordedTo = repoRelative(recordedTo);
    } catch (e) {
      process.stderr.write('arch-check: trend record failed: ' + String((e && e.message) || e) + '\n');
    }
  }

  const { _undeclaredKeys, _forbiddenKeys, ...publicReport } = report;
  return emit({ ...publicReport, recordedTo }, report.ok ? 0 : 1);
}

// ===========================================================================
// S16 arch-trend
// ===========================================================================
const TREND_METRICS = ['undeclared', 'forbidden', 'cycles', 'unused', 'unresolved'];
const RATCHET_METRICS = ['undeclared', 'cycles'];
const TREND_EDGE_FIELDS = { undeclared: 'undeclaredEdges', cycles: 'cycleKeys' };
const TREND_MAX_LINES = 1000;
const TREND_KEEP_LINES = 500;

function cycleKey(cycle) {
  const nodes = Array.isArray(cycle) ? cycle.slice(0, -1) : [];
  if (!nodes.length) return String(cycle);
  let at = 0;
  for (let i = 1; i < nodes.length; i++) if (nodes[i] < nodes[at]) at = i;
  const rot = nodes.slice(at).concat(nodes.slice(0, at));
  return rot.concat(rot[0]).join('->');
}

function trendFilePath() {
  return path.join(projectRoot(), '.cac', 'harness', 'trend', 'arch-trend.jsonl');
}

function appendTrendRecord(snap) {
  const fp = trendFilePath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  let lines = [];
  try { lines = fs.readFileSync(fp, 'utf8').split(/\r?\n/).filter(Boolean); } catch (_e) { lines = []; }
  if (lines.length >= TREND_MAX_LINES) lines = lines.slice(-TREND_KEEP_LINES);
  lines.push(JSON.stringify(snap));
  fs.writeFileSync(fp, lines.join('\n') + '\n', 'utf8');
  return fp;
}

function loadTrend() {
  const fp = trendFilePath();
  const read = readTextFile(fp);
  if (read.absent) return { records: [], corruptLines: 0, unreadable: null };
  if (read.error) {
    const detail = errDetail(read.error);
    recordCorruptState({ kind: 'arch-trend', path: fp, reason: detail });
    return { records: [], corruptLines: 0, unreadable: repoRelative(fp) };
  }
  const lines = read.text.split(/\r?\n/).filter(Boolean);
  const records = [];
  let corruptLines = 0;
  for (const l of lines) {
    try { records.push(JSON.parse(l)); } catch (_e) { corruptLines++; }
  }
  if (corruptLines) {
    recordCorruptState({ kind: 'arch-trend', path: fp, reason: corruptLines + ' unparseable line(s)' });
  }
  return { records, corruptLines, unreadable: null };
}

function compareRatchet(records) {
  const list = Array.isArray(records) ? records : [];
  if (list.length === 0) {
    return { comparable: false, regressed: [], improved: [], summary: {}, forbiddenViolation: null, edgeBasis: {} };
  }
  const latest = list[list.length - 1];
  const priorRecords = list.slice(0, -1);
  const summary = {};
  const regressed = [];
  const improved = [];
  const edgeBasis = {};
  for (const m of TREND_METRICS) {
    const series = list.map((r) => Number(r[m] || 0));
    const latestV = series[series.length - 1];
    const prior = series.slice(0, -1);
    const minPrior = prior.length ? Math.min(...prior) : null;
    summary[m] = {
      baseline: series[0],
      latest: latestV,
      min: Math.min(...series),
      deltaVsPrev: prior.length ? latestV - series[series.length - 2] : 0,
    };
    if (minPrior === null) continue;
    if (!RATCHET_METRICS.includes(m)) {
      if (latestV < minPrior) improved.push({ metric: m, latest: latestV, bestBefore: minPrior });
      continue;
    }
    const field = TREND_EDGE_FIELDS[m];
    const priorSets = priorRecords.map((r) => (Array.isArray(r[field]) ? r[field] : null));
    const usable = priorSets.filter(Boolean);
    const latestEdges = Array.isArray(latest[field]) ? latest[field] : null;
    const perEdge = !!(latestEdges && usable.length);
    let newEdges = [];
    if (perEdge) {
      const allowed = usable.reduce((acc, s) => acc.filter((e) => s.includes(e)), [...usable[0]]);
      newEdges = latestEdges.filter((e) => !allowed.includes(e));
    }
    edgeBasis[m] = {
      comparable: perEdge,
      countOnlyPriors: priorSets.length - usable.length,
      latestHasEdges: !!latestEdges,
    };
    const countRegressed = latestV > minPrior;
    if (countRegressed || newEdges.length) {
      const entry = { metric: m, latest: latestV, bestBefore: minPrior, basis: [] };
      if (countRegressed) entry.basis.push('count');
      if (newEdges.length) { entry.basis.push('edges'); entry.newEdges = newEdges; }
      regressed.push(entry);
    } else if (latestV < minPrior) {
      improved.push({ metric: m, latest: latestV, bestBefore: minPrior });
    }
  }
  const forbiddenCount = Number(latest.forbidden || 0);
  const forbiddenViolation = forbiddenCount > 0 ? {
    count: forbiddenCount,
    edges: Array.isArray(latest.forbiddenEdges) ? latest.forbiddenEdges : [],
    reason: 'forbiddenDependencies are declared boundaries, not debt: no baseline licenses them',
  } : null;
  return { comparable: list.length >= 2, regressed, improved, summary, forbiddenViolation, edgeBasis };
}

function cmdArchTrend(flags) {
  const { records, corruptLines, unreadable } = loadTrend();
  const gate = flags.gate === true;
  const damaged = corruptLines > 0 || !!unreadable;
  const corruptGate = gate && damaged;
  const corruptReason = unreadable
    ? 'trend-history-corrupt: the trend ledger at ' + unreadable + ' exists and cannot be read'
    : corruptLines > 0
      ? 'trend-history-corrupt: ' + corruptLines + ' line(s) of the trend ledger will not parse'
      : null;
  if (records.length === 0) {
    return emit({
      ok: !corruptGate,
      records: 0,
      corruptLines,
      ...(unreadable ? { unreadable } : {}),
      ...(corruptReason ? { reason: corruptReason } : {}),
      ...(damaged ? {} : { note: 'no trend data; run `arch-check --record` to establish a baseline' }),
    }, corruptGate ? 1 : 0);
  }
  const cmp = compareRatchet(records);
  const latest = records[records.length - 1];
  const ok = !gate || (!damaged && cmp.regressed.length === 0 && !cmp.forbiddenViolation);
  const notes = [];
  for (const m of RATCHET_METRICS) {
    const basis = cmp.edgeBasis[m];
    if (!basis || basis.comparable) continue;
    notes.push(
      m + ': ' + (basis.latestHasEdges
        ? basis.countOnlyPriors + ' prior record(s) are count-only (no edge identity)'
        : 'the latest snapshot carries no edge identity')
      + '; per-edge comparison unavailable, fell back to count comparison',
    );
  }
  return emit({
    ok,
    gate,
    records: records.length,
    corruptLines,
    ...(unreadable ? { unreadable } : {}),
    comparable: cmp.comparable,
    latestAt: latest.at || null,
    latestCommit: latest.headCommit || null,
    truncatedMixed: records.some((r) => r.truncated) !== records.every((r) => r.truncated) ? records.some((r) => r.truncated) : false,
    summary: cmp.summary,
    regressed: cmp.regressed,
    improved: cmp.improved,
    forbiddenViolation: cmp.forbiddenViolation,
    edgeBasis: cmp.edgeBasis,
    notes,
    ...(corruptReason ? { reason: corruptReason } : {}),
    note: cmp.forbiddenViolation
      ? 'forbidden dependency edges present (' + cmp.forbiddenViolation.count + '): declared boundaries are zero-tolerance and never ratchet'
        + (cmp.regressed.length ? '; drift ratchet violated as well' : '')
      : !cmp.comparable ? 'baseline established; ratchet activates from the second record'
      : cmp.regressed.length ? 'drift ratchet violated: new architectural debt exceeds the best recorded state'
      : 'no new drift beyond the best recorded state',
  }, ok ? 0 : 1);
}

// ===========================================================================
// S26 cochange
// ===========================================================================
const COCHANGE_MAX_COMMITS = 500;
const COCHANGE_MAX_FILES_PER_COMMIT = 30;
const COCHANGE_MIN_SUPPORT = 5;

function flagInt(v, fallback) {
  const n = parseInt(v, 10);
  return (!Number.isNaN(n) && n > 0) ? n : fallback;
}

function commitFileLists(maxCommits) {
  const cwd = projectRoot();
  const r = git(
    ['-c', 'core.quotePath=false', 'log', '-z', '--name-only', '--no-merges', '--format=%x01', '--max-count=' + (maxCommits + 1), 'HEAD'],
    { cwd },
  );
  if (r.status !== 0) {
    const detail = String(r.stderr || '').trim().split(/\r?\n/)[0];
    return { ok: false, detail: detail || 'git log exited ' + r.status };
  }
  const commits = [];
  let current = null;
  for (const token of r.stdout.toString('utf8').split('\0')) {
    if (token === '\x01') { current = []; commits.push(current); continue; }
    if (current === null) continue;
    const p = token.replace(/^\r?\n/, '');
    if (p) current.push(p);
  }
  return { ok: true, commits };
}

function countCoChanges(commits, catalog, maxFiles) {
  const counts = new Map();
  const touched = new Set();
  let scanned = 0;
  let skippedLarge = 0;
  for (const files of commits) {
    if (files.length > maxFiles) { skippedLarge++; continue; }
    scanned++;
    const mods = new Set();
    for (const f of files) {
      const id = moduleForPath(toPosixPath(f), catalog);
      if (id) { mods.add(id); touched.add(id); }
    }
    const ids = [...mods].sort();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = ids[i] + '\0' + ids[j];
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
  }
  return { counts, scanned, skippedLarge, modulesTouched: touched.size };
}

function cmdCoChange(flags) {
  const loaded = loadCatalogFlag(flags);
  if (!loaded.ok) {
    return emit({ ok: false, degraded: true, error: loaded.error, detail: loaded.detail }, 3);
  }
  if (!isGitRepo()) {
    return emit({ ok: false, degraded: true, error: 'non-git', detail: 'cochange reads module co-change from git history' }, 3);
  }
  const catalog = loaded.catalog;
  const maxCommits = flagInt(flags['max-commits'], COCHANGE_MAX_COMMITS);
  const maxFiles = flagInt(flags['max-files-per-commit'], COCHANGE_MAX_FILES_PER_COMMIT);
  const minSupport = flagInt(flags['min-support'], COCHANGE_MIN_SUPPORT);

  const log = commitFileLists(maxCommits);
  if (!log.ok) {
    return emit({ ok: false, degraded: true, error: 'git-log-failed', detail: log.detail }, 3);
  }
  const truncated = log.commits.length > maxCommits;
  const commits = truncated ? log.commits.slice(0, maxCommits) : log.commits;
  const { counts, scanned, skippedLarge, modulesTouched } = countCoChanges(commits, catalog, maxFiles);

  const declared = new Set();
  for (const m of (catalog.modules || [])) {
    for (const d of (m.dependsOn || [])) declared.add(m.id + '\0' + d);
  }
  const pairs = [];
  for (const [key, n] of counts) {
    if (n < minSupport) continue;
    const [a, b] = key.split('\0');
    pairs.push({ a, b, cochangeCount: n, declared: declared.has(a + '\0' + b) || declared.has(b + '\0' + a) });
  }
  pairs.sort((x, z) => (z.cochangeCount - x.cochangeCount) || (x.a + '\0' + x.b).localeCompare(z.a + '\0' + z.b));
  const undeclaredCoupling = pairs
    .filter((p) => !p.declared)
    .map((p) => ({ a: p.a, b: p.b, cochangeCount: p.cochangeCount, commitsScanned: scanned }));

  const notes = [];
  if (truncated) notes.push('history truncated at ' + maxCommits + ' commit(s) (--max-commits)');
  if (skippedLarge) notes.push(skippedLarge + ' commit(s) over ' + maxFiles + ' files were skipped as bulk changes');
  if (scanned < minSupport) notes.push('only ' + scanned + ' commit(s) scanned, below --min-support ' + minSupport);
  else if (counts.size === 0) notes.push('no commit in range touched two modules at once');

  const gate = flags.gate === true;
  const ok = !gate || undeclaredCoupling.length === 0;
  return emit({
    ok,
    gate,
    commitsScanned: scanned,
    commitsSkipped: skippedLarge,
    truncated,
    maxCommits,
    maxFilesPerCommit: maxFiles,
    minSupport,
    modulesTouched,
    pairs,
    undeclaredCoupling,
    notes,
    note: undeclaredCoupling.length
      ? undeclaredCoupling.length + ' module pair(s) change together with no dependsOn in either direction'
      : 'no undeclared coupling at or above the support threshold',
  }, ok ? 0 : 1);
}

export {
  reverseClosure, analyzeImpact, cmdImpact,
  extractImports, resolveRelativeImport, moduleForSpecifier, layerViolation, findCycles,
  expandSourceFiles, scanArch, cmdArchCheck,
  appendTrendRecord, loadTrend, cycleKey, compareRatchet, cmdArchTrend,
  COCHANGE_MAX_COMMITS, COCHANGE_MAX_FILES_PER_COMMIT, COCHANGE_MIN_SUPPORT,
  commitFileLists, countCoChanges, cmdCoChange,
};
