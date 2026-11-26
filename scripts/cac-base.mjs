#!/usr/bin/env node
// scripts/cac-base.mjs — Single cross-platform CLI kernel for cac-base.
// Subcommands: install (default) | upgrade | uninstall | doctor | manifest | pack-check | release | help
// Zero npm dependencies (Node >= 20 built-ins only).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toPosix, validateTargetPath } from './lib/path-guard.mjs';
import {
  MANIFEST_REL_PATH,
  checkManifest,
  leakScanManifest,
  scanTextForLeaks,
  walkRegularFiles,
  writeManifest,
} from './lib/manifest.mjs';
import { runInstall, runUninstall } from './lib/installer.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = path.resolve(SCRIPT_DIR, '..');

const KNOWN_COMMANDS = new Set([
  'install',
  'upgrade',
  'uninstall',
  'doctor',
  'manifest',
  'pack-check',
  'release',
  'help',
]);

// Bare lowercase English subcommand typos (no '/', '\', '.', ':') that must fail fast with exit 2
// instead of silently creating a local directory of that name as an install target.
const COMMON_TYPO_SUBCOMMANDS = new Map([
  ['package', 'did you mean "release <version>" or "pack-check"?'],
  ['pack', 'did you mean "release <version>" or "pack-check"?'],
  ['bundle', 'did you mean "release <version>"?'],
  ['check', 'did you mean "pack-check" or "manifest --check"?'],
  ['verify', 'did you mean "pack-check" or "doctor"?'],
  ['test', 'did you mean "pack-check"?'],
  ['tests', 'did you mean "pack-check"?'],
  ['lint', 'did you mean "pack-check"?'],
  ['audit', 'did you mean "pack-check"?'],
  ['status', 'did you mean "doctor"?'],
  ['init', 'did you mean "install"?'],
  ['update', 'did you mean "upgrade"?'],
  ['remove', 'did you mean "uninstall"?'],
  ['clean', 'did you mean "uninstall"?'],
  ['version', 'did you mean "--help"?'],
]);

const KNOWN_BOOLEAN_FLAGS = new Set([
  'dry-run',
  'with-tests',
  'with-harness',
  'force',
  'uninstall',
  'write',
  'check',
  'leak',
  'json',
  'strict-syntax',
  'help',
]);

const KNOWN_VALUE_FLAGS = new Set([
  'target',
  'hook-form',
  'out',
]);

function usageText() {
  return [
    'cac-base CLI (Node >= 20, zero npm deps)',
    '',
    '用法:',
    '  node scripts/cac-base.mjs [install|upgrade] [--target <dir> | <dir>] [--dry-run] [--with-tests] [--with-harness] [--force] [--hook-form string|exec] [--json]',
    '  node scripts/cac-base.mjs uninstall [--target <dir> | <dir>] [--force] [--dry-run] [--json]',
    '  node scripts/cac-base.mjs doctor [--target <dir> | <dir>] [--json]',
    '  node scripts/cac-base.mjs manifest (--write | --check | --leak)',
    '  node scripts/cac-base.mjs pack-check [--strict-syntax]',
    '  node scripts/cac-base.mjs release <version> [--out <path>]',
    '',
    '退出码: 0=clean  1=violation/fail  2=usage/blocked  3=degraded',
  ].join('\n');
}

function usageDie(msg) {
  process.stderr.write(`cac-base: ${msg}\n\n${usageText()}\n`);
  process.exit(2);
}

/**
 * Parse CLI argv strictly: unknown `-*` flags always fail with exit 2 (never treated as target paths).
 * @param {string[]} argv
 */
export function parseCliArgs(argv) {
  const flags = new Set();
  const kv = {};
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      flags.add('help');
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        const key = a.slice(2, eq);
        const val = a.slice(eq + 1);
        if (KNOWN_VALUE_FLAGS.has(key)) {
          if (!val) usageDie(`选项 --${key}= 缺少参数值`);
          kv[key] = val;
        } else if (KNOWN_BOOLEAN_FLAGS.has(key)) {
          if (val === 'true' || val === '1') flags.add(key);
          else if (val !== 'false' && val !== '0') usageDie(`布尔选项 --${key} 不接受值：${val}`);
        } else {
          usageDie(`未知选项：${a}`);
        }
      } else {
        const key = a.slice(2);
        if (KNOWN_BOOLEAN_FLAGS.has(key)) {
          flags.add(key);
        } else if (KNOWN_VALUE_FLAGS.has(key)) {
          const next = argv[i + 1];
          if (next === undefined || next.startsWith('-')) {
            usageDie(`选项 --${key} 后面缺少参数值`);
          }
          kv[key] = next;
          i++;
        } else {
          usageDie(`未知选项：${a}`);
        }
      }
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      usageDie(`未知选项：${a}`);
    }
    positional.push(a);
  }

  let cmd = 'install';
  const restPos = [...positional];
  if (restPos.length > 0 && KNOWN_COMMANDS.has(restPos[0])) {
    cmd = restPos.shift();
  } else if (
    restPos.length > 0 &&
    /^[a-z]+$/.test(restPos[0]) &&
    COMMON_TYPO_SUBCOMMANDS.has(restPos[0])
  ) {
    const badCmd = restPos[0];
    const hint = COMMON_TYPO_SUBCOMMANDS.get(badCmd);
    usageDie(
      `unknown subcommand "${badCmd}" (${hint} To install into a folder named "${badCmd}", pass --target ./${badCmd})`,
    );
  }
  if (flags.has('uninstall')) {
    if (cmd !== 'install' && cmd !== 'uninstall') {
      usageDie(`--uninstall 不能与子命令 ${cmd} 同时使用`);
    }
    cmd = 'uninstall';
  }

  if (kv['hook-form'] !== undefined && kv['hook-form'] !== '' && kv['hook-form'] !== 'string' && kv['hook-form'] !== 'exec') {
    usageDie(`--hook-form 只支持 string 或 exec，收到：${kv['hook-form']}`);
  }

  return { cmd, flags, kv, positional: restPos };
}

function resolveTargetArg(kv, positional, cmdName) {
  if (kv.target && positional.length > 0) {
    usageDie(`${cmdName}: 同时传入了 --target (${kv.target}) 与位置参数 (${positional[0]})，请只保留一个`);
  }
  if (positional.length > 1) {
    usageDie(`${cmdName}: 多余的位置参数：${positional.slice(1).join(' ')}`);
  }
  return kv.target || positional[0] || '.';
}

function printInstallReport(res, cmd, jsonMode) {
  if (jsonMode) {
    process.stdout.write(
      JSON.stringify({
        status: res.ok ? 'ok' : (res.code === 2 ? 'blocked' : 'violation'),
        code: res.code,
        command: cmd,
        dryRun: Boolean(res.dryRun),
        target: res.target,
        stats: res.stats,
        conflicts: res.conflicts || [],
        writtenCount: res.written ? res.written.length : 0,
        error: res.error || null,
      }) + '\n',
    );
    return;
  }

  if (!res.ok) {
    process.stderr.write(`setup: ${res.error}\n`);
    return;
  }

  if (res.dryRun) {
    process.stdout.write(`dry-run: 预览计划（零写入），目标目录：${res.target}\n`);
    for (const op of res.plan.ops) {
      process.stdout.write(`  ${op.action.padEnd(9)} ${op.relPath}\n`);
    }
    process.stdout.write(
      `dry-run: create=${res.stats.create} update=${res.stats.update} conflict=${res.stats.conflict} skip=${res.stats.skip}（conflict 真装时写入 <file>.cac-base-new，绝不覆盖本地修改）\n`,
    );
    return;
  }

  if (res.conflicts && res.conflicts.length > 0) {
    process.stderr.write(
      `setup: ${res.conflicts.length} 个文件存在本地改动，未覆盖；框架新版已写入 <file>.cac-base-new 供审阅合并：\n`,
    );
    for (const c of res.conflicts) {
      process.stderr.write(`  - ${c} -> ${c}.cac-base-new\n`);
    }
  }

  process.stdout.write(
    `${cmd}: ok target=${res.target} create=${res.stats.create} update=${res.stats.update} conflict=${res.stats.conflict} skip=${res.stats.skip} hookForm=${res.resolvedHookForm}\n`,
  );
}

function runNodeSubprocess(scriptPath, args, cwd = FRAMEWORK_ROOT) {
  const r = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (r.error) {
    return { status: -1, stdout: '', stderr: r.error.message, parsed: null };
  }
  const stdout = String(r.stdout || '');
  const stderr = String(r.stderr || '');
  const lastLine = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || '';
  let parsed = null;
  if (lastLine.startsWith('{')) {
    try {
      parsed = JSON.parse(lastLine);
    } catch {
      parsed = null;
    }
  }
  return { status: r.status ?? -1, stdout, stderr, parsed };
}

function handlePackCheck(flags) {
  const strictSyntax = flags.has('strict-syntax');
  const steps = [];
  const bad = [];
  const warnings = [];

  const subChecks = [
    ['selftest', path.join(FRAMEWORK_ROOT, '.cac', 'harness', 'harness.mjs'), ['selftest']],
    ['scan-secrets', path.join(FRAMEWORK_ROOT, '.cac', 'harness', 'audit', 'scan-secrets.mjs'), []],
    ['scan-instructions', path.join(FRAMEWORK_ROOT, '.cac', 'harness', 'audit', 'scan-instructions.mjs'), []],
    ['check-syntax', path.join(FRAMEWORK_ROOT, '.cac', 'harness', 'audit', 'check-syntax.mjs'), []],
  ];

  for (const [name, script, args] of subChecks) {
    if (!fs.existsSync(script)) {
      bad.push({ step: name, code: 3, summary: `missing script: ${toPosix(path.relative(FRAMEWORK_ROOT, script))}` });
      steps.push({ step: name, ok: false, code: 3 });
      continue;
    }
    const r = runNodeSubprocess(script, args, FRAMEWORK_ROOT);
    if (r.status === 0) {
      steps.push({ step: name, ok: true, code: 0 });
      continue;
    }

    // Special cross-OS shell parser allowance for check-syntax when 0 parse failures occurred:
    // Linux dev hosts often lack pwsh (.ps1 skipped -> rc 3); pure Windows PowerShell hosts may lack bash (.sh skipped -> rc 3).
    // Note: on Windows, pwsh MUST be present (skipping ps1 on win32 is always a hard failure).
    if (name === 'check-syntax' && r.status === 3 && !strictSyntax && r.parsed) {
      const failures = Array.isArray(r.parsed.failures) ? r.parsed.failures : [];
      const undecidable = Array.isArray(r.parsed.undecidable) ? r.parsed.undecidable : [];
      const degraded = Array.isArray(r.parsed.degraded) ? r.parsed.degraded : [];
      const rawSkipped = Array.isArray(r.parsed.skipped)
        ? r.parsed.skipped
        : (Array.isArray(r.parsed.skippedClasses) ? r.parsed.skippedClasses : []);
      const skippedNames = rawSkipped.map((s) => (typeof s === 'string' ? s : s?.class || s?.kind || '')).filter(Boolean);
      const foreignOnly =
        failures.length === 0 &&
        undecidable.length === 0 &&
        degraded.length === 0 &&
        skippedNames.length > 0 &&
        skippedNames.every((cls) =>
          (process.platform !== 'win32' && cls === 'ps1') || (process.platform === 'win32' && cls === 'sh'),
        );
      if (foreignOnly) {
        const msg = `check-syntax degraded (rc=3) due to cross-OS shell parser (${skippedNames.join(',')}) unavailable on ${process.platform}`;
        process.stderr.write(`[pack-check] warning: ${msg}\n`);
        warnings.push({ step: name, code: 3, summary: msg });
        steps.push({ step: name, ok: true, degradedWarning: true, code: 3 });
        continue;
      }
    }

    const detail = r.parsed?.summary || r.parsed?.note || r.stderr.trim().split(/\r?\n/)[0] || `exit ${r.status}`;
    bad.push({ step: name, code: r.status, summary: detail });
    steps.push({ step: name, ok: false, code: r.status, summary: detail });
  }

  // Manifest drift check
  const mCheck = checkManifest(FRAMEWORK_ROOT);
  if (mCheck.code !== 0) {
    bad.push({ step: 'manifest-check', code: mCheck.code, summary: mCheck.summary, problems: mCheck.problems?.slice(0, 10) });
    steps.push({ step: 'manifest-check', ok: false, code: mCheck.code });
  } else {
    steps.push({ step: 'manifest-check', ok: true, code: 0 });
  }

  // Manifest leak scan
  const mLeak = leakScanManifest(FRAMEWORK_ROOT, { requireManifestOnDisk: true });
  if (mLeak.code !== 0) {
    bad.push({ step: 'manifest-leak', code: mLeak.code, summary: mLeak.summary, hits: mLeak.hits?.slice(0, 10) });
    steps.push({ step: 'manifest-leak', ok: false, code: mLeak.code });
  } else {
    steps.push({ step: 'manifest-leak', ok: true, code: 0 });
  }

  // Doctor check
  const doctorScript = path.join(FRAMEWORK_ROOT, '.cac', 'scripts', 'doctor.mjs');
  if (!fs.existsSync(doctorScript)) {
    bad.push({ step: 'doctor', code: 3, summary: 'missing .cac/scripts/doctor.mjs' });
    steps.push({ step: 'doctor', ok: false, code: 3 });
  } else {
    const dr = runNodeSubprocess(doctorScript, ['--json', FRAMEWORK_ROOT], FRAMEWORK_ROOT);
    if (dr.status !== 0) {
      bad.push({
        step: 'doctor',
        code: dr.status,
        summary: dr.parsed?.summary || dr.stderr.trim().split(/\r?\n/)[0] || `doctor exited ${dr.status}`,
      });
      steps.push({ step: 'doctor', ok: false, code: dr.status });
    } else {
      steps.push({ step: 'doctor', ok: true, code: 0 });
    }
  }

  const code = bad.length === 0 ? 0 : (bad.every((b) => b.code === 3) ? 3 : 1);
  const payload = {
    status: code === 0 ? 'ok' : (code === 3 ? 'degraded' : 'violation'),
    code,
    summary: code === 0 ? `pack-check: all ${steps.length} checks passed` : `pack-check: ${bad.length} check(s) failed`,
    steps,
    warnings,
    bad,
  };
  process.stdout.write(JSON.stringify(payload) + '\n');
  process.exit(code);
}

function isReleaseExcludedRel(rel) {
  const p = toPosix(rel);
  if (
    p === 'progress.md' ||
    p === 'progress.archive.md' ||
    /^progress\..*\.md$/.test(p) ||
    p === 'CHANGELOG.md' ||
    p === 'Product-Spec.md' ||
    p === 'Product-Spec-CHANGELOG.md' ||
    p === 'DEV-PLAN.md' ||
    p === 'DEV-PLAN.archive.md'
  ) {
    return true;
  }
  if (p.startsWith('docs/') && p !== 'docs/HOST-CONTRACT.md') return true;
  if (
    p.startsWith('.cac/.runtime/') ||
    p.startsWith('.cac/evidence/') ||
    p.startsWith('.cac/agent-memory/') ||
    p.startsWith('.cac/research/') ||
    p.startsWith('.cac/worktrees/') ||
    p.startsWith('.cac/harness/state/') ||
    p.startsWith('.cac/harness/receipts/') ||
    p.startsWith('.cac/harness/waivers/') ||
    p.startsWith('.cac/harness/trend/') ||
    p.startsWith('.cac/harness/evidence/')
  ) {
    return true;
  }
  if (p.startsWith('.cac/feedback/') && !p.startsWith('.cac/feedback/templates/')) {
    return true;
  }
  if (/\.(?:bak|cac-base-new|framework-new|swp)$/.test(p)) return true;
  if (/(?:^|\/)(?:\.DS_Store|Thumbs\.db|signals\.jsonl|\.needs-review.*)$/.test(p)) return true;
  return false;
}

function resolveTarCommand() {
  if (process.platform === 'win32') {
    const sysTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(sysTar)) return { bin: sysTar, extraFlags: [] };
    const probe = spawnSync('tar', ['--help'], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
    });
    if (`${probe.stdout || ''}\n${probe.stderr || ''}`.includes('--force-local')) {
      return { bin: 'tar', extraFlags: ['--force-local'] };
    }
  }
  return { bin: 'tar', extraFlags: [] };
}

function handleRelease(version, outOverride) {
  if (!version || !/^[A-Za-z0-9._+-]+$/.test(version) || version.includes('..')) {
    usageDie(`release 需要合法的版本号（如 v1.0.0），收到：${version || '<empty>'}`);
  }

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cac-release-'));
  const pkgName = `cac-base-${version}`;
  const stageDir = path.join(tmpBase, pkgName);
  const verifyDir = path.join(tmpBase, 'verify-unpack');

  try {
    fs.mkdirSync(stageDir, { recursive: true });

    // Enumerate tracked files via git ls-files -z if git repo, else walk directory
    let sourceRelList = [];
    const gitLs = spawnSync('git', ['-c', 'core.quotePath=false', 'ls-files', '-z'], {
      cwd: FRAMEWORK_ROOT,
      shell: false,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (gitLs.status === 0 && gitLs.stdout && gitLs.stdout.length > 0) {
      sourceRelList = gitLs.stdout
        .toString('utf8')
        .split('\0')
        .map((s) => toPosix(s.trim()))
        .filter(Boolean);
    } else {
      sourceRelList = walkRegularFiles(FRAMEWORK_ROOT, FRAMEWORK_ROOT).filter(
        (p) => !p.startsWith('.git/') && !p.startsWith('node_modules/'),
      );
    }
    if (fs.existsSync(path.join(FRAMEWORK_ROOT, MANIFEST_REL_PATH)) && !sourceRelList.includes(MANIFEST_REL_PATH)) {
      sourceRelList.push(MANIFEST_REL_PATH);
    }

    for (const rel of sourceRelList) {
      if (isReleaseExcludedRel(rel)) continue;
      if (rel === '.cac/EVOLUTION.md') continue;
      const srcFull = path.join(FRAMEWORK_ROOT, rel);
      if (!fs.existsSync(srcFull) || !fs.statSync(srcFull).isFile()) continue;
      const dstFull = path.join(stageDir, rel);
      fs.mkdirSync(path.dirname(dstFull), { recursive: true });
      fs.copyFileSync(srcFull, dstFull);
    }

    // Seed clean FEEDBACK-INDEX.md and clean EVOLUTION.md into release bundle
    const fbTpl = path.join(FRAMEWORK_ROOT, '.cac', 'feedback', 'templates', 'feedback-index-template.md');
    const fbDest = path.join(stageDir, '.cac', 'feedback', 'FEEDBACK-INDEX.md');
    fs.mkdirSync(path.dirname(fbDest), { recursive: true });
    fs.writeFileSync(
      fbDest,
      fs.existsSync(fbTpl)
        ? fs.readFileSync(fbTpl, 'utf8')
        : '# FEEDBACK-INDEX — 项目 AI 行为修正索引\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(stageDir, '.cac', 'EVOLUTION.md'),
      '# EVOLUTION.md — 反馈聚类与规则进化记录\n',
      'utf8',
    );

    const defaultArchive = path.join(os.tmpdir(), `${pkgName}.tar.gz`);
    const outPath = outOverride ? path.resolve(outOverride) : defaultArchive;
    const exportAsDir = outPath.endsWith('.dir');

    let unpackRoot = stageDir;
    if (exportAsDir) {
      fs.rmSync(outPath, { recursive: true, force: true });
      fs.cpSync(stageDir, outPath, { recursive: true });
      unpackRoot = outPath;
    } else {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.rmSync(outPath, { force: true });
      const tarCmd = resolveTarCommand();
      const tmpArchiveName = `${pkgName}.tar.gz`;
      const tmpArchivePath = path.join(tmpBase, tmpArchiveName);
      const packRes = spawnSync(tarCmd.bin, [...tarCmd.extraFlags, '-czf', tmpArchiveName, pkgName], {
        cwd: tmpBase,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
      });
      if (packRes.error || packRes.status !== 0) {
        process.stderr.write(`release: tar 打包失败: ${packRes.error?.message || packRes.stderr}\n`);
        process.exit(1);
      }

      // Unpack into clean verify directory using relative paths (avoids MSYS GNU tar Windows C: remote-host misparse)
      fs.mkdirSync(verifyDir, { recursive: true });
      const unpackRes = spawnSync(tarCmd.bin, [...tarCmd.extraFlags, '-xzf', tmpArchiveName, '-C', 'verify-unpack'], {
        cwd: tmpBase,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
      });
      if (unpackRes.error || unpackRes.status !== 0) {
        process.stderr.write(`release: 解包校验失败: ${unpackRes.error?.message || unpackRes.stderr}\n`);
        process.exit(1);
      }
      fs.copyFileSync(tmpArchivePath, outPath);
      unpackRoot = path.join(verifyDir, pkgName);
    }

    // Verify unpacked bundle: 1) no forbidden private files, 2) zero content leaks
    const unpackedFiles = walkRegularFiles(unpackRoot, unpackRoot);
    const leakedFiles = unpackedFiles.filter((rel) => {
      if (rel === '.cac/feedback/FEEDBACK-INDEX.md') return false;
      return isReleaseExcludedRel(rel);
    });

    const contentHits = [];
    for (const rel of unpackedFiles) {
      const full = path.join(unpackRoot, rel);
      const buf = fs.readFileSync(full);
      if (buf.includes(0)) continue;
      contentHits.push(...scanTextForLeaks(rel, buf.toString('utf8')));
    }

    if (leakedFiles.length > 0 || contentHits.length > 0) {
      if (!exportAsDir) fs.rmSync(outPath, { force: true });
      process.stdout.write(
        JSON.stringify({
          status: 'violation',
          code: 1,
          summary: `release leak check failed: leakedFiles=${leakedFiles.length}, contentHits=${contentHits.length}`,
          leakedFiles: leakedFiles.slice(0, 20),
          contentHits: contentHits.slice(0, 20),
        }) + '\n',
      );
      process.exit(1);
    }

    process.stdout.write(
      JSON.stringify({
        status: 'ok',
        code: 0,
        version,
        artifact: toPosix(outPath),
        files: unpackedFiles.length,
        summary: `release ${version}: verified ${unpackedFiles.length} unpacked files with 0 leaks`,
      }) + '\n',
    );
    process.exit(0);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

function main() {
  const { cmd, flags, kv, positional } = parseCliArgs(process.argv.slice(2));

  if (flags.has('help') || cmd === 'help') {
    process.stdout.write(usageText() + '\n');
    process.exit(0);
  }

  switch (cmd) {
    case 'install':
    case 'upgrade': {
      const target = resolveTargetArg(kv, positional, cmd);
      const res = runInstall(FRAMEWORK_ROOT, target, {
        dryRun: flags.has('dry-run'),
        withTests: flags.has('with-tests'),
        withHarness: flags.has('with-harness'),
        force: flags.has('force'),
        hookForm: kv['hook-form'] || '',
      });
      printInstallReport(res, cmd, flags.has('json'));
      process.exit(res.code);
      break;
    }

    case 'uninstall': {
      const target = resolveTargetArg(kv, positional, 'uninstall');
      const res = runUninstall(target, {
        force: flags.has('force'),
        dryRun: flags.has('dry-run'),
      });
      if (flags.has('json')) {
        process.stdout.write(
          JSON.stringify({
            status: res.ok ? 'ok' : 'blocked',
            code: res.code,
            removed: res.removed || [],
            keptModified: res.keptModified || [],
            error: res.error || null,
          }) + '\n',
        );
      } else if (!res.ok) {
        process.stderr.write(`uninstall: ${res.error}\n`);
      } else {
        process.stdout.write(
          `uninstall: ${res.dryRun ? '(dry-run) ' : ''}removed=${res.removed.length} keptModified=${res.keptModified.length} target=${target}\n`,
        );
      }
      process.exit(res.code);
      break;
    }

    case 'doctor': {
      const target = resolveTargetArg(kv, positional, 'doctor');
      const v = validateTargetPath(target);
      if (!v.ok) {
        process.stderr.write(`doctor: ${v.message}\n`);
        process.exit(2);
      }
      const targetDoctor = path.join(target, '.cac', 'scripts', 'doctor.mjs');
      const fwDoctor = path.join(FRAMEWORK_ROOT, '.cac', 'scripts', 'doctor.mjs');
      const script = fs.existsSync(targetDoctor) ? targetDoctor : fwDoctor;
      if (!fs.existsSync(script)) {
        process.stderr.write('doctor: missing .cac/scripts/doctor.mjs\n');
        process.exit(3);
      }
      const args = [script, target];
      if (flags.has('json')) args.push('--json');
      const r = spawnSync(process.execPath, args, {
        stdio: 'inherit',
        shell: false,
        windowsHide: true,
      });
      process.exit(r.status ?? 1);
      break;
    }

    case 'manifest': {
      const modes = ['write', 'check', 'leak'].filter((m) => flags.has(m));
      if (modes.length > 1) {
        usageDie('manifest: --write / --check / --leak 只能传其中一个');
      }
      const mode = modes[0] || 'check';
      const root = kv.target ? path.resolve(kv.target) : FRAMEWORK_ROOT;
      const res =
        mode === 'write'
          ? writeManifest(root)
          : mode === 'leak'
            ? leakScanManifest(root, { requireManifestOnDisk: false })
            : checkManifest(root);
      process.stdout.write(JSON.stringify(res) + '\n');
      process.exit(res.code);
      break;
    }

    case 'pack-check': {
      handlePackCheck(flags);
      break;
    }

    case 'release': {
      handleRelease(positional[0], kv.out);
      break;
    }

    default:
      usageDie(`未知子命令：${cmd}`);
  }
}

const isMain = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isMain) {
  main();
}
