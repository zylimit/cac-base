// # risk: high
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HARNESS_ENTRY,
  mkTmpRepo,
  cleanupTmp,
  writeFiles,
  runNode,
} from './helpers.mjs';
import { gateMode, readSession, MAX_FAST_SECONDS } from '../hooks/lib/tier.mjs';

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
