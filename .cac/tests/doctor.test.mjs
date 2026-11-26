// # risk: high
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
});
