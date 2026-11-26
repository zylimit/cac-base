// PostCompact：上下文压缩后回注核心不变量（profile.floor 安全地板闸，任何档位永不降级）。
//
// 压缩摘要容易丢失 Pinned 硬约束、待审状态与当前档位。本闸在压缩完成后直接从磁盘文件
// （或已装大仓引擎的 `harness invariants`）重新派生约束并经 hookSpecificOutput.additionalContext 回注。

import fs from 'node:fs';
import path from 'node:path';
import { projectDir, readStdinRaw, pendingReviewFiles, emit } from './lib/io.mjs';
import { harnessEntry, harnessRun, rcInContract } from './lib/harness.mjs';

const DEGRADE = {
  'no-harness': 'PostCompact: .cac/harness/harness.mjs 缺失，压缩后未能自动回注不变量——继续操作前请先显式 Read .cac/rules/AGENTS.md 与 progress.md。',
  engine: 'PostCompact: 治理引擎派生 invariants 异常，压缩后未能自动回注不变量——继续操作前请先显式 Read .cac/rules/AGENTS.md 与 progress.md。',
};

function degrade(kind) {
  emit({ systemMessage: DEGRADE[kind] || DEGRADE.engine });
  process.exitCode = 0;
}

const BUDGET = 1200;
const NO_ENGINE_MSG = 'PostCompact: invariants re-derived from files (ext not installed)';

function extInstalled(root) {
  try { return fs.existsSync(path.join(root, '.cac', 'harness', 'ext')); } catch (_e) { return false; }
}

function pinnedOf(root) {
  let raw;
  try { raw = fs.readFileSync(path.join(root, 'progress.md'), 'utf8'); } catch (_e) { return null; }
  const items = [];
  let inside = false;
  for (const line of raw.split(/\r?\n/)) {
    if (/^##\s/.test(line)) { inside = /^##\s*Pinned/i.test(line); continue; }
    if (inside && line.startsWith('- ')) {
      const text = line.slice(2).trim();
      if (text.includes('→ 被') && text.includes('取代')) continue;
      items.push(text.length > 120 ? `${text.slice(0, 120)}…` : text);
      if (items.length >= 12) break;
    }
  }
  return items;
}

async function tierOf(root) {
  try {
    const m = await import('./lib/tier.mjs');
    const t = m.effectiveTier({ projectDir: root });
    return `${t.tier}（来源 ${t.source}）`;
  } catch (_e) {
    return null;
  }
}

async function reinjectWithoutEngine(root) {
  const pins = pinnedOf(root);
  const pending = pendingReviewFiles(root);
  const tier = await tierOf(root);
  const gaps = [];
  if (!pins || !pins.length) gaps.push(pins ? 'progress.md 无 Pinned 条目' : 'progress.md 不存在');
  if (!tier) gaps.push('档位未知');

  const body = [
    '# INVARIANTS —— 由 PostCompact Hook 从磁盘实时派生',
    '',
    '## 当前项目状态',
    `- 档位：${tier || '未知'}`,
    `- 待审文件：${pending.length ? `${pending.length} 个（${pending.slice(0, 5).join('、')}）` : '无'}`,
    '- 宪法必守：主 Agent 严禁亲自写业务源码/审代码/跑验收测试/部署；命中阶段前须先 Read .cac/rules/*.md 对应细则。',
  ];
  if (pins && pins.length) {
    body.push('', '## Pinned（progress.md）', ...pins.map((p) => `- ${p}`));
  }
  const head = '刚刚发生了一次上下文压缩。压缩摘要可能遗漏硬约束，以下为刚从磁盘文件重新派生的现行不变量——请以此校准：\n\n';
  const full = head + body.join('\n');
  const mark = '\n（已按预算截断）';
  const text = full.length > BUDGET ? full.slice(0, BUDGET - mark.length) + mark : full;

  emit({
    systemMessage: gaps.length ? `${NO_ENGINE_MSG} -- ${gaps.join('；')}` : NO_ENGINE_MSG,
    hookSpecificOutput: {
      hookEventName: 'PostCompact',
      additionalContext: text,
    },
  });
  process.exitCode = 0;
}

const rawEvent = readStdinRaw();
let ev = {};
try { ev = rawEvent.trim() ? (JSON.parse(rawEvent) || {}) : {}; } catch (_e) { ev = {}; }

try {
  const root = projectDir(ev);
  if (!extInstalled(root)) {
    await reinjectWithoutEngine(root);
  } else if (!fs.existsSync(harnessEntry(root))) {
    degrade('no-harness');
  } else {
    const r = harnessRun(['invariants'], { cwd: root });
    const combined = `${r.stderr || ''}\n${r.stdout || ''}`;
    if (rcInContract(r.status, 3) && (/not installed|未安装/i.test(combined))) {
      await reinjectWithoutEngine(root);
    } else if (!rcInContract(r.status, 0, 3) || !r.stdout.trim()) {
      degrade('engine');
    } else {
      let inv = null;
      try { inv = JSON.parse(r.stdout.trim().split(/\r?\n/).pop() || ''); } catch (_e) { inv = null; }
      if (!inv || typeof inv.text !== 'string') {
        await reinjectWithoutEngine(root);
      } else {
        const bits = [];
        if (typeof ev.compact_trigger === 'string') bits.push('trigger=' + ev.compact_trigger);
        if (typeof ev.compaction_ratio === 'number') bits.push('compaction_ratio=' + ev.compaction_ratio);
        const what = bits.length ? `（${bits.join('，')}）` : '';
        const head = `刚刚发生了一次上下文压缩${what}。以下为从磁盘重新派生的现行不变量与活跃状态——请以此校准：\n\n`;
        emit({
          systemMessage: 'PostCompact: invariants re-derived from files and re-injected.',
          hookSpecificOutput: {
            hookEventName: 'PostCompact',
            additionalContext: head + inv.text,
          },
        });
        process.exitCode = 0;
      }
    }
  }
} catch (_e) {
  degrade('engine');
}
