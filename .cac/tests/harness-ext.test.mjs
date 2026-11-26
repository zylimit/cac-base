// # risk: medium
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REPO_ROOT,
  HARNESS_ENTRY,
  mkTmpRepo,
  cleanupTmp,
  writeFiles,
  gitIn,
  runNode,
} from './helpers.mjs';
import { scanArch } from '../harness/ext/graph.mjs';

test('harness core commands (selftest, diff-hash, doctor) return contract-compliant JSON and exit codes', () => {
  // 1. selftest on REPO_ROOT (includes core + ext selftest cases)
  const selfRes = runNode(HARNESS_ENTRY, ['selftest'], { cwd: REPO_ROOT });
  assert.equal(selfRes.status, 0, `harness selftest failed: ${selfRes.stdout} ${selfRes.stderr}`);
  assert.equal(selfRes.json?.ok, true);
  assert.equal(selfRes.json?.ext, 'installed');
  assert.ok((selfRes.json?.tests || 0) >= 6);

  const dir = mkTmpRepo({
    files: {
      'src/math.ts': 'export const add = (a: number, b: number) => a + b;\n',
    },
  });
  try {
    // 2. diff-hash ignores runtime state files and changes on real code edits
    const dh1 = runNode(HARNESS_ENTRY, ['diff-hash'], { cwd: dir });
    assert.equal(dh1.status, 0);
    assert.equal(dh1.json?.nonGit, false);
    assert.match(dh1.json?.diffHash || '', /^[0-9a-f]{64}$/);

    writeFiles(dir, { '.cac/.needs-review': 'src/math.ts\n' });
    const dhStateOnly = runNode(HARNESS_ENTRY, ['diff-hash'], { cwd: dir });
    assert.equal(dhStateOnly.json?.diffHash, dh1.json?.diffHash, 'Runtime state must not alter canonical diffHash');

    writeFiles(dir, { 'src/math.ts': 'export const add = (a: number, b: number) => a + b + 1;\n' });
    const dhChanged = runNode(HARNESS_ENTRY, ['diff-hash'], { cwd: dir });
    assert.notEqual(dhChanged.json?.diffHash, dh1.json?.diffHash, 'Source edit must change diffHash');

    // 3. Minimal built-in doctor passes when settings.json + profile.json are valid
    const docOk = runNode(HARNESS_ENTRY, ['doctor'], { cwd: dir });
    assert.equal(docOk.status, 0);
    assert.equal(docOk.json?.status, 'ok');
  } finally {
    cleanupTmp(dir);
  }
});

test('[Red-lock D6] arch-check recursively scans module directory paths without EISDIR and catches forbiddenDependencies', () => {
  const catalog = {
    version: 1,
    layers: ['domain', 'infra'],
    modules: [
      {
        id: 'mod-a',
        layer: 'domain',
        paths: ['src/a/**'],
        dependsOn: [],
        forbiddenDependencies: ['mod-b'],
      },
      {
        id: 'mod-b',
        layer: 'infra',
        paths: ['src/b/**'],
        dependsOn: [],
      },
    ],
    ignored: ['README.md', '.cac/**'],
  };

  const dir = mkTmpRepo({
    files: {
      '.cac/harness/module-catalog.json': JSON.stringify(catalog, null, 2) + '\n',
      'src/a/nested/service.ts': "import { queryDb } from '../../b/db.js';\nexport const run = () => queryDb();\n",
      'src/b/db.ts': 'export const queryDb = () => "rows";\n',
    },
  });
  try {
    // 1. Direct programmatic call passing bare directory paths ['src/a', 'src/b'] (legacy D6 threw EISDIR)
    const directReport = scanArch(dir, catalog, { candidatePaths: ['src/a', 'src/b'] });
    assert.equal(directReport.ok, false);
    assert.equal(directReport.scannedFiles, 2);
    assert.equal(directReport.forbiddenDependencies.length, 1);
    assert.equal(directReport.forbiddenDependencies[0].from, 'mod-a');
    assert.equal(directReport.forbiddenDependencies[0].to, 'mod-b');

    // 2. CLI execution via `harness.mjs arch-check`
    const cliRes = runNode(HARNESS_ENTRY, ['arch-check'], { cwd: dir });
    assert.equal(cliRes.status, 1, `Expected exit 1 on forbidden dependency, got ${cliRes.status}: ${cliRes.stderr}`);
    assert.equal(cliRes.json?.ok, false);
    assert.equal(cliRes.json?.forbiddenDependencies?.length, 1);
    assert.equal(cliRes.json?.forbiddenDependencies?.[0]?.from, 'mod-a');
    assert.equal(cliRes.json?.forbiddenDependencies?.[0]?.to, 'mod-b');
  } finally {
    cleanupTmp(dir);
  }
});

test('[Red-lock D9] protected attributes (security/safety/privacy) cannot be fast-skipped or waived, and attributes never emit duplicate gaps', () => {
  const catalog = {
    version: 1,
    checks: {
      'perf-smoke': {
        command: 'node -e "process.exit(0)"',
        class: 'performance',
        attributes: ['performance'],
        allowFastSkip: true,
      },
      'sec-audit': {
        command: 'node -e "process.exit(1)"',
        // Intentionally non-protected `class` while claiming `security` in `attributes[]` (legacy D9 bypass vector!)
        class: 'quality',
        attributes: ['security'],
        allowFastSkip: true,
      },
    },
    modules: [
      {
        id: 'auth',
        paths: ['src/auth/**'],
        verification: ['perf-smoke', 'sec-audit'],
        attributes: {
          security: 'high',
          safety: 'high',
          privacy: 'critical',
          performance: 'medium',
        },
      },
    ],
    ignored: ['README.md', '.cac/**'],
  };

  const dir = mkTmpRepo({
    files: {
      '.cac/harness/module-catalog.json': JSON.stringify(catalog, null, 2) + '\n',
      'src/auth/login.ts': 'export const login = () => true;\n',
    },
  });
  try {
    // 1. `attributes` CLI must report unwired blocking gaps WITHOUT duplicate entries per (module, attribute)
    const attrRes = runNode(HARNESS_ENTRY, ['attributes', '--module', 'auth'], { cwd: dir });
    assert.equal(attrRes.status, 1);
    const reportAttrs = attrRes.json?.attributes || [];
    const attrKeys = reportAttrs.map((a) => `${a.module}:${a.attribute}`);
    assert.equal(
      attrKeys.length,
      new Set(attrKeys).size,
      `attributes output must not contain duplicate rows: ${JSON.stringify(attrKeys)}`,
    );
    assert.equal(attrRes.json?.unwiredBlocking, 2, 'safety(high) and privacy(critical) are unwired -> exactly 2 gaps');

    // 2. `waiver create` rejects security / safety / privacy keywords
    const futureIso = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
    const rejectWaiver = runNode(HARNESS_ENTRY, [
      'waiver', 'create',
      '--owner', 'alice',
      '--scope', 'attribute:auth/security',
      '--reason', 'defer security check',
      '--expiry', futureIso,
      '--compensation', 'manual audit',
    ], { cwd: dir });
    assert.equal(rejectWaiver.status, 1);

    // 3. Even if a syntactically neutral waiver targets checkId `sec-audit`, AND tier is `fast` with `allowFastSkip: true`,
    //    `sec-audit` MUST NOT be skipped or waived!
    const neutralWaiver = runNode(HARNESS_ENTRY, [
      'waiver', 'create',
      '--owner', 'alice',
      '--scope', 'sec-audit',
      '--reason', 'flaky runner environment',
      '--expiry', futureIso,
      '--compensation', 'manual verification',
    ], { cwd: dir });
    assert.equal(neutralWaiver.status, 0, `Neutral-worded waiver creation failed: ${neutralWaiver.stderr}`);

    const setFast = runNode(HARNESS_ENTRY, ['tier', 'set', 'fast', '--hours', '1', '--reason', 'd9-fast-skip-probe'], { cwd: dir });
    assert.equal(setFast.status, 0);

    const verifyRes = runNode(HARNESS_ENTRY, ['verify', '--changed', 'src/auth/login.ts'], { cwd: dir });
    assert.equal(verifyRes.status, 2, 'Protected check failure & unwired protected attributes must block with exit 2');

    const perfCheck = (verifyRes.json?.checks || []).find((c) => c.id === 'perf-smoke');
    const secCheck = (verifyRes.json?.checks || []).find((c) => c.id === 'sec-audit');
    assert.equal(perfCheck?.state, 'SKIPPED', 'Non-protected allowFastSkip check can skip in fast mode');
    assert.equal(secCheck?.state, 'FAIL', 'Protected check claiming security must NEVER be fast-skipped or waived');
    assert.equal(
      (verifyRes.json?.waiversBlocked || []).some((w) => w.check === 'sec-audit' && w.class === 'security'),
      true,
      'Waiver targeting protected check must be recorded in waiversBlocked',
    );

    const gapKeys = (verifyRes.json?.attributeGaps || []).map((g) => `${g.module}:${g.attribute}`);
    assert.equal(gapKeys.length, new Set(gapKeys).size, 'attributeGaps must not contain duplicate gaps');
  } finally {
    cleanupTmp(dir);
  }
});

test('[Red-lock D5] release review-queue passes after .needs-review is marked clean even when audit logs are non-empty', () => {
  const dir = mkTmpRepo({
    files: {
      'src/index.ts': 'export const v = 1;\n',
    },
  });
  try {
    // Seed non-empty historical audit logs + dirty .needs-review first
    writeFiles(dir, {
      '.cac/harness/state/gate-log.jsonl': [
        JSON.stringify({ ts: new Date().toISOString(), gate: 'stop-gate', reason: '1 pending file' }),
        JSON.stringify({ ts: new Date().toISOString(), gate: 'strike-out', reason: 'circuit-breaker' }),
      ].join('\n') + '\n',
      '.cac/harness/state/sessions.jsonl': JSON.stringify({ ts: new Date().toISOString(), event: 'subagent_stop' }) + '\n',
      '.cac/signals.jsonl': JSON.stringify({ ts: new Date().toISOString(), signal: '不对' }) + '\n',
      '.cac/.needs-review': 'src/index.ts\n',
    });

    // While .needs-review has pending file -> review-queue check MUST FAIL
    const dirtyRelease = runNode(HARNESS_ENTRY, ['release'], { cwd: dir });
    const dirtyRq = (dirtyRelease.json?.checks || []).find((c) => c.id === 'review-queue');
    assert.equal(dirtyRq?.status, 'FAIL');

    // Clear review queue (`clean`), keep all historical audit logs intact -> review-queue MUST PASS (Red-lock D5)
    writeFiles(dir, { '.cac/.needs-review': 'clean\n' });
    gitIn(dir, ['status']);

    const cleanRelease = runNode(HARNESS_ENTRY, ['release'], { cwd: dir });
    const cleanRq = (cleanRelease.json?.checks || []).find((c) => c.id === 'review-queue');
    const worktreeChk = (cleanRelease.json?.checks || []).find((c) => c.id === 'worktree');
    const tierChk = (cleanRelease.json?.checks || []).find((c) => c.id === 'tier');

    assert.equal(cleanRq?.status, 'PASS', 'Cleared .needs-review must pass review-queue despite non-empty audit logs');
    assert.equal(cleanRq?.evidence?.pending, 0);
    assert.equal(worktreeChk?.status, 'PASS', 'Audit/state logs must not dirty worktree check');
    assert.equal(tierChk?.status, 'PASS');
    assert.equal(
      (cleanRelease.json?.blockers || []).some((b) => b.id === 'review-queue'),
      false,
      'review-queue must not appear in release blockers after being cleared',
    );
  } finally {
    cleanupTmp(dir);
  }
});

test('run-all.mjs enforces risk level filtering, exit 2 on empty/all-skipped sets, exit 1 on failure, and JSONL ledger recording', () => {
  const dir = mkTmpRepo({ git: false, withProfile: false, withSettings: false });
  try {
    const runner = path.join(REPO_ROOT, '.cac', 'tests', 'run-all.mjs');
    const ledger = path.join(dir, 'ledger.jsonl');
    const emptySuiteDir = path.join(dir, 'empty-suites');

    writeFiles(dir, { 'empty-suites/.keep': '' });

    // 1. Empty matched suite set -> exit 2 (never fake green)
    const emptyRes = runNode(runner, ['--level', 'high', '--dir', emptySuiteDir, '--ledger', ledger]);
    assert.equal(emptyRes.status, 2);

    // 2. All-skipped suite -> exit 2 (never fake green)
    const skipOnlyDir = path.join(dir, 'skip-only');
    writeFiles(dir, {
      'skip-only/skipped.test.mjs': [
        '// # risk: high',
        'import test from "node:test";',
        'test("skipped case", { skip: "pending" }, () => {});',
      ].join('\n') + '\n',
    });
    const skipRes = runNode(runner, ['--level', 'high', '--dir', skipOnlyDir, '--ledger', ledger]);
    assert.equal(skipRes.status, 2);

    // 3. Multi-tier suites: high passes, low fails -> `--level high` exits 0, `--level all` exits 1
    const mixedDir = path.join(dir, 'mixed');
    writeFiles(dir, {
      'mixed/alpha.test.mjs': [
        '// # risk: high',
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'test("alpha high pass", () => { assert.equal(1 + 1, 2); });',
      ].join('\n') + '\n',
      'mixed/beta.test.mjs': [
        '// # risk: medium',
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'test("beta medium pass", () => { assert.equal(2 * 2, 4); });',
      ].join('\n') + '\n',
      'mixed/gamma.test.mjs': [
        '// # risk: low',
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'test("gamma low fail", () => { assert.equal(1, 2); });',
      ].join('\n') + '\n',
    });

    const highOnly = runNode(runner, ['--level', 'high', '--dir', mixedDir, '--ledger', ledger]);
    assert.equal(highOnly.status, 0, `highOnly failed: ${highOnly.stdout} ${highOnly.stderr}`);

    const medAndHigh = runNode(runner, ['--level', 'medium', '--dir', mixedDir, '--ledger', ledger]);
    assert.equal(medAndHigh.status, 0, `medAndHigh failed: ${medAndHigh.stdout} ${medAndHigh.stderr}`);

    const allLevels = runNode(runner, ['--level', 'all', '--dir', mixedDir, '--ledger', ledger]);
    assert.equal(allLevels.status, 1);

    const ledgerLines = fs.readFileSync(ledger, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.equal(ledgerLines.some((r) => r.file === 'alpha.test.mjs' && r.result === 'PASS'), true);
    assert.equal(ledgerLines.some((r) => r.file === 'gamma.test.mjs' && r.result === 'FAIL'), true);
    assert.equal(ledgerLines.some((r) => r.file === 'skipped.test.mjs' && r.result === 'SKIPPED'), true);
  } finally {
    cleanupTmp(dir);
  }
});
