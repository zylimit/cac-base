#!/usr/bin/env node
// static-check.mjs — code-review Stage 0 与 Phase 验收的全量机械静态检查入口（独立 CLI，非宿主事件 Hook）。
// 用法：node .cac/hooks/static-check.mjs [project_dir]
// 自动识别技术栈（shellcheck / ruff|py_compile / tsc / node --check）：全绿 exit 0，任一失败 exit 1，缺外部工具优雅跳过。

import fs from 'node:fs';
import path from 'node:path';
import { out, say, run } from './lib/io.mjs';

const PRUNE = new Set(['node_modules', '.git', 'dist', 'build', '.venv', 'out', 'release', '.cac']);
const JS_PRUNE = new Set(['node_modules', '.git', 'dist', 'build', '.venv', 'out', 'release', 'coverage']);
const JS_PRUNE_PATHS = new Set(['.cac/worktrees']);
const SH_PRUNE = new Set(['node_modules', '.git', 'dist', 'build', '.venv', 'out', 'release']);
const SH_PRUNE_PATHS = new Set(['.cac/worktrees', '.cac/harness/ext']);

const ran = [];
let fail = 0;

function have(cmd) {
  return run(cmd, ['--version']).error === null;
}

function resolveTsc(tsdir, root) {
  const rootAbs = path.resolve(root);
  let cur = path.resolve(rootAbs, tsdir);
  for (;;) {
    const tscJs = path.join(cur, 'node_modules', 'typescript', 'bin', 'tsc');
    try {
      if (fs.existsSync(tscJs) && fs.statSync(tscJs).isFile()) {
        return { exe: process.execPath, pre: [tscJs] };
      }
    } catch (_e) { /* ignore */ }
    if (cur === rootAbs) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  if (process.platform !== 'win32') {
    const v = run('tsc', ['--version'], { cwd: path.resolve(rootAbs, tsdir) });
    if (!v.error && v.status === 0) return { exe: 'tsc', pre: [] };
  }
  return null;
}

function probePython() {
  for (const cand of [['python3'], ['python'], ['py', '-3']]) {
    const [exe, ...pre] = cand;
    const v = run(exe, [...pre, '--version']);
    if (v.error && v.error.code === 'ENOENT') continue;
    if (v.status === 0 && /Python 3/.test(`${v.stdout}\n${v.stderr}`)) return { exe, pre };
  }
  return null;
}

function reportFail(tool, text) {
  out(`[${tool} 未通过]`);
  out(String(text).split(/\r?\n/).slice(0, 40).join('\n'));
  fail = 1;
}

function findFiles({ match, prune, prunePaths = new Set(), maxDepth = Infinity }) {
  const found = [];
  const walk = (dir, rel, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_e) { return; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (prune.has(e.name) || prunePaths.has(childRel)) continue;
        if (depth + 1 <= maxDepth) walk(path.join(dir, e.name), childRel, depth + 1);
      } else if (e.isFile() && match(e.name, childRel)) {
        found.push(`./${childRel}`);
      }
    }
  };
  walk('.', '', 0);
  return found;
}

const extIs = (...exts) => (name) => exts.some((x) => name.endsWith(x));

function filterNodeCheckNoise(text) {
  return String(text)
    .split(/\r?\n/)
    .filter((l) => !l.startsWith('    at ') && !l.startsWith('Node.js v'))
    .join('\n');
}

function checkPlainJs(f) {
  const r = run(process.execPath, ['--check', f]);
  return { status: r.status, text: filterNodeCheckNoise(`${r.stdout}${r.stderr}`) };
}

const dir = process.argv[2] || '.';
if (dir.includes('..')) {
  say(`static-check: unsafe dir ${dir}`);
  process.exitCode = 1;
} else {
  let ok = true;
  try {
    process.chdir(dir);
  } catch (_e) {
    say(`static-check: bad dir ${dir}`);
    process.exitCode = 1;
    ok = false;
  }
  if (ok) main();
}

function main() {
  // 1. Shell
  const sh = findFiles({
    match: (name, rel) => name.endsWith('.sh') || /^\.cac\/githooks\/(pre-commit|commit-msg|pre-push)$/.test(rel),
    prune: SH_PRUNE,
    prunePaths: SH_PRUNE_PATHS,
  });
  if (sh.length > 0 && have('shellcheck')) {
    ran.push('shellcheck');
    const r = run('shellcheck', sh);
    if (r.status !== 0) reportFail('shellcheck', `${r.stdout}${r.stderr}`);
  }

  // 2. Python
  const py = findFiles({ match: extIs('.py'), prune: PRUNE });
  if (py.length > 0) {
    if (have('ruff')) {
      ran.push('ruff');
      const r = run('ruff', ['check', '.']);
      if (r.status !== 0) reportFail('ruff', `${r.stdout}${r.stderr}`);
    } else {
      const pyExe = probePython();
      if (pyExe) {
        ran.push('py_compile');
        const bad = [];
        for (const f of py) {
          const r = run(pyExe.exe, [...pyExe.pre, '-m', 'py_compile', f]);
          const all = `${r.stdout}\n${r.stderr}`;
          if (r.status !== 0 && /SyntaxError/.test(all)) bad.push(`${f}\n${all.trim()}`);
        }
        if (bad.length > 0) reportFail('py_compile', bad.join('\n'));
      }
    }
  }

  // 3. TypeScript
  const tsDirs = [];
  const rootAbs = process.cwd();
  const cfgs = findFiles({ match: (n) => n === 'tsconfig.json', prune: PRUNE, maxDepth: 3 });
  for (const cfg of cfgs) {
    const tsdir = path.dirname(cfg).replace(/\\/g, '/');
    const tsc = resolveTsc(tsdir, rootAbs);
    if (!tsc) continue;
    tsDirs.push(tsdir);
    ran.push(`tsc(${tsdir})`);
    const r = run(tsc.exe, [...tsc.pre, '--noEmit'], { cwd: tsdir });
    if (r.status !== 0) reportFail(`tsc ${tsdir}`, `${r.stdout}${r.stderr}`);
  }

  // 4. JavaScript
  const js = findFiles({ match: extIs('.mjs', '.cjs', '.js'), prune: JS_PRUNE, prunePaths: JS_PRUNE_PATHS });
  if (js.length > 0) {
    let jsout = '';
    let jsn = 0;
    for (const f of js) {
      if (tsDirs.some((d) => d !== '.' && f.startsWith(`${d}/`))) continue;
      jsn += 1;
      const r = checkPlainJs(f);
      if (r.status !== 0) jsout += `${r.text}\n`;
    }
    if (jsn > 0) {
      ran.push(`node --check(${jsn})`);
      if (jsout.trim() !== '') reportFail('node --check', jsout);
    }
  }

  if (ran.length === 0) {
    out('static-check: 未识别到可运行的静态检查栈（或外部工具未装），已跳过。');
    return;
  }
  if (fail !== 0) {
    out('static-check: 静态检查未通过（见上），请修复后再进入语义审查。');
    process.exitCode = 1;
    return;
  }
  out(`static-check: 全绿（${ran.join(' ')}）。`);
}
