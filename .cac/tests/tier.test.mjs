// # risk: high
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
import { effectiveTier, gateMode, readSession, MAX_FAST_SECONDS } from '../hooks/lib/tier.mjs';

test('tier validate passes on default profile and rejects non-monotonic hook rows', () => {
  const dir = mkTmpRepo();
  try {
    const valid = runNode(HARNESS_ENTRY, ['tier', 'validate'], { cwd: dir });
    assert.equal(valid.status, 0);
    assert.equal(valid.json?.ok, true);

    const profilePath = path.join(dir, '.cac', 'harness', 'profile.json');
    const broken = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    broken.hooks['stop-gate'] = { kind: 'guard', fast: 'block', standard: 'advise', strict: 'block' };
    broken.hooks['kill-dev-ports'] = { kind: 'recorder', fast: 'on', standard: 'off', strict: 'on' };
    fs.writeFileSync(profilePath, JSON.stringify(broken, null, 2) + '\n', 'utf8');

    const bad = runNode(HARNESS_ENTRY, ['tier', 'validate'], { cwd: dir });
    assert.equal(bad.status, 1);
    assert.equal(bad.json?.ok, false);
    const monoHooks = (bad.json?.violations || [])
      .filter((v) => v.code === 'NOT_MONOTONIC')
      .map((v) => v.hook)
      .sort();
    assert.deepEqual(monoHooks, ['kill-dev-ports', 'stop-gate']);
  } finally {
    cleanupTmp(dir);
  }
});

test('tier clamps 8h cap on both write-side (--hours 720) and read-side (forged future set_epoch or 720h expires_epoch)', () => {
  const dir = mkTmpRepo();
  try {
    // Missing --reason must fail with exit 2
    const noReason = runNode(HARNESS_ENTRY, ['tier', 'set', 'fast', '--hours', '2'], { cwd: dir });
    assert.equal(noReason.status, 2);

    // Write-side clamp: --hours 720 -> capped to 8h
    const clampedWrite = runNode(HARNESS_ENTRY, ['tier', 'set', 'fast', '--hours', '720', '--reason', 'spike'], { cwd: dir });
    assert.equal(clampedWrite.status, 0);
    assert.equal(clampedWrite.json?.clamped, true);
    assert.equal(clampedWrite.json?.hours, 8);

    // Read-side clamp 1: forged 720h expiry in .cac/.runtime/tier.json
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    writeFiles(dir, {
      '.cac/.runtime/tier.json': JSON.stringify({
        tier: 'fast',
        reason: 'forged-720h',
        set_epoch: nowSec,
        expires_epoch: nowSec + 720 * 3600,
      }) + '\n',
    });
    const sess720 = readSession(dir, nowMs);
    assert.ok(sess720);
    assert.ok(
      sess720.expires_epoch <= nowSec + MAX_FAST_SECONDS,
      `Expected expires_epoch clamped to <= ${nowSec + MAX_FAST_SECONDS}, got ${sess720.expires_epoch}`,
    );

    // Read-side clamp 2: forged future set_epoch (+30 days) cannot extend fast beyond now + 8h
    writeFiles(dir, {
      '.cac/.runtime/tier.json': JSON.stringify({
        tier: 'fast',
        reason: 'forged-future-set-epoch',
        set_epoch: nowSec + 30 * 86400,
        expires_epoch: nowSec + 30 * 86400 + 8 * 3600,
      }) + '\n',
    });
    const sessFuture = readSession(dir, nowMs);
    assert.ok(sessFuture);
    assert.equal(sessFuture.expires_epoch, nowSec + MAX_FAST_SECONDS);

    // Expired session falls back to null (default tier)
    writeFiles(dir, {
      '.cac/.runtime/tier.json': JSON.stringify({
        tier: 'fast',
        reason: 'already-expired',
        set_epoch: nowSec - 7200,
        expires_epoch: nowSec - 10,
      }) + '\n',
    });
    assert.equal(readSession(dir, nowMs), null);
  } finally {
    cleanupTmp(dir);
  }
});

test('tier validates --sticky legal shape and rejects malformed sticky records', () => {
  const dir = mkTmpRepo();
  try {
    // --sticky and --hours are mutually exclusive
    const conflict = runNode(HARNESS_ENTRY, ['tier', 'set', 'fast', '--sticky', '--hours', '2', '--reason', 'bad'], { cwd: dir });
    assert.equal(conflict.status, 2);

    // Valid --sticky
    const setSticky = runNode(HARNESS_ENTRY, ['tier', 'set', 'fast', '--sticky', '--reason', 'long-refactor'], { cwd: dir });
    assert.equal(setSticky.status, 0);
    assert.equal(setSticky.json?.sticky, true);
    assert.equal(setSticky.json?.expiresEpoch, null);

    const statusSticky = runNode(HARNESS_ENTRY, ['tier', 'status'], { cwd: dir });
    assert.equal(statusSticky.status, 0);
    assert.equal(statusSticky.json?.tier, 'fast');
    assert.equal(statusSticky.json?.sticky, true);

    // Revoke sticky via tier set standard
    const revoke = runNode(HARNESS_ENTRY, ['tier', 'set', 'standard'], { cwd: dir });
    assert.equal(revoke.status, 0);
    const afterRevoke = runNode(HARNESS_ENTRY, ['tier', 'status'], { cwd: dir });
    assert.equal(afterRevoke.json?.tier, 'standard');

    // Forged sticky with blank reason -> rejected back to standard
    writeFiles(dir, {
      '.cac/.runtime/tier.json': JSON.stringify({
        tier: 'fast',
        sticky: true,
        reason: '   ',
        set_epoch: Math.floor(Date.now() / 1000),
        expires_epoch: null,
      }) + '\n',
    });
    const badSticky = runNode(HARNESS_ENTRY, ['tier', 'status'], { cwd: dir });
    assert.equal(badSticky.json?.tier, 'standard');
  } finally {
    cleanupTmp(dir);
  }
});

test('governance asset edits (.cac/rules/AGENTS.md) automatically raise tier to strict while runtime state and external root AGENTS.md do not trigger raise', () => {
  const dir = mkTmpRepo({
    files: {
      '.cac/rules/AGENTS.md': '# Constitution v1\n',
      'AGENTS.md': '# External Tool Root AGENTS.md v1\n',
    },
  });
  try {
    runNode(HARNESS_ENTRY, ['tier', 'set', 'fast', '--hours', '2', '--reason', 'check-raise'], { cwd: dir });

    // Dirty runtime state files + external root AGENTS.md -> must NOT trigger raise!
    writeFiles(dir, {
      '.cac/.needs-review': 'src/index.ts\n',
      '.cac/signals.jsonl': '{"signal":"不对"}\n',
      '.cac/harness/state/sessions.jsonl': '{"event":"subagent_start"}\n',
      '.cac/evidence/test-ledger.jsonl': '{"file":"a.test.mjs","case":"x","result":"PASS"}\n',
      '.cac/.red-verified': 'ok\n',
      'AGENTS.md': '# External Tool Root AGENTS.md v2 (edited by Codex/agy-base)\n',
    });

    const stillFast = runNode(HARNESS_ENTRY, ['tier', 'status'], { cwd: dir });
    assert.equal(stillFast.status, 0);
    assert.equal(stillFast.json?.tier, 'fast', 'Runtime state files and external root AGENTS.md must NOT trigger governance raise');
    assert.equal(stillFast.json?.source, 'session');

    // Modify governance asset .cac/rules/AGENTS.md -> auto-raises to strict!
    writeFiles(dir, { '.cac/rules/AGENTS.md': '# Constitution v2 (edited)\n' });
    const raised = runNode(HARNESS_ENTRY, ['tier', 'status'], { cwd: dir });
    assert.equal(raised.status, 0);
    assert.equal(raised.json?.tier, 'strict');
    assert.equal(raised.json?.source, 'raise');
    assert.ok(Array.isArray(raised.json?.raisedBy) && raised.json.raisedBy.includes('.cac/rules/AGENTS.md'));
    assert.equal(raised.json.raisedBy.includes('AGENTS.md'), false);
    assert.equal(raised.json?.hooks?.['stop-gate'], 'block');
  } finally {
    cleanupTmp(dir);
  }
});

test('BUILTIN_FLOOR cannot be downgraded by removing floor entries or injecting overrides in profile.json', () => {
  const dir = mkTmpRepo();
  try {
    const profilePath = path.join(dir, '.cac', 'harness', 'profile.json');
    const tampered = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    tampered.floor = tampered.floor.filter((id) => id !== 'secret-exfil-guard' && id !== 'postcompact-reinject');
    tampered.overrides = {
      'secret-exfil-guard': 'off',
      'dangerous-command-guard': 'advise',
      'postcompact-reinject': 'off',
    };
    fs.writeFileSync(profilePath, JSON.stringify(tampered, null, 2) + '\n', 'utf8');

    // Validation catches tampering
    const val = runNode(HARNESS_ENTRY, ['tier', 'validate'], { cwd: dir });
    assert.equal(val.status, 1);
    const codes = new Set((val.json?.violations || []).map((v) => v.code));
    assert.equal(codes.has('MISSING_BUILTIN_FLOOR'), true);
    assert.equal(codes.has('OVERRIDE_ON_FLOOR'), true);

    // Runtime gateMode still enforces strictest floor modes unconditionally
    assert.equal(gateMode('secret-exfil-guard', { projectDir: dir }), 'block');
    assert.equal(gateMode('dangerous-command-guard', { projectDir: dir }), 'block');
    assert.equal(gateMode('release-gate', { projectDir: dir }), 'block');
    assert.equal(gateMode('postcompact-reinject', { projectDir: dir }), 'on');
  } finally {
    cleanupTmp(dir);
  }
});

test('corrupt tier.json and profile.json fall back safely and record entries in .cac/harness/state/quarantine.jsonl', () => {
  const dir = mkTmpRepo({
    files: {
      '.cac/harness/profile.json': '{broken-profile-json',
    },
  });
  try {
    writeFiles(dir, {
      '.cac/.runtime/tier.json': '{broken-tier-json',
    });

    const st = runNode(HARNESS_ENTRY, ['tier', 'status'], { cwd: dir });
    assert.equal(st.status, 0);
    assert.equal(st.json?.tier, 'standard');

    const val = runNode(HARNESS_ENTRY, ['tier', 'validate'], { cwd: dir });
    assert.equal(val.status, 1);

    const qFile = path.join(dir, '.cac', 'harness', 'state', 'quarantine.jsonl');
    assert.equal(fs.existsSync(qFile), true, 'quarantine.jsonl must be written');
    const entries = fs.readFileSync(qFile, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((l) => JSON.parse(l));
    const kinds = new Set(entries.map((e) => e.kind));
    assert.equal(kinds.has('profile'), true);
    assert.equal(kinds.has('tier'), true);
  } finally {
    cleanupTmp(dir);
  }
});

test('[Regression v1.1.1] outer parent .git with dirty .github/workflows/ci.yml and sibling files never raises uninitialized child cac-dryrun to strict', () => {
  const parent = mkTmpRepo({
    prefix: 'cac-tier-outer-git-',
    withProfile: false,
    withSettings: false,
    files: {
      'other-proj/index.ts': 'export const base = 1;\n',
      '.github/workflows/ci.yml': 'name: parent-ci\n',
    },
  });
  try {
    // Dirty parent/.github/workflows/ci.yml (matches raise.paths `.github/**`!) and parent/other-proj/dirty.ts
    writeFiles(parent, {
      '.github/workflows/ci.yml': 'name: parent-ci-uncommitted-dirty\n',
      'other-proj/dirty.ts': 'export const siblingDirty = true;\n',
    });

    // Install cac-base into parent/cac-dryrun WITHOUT running `git init` inside cac-dryrun
    const childDir = path.join(parent, 'cac-dryrun');
    const cacCli = path.join(REPO_ROOT, 'scripts', 'cac-base.mjs');
    const inst = runNode(cacCli, ['install', '--target', childDir]);
    assert.equal(inst.status, 0, `install into childDir failed: ${inst.stderr}`);
    assert.equal(fs.existsSync(path.join(childDir, '.git')), false);

    // 1. Direct programmatic effectiveTier & gateMode in childDir must remain standard (source: 'default')
    const eff = effectiveTier({ projectDir: childDir });
    assert.equal(eff.tier, 'standard', `effectiveTier must NOT be raised to strict by parent .git or untracked .cac/*: ${JSON.stringify(eff)}`);
    assert.equal(eff.source, 'default');
    assert.equal(eff.raisedBy, undefined);
    assert.equal(gateMode('stop-gate', { projectDir: childDir }), 'advise');
    assert.equal(gateMode('three-file-sync-gate', { projectDir: childDir }), 'advise');

    // 2. CLI `harness.mjs tier status` in childDir (with CODEAGENT3_PROJECT_DIR=childDir)
    const childHarness = path.join(childDir, '.cac', 'harness', 'harness.mjs');
    const stEnv = runNode(childHarness, ['tier', 'status'], { cwd: childDir, projectDir: childDir });
    assert.equal(stEnv.status, 0, `tier status failed: ${stEnv.stderr}`);
    assert.equal(stEnv.json?.tier, 'standard');
    assert.equal(stEnv.json?.source, 'default');
    assert.equal(stEnv.json?.raisedBy, undefined);
    assert.equal(stEnv.json?.hooks?.['stop-gate'], 'advise');
    assert.equal(stEnv.json?.hooks?.['three-file-sync-gate'], 'advise');

    // 3. CLI `harness.mjs tier status` & `diff-hash` from nested subdir with CODEAGENT3_PROJECT_DIR unset (projectDir: null)
    const nestedCwd = path.join(childDir, 'src', 'feature');
    fs.mkdirSync(nestedCwd, { recursive: true });
    const stNoEnv = runNode(childHarness, ['tier', 'status'], { cwd: nestedCwd, projectDir: null });
    assert.equal(stNoEnv.status, 0);
    assert.equal(stNoEnv.json?.tier, 'standard', 'nested cwd without env vars must lock onto childDir/.cac and stay standard');
    assert.equal(stNoEnv.json?.source, 'default');
    assert.equal(stNoEnv.json?.raisedBy, undefined);

    const dhNoEnv = runNode(childHarness, ['diff-hash'], { cwd: nestedCwd, projectDir: null });
    assert.equal(dhNoEnv.status, 0);
    assert.equal(dhNoEnv.json?.nonGit, true, 'uninitialized childDir inside outer parent .git must be treated as nonGit');

    // 4. Contrast: intentionally tracked monorepo subpackage ignores outer sibling/.github dirty files,
    //    yet raises to strict when its OWN tracked .cac/rules/AGENTS.md is modified
    const trackedSub = path.join(parent, 'packages', 'tracked-sub');
    assert.equal(runNode(cacCli, ['install', '--target', trackedSub]).status, 0);
    gitIn(parent, ['add', 'packages/tracked-sub']);
    gitIn(parent, ['commit', '-m', 'chore(monorepo): track intentional subpackage']);
    // Note: parent/.github/workflows/ci.yml and parent/other-proj/dirty.ts are STILL dirty in parent!
    const trackedHarness = path.join(trackedSub, '.cac', 'harness', 'harness.mjs');
    const subClean = runNode(trackedHarness, ['tier', 'status'], { cwd: trackedSub, projectDir: trackedSub });
    assert.equal(subClean.status, 0);
    assert.equal(subClean.json?.tier, 'standard', 'outer .github/workflows/ci.yml must not raise tracked sibling subpackage');
    assert.equal(subClean.json?.source, 'default');

    writeFiles(trackedSub, {
      '.cac/rules/AGENTS.md': fs.readFileSync(path.join(trackedSub, '.cac', 'rules', 'AGENTS.md'), 'utf8') + '\n<!-- local subpackage edit -->\n',
    });
    const subRaised = runNode(trackedHarness, ['tier', 'status'], { cwd: trackedSub, projectDir: trackedSub });
    assert.equal(subRaised.status, 0);
    assert.equal(subRaised.json?.tier, 'strict');
    assert.equal(subRaised.json?.source, 'raise');
    assert.deepEqual(subRaised.json?.raisedBy, ['.cac/rules/AGENTS.md']);
  } finally {
    cleanupTmp(parent);
  }
});
