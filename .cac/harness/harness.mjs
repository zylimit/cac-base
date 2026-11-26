#!/usr/bin/env node
// harness.mjs — cac-base 工程治理运行时 CLI 入口（零外部依赖，Node >= 20 内置模块）。
//
// 核心常驻 4 子命令（无需安装大仓包即可运行）：
//   doctor    委派 .cac/scripts/doctor.mjs --json（若存在）或执行内置最小体检，单行 JSON {status, code, summary, detail}
//   diff-hash 工作树规范化 diff SHA-256 指纹
//   selftest  核心自测（若 .cac/harness/ext/selftest.mjs 存在则合并运行扩展自测）
//   tier      status | set | explain | validate 三档强度表盘
//
// 其余 36 个大仓治理子命令按需加载 ./ext/<section>.mjs；未安装大仓包时以退出码 3 输出单行 JSON：
//   {status:"degraded", code:3, summary:"大仓治理包未安装（运行 setup --with-harness 安装）", detail:{}}

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { DEFAULT_PROFILE } from '../hooks/lib/tier.mjs';
import {
  HARNESS_DIR, canonicalDiff, die, emit, headCommit, isDenied, isGitRepo,
  loadHarnessConfig, matchAny, projectRoot, sha256, stableJson, toPosixPath,
} from './lib/core.mjs';
import { cmdTier, validateProfile } from './lib/tier.mjs';

const EXT_DIR = path.join(HARNESS_DIR, 'ext');
const EXT_MISSING_SUMMARY = '大仓治理包未安装（运行 setup --with-harness 安装）';

async function tryExt(name) {
  const target = path.join(EXT_DIR, name + '.mjs');
  if (!fs.existsSync(target)) return null;
  return await import('./ext/' + name + '.mjs');
}

async function ext(name) {
  const mod = await tryExt(name);
  if (mod) return mod;
  process.stderr.write(EXT_MISSING_SUMMARY + '\n');
  return emit({
    status: 'degraded',
    code: 3,
    summary: EXT_MISSING_SUMMARY,
    detail: {},
  }, 3);
}

const IMPLEMENTED_SUBCOMMANDS = [
  'doctor', 'diff-hash', 'selftest', 'tier',
  'catalog-lint', 'impact', 'context-pack', 'receipt', 'verify', 'waiver',
  'attributes', 'arch-check', 'fitness', 'adapters', 'adr-check', 'arch-trend',
  'gate', 'ledger', 'gate-audit', 'retention', 'risk', 'task', 'budget',
  'spec-lint', 'trace', 'spec', 'dod', 'review', 'review-pack', 'authorship',
  'invariants', 'recap', 'archive', 'sync-check', 'rules-audit', 'skills-lint',
  'agents-md-lint', 'init', 'cochange', 'release',
];

const SUBCOMMAND_FLAGS = {
  'doctor': [],
  'diff-hash': [],
  'selftest': [],
  'tier': ['hours', 'reason', 'sticky'],
  'catalog-lint': ['catalog', 'tracked'],
  'impact': ['catalog', 'changed'],
  'context-pack': ['budget-chars', 'catalog', 'changed', 'task'],
  'receipt': ['task'],
  'verify': ['catalog', 'changed'],
  'waiver': ['compensation', 'dry-run', 'dryRun', 'expiry', 'file', 'owner', 'reason', 'scope', 'sub'],
  'attributes': ['catalog', 'module'],
  'arch-check': ['catalog', 'max-files', 'record'],
  'fitness': ['all', 'catalog', 'paths', 'rules-file'],
  'adapters': ['attribute', 'catalog', 'dry-run', 'dryRun', 'id'],
  'adr-check': ['catalog', 'dir', 'file'],
  'arch-trend': ['gate'],
  'gate': ['catalog', 'changed'],
  'ledger': ['no-verify-evidence'],
  'gate-audit': ['catalog'],
  'retention': ['apply', 'max-age-days', 'max-evidence', 'max-packs'],
  'risk': ['catalog'],
  'task': ['catalog', 'changed'],
  'budget': ['catalog'],
  'spec-lint': ['file'],
  'trace': ['catalog', 'file', 'min-coverage', 'tests'],
  'spec': ['all', 'budget', 'catalog', 'file', 'paths', 'tests'],
  'dod': ['only'],
  'review': ['agent', 'catalog', 'notes', 'pack', 'reviewer', 'scope'],
  'review-pack': ['base', 'max-diff-lines'],
  'authorship': [],
  'invariants': ['budget', 'file', 'rules'],
  'recap': ['budget', 'changelog', 'file', 'spec'],
  'archive': ['apply', 'archive', 'file', 'max-entries'],
  'sync-check': ['staged'],
  'rules-audit': ['limit'],
  'skills-lint': ['limit'],
  'agents-md-lint': ['catalog', 'limit'],
  'init': ['apply', 'catalog', 'max-modules'],
  'cochange': ['catalog', 'gate', 'max-commits', 'max-files-per-commit', 'min-support'],
  'release': [],
};

function parseArgs(argv) {
  const cmd = argv[0];
  const flags = {};
  const positional = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 2) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
          flags[key] = true;
        } else {
          flags[key] = next;
          i++;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { cmd, flags, positional, sub: positional[0] };
}

function unknownFlags(cmd, flags) {
  if (!IMPLEMENTED_SUBCOMMANDS.includes(cmd)) return [];
  const allowed = SUBCOMMAND_FLAGS[cmd] || [];
  return Object.keys(flags).filter((k) => !allowed.includes(k));
}

function flagUsage(cmd, unknown) {
  const allowed = SUBCOMMAND_FLAGS[cmd] || [];
  return (unknown.length === 1 ? 'unknown flag for ' : 'unknown flags for ') + cmd + ': '
    + unknown.map((f) => '--' + f).join(', ') + '\n'
    + (allowed.length
      ? cmd + ' reads: ' + allowed.map((f) => '--' + f).join(', ') + '\n'
      : cmd + ' reads no flags\n');
}

function usage(cmd) {
  const prefix = cmd ? ('unknown subcommand: ' + cmd + '\n') : 'missing subcommand\n';
  return prefix
    + 'usage: node .cac/harness/harness.mjs <subcommand>\n'
    + 'core subcommands: doctor, diff-hash, selftest, tier\n'
    + 'all subcommands: ' + IMPLEMENTED_SUBCOMMANDS.join(', ') + '\n';
}

async function cmdDoctor() {
  const root = projectRoot();
  const doctorScript = path.join(root, '.cac', 'scripts', 'doctor.mjs');
  if (fs.existsSync(doctorScript)) {
    const r = spawnSync(process.execPath, [doctorScript, '--json'], {
      cwd: root,
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 15000,
    });
    if (r.stderr && r.stderr.trim()) process.stderr.write(r.stderr);
    const lines = String(r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const lastLine = lines.length ? lines[lines.length - 1] : '';
    if (lastLine) {
      try {
        const parsed = JSON.parse(lastLine);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const code = Number.isInteger(parsed.code)
            ? parsed.code
            : (r.status === 0 ? 0 : (r.status === 3 ? 3 : 1));
          const status = typeof parsed.status === 'string'
            ? parsed.status
            : (code === 0 ? 'ok' : (code === 3 ? 'degraded' : 'violation'));
          const summary = typeof parsed.summary === 'string'
            ? parsed.summary
            : (code === 0 ? 'doctor 检查通过' : `doctor 检查退出码 ${code}`);
          const detail = (parsed.detail && typeof parsed.detail === 'object') ? parsed.detail : parsed;
          return emit({ ...parsed, status, code, summary, detail }, code);
        }
      } catch (_e) { /* fall through to degraded */ }
    }
    const errSummary = r.error
      ? `doctor.mjs 启动失败：${r.error.message || r.error}`
      : `doctor.mjs --json 未返回有效 JSON（退出码 ${r.status}）`;
    return emit({
      status: 'degraded',
      code: 3,
      summary: errSummary,
      detail: { exitStatus: r.status, stderr: String(r.stderr || '').trim().slice(0, 400) },
    }, 3);
  }

  // 内置最小体检（当 .cac/scripts/doctor.mjs 尚未安装时）
  const cfg = loadHarnessConfig();
  const extInstalled = fs.existsSync(EXT_DIR);
  const issues = [];
  const major = Number(String(process.versions.node || '0').split('.')[0]);
  if (major < 20) issues.push(`Node 版本过低（当前 ${process.version}，需 >=20.0.0）`);

  const settingsPath = path.join(root, '.cac', 'settings.json');
  const settingsPresent = fs.existsSync(settingsPath);
  if (!settingsPresent) {
    issues.push('缺少 .cac/settings.json');
  } else {
    try { JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch (_e) { issues.push('.cac/settings.json 不是合法 JSON'); }
  }

  const profilePath = path.join(root, '.cac', 'harness', 'profile.json');
  const profilePresent = fs.existsSync(profilePath);
  if (profilePresent) {
    try { JSON.parse(fs.readFileSync(profilePath, 'utf8')); } catch (_e) { issues.push('.cac/harness/profile.json 不是合法 JSON'); }
  }

  const code = issues.length > 0 ? 1 : 0;
  const status = code === 0 ? 'ok' : 'violation';
  const summary = code === 0
    ? `内置最小体检通过（Node ${process.version}，ext=${extInstalled ? 'installed' : 'not-installed'}）`
    : `内置最小体检发现 ${issues.length} 项问题：${issues.join('；')}`;

  return emit({
    status,
    code,
    summary,
    detail: {
      node: process.version,
      gitRepo: isGitRepo(root),
      headCommit: headCommit(root),
      harnessDir: '.cac/harness',
      extInstalled,
      catalogPresent: cfg.catalogPresent,
      settingsPresent,
      profilePresent,
      subcommands: IMPLEMENTED_SUBCOMMANDS,
      issues,
    },
  }, code);
}

function cmdDiffHash() {
  const { buf, nonGit } = canonicalDiff();
  return emit({
    status: 'ok',
    code: 0,
    diffHash: sha256(buf),
    baseCommit: headCommit(),
    nonGit,
  }, 0);
}

function coreSelftestCases() {
  return [
    ['core-glob-and-posix', () => {
      if (!matchAny('src/a/b.ts', ['src/**/*.ts'])) throw new Error('src/**/*.ts should match src/a/b.ts');
      if (matchAny('src/a/b.js', ['src/**/*.ts'])) throw new Error('src/**/*.ts should not match src/a/b.js');
      if (toPosixPath('src\\a\\b.ts') !== 'src/a/b.ts') throw new Error('toPosixPath failed on backslashes');
      if (!matchAny('src\\a\\b.ts', ['src/**/*.ts'])) throw new Error('Windows path should match POSIX glob');
    }],
    ['core-deny-secrets', () => {
      if (!isDenied('.env')) throw new Error('.env must be denied');
      if (!isDenied('sub/.env.production')) throw new Error('sub/.env.production must be denied');
      if (isDenied('.env.example')) throw new Error('.env.example must be allowed');
      if (!isDenied('keys/server.pem')) throw new Error('keys/server.pem must be denied');
      if (!isDenied('.cac/.runtime/tier.json')) throw new Error('.cac/.runtime/tier.json must be denied');
    }],
    ['core-stable-json', () => {
      const actual = stableJson({ b: 1, a: [2, { d: 4, c: 3 }] });
      const expected = '{"a":[2,{"c":3,"d":4}],"b":1}';
      if (actual !== expected) throw new Error(`expected ${expected}, got ${actual}`);
    }],
    ['tier-default-profile-valid', () => {
      const allHookIds = [
        ...DEFAULT_PROFILE.floor,
        ...Object.keys(DEFAULT_PROFILE.hooks),
      ];
      const v = validateProfile(DEFAULT_PROFILE, allHookIds);
      if (v.length > 0) throw new Error('DEFAULT_PROFILE validation failed: ' + JSON.stringify(v));
    }],
    ['tier-monotonic-enforced', () => {
      const broken = {
        ...DEFAULT_PROFILE,
        hooks: {
          ...DEFAULT_PROFILE.hooks,
          'stop-gate': { kind: 'guard', fast: 'block', standard: 'advise', strict: 'block' },
        },
      };
      const allHookIds = [...DEFAULT_PROFILE.floor, ...Object.keys(broken.hooks)];
      const v = validateProfile(broken, allHookIds);
      if (!v.some((x) => x.code === 'NOT_MONOTONIC' && x.hook === 'stop-gate')) {
        throw new Error('expected NOT_MONOTONIC on stop-gate');
      }
    }],
    ['subcommand-flags-complete', () => {
      for (const sub of IMPLEMENTED_SUBCOMMANDS) {
        if (!Object.prototype.hasOwnProperty.call(SUBCOMMAND_FLAGS, sub)) {
          throw new Error(`missing SUBCOMMAND_FLAGS row for ${sub}`);
        }
      }
      for (const key of Object.keys(SUBCOMMAND_FLAGS)) {
        if (!IMPLEMENTED_SUBCOMMANDS.includes(key)) {
          throw new Error(`orphan SUBCOMMAND_FLAGS row: ${key}`);
        }
      }
    }],
  ];
}

async function cmdSelftest() {
  const cases = [...coreSelftestCases()];
  const mod = await tryExt('selftest');
  if (mod && typeof mod.selftestCases === 'function') {
    for (const c of mod.selftestCases()) cases.push(c);
  }
  const failed = [];
  for (const [name, fn] of cases) {
    try {
      await fn();
    } catch (e) {
      failed.push({ name, error: String((e && e.message) || e) });
    }
  }
  const code = failed.length ? 1 : 0;
  return emit({
    status: code === 0 ? 'ok' : 'violation',
    code,
    ok: failed.length === 0,
    tests: cases.length,
    ext: mod ? 'installed' : 'not installed',
    ...(failed.length ? { failed } : {}),
  }, code);
}

async function main() {
  const { cmd, flags, positional } = parseArgs(process.argv.slice(2));
  const unknown = unknownFlags(cmd, flags);
  if (unknown.length) return die(flagUsage(cmd, unknown), 2);

  switch (cmd) {
    case 'doctor':         return cmdDoctor();
    case 'diff-hash':      return cmdDiffHash();
    case 'selftest':       return cmdSelftest();
    case 'tier':           return cmdTier(flags, positional);
    case 'catalog-lint':   return (await ext('catalog')).cmdCatalogLint(flags);
    case 'impact':         return (await ext('graph')).cmdImpact(flags);
    case 'context-pack':   return (await ext('context')).cmdContextPack(flags);
    case 'receipt':        return (await ext('quality')).cmdReceipt(flags, positional);
    case 'verify':         return (await ext('quality')).cmdVerify(flags);
    case 'waiver':         return (await ext('quality')).cmdWaiver(flags, positional);
    case 'attributes':     return (await ext('quality')).cmdAttributes(flags);
    case 'arch-check':     return (await ext('graph')).cmdArchCheck(flags);
    case 'fitness':        return (await ext('scan')).cmdFitness(flags);
    case 'adapters':       return (await ext('scan')).cmdAdapters(flags, positional);
    case 'adr-check':      return (await ext('scan')).cmdAdrCheck(flags);
    case 'arch-trend':     return (await ext('graph')).cmdArchTrend(flags);
    case 'gate':           return (await ext('evidence')).cmdGate(flags);
    case 'ledger':         return (await ext('evidence')).cmdLedger(flags);
    case 'gate-audit':     return (await ext('evidence')).cmdGateAudit(flags);
    case 'retention':      return (await ext('evidence')).cmdRetention(flags);
    case 'risk':           return (await ext('evidence')).cmdRisk(flags);
    case 'task':           return (await ext('task')).cmdTask(flags, positional);
    case 'budget':         return (await ext('task')).cmdBudget(flags);
    case 'spec-lint':      return (await ext('spec')).cmdSpecLint(flags);
    case 'trace':          return (await ext('spec')).cmdTrace(flags);
    case 'spec':           return (await ext('spec')).cmdSpec(flags);
    case 'dod':            return (await ext('spec')).cmdDod(flags);
    case 'review':         return (await ext('review')).cmdReview(flags, positional);
    case 'review-pack':    return (await ext('review')).cmdReviewPack(flags);
    case 'authorship':     return (await ext('review')).cmdAuthorship(flags, positional);
    case 'invariants':     return (await ext('memory')).cmdInvariants(flags);
    case 'recap':          return (await ext('memory')).cmdRecap(flags);
    case 'archive':        return (await ext('memory')).cmdArchive(flags);
    case 'sync-check':     return (await ext('memory')).cmdSyncCheck(flags);
    case 'rules-audit':    return (await ext('rules')).cmdRulesAudit(flags, IMPLEMENTED_SUBCOMMANDS);
    case 'skills-lint':    return (await ext('rules')).cmdSkillsLint(flags);
    case 'agents-md-lint': {
      const rulesMod = await ext('rules');
      const fn = rulesMod.cmdAgentsMdLint || rulesMod.cmdDocLint;
      return fn(flags);
    }
    case 'init':           return (await ext('init')).cmdInit(flags);
    case 'cochange':       return (await ext('graph')).cmdCoChange(flags);
    case 'release':        return (await ext('release')).cmdRelease();
    default:
      return die(usage(cmd), 3);
  }
}

main();
