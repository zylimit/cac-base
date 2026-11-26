// # risk: high
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REPO_ROOT,
  HARNESS_DIR,
  HARNESS_ENTRY,
  HOOKS_DIR,
  GITHOOKS_RUN,
  mkTmpDir,
  mkTmpRepo,
  cleanupTmp,
  writeFiles,
  gitIn,
  runNode,
  runHook,
} from './helpers.mjs';
import { findCacProjectRoot as findHookCacRoot, sameDir } from '../hooks/lib/io.mjs';
import { findCacProjectRoot as findCoreCacRoot } from '../harness/lib/core.mjs';

function setTier(dir, tier, extraArgs = []) {
  const res = runNode(HARNESS_ENTRY, ['tier', 'set', tier, ...extraArgs], { cwd: dir });
  assert.equal(res.status, 0, `tier set ${tier} failed: ${res.stderr}`);
}

// ============================================================================
// 1. no-direct-code-guard.mjs
// ============================================================================

test('no-direct-code-guard blocks main Agent and readonly subagents on POSIX & Windows source paths, allows implementer/tester and docs', () => {
  const dir = mkTmpRepo();
  try {
    // Main Agent writing POSIX path -> blocked (exit 2)
    const mainPosix = runHook('no-direct-code-guard', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      cwd: dir,
      tool_input: { file_path: 'src/app.ts' },
    }, { cwd: dir });
    assert.equal(mainPosix.status, 2);

    // Main Agent writing Windows backslash path -> blocked (exit 2)
    const mainWin = runHook('no-direct-code-guard', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      cwd: dir,
      tool_input: { file_path: 'C:\\repo\\src\\app.ts' },
    }, { cwd: dir });
    assert.equal(mainWin.status, 2);

    // Subagent implementer -> allowed (exit 0)
    const implAllowed = runHook('no-direct-code-guard', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      cwd: dir,
      agent_id: 'impl-01',
      agent_type: 'implementer',
      tool_input: { file_path: 'src/app.ts' },
    }, { cwd: dir });
    assert.equal(implAllowed.status, 0);

    // Readonly subagent code-reviewer -> blocked (exit 2)
    const reviewerBlocked = runHook('no-direct-code-guard', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      cwd: dir,
      agent_id: 'rev-01',
      agent_type: 'code-reviewer',
      tool_input: { file_path: 'src/app.ts' },
    }, { cwd: dir });
    assert.equal(reviewerBlocked.status, 2);

    // Main Agent writing Product-Spec.md -> allowed (exit 0)
    const docAllowed = runHook('no-direct-code-guard', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      cwd: dir,
      tool_input: { file_path: 'Product-Spec.md' },
    }, { cwd: dir });
    assert.equal(docAllowed.status, 0);
  } finally {
    cleanupTmp(dir);
  }
});

test('[Regression MEDIUM-1] no-direct-code-guard blocks main Agent on business src/hooks/* & src/agents/* and blocks non-coding subagent feedback-observer on src/app.ts', () => {
  const dir = mkTmpRepo();
  try {
    for (const businessPath of [
      'src/hooks/useAuth.ts',
      'src\\hooks\\useAuth.ts',
      'src/agents/worker.ts',
      'src\\agents\\worker.ts',
    ]) {
      const res = runHook('no-direct-code-guard', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        cwd: dir,
        tool_input: { file_path: businessPath },
      }, { cwd: dir });
      assert.equal(
        res.status,
        2,
        `Main Agent writing business path ${businessPath} must be blocked (must not match framework .cac/hooks or .cac/agents)`,
      );
    }

    const fbObserverBlocked = runHook('no-direct-code-guard', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      cwd: dir,
      agent_id: 'fb-obs-01',
      agent_type: 'feedback-observer',
      tool_input: { file_path: 'src/app.ts' },
    }, { cwd: dir });
    assert.equal(
      fbObserverBlocked.status,
      2,
      'Non-coding subagent feedback-observer must be blocked from writing src/app.ts',
    );
  } finally {
    cleanupTmp(dir);
  }
});

// ============================================================================
// 2. mark-review-needed.mjs + stop-gate.mjs (Red-locks D8 & D4 + stop_hook_active)
// ============================================================================

test('[Red-lock D8] mark-review-needed records relative, absolute, and Windows backslash paths while ignoring docs and escapes', () => {
  const dir = mkTmpRepo();
  try {
    // Relative path (legacy D8 missed relative paths)
    const r1 = runHook('mark-review-needed', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      cwd: dir,
      tool_input: { file_path: 'src/a.ts' },
    }, { cwd: dir });
    assert.equal(r1.status, 0);

    // Absolute path
    const r2 = runHook('mark-review-needed', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      cwd: dir,
      tool_input: { file_path: path.join(dir, 'src', 'b.ts') },
    }, { cwd: dir });
    assert.equal(r2.status, 0);

    // Windows backslash relative path
    const r3 = runHook('mark-review-needed', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      cwd: dir,
      tool_input: { file_path: 'src\\sub\\c.ts' },
    }, { cwd: dir });
    assert.equal(r3.status, 0);

    // Exempt doc & path traversal escape -> must NOT be recorded
    runHook('mark-review-needed', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      cwd: dir,
      tool_input: { file_path: 'Product-Spec.md' },
    }, { cwd: dir });
    runHook('mark-review-needed', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      cwd: dir,
      tool_input: { file_path: '../outside.ts' },
    }, { cwd: dir });

    const recorded = fs.readFileSync(path.join(dir, '.cac', '.needs-review'), 'utf8')
      .trim()
      .split(/\r?\n/);
    assert.deepEqual(recorded, ['src/a.ts', 'src/b.ts', 'src/sub/c.ts']);
  } finally {
    cleanupTmp(dir);
  }
});

test('[Red-lock D4] stop-gate advises with 1h dedup in standard tier, and blocks 3 times without continue:false then releases on 4th in strict tier', () => {
  const dir = mkTmpRepo();
  try {
    writeFiles(dir, { '.cac/.needs-review': 'src/a.ts\n' });

    // Standard tier -> advise on 1st call, deduplicated silent on 2nd call
    const adv1 = runHook('stop-gate', { hook_event_name: 'Stop', cwd: dir, stop_hook_active: false }, { cwd: dir });
    assert.equal(adv1.status, 0);
    assert.notEqual(adv1.json?.decision, 'block');
    assert.match(adv1.json?.systemMessage || '', /\[advise\]/);

    const adv2 = runHook('stop-gate', { hook_event_name: 'Stop', cwd: dir, stop_hook_active: false }, { cwd: dir });
    assert.equal(adv2.status, 0);
    assert.equal(adv2.stdout.trim(), '', 'Second advise within 1h for identical signature must be deduplicated');

    // Switch to strict tier -> 3 blocks (no continue: false!), 4th strike releases
    setTier(dir, 'strict');
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const blk = runHook('stop-gate', { hook_event_name: 'Stop', cwd: dir, stop_hook_active: false }, { cwd: dir });
      assert.equal(blk.status, 0);
      assert.ok(blk.json, `Attempt ${attempt} must emit JSON`);
      assert.equal(blk.json.decision, 'block', `Attempt ${attempt} must block`);
      assert.equal(
        Object.prototype.hasOwnProperty.call(blk.json, 'continue'),
        false,
        `Attempt ${attempt} must NEVER include continue: false (Red-lock D4)`,
      );
      assert.match(blk.json.reason, /src\/a\.ts/);
    }

    const fourth = runHook('stop-gate', { hook_event_name: 'Stop', cwd: dir, stop_hook_active: false }, { cwd: dir });
    assert.equal(fourth.status, 0);
    assert.notEqual(fourth.json?.decision, 'block', '4th consecutive attempt must trip 3-strike circuit breaker and release');
    assert.match(fourth.json?.systemMessage || '', /3 次上限/);
  } finally {
    cleanupTmp(dir);
  }
});

test('stop-gate and three-file-sync-gate respect stop_hook_active: true to prevent re-entrant Stop loop (HOST-CONTRACT §3.5)', () => {
  const dir = mkTmpRepo({
    files: {
      'progress.md': '# Progress\n',
      'src/a.ts': 'export const a = 1;\n',
    },
  });
  try {
    writeFiles(dir, {
      '.cac/.needs-review': 'src/a.ts\n',
      'src/a.ts': 'export const a = 2;\n',
    });
    setTier(dir, 'strict');

    const stopRes = runHook('stop-gate', {
      hook_event_name: 'Stop',
      cwd: dir,
      stop_hook_active: true,
    }, { cwd: dir });
    assert.equal(stopRes.status, 0);

    const syncRes = runHook('three-file-sync-gate', {
      hook_event_name: 'Stop',
      cwd: dir,
      stop_hook_active: true,
    }, { cwd: dir });
    assert.equal(syncRes.status, 0);

    assert.notEqual(
      stopRes.json?.decision,
      'block',
      'stop-gate must not re-block when stop_hook_active is true (HOST-CONTRACT §3.5)',
    );
    assert.notEqual(
      syncRes.json?.decision,
      'block',
      'three-file-sync-gate must not re-block when stop_hook_active is true (HOST-CONTRACT §3.5)',
    );
  } finally {
    cleanupTmp(dir);
  }
});

// ============================================================================
// 3. subagent-bookkeeping.mjs (Red-lock D3 + strict envelope + stop_hook_active)
// ============================================================================

test('[Red-lock D3] subagent-bookkeeping reads only last_assistant_message (never walks session_id/cwd) and enforces Status+Evidence with stop_hook_active guard', () => {
  const dir = mkTmpRepo();
  try {
    setTier(dir, 'strict');

    // --start records session and exits 0 without blocking
    const startRes = runHook('subagent-bookkeeping', {
      hook_event_name: 'SubagentStart',
      session_id: 'sess-alpha',
      cwd: dir,
      agent_id: 'ag-1',
      agent_type: 'implementer',
    }, { cwd: dir, args: ['--start'] });
    assert.equal(startRes.status, 0);
    assert.equal(startRes.stdout.trim(), '');

    // D3 red-lock: empty last_assistant_message with non-envelope strings in session_id / cwd / unknown fields must NOT false-block!
    const emptyMsgRes = runHook('subagent-bookkeeping', {
      hook_event_name: 'SubagentStop',
      session_id: 'random-session-without-envelope-fields',
      cwd: dir,
      agent_id: 'ag-empty',
      agent_type: 'implementer',
      stop_hook_active: false,
      unknown_nested: { note: 'just finished editing files' },
      last_assistant_message: '',
    }, { cwd: dir });
    assert.equal(emptyMsgRes.status, 0);
    assert.notEqual(emptyMsgRes.json?.decision, 'block', 'Must not walk(input) over session_id/cwd/unknown fields when last_assistant_message is empty');

    // Valid envelope in last_assistant_message + noisy extra fields -> allowed
    const validEnvRes = runHook('subagent-bookkeeping', {
      hook_event_name: 'SubagentStop',
      session_id: 'sess-noise-no-status',
      cwd: dir,
      agent_id: 'ag-valid',
      agent_type: 'implementer',
      stop_hook_active: false,
      extra_blob: 'plain text without status',
      last_assistant_message: 'Status: DONE\nChanged: src/x.ts\nEvidence: node --test -> exit 0\n',
    }, { cwd: dir });
    assert.equal(validEnvRes.status, 0);
    assert.notEqual(validEnvRes.json?.decision, 'block');

    // Missing Status/Evidence in strict tier with stop_hook_active: false -> blocked without continue: false
    const invalidEnvRes = runHook('subagent-bookkeeping', {
      hook_event_name: 'SubagentStop',
      session_id: 'Status: DONE\nEvidence: fake-in-session-id',
      cwd: dir,
      agent_id: 'ag-bad',
      agent_type: 'implementer',
      stop_hook_active: false,
      last_assistant_message: 'All tasks completed.',
    }, { cwd: dir });
    assert.equal(invalidEnvRes.status, 0);
    assert.equal(invalidEnvRes.json?.decision, 'block', 'Must ignore fake envelope inside session_id and block incomplete last_assistant_message');
    assert.equal(Object.prototype.hasOwnProperty.call(invalidEnvRes.json, 'continue'), false);

    // Same incomplete message with stop_hook_active: true -> must NOT block a second time
    const reentrantRes = runHook('subagent-bookkeeping', {
      hook_event_name: 'SubagentStop',
      session_id: 'sess-reentrant',
      cwd: dir,
      agent_id: 'ag-bad',
      agent_type: 'implementer',
      stop_hook_active: true,
      last_assistant_message: 'All tasks completed.',
    }, { cwd: dir });
    assert.equal(reentrantRes.status, 0);
    assert.notEqual(reentrantRes.json?.decision, 'block', 'stop_hook_active: true must prevent second block');
  } finally {
    cleanupTmp(dir);
  }
});

// ============================================================================
// 4. tdd-gate.mjs
// ============================================================================

test('tdd-gate enforces fresh .red-verified before dispatching implementer on bug/contract fixes in strict tier', () => {
  const dir = mkTmpRepo();
  try {
    setTier(dir, 'strict');

    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      cwd: dir,
      tool_input: {
        subagent_type: 'implementer',
        prompt: 'Goal: 修复解析器契约 bug 并保持向后兼容',
      },
    };

    // Without .red-verified -> blocked (exit 2)
    const noRed = runHook('tdd-gate', payload, { cwd: dir });
    assert.equal(noRed.status, 2);

    // Dispatching tester first -> always allowed
    const testerDispatch = runHook('tdd-gate', {
      ...payload,
      tool_input: { ...payload.tool_input, subagent_type: 'tester' },
    }, { cwd: dir });
    assert.equal(testerDispatch.status, 0);

    // Expired .red-verified (> 2h old) -> still blocked
    const redPath = path.join(dir, '.cac', '.red-verified');
    writeFiles(dir, { '.cac/.red-verified': 'verified\n' });
    const threeHoursAgo = new Date(Date.now() - 3 * 3600 * 1000);
    fs.utimesSync(redPath, threeHoursAgo, threeHoursAgo);
    const expiredRed = runHook('tdd-gate', payload, { cwd: dir });
    assert.equal(expiredRed.status, 2);

    // Fresh .red-verified -> allowed
    writeFiles(dir, { '.cac/.red-verified': 'verified\n' });
    const freshRed = runHook('tdd-gate', payload, { cwd: dir });
    assert.equal(freshRed.status, 0);
  } finally {
    cleanupTmp(dir);
  }
});

// ============================================================================
// 5. three-file-sync-gate.mjs (including design-detail-sync)
// ============================================================================

test('three-file-sync-gate enforces progress.md sync, Product-Spec/CHANGELOG pairing, and design-detail-sync', () => {
  const dir = mkTmpRepo({
    files: {
      'progress.md': '# progress\n\n## Pinned\n- Rule 1\n',
      'Product-Spec.md': '# Spec v1\n',
      'Product-Spec-CHANGELOG.md': '# Changelog v1\n',
      'docs/design/billing.md': '# Billing Design\n\n> 代码范围：`src/billing/**`\n',
      'src/billing/calc.ts': 'export const tax = 1;\n',
    },
  });
  try {
    setTier(dir, 'strict');

    // 1. Modify src/billing/calc.ts without progress.md or docs/design/billing.md -> blocked on C1 + DD
    writeFiles(dir, { 'src/billing/calc.ts': 'export const tax = 2;\n' });
    const c1dd = runHook('three-file-sync-gate', { hook_event_name: 'Stop', cwd: dir, stop_hook_active: false }, { cwd: dir });
    assert.equal(c1dd.status, 0);
    assert.equal(c1dd.json?.decision, 'block');
    assert.match(c1dd.json.reason, /progress\.md/);
    assert.match(c1dd.json.reason, /docs\/design\/billing\.md/);

    // 2. Sync progress.md + docs/design/billing.md, but modify only Product-Spec.md -> blocked on C2a
    writeFiles(dir, {
      'progress.md': '# progress\n\n## Pinned\n- Rule 1\n\n## Done\n- Updated tax\n',
      'docs/design/billing.md': '# Billing Design\n\n> 代码范围：`src/billing/**`\n\nUpdated tax=2.\n',
      'Product-Spec.md': '# Spec v2\n',
    });
    const c2a = runHook('three-file-sync-gate', { hook_event_name: 'Stop', cwd: dir, stop_hook_active: false }, { cwd: dir });
    assert.equal(c2a.status, 0);
    assert.equal(c2a.json?.decision, 'block');
    assert.match(c2a.json.reason, /Product-Spec-CHANGELOG\.md/);

    // 3. Pair Product-Spec-CHANGELOG.md -> clean pass
    writeFiles(dir, { 'Product-Spec-CHANGELOG.md': '# Changelog v2\n' });
    const allSynced = runHook('three-file-sync-gate', { hook_event_name: 'Stop', cwd: dir, stop_hook_active: false }, { cwd: dir });
    assert.equal(allSynced.status, 0);
    assert.equal(allSynced.stdout.trim(), '');
  } finally {
    cleanupTmp(dir);
  }
});

// ============================================================================
// 6. precompact-gate.mjs & postcompact-reinject.mjs
// ============================================================================

test('precompact-gate blocks once with 10-minute cooldown when dirty, and postcompact-reinject re-injects Pinned invariants even in fast tier', () => {
  const dir = mkTmpRepo({
    files: {
      'progress.md': '# Progress\n\n## Pinned\n- 严禁绕过安全地板闸\n',
    },
  });
  try {
    writeFiles(dir, { '.cac/.needs-review': 'src/core.ts\n' });

    // 1st PreCompact -> blocks without continue: false
    const pre1 = runHook('precompact-gate', { hook_event_name: 'PreCompact', cwd: dir }, { cwd: dir });
    assert.equal(pre1.status, 0);
    assert.equal(pre1.json?.decision, 'block');
    assert.equal(Object.prototype.hasOwnProperty.call(pre1.json, 'continue'), false);

    // 2nd PreCompact within 10min cooldown -> allowed silently
    const pre2 = runHook('precompact-gate', { hook_event_name: 'PreCompact', cwd: dir }, { cwd: dir });
    assert.equal(pre2.status, 0);
    assert.equal(pre2.stdout.trim(), '');

    // PostCompact in fast tier (floor gate) -> re-injects Pinned & pending review state
    setTier(dir, 'fast', ['--hours', '1', '--reason', 'compact-floor-test']);
    const post = runHook('postcompact-reinject', {
      hook_event_name: 'PostCompact',
      cwd: dir,
      compact_trigger: 'auto',
    }, { cwd: dir });
    assert.equal(post.status, 0);
    assert.equal(post.json?.hookSpecificOutput?.hookEventName, 'PostCompact');
    const ctx = post.json?.hookSpecificOutput?.additionalContext || '';
    assert.match(ctx, /严禁绕过安全地板闸/);
    assert.match(ctx, /src\/core\.ts/);
  } finally {
    cleanupTmp(dir);
  }
});

// ============================================================================
// 7. session-start.mjs & detect-feedback-signal.mjs
// ============================================================================

test('session-start injects governance banner, interrupted install warning, and fast-tier alert; detect-feedback-signal queues user corrections', () => {
  const dir = mkTmpRepo();
  try {
    writeFiles(dir, { '.cac/.runtime/install.marker': 'interrupted\n' });
    const ss = runHook('session-start', { hook_event_name: 'SessionStart', cwd: dir }, { cwd: dir });
    assert.equal(ss.status, 0);
    const ssCtx = ss.json?.hookSpecificOutput?.additionalContext || '';
    assert.match(ssCtx, /install\.marker/);
    assert.match(ssCtx, /核心治理铁律/);

    // Fast tier warning survives source="compact"
    fs.rmSync(path.join(dir, '.cac', '.runtime', 'install.marker'), { force: true });
    setTier(dir, 'fast', ['--sticky', '--reason', 'rapid-proto']);
    const ssFast = runHook('session-start', { hook_event_name: 'SessionStart', cwd: dir, source: 'compact' }, { cwd: dir });
    assert.match(ssFast.json?.hookSpecificOutput?.additionalContext || '', /tier: fast/);

    // Switch back to standard to test detect-feedback-signal
    setTier(dir, 'standard');

    // Slash command must not be treated as user correction
    const slashRes = runHook('detect-feedback-signal', {
      hook_event_name: 'UserPromptSubmit',
      cwd: dir,
      prompt: '/release-builder',
    }, { cwd: dir });
    assert.equal(slashRes.status, 0);
    assert.equal(slashRes.stdout.trim(), '');

    // Real correction signal -> queues .cac/signals.jsonl & injects 3-step rule
    const corrRes = runHook('detect-feedback-signal', {
      hook_event_name: 'UserPromptSubmit',
      cwd: dir,
      session_id: 'sess-fb-1',
      prompt: '不对，你搞错了这里的汇率精度规则',
    }, { cwd: dir });
    assert.equal(corrRes.status, 0);
    assert.match(corrRes.json?.hookSpecificOutput?.additionalContext || '', /三步铁律/);
    const signalsRaw = fs.readFileSync(path.join(dir, '.cac', 'signals.jsonl'), 'utf8').trim();
    const sigEntry = JSON.parse(signalsRaw.split(/\r?\n/)[0]);
    assert.equal(sigEntry.sessionId, 'sess-fb-1');
  } finally {
    cleanupTmp(dir);
  }
});

// ============================================================================
// 8. .cac/githooks/run.mjs & pre-commit-check.mjs
// ============================================================================

test('githooks/run.mjs validates commit-msg, blocks broken syntax in pre-commit, fast-passes doc-only pre-push, and pre-commit-check guards git commit', () => {
  const dir = mkTmpRepo();
  try {
    // 1. commit-msg: reject low-info / short message, accept descriptive CJK/English subject
    const badMsgFile = path.join(dir, '.git', 'COMMIT_EDITMSG_BAD');
    fs.writeFileSync(badMsgFile, 'fix\n', 'utf8');
    const badMsg = runNode(GITHOOKS_RUN, ['commit-msg', badMsgFile], { cwd: dir });
    assert.equal(badMsg.status, 1);

    const noInfoFile = path.join(dir, '.git', 'COMMIT_EDITMSG_NOINFO');
    fs.writeFileSync(noInfoFile, 'chore(core): update\n', 'utf8');
    const noInfo = runNode(GITHOOKS_RUN, ['commit-msg', noInfoFile], { cwd: dir });
    assert.equal(noInfo.status, 1);

    const goodMsgFile = path.join(dir, '.git', 'COMMIT_EDITMSG_GOOD');
    fs.writeFileSync(goodMsgFile, 'feat(hooks): 增加 PowerShell 编码命令解码递归检查\n', 'utf8');
    const goodMsg = runNode(GITHOOKS_RUN, ['commit-msg', goodMsgFile], { cwd: dir });
    assert.equal(goodMsg.status, 0);

    // 2. Stage a broken JS file -> pre-commit-check (exit 2) & githooks pre-commit (exit 1)
    // Copy audit sentinels into temp repo so githooks pre-commit executes them against staged index
    for (const sentinel of ['scan-secrets.mjs', 'scan-instructions.mjs', 'check-syntax.mjs']) {
      const src = path.join(path.dirname(HARNESS_ENTRY), 'audit', sentinel);
      writeFiles(dir, { [`.cac/harness/audit/${sentinel}`]: fs.readFileSync(src, 'utf8') });
    }
    gitIn(dir, ['add', '.cac/harness/audit']);
    gitIn(dir, ['commit', '-m', 'chore(fixture): add audit sentinels']);

    writeFiles(dir, { 'src/broken.mjs': 'export function oops( {\n' });
    gitIn(dir, ['add', 'src/broken.mjs']);

    const hookCommitCheck = runHook('pre-commit-check', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: dir,
      tool_input: { command: 'git commit -m "feat(src): broken syntax"' },
    }, { cwd: dir });
    assert.equal(hookCommitCheck.status, 2);

    const gitPreCommitBad = runNode(GITHOOKS_RUN, ['pre-commit'], { cwd: dir });
    assert.equal(gitPreCommitBad.status, 1);

    // Fix syntax -> both pass
    writeFiles(dir, { 'src/broken.mjs': 'export function ok() { return 42; }\n' });
    gitIn(dir, ['add', 'src/broken.mjs']);
    const gitPreCommitOk = runNode(GITHOOKS_RUN, ['pre-commit'], { cwd: dir });
    assert.equal(gitPreCommitOk.status, 0);
    gitIn(dir, ['commit', '-m', 'feat(src): add valid ok module']);

    // 3. pre-push: pure doc commit between base..localSha fast-passes with exit 0
    const baseSha = gitIn(dir, ['rev-parse', 'HEAD']).stdout.trim();
    writeFiles(dir, { 'docs/guide.md': '# Guide\n' });
    gitIn(dir, ['add', 'docs/guide.md']);
    gitIn(dir, ['commit', '-m', 'docs(guide): add user guide']);
    const headSha = gitIn(dir, ['rev-parse', 'HEAD']).stdout.trim();

    const prePushDoc = runNode(GITHOOKS_RUN, ['pre-push', 'origin', 'https://example.com/repo.git'], {
      cwd: dir,
      input: `refs/heads/main ${headSha} refs/heads/main ${baseSha}\n`,
    });
    assert.equal(prePushDoc.status, 0);
    assert.match(prePushDoc.stderr, /纯文档推送/);
  } finally {
    cleanupTmp(dir);
  }
});

// ============================================================================
// 9. [Regression HIGH-1 & HIGH-4] tsc via process.execPath & record-authorship instance ID
// ============================================================================

test('[Regression HIGH-1] pre-commit-check and static-check execute node_modules/typescript/bin/tsc directly via process.execPath without .cmd and block on TS failure', () => {
  const dir = mkTmpRepo();
  try {
    const fakeTscRel = 'node_modules/typescript/bin/tsc';
    const fakeTscAbs = path.join(dir, 'node_modules', 'typescript', 'bin', 'tsc');
    const fakeTscSource = [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const args = process.argv.slice(2);',
      'if (args.includes("--version") || args.includes("-v")) {',
      '  process.stdout.write("Version 5.6.3\\n");',
      '  process.exit(0);',
      '}',
      'const root = process.cwd();',
      'const logDir = path.join(root, ".cac", ".runtime");',
      'fs.mkdirSync(logDir, { recursive: true });',
      'fs.appendFileSync(',
      '  path.join(logDir, "fake-tsc-runs.jsonl"),',
      '  JSON.stringify({ execPath: process.execPath, script: process.argv[1], args }) + "\\n",',
      '  "utf8",',
      ');',
      'const tsFile = path.join(root, "src", "app.ts");',
      'const src = fs.existsSync(tsFile) ? fs.readFileSync(tsFile, "utf8") : "";',
      'if (src.includes("__TRIGGER_TSC_ERROR__")) {',
      '  process.stderr.write("src/app.ts(1,14): error TS2322: [FAKE_TSC_EXECPATH_ERR] Type string is not assignable to number.\\n");',
      '  process.exit(2);',
      '}',
      'process.exit(0);',
    ].join('\n') + '\n';

    writeFiles(dir, {
      [fakeTscRel]: fakeTscSource,
      'tsconfig.json': JSON.stringify({ compilerOptions: { noEmit: true, strict: true }, include: ['src'] }, null, 2) + '\n',
      'src/app.ts': 'export const count: number = "__TRIGGER_TSC_ERROR__";\n',
    });
    // Ensure non-executable file mode (0o644) and zero .bin/tsc(.cmd) wrappers
    fs.chmodSync(fakeTscAbs, 0o644);
    assert.equal(fs.existsSync(path.join(dir, 'node_modules', '.bin')), false);

    gitIn(dir, ['add', 'tsconfig.json', 'src/app.ts']);

    // 1. Failing TS -> static-check exits 1 and pre-commit-check blocks git commit (exit 2)
    const staticFail = runNode(path.join(HOOKS_DIR, 'static-check.mjs'), [dir], { cwd: dir });
    assert.equal(staticFail.status, 1, `Expected static-check exit 1 on tsc error, got ${staticFail.status}: ${staticFail.stdout} ${staticFail.stderr}`);
    assert.match(staticFail.stdout + staticFail.stderr, /FAKE_TSC_EXECPATH_ERR/);

    const preCommitFail = runHook('pre-commit-check', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: dir,
      tool_input: { command: 'git commit -m "feat(ts): should block on tsc error"' },
    }, { cwd: dir });
    assert.equal(
      preCommitFail.status === 2 || preCommitFail.json?.hookSpecificOutput?.permissionDecision === 'deny',
      true,
      `Expected pre-commit-check to block git commit on tsc error (got status=${preCommitFail.status}, stdout=${preCommitFail.stdout}, stderr=${preCommitFail.stderr})`,
    );
    assert.match(preCommitFail.stdout + preCommitFail.stderr, /FAKE_TSC_EXECPATH_ERR/);

    // 2. Fix TS file -> both static-check and pre-commit-check pass via process.execPath
    writeFiles(dir, { 'src/app.ts': 'export const count: number = 42;\n' });
    gitIn(dir, ['add', 'src/app.ts']);

    const staticPass = runNode(path.join(HOOKS_DIR, 'static-check.mjs'), [dir], { cwd: dir });
    assert.equal(staticPass.status, 0, `Expected static-check exit 0 after fix: ${staticPass.stdout} ${staticPass.stderr}`);

    const preCommitPass = runHook('pre-commit-check', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: dir,
      tool_input: { command: 'git commit -m "feat(ts): valid typecheck"' },
    }, { cwd: dir });
    assert.equal(preCommitPass.status, 0, `Expected pre-commit-check exit 0 after fix: ${preCommitPass.stderr}`);
    assert.notEqual(preCommitPass.json?.hookSpecificOutput?.permissionDecision, 'deny');

    const runsRaw = fs.readFileSync(path.join(dir, '.cac', '.runtime', 'fake-tsc-runs.jsonl'), 'utf8').trim();
    const runs = runsRaw.split(/\r?\n/).map((line) => JSON.parse(line));
    assert.ok(runs.length >= 4, `Expected fake tsc to be invoked at least 4 times, got ${runs.length}`);
    for (const r of runs) {
      assert.equal(r.execPath, process.execPath);
      assert.equal(fs.realpathSync.native(r.script), fs.realpathSync.native(fakeTscAbs));
    }
  } finally {
    cleanupTmp(dir);
  }
});

test('[Regression HIGH-4] record-authorship records unique instance agent_id instead of role agent_type in authorship.jsonl', () => {
  const dir = mkTmpRepo({
    files: {
      'src/app.ts': 'export const v = 1;\n',
    },
  });
  try {
    fs.cpSync(path.join(HOOKS_DIR, 'lib'), path.join(dir, '.cac', 'hooks', 'lib'), { recursive: true });
    fs.cpSync(HARNESS_DIR, path.join(dir, '.cac', 'harness'), { recursive: true });
    writeFiles(dir, {
      '.cac/harness/module-catalog.json': JSON.stringify({
        version: 1,
        modules: [{ id: 'core', paths: ['src/**'] }],
        ignored: ['README.md', '.cac/**'],
      }, null, 2) + '\n',
      'src/app.ts': 'export const v = 2;\n',
    });

    const res = runHook('record-authorship', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      cwd: dir,
      session_id: 'sess-auth-high4',
      agent_id: 'a280c3a2466ea8b8e',
      agent_type: 'implementer',
      tool_input: { file_path: 'src/app.ts' },
    }, { cwd: dir });
    assert.equal(res.status, 0, `record-authorship failed: ${res.stderr}`);

    const ledgerPath = path.join(dir, '.cac', 'harness', 'state', 'authorship.jsonl');
    assert.equal(fs.existsSync(ledgerPath), true, 'Expected authorship.jsonl to be created');
    const lines = fs.readFileSync(ledgerPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.agentId, 'a280c3a2466ea8b8e', 'agentId must record unique instance agent_id');
    assert.notEqual(entry.agentId, 'implementer', 'agentId must NOT collapse to role name agent_type');
    assert.equal(entry.agentType, 'implementer');
    assert.deepEqual(entry.files, ['src/app.ts']);
  } finally {
    cleanupTmp(dir);
  }
});

// ============================================================================
// 10. [Regression v1.1.1/v1.2.0] Outer parent .git isolation + SessionStart snapshot
// ============================================================================

test('[Regression v1.1.1] uninitialized child project inside dirty outer parent .git injects startup snapshot + git init boundary hint and never false-alarms or blocks on sibling dirty files', () => {
  const parent = mkTmpRepo({
    prefix: 'cac-outer-git-hooks-',
    withProfile: false,
    withSettings: false,
    files: {
      'other-proj/tracked.ts': 'export const v = 1;\n',
      '.github/workflows/ci.yml': 'name: outer-ci\n',
    },
  });
  try {
    // Dirty the outer parent repo (both tracked governance-like workflow and sibling untracked/modified code)
    writeFiles(parent, {
      'other-proj/tracked.ts': 'export const v = 2;\n',
      'other-proj/dirty.ts': 'export const dirty = true;\n',
      '.github/workflows/ci.yml': 'name: outer-ci-dirty\n',
    });

    // Install cac-base into parent/cac-dryrun WITHOUT running `git init` inside cac-dryrun
    const childDir = path.join(parent, 'cac-dryrun');
    const cacCli = path.join(REPO_ROOT, 'scripts', 'cac-base.mjs');
    const inst = runNode(cacCli, ['install', '--target', childDir]);
    assert.equal(inst.status, 0, `install into childDir failed: ${inst.stderr}`);
    assert.equal(fs.existsSync(path.join(childDir, '.git')), false, 'cac-dryrun must NOT have its own .git');

    const childSessionStart = path.join(childDir, '.cac', 'hooks', 'session-start.mjs');
    const childSyncGate = path.join(childDir, '.cac', 'hooks', 'three-file-sync-gate.mjs');
    const childPrecompactGate = path.join(childDir, '.cac', 'hooks', 'precompact-gate.mjs');
    const childHarness = path.join(childDir, '.cac', 'harness', 'harness.mjs');

    // (a) SessionStart in parent/cac-dryrun with CODEAGENT3_PROJECT_DIR=parent/cac-dryrun
    const ss = runHook(childSessionStart, {
      hook_event_name: 'SessionStart',
      cwd: childDir,
    }, {
      cwd: childDir,
      projectDir: childDir,
    });
    assert.equal(ss.status, 0, `session-start failed: ${ss.stderr}`);
    const ssCtx = ss.json?.hookSpecificOutput?.additionalContext || '';
    assert.match(ssCtx, /tier:\s*standard（来源 default）/, 'tier must remain standard (default), never raised by parent .git');
    assert.match(ssCtx, /当前项目启动快照/, 'must inject startup snapshot heading');
    assert.match(ssCtx, /Product-Spec:\s*未创建/, 'must report Product-Spec: 未创建');
    assert.match(ssCtx, /Design-Brief:\s*未创建/, 'must report Design-Brief: 未创建');
    assert.match(ssCtx, /DEV-PLAN:\s*未创建/, 'must report DEV-PLAN: 未创建');
    assert.match(ssCtx, /progress\.md:\s*未创建/, 'must report progress.md: 未创建');
    assert.match(ssCtx, /人读文档:\s*未初始化/, 'must report 人读文档: 未初始化');
    assert.match(ssCtx, /git init/, 'must include uninitialized git init boundary notice');
    assert.doesNotMatch(ssCtx, /检测到 git 工作树有/, 'must NEVER false-alarm on parent dirty worktree');

    // Also verify env-less invocation (CODEAGENT3_PROJECT_DIR & CAC_PROJECT_DIR unset, no ev.cwd) locks onto childDir/.cac
    const ssNoEnv = runHook(childSessionStart, { hook_event_name: 'SessionStart' }, {
      cwd: childDir,
      projectDir: null,
    });
    assert.equal(ssNoEnv.status, 0);
    const ssNoEnvCtx = ssNoEnv.json?.hookSpecificOutput?.additionalContext || '';
    assert.match(ssNoEnvCtx, /当前项目启动快照/);
    assert.match(ssNoEnvCtx, /git init/);
    assert.doesNotMatch(ssNoEnvCtx, /检测到 git 工作树有/);

    // (c) three-file-sync-gate & precompact-gate in parent/cac-dryrun (even with progress.md + strict tier + local file)
    writeFiles(childDir, {
      'progress.md': '# Progress\n\n## Pinned\n- Isolated child project\n',
    });

    const syncStd = runHook(childSyncGate, {
      hook_event_name: 'Stop',
      cwd: childDir,
      stop_hook_active: false,
    }, { cwd: childDir, projectDir: childDir });
    assert.equal(syncStd.status, 0);
    assert.notEqual(syncStd.json?.decision, 'block');
    assert.equal(syncStd.stdout.trim(), '', 'three-file-sync-gate must emit neither block nor advise for parent dirty files');

    const preStd = runHook(childPrecompactGate, {
      hook_event_name: 'PreCompact',
      cwd: childDir,
    }, { cwd: childDir, projectDir: childDir });
    assert.equal(preStd.status, 0);
    assert.notEqual(preStd.json?.decision, 'block');
    assert.equal(preStd.stdout.trim(), '', 'precompact-gate must emit neither block nor warning for parent dirty files');

    // Even under explicit strict tier with local uninitialized files, outer parent .git must never trigger gates
    const strictSet = runNode(childHarness, ['tier', 'set', 'strict'], { cwd: childDir, projectDir: childDir });
    assert.equal(strictSet.status, 0);
    writeFiles(childDir, { 'src/local.ts': 'export const ok = 1;\n' });

    const syncStrict = runHook(childSyncGate, {
      hook_event_name: 'Stop',
      cwd: childDir,
      stop_hook_active: false,
    }, { cwd: childDir, projectDir: childDir });
    assert.equal(syncStrict.status, 0);
    assert.equal(syncStrict.stdout.trim(), '', 'strict three-file-sync-gate must stay silent before child runs git init');

    const preStrict = runHook(childPrecompactGate, {
      hook_event_name: 'PreCompact',
      cwd: childDir,
    }, { cwd: childDir, projectDir: childDir });
    assert.equal(preStrict.status, 0);
    assert.equal(preStrict.stdout.trim(), '', 'strict precompact-gate must stay silent before child runs git init');

    // Contrast: once childDir initializes its own git repo and modifies a local file, snapshot & dirty count reflect ONLY childDir
    runNode(childHarness, ['tier', 'set', 'standard'], { cwd: childDir, projectDir: childDir });
    writeFiles(childDir, {
      'Product-Spec.md': '# Child Product Spec\n',
      'docs/readable/index.html': '<!doctype html><title>Docs</title>\n',
      'node_modules/pkg/index.js': 'module.exports = 1;\n',
    });
    gitIn(childDir, ['init', '-b', 'main']);
    if (!fs.existsSync(path.join(childDir, '.git'))) {
      gitIn(childDir, ['init']);
    }
    gitIn(childDir, ['config', 'user.email', 'tester@cac-base.local']);
    gitIn(childDir, ['config', 'user.name', 'CacTester']);
    gitIn(childDir, ['config', 'commit.gpgsign', 'false']);
    writeFiles(childDir, { '.gitignore': 'node_modules/\n' });
    gitIn(childDir, ['add', '-A']);
    gitIn(childDir, ['commit', '-m', 'feat(init): initialize standalone child repository']);

    // Modify exactly 1 file inside childDir while parent still has 3 dirty files
    writeFiles(childDir, { 'src/local.ts': 'export const ok = 2;\n' });

    const ssOwnGit = runHook(childSessionStart, {
      hook_event_name: 'SessionStart',
      cwd: childDir,
    }, { cwd: childDir, projectDir: childDir });
    assert.equal(ssOwnGit.status, 0);
    const ownCtx = ssOwnGit.json?.hookSpecificOutput?.additionalContext || '';
    assert.match(ownCtx, /Product-Spec:\s*已存在/);
    assert.match(ownCtx, /progress\.md:\s*已存在/);
    assert.match(ownCtx, /人读文档:\s*已生成/);
    assert.match(ownCtx, /src\//);
    assert.doesNotMatch(ownCtx, /node_modules/);
    assert.doesNotMatch(ownCtx, /尚未独立执行 git init/);
    assert.match(ownCtx, /检测到 git 工作树有 1 处未提交改动/, 'ownRepo dirty count must reflect only childDir (1 file), never parent');
  } finally {
    cleanupTmp(parent);
  }
});

// ============================================================================
// 11. [Regression HIGH-3 & MEDIUM-2] pre-commit-check boundary/monorepo + symlink realpath root
// ============================================================================

test('[Regression HIGH-3] pre-commit-check blocks uninitialized child project from committing to outer parent .git (exit 2) and passes tracked monorepo subpackage with --relative path', () => {
  const parent = mkTmpRepo({
    prefix: 'cac-high3-precommit-',
    withProfile: false,
    withSettings: false,
    files: {
      'packages/app/package.json': JSON.stringify({ name: '@mono/app', version: '1.0.0' }, null, 2) + '\n',
      'outer-staged.mjs': 'export const outer = 1;\n',
    },
  });
  try {
    const cacCli = path.join(REPO_ROOT, 'scripts', 'cac-base.mjs');

    // Stage an outer file in parent so an unguarded `git commit` from child would otherwise leak into parent .git
    writeFiles(parent, { 'outer-staged.mjs': 'export const outer = 2;\n' });
    gitIn(parent, ['add', 'outer-staged.mjs']);

    // Scenario A: parent has .git, child `parent/cac-dryrun` is NOT `git init`-ed and NOT tracked by parent repo
    const childDir = path.join(parent, 'cac-dryrun');
    const instChild = runNode(cacCli, ['install', '--target', childDir]);
    assert.equal(instChild.status, 0, `install into childDir failed: ${instChild.stderr}`);
    assert.equal(fs.existsSync(path.join(childDir, '.git')), false);

    const childPreCommit = path.join(childDir, '.cac', 'hooks', 'pre-commit-check.mjs');
    const blockedBoundary = runHook(childPreCommit, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: childDir,
      tool_input: { command: 'git commit -m test' },
    }, { cwd: childDir, projectDir: childDir });
    assert.equal(
      blockedBoundary.status,
      2,
      `Expected exit 2 blocking boundary escape to parent .git in standard tier, got ${blockedBoundary.status}: ${blockedBoundary.stdout} ${blockedBoundary.stderr}`,
    );
    assert.match(blockedBoundary.stdout + blockedBoundary.stderr, /git init/);

    // Scenario B: legitimate tracked monorepo subpackage `parent/packages/app` with staged `parent/packages/app/src/ok.mjs`
    const appDir = path.join(parent, 'packages', 'app');
    const instApp = runNode(cacCli, ['install', '--target', appDir]);
    assert.equal(instApp.status, 0, `install into monorepo subpackage failed: ${instApp.stderr}`);

    writeFiles(appDir, { 'src/ok.mjs': 'export const greet = () => "ok";\n' });
    const addOk = gitIn(appDir, ['add', 'src/ok.mjs']);
    assert.equal(addOk.status, 0, `git add src/ok.mjs failed: ${addOk.stderr}`);

    const appPreCommit = path.join(appDir, '.cac', 'hooks', 'pre-commit-check.mjs');
    const monoPass = runHook(appPreCommit, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: appDir,
      tool_input: { command: 'git commit -m "feat(app): add ok module"' },
    }, { cwd: appDir, projectDir: appDir });
    assert.equal(
      monoPass.status,
      0,
      `Expected exit 0 for valid staged JS in tracked monorepo subpackage (no doubled packages/app/packages/app path), got ${monoPass.status}: ${monoPass.stdout} ${monoPass.stderr}`,
    );
    assert.doesNotMatch(monoPass.stdout + monoPass.stderr, /packages\/app\/packages\/app/);

    // Counter-check (never fake green): broken JS inside the same monorepo subpackage MUST still be caught (exit 2)
    writeFiles(appDir, { 'src/broken.mjs': 'export function bad( {\n' });
    gitIn(appDir, ['add', 'src/broken.mjs']);
    const monoBroken = runHook(appPreCommit, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: appDir,
      tool_input: { command: 'git commit -m "feat(app): broken syntax"' },
    }, { cwd: appDir, projectDir: appDir });
    assert.equal(monoBroken.status, 2, 'Broken staged JS in tracked monorepo subpackage must be blocked with exit 2');
  } finally {
    cleanupTmp(parent);
  }
});

test('[Regression MEDIUM-2] findCacProjectRoot and projectDir() resolve symlinked subdirectory via realpath to hit real-proj/.cac instead of escaping to outer .git', () => {
  const outerGit = mkTmpRepo({
    prefix: 'cac-med2-outer-',
    withProfile: false,
    withSettings: false,
    files: {
      'outer-only.txt': 'outer\n',
    },
  });
  const linkContainer = mkTmpDir('cac-med2-symlink-');
  try {
    const cacCli = path.join(REPO_ROOT, 'scripts', 'cac-base.mjs');
    const realProj = path.join(outerGit, 'real-proj');
    const inst = runNode(cacCli, ['install', '--target', realProj]);
    assert.equal(inst.status, 0, `install into real-proj failed: ${inst.stderr}`);

    writeFiles(realProj, {
      'Product-Spec.md': '# Real Project Spec\n',
      'src/entry.mjs': 'export const entry = true;\n',
    });
    assert.equal(fs.existsSync(path.join(outerGit, 'Product-Spec.md')), false);
    assert.equal(fs.existsSync(path.join(realProj, '.git')), false);

    // Create symlink `symlink-src -> real-proj/src` inside isolated os.tmpdir() subdirectory
    const symlinkSrc = path.join(linkContainer, 'symlink-src');
    const targetSrc = path.join(realProj, 'src');
    try {
      fs.symlinkSync(targetSrc, symlinkSrc, 'dir');
    } catch (err) {
      if (process.platform === 'win32' && err && (err.code === 'EPERM' || err.code === 'EACCES')) {
        fs.symlinkSync(targetSrc, symlinkSrc, 'junction');
      } else {
        throw err;
      }
    }

    // 1. Direct lexical-symlink resolution in both hooks/lib/io.mjs and harness/lib/core.mjs
    const hookHit = findHookCacRoot(symlinkSrc, outerGit);
    assert.ok(hookHit, 'io.findCacProjectRoot must resolve symlink-src via realpath');
    assert.equal(sameDir(hookHit, realProj), true, `io.findCacProjectRoot expected real-proj (${realProj}), got ${hookHit}`);
    assert.equal(sameDir(hookHit, outerGit), false, 'io.findCacProjectRoot must not escape to outer .git');

    const coreHit = findCoreCacRoot(symlinkSrc, outerGit);
    assert.ok(coreHit, 'core.findCacProjectRoot must resolve symlink-src via realpath');
    assert.equal(sameDir(coreHit, realProj), true, `core.findCacProjectRoot expected real-proj (${realProj}), got ${coreHit}`);
    assert.equal(sameDir(coreHit, outerGit), false, 'core.findCacProjectRoot must not escape to outer .git');

    // 2. Subprocess projectDir() with cwd=symlink-src and zero CODEAGENT3_PROJECT_DIR / CAC_PROJECT_DIR env vars
    const ioFileUrl = pathToFileURL(path.join(realProj, '.cac', 'hooks', 'lib', 'io.mjs')).href;
    const probeScript = path.join(linkContainer, 'probe-project-dir.mjs');
    fs.writeFileSync(
      probeScript,
      `import { projectDir } from ${JSON.stringify(ioFileUrl)};\nprocess.stdout.write(JSON.stringify({ root: projectDir() }) + "\\n");\n`,
      'utf8',
    );
    const probeRes = runNode(probeScript, [], { cwd: symlinkSrc, projectDir: null });
    assert.equal(probeRes.status, 0, `projectDir() subprocess probe failed: ${probeRes.stderr}`);
    assert.equal(
      sameDir(probeRes.json?.root, realProj),
      true,
      `projectDir() from cwd=symlink-src must hit real-proj (${realProj}), got ${probeRes.json?.root}`,
    );
    assert.equal(sameDir(probeRes.json?.root, outerGit), false, 'projectDir() must never escape to outer .git parent');

    // 3. End-to-end session-start.mjs from cwd=symlink-src without env vars or ev.cwd
    const ssRes = runHook(
      path.join(realProj, '.cac', 'hooks', 'session-start.mjs'),
      { hook_event_name: 'SessionStart' },
      { cwd: symlinkSrc, projectDir: null },
    );
    assert.equal(ssRes.status, 0, `session-start from symlink-src failed: ${ssRes.stderr}`);
    const ssCtx = ssRes.json?.hookSpecificOutput?.additionalContext || '';
    assert.match(ssCtx, /Product-Spec:\s*已存在/, 'session-start must inspect real-proj rather than outer .git');
    assert.match(ssCtx, /git init/, 'session-start must report uninitialized real-proj git boundary');
  } finally {
    cleanupTmp(linkContainer);
    cleanupTmp(outerGit);
  }
});
