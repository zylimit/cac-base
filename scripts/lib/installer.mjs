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
 * Read a manifest file (`files` and `seeded`) into lookup maps, or empty maps if absent/corrupt.
 * @param {string} manifestPath
 * @returns {{ filesMap: Map<string, {path:string,sha256:string,bytes:number}>, seededMap: Map<string, {path:string,sha256:string,bytes:number}> }}
 */
function readManifestMaps(manifestPath) {
  const filesMap = new Map();
  const seededMap = new Map();
  if (!fs.existsSync(manifestPath)) return { filesMap, seededMap };
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
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
  } catch {
    // Unreadable old manifest falls back to conservative conflict protection (never silent overwrite).
  }
  return { filesMap, seededMap };
}

/**
 * Decide 3-way action (`create` | `skip` | `update` | `conflict`) for one file pair.
 * @param {string} srcSha
 * @param {string} dstFullPath
 * @param {string | undefined} oldSha
 * @param {boolean} force
 * @returns {'create' | 'skip' | 'update' | 'conflict'}
 */
function decideThreeWay(srcSha, dstFullPath, oldSha, force) {
  if (!fs.existsSync(dstFullPath)) return 'create';
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

  const { filesMap: oldCoreMap, seededMap: oldSeedMap } = readManifestMaps(
    path.join(targetDir, MANIFEST_REL_PATH),
  );
  const { filesMap: oldOptMap } = readManifestMaps(
    path.join(targetDir, OPTIONAL_MANIFEST_REL_PATH),
  );

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
    const action = decideThreeWay(item.sha256, dstFull, oldEntry?.sha256, force);
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
  for (const opt of optionalItems) {
    const dstFull = path.join(targetDir, opt.relPath);
    const oldEntry = oldOptMap.get(opt.relPath);
    const action = decideThreeWay(opt.sha256, dstFull, oldEntry?.sha256, force);
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
    if (!fs.existsSync(dstSettingsPath)) {
      const merged = mergeSettings(null, srcSettingsObj, { hookForm });
      const content = formatSettingsJson(merged.settings);
      settingsPlan = { action: 'create', content, resolvedForm: merged.resolvedForm };
      ops.push({ action: 'create', kind: 'settings', relPath: '.cac/settings.json' });
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

  // 5. .cac/feedback/FEEDBACK-INDEX.md (only created if missing; never overwritten on upgrade)
  const dstFbIndex = path.join(targetDir, '.cac', 'feedback', 'FEEDBACK-INDEX.md');
  const srcFbTpl = path.join(srcRoot, '.cac', 'feedback', 'templates', 'feedback-index-template.md');
  const fbIndexContent = fs.existsSync(srcFbTpl)
    ? fs.readFileSync(srcFbTpl, 'utf8')
    : DEFAULT_FEEDBACK_INDEX_TEMPLATE;
  const fbAction = fs.existsSync(dstFbIndex) ? 'skip' : 'create';
  ops.push({ action: fbAction, kind: 'seeded-once', relPath: '.cac/feedback/FEEDBACK-INDEX.md', content: fbIndexContent });

  // 6. .cac/EVOLUTION.md (clean template only if missing; never copies framework's own history)
  const dstEvolution = path.join(targetDir, '.cac', 'EVOLUTION.md');
  const evoAction = fs.existsSync(dstEvolution) ? 'skip' : 'create';
  ops.push({ action: evoAction, kind: 'seeded-once', relPath: '.cac/EVOLUTION.md', content: DEFAULT_EVOLUTION_TEMPLATE });

  // 7. .cac/FRAMEWORK-MANIFEST.json
  const manifestText = fs.existsSync(srcManifestFile)
    ? fs.readFileSync(srcManifestFile, 'utf8')
    : JSON.stringify(coreManifest, null, 2) + '\n';
  const dstManifestPath = path.join(targetDir, MANIFEST_REL_PATH);
  let manifestAction = 'create';
  if (fs.existsSync(dstManifestPath)) {
    manifestAction = hashLfBuffer(manifestText).sha256 === hashLfFile(dstManifestPath).sha256 ? 'skip' : 'update';
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
    if (fs.existsSync(dstOptPath)) {
      optAction = hashLfBuffer(optionalManifestText).sha256 === hashLfFile(dstOptPath).sha256 ? 'skip' : 'update';
    }
    ops.push({ action: optAction, kind: 'manifest-optional', relPath: OPTIONAL_MANIFEST_REL_PATH, content: optionalManifestText });
  }

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
    settingsPlan,
    manifestText,
    optionalManifestText,
  };
}

/**
 * Acquire atomic exclusive lock `<target>/.cac/.runtime/install.lock` using `wx` flag.
 * Reclaims stale locks from dead PIDs up to 3 attempts.
 * @param {string} runtimeDir
 * @param {string} startedAt
 * @returns {{ ok: true, lockPath: string } | { ok: false, code: number, error: string }}
 */
export function acquireInstallLock(runtimeDir, startedAt) {
  fs.mkdirSync(runtimeDir, { recursive: true });
  const lockPath = path.join(runtimeDir, 'install.lock');

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
      if (!e || e.code !== 'EEXIST') {
        return { ok: false, code: 1, error: `无法创建安装锁 ${lockPath}: ${e?.message || e}` };
      }
      let holderPid = null;
      try {
        const raw = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        holderPid = raw?.pid ?? null;
      } catch {
        holderPid = null;
      }
      if (holderPid && isPidAlive(holderPid)) {
        return {
          ok: false,
          code: 2,
          error: `另一个安装进程正在写入目标目录：锁 ${lockPath} 的持有者 pid=${holderPid} 仍在运行`,
        };
      }
      process.stderr.write(
        `setup: 检测到陈旧安装锁 ${lockPath}（pid=${holderPid ?? 'unknown'} 已退出），自动接管（第 ${attempt}/3 次）\n`,
      );
      try {
        fs.rmSync(lockPath, { force: true });
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
 * Write `<target>/.cac/.runtime/install.marker`.
 * @param {string} markerPath
 * @param {{ status: 'active' | 'interrupted', pid: number, startedAt: string, written: string[], error?: string }} payload
 */
function writeInstallMarker(markerPath, payload) {
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
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
  const runtimeDir = path.join(targetDir, '.cac', '.runtime');
  const markerPath = path.join(runtimeDir, 'install.marker');

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
    if (fs.existsSync(dstFull)) {
      fs.copyFileSync(dstFull, `${dstFull}.bak`);
    }
  };

  const writeBufferOrCopy = (op, dstFull) => {
    fs.mkdirSync(path.dirname(dstFull), { recursive: true });
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

    for (const op of plan.ops) {
      if (op.action === 'skip') continue;
      const dstFull = path.join(targetDir, op.relPath);

      if (op.kind === 'settings') {
        if (op.action === 'conflict') {
          const newPath = `${dstFull}.cac-base-new`;
          fs.mkdirSync(path.dirname(newPath), { recursive: true });
          fs.writeFileSync(newPath, plan.settingsPlan.content, 'utf8');
          recordWrite(`${op.relPath}.cac-base-new`);
        } else {
          if (op.action === 'update') backupExisting(dstFull);
          fs.mkdirSync(path.dirname(dstFull), { recursive: true });
          fs.writeFileSync(dstFull, plan.settingsPlan.content, 'utf8');
          recordWrite(op.relPath);
        }
        continue;
      }

      if (op.action === 'conflict') {
        const newPath = `${dstFull}.cac-base-new`;
        fs.mkdirSync(path.dirname(newPath), { recursive: true });
        if (op.srcFull) fs.copyFileSync(op.srcFull, newPath);
        else if (typeof op.content === 'string') fs.writeFileSync(newPath, op.content, 'utf8');
        recordWrite(`${op.relPath}.cac-base-new`);
        continue;
      }

      if (op.action === 'update') {
        backupExisting(dstFull);
      }
      writeBufferOrCopy(op, dstFull);
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
 * Modified `.cac/` files are preserved unless `force: true`.
 * @param {string} targetDir
 * @param {{ force?: boolean, dryRun?: boolean }} [opts]
 */
export function runUninstall(targetDir, opts = {}) {
  const valid = validateTargetPath(targetDir);
  if (!valid.ok) {
    return { ok: false, code: 2, error: valid.message };
  }
  const cacDir = path.join(targetDir, '.cac');
  const coreManifestPath = path.join(targetDir, MANIFEST_REL_PATH);
  const optManifestPath = path.join(targetDir, OPTIONAL_MANIFEST_REL_PATH);

  if (!fs.existsSync(cacDir) || (!fs.existsSync(coreManifestPath) && !fs.existsSync(optManifestPath))) {
    return {
      ok: false,
      code: 2,
      error: `目标目录未检测到 cac-base 安装清单（${MANIFEST_REL_PATH}）：${targetDir}`,
    };
  }

  const force = Boolean(opts.force);
  const dryRun = Boolean(opts.dryRun);
  const { filesMap: coreMap } = readManifestMaps(coreManifestPath);
  const { filesMap: optMap } = readManifestMaps(optManifestPath);

  const allManaged = new Map([...coreMap, ...optMap]);
  const removed = [];
  const keptModified = [];

  for (const [relPath, entry] of allManaged) {
    if (!relPath.startsWith('.cac/')) continue;
    // Extra safety: never touch feedback entries (except templates) or EVOLUTION.md
    if (relPath === '.cac/EVOLUTION.md') continue;
    if (relPath.startsWith('.cac/feedback/') && !relPath.startsWith('.cac/feedback/templates/')) continue;

    const full = path.join(targetDir, relPath);
    if (!fs.existsSync(full)) continue;
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
  if (fs.existsSync(settingsPath)) {
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
    if (fs.existsSync(coreManifestPath)) {
      fs.rmSync(coreManifestPath, { force: true });
      removed.push(MANIFEST_REL_PATH);
    }
    if (fs.existsSync(optManifestPath)) {
      fs.rmSync(optManifestPath, { force: true });
      removed.push(OPTIONAL_MANIFEST_REL_PATH);
    }
    // Prune empty directories bottom-up inside .cac (keeps .cac/feedback etc. if non-empty).
    const pruneEmptyDirs = (dir) => {
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
