#!/usr/bin/env node
// .cac/scripts/gate-audit.mjs — Read-only diagnostic summary of hook gate block records across main repo & worktrees.
// Pure Node >= 20, zero external dependencies, cross-platform (Windows PowerShell + WSL/Linux).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function toPosix(p) {
  return String(p ?? '').replace(/\\/g, '/');
}

function git(args, cwd) {
  return spawnSync('git', args, {
    cwd,
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

function resolveScanRoot() {
  const envDir = process.env.CODEAGENT3_PROJECT_DIR || process.env.CAC_PROJECT_DIR;
  const startDir = envDir && envDir.trim() ? path.resolve(envDir.trim()) : process.cwd();
  const r = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], startDir);
  if (r.status === 0 && r.stdout && r.stdout.trim()) {
    return path.dirname(r.stdout.trim());
  }
  const top = git(['rev-parse', '--show-toplevel'], startDir);
  if (top.status === 0 && top.stdout && top.stdout.trim()) {
    return path.resolve(top.stdout.trim());
  }
  return startDir;
}

function findGateBlockLogs(dir) {
  const logs = [];
  const walk = (cur) => {
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name === '.git' || ent.name === 'node_modules') continue;
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile() && ent.name === 'gate-block.log') {
        logs.push(full);
      }
    }
  };
  walk(dir);
  logs.sort();
  return logs;
}

function countTsConfigs(dir, maxDepth = 3) {
  let count = 0;
  const walk = (cur, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name === '.git' || ent.name === 'node_modules') continue;
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) walk(full, depth + 1);
      else if (ent.isFile() && ent.name === 'tsconfig.json') count++;
    }
  };
  walk(dir, 1);
  return count;
}

function discoverRegisteredGates(scanRoot) {
  const hooksDir = path.join(scanRoot, '.cac', 'hooks');
  if (!fs.existsSync(hooksDir)) return [];
  const names = [];
  for (const ent of fs.readdirSync(hooksDir, { withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.endsWith('.mjs')) continue;
    try {
      const src = fs.readFileSync(path.join(hooksDir, ent.name), 'utf8');
      if (/(?:gatelog|gateLog\s*\()/.test(src)) {
        names.push(ent.name.slice(0, -4));
      }
    } catch {
      /* ignore unreadable */
    }
  }
  return [...new Set(names)].sort();
}

function main() {
  const argv = process.argv.slice(2);
  let jsonMode = false;
  for (const a of argv) {
    if (a === '--json') jsonMode = true;
    else if (a === '-h' || a === '--help') {
      process.stdout.write('usage: node .cac/scripts/gate-audit.mjs [--json]\n');
      process.exit(0);
    } else {
      process.stderr.write(`gate-audit: 未知参数：${a}（用法：gate-audit.mjs [--json]）\n`);
      process.exit(2);
    }
  }

  const scanRoot = resolveScanRoot();
  const logs = findGateBlockLogs(scanRoot);
  const registered = discoverRegisteredGates(scanRoot);

  const statsMap = new Map();
  for (const logPath of logs) {
    let text = '';
    try {
      text = fs.readFileSync(logPath, 'utf8');
    } catch {
      continue;
    }
    for (const rawLine of text.split(/\r?\n/)) {
      if (!rawLine.trim()) continue;
      const parts = rawLine.split('\t');
      if (parts.length < 2 || !parts[1].trim()) continue;
      const ts = parts[0].trim();
      const name = parts[1].trim();
      const cur = statsMap.get(name) || { name, count: 0, firstSeen: ts, lastSeen: ts };
      cur.count++;
      if (!cur.firstSeen || (ts && ts < cur.firstSeen)) cur.firstSeen = ts;
      if (!cur.lastSeen || (ts && ts > cur.lastSeen)) cur.lastSeen = ts;
      statsMap.set(name, cur);
    }
  }

  const active = [...statsMap.values()].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name),
  );
  const zeroRecord = registered.filter((h) => !statsMap.has(h));
  const haveCount = registered.filter((h) => statsMap.has(h)).length;

  const catalogPresent = fs.existsSync(path.join(scanRoot, '.cac', 'harness', 'module-catalog.json'));
  const tsCount = countTsConfigs(scanRoot, 3);
  let pyCount = null;
  const gitCheck = git(['rev-parse', '--git-dir'], scanRoot);
  if (gitCheck.status === 0) {
    const pyRes = git(['ls-files', '*.py'], scanRoot);
    pyCount = pyRes.status === 0
      ? String(pyRes.stdout || '').split(/\r?\n/).filter((x) => x.trim().length > 0).length
      : 0;
  }

  if (jsonMode) {
    process.stdout.write(
      JSON.stringify({
        status: 'ok',
        code: 0,
        scanRoot: toPosix(scanRoot),
        registered,
        active,
        zeroRecord,
        logs: logs.map(toPosix),
        context: {
          catalogPresent,
          tsconfigCount: tsCount,
          pythonFileCount: pyCount,
        },
      }) + '\n',
    );
    return;
  }

  const pad = (s, w) => String(s) + ' '.repeat(Math.max(1, w - String(s).length));
  console.log('════════════════════════════════════════════════════════════════');
  console.log(' 钩子拦截战绩审计（gate-audit）');
  console.log(` 扫描根：${scanRoot}`);
  console.log('════════════════════════════════════════════════════════════════\n');

  console.log('── (a) 有战绩的钩子（按拦截次数降序）──');
  if (active.length > 0) {
    console.log(`${pad('钩子名', 30)}${pad('拦截次数', 10)}${pad('首次', 24)}末次`);
    for (const row of active) {
      console.log(`${pad(row.name, 30)}${pad(row.count, 10)}${pad(row.firstSeen, 24)}${row.lastSeen}`);
    }
  } else {
    console.log('（账本为空，没有任何拦截记录）');
  }
  console.log('');

  console.log('── (b) 零记录钩子（注册了但从没拦过：前置条件不在本仓，或威慑生效）──');
  if (zeroRecord.length === 0) {
    console.log('（无——所有注册钩子都至少拦过一次）');
  } else {
    for (const h of zeroRecord) console.log(`  • ${h}`);
  }
  console.log('');
  console.log('  本仓能力上下文：');
  console.log(`  module-catalog.json：${catalogPresent ? '有' : '无'}`);
  console.log(`  tsconfig.json：${tsCount} 个`);
  console.log(`  .py 文件：${pyCount === null ? '未知（非 git 目录）' : `${pyCount} 个`}`);
  console.log('  退役任何一个闸之前，请先核查下游项目的 .cac/evidence/gate-block.log。\n');

  console.log('── (c) 汇总 ──');
  console.log(`  注册钩子：${registered.length} 个`);
  console.log(`  有记录　：${haveCount} 个`);
  console.log(`  零记录　：${zeroRecord.length} 个\n`);
  console.log(`  找到的账本文件（${logs.length} 份）：`);
  if (logs.length > 0) {
    for (const f of logs) console.log(`    - ${f}`);
  } else {
    console.log('    （未找到任何 gate-block.log）');
  }
}

const isMain = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isMain) {
  main();
}
