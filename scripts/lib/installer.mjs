// scripts/lib/installer.mjs — Transactional cross-platform installer, lossless 3-way upgrader, and uninstaller.
// Implements: per-segment path guard -> dry-run planner -> atomic wx lock (with dead-pid takeover) ->
// active/interrupted marker (with CAC_SETUP_FAIL_AFTER=N fault injection) -> 3-way LF-SHA256 merge ->
// pure-Node settings.json merge -> optional manifest merge -> clean teardown.
// Zero npm dependencies (Node >= 20 built-ins only).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toPosix, validateTargetPath } from './path-guard.mjs';
import {
  MANIFEST_REL_PATH,
  OPTIONAL_MANIFEST_REL_PATH,
  NEVER_INSTALL_ROOT,
  buildCoreManifest,
  hashLfBuffer,
  hashLfFile,
  isOptionalExcluded,
  walkRegularFiles,
} from './manifest.mjs';
import {
  formatSettingsJson,
  mergeSettings,
  stripFrameworkHooks,
  stripFrameworkPermissions,
} from './settings-merge.mjs';

const INSTALLER_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FRAMEWORK_ROOT = path.resolve(INSTALLER_DIR, '..', '..');

function loadFrameworkDefaultPermissions(srcRoot = DEFAULT_FRAMEWORK_ROOT) {
  const srcSettingsPath = path.join(srcRoot, '.cac', 'settings.json');
  if (!fs.existsSync(srcSettingsPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(srcSettingsPath, 'utf8'));
    return parsed && typeof parsed.permissions === 'object' ? parsed.permissions : null;
  } catch {
    return null;
  }
}

const DEFAULT_FEEDBACK_INDEX_TEMPLATE = [
  '# FEEDBACK-INDEX — 项目 AI 行为修正索引',
  '',
  '> 由 `feedback-observer` 维护，`evolution-runner` 定期扫描聚类。安装器升级绝不覆盖本文件。',
  '',
].join('\n');

const DEFAULT_EVOLUTION_TEMPLATE = [
  '# EVOLUTION.md — 反馈聚类与规则进化记录',
  '',
  '> 记录经 `evolution-engine` 聚类毕业并沉淀到规则或技能的演进历史。',
  '',
].join('\n');

/**
 * Check if a process PID is currently alive.
 * Note: EPERM means the process exists under another user/privilege boundary -> alive!
 * @param {number} pid
 * @returns {boolean}
 */
export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    if (e && e.code === 'EPERM') return true;
    return false;
  }
}

/**
 * `fs.lstatSync` wrapper returning `null` when path or intermediate dir does not exist (`ENOENT` / `ENOTDIR`).
 * Never follows leaf symlinks and sees dangling symlinks cleanly.
 * @param {string} targetPath
 * @returns {fs.Stats | null}
 */
function safeLstat(targetPath) {
  try {
    return fs.lstatSync(targetPath);
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null;
    throw e;
  }
}

/**
 * Safely remove ONLY a symlink or Windows directory Junction itself, NEVER recursing into target directories
 * and NEVER deleting physical directories or regular files.
 * @param {string} linkPath
 * @returns {boolean} `true` if a symlink/junction was unlinked, `false` if already absent (`ENOENT`/`ENOTDIR`).
 */
export function unlinkSymlinkOrJunctionSafe(linkPath) {
  const st = safeLstat(linkPath);
  if (!st) return false;
  if (!st.isSymbolicLink()) {
    throw new Error(`拒绝拆除非符号链接路径（保护物理目录与文件）：${linkPath}`);
  }
  if (process.platform === 'win32') {
    try {
      fs.rmdirSync(linkPath);
      return true;
    } catch {
      fs.unlinkSync(linkPath);
      return true;
    }
  }
  fs.unlinkSync(linkPath);
  return true;
}

/**
 * Check whether a `.cac` relative path equals or sits underneath any directory prefix in `unlinkedDirs`.
 * @param {string} relPath
 * @param {string[]} unlinkedDirs
 * @returns {boolean}
 */
function isUnderUnlinkedDir(relPath, unlinkedDirs) {
  const norm = toPosix(relPath);
  for (const d of unlinkedDirs) {
    if (norm === d || norm.startsWith(`${d}/`)) return true;
  }
  return false;
}

/**
 * Add `.cac` and every ancestor directory segment inside `.cac/...` of `relPath` into `outSet`.
 * @param {string} relPath
 * @param {Set<string>} outSet
 */
function collectCacAncestors(relPath, outSet) {
  const norm = toPosix(relPath).replace(/\/+$/, '');
  if (norm === '.cac') {
    outSet.add('.cac');
    return;
  }
  if (!norm.startsWith('.cac/')) return;
  const segs = norm.split('/');
  if (segs.some((s) => !s || s === '.' || s === '..')) return;
  let acc = segs[0];
  outSet.add(acc);
  for (let i = 1; i < segs.length - 1; i++) {
    acc = `${acc}/${segs[i]}`;
    outSet.add(acc);
  }
}

/**
 * Add `.cac` and every directory segment (including `dirRel` itself) inside `.cac/...` into `outSet`.
 * @param {string} dirRel
 * @param {Set<string>} outSet
 */
function collectCacDirAndAncestors(dirRel, outSet) {
  const norm = toPosix(dirRel).replace(/\/+$/, '');
  if (norm === '.cac') {
    outSet.add('.cac');
    return;
  }
  if (!norm.startsWith('.cac/')) return;
  const segs = norm.split('/');
  if (segs.some((s) => !s || s === '.' || s === '..')) return;
  let acc = segs[0];
  outSet.add(acc);
  for (let i = 1; i < segs.length; i++) {
    acc = `${acc}/${segs[i]}`;
    outSet.add(acc);
  }
}

/**
 * Discover symlinked/junction directories under `<target>/.cac` in shallow-to-deep order without traversing through parent symlinks.
 * @param {string} targetDir
 * @param {Iterable<string>} candidateDirs
 * @returns {string[]}
 */
function scanUnlinkedDirs(targetDir, candidateDirs) {
  const sorted = [...new Set(candidateDirs)].sort((a, b) => {
    const da = a.split('/').length;
    const db = b.split('/').length;
    if (da !== db) return da - db;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const unlinked = [];
  for (const relDir of sorted) {
    if (isUnderUnlinkedDir(relDir, unlinked)) continue;
    const st = safeLstat(path.join(targetDir, relDir));
    if (st && st.isSymbolicLink()) {
      unlinked.push(relDir);
    }
  }
  return unlinked;
}

/**
 * Read a manifest file (`files`, `seeded`, and optional `links`) into lookup structures, or empty structures if absent/corrupt/symlink.
 * @param {string} manifestPath
 * @returns {{
 *   filesMap: Map<string, {path:string,sha256:string,bytes:number}>,
 *   seededMap: Map<string, {path:string,sha256:string,bytes:number}>,
 *   links: string[]
 * }}
 */
function readManifestMaps(manifestPath) {
  const filesMap = new Map();
  const seededMap = new Map();
  const links = [];
  let engine = null;
  const mst = safeLstat(manifestPath);
  if (!mst || mst.isSymbolicLink() || !mst.isFile()) return { filesMap, seededMap, links, engine };
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (raw && raw.engine !== undefined && raw.engine !== null && String(raw.engine).trim() !== '') {
      engine = String(raw.engine).trim();
    }
    if (raw && Array.isArray(raw.files)) {
      for (const f of raw.files) {
        if (f && typeof f.path === 'string' && typeof f.sha256 === 'string') {
          filesMap.set(toPosix(f.path), f);
        }
      }
    }
    if (raw && Array.isArray(raw.seeded)) {
      for (const s of raw.seeded) {
        if (s && typeof s.path === 'string' && typeof s.sha256 === 'string') {
          seededMap.set(toPosix(s.path), s);
        }
      }
    }
    if (raw && Array.isArray(raw.links)) {
      for (const lk of raw.links) {
        const rawRel =
          typeof lk === 'string'
            ? lk
            : lk && typeof lk === 'object'
              ? (typeof lk.path === 'string' ? lk.path : typeof lk.link === 'string' ? lk.link : '')
              : '';
        if (!rawRel) continue;
        const norm = toPosix(rawRel).replace(/\/+$/, '');
        const segs = norm.split('/');
        if ((norm === '.cac' || norm.startsWith('.cac/')) && segs.every((s) => s && s !== '.' && s !== '..')) {
          links.push(norm);
        }
      }
    }
  } catch {
    // Unreadable old manifest falls back to conservative conflict protection (never silent overwrite).
  }
  return { filesMap, seededMap, links, engine };
}

/**
 * Decide 3-way action (`create` | `skip` | `update` | `conflict`) for one leaf file pair.
 * Inspects leaf via `lstatSync` first so dangling symlinks resolve to `create` and live file symlinks
 * resolve to `update` / `conflict` (never `skip` and never traversed on write).
 * @param {string} srcSha
 * @param {string} dstFullPath
 * @param {string | undefined} oldSha
 * @param {boolean} force
 * @returns {'create' | 'skip' | 'update' | 'conflict'}
 */
function decideThreeWay(srcSha, dstFullPath, oldSha, force) {
  const lst = safeLstat(dstFullPath);
  if (!lst) return 'create';
  if (lst.isSymbolicLink()) {
    let targetStat = null;
    try {
      targetStat = fs.statSync(dstFullPath);
    } catch {
      targetStat = null;
    }
    if (!targetStat) return 'create';
    return force || Boolean(oldSha) ? 'update' : 'conflict';
  }
  if (lst.isDirectory()) {
    return force ? 'update' : 'conflict';
  }
  if (!lst.isFile()) {
    return force ? 'update' : 'conflict';
  }
  let dstSha;
  try {
    dstSha = hashLfFile(dstFullPath).sha256;
  } catch {
    return force ? 'update' : 'conflict';
  }
  if (dstSha === srcSha) return 'skip';
  if (force || (oldSha && dstSha === oldSha)) return 'update';
  return 'conflict';
}

/**
 * Collect optional package items (`--with-tests` and/or `--with-harness`) from `srcRoot`.
 * @param {string} srcRoot
 * @param {{ withTests?: boolean, withHarness?: boolean }} opts
 * @returns {{ items: Array<{ relPath: string, srcFull: string, sha256: string, bytes: number }>, testCount: number, harnessCount: number }}
 */
function collectOptionalItems(srcRoot, { withTests = false, withHarness = false } = {}) {
  const items = [];
  let testCount = 0;
  let harnessCount = 0;
  const srcCac = path.join(srcRoot, '.cac');

  if (withTests) {
    const testsDir = path.join(srcCac, 'tests');
    if (fs.existsSync(testsDir)) {
      for (const relInCac of walkRegularFiles(testsDir, srcCac)) {
        if (isOptionalExcluded(relInCac)) continue;
        const srcFull = path.join(srcCac, relInCac);
        const { sha256, bytes } = hashLfFile(srcFull);
        items.push({ relPath: `.cac/${relInCac}`, srcFull, sha256, bytes });
        testCount++;
      }
    }
  }

  if (withHarness) {
    const extDir = path.join(srcCac, 'harness', 'ext');
    if (fs.existsSync(extDir)) {
      for (const relInCac of walkRegularFiles(extDir, srcCac)) {
        if (isOptionalExcluded(relInCac)) continue;
        const srcFull = path.join(srcCac, relInCac);
        const { sha256, bytes } = hashLfFile(srcFull);
        items.push({ relPath: `.cac/${relInCac}`, srcFull, sha256, bytes });
        harnessCount++;

        // Top-level .cac/harness/ext/rules/*.md also installs into .cac/rules/*.md (nested subdirs are NOT flattened).
        if (relInCac.startsWith('harness/ext/rules/') && relInCac.endsWith('.md')) {
          const tail = relInCac.slice('harness/ext/rules/'.length);
          if (tail && !tail.includes('/')) {
            items.push({ relPath: `.cac/rules/${tail}`, srcFull, sha256, bytes });
          }
        }
      }
    }
  }

  items.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return { items, testCount, harnessCount };
}

/**
 * Compute full installation/upgrade plan with ZERO filesystem writes.
 * @param {string} srcRoot
 * @param {string} targetDir
 * @param {{
 *   withTests?: boolean,
 *   withHarness?: boolean,
 *   force?: boolean,
 *   hookForm?: '' | 'string' | 'exec'
 * }} [opts]
 */
export function planInstall(srcRoot, targetDir, opts = {}) {
  const valid = validateTargetPath(targetDir);
  if (!valid.ok) {
    return { ok: false, code: 2, error: valid.message };
  }
  const srcCac = path.join(srcRoot, '.cac');
  if (!fs.existsSync(srcCac) || !fs.statSync(srcCac).isDirectory()) {
    return { ok: false, code: 2, error: `源框架目录缺失 .cac：${srcCac}` };
  }

  const force = Boolean(opts.force);
  const withTests = Boolean(opts.withTests);
  const withHarness = Boolean(opts.withHarness);
  const hookForm = opts.hookForm || '';

  // Source manifest: prefer on-disk .cac/FRAMEWORK-MANIFEST.json if present, else compute live.
  const srcManifestFile = path.join(srcRoot, MANIFEST_REL_PATH);
  let coreManifest = null;
  if (fs.existsSync(srcManifestFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(srcManifestFile, 'utf8'));
      if (parsed && parsed.version === 1 && Array.isArray(parsed.files)) {
        coreManifest = parsed;
      }
    } catch {
      coreManifest = null;
    }
  }
  if (!coreManifest) {
    coreManifest = buildCoreManifest(srcRoot);
  }

  // Validate optional package availability upfront so candidate directory scan sees every planned path.
  const { items: optionalItems, testCount, harnessCount } = collectOptionalItems(srcRoot, { withTests, withHarness });
  if (withTests && testCount === 0) {
    return {
      ok: false,
      code: 2,
      error: `启用了 --with-tests，但源目录缺失可选测试包文件（${path.join(srcCac, 'tests')} 为空或不存在）`,
    };
  }
  if (withHarness && harnessCount === 0) {
    return {
      ok: false,
      code: 2,
      error: `启用了 --with-harness，但源目录缺失大仓治理扩展包文件（${path.join(srcCac, 'harness', 'ext')} 为空或不存在）`,
    };
  }

  // Never traverse into <target>/.cac if .cac itself is a symlink/junction.
  const dstCacSt = safeLstat(path.join(targetDir, '.cac'));
  const dstCacIsSymlink = Boolean(dstCacSt && dstCacSt.isSymbolicLink());

  const emptyMaps = { filesMap: new Map(), seededMap: new Map(), links: [] };
  const { filesMap: oldCoreMap, seededMap: oldSeedMap, links: oldCoreLinks } = dstCacIsSymlink
    ? emptyMaps
    : readManifestMaps(path.join(targetDir, MANIFEST_REL_PATH));
  const { filesMap: oldOptMap, links: oldOptLinks } = dstCacIsSymlink
    ? emptyMaps
    : readManifestMaps(path.join(targetDir, OPTIONAL_MANIFEST_REL_PATH));

  // Collect .cac itself, all planned/previous ancestor segments inside .cac, and optional manifest `links` dirs.
  const candidateDirs = new Set(['.cac']);
  for (const item of coreManifest.files) {
    collectCacAncestors(item.path, candidateDirs);
  }
  for (const opt of optionalItems) {
    collectCacAncestors(opt.relPath, candidateDirs);
  }
  for (const oldRel of oldCoreMap.keys()) {
    collectCacAncestors(oldRel, candidateDirs);
  }
  for (const oldOptRel of oldOptMap.keys()) {
    collectCacAncestors(oldOptRel, candidateDirs);
  }
  collectCacAncestors('.cac/settings.json', candidateDirs);
  collectCacAncestors('.cac/feedback/FEEDBACK-INDEX.md', candidateDirs);
  collectCacAncestors('.cac/EVOLUTION.md', candidateDirs);
  collectCacAncestors(MANIFEST_REL_PATH, candidateDirs);
  if (optionalItems.length > 0) {
    collectCacAncestors(OPTIONAL_MANIFEST_REL_PATH, candidateDirs);
  }
  for (const lk of [...oldCoreLinks, ...oldOptLinks]) {
    collectCacDirAndAncestors(lk, candidateDirs);
  }

  const unlinkedDirs = scanUnlinkedDirs(targetDir, candidateDirs);

  const ops = [];

  // 1. Optional seeded root files (empty by default; cac-base constitution lives in .cac/rules/AGENTS.md)
  for (const seed of coreManifest.seeded || []) {
    if (NEVER_INSTALL_ROOT.has(seed.path)) continue;
    const srcFull = path.join(srcRoot, seed.path);
    if (!fs.existsSync(srcFull)) continue;
    const dstFull = path.join(targetDir, seed.path);
    const oldEntry = oldSeedMap.get(seed.path);
    const action = decideThreeWay(seed.sha256, dstFull, oldEntry?.sha256, force);
    ops.push({
      action,
      kind: 'seeded',
      relPath: seed.path,
      srcFull,
      sha256: seed.sha256,
      bytes: seed.bytes,
    });
  }

  // 2. Managed .cac/* files
  for (const item of coreManifest.files) {
    const rel = toPosix(item.path);
    if (!rel.startsWith('.cac/') || NEVER_INSTALL_ROOT.has(rel)) continue;
    const srcFull = path.join(srcRoot, rel);
    if (!fs.existsSync(srcFull)) continue;
    const dstFull = path.join(targetDir, rel);
    const oldEntry = oldCoreMap.get(rel);
    const action = isUnderUnlinkedDir(rel, unlinkedDirs)
      ? 'create'
      : decideThreeWay(item.sha256, dstFull, oldEntry?.sha256, force);
    ops.push({
      action,
      kind: 'managed',
      relPath: rel,
      srcFull,
      sha256: item.sha256,
      bytes: item.bytes,
    });
  }

  // 3. Optional packages (--with-tests / --with-harness)
  for (const opt of optionalItems) {
    const dstFull = path.join(targetDir, opt.relPath);
    const oldEntry = oldOptMap.get(opt.relPath);
    const action = isUnderUnlinkedDir(opt.relPath, unlinkedDirs)
      ? 'create'
      : decideThreeWay(opt.sha256, dstFull, oldEntry?.sha256, force);
    ops.push({
      action,
      kind: 'optional',
      relPath: opt.relPath,
      srcFull: opt.srcFull,
      sha256: opt.sha256,
      bytes: opt.bytes,
    });
  }

  // 4. .cac/settings.json smart merge plan
  const srcSettingsPath = path.join(srcRoot, '.cac', 'settings.json');
  const dstSettingsPath = path.join(targetDir, '.cac', 'settings.json');
  let settingsPlan = null;
  if (fs.existsSync(srcSettingsPath)) {
    const srcSettingsObj = JSON.parse(fs.readFileSync(srcSettingsPath, 'utf8'));
    const dstSettingsSt = isUnderUnlinkedDir('.cac/settings.json', unlinkedDirs)
      ? null
      : safeLstat(dstSettingsPath);

    if (!dstSettingsSt) {
      const merged = mergeSettings(null, srcSettingsObj, { hookForm });
      const content = formatSettingsJson(merged.settings);
      settingsPlan = { action: 'create', content, resolvedForm: merged.resolvedForm };
      ops.push({ action: 'create', kind: 'settings', relPath: '.cac/settings.json' });
    } else if (dstSettingsSt.isSymbolicLink()) {
      let liveTarget = false;
      try {
        liveTarget = Boolean(fs.statSync(dstSettingsPath));
      } catch {
        liveTarget = false;
      }
      const fresh = mergeSettings(null, srcSettingsObj, { hookForm });
      const content = formatSettingsJson(fresh.settings);
      const action = !liveTarget ? 'create' : force ? 'update' : 'conflict';
      settingsPlan = { action, content, resolvedForm: fresh.resolvedForm };
      ops.push({ action, kind: 'settings', relPath: '.cac/settings.json' });
    } else if (!dstSettingsSt.isFile()) {
      const fresh = mergeSettings(null, srcSettingsObj, { hookForm });
      const content = formatSettingsJson(fresh.settings);
      const action = force ? 'update' : 'conflict';
      settingsPlan = { action, content, resolvedForm: fresh.resolvedForm };
      ops.push({ action, kind: 'settings', relPath: '.cac/settings.json' });
    } else {
      let dstSettingsObj = null;
      let parseFailed = false;
      try {
        dstSettingsObj = JSON.parse(fs.readFileSync(dstSettingsPath, 'utf8'));
      } catch {
        parseFailed = true;
      }
      if (parseFailed && !force) {
        const fresh = mergeSettings(null, srcSettingsObj, { hookForm });
        settingsPlan = {
          action: 'conflict',
          content: formatSettingsJson(fresh.settings),
          resolvedForm: fresh.resolvedForm,
        };
        ops.push({ action: 'conflict', kind: 'settings', relPath: '.cac/settings.json' });
      } else {
        const merged = mergeSettings(parseFailed ? null : dstSettingsObj, srcSettingsObj, { hookForm });
        const content = formatSettingsJson(merged.settings);
        const same = !parseFailed && hashLfBuffer(content).sha256 === hashLfFile(dstSettingsPath).sha256;
        const action = same ? 'skip' : 'update';
        settingsPlan = { action, content, resolvedForm: merged.resolvedForm };
        ops.push({ action, kind: 'settings', relPath: '.cac/settings.json' });
      }
    }
  }

  // 5. .cac/feedback/FEEDBACK-INDEX.md (only created if missing or dangling symlink; never overwritten on upgrade)
  const dstFbIndex = path.join(targetDir, '.cac', 'feedback', 'FEEDBACK-INDEX.md');
  const srcFbTpl = path.join(srcRoot, '.cac', 'feedback', 'templates', 'feedback-index-template.md');
  const fbIndexContent = fs.existsSync(srcFbTpl)
    ? fs.readFileSync(srcFbTpl, 'utf8')
    : DEFAULT_FEEDBACK_INDEX_TEMPLATE;
  const fbAction =
    isUnderUnlinkedDir('.cac/feedback/FEEDBACK-INDEX.md', unlinkedDirs) || !fs.existsSync(dstFbIndex)
      ? 'create'
      : 'skip';
  ops.push({ action: fbAction, kind: 'seeded-once', relPath: '.cac/feedback/FEEDBACK-INDEX.md', content: fbIndexContent });

  // 6. .cac/EVOLUTION.md (clean template only if missing or dangling symlink; never copies framework's own history)
  const dstEvolution = path.join(targetDir, '.cac', 'EVOLUTION.md');
  const evoAction =
    isUnderUnlinkedDir('.cac/EVOLUTION.md', unlinkedDirs) || !fs.existsSync(dstEvolution)
      ? 'create'
      : 'skip';
  ops.push({ action: evoAction, kind: 'seeded-once', relPath: '.cac/EVOLUTION.md', content: DEFAULT_EVOLUTION_TEMPLATE });

  // 7. .cac/FRAMEWORK-MANIFEST.json
  const manifestText = fs.existsSync(srcManifestFile)
    ? fs.readFileSync(srcManifestFile, 'utf8')
    : JSON.stringify(coreManifest, null, 2) + '\n';
  const dstManifestPath = path.join(targetDir, MANIFEST_REL_PATH);
  let manifestAction = 'create';
  if (!isUnderUnlinkedDir(MANIFEST_REL_PATH, unlinkedDirs)) {
    const mst = safeLstat(dstManifestPath);
    if (mst) {
      if (mst.isSymbolicLink()) {
        manifestAction = fs.existsSync(dstManifestPath) ? 'update' : 'create';
      } else if (mst.isFile()) {
        manifestAction = hashLfBuffer(manifestText).sha256 === hashLfFile(dstManifestPath).sha256 ? 'skip' : 'update';
      } else {
        manifestAction = 'update';
      }
    }
  }
  ops.push({ action: manifestAction, kind: 'manifest', relPath: MANIFEST_REL_PATH, content: manifestText });

  // 8. .cac/FRAMEWORK-MANIFEST-OPTIONAL.json (only when optional switches are active)
  let optionalManifestText = null;
  if (optionalItems.length > 0) {
    const mergedOptMap = new Map(oldOptMap);
    for (const opt of optionalItems) {
      mergedOptMap.set(opt.relPath, { path: opt.relPath, sha256: opt.sha256, bytes: opt.bytes });
    }
    const mergedOptFiles = [...mergedOptMap.values()].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    optionalManifestText = JSON.stringify(
      { version: 1, engine: 'cac-base', optional: true, files: mergedOptFiles },
      null,
      2,
    ) + '\n';
    const dstOptPath = path.join(targetDir, OPTIONAL_MANIFEST_REL_PATH);
    let optAction = 'create';
    if (!isUnderUnlinkedDir(OPTIONAL_MANIFEST_REL_PATH, unlinkedDirs)) {
      const ost = safeLstat(dstOptPath);
      if (ost) {
        if (ost.isSymbolicLink()) {
          optAction = fs.existsSync(dstOptPath) ? 'update' : 'create';
        } else if (ost.isFile()) {
          optAction = hashLfBuffer(optionalManifestText).sha256 === hashLfFile(dstOptPath).sha256 ? 'skip' : 'update';
        } else {
          optAction = 'update';
        }
      }
    }
    ops.push({ action: optAction, kind: 'manifest-optional', relPath: OPTIONAL_MANIFEST_REL_PATH, content: optionalManifestText });
  }

  // 9. Retired managed files cleanup plan (e.g. cc-bridge.mjs / root.mjs / ps-floor.mjs or deprecated managed files)
  const newCoreSet = new Set(coreManifest.files.map((f) => toPosix(f.path)));
  const optKeepSet = new Set([...oldOptMap.keys(), ...optionalItems.map((o) => o.relPath)]);
  const retiredFiles = [];
  for (const [rel, oldEntry] of oldCoreMap.entries()) {
    const norm = toPosix(rel);
    if (!norm.startsWith('.cac/')) continue;
    const segs = norm.split('/');
    if (segs.some((s) => !s || s === '.' || s === '..')) continue;
    if (
      norm === MANIFEST_REL_PATH ||
      norm === OPTIONAL_MANIFEST_REL_PATH ||
      norm === '.cac/settings.json' ||
      norm === '.cac/EVOLUTION.md' ||
      norm.startsWith('.cac/feedback/')
    ) {
      continue;
    }
    if (newCoreSet.has(norm) || optKeepSet.has(norm)) continue;
    if (isUnderUnlinkedDir(norm, unlinkedDirs)) continue;

    const full = path.join(targetDir, norm);
    const lst = safeLstat(full);
    if (!lst) continue;
    if (lst.isSymbolicLink() || force) {
      retiredFiles.push(norm);
      continue;
    }
    if (lst.isFile()) {
      try {
        if (hashLfFile(full).sha256 === oldEntry.sha256) {
          retiredFiles.push(norm);
        }
      } catch {
        // Unreadable modified/locked file is conservatively preserved unless --force
      }
    }
  }
  retiredFiles.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const stats = {
    create: ops.filter((o) => o.action === 'create').length,
    update: ops.filter((o) => o.action === 'update').length,
    conflict: ops.filter((o) => o.action === 'conflict').length,
    skip: ops.filter((o) => o.action === 'skip').length,
    total: ops.length,
  };

  return {
    ok: true,
    code: 0,
    ops,
    stats,
    conflicts: ops.filter((o) => o.action === 'conflict').map((o) => o.relPath),
    unlinkedDirs,
    retiredFiles,
    settingsPlan,
    manifestText,
    optionalManifestText,
  };
}

/**
 * Rename a physical directory blocking leaf file creation to `<dirPath>.bak-<timestamp>`.
 * @param {string} dirPath
 * @returns {string}
 */
function evictDirToTimestampedBak(dirPath) {
  const ts = Date.now();
  let bakDirPath = `${dirPath}.bak-${ts}`;
  let suffix = 1;
  while (safeLstat(bakDirPath)) {
    bakDirPath = `${dirPath}.bak-${ts}-${suffix++}`;
  }
  fs.renameSync(dirPath, bakDirPath);
  return bakDirPath;
}

/**
 * Back up a non-directory regular file blocking directory creation to `<filePath>.bak` and remove the blocker.
 * @param {string} filePath
 */
function evictBlockingFileToBak(filePath) {
  const bakPath = `${filePath}.bak`;
  const bakSt = safeLstat(bakPath);
  if (bakSt?.isSymbolicLink()) {
    unlinkSymlinkOrJunctionSafe(bakPath);
  } else if (bakSt?.isDirectory()) {
    evictDirToTimestampedBak(bakPath);
  }
  fs.copyFileSync(filePath, bakPath);
  fs.rmSync(filePath, { force: true });
}

/**
 * Ensure every directory segment from `targetDir` down to `path.dirname(dstFull)` is a physical directory,
 * unlinking any symlink/junction segment and backing up any blocking regular file as `<seg>.bak`.
 * @param {string} dstFull
 * @param {string} targetDir
 */
function ensureParentDirSafe(dstFull, targetDir) {
  const rootAbs = path.resolve(targetDir);
  const parentAbs = path.dirname(path.resolve(dstFull));
  fs.mkdirSync(rootAbs, { recursive: true });
  const rel = path.relative(rootAbs, parentAbs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    fs.mkdirSync(parentAbs, { recursive: true });
    return;
  }
  const segs = toPosix(rel).split('/').filter(Boolean);
  let cur = rootAbs;
  for (const seg of segs) {
    cur = path.join(cur, seg);
    const st = safeLstat(cur);
    if (st) {
      if (st.isSymbolicLink()) {
        unlinkSymlinkOrJunctionSafe(cur);
      } else if (!st.isDirectory()) {
        evictBlockingFileToBak(cur);
      }
    }
  }
  fs.mkdirSync(parentAbs, { recursive: true });
}

/**
 * Prune empty physical parent directories bottom-up inside `<target>/.cac` (never touching `.cac` root or symlinks).
 * @param {string} fileFullPath
 * @param {string} targetDir
 */
function pruneEmptyParentDirsInCac(fileFullPath, targetDir) {
  const cacRoot = path.resolve(targetDir, '.cac');
  let cur = path.dirname(path.resolve(fileFullPath));
  while (cur.startsWith(cacRoot + path.sep)) {
    const st = safeLstat(cur);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) break;
    try {
      if (fs.readdirSync(cur).length === 0) {
        fs.rmdirSync(cur);
        cur = path.dirname(cur);
      } else {
        break;
      }
    } catch {
      break;
    }
  }
}

export const LOCK_STALE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Acquire atomic exclusive lock `<target>/.cac/.runtime/install.lock` using `wx` flag.
 * Reclaims stale locks from dead PIDs, locks older than 10 minutes (PID reuse guard),
 * residual directory locks, or symlinked lock files up to 3 attempts.
 * @param {string} runtimeDir
 * @param {string} startedAt
 * @returns {{ ok: true, lockPath: string } | { ok: false, code: number, error: string }}
 */
export function acquireInstallLock(runtimeDir, startedAt) {
  fs.mkdirSync(runtimeDir, { recursive: true });
  const lockPath = path.join(runtimeDir, 'install.lock');
  if (safeLstat(lockPath)?.isSymbolicLink()) {
    unlinkSymlinkOrJunctionSafe(lockPath);
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt }) + '\n', 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      return { ok: true, lockPath };
    } catch (e) {
      const lockSt = safeLstat(lockPath);
      const isExistingDirLock =
        Boolean(lockSt?.isDirectory()) &&
        Boolean(e && (e.code === 'EEXIST' || e.code === 'EISDIR' || e.code === 'EACCES' || e.code === 'EPERM'));
      if (!e || (e.code !== 'EEXIST' && !isExistingDirLock)) {
        return { ok: false, code: 1, error: `无法创建安装锁 ${lockPath}: ${e?.message || e}` };
      }
      if (lockSt?.isSymbolicLink()) {
        try {
          unlinkSymlinkOrJunctionSafe(lockPath);
          continue;
        } catch (unlinkErr) {
          return { ok: false, code: 1, error: `无法清除符号链接安装锁 ${lockPath}: ${unlinkErr?.message || unlinkErr}` };
        }
      }
      let holderPid = null;
      let lockStartedAt = null;
      if (lockSt?.isFile()) {
        try {
          const raw = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
          holderPid = raw?.pid ?? null;
          lockStartedAt = typeof raw?.startedAt === 'string' ? raw.startedAt : null;
        } catch {
          holderPid = null;
          lockStartedAt = null;
        }
      }
      const nowMs = Date.now();
      const startedMs = lockStartedAt ? Date.parse(lockStartedAt) : Number.NaN;
      const mtimeMs = typeof lockSt?.mtimeMs === 'number' ? lockSt.mtimeMs : Number.NaN;
      const isStaleTimeout =
        (Number.isFinite(startedMs) && nowMs - startedMs > LOCK_STALE_TIMEOUT_MS) ||
        (Number.isFinite(mtimeMs) && nowMs - mtimeMs > LOCK_STALE_TIMEOUT_MS);

      if (holderPid && isPidAlive(holderPid) && !isStaleTimeout) {
        return {
          ok: false,
          code: 2,
          error: `另一个安装进程正在写入目标目录：锁 ${lockPath} 的持有者 pid=${holderPid} 仍在运行`,
        };
      }
      const staleDetail = isStaleTimeout
        ? `pid=${holderPid ?? 'unknown'} 锁已超时 >10min`
        : lockSt?.isDirectory()
          ? '旧残留目录锁'
          : `pid=${holderPid ?? 'unknown'} 已退出`;
      process.stderr.write(
        `setup: 检测到陈旧安装锁 ${lockPath}（${staleDetail}），自动接管（第 ${attempt}/3 次）\n`,
      );
      try {
        fs.rmSync(lockPath, { recursive: true, force: true });
      } catch (rmErr) {
        return { ok: false, code: 1, error: `无法清除陈旧安装锁 ${lockPath}: ${rmErr?.message || rmErr}` };
      }
    }
  }

  return {
    ok: false,
    code: 2,
    error: `连续 3 次接管安装锁 ${lockPath} 仍被并发抢占，请确认无其他安装进程后再试`,
  };
}

/**
 * Write `<target>/.cac/.runtime/install.marker` safely without traversing symlinks.
 * @param {string} markerPath
 * @param {{ status: 'active' | 'interrupted', pid: number, startedAt: string, written: string[], error?: string }} payload
 */
function writeInstallMarker(markerPath, payload) {
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    if (safeLstat(markerPath)?.isSymbolicLink()) {
      unlinkSymlinkOrJunctionSafe(markerPath);
    }
    fs.writeFileSync(markerPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  } catch {
    // Best-effort during crash path
  }
}

/**
 * Execute transactional install or upgrade.
 * @param {string} srcRoot
 * @param {string} targetDir
 * @param {{
 *   dryRun?: boolean,
 *   withTests?: boolean,
 *   withHarness?: boolean,
 *   force?: boolean,
 *   hookForm?: '' | 'string' | 'exec'
 * }} [opts]
 */
export function runInstall(srcRoot, targetDir, opts = {}) {
  const plan = planInstall(srcRoot, targetDir, opts);
  if (!plan.ok) return plan;

  if (opts.dryRun) {
    return {
      ok: true,
      code: 0,
      dryRun: true,
      target: targetDir,
      plan,
      stats: plan.stats,
      conflicts: plan.conflicts,
      written: [],
    };
  }

  if (path.resolve(srcRoot) === path.resolve(targetDir)) {
    return {
      ok: false,
      code: 2,
      error: `target 目录不能指向 cac-base 框架源仓库自身（${targetDir}）；请指定下游项目路径或使用 --dry-run`,
    };
  }

  const startedAt = new Date().toISOString();
  const cacDir = path.join(targetDir, '.cac');
  const runtimeDir = path.join(cacDir, '.runtime');
  const markerPath = path.join(runtimeDir, 'install.marker');

  // Pre-lock safety: detach symlink/junction or evict blocking regular file at <target>/.cac and <target>/.cac/.runtime
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    for (const dirCandidate of [cacDir, runtimeDir]) {
      const dstSt = safeLstat(dirCandidate);
      if (dstSt) {
        if (dstSt.isSymbolicLink()) {
          unlinkSymlinkOrJunctionSafe(dirCandidate);
        } else if (!dstSt.isDirectory()) {
          evictBlockingFileToBak(dirCandidate);
        }
      }
    }
  } catch (preErr) {
    return {
      ok: false,
      code: 1,
      error: `准备安装运行态目录失败：${preErr?.message || preErr}`,
    };
  }

  const lock = acquireInstallLock(runtimeDir, startedAt);
  if (!lock.ok) return lock;

  const written = [];
  let installDone = false;

  const failAfterRaw = process.env.CAC_SETUP_FAIL_AFTER || '';
  const failAfter = /^\d+$/.test(failAfterRaw) ? parseInt(failAfterRaw, 10) : 0;

  const recordWrite = (relPath) => {
    written.push(toPosix(relPath));
    writeInstallMarker(markerPath, { status: 'active', pid: process.pid, startedAt, written });
    if (failAfter > 0 && written.length >= failAfter) {
      throw new Error(
        `CAC_SETUP_FAIL_AFTER=${failAfter} 故障注入生效：写入第 ${written.length} 个文件（${relPath}）后强制中止`,
      );
    }
  };

  const backupExisting = (dstFull) => {
    const st = safeLstat(dstFull);
    if (!st) return;
    if (st.isSymbolicLink()) {
      unlinkSymlinkOrJunctionSafe(dstFull);
      return;
    }
    if (st.isFile()) {
      const bakPath = `${dstFull}.bak`;
      const bakSt = safeLstat(bakPath);
      if (bakSt?.isSymbolicLink()) {
        unlinkSymlinkOrJunctionSafe(bakPath);
      } else if (bakSt?.isDirectory()) {
        evictDirToTimestampedBak(bakPath);
      }
      fs.copyFileSync(dstFull, bakPath);
    }
  };

  const prepareLeafForWrite = (dstFull) => {
    ensureParentDirSafe(dstFull, targetDir);
    const leafSt = safeLstat(dstFull);
    if (leafSt?.isSymbolicLink()) {
      unlinkSymlinkOrJunctionSafe(dstFull);
    } else if (leafSt?.isDirectory()) {
      evictDirToTimestampedBak(dstFull);
    }
  };

  const writeBufferOrCopy = (op, dstFull) => {
    prepareLeafForWrite(dstFull);
    if (op.srcFull) {
      fs.copyFileSync(op.srcFull, dstFull);
    } else if (typeof op.content === 'string') {
      fs.writeFileSync(dstFull, op.content, 'utf8');
    }
    if (process.platform !== 'win32' && op.relPath.startsWith('.cac/githooks/')) {
      try {
        fs.chmodSync(dstFull, 0o755);
      } catch {
        // Ignore chmod on filesystems that do not support POSIX mode bits
      }
    }
    recordWrite(op.relPath);
  };

  const onSignal = (sig) => {
    if (!installDone) {
      writeInstallMarker(markerPath, {
        status: 'interrupted',
        pid: process.pid,
        startedAt,
        written,
        error: `terminated by ${sig}`,
      });
    }
    try {
      fs.rmSync(lock.lockPath, { force: true });
    } catch {
      /* ignore */
    }
    process.exit(1);
  };

  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    writeInstallMarker(markerPath, { status: 'active', pid: process.pid, startedAt, written });

    // Unlink planned directory symlinks/junctions first (shallow to deep) so zero writes ever traverse out of .cac/
    for (const relDir of plan.unlinkedDirs || []) {
      const fullDir = path.join(targetDir, relDir);
      if (safeLstat(fullDir)?.isSymbolicLink()) {
        unlinkSymlinkOrJunctionSafe(fullDir);
      }
    }

    for (const op of plan.ops) {
      if (op.action === 'skip') continue;
      const dstFull = path.join(targetDir, op.relPath);

      if (op.kind === 'settings') {
        if (op.action === 'conflict') {
          const newPath = `${dstFull}.cac-base-new`;
          prepareLeafForWrite(newPath);
          fs.writeFileSync(newPath, plan.settingsPlan.content, 'utf8');
          recordWrite(`${op.relPath}.cac-base-new`);
        } else {
          ensureParentDirSafe(dstFull, targetDir);
          if (safeLstat(dstFull)?.isSymbolicLink()) {
            unlinkSymlinkOrJunctionSafe(dstFull);
          } else if (op.action === 'update') {
            backupExisting(dstFull);
          }
          prepareLeafForWrite(dstFull);
          fs.writeFileSync(dstFull, plan.settingsPlan.content, 'utf8');
          recordWrite(op.relPath);
        }
        continue;
      }

      if (op.action === 'conflict') {
        const newPath = `${dstFull}.cac-base-new`;
        prepareLeafForWrite(newPath);
        if (op.srcFull) fs.copyFileSync(op.srcFull, newPath);
        else if (typeof op.content === 'string') fs.writeFileSync(newPath, op.content, 'utf8');
        recordWrite(`${op.relPath}.cac-base-new`);
        continue;
      }

      ensureParentDirSafe(dstFull, targetDir);
      if (safeLstat(dstFull)?.isSymbolicLink()) {
        unlinkSymlinkOrJunctionSafe(dstFull);
      } else if (op.action === 'update') {
        backupExisting(dstFull);
      }
      writeBufferOrCopy(op, dstFull);
    }

    // Retire obsolete managed files (e.g. cc-bridge.mjs / root.mjs / ps-floor.mjs) and prune empty parent dirs
    for (const retiredRel of plan.retiredFiles || []) {
      const retiredFull = path.join(targetDir, retiredRel);
      const rst = safeLstat(retiredFull);
      if (!rst) continue;
      if (rst.isSymbolicLink()) {
        unlinkSymlinkOrJunctionSafe(retiredFull);
        pruneEmptyParentDirsInCac(retiredFull, targetDir);
      } else if (rst.isFile()) {
        fs.rmSync(retiredFull, { force: true });
        pruneEmptyParentDirsInCac(retiredFull, targetDir);
      }
    }

    installDone = true;
    fs.rmSync(markerPath, { force: true });
    fs.rmSync(lock.lockPath, { force: true });
    try {
      if (fs.existsSync(runtimeDir) && fs.readdirSync(runtimeDir).length === 0) {
        fs.rmdirSync(runtimeDir);
      }
    } catch {
      // Leave .runtime if non-empty (e.g. tier.json or supervisor state exists)
    }

    return {
      ok: true,
      code: 0,
      dryRun: false,
      target: targetDir,
      plan,
      stats: plan.stats,
      conflicts: plan.conflicts,
      written,
      resolvedHookForm: plan.settingsPlan?.resolvedForm || 'string',
    };
  } catch (err) {
    const msg = String(err?.message || err);
    if (!installDone) {
      writeInstallMarker(markerPath, {
        status: 'interrupted',
        pid: process.pid,
        startedAt,
        written,
        error: msg,
      });
    }
    return {
      ok: false,
      code: 1,
      interrupted: true,
      error: msg,
      written,
    };
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    try {
      fs.rmSync(lock.lockPath, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Safely uninstall cac-base managed framework files from `targetDir`.
 * Never removes user project files (`AGENTS.md`, `Product-Spec.md`, `progress.md`, `.cac/feedback/*`, `.cac/EVOLUTION.md`).
 * Modified `.cac/` files are preserved unless `force: true`. Never traverses symlinks/junctions.
 * @param {string} targetDir
 * @param {{ force?: boolean, dryRun?: boolean, srcRoot?: string }} [opts]
 */
export function runUninstall(targetDir, opts = {}) {
  const valid = validateTargetPath(targetDir);
  if (!valid.ok) {
    return { ok: false, code: 2, error: valid.message };
  }
  const cacDir = path.join(targetDir, '.cac');
  const force = Boolean(opts.force);
  const dryRun = Boolean(opts.dryRun);

  const cacSt = safeLstat(cacDir);
  if (!cacSt) {
    return {
      ok: false,
      code: 2,
      error: `目标目录未检测到 cac-base 安装清单（${MANIFEST_REL_PATH}）：${targetDir}`,
    };
  }
  if (cacSt.isSymbolicLink()) {
    if (!dryRun) unlinkSymlinkOrJunctionSafe(cacDir);
    return {
      ok: true,
      code: 0,
      dryRun,
      removed: ['.cac'],
      keptModified: [],
    };
  }

  const coreManifestPath = path.join(targetDir, MANIFEST_REL_PATH);
  const optManifestPath = path.join(targetDir, OPTIONAL_MANIFEST_REL_PATH);
  const coreManifestSt = safeLstat(coreManifestPath);
  const optManifestSt = safeLstat(optManifestPath);

  if (!coreManifestSt && !optManifestSt) {
    return {
      ok: false,
      code: 2,
      error: `目标目录未检测到 cac-base 安装清单（${MANIFEST_REL_PATH}）：${targetDir}`,
    };
  }

  const { filesMap: coreMap, links: coreLinks, engine: coreEngine } = readManifestMaps(coreManifestPath);
  const { filesMap: optMap, links: optLinks, engine: optEngine } = readManifestMaps(optManifestPath);

  const detectedEngine = coreEngine || optEngine;
  if (detectedEngine && detectedEngine !== 'cac-base' && !force) {
    return {
      ok: false,
      code: 2,
      error: `目标目录当前安装清单声明的引擎为 "${detectedEngine}"（非 "cac-base"），已拒绝跨引擎误卸载；如确认强制卸载请传入 --force`,
    };
  }

  const allManaged = new Map([...coreMap, ...optMap]);
  const candidateDirs = new Set(['.cac', '.cac/skills', '.cac/agents']);
  for (const relPath of allManaged.keys()) {
    collectCacAncestors(relPath, candidateDirs);
  }
  for (const lk of [...coreLinks, ...optLinks]) {
    collectCacDirAndAncestors(lk, candidateDirs);
  }
  const linkedDirs = scanUnlinkedDirs(targetDir, candidateDirs);

  const removed = [];
  const keptModified = [];

  for (const linkDir of linkedDirs) {
    if (!dryRun) unlinkSymlinkOrJunctionSafe(path.join(targetDir, linkDir));
    removed.push(linkDir);
  }

  for (const [relPath, entry] of allManaged) {
    if (!relPath.startsWith('.cac/')) continue;
    // Extra safety: never touch feedback entries (except templates) or EVOLUTION.md
    if (relPath === '.cac/EVOLUTION.md') continue;
    if (relPath.startsWith('.cac/feedback/') && !relPath.startsWith('.cac/feedback/templates/')) continue;
    if (isUnderUnlinkedDir(relPath, linkedDirs)) continue;

    const full = path.join(targetDir, relPath);
    const lst = safeLstat(full);
    if (!lst) continue;
    if (lst.isSymbolicLink()) {
      if (!dryRun) unlinkSymlinkOrJunctionSafe(full);
      removed.push(relPath);
      continue;
    }
    if (!lst.isFile()) continue;
    const actualSha = hashLfFile(full).sha256;
    if (actualSha === entry.sha256 || force) {
      if (!dryRun) fs.rmSync(full, { force: true });
      removed.push(relPath);
    } else {
      keptModified.push(relPath);
    }
  }

  // Clean framework hooks (and framework default permissions on --force) from .cac/settings.json while preserving user custom settings.
  const settingsPath = path.join(cacDir, 'settings.json');
  const settingsSt = safeLstat(settingsPath);
  if (settingsSt?.isSymbolicLink()) {
    if (!dryRun) unlinkSymlinkOrJunctionSafe(settingsPath);
    removed.push('.cac/settings.json');
  } else if (settingsSt?.isFile()) {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const stripped = stripFrameworkHooks(parsed);
      let nextSettings = stripped.settings;
      let changed = stripped.removedHooks > 0;
      if (force) {
        const defaultPerms = loadFrameworkDefaultPermissions(opts.srcRoot);
        if (defaultPerms) {
          const permRes = stripFrameworkPermissions(nextSettings, defaultPerms);
          nextSettings = permRes.settings;
          if (permRes.removedPermissions > 0) changed = true;
        }
      }
      if (force && Object.keys(nextSettings).length === 0) {
        if (!dryRun) fs.rmSync(settingsPath, { force: true });
        removed.push('.cac/settings.json');
      } else if (!dryRun && changed) {
        fs.writeFileSync(settingsPath, formatSettingsJson(nextSettings), 'utf8');
      }
    } catch {
      keptModified.push('.cac/settings.json');
    }
  }

  if (!dryRun) {
    const cmSt = safeLstat(coreManifestPath);
    if (cmSt) {
      if (cmSt.isSymbolicLink()) unlinkSymlinkOrJunctionSafe(coreManifestPath);
      else fs.rmSync(coreManifestPath, { force: true });
      removed.push(MANIFEST_REL_PATH);
    }
    const omSt = safeLstat(optManifestPath);
    if (omSt) {
      if (omSt.isSymbolicLink()) unlinkSymlinkOrJunctionSafe(optManifestPath);
      else fs.rmSync(optManifestPath, { force: true });
      removed.push(OPTIONAL_MANIFEST_REL_PATH);
    }
    // Prune empty physical directories bottom-up inside .cac (keeps .cac/feedback etc. if non-empty).
    const pruneEmptyDirs = (dir) => {
      const dst = safeLstat(dir);
      if (!dst || dst.isSymbolicLink() || !dst.isDirectory()) return;
      let ents;
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        if (e.isDirectory()) pruneEmptyDirs(path.join(dir, e.name));
      }
      try {
        if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      } catch {
        /* ignore */
      }
    };
    pruneEmptyDirs(cacDir);
  }

  return {
    ok: true,
    code: 0,
    dryRun,
    removed,
    keptModified,
  };
}
