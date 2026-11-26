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

    // Positional, --target=<dir>, and --target <dir> real installs
    const shPos = nextDir('sh-pos');
    assert.equal(runSetupSh([shPos]).status, 0);
    assert.equal(fs.existsSync(path.join(shPos, 'AGENTS.md')), true);

    const shEq = nextDir('sh-eq');
    assert.equal(runSetupSh([`--target=${shEq}`]).status, 0);
    assert.equal(fs.existsSync(path.join(shEq, 'AGENTS.md')), true);

    const shSp = nextDir('sh-sp');
    assert.equal(runSetupSh(['--target', shSp]).status, 0);
    assert.equal(fs.existsSync(path.join(shSp, 'AGENTS.md')), true);
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

  test('default lightweight install produces zero framework repo pollution in target directory', () => {
    const target = nextDir('lightweight-clean');
    const r = runNode(CAC_CLI, ['install', '--target', target, '--json']);
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(r.stdout.trim());
    assert.equal(report.status, 'ok');

    // Top-level directory MUST contain ONLY .cac and AGENTS.md
    const rootEntries = fs.readdirSync(target).sort();
    assert.deepEqual(rootEntries, ['.cac', 'AGENTS.md']);

    // Explicitly verify forbidden framework-own artifacts are absent
    const forbiddenRelPaths = [
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

  test('3-way lossless upgrade: updates unmodified files with .bak, preserves user-edited rules & AGENTS.md via .cac-base-new, and never clears FEEDBACK-INDEX.md', () => {
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

    // 2. Simulate user-edited .cac/rules/file-structure.md and root AGENTS.md
    const userRuleRel = '.cac/rules/file-structure.md';
    const userRuleFull = path.join(target, userRuleRel);
    const userRuleCustom = fs.readFileSync(userRuleFull, 'utf8') + '\n<!-- USER_CUSTOM_FILE_STRUCTURE_RULE -->\n';
    fs.writeFileSync(userRuleFull, userRuleCustom, 'utf8');

    const agentsFull = path.join(target, 'AGENTS.md');
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
    assert.ok(upgReport.conflicts.includes('AGENTS.md'));
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

    assert.equal(fs.readFileSync(agentsFull, 'utf8'), agentsCustom, 'user edit in AGENTS.md must not be overwritten');
    assert.equal(fs.existsSync(`${agentsFull}.cac-base-new`), true);
    assert.equal(
      fs.readFileSync(`${agentsFull}.cac-base-new`, 'utf8'),
      fs.readFileSync(path.join(REPO_ROOT, 'AGENTS.md'), 'utf8'),
    );

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

  test('--uninstall removes only unmodified managed files while preserving AGENTS.md, user project files, and modified .cac files', () => {
    const target = nextDir('uninstall-safe');
    assert.equal(runNode(CAC_CLI, ['install', '--target', target, '--with-harness']).status, 0);

    // Add a user source file, customize AGENTS.md, and modify one managed .cac rule
    const userSrc = path.join(target, 'src', 'app.mjs');
    fs.mkdirSync(path.dirname(userSrc), { recursive: true });
    fs.writeFileSync(userSrc, 'export const ok = true;\n', 'utf8');

    const agentsPath = path.join(target, 'AGENTS.md');
    const customAgents = fs.readFileSync(agentsPath, 'utf8') + '\n# Keep on uninstall\n';
    fs.writeFileSync(agentsPath, customAgents, 'utf8');

    const modifiedRuleRel = '.cac/rules/file-structure.md';
    const modifiedRulePath = path.join(target, modifiedRuleRel);
    const customRule = fs.readFileSync(modifiedRulePath, 'utf8') + '\n<!-- user modified -->\n';
    fs.writeFileSync(modifiedRulePath, customRule, 'utf8');

    const rUninst = runNode(CAC_CLI, ['--uninstall', '--target', target, '--json']);
    assert.equal(rUninst.status, 0, rUninst.stderr);
    const res = JSON.parse(rUninst.stdout.trim());
    assert.equal(res.status, 'ok');
    assert.ok(res.keptModified.includes(modifiedRuleRel));

    // Unmodified managed files and manifests are removed
    assert.equal(fs.existsSync(path.join(target, '.cac', 'FRAMEWORK-MANIFEST.json')), false);
    assert.equal(fs.existsSync(path.join(target, '.cac', 'FRAMEWORK-MANIFEST-OPTIONAL.json')), false);
    assert.equal(fs.existsSync(path.join(target, '.cac', 'scripts', 'doctor.mjs')), false);
    assert.equal(fs.existsSync(path.join(target, '.cac', 'rules', 'dev-workflow-details.md')), false);

    // AGENTS.md, user source file, FEEDBACK-INDEX.md, EVOLUTION.md, and modified rule are preserved
    assert.equal(fs.readFileSync(agentsPath, 'utf8'), customAgents);
    assert.equal(fs.existsSync(userSrc), true);
    assert.equal(fs.readFileSync(modifiedRulePath, 'utf8'), customRule);
    assert.equal(fs.existsSync(path.join(target, '.cac', 'feedback', 'FEEDBACK-INDEX.md')), true);
    assert.equal(fs.existsSync(path.join(target, '.cac', 'EVOLUTION.md')), true);
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
});
