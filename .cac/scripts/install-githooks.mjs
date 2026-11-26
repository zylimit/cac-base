#!/usr/bin/env node
// .cac/scripts/install-githooks.mjs — Explicit repository-local switch for .cac/githooks (on | off | status).
// OFF BY DEFAULT: setup.sh / setup.ps1 never touch core.hooksPath without explicit user opt-in.
// Pure Node >= 20 cross-platform script (replaces separate .sh and .ps1 variants).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REL_HOOKS = '.cac/githooks';
const HOOK_NAMES = ['pre-commit', 'commit-msg', 'pre-push'];

function toPosix(p) {
  return String(p ?? '').replace(/\\/g, '/');
}

function git(args, cwd) {
  return spawnSync('git', args, {
    cwd,
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
  });
}

function getHooksPath(root) {
  const r = git(['config', '--local', '--get', 'core.hooksPath'], root);
  if (r.status !== 0 || !r.stdout) return '';
  return String(r.stdout).trim().split(/\r?\n/)[0] || '';
}

function main() {
  const argv = process.argv.slice(2);
  let action = 'status';
  let jsonMode = false;

  for (const a of argv) {
    if (a === '--json') {
      jsonMode = true;
    } else if (a === 'on' || a === 'off' || a === 'status') {
      action = a;
    } else {
      process.stderr.write('用法: node .cac/scripts/install-githooks.mjs [on|off|status] [--json]\n');
      process.exit(2);
    }
  }

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const hooksDir = path.join(root, '.cac', 'githooks');

  const top = git(['rev-parse', '--show-toplevel'], root);
  if (top.status !== 0) {
    process.stderr.write('install-githooks: 当前目录不是 git 仓库（git rev-parse --show-toplevel 失败）\n');
    process.exit(2);
  }

  const prev = getHooksPath(root);
  const normPrev = toPosix(prev).replace(/\/+$/, '');

  if (action === 'on') {
    if (!fs.existsSync(hooksDir) || !fs.statSync(hooksDir).isDirectory()) {
      process.stderr.write(`install-githooks: 找不到目录 ${hooksDir}\n`);
      process.exit(2);
    }
    if (normPrev && normPrev !== REL_HOOKS) {
      process.stderr.write(`install-githooks: core.hooksPath 已被其他工具占用（当前 = ${prev}）。\n`);
      process.stderr.write(`  为保护现有资产不自动覆盖；若确认切换请手动执行：git config --local core.hooksPath ${REL_HOOKS}\n`);
      process.exit(2);
    }
    if (process.platform !== 'win32') {
      for (const h of HOOK_NAMES) {
        const hp = path.join(hooksDir, h);
        if (fs.existsSync(hp)) {
          try {
            fs.chmodSync(hp, 0o755);
          } catch {
            /* ignore */
          }
        }
      }
    }
    const w = git(['config', '--local', 'core.hooksPath', REL_HOOKS], root);
    if (w.status !== 0) {
      process.stderr.write(`install-githooks: git config 写入失败：${w.stderr || ''}\n`);
      process.exit(2);
    }
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ ok: true, state: 'on', hooksPath: REL_HOOKS }) + '\n');
    } else {
      console.log(`install-githooks: on（core.hooksPath = ${REL_HOOKS}，仅限本仓库）`);
      console.log('  已启用：pre-commit / commit-msg / pre-push');
      console.log('  关闭命令：node .cac/scripts/install-githooks.mjs off');
    }
    process.exit(0);
  }

  if (action === 'off') {
    if (!normPrev) {
      if (jsonMode) {
        process.stdout.write(JSON.stringify({ ok: true, state: 'off', note: 'already-unset' }) + '\n');
      } else {
        console.log('install-githooks: off（core.hooksPath 本来就未设置）');
      }
      process.exit(0);
    }
    if (normPrev !== REL_HOOKS) {
      process.stderr.write(`install-githooks: 未改动（core.hooksPath = ${prev}，非 cac-base 设置）\n`);
      process.exit(2);
    }
    git(['config', '--local', '--unset', 'core.hooksPath'], root);
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ ok: true, state: 'off', hooksPath: null }) + '\n');
    } else {
      console.log('install-githooks: off（core.hooksPath 已清除，恢复默认 .git/hooks）');
    }
    process.exit(0);
  }

  // status
  const hookStates = HOOK_NAMES.map((h) => {
    const hp = path.join(hooksDir, h);
    const present = fs.existsSync(hp) && fs.statSync(hp).isFile();
    let executable = present;
    if (present && process.platform !== 'win32') {
      executable = Boolean(fs.statSync(hp).mode & 0o111);
    }
    return { name: h, present, executable };
  });

  if (jsonMode) {
    process.stdout.write(
      JSON.stringify({
        ok: true,
        state: normPrev === REL_HOOKS ? 'on' : 'off',
        hooksPath: prev || null,
        hooks: hookStates,
      }) + '\n',
    );
    process.exit(0);
  }

  if (normPrev === REL_HOOKS) {
    console.log(`install-githooks: on（core.hooksPath = ${prev}）`);
    for (const hs of hookStates) {
      if (hs.present && hs.executable) {
        console.log(`  ${hs.name}: 已就绪`);
      } else if (hs.present) {
        console.error(`  ${hs.name}: 存在但缺少可执行权限（重跑 on 修复）`);
      } else {
        console.error(`  ${hs.name}: 缺失（${path.join(hooksDir, hs.name)}）`);
      }
    }
  } else if (normPrev) {
    console.log(`install-githooks: off（core.hooksPath = ${prev}，由其他工具管理）`);
  } else {
    console.log('install-githooks: off（core.hooksPath 未设置，使用默认 .git/hooks）');
  }
}

const isMain = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isMain) {
  main();
}
