// # risk: high
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..');
const CAC_CLI = path.join(REPO_ROOT, 'scripts', 'cac-base.mjs');
const SETUP_SH = path.join(REPO_ROOT, 'setup.sh');
const PATH_GUARD_CLI = path.join(REPO_ROOT, 'scripts', 'lib', 'path-guard.mjs');
const SETTINGS_MERGE_CLI = path.join(REPO_ROOT, 'scripts', 'lib', 'settings-merge.mjs');
const DOCTOR_CLI = path.join(REPO_ROOT, '.cac', 'scripts', 'doctor.mjs');

const TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'cac-installer-test-'));
let seq = 0;
function nextDir(label) {
  seq += 1;
  return path.join(TMP_BASE, `${seq}-${label}`);
}

after(() => {
  fs.rmSync(TMP_BASE, { recursive: true, force: true });
});

function runNode(script, args = [], opts = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: opts.cwd || REPO_ROOT,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function hasPosixBash() {
  if (process.platform === 'win32') return false;
  const r = spawnSync('bash', ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return !r.error && r.status === 0;
}

function runSetupSh(args = [], opts = {}) {
  return spawnSync('bash', [SETUP_SH, ...args], {
    cwd: opts.cwd || REPO_ROOT,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function lfSha256(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  const norm = Buffer.from(buf.filter((b) => b !== 0x0d));
  return {
    sha256: createHash('sha256').update(norm).digest('hex'),
    bytes: norm.length,
  };
}

describe('installer & setup CLI contract', () => {
  test('[红锁 D7] cac-base.mjs supports positional/<dir>, --target=<dir>, --target <dir>, --dry-run zero write, and rejects --dryrun with rc 2 without creating --dryrun dir', () => {
    const workCwd = nextDir('d7-cwd');
    fs.mkdirSync(workCwd, { recursive: true });

    // 1. Unknown option --dryrun (alone or with target) MUST exit rc 2 and NEVER create a "--dryrun" directory
    const badAlone = runNode(CAC_CLI, ['--dryrun'], { cwd: workCwd });
    assert.equal(badAlone.status, 2, `expected rc 2 for --dryrun, got ${badAlone.status}: ${badAlone.stderr}`);
    assert.equal(fs.existsSync(path.join(workCwd, '--dryrun')), false, 'must NOT create directory named --dryrun');

    const neverCreatedTarget = nextDir('d7-never-created');
    const badWithTarget = runNode(CAC_CLI, ['--dryrun', neverCreatedTarget], { cwd: workCwd });
    assert.equal(badWithTarget.status, 2);
    assert.equal(fs.existsSync(neverCreatedTarget), false);
    assert.equal(fs.existsSync(path.join(workCwd, '--dryrun')), false);

    // 2. --dry-run leaves zero files / directories on disk across all 3 target forms
    const dryPos = nextDir('d7-dry-pos');
    const rDryPos = runNode(CAC_CLI, [dryPos, '--dry-run']);
    assert.equal(rDryPos.status, 0, rDryPos.stderr);
    assert.equal(fs.existsSync(dryPos), false, '--dry-run with positional target must write nothing');

    const dryEq = nextDir('d7-dry-eq');
    const rDryEq = runNode(CAC_CLI, [`--target=${dryEq}`, '--dry-run']);
    assert.equal(rDryEq.status, 0, rDryEq.stderr);
    assert.equal(fs.existsSync(dryEq), false, '--dry-run with --target=<dir> must write nothing');

    const drySpace = nextDir('d7-dry-space');
    const rDrySpace = runNode(CAC_CLI, ['--target', drySpace, '--dry-run']);
    assert.equal(rDrySpace.status, 0, rDrySpace.stderr);
    assert.equal(fs.existsSync(drySpace), false, '--dry-run with --target <dir> must write nothing');

    // 3. Real installs work identically across positional, --target=<dir>, and --target <dir>
    const realPos = nextDir('d7-real-pos');
    assert.equal(runNode(CAC_CLI, [realPos]).status, 0);
    assert.equal(fs.existsSync(path.join(realPos, '.cac', 'FRAMEWORK-MANIFEST.json')), true);

    const realEq = nextDir('d7-real-eq');
    assert.equal(runNode(CAC_CLI, [`--target=${realEq}`]).status, 0);
    assert.equal(fs.existsSync(path.join(realEq, '.cac', 'FRAMEWORK-MANIFEST.json')), true);

    const realSpace = nextDir('d7-real-space');
    assert.equal(runNode(CAC_CLI, ['install', '--target', realSpace]).status, 0);
    assert.equal(fs.existsSync(path.join(realSpace, '.cac', 'FRAMEWORK-MANIFEST.json')), true);
  });

  test('[红锁 D7] setup.sh POSIX wrapper enforces positional, --target=<dir>, --target <dir>, --dry-run zero write, and --dryrun rc 2', { skip: !hasPosixBash() }, () => {
    const workCwd = nextDir('sh-d7-cwd');
    fs.mkdirSync(workCwd, { recursive: true });

    // Misspelled --dryrun must fail immediately with rc 2 and never create "./--dryrun"
    const rBad1 = runSetupSh(['--dryrun'], { cwd: workCwd });
    assert.equal(rBad1.status, 2, `setup.sh --dryrun expected rc 2, got ${rBad1.status}`);
    assert.equal(fs.existsSync(path.join(workCwd, '--dryrun')), false, 'setup.sh must NOT create --dryrun dir');

    const targetNotCreated = nextDir('sh-d7-not-created');
    const rBad2 = runSetupSh([targetNotCreated, '--dryrun'], { cwd: workCwd });
    assert.equal(rBad2.status, 2);
    assert.equal(fs.existsSync(targetNotCreated), false);

    // Missing value for --target must fail with rc 2
    assert.equal(runSetupSh(['--target'], { cwd: workCwd }).status, 2);
    assert.equal(runSetupSh(['--target='], { cwd: workCwd }).status, 2);

    // --dry-run zero write
    const shDry = nextDir('sh-dry');
    const rDry = runSetupSh([shDry, '--dry-run']);
    assert.equal(rDry.status, 0, rDry.stderr);
    assert.equal(fs.existsSync(shDry), false, 'setup.sh --dry-run must leave zero files');

    // Positional, --target=<dir>, and --target <dir> real installs (zero root file intrusion)
    for (const [label, args] of [
      ['sh-pos', (d) => [d]],
      ['sh-eq', (d) => [`--target=${d}`]],
      ['sh-sp', (d) => ['--target', d]],
    ]) {
      const shDir = nextDir(label);
      const rSh = runSetupSh(args(shDir));
      assert.equal(rSh.status, 0, rSh.stderr);
      assert.deepEqual(fs.readdirSync(shDir).sort(), ['.cac'], `${label}: target root must only contain .cac`);
      assert.equal(fs.existsSync(path.join(shDir, 'AGENTS.md')), false, `${label}: root AGENTS.md must not exist`);
      const hiddenAgents = path.join(shDir, '.cac', 'rules', 'AGENTS.md');
      assert.equal(fs.existsSync(hiddenAgents), true, `${label}: .cac/rules/AGENTS.md must exist`);
      assert.ok(fs.statSync(hiddenAgents).size > 0, `${label}: .cac/rules/AGENTS.md must be non-empty`);
    }
  });

  test('path-guard rejects "..", control chars, <>:"|?*, Windows reserved names, and trailing dot/space before any mkdir', () => {
    const parentSandbox = nextDir('path-guard-sandbox');
    fs.mkdirSync(parentSandbox, { recursive: true });

    const unsafeTargets = [
      `${parentSandbox}/../escaped-target`,
      '../escaped-rel',
      'a/../../escape',
      `a/\x07bell/b`,
      `a/\x1fctrl/b`,
      ...['<', '>', ':', '"', '|', '?', '*'].map((ch) => path.join(parentSandbox, `bad${ch}seg`)),
      ...['CON', 'nul', 'aux', 'con.txt', 'lpt1', 'PRN', 'com9'].map((dev) => path.join(parentSandbox, dev)),
      path.join(parentSandbox, 'trailing-dot.'),
      path.join(parentSandbox, 'trailing-space '),
    ];

    for (const badTarget of unsafeTargets) {
      const rGuard = runNode(PATH_GUARD_CLI, [badTarget], { cwd: parentSandbox });
      assert.equal(rGuard.status, 2, `path-guard should reject ${JSON.stringify(badTarget)} with rc 2`);

      const rInst = runNode(CAC_CLI, ['install', '--target', badTarget], { cwd: parentSandbox });
      assert.equal(rInst.status, 2, `installer should reject ${JSON.stringify(badTarget)} with rc 2`);
    }

    // Verify parentSandbox remained completely empty (zero mkdir side effects)
    assert.deepEqual(fs.readdirSync(parentSandbox), [], 'rejected target paths must not create any directory');
  });

  test('default lightweight install produces zero root file intrusion and zero framework repo pollution in target directory', () => {
    const target = nextDir('lightweight-clean');
    const r = runNode(CAC_CLI, ['install', '--target', target, '--json']);
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(r.stdout.trim());
    assert.equal(report.status, 'ok');

    // Top-level directory MUST contain ONLY .cac (zero root file intrusion; no root AGENTS.md)
    const rootEntries = fs.readdirSync(target).sort();
    assert.deepEqual(rootEntries, ['.cac']);

    // Hidden constitution .cac/rules/AGENTS.md MUST exist, be non-empty, and match framework source
    const hiddenAgentsPath = path.join(target, '.cac', 'rules', 'AGENTS.md');
    assert.equal(fs.existsSync(hiddenAgentsPath), true, '.cac/rules/AGENTS.md must exist');
    const hiddenAgentsText = fs.readFileSync(hiddenAgentsPath, 'utf8');
    assert.ok(hiddenAgentsText.trim().length > 0, '.cac/rules/AGENTS.md must be non-empty');
    assert.equal(hiddenAgentsText, fs.readFileSync(path.join(REPO_ROOT, '.cac', 'rules', 'AGENTS.md'), 'utf8'));

    // Manifest must declare seeded: [] and track .cac/rules/AGENTS.md as a regular managed file
    const manifestObj = JSON.parse(fs.readFileSync(path.join(target, '.cac', 'FRAMEWORK-MANIFEST.json'), 'utf8'));
    assert.deepEqual(manifestObj.seeded, []);
    assert.equal(manifestObj.files.some((f) => f.path === '.cac/rules/AGENTS.md'), true);

    // Explicitly verify forbidden root & framework-own artifacts are absent
    const forbiddenRelPaths = [
      'AGENTS.md',
      'progress.md',
      'README.md',
      'ARCHITECTURE.md',
      'setup.sh',
      'setup.ps1',
      'scripts',
      '.github',
      'package.json',
      'docs',
      '.cac/tests',
      '.cac/harness/ext',
      '.cac/rules/harness-large-repo.md',
      '.cac/rules/quality-attributes.md',
      '.cac/FRAMEWORK-MANIFEST-OPTIONAL.json',
      '.cac/.runtime/install.lock',
      '.cac/.runtime/install.marker',
    ];
    for (const rel of forbiddenRelPaths) {
      assert.equal(
        fs.existsSync(path.join(target, rel)),
        false,
        `default lightweight install must NOT copy ${rel}`,
      );
    }

    // Seeded-once templates exist cleanly
    assert.equal(fs.existsSync(path.join(target, '.cac', 'feedback', 'FEEDBACK-INDEX.md')), true);
    assert.equal(fs.existsSync(path.join(target, '.cac', 'EVOLUTION.md')), true);
  });

  test('multi-tool coexistence: install -> upgrade --force -> uninstall --force preserves external AGENTS.md, .claude/CLAUDE.md, .agents/rules/init.md, and .cursor/rules/init.mdc byte-for-byte', () => {
    const target = nextDir('multi-tool-coexist');
    const externalFixtures = {
      'AGENTS.md': Buffer.from('# External Codex / agy-base Root Constitution\r\n\r\n- Keep exact CRLF & UTF-8 bytes (严禁覆盖或误删)!\r\n', 'utf8'),
      '.claude/CLAUDE.md': Buffer.from('# cc-base Claude Constitution\n\n- Managed by .claude toolchain.\n', 'utf8'),
      '.agents/rules/init.md': Buffer.from('---\ntrigger: always_on\n---\n\n# agy-base Init Rule\r\n', 'utf8'),
      '.cursor/rules/init.mdc': Buffer.from('---\ndescription: Cursor workspace rule\nalwaysApply: true\n---\n\nPrefer strict types.\n', 'utf8'),
    };

    for (const [rel, buf] of Object.entries(externalFixtures)) {
      const full = path.join(target, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, buf);
    }

    const assertExternalIntact = (stage) => {
      for (const [rel, expectedBuf] of Object.entries(externalFixtures)) {
        const full = path.join(target, rel);
        assert.equal(fs.existsSync(full), true, `[${stage}] external file ${rel} must still exist`);
        const actualBuf = fs.readFileSync(full);
        assert.equal(
          Buffer.compare(actualBuf, expectedBuf),
          0,
          `[${stage}] external file ${rel} was mutated (expected ${expectedBuf.length}B, got ${actualBuf.length}B)`,
        );
        for (const suffix of ['.bak', '.cac-base-new', '.framework-new']) {
          assert.equal(
            fs.existsSync(`${full}${suffix}`),
            false,
            `[${stage}] external file ${rel} must not get sidecar/backup ${rel}${suffix}`,
          );
        }
      }
    };

    // 1. Fresh install onto multi-tool repository
    const rInst = runNode(CAC_CLI, ['install', '--target', target, '--with-harness', '--json']);
    assert.equal(rInst.status, 0, rInst.stderr);
    const hiddenAgents = path.join(target, '.cac', 'rules', 'AGENTS.md');
    const srcHiddenAgentsBuf = fs.readFileSync(path.join(REPO_ROOT, '.cac', 'rules', 'AGENTS.md'));
    assert.equal(fs.existsSync(hiddenAgents), true);
    assert.equal(Buffer.compare(fs.readFileSync(hiddenAgents), srcHiddenAgentsBuf), 0);
    assertExternalIntact('after install');

    // 2. Customize .cac/rules/AGENTS.md locally, then run `upgrade --force`
    fs.writeFileSync(hiddenAgents, '# Temporary local edit to verify --force overwrites .cac managed file only\n', 'utf8');
    const rUpgForce = runNode(CAC_CLI, ['upgrade', '--force', '--target', target, '--with-harness', '--json']);
    assert.equal(rUpgForce.status, 0, rUpgForce.stderr);
    assert.equal(
      Buffer.compare(fs.readFileSync(hiddenAgents), srcHiddenAgentsBuf),
      0,
      'upgrade --force must restore .cac/rules/AGENTS.md to framework bytes',
    );
    assertExternalIntact('after upgrade --force');

    // 3. Run `uninstall --force` and verify all external files remain byte-for-byte intact
    const rUninstForce = runNode(CAC_CLI, ['uninstall', '--force', '--target', target, '--json']);
    assert.equal(rUninstForce.status, 0, rUninstForce.stderr);
    assert.equal(fs.existsSync(path.join(target, '.cac', 'FRAMEWORK-MANIFEST.json')), false);
    assert.equal(fs.existsSync(path.join(target, '.cac', 'FRAMEWORK-MANIFEST-OPTIONAL.json')), false);
    assert.equal(fs.existsSync(hiddenAgents), false, 'uninstall --force must remove managed .cac/rules/AGENTS.md');
    assert.equal(fs.existsSync(path.join(target, '.cac', 'scripts', 'doctor.mjs')), false);
    assertExternalIntact('after uninstall --force');
  });

  test('3-way lossless upgrade: updates unmodified files with .bak, preserves user-edited .cac/rules/AGENTS.md & rules via .cac-base-new, and never clears FEEDBACK-INDEX.md', () => {
    const target = nextDir('three-way');
    assert.equal(runNode(CAC_CLI, ['install', '--target', target]).status, 0);

    // 1. Simulate unmodified V1 managed file: .cac/rules/dev-workflow-details.md matches old manifest sha256
    const unmodifiedRel = '.cac/rules/dev-workflow-details.md';
    const unmodifiedFull = path.join(target, unmodifiedRel);
    const v2Content = fs.readFileSync(unmodifiedFull, 'utf8');
    const v1Content = '# Legacy V1 dev-workflow-details (unmodified by user)\n';
    fs.writeFileSync(unmodifiedFull, v1Content, 'utf8');

    const manifestPath = path.join(target, '.cac', 'FRAMEWORK-MANIFEST.json');
    const manifestObj = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const entry = manifestObj.files.find((f) => f.path === unmodifiedRel);
    assert.ok(entry, `expected ${unmodifiedRel} in FRAMEWORK-MANIFEST.json`);
    const v1Hash = lfSha256(v1Content);
    entry.sha256 = v1Hash.sha256;
    entry.bytes = v1Hash.bytes;
    fs.writeFileSync(manifestPath, JSON.stringify(manifestObj, null, 2) + '\n', 'utf8');

    // 2. Simulate user-edited .cac/rules/file-structure.md and .cac/rules/AGENTS.md
    const userRuleRel = '.cac/rules/file-structure.md';
    const userRuleFull = path.join(target, userRuleRel);
    const userRuleCustom = fs.readFileSync(userRuleFull, 'utf8') + '\n<!-- USER_CUSTOM_FILE_STRUCTURE_RULE -->\n';
    fs.writeFileSync(userRuleFull, userRuleCustom, 'utf8');

    const agentsRel = '.cac/rules/AGENTS.md';
    const agentsFull = path.join(target, agentsRel);
    const agentsCustom = fs.readFileSync(agentsFull, 'utf8') + '\n# Project-Specific Domain Constitution\n';
    fs.writeFileSync(agentsFull, agentsCustom, 'utf8');

    // 3. Simulate accumulated project feedback in .cac/feedback/FEEDBACK-INDEX.md
    const fbIndexFull = path.join(target, '.cac', 'feedback', 'FEEDBACK-INDEX.md');
    const fbCustom = '# FEEDBACK-INDEX\n\n- fb-2026-11-26-001: Keep custom project feedback intact!\n';
    fs.writeFileSync(fbIndexFull, fbCustom, 'utf8');

    // Execute upgrade
    const rUpg = runNode(CAC_CLI, ['upgrade', '--target', target, '--json']);
    assert.equal(rUpg.status, 0, rUpg.stderr);
    const upgReport = JSON.parse(rUpg.stdout.trim());
    assert.equal(upgReport.status, 'ok');
    assert.ok(upgReport.conflicts.includes(agentsRel));
    assert.ok(upgReport.conflicts.includes(userRuleRel));

    // Verify Case A: unmodified V1 file auto-updated to V2 and left .bak with V1 content
    assert.equal(fs.readFileSync(unmodifiedFull, 'utf8'), v2Content);
    assert.equal(fs.existsSync(`${unmodifiedFull}.bak`), true, 'expected .bak backup for updated managed file');
    assert.equal(fs.readFileSync(`${unmodifiedFull}.bak`, 'utf8'), v1Content);

    // Verify Case B: user-modified files were NEVER overwritten, and .cac-base-new sidecars hold framework version
    assert.equal(fs.readFileSync(userRuleFull, 'utf8'), userRuleCustom, 'user edit in file-structure.md must not be overwritten');
    assert.equal(fs.existsSync(`${userRuleFull}.cac-base-new`), true);
    assert.equal(
      fs.readFileSync(`${userRuleFull}.cac-base-new`, 'utf8'),
      fs.readFileSync(path.join(REPO_ROOT, userRuleRel), 'utf8'),
    );

    assert.equal(fs.readFileSync(agentsFull, 'utf8'), agentsCustom, 'user edit in .cac/rules/AGENTS.md must not be overwritten');
    assert.equal(fs.existsSync(`${agentsFull}.cac-base-new`), true);
    assert.equal(
      fs.readFileSync(`${agentsFull}.cac-base-new`, 'utf8'),
      fs.readFileSync(path.join(REPO_ROOT, agentsRel), 'utf8'),
    );
    assert.equal(fs.existsSync(path.join(target, 'AGENTS.md')), false, 'upgrade must never create root AGENTS.md');
    assert.equal(fs.existsSync(path.join(target, 'AGENTS.md.cac-base-new')), false);

    // Verify Case C: FEEDBACK-INDEX.md was NEVER cleared or overwritten
    assert.equal(fs.readFileSync(fbIndexFull, 'utf8'), fbCustom, 'FEEDBACK-INDEX.md must never be overwritten on upgrade');
    assert.equal(fs.existsSync(`${fbIndexFull}.cac-base-new`), false);
  });

  test('optional packages independent bookkeeping: --with-harness installs ext + rules, and subsequent --with-tests preserves harness entries in FRAMEWORK-MANIFEST-OPTIONAL.json', () => {
    const target = nextDir('optional-pkgs');

    // Step 1: install with --with-harness
    const rHarness = runNode(CAC_CLI, ['install', '--target', target, '--with-harness']);
    assert.equal(rHarness.status, 0, rHarness.stderr);
    assert.equal(fs.existsSync(path.join(target, '.cac', 'harness', 'ext')), true);
    assert.equal(fs.existsSync(path.join(target, '.cac', 'rules', 'harness-large-repo.md')), true);
    assert.equal(fs.existsSync(path.join(target, '.cac', 'rules', 'quality-attributes.md')), true);

    const optManifestPath = path.join(target, '.cac', 'FRAMEWORK-MANIFEST-OPTIONAL.json');
    assert.equal(fs.existsSync(optManifestPath), true);
    const optAfterHarness = JSON.parse(fs.readFileSync(optManifestPath, 'utf8'));
    const harnessPaths = optAfterHarness.files.map((f) => f.path);
    assert.ok(harnessPaths.some((p) => p.startsWith('.cac/harness/ext/')));
    assert.ok(harnessPaths.includes('.cac/rules/harness-large-repo.md'));

    // Step 2: run upgrade with ONLY --with-tests (do NOT pass --with-harness)
    const rTests = runNode(CAC_CLI, ['upgrade', '--target', target, '--with-tests']);
    assert.equal(rTests.status, 0, rTests.stderr);
    assert.equal(fs.existsSync(path.join(target, '.cac', 'tests', 'installer.test.mjs')), true);

    const optAfterTests = JSON.parse(fs.readFileSync(optManifestPath, 'utf8'));
    const mergedPaths = new Set(optAfterTests.files.map((f) => f.path));

    // Every previously recorded harness entry MUST still be present alongside new test entries
    for (const hp of harnessPaths) {
      assert.equal(mergedPaths.has(hp), true, `FRAMEWORK-MANIFEST-OPTIONAL.json lost harness entry ${hp}`);
    }
    assert.equal(mergedPaths.has('.cac/tests/installer.test.mjs'), true);

    // Doctor validates both core and optional manifests cleanly
    const rDoc = runNode(DOCTOR_CLI, [target, '--json']);
    assert.equal(rDoc.status, 0, rDoc.stdout + rDoc.stderr);
  });

  test('CAC_SETUP_FAIL_AFTER=3 fault injection writes interrupted install.marker and clean re-run recovers automatically', () => {
    const target = nextDir('fault-inject');

    const rFail = runNode(CAC_CLI, ['install', '--target', target], {
      env: { CAC_SETUP_FAIL_AFTER: '3' },
    });
    assert.notEqual(rFail.status, 0, 'fault-injected install must exit non-zero');

    const markerPath = path.join(target, '.cac', '.runtime', 'install.marker');
    const lockPath = path.join(target, '.cac', '.runtime', 'install.lock');
    assert.equal(fs.existsSync(markerPath), true, 'interrupted install.marker must remain on disk');
    assert.equal(fs.existsSync(lockPath), false, 'install.lock must be released in finally block');

    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    assert.equal(marker.status, 'interrupted');
    assert.equal(marker.written.length, 3);

    // Re-running install without fault injection recovers cleanly and removes install.marker
    const rRecover = runNode(CAC_CLI, ['install', '--target', target]);
    assert.equal(rRecover.status, 0, rRecover.stderr);
    assert.equal(fs.existsSync(markerPath), false, 'recovery install must clean up install.marker');

    const rDoc = runNode(DOCTOR_CLI, [target, '--json']);
    assert.equal(rDoc.status, 0, rDoc.stdout + rDoc.stderr);
  });

  test('settings-merge preserves custom settings/hooks and performs lossless string <-> exec round-trip', () => {
    const target = nextDir('settings-roundtrip');
    fs.mkdirSync(path.join(target, '.cac'), { recursive: true });

    const preExistingSettings = {
      customProjectOption: { enabled: true, owner: 'team-alpha' },
      permissions: {
        allow: ['Bash(npm test)'],
        deny: ['Read(config/local-secret.yaml)'],
      },
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash|PowerShell|Shell',
            hooks: [
              { type: 'command', command: 'bash .cac/hooks/legacy-guard.sh' },
              { type: 'command', command: 'node scripts/custom-audit-hook.mjs' },
            ],
          },
        ],
      },
    };
    const settingsPath = path.join(target, '.cac', 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify(preExistingSettings, null, 2) + '\n', 'utf8');

    // 1. Install with default hook form (string)
    assert.equal(runNode(CAC_CLI, ['install', '--target', target]).status, 0);
    const strRaw1 = fs.readFileSync(settingsPath, 'utf8');
    const strObj1 = JSON.parse(strRaw1);

    assert.deepEqual(strObj1.customProjectOption, { enabled: true, owner: 'team-alpha' });
    assert.ok(strObj1.permissions.allow.includes('Bash(npm test)'));
    assert.ok(strObj1.permissions.deny.includes('Read(config/local-secret.yaml)'));
    assert.ok(strObj1.permissions.deny.includes('Read(.env)'), 'security floor deny must be unioned');

    const preHooksStr = strObj1.hooks.PreToolUse.flatMap((g) => g.hooks);
    assert.equal(
      preHooksStr.some((h) => String(h.command || '').includes('legacy-guard.sh')),
      false,
      'legacy .cac/hooks/*.sh entry should be cleaned',
    );
    assert.equal(
      preHooksStr.some((h) => h.command === 'node scripts/custom-audit-hook.mjs'),
      true,
      'user custom hook must be preserved',
    );
    assert.equal(runNode(SETTINGS_MERGE_CLI, ['--check', '--file', settingsPath]).stdout.trim(), 'string');

    // 2. Switch to --hook-form exec
    assert.equal(runNode(CAC_CLI, ['upgrade', '--target', target, '--hook-form', 'exec']).status, 0);
    const execObj = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(runNode(SETTINGS_MERGE_CLI, ['--check', '--file', settingsPath]).stdout.trim(), 'exec');
    const preHooksExec = execObj.hooks.PreToolUse.flatMap((g) => g.hooks);
    assert.equal(
      preHooksExec.some((h) => h.command === 'node' && Array.isArray(h.args) && h.args[0] === '.cac/hooks/secret-exfil-guard.mjs'),
      true,
    );
    assert.equal(
      preHooksExec.some((h) => h.command === 'node scripts/custom-audit-hook.mjs' && !('args' in h)),
      true,
      'custom hook must not be mutated during exec conversion',
    );

    // 3. Switch back to --hook-form string -> byte-identical to initial merged string settings
    assert.equal(runNode(CAC_CLI, ['upgrade', '--target', target, '--hook-form', 'string']).status, 0);
    const strRaw2 = fs.readFileSync(settingsPath, 'utf8');
    assert.equal(strRaw2, strRaw1, 'string -> exec -> string round-trip must be byte-for-byte lossless');
  });

  test('--uninstall removes unmodified managed files (including unmodified .cac/rules/AGENTS.md) while preserving user-modified .cac/rules/AGENTS.md, modified rules, and user project files', () => {
    // Part A: when .cac/rules/AGENTS.md is customized by the user, non-force --uninstall preserves it
    const target = nextDir('uninstall-safe');
    assert.equal(runNode(CAC_CLI, ['install', '--target', target, '--with-harness']).status, 0);

    // Add a user source file, customize .cac/rules/AGENTS.md, and modify one managed .cac rule
    const userSrc = path.join(target, 'src', 'app.mjs');
    fs.mkdirSync(path.dirname(userSrc), { recursive: true });
    fs.writeFileSync(userSrc, 'export const ok = true;\n', 'utf8');

    const agentsRel = '.cac/rules/AGENTS.md';
    const agentsPath = path.join(target, agentsRel);
    const customAgents = fs.readFileSync(agentsPath, 'utf8') + '\n# Keep customized constitution on non-force uninstall\n';
    fs.writeFileSync(agentsPath, customAgents, 'utf8');

    const modifiedRuleRel = '.cac/rules/file-structure.md';
    const modifiedRulePath = path.join(target, modifiedRuleRel);
    const customRule = fs.readFileSync(modifiedRulePath, 'utf8') + '\n<!-- user modified -->\n';
    fs.writeFileSync(modifiedRulePath, customRule, 'utf8');

    const rUninst = runNode(CAC_CLI, ['--uninstall', '--target', target, '--json']);
    assert.equal(rUninst.status, 0, rUninst.stderr);
    const res = JSON.parse(rUninst.stdout.trim());
    assert.equal(res.status, 'ok');
    assert.ok(res.keptModified.includes(agentsRel));
    assert.ok(res.keptModified.includes(modifiedRuleRel));

    // Unmodified managed files and manifests are removed
    assert.equal(fs.existsSync(path.join(target, '.cac', 'FRAMEWORK-MANIFEST.json')), false);
    assert.equal(fs.existsSync(path.join(target, '.cac', 'FRAMEWORK-MANIFEST-OPTIONAL.json')), false);
    assert.equal(fs.existsSync(path.join(target, '.cac', 'scripts', 'doctor.mjs')), false);
    assert.equal(fs.existsSync(path.join(target, '.cac', 'rules', 'dev-workflow-details.md')), false);

    // User-modified .cac/rules/AGENTS.md, modified rule, user source file, FEEDBACK-INDEX.md, and EVOLUTION.md are preserved
    assert.equal(fs.readFileSync(agentsPath, 'utf8'), customAgents);
    assert.equal(fs.existsSync(userSrc), true);
    assert.equal(fs.readFileSync(modifiedRulePath, 'utf8'), customRule);
    assert.equal(fs.existsSync(path.join(target, '.cac', 'feedback', 'FEEDBACK-INDEX.md')), true);
    assert.equal(fs.existsSync(path.join(target, '.cac', 'EVOLUTION.md')), true);

    // Part B: when .cac/rules/AGENTS.md is unmodified, non-force --uninstall removes it cleanly
    const cleanTarget = nextDir('uninstall-unmodified-agents');
    assert.equal(runNode(CAC_CLI, ['install', '--target', cleanTarget]).status, 0);
    assert.equal(fs.existsSync(path.join(cleanTarget, agentsRel)), true);
    const rCleanUninst = runNode(CAC_CLI, ['--uninstall', '--target', cleanTarget, '--json']);
    assert.equal(rCleanUninst.status, 0, rCleanUninst.stderr);
    assert.equal(fs.existsSync(path.join(cleanTarget, agentsRel)), false, 'unmodified .cac/rules/AGENTS.md must be removed on uninstall');
  });

  test('[Regression MEDIUM-6] settings-merge does not duplicate secret-exfil-guard.mjs on upgrade when node.exe "${CODEAGENT3_PROJECT_DIR}\\.cac\\hooks\\..." already exists', () => {
    const target = nextDir('settings-win-nodeexe-dedup');
    assert.equal(runNode(CAC_CLI, ['install', '--target', target]).status, 0);

    const settingsPath = path.join(target, '.cac', 'settings.json');
    const current = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

    // Replace secret-exfil-guard command with Windows node.exe + ${CODEAGENT3_PROJECT_DIR}\.cac\hooks\... form
    let replaced = false;
    for (const group of current.hooks.PreToolUse || []) {
      for (const h of group.hooks || []) {
        if (String(h.command || '').includes('secret-exfil-guard.mjs')) {
          h.command = 'node.exe "${CODEAGENT3_PROJECT_DIR}\\.cac\\hooks\\secret-exfil-guard.mjs"';
          replaced = true;
        }
      }
    }
    assert.equal(replaced, true, 'fixture setup must locate secret-exfil-guard.mjs in installed settings.json');
    current.hooks.PreToolUse[0].hooks.push({
      type: 'command',
      command: 'node scripts/custom-company-check.mjs',
    });
    fs.writeFileSync(settingsPath, JSON.stringify(current, null, 2) + '\n', 'utf8');

    const rUpg = runNode(CAC_CLI, ['upgrade', '--target', target]);
    assert.equal(rUpg.status, 0, rUpg.stderr);

    const afterStr = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const allPreHooks = (afterStr.hooks.PreToolUse || []).flatMap((g) => g.hooks || []);
    const secretGuardMatches = allPreHooks.filter((h) => {
      const text = `${h.command || ''} ${Array.isArray(h.args) ? h.args.join(' ') : ''}`;
      return text.includes('secret-exfil-guard.mjs');
    });
    assert.equal(
      secretGuardMatches.length,
      1,
      `Expected exactly 1 secret-exfil-guard.mjs hook after upgrade, got ${secretGuardMatches.length}: ${JSON.stringify(secretGuardMatches)}`,
    );
    assert.equal(
      allPreHooks.filter((h) => h.command === 'node scripts/custom-company-check.mjs').length,
      1,
      'User custom hook must remain intact without duplication',
    );

    // Also verify switching to --hook-form exec still yields exactly 1 secret-exfil-guard.mjs
    fs.writeFileSync(settingsPath, JSON.stringify(current, null, 2) + '\n', 'utf8');
    const rExec = runNode(CAC_CLI, ['upgrade', '--target', target, '--hook-form', 'exec']);
    assert.equal(rExec.status, 0, rExec.stderr);
    const afterExec = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const execMatches = (afterExec.hooks.PreToolUse || []).flatMap((g) => g.hooks || []).filter((h) => {
      const text = `${h.command || ''} ${Array.isArray(h.args) ? h.args.join(' ') : ''}`;
      return text.includes('secret-exfil-guard.mjs');
    });
    assert.equal(execMatches.length, 1, 'Expected exactly 1 secret-exfil-guard.mjs hook after --hook-form exec upgrade');
  });

  test('[Regression LOW-1] --uninstall --force preserves settings.json when user added private permissions.deny rule Read(config/prod.key)', () => {
    const target = nextDir('uninstall-force-private-deny');
    assert.equal(runNode(CAC_CLI, ['install', '--target', target]).status, 0);

    const settingsPath = path.join(target, '.cac', 'settings.json');
    const settingsObj = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    settingsObj.permissions = settingsObj.permissions || {};
    settingsObj.permissions.deny = Array.isArray(settingsObj.permissions.deny) ? settingsObj.permissions.deny : [];
    settingsObj.permissions.deny.push('Read(config/prod.key)');
    fs.writeFileSync(settingsPath, JSON.stringify(settingsObj, null, 2) + '\n', 'utf8');

    const rUninst = runNode(CAC_CLI, ['--uninstall', '--force', '--target', target, '--json']);
    assert.equal(rUninst.status, 0, rUninst.stderr);

    // Framework-managed manifest and scripts are removed
    assert.equal(fs.existsSync(path.join(target, '.cac', 'FRAMEWORK-MANIFEST.json')), false);
    assert.equal(fs.existsSync(path.join(target, '.cac', 'scripts', 'doctor.mjs')), false);

    // settings.json MUST be preserved because it holds user-private permissions.deny rule
    assert.equal(
      fs.existsSync(settingsPath),
      true,
      '--uninstall --force must NOT delete .cac/settings.json when user added private permissions.deny rules',
    );
    const remaining = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(
      Array.isArray(remaining?.permissions?.deny) && remaining.permissions.deny.includes('Read(config/prod.key)'),
      true,
      'User private rule Read(config/prod.key) must remain in settings.json after --uninstall --force',
    );
  });

  test('[Regression] manifest --check detects stale extra seeded entries in .cac/FRAMEWORK-MANIFEST.json and exits 1', () => {
    const target = nextDir('manifest-stale-seeded');
    assert.equal(runNode(CAC_CLI, ['install', '--target', target]).status, 0);

    // Precondition: clean installed target passes manifest --check with seeded: []
    const rClean = runNode(CAC_CLI, ['manifest', '--check', '--target', target]);
    assert.equal(rClean.status, 0, `baseline manifest --check failed: ${rClean.stdout} ${rClean.stderr}`);
    const cleanJson = JSON.parse(rClean.stdout.trim());
    assert.equal(cleanJson.status, 'ok');
    assert.deepEqual(cleanJson.problems, []);

    const manifestPath = path.join(target, '.cac', 'FRAMEWORK-MANIFEST.json');
    const manifestObj = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.deepEqual(manifestObj.seeded, []);
    assert.equal(fs.existsSync(path.join(target, 'AGENTS.md')), false);

    // 1. Inject stale seeded entry while actual seeded on disk is empty -> must exit 1
    manifestObj.seeded = [
      {
        path: 'AGENTS.md',
        sha256: '0'.repeat(64),
        bytes: 1,
      },
    ];
    fs.writeFileSync(manifestPath, JSON.stringify(manifestObj, null, 2) + '\n', 'utf8');

    const rStale = runNode(CAC_CLI, ['manifest', '--check', '--target', target]);
    assert.equal(
      rStale.status,
      1,
      `manifest --check must exit 1 on stale extra seeded entry, got ${rStale.status}: ${rStale.stdout} ${rStale.stderr}`,
    );
    const staleJson = JSON.parse(rStale.stdout.trim());
    assert.equal(staleJson.code, 1);
    assert.equal(staleJson.status, 'violation');
    assert.ok(Array.isArray(staleJson.problems) && staleJson.problems.length >= 1);
    assert.ok(
      staleJson.problems.some((p) => p.includes('seeded') && p.includes('AGENTS.md')),
      `expected seeded drift problem mentioning AGENTS.md, got: ${JSON.stringify(staleJson.problems)}`,
    );

    // 2. Even if an external root AGENTS.md exists on disk with matching hash/bytes, stale seeded must still exit 1
    const extAgents = 'x';
    fs.writeFileSync(path.join(target, 'AGENTS.md'), extAgents, 'utf8');
    const extHash = lfSha256(extAgents);
    manifestObj.seeded = [
      {
        path: 'AGENTS.md',
        sha256: extHash.sha256,
        bytes: extHash.bytes,
      },
    ];
    fs.writeFileSync(manifestPath, JSON.stringify(manifestObj, null, 2) + '\n', 'utf8');

    const rStaleWithExt = runNode(CAC_CLI, ['manifest', '--check', '--target', target]);
    assert.equal(
      rStaleWithExt.status,
      1,
      'manifest --check must still exit 1 on stale seeded entry when external root AGENTS.md exists',
    );

    // 3. Restoring seeded: [] returns manifest --check to exit 0
    manifestObj.seeded = [];
    fs.writeFileSync(manifestPath, JSON.stringify(manifestObj, null, 2) + '\n', 'utf8');
    const rRestored = runNode(CAC_CLI, ['manifest', '--check', '--target', target]);
    assert.equal(rRestored.status, 0, `restored manifest --check failed: ${rRestored.stdout}`);
  });

  test('[Regression v1.2.0] fresh install ships all 194 managed assets, 7 core rules, headerless SiteMaster AGENTS.md, adapters.json, and representative cc-base 1:1 fused examples/references', () => {
    const target = nextDir('v120-full-194-assets');
    const rInst = runNode(CAC_CLI, ['install', '--target', target, '--json']);
    assert.equal(rInst.status, 0, `install failed: ${rInst.stderr}`);
    const report = JSON.parse(rInst.stdout.trim());
    assert.equal(report.status, 'ok');

    // 1. FRAMEWORK-MANIFEST.json tracks all 194 managed files (0 seeded), all present and non-empty on disk
    const manifestObj = JSON.parse(fs.readFileSync(path.join(target, '.cac', 'FRAMEWORK-MANIFEST.json'), 'utf8'));
    assert.equal(manifestObj.version, 1);
    assert.equal(manifestObj.engine, 'cac-base');
    assert.deepEqual(manifestObj.seeded, []);
    assert.equal(manifestObj.files.length, 194, `expected 194 managed files in FRAMEWORK-MANIFEST.json, got ${manifestObj.files.length}`);
    for (const item of manifestObj.files) {
      const full = path.join(target, ...item.path.split('/'));
      assert.equal(fs.existsSync(full), true, `managed asset missing after install: ${item.path}`);
      assert.ok(fs.statSync(full).size > 0, `managed asset must be non-empty: ${item.path}`);
    }

    // 2. Headerless .cac/rules/AGENTS.md carries SiteMaster constitution + pointer to workflow-orchestration.md + startup boundary
    const agentsText = fs.readFileSync(path.join(target, '.cac', 'rules', 'AGENTS.md'), 'utf8');
    assert.equal(/^---(?:[ \t]*\r?\n|[ \t]*$)/.test(agentsText.replace(/^\uFEFF/, '')), false, '.cac/rules/AGENTS.md must never start with YAML frontmatter');
    assert.match(agentsText, /SiteMaster/);
    assert.match(agentsText, /\.cac\/rules\/workflow-orchestration\.md/);
    assert.match(agentsText, /当前项目启动快照/);

    // 3. All 7 core rules (including 7th rule .cac/rules/workflow-orchestration.md) exist and are non-empty
    const expectedCoreRules = [
      '.cac/rules/dev-workflow-details.md',
      '.cac/rules/subagent-dispatch.md',
      '.cac/rules/workflow-orchestration.md',
      '.cac/rules/file-structure.md',
      '.cac/rules/memory-systems.md',
      '.cac/rules/design-detail.md',
      '.cac/rules/domain-rulings.md',
    ];
    for (const rel of expectedCoreRules) {
      const full = path.join(target, ...rel.split('/'));
      assert.equal(fs.existsSync(full), true, `core rule must exist: ${rel}`);
      const content = fs.readFileSync(full, 'utf8');
      assert.ok(content.trim().length > 0, `core rule must be non-empty: ${rel}`);
    }

    // 4. .cac/harness/adapters.json (valid JSON) + .cac/harness/audit/README.md + practical examples & references exist and are non-empty
    const adaptersFull = path.join(target, '.cac', 'harness', 'adapters.json');
    assert.equal(fs.existsSync(adaptersFull), true, '.cac/harness/adapters.json must exist');
    const adaptersRaw = fs.readFileSync(adaptersFull, 'utf8');
    assert.ok(adaptersRaw.trim().length > 0, '.cac/harness/adapters.json must be non-empty');
    const adaptersParsed = JSON.parse(adaptersRaw);
    assert.equal(typeof adaptersParsed === 'object' && adaptersParsed !== null && !Array.isArray(adaptersParsed), true);

    const requiredFusedAssets = [
      '.cac/harness/audit/README.md',
      '.cac/skills/product-spec-builder/examples/after-sales-dispatch.md',
      '.cac/skills/design-brief-builder/examples/after-sales-dispatch-brief.md',
      '.cac/skills/design-brief-builder/examples/after-sales-dispatch-DESIGN.md',
      '.cac/skills/arch-designer/examples/after-sales-dispatch-arch.md',
      '.cac/skills/dfx-designer/examples/after-sales-dispatch-dfx.md',
      '.cac/skills/design-brief-builder/references/direction-examples.md',
      '.cac/skills/product-spec-builder/references/discovery-examples.md',
      '.cac/skills/product-spec-builder/references/discovery-methods.md',
      '.cac/skills/product-spec-builder/references/reservation-case.md',
    ];
    for (const rel of requiredFusedAssets) {
      const full = path.join(target, ...rel.split('/'));
      assert.equal(fs.existsSync(full), true, `expected fused asset to be installed: ${rel}`);
      const text = fs.readFileSync(full, 'utf8');
      assert.ok(text.trim().length > 0, `expected fused asset to be non-empty: ${rel}`);
    }

    // 5. All 22 skills and 9 sub-agents exist and are non-empty
    const skillDirs = fs.readdirSync(path.join(target, '.cac', 'skills'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'));
    assert.equal(skillDirs.length, 22, `expected 22 skill directories, got ${skillDirs.length}`);
    for (const d of skillDirs) {
      const sk = path.join(target, '.cac', 'skills', d.name, 'SKILL.md');
      assert.equal(fs.existsSync(sk), true, `missing SKILL.md for ${d.name}`);
      assert.ok(fs.readFileSync(sk, 'utf8').trim().length > 0, `empty SKILL.md for ${d.name}`);
    }

    const agentFiles = fs.readdirSync(path.join(target, '.cac', 'agents'))
      .filter((n) => n.endsWith('.md'));
    assert.equal(agentFiles.length, 9, `expected 9 sub-agent definitions, got ${agentFiles.length}`);
  });

  test('[Regression HIGH-2] cac-base.mjs rejects bare subcommand typo "package" with exit 2, hints release/pack-check, and never creates ./package directory', () => {
    const workCwd = nextDir('high2-typo-package-cwd');
    fs.mkdirSync(workCwd, { recursive: true });

    const rPkg = runNode(CAC_CLI, ['package'], { cwd: workCwd });
    assert.equal(rPkg.status, 2, `expected exit 2 for "cac-base.mjs package", got ${rPkg.status}: ${rPkg.stderr}`);
    assert.match(rPkg.stderr, /release/i, 'stderr must suggest "release"');
    assert.match(rPkg.stderr, /pack-check/i, 'stderr must suggest "pack-check"');
    assert.equal(fs.existsSync(path.join(workCwd, 'package')), false, 'must NOT create ./package directory');
    assert.deepEqual(fs.readdirSync(workCwd), [], 'working directory must remain completely empty');

    // Representative bare subcommand typos also fail fast with exit 2 and zero directory creation
    for (const typo of ['pack', 'check']) {
      const rTypo = runNode(CAC_CLI, [typo], { cwd: workCwd });
      assert.equal(rTypo.status, 2, `expected exit 2 for bare typo "${typo}", got ${rTypo.status}`);
      assert.equal(fs.existsSync(path.join(workCwd, typo)), false, `must NOT create ./${typo} directory`);
    }
    assert.deepEqual(fs.readdirSync(workCwd), [], 'working directory must still be completely empty');

    // Explicit --target ./package escape hatch remains valid when user intentionally targets "./package"
    const rExplicitDry = runNode(CAC_CLI, ['install', '--target', './package', '--dry-run'], { cwd: workCwd });
    assert.equal(rExplicitDry.status, 0, `explicit --target ./package --dry-run failed: ${rExplicitDry.stderr}`);
    assert.equal(fs.existsSync(path.join(workCwd, 'package')), false, '--dry-run must still leave zero files');
  });
});
