#!/usr/bin/env node
// plan-lint.mjs — DEV-PLAN.md 纯 Node 跨平台静态质量闸（无需 bash / python3）。
// 用法：node .cac/scripts/plan-lint.mjs [plan] [spec] [--json]
//   默认 plan = DEV-PLAN.md，spec = <plan同目录>/Product-Spec.md。
//   DEV-PLAN.md 不存在时正常提示并退出 0（框架仓本体无 DEV-PLAN）。
// 核查项：
//   1) 禁未完成占位符（TBD / TODO / 待补充 / 待确定 / 类似 Task / 类似 Phase / 按需调整 / 做相应修改 / implement later）
//   2) Phase 结构完整（交付内容 / 验证的假设 / 关键文件 / Task 清单 / 验收标准）
//   3) Task 粒度（每个 Phase 至少 1 条 `- **Task N.M：...**`）
//   4) Product-Spec.md REQ 双向覆盖 + `## 已归档 Phase` 指针行箭头后 `（REQ：…）` 后缀识别 + `## 范围外（本次不计划）` 核查
// 退出码：0 通过或跳过 / 1 校验未通过 / 2 参数用法错误。

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const USAGE = '用法：node .cac/scripts/plan-lint.mjs [plan] [spec] [--json]';

function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

function parseCli(argv) {
  const positionals = [];
  let json = false;
  let help = false;
  for (const arg of argv) {
    if (arg === '--json') {
      json = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg.startsWith('-')) {
      return { error: `未知参数 ${arg}（${USAGE}）` };
    } else {
      positionals.push(arg);
      if (positionals.length > 2) {
        return { error: `多余参数 ${arg}（${USAGE}）` };
      }
    }
  }
  const plan = positionals[0] || 'DEV-PLAN.md';
  const spec = positionals[1] || path.join(path.dirname(plan), 'Product-Spec.md');
  return { plan, spec, json, help };
}

function splitLines(raw) {
  const norm = raw.replace(/\r\n?/g, '\n');
  if (!norm) return [];
  return norm.endsWith('\n') ? norm.slice(0, -1).split('\n') : norm.split('\n');
}

function fencedSet(srcLines) {
  const marked = new Set();
  let inFence = false;
  for (let i = 0; i < srcLines.length; i++) {
    if (/^\s*```/.test(srcLines[i])) {
      marked.add(i);
      inFence = !inFence;
      continue;
    }
    if (inFence) marked.add(i);
  }
  return marked;
}

const PLACEHOLDER_SPECS = [
  { label: '\\bTBD\\b', re: /\bTBD\b/i },
  { label: '\\bTODO\\b', re: /\bTODO\b/i },
  { label: '待补充', re: /待补充/i },
  { label: '待确定', re: /待确定/i },
  { label: '类似 Task', re: /类似 Task/i },
  { label: '类似 Phase', re: /类似 Phase/i },
  { label: '按需调整', re: /按需调整/i },
  { label: '做相应修改', re: /做相应修改/i },
  { label: 'implement later', re: /implement later/i },
];

const PHASE_HEADING_RE = /^## Phase\s+\d+[:：].*$/;
const H2_RE = /^##\s+/;
const TASK_ITEM_RE = /^\s*-\s*\*\*Task\s+\d+\.\d+[:：]/;
const PHASE_ANCHORS = ['**交付内容**', '**验证的假设**', '**关键文件**', '**Task 清单**', '**验收标准**'];

const REQ_DECL_RE = /^\s{0,1}(?:[-*+]|\d+[.)])\s*\[(REQ-[A-Za-z0-9]{1,16}-\d{2,4})\]\s*/;
const REQ_REF_SRC = '\\bREQ-[A-Za-z0-9]{1,16}-\\d{2,4}\\b';
const REQ_REF_RE = new RegExp(REQ_REF_SRC, 'g');

const ARCHIVED_HEADING_RE = /^## 已归档 Phase\s*$/;
const ARCHIVED_POINTER_RE = /^\s*-\s.*(?:→|->)\s*DEV-PLAN\.archive\.md/;
const ARCHIVED_ARROW_RE = /(?:→|->)\s*DEV-PLAN\.archive\.md/;
const ARCHIVED_SUFFIX_RE = /^\s*[（(]REQ[:：]([^）)]*)[）)]/;

const OOS_HEADING_RE = /^## 范围外（本次不计划）\s*$/;
const OOS_ITEM_RE = new RegExp(`^\\s*-\\s*(${REQ_REF_SRC})\\s*[:：]\\s*(.*)$`);

function findAllReqRefs(line) {
  return [...line.matchAll(REQ_REF_RE)].map((m) => m[0]);
}

function scanIds(srcLines, skipSet) {
  const declared = new Map();
  const mentioned = new Map();
  for (let i = 0; i < srcLines.length; i++) {
    if (skipSet.has(i)) continue;
    const line = srcLines[i];
    const decl = REQ_DECL_RE.exec(line);
    if (decl && !declared.has(decl[1])) {
      declared.set(decl[1], i + 1);
    }
    for (const reqId of findAllReqRefs(line)) {
      if (!mentioned.has(reqId)) mentioned.set(reqId, i + 1);
    }
  }
  return { declared, mentioned };
}

function nameFew(idToLineMap) {
  const entries = [...idToLineMap.entries()].sort((a, b) => a[1] - b[1]);
  const shown = entries.slice(0, 3).map(([rid, ln]) => `${rid}（L${ln}）`).join('、');
  return entries.length > 3 ? `${shown} 等 ${entries.length} 个` : shown;
}

function main() {
  const opts = parseCli(process.argv.slice(2));
  if (opts.error) {
    process.stderr.write(`plan-lint: ${opts.error}\n`);
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  const planPath = opts.plan;
  if (!fs.existsSync(planPath) || !fs.statSync(planPath).isFile()) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ ok: true, skipped: true, plan: toPosix(planPath), failures: [], warnings: [] }) + '\n');
    } else {
      process.stdout.write(`plan-lint: 无 DEV-PLAN，跳过 (${toPosix(planPath)})\n`);
    }
    process.exit(0);
  }

  let specPath = opts.spec;
  if (!fs.existsSync(specPath) || !fs.statSync(specPath).isFile()) {
    if (!opts.json) {
      process.stdout.write(`plan-lint: 无 Product-Spec，跳过覆盖检查 (${toPosix(specPath)})\n`);
    }
    specPath = '';
  }

  const lines = splitLines(fs.readFileSync(planPath, 'utf8'));
  const fenced = fencedSet(lines);
  const failures = [];
  const warnings = [];
  const notes = [];

  const fail = (msg) => failures.push(msg);
  const warn = (msg) => {
    warnings.push(msg);
    if (!opts.json) process.stderr.write(`plan-lint: 警告（不改 rc）：${msg}\n`);
  };

  // 1) 禁未完成占位符（跳过代码围栏）
  for (const { label, re } of PLACEHOLDER_SPECS) {
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      if (!fenced.has(i) && re.test(lines[i])) hits.push(`L${i + 1}`);
    }
    if (hits.length > 0) {
      fail(`占位符命中: ${label}  (${hits.join(', ')})`);
    }
  }

  // 2 & 3) Phase 结构完整性与 Task 粒度（仅扫围栏外的 ## Phase 标题，切片至下一个顶层 ## 标题）
  const phaseStarts = [];
  for (let i = 0; i < lines.length; i++) {
    if (!fenced.has(i) && PHASE_HEADING_RE.test(lines[i])) {
      phaseStarts.push(i);
    }
  }

  if (phaseStarts.length === 0) {
    fail('未找到任何 ## Phase 小节');
  }

  for (const startIdx of phaseStarts) {
    let endIdx = lines.length;
    for (let j = startIdx + 1; j < lines.length; j++) {
      if (!fenced.has(j) && H2_RE.test(lines[j])) {
        endIdx = j;
        break;
      }
    }
    const title = lines[startIdx].trim();
    const ln = startIdx + 1;
    const sectionNonFencedLines = [];
    let taskCount = 0;
    for (let k = startIdx; k < endIdx; k++) {
      if (fenced.has(k)) continue;
      sectionNonFencedLines.push(lines[k]);
      if (TASK_ITEM_RE.test(lines[k])) taskCount++;
    }
    const sectionText = sectionNonFencedLines.join('\n');
    for (const anchor of PHASE_ANCHORS) {
      if (!sectionText.includes(anchor)) {
        fail(`L${ln} ${title} 缺字段 ${anchor}`);
      }
    }
    if (taskCount === 0) {
      fail(`L${ln} ${title} 没有可执行的 Task 条目（需 - **Task N.M：...**）`);
    }
  }

  // 4) Product-Spec.md ↔ DEV-PLAN.md 双向覆盖核查
  if (specPath) {
    const specName = path.basename(specPath);
    const planName = path.basename(planPath);
    const specLines = splitLines(fs.readFileSync(specPath, 'utf8'));
    const { declared: specDeclared, mentioned: specMentioned } = scanIds(specLines, fencedSet(specLines));

    if (specDeclared.size === 0) {
      if (specMentioned.size > 0) {
        warn(`${specName} 里出现了 ${nameFew(specMentioned)}，但没有一条被识别成声明——检查是不是缩进超了一个空格，或者没写成列表项开头（声明须形如行首 - [REQ-CORE-001] ……）`);
      }
      const skipMsg = `Spec 未用 REQ 编号，跳过覆盖检查 (${toPosix(specPath)})——跳过 = 没查，不是查过了`;
      notes.push(skipMsg);
      if (!opts.json) process.stdout.write(`plan-lint: ${skipMsg}\n`);
    } else {
      const { mentioned: planMentioned } = scanIds(lines, fenced);

      // 覆盖只认 Task 条目行 + `## 已归档 Phase` 指针行箭头后的 `（REQ：…）` 后缀
      const taskIds = new Set();
      for (let i = 0; i < lines.length; i++) {
        if (!fenced.has(i) && TASK_ITEM_RE.test(lines[i])) {
          for (const id of findAllReqRefs(lines[i])) taskIds.add(id);
        }
      }

      let inArchived = false;
      for (let i = 0; i < lines.length; i++) {
        if (fenced.has(i)) continue;
        const line = lines[i];
        if (ARCHIVED_HEADING_RE.test(line)) {
          inArchived = true;
          continue;
        }
        if (inArchived && H2_RE.test(line)) {
          inArchived = false;
          continue;
        }
        if (inArchived && ARCHIVED_POINTER_RE.test(line)) {
          const parts = line.split(ARCHIVED_ARROW_RE);
          const tail = parts[parts.length - 1] || '';
          const suffix = ARCHIVED_SUFFIX_RE.exec(tail);
          if (suffix) {
            for (const id of findAllReqRefs(suffix[1])) taskIds.add(id);
          }
        }
      }

      // 4.5) 范围外（本次不计划）小节解析
      const oosItems = [];
      let inOos = false;
      for (let i = 0; i < lines.length; i++) {
        if (fenced.has(i)) continue;
        const line = lines[i];
        if (OOS_HEADING_RE.test(line)) {
          inOos = true;
          continue;
        }
        if (inOos && H2_RE.test(line)) {
          inOos = false;
          continue;
        }
        if (inOos) {
          const m = OOS_ITEM_RE.exec(line);
          if (m) {
            oosItems.push({ reqId: m[1], ln: i + 1, reason: m[2].trim() });
          }
        }
      }

      for (const { reqId, ln, reason } of oosItems) {
        if (!reason) {
          fail(`范围外声明缺原因: ${reqId}（${planName} L${ln}）`);
        }
      }

      const oosLinesById = new Map();
      for (const { reqId, ln } of oosItems) {
        if (!oosLinesById.has(reqId)) oosLinesById.set(reqId, []);
        oosLinesById.get(reqId).push(ln);
      }
      for (const [reqId, lns] of oosLinesById.entries()) {
        if (lns.length > 1) {
          const loc = lns.map((n) => `L${n}`).join('、');
          warn(`${reqId} 在「范围外」节重复声明 ${lns.length} 次（${loc}），仍以首条 L${lns[0]} 为准`);
        }
      }

      const oosDeclared = new Map();
      for (const { reqId, ln, reason } of oosItems) {
        if (!oosDeclared.has(reqId)) {
          oosDeclared.set(reqId, { ln, reason });
        }
      }

      for (const [reqId, ln] of specDeclared.entries()) {
        if (!taskIds.has(reqId) && !oosDeclared.has(reqId)) {
          fail(`需求没人做: ${reqId}（${specName} L${ln}）在 ${planName} 里没有任何 Task 引用`);
        }
      }

      for (const [reqId, { ln, reason }] of oosDeclared.entries()) {
        if (!specMentioned.has(reqId)) {
          fail(`范围外声明的编号不存在: ${reqId}（${planName} L${ln}，${specName} 中没有这个编号——检查是不是拼错了）`);
        } else if (taskIds.has(reqId)) {
          fail(`范围外声明与 Task 矛盾: ${reqId} 既被 Task 引用又在「范围外」节声明为不计划（${planName} L${ln}）`);
        } else {
          const msg = `范围外（已声明）：${reqId}——${reason}（${planName} L${ln}）`;
          notes.push(msg);
          if (!opts.json) process.stderr.write(`plan-lint: ${msg}\n`);
        }
      }

      const danglingIds = [...planMentioned.keys()]
        .filter((id) => !specMentioned.has(id) && !oosDeclared.has(id))
        .sort();
      for (const reqId of danglingIds) {
        const hits = [];
        const tokenRe = new RegExp(`\\b${reqId}\\b`);
        for (let i = 0; i < lines.length; i++) {
          if (!fenced.has(i) && tokenRe.test(lines[i])) hits.push(`L${i + 1}`);
        }
        fail(`悬空引用: ${reqId} 在 ${specName} 中不存在  (${hits.join(', ')})`);
      }

      const stray = new Map();
      for (const [rid, ln] of specMentioned.entries()) {
        if (!specDeclared.has(rid) && !planMentioned.has(rid)) {
          stray.set(rid, ln);
        }
      }
      if (stray.size > 0) {
        warn(`${specName} 里的 ${nameFew(stray)}写了编号但没被识别成声明，计划里也没人做——检查是不是缩进超了一个空格，或者没写成列表项开头（声明须形如行首 - [REQ-CORE-001] ……）`);
      }
    }
  }

  const ok = failures.length === 0;
  if (opts.json) {
    process.stdout.write(JSON.stringify({
      ok,
      plan: toPosix(planPath),
      spec: specPath ? toPosix(specPath) : null,
      failures,
      warnings,
      notes,
    }, null, 2) + '\n');
  } else if (!ok) {
    process.stderr.write('plan-lint: 失败\n');
    for (const item of failures) {
      process.stderr.write(`- ${item}\n`);
    }
  } else {
    process.stdout.write(`plan-lint: 通过 (${toPosix(planPath)})\n`);
  }
  process.exit(ok ? 0 : 1);
}

main();
