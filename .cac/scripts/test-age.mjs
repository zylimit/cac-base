#!/usr/bin/env node
// .cac/scripts/test-age.mjs — Test case aging analysis over .cac/evidence/test-ledger.jsonl.
// Lists retirement candidates that executed >= minRuns times with 0 failures (excluding safety floor suites).
// Exit codes: 0 = completed, 2 = invalid arguments.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FLOOR_FILES = new Set([
  'secrets.test.mjs',
  'installer.test.mjs',
  'hooks-floor.test.mjs',
  'test-scan-secrets-userinfo.mjs',
  'test-setup.mjs',
  'test-hooks-floor.mjs',
]);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER = join(ROOT, '.cac', 'evidence', 'test-ledger.jsonl');

function main() {
  let minRuns = 20;
  let jsonMode = false;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--min-runs') minRuns = Number(args[++i]);
    else if (args[i].startsWith('--min-runs=')) minRuns = Number(args[i].slice(11));
    else if (args[i] === '--json') jsonMode = true;
    else {
      console.error(`未知参数：${args[i]}（用法：test-age.mjs [--min-runs N] [--json]）`);
      process.exit(2);
    }
  }
  if (!Number.isFinite(minRuns) || minRuns < 1) {
    console.error('--min-runs 需要一个 >= 1 的整数');
    process.exit(2);
  }

  if (!existsSync(LEDGER)) {
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ ok: true, ledgerPresent: false, candidates: [] }) + '\n');
    } else {
      console.log(`还没有测试账本（${LEDGER}）——运行一次 node .cac/tests/run-all.mjs 后自动生成。`);
    }
    process.exit(0);
  }

  const agg = new Map();
  let bad = 0;
  for (const line of readFileSync(LEDGER, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      bad++;
      continue;
    }
    if (!r || !r.file || !r.case) {
      bad++;
      continue;
    }
    const key = `${r.file}\u0000${r.case}`;
    const a = agg.get(key) || {
      file: r.file,
      case: r.case,
      runs: 0,
      fails: 0,
      skips: 0,
      firstSeen: r.t || '',
      lastFail: '',
    };
    // Count only real executions (PASS/FAIL); SKIPPED never counts toward retirement runs.
    if (r.result === 'PASS') {
      a.runs++;
    } else if (r.result === 'FAIL') {
      a.runs++;
      a.fails++;
      if (r.t && r.t > a.lastFail) a.lastFail = r.t;
    } else {
      a.skips++;
    }
    if (r.t && (!a.firstSeen || r.t < a.firstSeen)) a.firstSeen = r.t;
    agg.set(key, a);
  }

  const rows = [...agg.values()]
    .filter((a) => a.runs >= minRuns && a.fails === 0 && !FLOOR_FILES.has(a.file))
    .sort((x, y) => y.runs - x.runs || x.file.localeCompare(y.file));

  if (jsonMode) {
    process.stdout.write(
      JSON.stringify({
        ok: true,
        ledgerPresent: true,
        totalCases: agg.size,
        minRuns,
        corruptLines: bad,
        candidates: rows,
      }) + '\n',
    );
    process.exit(0);
  }

  console.log(`账本 ${LEDGER}`);
  console.log(`用例 ${agg.size} 条，退休门槛 --min-runs ${minRuns}（安全地板套件永不列入退休候选）`);
  if (bad) console.log(`损坏行 ${bad} 条（已跳过）`);
  if (!rows.length) {
    console.log('没有退休候选——要么运行次数尚未达到门槛，要么曾捕获过真实失败。');
    process.exit(0);
  }
  const w = (s, n) => String(s) + ' '.repeat(Math.max(1, n - String(s).length));
  console.log('');
  console.log(w('file', 32) + w('runs', 8) + w('firstSeen', 24) + 'case');
  for (const a of rows) {
    console.log(w(a.file, 32) + w(a.runs, 8) + w(a.firstSeen || '-', 24) + a.case);
  }
  console.log('');
  console.log(`共 ${rows.length} 条候选：运行 >= ${minRuns} 次且 0 次失败。精简前须人工复核并记入 progress.md。`);
}

const isMain = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  main();
}
