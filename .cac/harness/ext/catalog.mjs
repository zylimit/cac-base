// ext/catalog.mjs — S4: reading, validating and classifying against .cac/harness/module-catalog.json.
// Depends on ../lib/core.mjs only.

import fs from 'node:fs';
import {
  ATTRIBUTES, DEFAULTS, TIERS,
  catalogFilePath, emit, git, globToRegExp, isGitRepo, matchAny, normalizeTier, parseCsv,
  projectRoot, repoRelative, specificity, splitNul, toPosixPath,
} from '../lib/core.mjs';

const CATCH_ALL_GLOBS = ['', '.', '*', '**', '**/*'];

function loadCatalog(catalogPath) {
  const cp = catalogPath || catalogFilePath();
  if (!fs.existsSync(cp)) {
    return { ok: false, error: 'catalog-missing', detail: repoRelative(cp) };
  }
  let raw;
  try {
    raw = fs.readFileSync(cp, 'utf8');
  } catch (e) {
    return { ok: false, error: 'catalog-unreadable', detail: String((e && e.message) || e) };
  }
  try {
    return { ok: true, catalog: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, error: 'catalog-parse-error', detail: String((e && e.message) || e) };
  }
}

function loadCatalogFlag(flags) {
  return loadCatalog(typeof flags.catalog === 'string' ? flags.catalog : undefined);
}

function validateSchema(catalog) {
  const errors = [];
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    return { ok: false, errors: ['catalog is not an object'] };
  }
  if (catalog.version === undefined) errors.push('missing version');
  if (!Array.isArray(catalog.modules)) {
    errors.push('modules is not an array');
    return { ok: errors.length === 0, errors };
  }
  catalog.modules.forEach((m, i) => {
    if (!m || typeof m !== 'object') { errors.push('module[' + i + '] is not an object'); return; }
    if (!m.id || typeof m.id !== 'string') errors.push('module[' + i + '] missing id');
    if (!Array.isArray(m.paths)) errors.push('module[' + (m.id || i) + '] missing paths array');
  });
  return { ok: errors.length === 0, errors };
}

function classifyPath(p, catalog) {
  const norm = toPosixPath(p);
  let best = null;
  let bestScore = -1;
  for (const m of (catalog.modules || [])) {
    for (const g of (m.paths || [])) {
      if (globToRegExp(g).test(norm)) {
        const s = specificity(g);
        if (s > bestScore) { bestScore = s; best = m.id; }
      }
    }
  }
  if (best !== null) return { kind: 'module', moduleId: best };
  if (matchAny(norm, catalog.ignored)) return { kind: 'ignored' };
  if (matchAny(norm, catalog.global)) return { kind: 'global' };
  return { kind: 'unmapped' };
}

function moduleForPath(p, catalog) {
  const cls = classifyPath(p, catalog);
  return cls.kind === 'module' ? cls.moduleId : null;
}

function hasDependencyCycle(catalog) {
  const graph = new Map();
  for (const m of (catalog.modules || [])) graph.set(m.id, m.dependsOn || []);
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  for (const id of graph.keys()) color.set(id, WHITE);
  const visit = (id) => {
    color.set(id, GRAY);
    for (const dep of (graph.get(id) || [])) {
      if (!graph.has(dep)) continue;
      const c = color.get(dep);
      if (c === GRAY) return true;
      if (c === WHITE && visit(dep)) return true;
    }
    color.set(id, BLACK);
    return false;
  };
  for (const id of graph.keys()) {
    if (color.get(id) === WHITE && visit(id)) return true;
  }
  return false;
}

function lintCatalog(catalog, trackedPaths) {
  const errors = [];
  const warnings = [];

  const schema = validateSchema(catalog);
  for (const detail of schema.errors) errors.push({ code: 'SCHEMA', path: null, detail });

  const modules = Array.isArray(catalog && catalog.modules) ? catalog.modules : [];

  for (const m of modules) {
    for (const g of (m.paths || [])) {
      if (CATCH_ALL_GLOBS.includes(g)) {
        errors.push({ code: 'CATCH_ALL', path: g, detail: 'module ' + m.id + ' has catch-all path "' + g + '"' });
      }
    }
  }

  const ids = new Set(modules.map((m) => m.id));
  for (const m of modules) {
    for (const dep of (m.dependsOn || [])) {
      if (!ids.has(dep)) {
        errors.push({ code: 'DANGLING_DEP', path: null, detail: 'module ' + m.id + ' dependsOn missing id "' + dep + '"' });
      }
    }
  }

  const layerNames = Array.isArray(catalog && catalog.layers) ? catalog.layers : [];
  for (const m of modules) {
    for (const [attr, req] of Object.entries(m.attributes || {})) {
      if (!ATTRIBUTES.includes(attr)) {
        errors.push({ code: 'UNKNOWN_ATTRIBUTE', path: null, detail: 'module ' + m.id + ' declares unknown attribute "' + attr + '"' });
        continue;
      }
      const { tier, reason } = normalizeTier(req);
      if (!TIERS.includes(tier)) {
        errors.push({ code: 'UNKNOWN_TIER', path: null, detail: 'module ' + m.id + ' sets ' + attr + ' to unknown tier "' + tier + '"' });
        continue;
      }
      if ((tier === 'none' || tier === 'minimal') && !reason.trim()) {
        errors.push({ code: 'UNJUSTIFIED_TIER', path: null, detail: 'module ' + m.id + ' sets ' + attr + ' to "' + tier + '" without a reason ({"tier":"' + tier + '","reason":"..."})' });
      }
    }
    for (const f of (m.forbiddenDependencies || [])) {
      if (f === m.id) {
        errors.push({ code: 'SELF_FORBIDDEN', path: null, detail: 'module ' + m.id + ' forbids depending on itself' });
      } else if (!ids.has(f)) {
        errors.push({ code: 'DANGLING_DEP', path: null, detail: 'module ' + m.id + ' forbiddenDependencies missing id "' + f + '"' });
      }
      if ((m.dependsOn || []).includes(f)) {
        errors.push({ code: 'FORBIDDEN_DECLARED', path: null, detail: 'module ' + m.id + ' both declares and forbids dependency "' + f + '"' });
      }
    }
    if (m.layer && !layerNames.includes(m.layer)) {
      errors.push({ code: 'UNKNOWN_LAYER', path: null, detail: 'module ' + m.id + ' is in layer "' + m.layer + '" which catalog.layers does not declare' });
    }
  }

  let unmapped = 0;
  let overlaps = 0;
  for (const rawP of (trackedPaths || [])) {
    const p = toPosixPath(rawP);
    const hits = [];
    for (const m of modules) {
      if (matchAny(p, m.paths)) hits.push(m.id);
    }
    if (hits.length > 1) {
      overlaps++;
      errors.push({ code: 'OVERLAP', path: p, detail: 'path claimed by modules: ' + hits.join(', ') });
    }
    if (hits.length === 0) {
      const cls = classifyPath(p, catalog);
      if (cls.kind === 'unmapped') {
        unmapped++;
        errors.push({ code: 'UNMAPPED', path: p, detail: 'tracked path not claimed by any module/global/ignored' });
      }
    }
  }

  if (hasDependencyCycle(catalog)) {
    warnings.push({ code: 'CYCLE', path: null, detail: 'dependsOn graph contains a cycle' });
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      modules: modules.length,
      trackedPaths: (trackedPaths || []).length,
      unmapped,
      overlaps,
    },
  };
}

function trackedFiles(cap) {
  const cwd = projectRoot();
  if (!isGitRepo(cwd)) return { paths: [], truncated: false };
  const r = git(['-c', 'core.quotePath=false', 'ls-files', '-z'], { cwd });
  if (r.status !== 0) return { paths: [], truncated: false };
  const all = splitNul(r.stdout);
  const limit = (typeof cap === 'number' && cap > 0) ? cap : DEFAULTS.maxTrackedPaths;
  return { paths: all.slice(0, limit), truncated: all.length > limit };
}

function cmdCatalogLint(flags) {
  const loaded = loadCatalogFlag(flags);
  if (!loaded.ok) {
    return emit({ ok: false, degraded: true, error: loaded.error, detail: loaded.detail }, 3);
  }
  let tracked;
  let truncated = false;
  if (typeof flags.tracked === 'string') {
    tracked = parseCsv(flags.tracked);
  } else {
    const t = trackedFiles(loaded.catalog.maxTrackedPaths);
    tracked = t.paths;
    truncated = t.truncated;
  }
  const result = lintCatalog(loaded.catalog, tracked);
  if (truncated) {
    result.warnings.push({ code: 'TRUNCATED', path: null, detail: 'tracked listing hit maxTrackedPaths; coverage is incomplete' });
  }
  return emit(result, result.ok ? 0 : 1);
}

export {
  CATCH_ALL_GLOBS,
  loadCatalog, loadCatalogFlag, validateSchema, classifyPath, moduleForPath, hasDependencyCycle, lintCatalog,
  trackedFiles, cmdCatalogLint,
};
