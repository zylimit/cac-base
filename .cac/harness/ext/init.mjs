// ext/init.mjs — S25: infer a `.cac/harness/module-catalog.json` draft from tracked git paths.
// Depends on ../lib/core.mjs and ./{catalog,graph,evidence}.mjs.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  SOURCE_EXTS, catalogFilePath, emit, isGitRepo, projectRoot, repoRelative,
} from '../lib/core.mjs';
import { classifyPath, lintCatalog, moduleForPath, trackedFiles } from './catalog.mjs';
import { extractImports, resolveRelativeImport } from './graph.mjs';
import { writeAtomic } from './evidence.mjs';

const MAX_MODULES = 50;
const MIN_MODULE_FILES = 2;
const CONTAINER_MIN_CHILD_DIRS = 3;
const CONTAINER_MIN_FILES = 24;
const REFERENCE_MAX_FILES = 20000;
const REFERENCE_MAX_BYTES = 1500000;
const MAX_REPORTED_ERRORS = 20;

const CONTAINER_NAMES = new Set([
  'apps', 'cmd', 'crates', 'libs', 'modules', 'packages', 'plugins', 'services', 'src',
]);

const NON_SOURCE_DIRS = new Set([
  '.cache', '.git', '.github', '.gradle', '.idea', '.mypy_cache', '.next', '.nyc_output',
  '.pytest_cache', '.ruff_cache', '.tox', '.venv', '.vscode',
  'build', 'coverage', 'dist', 'doc', 'docs', 'documentation', 'fixtures', 'htmlcov',
  'node_modules', 'out', 'target', 'testdata', 'third_party', 'vendor', '__pycache__',
]);

const GLOBAL_FILE_PATTERNS = [
  /^package(-lock)?\.json$/, /^yarn\.lock$/, /^pnpm-lock\.yaml$/, /^[jt]sconfig.*\.json$/,
  /^go\.(mod|sum)$/, /^Cargo\.(toml|lock)$/, /^pyproject\.toml$/, /^setup\.(py|cfg)$/,
  /^requirements.*\.txt$/, /^Gemfile(\.lock)?$/, /^composer\.(json|lock)$/, /^pom\.xml$/,
  /^(build|settings)\.gradle(\.kts)?$/, /^Makefile$/, /^CMakeLists\.txt$/, /^Dockerfile$/,
  /^\.gitignore$/, /^\.editorconfig$/,
];

const AUTHORED_EXTS = new Set([
  ...SOURCE_EXTS,
  '.sh', '.bash', '.zsh', '.ps1', '.psm1', '.bat', '.cmd', '.sql', '.vue', '.svelte',
]);

const DRAFT_NOTE = 'drafted by harness.mjs init from the tracked file tree; riskTier is a '
  + 'placeholder, attributes / dependsOn / layer / forbiddenDependencies are decisions a '
  + 'human still owes this file';

function moduleIdFor(dir) {
  const id = String(dir)
    .replace(/\//g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[.\-]+/, '')
    .replace(/[.\-]+$/, '');
  return id || 'module';
}

function extensionOf(p) {
  const base = p.slice(p.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

function looseFileKind(p) {
  const base = p.slice(p.lastIndexOf('/') + 1);
  if (GLOBAL_FILE_PATTERNS.some((r) => r.test(base))) return 'global';
  return AUTHORED_EXTS.has(extensionOf(p)) ? 'global' : 'ignored';
}

function groupByTopDir(paths) {
  const dirs = new Map();
  const loose = [];
  for (const p of paths) {
    const slash = p.indexOf('/');
    if (slash <= 0) { loose.push(p); continue; }
    const head = p.slice(0, slash);
    const bucket = dirs.get(head);
    if (bucket) bucket.push(p);
    else dirs.set(head, [p]);
  }
  return { dirs, loose };
}

function childDirsOf(dir, paths) {
  const kids = new Set();
  const prefix = dir + '/';
  for (const p of paths) {
    const rest = p.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash > 0) kids.add(rest.slice(0, slash));
  }
  return kids;
}

function planModules(trackedPaths, { expand = true } = {}) {
  const sorted = [...(trackedPaths || [])].sort();
  const { dirs, loose } = groupByTopDir(sorted);

  const candidates = [];
  const looseFiles = [...loose];
  for (const dir of [...dirs.keys()].sort()) {
    const owned = dirs.get(dir);
    const name = dir;
    if (NON_SOURCE_DIRS.has(name)) { candidates.push({ dir, paths: owned }); continue; }
    const kids = childDirsOf(dir, owned);
    const isContainer = expand && (CONTAINER_NAMES.has(name)
      ? kids.size >= 2
      : (kids.size >= CONTAINER_MIN_CHILD_DIRS && owned.length > CONTAINER_MIN_FILES));
    if (!isContainer) { candidates.push({ dir, paths: owned }); continue; }
    const prefix = dir + '/';
    const byKid = new Map();
    for (const p of owned) {
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash <= 0) { looseFiles.push(p); continue; }
      const kid = prefix + rest.slice(0, slash);
      const bucket = byKid.get(kid);
      if (bucket) bucket.push(p);
      else byKid.set(kid, [p]);
    }
    for (const kid of [...byKid.keys()].sort()) candidates.push({ dir: kid, paths: byKid.get(kid) });
  }

  const modules = [];
  const ignored = [];
  const globals = [];
  const usedIds = new Map();
  for (const c of candidates) {
    const name = c.dir.slice(c.dir.lastIndexOf('/') + 1);
    if (NON_SOURCE_DIRS.has(name)) {
      ignored.push({ glob: c.dir + '/**', reason: 'non-source-directory', files: c.paths.length });
      continue;
    }
    if (c.paths.length < MIN_MODULE_FILES) {
      ignored.push({ glob: c.dir + '/**', reason: 'single-file-directory', files: c.paths.length });
      continue;
    }
    let id = moduleIdFor(c.dir);
    if (usedIds.has(id)) {
      const n = usedIds.get(id) + 1;
      usedIds.set(id, n);
      id = id + '-' + n;
    } else usedIds.set(id, 1);
    modules.push({ id, dir: c.dir, glob: c.dir + '/**', files: c.paths.length });
  }

  for (const p of looseFiles.sort()) {
    if (looseFileKind(p) === 'global') globals.push(p);
    else ignored.push({ glob: p, reason: 'loose-document', files: 1 });
  }

  const sourceIgnored = countSourceUnder(sorted, ignored);
  return {
    modules,
    globals: globals.sort(),
    ignored: ignored.sort((a, b) => (a.glob < b.glob ? -1 : a.glob > b.glob ? 1 : 0)),
    sourceIgnored,
    granularity: expand ? 'fine' : 'coarse',
  };
}

function countSourceUnder(sortedPaths, ignored) {
  const globs = ignored.map((i) => i.glob);
  if (!globs.length) return 0;
  const dirs = globs.filter((g) => g.endsWith('/**')).map((g) => g.slice(0, -2));
  const files = new Set(globs.filter((g) => !g.endsWith('/**')));
  let n = 0;
  for (const p of sortedPaths) {
    if (!AUTHORED_EXTS.has(extensionOf(p))) continue;
    if (files.has(p) || dirs.some((d) => p.startsWith(d))) n++;
  }
  return n;
}

function draftCatalog(plan) {
  return {
    version: 1,
    _generated: { by: 'harness.mjs init', reviewed: false, note: DRAFT_NOTE },
    modules: plan.modules.map((m) => ({ id: m.id, paths: [m.glob], riskTier: 'low' })),
    global: [...plan.globals],
    ignored: plan.ignored.map((i) => i.glob),
  };
}

function closeCoverage(draft, trackedPaths) {
  const rescued = [];
  for (const p of trackedPaths) {
    if (classifyPath(p, draft).kind === 'unmapped') rescued.push(p);
  }
  if (rescued.length) draft.ignored = [...new Set([...draft.ignored, ...rescued])].sort();
  return rescued.length;
}

function referenceEdges(root, catalog, trackedPaths, maxFiles = REFERENCE_MAX_FILES) {
  const edges = new Map();
  let scanned = 0;
  let unresolved = 0;
  let truncated = false;
  for (const rel of trackedPaths) {
    if (scanned >= maxFiles) { truncated = true; break; }
    if (!SOURCE_EXTS.has(extensionOf(rel))) continue;
    const owner = moduleForPath(rel, catalog);
    if (!owner) continue;
    let content;
    try {
      const st = fs.statSync(path.join(root, rel));
      if (!st.isFile() || st.size > REFERENCE_MAX_BYTES) continue;
      content = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch (_e) { continue; }
    scanned++;
    for (const spec of extractImports(rel, content)) {
      if (!spec.startsWith('.')) { unresolved++; continue; }
      const resolved = resolveRelativeImport(root, rel, spec);
      if (!resolved) { unresolved++; continue; }
      const target = moduleForPath(resolved, catalog);
      if (!target || target === owner) continue;
      const key = owner + '->' + target;
      const entry = edges.get(key) || { from: owner, to: target, evidence: [] };
      if (entry.evidence.length < 3) entry.evidence.push(rel + ': ' + spec);
      edges.set(key, entry);
    }
  }
  const list = [...edges.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map((e) => e[1]);
  return { edges: list, scanned, unresolved, truncated };
}

function positiveInt(v, fallback) {
  const n = parseInt(v, 10);
  return (!Number.isNaN(n) && n > 0) ? n : fallback;
}

function writeInitSummary(report, plan) {
  process.stderr.write('init: ' + report.modules + ' module(s), ' + report.globalPaths
    + ' global path(s), ' + report.ignoredPaths + ' ignored path(s), from '
    + report.trackedPaths + ' tracked path(s) [' + report.granularity + ']\n');
  for (const m of plan.modules) {
    process.stderr.write('  module ' + m.id + '  ' + m.glob + '  ' + m.files + ' file(s)\n');
  }
  for (const e of report.referenceEdges) {
    process.stderr.write('  edge ' + e.from + ' -> ' + e.to + '  ' + (e.evidence[0] || '') + '\n');
  }
}

function cmdInit(flags = {}) {
  if (!isGitRepo()) {
    const detail = 'init reads the tracked file list through git ls-files';
    process.stderr.write('init: not a git repository; ' + detail + '\n');
    return emit({ ok: false, degraded: true, error: 'non-git', detail }, 3);
  }
  const t = trackedFiles();
  if (!t.paths.length) {
    const detail = 'git ls-files returned nothing; there is no tree to infer a catalog from';
    process.stderr.write('init: ' + detail + '\n');
    return emit({ ok: false, degraded: true, error: 'no-tracked-paths', detail }, 3);
  }
  if (t.truncated) {
    const detail = 'tracked listing hit the maxTrackedPaths cap; a draft over part of the tree would leave the rest unmapped';
    process.stderr.write('init: ' + detail + '\n');
    return emit({ ok: false, degraded: true, error: 'tracked-truncated', detail, trackedPaths: t.paths.length }, 3);
  }

  const maxModules = positiveInt(flags['max-modules'], MAX_MODULES);
  let plan = planModules(t.paths, { expand: true });
  if (plan.modules.length > maxModules) plan = planModules(t.paths, { expand: false });
  const overBudget = plan.modules.length > maxModules;

  const draft = draftCatalog(plan);
  const rescued = closeCoverage(draft, t.paths);
  const lint = lintCatalog(draft, t.paths);
  const refs = referenceEdges(projectRoot(), draft, t.paths);

  const target = typeof flags.catalog === 'string' ? flags.catalog : catalogFilePath();
  const rel = repoRelative(target);
  const exists = fs.existsSync(target);
  const wantApply = Boolean(flags.apply);

  const report = {
    ok: lint.ok,
    applied: false,
    path: rel,
    catalogPresent: exists,
    trackedPaths: t.paths.length,
    granularity: plan.granularity,
    maxModules,
    overBudget,
    modules: plan.modules.length,
    globalPaths: draft.global.length,
    ignoredPaths: draft.ignored.length,
    sourceIgnored: plan.sourceIgnored,
    rescued,
    referenceEdges: refs.edges,
    referenceScan: { scanned: refs.scanned, unresolved: refs.unresolved, truncated: refs.truncated },
    lint: {
      ok: lint.ok,
      errors: lint.errors.slice(0, MAX_REPORTED_ERRORS),
      errorsOmitted: Math.max(0, lint.errors.length - MAX_REPORTED_ERRORS),
      warnings: lint.warnings,
      stats: lint.stats,
    },
    draft,
    note: '',
  };

  writeInitSummary(report, plan);

  if (!lint.ok) {
    report.ok = false;
    report.error = 'draft-not-lint-clean';
    report.note = 'the inference left ' + lint.errors.length + ' catalog-lint error(s); nothing was written';
    return emit(report, 1);
  }

  if (wantApply && exists) {
    process.stderr.write('init: ' + rel + ' already exists and is not overwritten\n');
    report.error = 'catalog-exists';
    report.note = rel + ' already exists; the draft was printed but nothing was written';
    return emit(report, 1);
  }

  if (wantApply) {
    try {
      writeAtomic(path.resolve(projectRoot(), target), JSON.stringify(draft, null, 2) + '\n');
    } catch (e) {
      const detail = String((e && e.message) || e);
      report.ok = false;
      report.error = 'write-failed';
      report.note = detail;
      return emit(report, 1);
    }
    report.applied = true;
    report.note = 'wrote ' + rel + '; review riskTier, attributes and dependsOn before trusting gates that read them';
    return emit(report, 0);
  }

  report.note = 'dry run; rerun with --apply to write ' + rel;
  return emit(report, 0);
}

export {
  CONTAINER_NAMES, GLOBAL_FILE_PATTERNS, MAX_MODULES, NON_SOURCE_DIRS,
  closeCoverage, countSourceUnder, draftCatalog, extensionOf, looseFileKind, moduleIdFor,
  planModules, referenceEdges, cmdInit,
};
