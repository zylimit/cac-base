#!/usr/bin/env node
// run.mjs — cac-base 纯 Node 跨平台 Git Hooks 统一内核（零 /tmp 依赖，Windows PowerShell / Git for Windows / WSL / Linux 一致）。
//
// 用法：
//   node .cac/githooks/run.mjs pre-commit
//   node .cac/githooks/run.mjs commit-msg <msg-file>
//   node .cac/githooks/run.mjs pre-push [remote-name] [remote-url]

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isatty } from 'node:tty';
import process from 'node:process';

function say(line = '') {
  try {
    fs.writeSync(2, String(line) + '\n');
  } catch (_e) {
    process.stderr.write(String(line) + '\n');
  }
}

function runCmd(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, {
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
    ...opts,
  });
  return {
    status: (r.status === null || r.status === undefined) ? -1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error || null,
  };
}

function git(args, opts = {}) {
  return runCmd('git', args, opts);
}

function repoRoot() {
  const r = git(['rev-parse', '--show-toplevel']);
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  return null;
}

function readStdinText() {
  if (isatty(0)) return '';
  const chunks = [];
  const buf = Buffer.alloc(64 * 1024);
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  let waited = 0;
  for (;;) {
    let n;
    try {
      n = fs.readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      const again = e && (e.code === 'EAGAIN' || e.code === 'EWOULDBLOCK');
      if (again && waited < 2000) {
        Atomics.wait(sleeper, 0, 0, 5);
        waited += 5;
        continue;
      }
      break;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function dumpHead(stdout, stderr, maxLines = 25) {
  const src = (stderr && stderr.trim()) ? stderr : stdout;
  if (!src || !src.trim()) {
    say('         （该命令无输出）');
    return;
  }
  const lines = src.replace(/\r/g, '').trimEnd().split('\n').slice(0, maxLines);
  for (const l of lines) say(l);
}

// ===========================================================================
// 1. pre-commit：三哨兵 (--staged) + 可选大仓 catalog-lint / fitness
// ===========================================================================
function classifyVerdict(contract, rc) {
  if (contract === 'audit') {
    if (rc === 0) return { verdict: 'ok', why: '扫过且干净' };
    if (rc === 1) return { verdict: 'block', why: '有违规命中（rc 1）' };
    if (rc === 2) return { verdict: 'block', why: '参数用法错（rc 2）——请检查 hook 调用参数' };
    if (rc === 3) return { verdict: 'degrade', why: '降级（rc 3）：部分检查项未执行，未执行 != 通过' };
    return { verdict: 'skip', why: `契约外退出码 rc ${rc}（契约只有 0/1/2/3）：工具异常，未执行 != 通过` };
  }
  if (contract === 'lint') {
    if (rc === 0) return { verdict: 'ok', why: '无错' };
    if (rc === 1) return { verdict: 'block', why: '有违规（rc 1）' };
    if (rc === 3) return { verdict: 'degrade', why: '降级（rc 3）：大仓包未装或无 catalog，未执行 != 通过' };
    return { verdict: 'skip', why: `契约外退出码 rc ${rc}（契约只有 0/1/3）：引擎异常，未执行 != 通过` };
  }
  return { verdict: 'skip', why: `未知契约 ${contract}` };
}

function runPreCommit() {
  const root = repoRoot();
  if (!root) return 0;
  process.chdir(root);

  const blocked = [];
  const degraded = [];
  const skipped = [];

  const check = (label, contract, scriptArgs) => {
    const r = runCmd(process.execPath, scriptArgs, { cwd: root });
    const { verdict, why } = classifyVerdict(contract, r.status);
    if (verdict === 'ok') {
      say(`  [OK]      ${label} —— ${why}`);
    } else if (verdict === 'block') {
      blocked.push(label);
      say(`  [BLOCK]   ${label} —— ${why}`);
      dumpHead(r.stdout, r.stderr, 25);
    } else if (verdict === 'degrade') {
      degraded.push(label);
      say(`  [DEGRADE] ${label} —— ${why}`);
      dumpHead(r.stdout, r.stderr, 25);
    } else {
      skipped.push(label);
      say(`  [SKIPPED] ${label} —— ${why}`);
      dumpHead(r.stdout, r.stderr, 25);
    }
  };

  const noteSkip = (label, reason) => {
    skipped.push(label);
    say(`  [SKIPPED] ${label} —— ${reason}（未执行 != 通过）`);
  };

  say('cac-base pre-commit：静态检查（密钥 + 指令安全 + 语法）');

  const sentinels = [
    ['secrets', '.cac/harness/audit/scan-secrets.mjs'],
    ['instructions', '.cac/harness/audit/scan-instructions.mjs'],
    ['syntax', '.cac/harness/audit/check-syntax.mjs'],
  ];
  for (const [label, relScript] of sentinels) {
    const full = path.join(root, ...relScript.split('/'));
    if (fs.existsSync(full)) {
      check(label, 'audit', [full, '--staged']);
    } else {
      noteSkip(label, `${relScript} 不存在`);
    }
  }

  const catalog = path.join(root, '.cac', 'harness', 'module-catalog.json');
  const engine = path.join(root, '.cac', 'harness', 'harness.mjs');
  if (fs.existsSync(catalog)) {
    if (!fs.existsSync(engine)) {
      noteSkip('catalog-lint/fitness', '.cac/harness/harness.mjs 不存在（有 catalog 却无引擎）');
    } else {
      check('catalog-lint', 'lint', [engine, 'catalog-lint']);
      const st = git(['-c', 'core.quotePath=false', 'diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], { cwd: root });
      const stagedFiles = st.status === 0
        ? st.stdout.split('\0').map((s) => s.replace(/\\/g, '/').trim()).filter(Boolean)
        : [];
      if (stagedFiles.length === 0) {
        noteSkip('fitness', '索引里没有新增/修改的文件');
      } else if (stagedFiles.some((f) => f.includes(',') || f.includes('\n')) || stagedFiles.length > 500) {
        say('  [注意]    fitness：暂存文件名含逗号/换行或数量超过 500，退回 changed 作用域');
        check('fitness', 'lint', [engine, 'fitness']);
      } else {
        check('fitness', 'lint', [engine, 'fitness', '--paths', stagedFiles.join(',')]);
      }
    }
  }

  say('');
  if (degraded.length > 0) {
    say(`cac-base pre-commit：降级项（未阻断但未完整执行）: ${degraded.join(' ')}`);
  }
  if (skipped.length > 0) {
    say(`cac-base pre-commit：未执行项（未执行 != 通过）: ${skipped.join(' ')}`);
  }
  if (blocked.length > 0) {
    say('');
    say(`❌ cac-base pre-commit：commit 被阻断，未过项: ${blocked.join(' ')}`);
    say('   请修复上述命中问题后再提交（--no-verify 绕过属 HIGH 档受控操作，须用户批准）。');
    return 1;
  }
  if (degraded.length > 0 || skipped.length > 0) {
    say('cac-base pre-commit：放行——但存在降级/跳过项，放行 != 全部通过。');
  } else {
    say('cac-base pre-commit：静态检查全部通过，放行。');
  }
  return 0;
}

// ===========================================================================
// 2. commit-msg：提交说明信息量与显示列宽校验（原生 UTF-8 / CJK 双列宽计算）
// ===========================================================================
function displayWidth(str) {
  let width = 0;
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0);
    // CJK 统一表意文字、全角标点、假名、韩文与 Emoji 计 2 列，ASCII 与拉丁字符计 1 列
    if (cp >= 0x1100 && (
      cp <= 0x115F
      || cp === 0x2329 || cp === 0x232A
      || (cp >= 0x2E80 && cp <= 0xA4CF && cp !== 0x303F)
      || (cp >= 0xAC00 && cp <= 0xD7A3)
      || (cp >= 0xF900 && cp <= 0xFAFF)
      || (cp >= 0xFE10 && cp <= 0xFE19)
      || (cp >= 0xFE30 && cp <= 0xFE6F)
      || (cp >= 0xFF00 && cp <= 0xFF60)
      || (cp >= 0xFFE0 && cp <= 0xFFE6)
      || cp >= 0x1F000
    )) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

const NO_INFO_WORDS = new Set([
  '', '.', '..', '...',
  'wip', 'tmp', 'temp', 'test', 'tests', 'fix', 'fixes', 'fixed', 'fixing',
  'update', 'updates', 'updated', 'change', 'changes', 'changed',
  'misc', 'stuff', 'things', 'asdf', 'minor', 'cleanup', 'clean', 'debug', 'todo',
]);

function isNoInfo(s) {
  if (NO_INFO_WORDS.has(s)) return true;
  const stripped = s.replace(/[0-9]+$/, '').trimEnd();
  if (stripped !== s && NO_INFO_WORDS.has(stripped)) return true;
  return false;
}

function runCommitMsg(args) {
  const msgFile = args[0];
  if (!msgFile || !fs.existsSync(msgFile)) return 0;

  let raw;
  try { raw = fs.readFileSync(msgFile, 'utf8'); } catch (_e) { return 0; }
  const firstLine = raw.replace(/^\uFEFF/, '').split(/\r?\n/)[0] || '';
  const subject = firstLine.trim();

  // 空消息交给 git 默认机制（兼容 --allow-empty-message）
  if (!subject) return 0;

  // 放行注释行、Merge、Revert 与 rebase --autosquash 前缀
  if (/^(?:#|Merge |Revert |fixup!|squash!|amend!)/.test(subject)) return 0;

  const width = displayWidth(subject);
  if (width < 12) {
    say(`cac-base commit-msg：subject 只有 ${width} 个显示列（下限 12）。请写清改了什么、为什么。`);
    say(`  被拒的 subject：${subject}`);
    say('  推荐风格：type(scope): 中文或英文具体变更说明（或 REQ-NNN 前缀）');
    return 1;
  }

  const lower = subject.toLowerCase().replace(/[.!]+$/, '').trimEnd();
  const body = lower.replace(/^[a-z][a-z0-9_-]*(?:\([^)]*\))?!?(?::|：)\s*/, '').trim();

  if (isNoInfo(lower) || isNoInfo(body)) {
    say(`cac-base commit-msg：「${subject}」缺少有效信息，请写明具体修改了哪个行为。`);
    say('  推荐风格：type(scope): 中文或英文具体变更说明');
    return 1;
  }

  if (width > 72) {
    say(`cac-base commit-msg：subject ${width} 个显示列（建议 <= 72），细节建议放入正文。本条仅告警不阻断。`);
  }
  return 0;
}

// ===========================================================================
// 3. pre-push：纯文档推送快速放行，代码推送执行 selftest + scan-secrets
// ===========================================================================
function isDocOnlyPath(p) {
  const norm = p.replace(/\\/g, '/');
  return norm === 'progress.md'
    || norm === 'progress.archive.md'
    || norm.startsWith('docs/')
    || norm.startsWith('domain/')
    || norm.startsWith('.cac/feedback/')
    || norm.endsWith('.md');
}

function runPrePush() {
  const root = repoRoot();
  if (!root) return 0;
  process.chdir(root);

  const stdinText = readStdinText();
  const lines = stdinText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  let refsCount = 0;
  let nonDeleteRefs = 0;
  let codePush = false;
  const changedFiles = [];

  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const [, localSha, , remoteSha] = parts;
    if (!localSha) continue;
    refsCount += 1;
    // 全 0 为删除远端分支
    if (/^0+$/.test(localSha)) continue;
    nonDeleteRefs += 1;

    let base = !/^0+$/.test(remoteSha) ? remoteSha : '';
    if (!base) {
      const om = git(['rev-parse', '--verify', '-q', 'origin/main'], { cwd: root });
      if (om.status === 0 && om.stdout.trim()) base = om.stdout.trim();
    }
    if (!base) {
      codePush = true;
      continue;
    }
    const d = git(['-c', 'core.quotePath=false', 'diff', '--name-only', '-z', `${base}..${localSha}`], { cwd: root });
    if (d.status !== 0) {
      codePush = true;
      continue;
    }
    for (const f of d.stdout.split('\0').filter(Boolean)) changedFiles.push(f);
  }

  // 若全是删除远端分支操作，无需检查直接放行
  if (refsCount > 0 && nonDeleteRefs === 0) return 0;
  if (refsCount === 0) codePush = true;
  if (!codePush && changedFiles.some((f) => !isDocOnlyPath(f))) codePush = true;

  if (!codePush) {
    say('cac-base pre-push：[OK] 纯文档推送，直接放行（progress.md / docs/ / domain/ / feedback / *.md）。');
    return 0;
  }

  say('cac-base pre-push：代码推送，执行引擎 selftest + 全仓密钥扫描。');
  const blocked = [];

  const checkPush = (label, relScript, scriptArgs) => {
    const full = path.join(root, ...relScript.split('/'));
    if (!fs.existsSync(full)) {
      say(`  [SKIPPED] ${label} —— ${relScript} 不存在（未执行 != 通过）`);
      return;
    }
    const r = runCmd(process.execPath, [full, ...scriptArgs], { cwd: root });
    if (r.status === 0) {
      say(`  [OK]      ${label} —— 跑过且干净`);
    } else if (r.status === 3) {
      say(`  [DEGRADE] ${label} —— 降级（rc 3）：未完整执行 != 通过`);
    } else {
      blocked.push(label);
      say(`  [BLOCK]   ${label} —— rc ${r.status}`);
      dumpHead(r.stdout, r.stderr, 30);
    }
  };

  checkPush('selftest', '.cac/harness/harness.mjs', ['selftest']);
  checkPush('secrets', '.cac/harness/audit/scan-secrets.mjs', []);

  if (blocked.length === 0) return 0;

  say('');
  say(`❌ cac-base pre-push：push 被阻断，未过项: ${blocked.join(' ')}`);
  say('   请修复上述问题后再推送（git push --no-verify 属 HIGH 档受控操作，须用户批准）。');
  return 1;
}

const hookName = process.argv[2];
const hookArgs = process.argv.slice(3);

switch (hookName) {
  case 'pre-commit':
    process.exitCode = runPreCommit();
    break;
  case 'commit-msg':
    process.exitCode = runCommitMsg(hookArgs);
    break;
  case 'pre-push':
    process.exitCode = runPrePush();
    break;
  default:
    say(`cac-base githooks/run.mjs: unknown hook "${hookName || ''}" (expected pre-commit | commit-msg | pre-push)`);
    process.exitCode = 2;
}
