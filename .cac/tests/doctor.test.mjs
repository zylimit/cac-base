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
const REPO_DOCTOR = path.join(REPO_ROOT, '.cac', 'scripts', 'doctor.mjs');

const TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'cac-doctor-test-'));
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

function installTarget(label, extraFlags = []) {
  const dir = nextDir(label);
  const r = runNode(CAC_CLI, ['install', '--target', dir, ...extraFlags]);
  assert.equal(r.status, 0, `install failed: ${r.stderr}`);
  return dir;
}

describe('doctor.mjs integrity & health check contract', () => {
  test('freshly installed target passes both human doctor.mjs and doctor.mjs --json with exit code 0 (including CRLF invariance)', () => {
    const target = installTarget('fresh-clean');
    const targetDoctor = path.join(target, '.cac', 'scripts', 'doctor.mjs');

    // Human mode
    const rHuman = runNode(targetDoctor, [target]);
    assert.equal(rHuman.status, 0, `doctor human failed: ${rHuman.stderr}`);
    assert.match(rHuman.stdout, /✓/);
    assert.match(rHuman.stdout, /doctor: 通过/);

    // JSON mode (single-line JSON on stdout)
    const rJson = runNode(targetDoctor, ['--root', target, '--json']);
    assert.equal(rJson.status, 0, `doctor --json failed: ${rJson.stderr}`);
    const lines = rJson.stdout.trim().split(/\r?\n/);
    assert.equal(lines.length, 1, 'doctor --json must emit single-line JSON on stdout');
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.code, 0);
    assert.equal(parsed.status, 'ok');
    assert.equal(parsed.detail.counts.bad, 0);
    assert.deepEqual(parsed.detail.errors, []);

    // CRLF line-ending conversion without content change MUST still pass LF-SHA256 check
    const ruleFile = path.join(target, '.cac', 'rules', 'domain-rulings.md');
    const lfText = fs.readFileSync(ruleFile, 'utf8').replace(/\r\n/g, '\n');
    fs.writeFileSync(ruleFile, lfText.replace(/\n/g, '\r\n'), 'utf8');
    const rCrlf = runNode(targetDoctor, [target, '--json']);
    assert.equal(rCrlf.status, 0, `CRLF-only difference should pass LF-SHA256: ${rCrlf.stdout}`);
  });

  test('tampering with any managed file content fails LF-SHA256 verification and exits non-zero', () => {
    const target = installTarget('tamper-managed', ['--with-harness']);
    const targetDoctor = path.join(target, '.cac', 'scripts', 'doctor.mjs');

    // Tamper with a core managed file
    const managedRel = '.cac/rules/domain-rulings.md';
    const managedFull = path.join(target, managedRel);
    fs.appendFileSync(managedFull, '\n<!-- unauthorized tamper -->\n', 'utf8');

    const rJson = runNode(targetDoctor, [target, '--json']);
    assert.notEqual(rJson.status, 0, 'tampered managed file must exit non-zero');
    const parsed = JSON.parse(rJson.stdout.trim());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.status, 'violation');
    assert.ok(parsed.detail.counts.bad >= 1);
    assert.ok(
      parsed.detail.errors.some((e) => e.includes(managedRel) && (e.includes('篡改') || e.includes('漂移'))),
      `expected tamper error naming ${managedRel}, got: ${JSON.stringify(parsed.detail.errors)}`,
    );
    assert.ok(
      parsed.detail.errors.some((e) => e.includes('LF-SHA256')),
      `expected LF-SHA256 summary error, got: ${JSON.stringify(parsed.detail.errors)}`,
    );
  });

  test('deleting any registered manifest file fails missing-file check and exits non-zero', () => {
    const target = installTarget('missing-managed');
    const targetDoctor = path.join(target, '.cac', 'scripts', 'doctor.mjs');

    // Remove a registered managed file
    const deletedRel = '.cac/scripts/test-age.mjs';
    fs.rmSync(path.join(target, deletedRel), { force: true });

    const rJson = runNode(targetDoctor, [target, '--json']);
    assert.notEqual(rJson.status, 0, 'deleted registered file must exit non-zero');
    const parsed = JSON.parse(rJson.stdout.trim());
    assert.equal(parsed.ok, false);
    assert.ok(
      parsed.detail.errors.some((e) => e.includes(deletedRel) && (e.includes('缺件') || e.includes('缺失'))),
      `expected missing-file error for ${deletedRel}, got: ${JSON.stringify(parsed.detail.errors)}`,
    );
  });

  test('placing module-catalog.json without --with-harness fails contradiction check and passes once --with-harness is installed', () => {
    const target = installTarget('catalog-no-ext');
    const targetDoctor = path.join(target, '.cac', 'scripts', 'doctor.mjs');

    const catalogPath = path.join(target, '.cac', 'harness', 'module-catalog.json');
    fs.writeFileSync(catalogPath, JSON.stringify({ version: 1, modules: [] }, null, 2) + '\n', 'utf8');

    const rBad = runNode(targetDoctor, [target, '--json']);
    assert.notEqual(rBad.status, 0, 'module-catalog.json without harness/ext must exit non-zero');
    const badJson = JSON.parse(rBad.stdout.trim());
    assert.equal(badJson.ok, false);
    assert.ok(
      badJson.detail.errors.some((e) => e.includes('module-catalog.json') && e.includes('harness/ext')),
      `expected contradiction error mentioning module-catalog.json & harness/ext, got: ${JSON.stringify(badJson.detail.errors)}`,
    );

    // Installing --with-harness resolves the contradiction
    assert.equal(runNode(CAC_CLI, ['upgrade', '--target', target, '--with-harness']).status, 0);
    const rFixed = runNode(targetDoctor, [target, '--json']);
    assert.equal(rFixed.status, 0, `expected rc 0 after --with-harness: ${rFixed.stdout}`);
  });

  test('interrupted install.marker raises the very first error item and exits non-zero', () => {
    const target = nextDir('interrupted-marker');

    // Produce real interrupted marker via fault injection
    const rInject = runNode(CAC_CLI, ['install', '--target', target], {
      env: { CAC_SETUP_FAIL_AFTER: '2' },
    });
    assert.notEqual(rInject.status, 0);

    // Human mode: first check output on stderr must be the interrupted install.marker alarm
    const rHuman = runNode(REPO_DOCTOR, [target]);
    assert.notEqual(rHuman.status, 0);
    const firstErrLine = rHuman.stderr.trim().split(/\r?\n/)[0] || '';
    assert.match(firstErrLine, /^✗ .*install\.marker.*interrupted/);

    // JSON mode: detail.errors[0] must be the interrupted install.marker alarm
    const rJson = runNode(REPO_DOCTOR, [target, '--json']);
    assert.notEqual(rJson.status, 0);
    const parsed = JSON.parse(rJson.stdout.trim());
    assert.equal(parsed.ok, false);
    assert.ok(parsed.detail.errors.length >= 1);
    assert.match(parsed.detail.errors[0], /install\.marker.*interrupted/);
  });

  test('missing or empty .cac/rules/AGENTS.md fails doctor.mjs (exit non-zero) even when an external root AGENTS.md exists', () => {
    const target = installTarget('missing-hidden-agents');
    const targetDoctor = path.join(target, '.cac', 'scripts', 'doctor.mjs');
    const hiddenAgents = path.join(target, '.cac', 'rules', 'AGENTS.md');

    // Place an external root AGENTS.md to ensure root AGENTS.md cannot mask missing .cac/rules/AGENTS.md
    fs.writeFileSync(path.join(target, 'AGENTS.md'), '# External Tool Root AGENTS.md\n', 'utf8');

    // Case A: deleted .cac/rules/AGENTS.md -> exit non-zero
    fs.rmSync(hiddenAgents, { force: true });
    const rMissing = runNode(targetDoctor, [target, '--json']);
    assert.notEqual(rMissing.status, 0, 'missing .cac/rules/AGENTS.md must exit non-zero');
    const missingJson = JSON.parse(rMissing.stdout.trim());
    assert.equal(missingJson.ok, false);
    assert.ok(
      missingJson.detail.errors.some((e) => e.includes('.cac/rules/AGENTS.md') && (e.includes('缺失') || e.includes('空'))),
      `expected missing .cac/rules/AGENTS.md error, got: ${JSON.stringify(missingJson.detail.errors)}`,
    );

    // Case B: empty (0-byte) .cac/rules/AGENTS.md -> exit non-zero
    fs.writeFileSync(hiddenAgents, '', 'utf8');
    const rEmpty = runNode(targetDoctor, [target, '--json']);
    assert.notEqual(rEmpty.status, 0, 'empty .cac/rules/AGENTS.md must exit non-zero');
    const emptyJson = JSON.parse(rEmpty.stdout.trim());
    assert.equal(emptyJson.ok, false);
    assert.ok(
      emptyJson.detail.errors.some((e) => e.includes('.cac/rules/AGENTS.md') && (e.includes('缺失') || e.includes('空'))),
      `expected empty .cac/rules/AGENTS.md error, got: ${JSON.stringify(emptyJson.detail.errors)}`,
    );
  });

  test('[Red-lock HOST-CONTRACT §2] .cac/rules/AGENTS.md with paths: YAML frontmatter (LF & \\r\\n CRLF) fails doctor.mjs with exit 1 even when manifest SHA256 matches', () => {
    const target = installTarget('agents-paths-guard');
    const targetDoctor = path.join(target, '.cac', 'scripts', 'doctor.mjs');
    const hiddenAgents = path.join(target, '.cac', 'rules', 'AGENTS.md');
    const manifestPath = path.join(target, '.cac', 'FRAMEWORK-MANIFEST.json');
    const cleanBody = fs.readFileSync(hiddenAgents, 'utf8').replace(/\r\n/g, '\n');

    // Sync manifest LF-SHA256 for .cac/rules/AGENTS.md so ONLY the paths: frontmatter guard triggers exit 1
    const writeAgentsWithSyncedManifest = (rawText) => {
      fs.writeFileSync(hiddenAgents, rawText, 'utf8');
      const normBuf = Buffer.from(Buffer.from(rawText, 'utf8').filter((b) => b !== 0x0d));
      const sha256 = createHash('sha256').update(normBuf).digest('hex');
      const manifestObj = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const entry = manifestObj.files.find((f) => f.path === '.cac/rules/AGENTS.md');
      assert.ok(entry, 'expected .cac/rules/AGENTS.md in FRAMEWORK-MANIFEST.json');
      entry.sha256 = sha256;
      entry.bytes = normBuf.length;
      fs.writeFileSync(manifestPath, JSON.stringify(manifestObj, null, 2) + '\n', 'utf8');
    };

    // 1. LF block paths: frontmatter -> exit 1
    const lfPoisoned = ['---', 'paths:', '  - "src/**"', '---', '', cleanBody].join('\n');
    writeAgentsWithSyncedManifest(lfPoisoned);
    const rLfHuman = runNode(targetDoctor, [target]);
    assert.equal(rLfHuman.status, 1, `expected exit 1 on LF paths: frontmatter, got ${rLfHuman.status}`);
    assert.match(rLfHuman.stderr, /\.cac\/rules\/AGENTS\.md.*paths:/);

    const rLfJson = runNode(targetDoctor, [target, '--json']);
    assert.equal(rLfJson.status, 1);
    const lfParsed = JSON.parse(rLfJson.stdout.trim());
    assert.equal(lfParsed.ok, false);
    assert.equal(lfParsed.detail.errors.some((e) => e.includes('LF-SHA256')), false, 'manifest hash was synced; failure must come solely from paths: guard');
    assert.equal(
      lfParsed.detail.errors.some((e) => e.includes('.cac/rules/AGENTS.md') && e.includes('paths:')),
      true,
      `expected paths: frontmatter error in ${JSON.stringify(lfParsed.detail.errors)}`,
    );

    // 2. Windows CRLF (\r\n) block paths: frontmatter (with UTF-8 BOM) -> exit 1
    const crlfPoisoned = '\uFEFF' + ['---', 'paths:', '  - "src/**"', '---', '', cleanBody.replace(/\n/g, '\r\n')].join('\r\n');
    writeAgentsWithSyncedManifest(crlfPoisoned);
    const rCrlfJson = runNode(targetDoctor, [target, '--json']);
    assert.equal(rCrlfJson.status, 1, `expected exit 1 on CRLF paths: frontmatter, got ${rCrlfJson.status}`);
    const crlfParsed = JSON.parse(rCrlfJson.stdout.trim());
    assert.equal(crlfParsed.ok, false);
    assert.equal(
      crlfParsed.detail.errors.some((e) => e.includes('.cac/rules/AGENTS.md') && e.includes('paths:')),
      true,
    );

    // 3. CRLF inline flow paths: ["**"] -> exit 1
    const inlinePoisoned = ['---', 'paths: ["**"]', '---', '', cleanBody.replace(/\n/g, '\r\n')].join('\r\n');
    writeAgentsWithSyncedManifest(inlinePoisoned);
    const rInline = runNode(targetDoctor, [target, '--json']);
    assert.equal(rInline.status, 1);

    // 4. Restoring headerless .cac/rules/AGENTS.md -> passes cleanly (exit 0)
    writeAgentsWithSyncedManifest(cleanBody);
    const rClean = runNode(targetDoctor, [target, '--json']);
    assert.equal(rClean.status, 0, `expected exit 0 once paths: frontmatter is removed: ${rClean.stdout}`);
  });

  test('[Regression HOST-CONTRACT §2] .cac/rules/AGENTS.md with quoted "paths": or bare non-paths YAML frontmatter (including ---   \\r\\n trailing spaces) fails doctor.mjs with exit 1 when manifest SHA256 is synced', () => {
    const target = installTarget('agents-fm-edge-guard');
    const targetDoctor = path.join(target, '.cac', 'scripts', 'doctor.mjs');
    const hiddenAgents = path.join(target, '.cac', 'rules', 'AGENTS.md');
    const manifestPath = path.join(target, '.cac', 'FRAMEWORK-MANIFEST.json');
    const cleanBody = fs.readFileSync(hiddenAgents, 'utf8').replace(/\r\n/g, '\n');

    const writeAgentsWithSyncedManifest = (rawText) => {
      fs.writeFileSync(hiddenAgents, rawText, 'utf8');
      const normBuf = Buffer.from(Buffer.from(rawText, 'utf8').filter((b) => b !== 0x0d));
      const sha256 = createHash('sha256').update(normBuf).digest('hex');
      const manifestObj = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const entry = manifestObj.files.find((f) => f.path === '.cac/rules/AGENTS.md');
      assert.ok(entry, 'expected .cac/rules/AGENTS.md in FRAMEWORK-MANIFEST.json');
      entry.sha256 = sha256;
      entry.bytes = normBuf.length;
      fs.writeFileSync(manifestPath, JSON.stringify(manifestObj, null, 2) + '\n', 'utf8');
    };

    const forbiddenHeaders = [
      {
        label: 'double-quoted "paths": flow header (LF)',
        raw: ['---', '"paths": ["src/**"]', '---', '', cleanBody].join('\n'),
      },
      {
        label: 'double-quoted "paths": block header with trailing spaces & CRLF (---   \\r\\n)',
        raw: ['---   ', '"paths":', '  - "src/**"', '---   ', '', cleanBody.replace(/\n/g, '\r\n')].join('\r\n'),
      },
      {
        label: 'bare non-paths frontmatter (---\\ntitle: x\\n---)',
        raw: ['---', 'title: x', '---', '', cleanBody].join('\n'),
      },
      {
        label: 'BOM + bare non-paths frontmatter with trailing spaces & CRLF (---   \\r\\n)',
        raw: '\uFEFF' + ['---   ', 'title: x', '---   ', '', cleanBody.replace(/\n/g, '\r\n')].join('\r\n'),
      },
      {
        label: 'unclosed opening YAML fence with trailing spaces & CRLF',
        raw: ['---   ', 'title: unclosed', '', cleanBody.replace(/\n/g, '\r\n')].join('\r\n'),
      },
    ];

    for (const { label, raw } of forbiddenHeaders) {
      writeAgentsWithSyncedManifest(raw);

      const rHuman = runNode(targetDoctor, [target]);
      assert.equal(rHuman.status, 1, `expected human doctor exit 1 for ${label}, got ${rHuman.status}`);

      const rJson = runNode(targetDoctor, [target, '--json']);
      assert.equal(rJson.status, 1, `expected json doctor exit 1 for ${label}, got ${rJson.status}: ${rJson.stdout}`);
      const parsed = JSON.parse(rJson.stdout.trim());
      assert.equal(parsed.ok, false);
      assert.equal(
        parsed.detail.errors.some((e) => e.includes('LF-SHA256')),
        false,
        `manifest SHA256 was synced for ${label}; failure must come strictly from frontmatter guard`,
      );
      assert.equal(
        parsed.detail.errors.some((e) => e.includes('.cac/rules/AGENTS.md')),
        true,
        `expected .cac/rules/AGENTS.md error for ${label}, got: ${JSON.stringify(parsed.detail.errors)}`,
      );
    }

    // Headerless .cac/rules/AGENTS.md containing a normal Markdown thematic break (`---`) in body must exit 0
    writeAgentsWithSyncedManifest(`${cleanBody}\n---\n`);
    const rCleanHr = runNode(targetDoctor, [target, '--json']);
    assert.equal(rCleanHr.status, 0, `expected exit 0 for headerless AGENTS.md with body thematic break: ${rCleanHr.stdout}`);
  });
});
