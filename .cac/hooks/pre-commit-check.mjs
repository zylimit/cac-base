// PreToolUse(Bash|PowerShell|Shell)：git commit 前按本次暂存栈执行编译/语法门禁 + 人读文档重出 + 大仓四态门。
//
// 设计原则：
//   1. 仅在命令匹配 git commit 时触发；
//   2. 只检查本次 staged 改动涉及的语言栈（TS / Python / JS），工具未装时优雅降级跳过；
//   3. Windows 上探测真实 Python 3 解释器（过滤 Microsoft Store 空 stub）；
//   4. 若存在 docs/readable-src/config.json，自动重出人读文档并检查未暂存漂移；
//   5. 若存在 .cac/harness/module-catalog.json，联动 `harness verify` 大仓四态质量门。

import fs from 'node:fs';
import path from 'node:path';
import { projectDir, readStdinJson, git, run, say, errText, gateModeOf, toPosix } from './lib/io.mjs';
import { gateLog } from './lib/gatelog.mjs';
import {
  harnessEnabled, harnessExtInstalled, harnessExtMissingNotice, harnessRun, rcInContract, errHead,
} from './lib/harness.mjs';
import { refreshReadableDocs } from './lib/readable-refresh.mjs';

const TSCONFIG_MAX_DEPTH = 3;
const COMMIT_CMD_RE = /(?:^|[\s;&|(){}])git(?:\.exe)?(?:\s+-\S+(?:\s+\S+)?)*\s+commit(?:\s|$)/i;

function findTsconfig(root) {
  let level = [root];
  for (let depth = 0; depth <= TSCONFIG_MAX_DEPTH && level.length; depth++) {
    const next = [];
    for (const dir of level) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_e) { continue; }
      for (const e of entries) {
        if (e.isFile() && e.name === 'tsconfig.json') return path.join(dir, e.name);
      }
      for (const e of entries) {
        if (e.isDirectory() && e.name !== 'node_modules' && e.name !== '.next' && e.name !== '.git') {
          next.push(path.join(dir, e.name));
        }
      }
    }
    level = next;
  }
  return null;
}

function missing(r) {
  return Boolean(r.error && r.error.code === 'ENOENT');
}

function probePython(cwd) {
  for (const cand of [['python3'], ['python'], ['py', '-3']]) {
    const [exe, ...pre] = cand;
    const v = run(exe, [...pre, '--version'], { cwd });
    if (missing(v)) continue;
    if (v.status === 0 && /Python 3/.test(`${v.stdout}\n${v.stderr}`)) return { exe, pre };
  }
  return null;
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
    if (!missing(v) && !v.error && v.status === 0) return { exe: 'tsc', pre: [] };
  }
  return null;
}

async function main() {
  const ev = readStdinJson();
  if (!ev) return;
  const cmd = String((ev.tool_input && ev.tool_input.command) || '');
  if (!COMMIT_CMD_RE.test(cmd)) return;

  const root = projectDir(ev);
  const mode = await gateModeOf('pre-commit-check', root);
  let engineBroken = false;
  if (mode === 'off') return;

  // 1. 人读工程文档重出与漂移检查
  if (refreshReadableDocs(root, mode)) process.exitCode = 2;

  // 2. 读取本次暂存的新增/复制/修改/重命名文件（NUL 分隔防中文/空格截断）
  const staged = git(['-c', 'core.quotePath=false', 'diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'], { cwd: root });
  const files = staged.stdout.split('\0').map((s) => toPosix(s.trim())).filter(Boolean);
  if (staged.status !== 0 || files.length === 0) return;

  let fail = false;

  // 3. TypeScript
  if (files.some((f) => /\.(ts|tsx)$/.test(f))) {
    const tsconfig = findTsconfig(root);
    if (tsconfig) {
      const tsdir = path.dirname(tsconfig);
      const tsc = resolveTsc(tsdir, root);
      if (tsc) {
        const r = run(tsc.exe, [...tsc.pre, '--noEmit'], { cwd: tsdir });
        if (!missing(r) && r.status !== 0) {
          say('❌ TypeScript 编译检查未通过，commit 被阻止：');
          say(`${r.stdout}${r.stderr}`.trimEnd());
          fail = true;
        }
      }
    }
  }

  // 4. Python
  const pyFiles = files.filter((f) => /\.py$/.test(f));
  if (pyFiles.length) {
    const ruff = run('ruff', ['check', ...pyFiles], { cwd: root });
    if (!missing(ruff)) {
      if (ruff.status !== 0) {
        say('❌ Python 检查未通过（ruff check），commit 被阻止：');
        say(`${ruff.stdout}${ruff.stderr}`.trimEnd());
        fail = true;
      }
    } else {
      const py = probePython(root);
      if (py) {
        const tool = `${py.exe} -m py_compile（未装 ruff，降级语法检查）`;
        const bad = [];
        for (const f of pyFiles) {
          const c = run(py.exe, [...py.pre, '-m', 'py_compile', f], { cwd: root });
          const all = `${c.stdout}\n${c.stderr}`;
          if (!missing(c) && c.status !== 0 && /SyntaxError/.test(all)) bad.push(`${f}\n${all.trim()}`);
        }
        if (bad.length) {
          say(`❌ Python 检查未通过（${tool}），commit 被阻止：`);
          say(bad.join('\n'));
          fail = true;
        }
      }
    }
  }

  // 5. JavaScript
  const jsFiles = files.filter((f) => /\.(mjs|cjs|js)$/.test(f));
  if (jsFiles.length) {
    const bad = [];
    for (const f of jsFiles) {
      const c = run(process.execPath, ['--check', f], { cwd: root });
      if (c.status !== 0) {
        bad.push(`${c.stdout}${c.stderr}`.split(/\r?\n/)
          .filter((l) => !l.startsWith('    at ') && !l.startsWith('Node.js v'))
          .join('\n').trim());
      }
    }
    if (bad.length) {
      say('❌ JavaScript 语法检查未通过（node --check），commit 被阻止：');
      say(bad.join('\n'));
      fail = true;
    }
  }

  // 6. 大仓四态质量门（module-catalog.json 存在才启用）
  if (harnessEnabled(root) && !harnessExtInstalled(root)) {
    const notice = harnessExtMissingNotice('大仓四态质量门（harness verify）');
    say(notice);
    gateLog('pre-commit-check', notice, root);
  } else if (harnessEnabled(root)) {
    const r = harnessRun(['verify'], { cwd: root });
    if (r.status === 2) {
      say('❌ 大仓四态质量门未通过（受影响模块定向检查 FAIL/BLOCKED），commit 被阻止：');
      say(r.stdout.trimEnd());
      fail = true;
    } else if (!rcInContract(r.status, 0, 3)) {
      engineBroken = true;
      say(`❌ 大仓四态质量门异常（harness verify 以契约外退出码 ${r.status} 退出，契约只有 0/2/3），commit 被阻止：`);
      say(errHead(r.stderr) || '（引擎无 stderr 输出）');
      say('请运行 node .cac/harness/harness.mjs verify 排查引擎故障。');
      fail = true;
    }
  }

  if (fail) {
    const why = engineBroken ? '大仓质量门跑不起来（引擎契约外退出码）' : '编译/语法门禁未通过';
    if (mode === 'advise') {
      say(`[fast] 以上${why}，fast 档不拦本次 commit——欠账仍在，回 standard 前请修掉。`);
      gateLog('pre-commit-check', `[fast] ${why}，advise 档放行 commit`, root);
      return;
    }
    gateLog('pre-commit-check', `${why}，commit 被阻止`, root);
    process.exitCode = 2;
  }
}

main().catch((e) => {
  say(`❌ pre-commit-check 自身异常，commit 被阻止：${errText(e)}`);
  process.exitCode = 2;
});
