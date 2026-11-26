#!/usr/bin/env node
// red-blue-pack.mjs — 红蓝对抗审查纯 Node 跨平台证据包采集器（零 bash / awk / mktemp 依赖，Windows PowerShell 一等公民）。
// 用法：
//   node .cac/skills/red-blue-review/red-blue-pack.mjs [BASE] [HEAD] [--working]
//   - BASE 默认取最近 git tag，无 tag 回退 origin/main，再无回退根提交；
//   - HEAD 默认 HEAD；传 --working（可置于任意参数位）时对比 BASE..未提交工作树；
//   - BASE / HEAD ref 无效时向 stderr 响亮报错并以退出码 1 退出，绝不静默产出空证据包！
// 输出（stdout Markdown）：审查范围 / Commit 清单 / 改动统计 / 删除审计 / 未跟踪新文件 / 完整 diff（>800 行自动落临时文件）。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const MAX_INLINE_DIFF_LINES = 800;
const STALE_MS = 2 * 60 * 60 * 1000;
const toPosix = (p) => String(p).replace(/\\/g, '/');

function runGit(args, cwd) {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    ok: res.status === 0 && !res.error,
    status: res.status ?? 1,
    stdout: (res.stdout || '').replace(/\r\n?/g, '\n'),
    stderr: (res.stderr || '').replace(/\r\n?/g, '\n'),
  };
}

function resolveRealPathBestEffort(p) {
  const abs = path.resolve(String(p));
  let cur = abs;
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native ? fs.realpathSync.native(cur) : fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail) : real;
    } catch (_e) {
      try {
        const realFallback = fs.realpathSync(cur);
        return tail.length ? path.join(realFallback, ...tail) : realFallback;
      } catch (_e2) {
        const parent = path.dirname(cur);
        if (parent === cur) return abs;
        tail.unshift(path.basename(cur));
        cur = parent;
      }
    }
  }
}

function normDirKey(p) {
  if (!p) return '';
  const abs = resolveRealPathBestEffort(p);
  const posix = toPosix(abs).replace(/\/+$/, '') || '/';
  return process.platform === 'win32' ? posix.toLowerCase() : posix;
}

function sameDir(a, b) {
  if (!a || !b) return false;
  return normDirKey(a) === normDirKey(b);
}

function findCacProjectRoot(startDir, stopAt = null) {
  if (!startDir) return null;
  const resolvedStart = path.resolve(String(startDir));
  const stopKey = stopAt ? normDirKey(stopAt) : '';
  const homeKey = normDirKey(os.homedir());
  const tmpKey = normDirKey(os.tmpdir());

  const walkUp = (fromAbs, preserveRawStart) => {
    let cur = fromAbs;
    for (;;) {
      const curKey = normDirKey(cur);
      if (curKey === homeKey || curKey === tmpKey) break;
      if (fs.existsSync(path.join(cur, '.cac'))) {
        const isProjectCac = curKey !== homeKey && curKey !== tmpKey;
        if (isProjectCac) {
          return preserveRawStart && cur === fromAbs && fs.existsSync(path.join(String(startDir), '.cac'))
            ? String(startDir)
            : cur;
        }
      }
      if (stopKey && curKey === stopKey) break;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    return null;
  };

  const direct = walkUp(resolvedStart, true);
  if (direct) return direct;

  const realStart = resolveRealPathBestEffort(resolvedStart);
  const lexA = toPosix(resolvedStart).replace(/\/+$/, '') || '/';
  const lexB = toPosix(realStart).replace(/\/+$/, '') || '/';
  const sameSpelling = process.platform === 'win32'
    ? lexA.toLowerCase() === lexB.toLowerCase()
    : lexA === lexB;
  if (!sameSpelling) {
    return walkUp(realStart, false);
  }
  return null;
}

function cleanStaleTempDiffs() {
  const tmpDir = os.tmpdir();
  const now = Date.now();
  let entries = [];
  try {
    entries = fs.readdirSync(tmpDir, { withFileTypes: true });
  } catch (_e) {
    return;
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.startsWith('red-blue-diff.')) continue;
    const fp = path.join(tmpDir, e.name);
    try {
      const st = fs.statSync(fp);
      if (now - st.mtimeMs > STALE_MS) fs.unlinkSync(fp);
    } catch (_e) { /* 忽略并发删除 */ }
  }
}

function extractDeletedLineFiles(diffText) {
  const files = new Set();
  let currentFile = '';
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/.+$/.exec(line);
      currentFile = m ? m[1] : '';
      continue;
    }
    if (currentFile && line.startsWith('-') && !line.startsWith('---')) {
      files.add(currentFile);
      currentFile = '';
    }
  }
  return [...files].sort();
}

function usage() {
  return '用法：node .cac/skills/red-blue-review/red-blue-pack.mjs [BASE] [HEAD] [--working]';
}

function main() {
  const argv = process.argv.slice(2);
  let working = false;
  const pos = [];
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(usage() + '\n');
      process.exit(0);
    } else if (arg === '--working') {
      working = true;
    } else if (arg.startsWith('-')) {
      process.stderr.write(`red-blue-pack: 未知参数 '${arg}'（${usage()}）\n`);
      process.exit(2);
    } else {
      pos.push(arg);
      if (pos.length > 2) {
        process.stderr.write(`red-blue-pack: 多余参数 '${arg}'（${usage()}）\n`);
        process.exit(2);
      }
    }
  }

  const envDir = process.env.CODEAGENT3_PROJECT_DIR || process.env.CAC_PROJECT_DIR;
  const startDir = (envDir && envDir.trim()) ? path.resolve(envDir.trim()) : process.cwd();

  const top = runGit(['-c', 'core.quotePath=false', 'rev-parse', '--show-toplevel'], startDir);
  if (!top.ok || !top.stdout.trim()) {
    process.stderr.write('red-blue-pack: 不在 git 仓库内\n');
    process.exit(1);
  }
  const topDir = top.stdout.trim();
  const cacRoot = findCacProjectRoot(startDir, topDir);

  let root = topDir;
  let scopedSubdir = false;
  if (cacRoot) {
    const ownRepo = sameDir(topDir, cacRoot) || fs.existsSync(path.join(cacRoot, '.git'));
    if (!ownRepo) {
      const trackedSubdir = runGit(['ls-files', '--error-unmatch', '.'], cacRoot).ok;
      if (!trackedSubdir) {
        process.stderr.write('red-blue-pack: 当前 .cac 项目尚未独立 git init（检测到外层父目录存在 .git），拒绝越界打包父目录仓库\n');
        process.exit(1);
      }
      scopedSubdir = true;
    }
    root = cacRoot;
  }

  cleanStaleTempDiffs();

  let base = pos[0] || '';
  if (!base) {
    if (!runGit(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], root).ok) {
      process.stderr.write('red-blue-pack: 当前仓库尚无任何提交（HEAD 未初始化），无法建立对比基线\n');
      process.exit(1);
    }
    const tagRes = runGit(['describe', '--tags', '--abbrev=0'], root);
    if (tagRes.ok && tagRes.stdout.trim()) {
      base = tagRes.stdout.trim();
    } else if (runGit(['rev-parse', '--verify', '--quiet', 'origin/main'], root).ok) {
      base = 'origin/main';
    } else {
      const rootCommit = runGit(['rev-list', '--max-parents=0', 'HEAD'], root);
      if (rootCommit.ok && rootCommit.stdout.trim()) {
        base = rootCommit.stdout.trim().split('\n')[0].trim();
      }
    }
  }
  const head = pos[1] || 'HEAD';

  if (!base || !runGit(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], root).ok) {
    process.stderr.write(`red-blue-pack: 无效的 BASE ref '${base}'\n`);
    process.exit(1);
  }
  if (!working && !runGit(['rev-parse', '--verify', '--quiet', `${head}^{commit}`], root).ok) {
    process.stderr.write(`red-blue-pack: 无效的 HEAD ref '${head}'\n`);
    process.exit(1);
  }

  const rangeLabel = working ? `${base}..（未提交工作树）` : `${base}..${head}`;
  const diffRange = working ? [base] : [`${base}..${head}`];
  const diffArgs = ['-c', 'core.quotePath=false', 'diff', '--relative', ...diffRange, '--', '.'];
  const statArgs = ['-c', 'core.quotePath=false', 'diff', '--stat', '--relative', ...diffRange, '--', '.'];

  const baseSha = runGit(['rev-parse', '--short', base], root).stdout.trim() || '?';
  const headSha = working ? '' : (runGit(['rev-parse', '--short', head], root).stdout.trim() || '?');

  const out = [];
  out.push('## 红蓝审查证据包', '');
  out.push(`**审查范围**：${rangeLabel}`);
  out.push(`- BASE：${base}（${baseSha}）`);
  if (working) {
    out.push('- HEAD：未提交工作树（含已暂存 + 未暂存）');
  } else {
    out.push(`- HEAD：${head}（${headSha}）`);
  }
  out.push('');

  if (!working) {
    out.push('### Commit 清单');
    const logArgs = scopedSubdir
      ? ['log', '--oneline', `${base}..${head}`, '--', '.']
      : ['log', '--oneline', `${base}..${head}`];
    const logRes = runGit(logArgs, root);
    const logLines = logRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    if (logLines.length > 0) {
      for (const l of logLines) out.push(`- ${l}`);
    } else {
      out.push('（无新 commit）');
    }
    out.push('');
  }

  out.push('### 改动清单（git diff --stat）');
  out.push('```');
  const statRes = runGit(statArgs, root);
  out.push(statRes.stdout.trimEnd() || '（无改动）');
  out.push('```', '');

  const fullDiffRes = runGit(diffArgs, root);
  const fullDiff = fullDiffRes.stdout;

  out.push('### 删除审计（有删除行的文件——重点核有无误删既有规则）');
  const delFiles = extractDeletedLineFiles(fullDiff);
  if (delFiles.length > 0) {
    for (const f of delFiles) out.push(`- ${f}`);
  } else {
    out.push('（无删除行）');
  }
  out.push('');

  out.push('### 未跟踪新文件');
  const untrackedRes = runGit(['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard', '--', '.'], root);
  const untracked = untrackedRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (untracked.length > 0) {
    for (const f of untracked) out.push(`- ${f}`);
  } else {
    out.push('（无）');
  }
  out.push('');

  const diffLines = fullDiff ? (fullDiff.endsWith('\n') ? fullDiff.slice(0, -1).split('\n') : fullDiff.split('\n')) : [];
  const lineCount = diffLines.length;
  out.push(`### 完整 diff（${lineCount} 行）`);
  if (lineCount > MAX_INLINE_DIFF_LINES) {
    const tmpFile = path.join(os.tmpdir(), `red-blue-diff.${process.pid}.${Date.now()}.patch`);
    fs.writeFileSync(tmpFile, fullDiff, 'utf8');
    out.push(`diff 过长（${lineCount} 行），已写入临时文件，红队请读取此文件：`);
    out.push(`  ${toPosix(tmpFile)}`);
    out.push('（读完可删；超过 2 小时的陈旧残留下次运行会自动清理）');
  } else {
    out.push('```diff');
    if (fullDiff) out.push(fullDiff.trimEnd());
    out.push('```');
  }

  process.stdout.write(out.join('\n') + '\n');
}

main();
