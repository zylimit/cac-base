// PostToolUse(Edit|Write|MultiEdit|NotebookEdit)：业务源码变更后自动按文件登记至 .cac/.needs-review。
//
// 特性：
//   1. Windows 反斜杠转正斜杠 + realpathSync.native 展开 8.3 短路径与软链；
//   2. 折叠 ./.. 后越出项目根的路径不登记，防止脏行永久卡住 stop-gate；
//   3. 豁免顶层 tools/、.cac/ 以及纯文档/配置后缀；
//   4. 独占锁 .cac/.needs-review.lock（5s 陈旧锁自动回收），防并发写入互相覆盖。

import fs from 'node:fs';
import path from 'node:path';
import { projectDir, readStdinJson, toPosix, say, fastOff, runFailOpen } from './lib/io.mjs';

const LOCK_STALE_MS = 5000;
const LOCK_WAIT_MS = 1000;

function realish(p) {
  const abs = path.resolve(String(p));
  let cur = abs;
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return tail.length ? path.join(real, ...tail) : real;
    } catch (_e) {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

function escapes(rel) {
  return rel === '..' || rel.startsWith('../') || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);
}

function acquireLock(lockFile) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      return fs.openSync(lockFile, 'wx');
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return -1;
      let age = 0;
      try { age = Date.now() - fs.statSync(lockFile).mtimeMs; } catch (_e) { age = LOCK_STALE_MS + 1; }
      if (age >= LOCK_STALE_MS) {
        try { fs.rmSync(lockFile, { force: true }); } catch (_e2) { /* retry */ }
        continue;
      }
      if (Date.now() >= deadline) return -1;
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); } catch (_e2) { /* retry */ }
    }
  }
}

function releaseLock(fd, lockFile) {
  if (fd < 0) return;
  try { fs.closeSync(fd); } catch (_e) { /* ignore */ }
  try { fs.rmSync(lockFile, { force: true }); } catch (_e) { /* ignore */ }
}

runFailOpen(async () => {
  const input = readStdinJson();
  if (!input) return;

  const root = projectDir(input);
  if (await fastOff('mark-review-needed', root)) return;

  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const filePath = toolInput.file_path || toolInput.notebook_path;
  if (!filePath || typeof filePath !== 'string') return;

  const rootAbs = path.resolve(root);
  const rootPosix = toPosix(rootAbs).replace(/\/+$/, '');
  const raw = toPosix(filePath);
  const isAbs = path.isAbsolute(raw) || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw);
  const litAbs = isAbs ? raw : `${rootPosix}/${raw}`;

  let rel;
  if (litAbs === rootPosix || litAbs.startsWith(rootPosix + '/')) {
    rel = litAbs.slice(rootPosix.length + 1);
  } else {
    const relId = path.relative(realish(rootAbs), realish(path.isAbsolute(filePath) ? filePath : path.join(rootAbs, filePath)));
    if (relId === '' || escapes(relId)) return;
    rel = toPosix(relId);
  }

  const folded = path.posix.normalize(rel);
  if (folded === '' || folded === '.' || folded === '..' || folded.startsWith('../')) {
    say(`[mark-review-needed] 未登记 ${litAbs}：路径折叠后越出项目根目录（${folded || '空'}）`);
    return;
  }
  rel = folded;

  // 豁免 1：顶层框架与工具目录
  if (/^(tools|\.cac)\//.test(rel)) return;
  // 豁免 2：纯文档与配置文件后缀
  if (/\.(md|txt|json|yaml|yml|toml|lock|log|gitignore|prettierrc|eslintrc)$/i.test(rel)) return;
  if (/\.env(\.(local|development|production|staging|test))?$/i.test(rel)) return;

  const stateFile = path.join(rootAbs, '.cac', '.needs-review');
  const lockFile = `${stateFile}.lock`;
  try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); } catch (_e) { /* handled below */ }

  const fd = acquireLock(lockFile);
  try {
    let lines = [];
    let prior = null;
    try { prior = fs.readFileSync(stateFile, 'utf8'); } catch (_e) { prior = null; }
    if (prior !== null) {
      lines = prior.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.includes('clean')) lines = [];
    }
    if (!lines.includes(rel)) lines.push(rel);
    fs.writeFileSync(stateFile, lines.length ? lines.join('\n') + '\n' : '', 'utf8');
  } finally {
    releaseLock(fd, lockFile);
  }
});
