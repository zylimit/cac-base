// # risk: high
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..');
const PROGRESS_ARCHIVE = path.join(REPO_ROOT, '.cac', 'scripts', 'progress-archive.mjs');
const PLAN_ARCHIVE = path.join(REPO_ROOT, '.cac', 'scripts', 'plan-archive.mjs');
const PLAN_LINT = path.join(REPO_ROOT, '.cac', 'scripts', 'plan-lint.mjs');
const PROJECT_STATUS = path.join(REPO_ROOT, '.cac', 'scripts', 'project-status.mjs');

const TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'cac-living-docs-test-'));
let seq = 0;
function nextDir(label) {
  seq += 1;
  const dir = path.join(TMP_BASE, `${seq}-${label}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

after(() => {
  fs.rmSync(TMP_BASE, { recursive: true, force: true });
});

function runNode(script, args = [], opts = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: opts.cwd || REPO_ROOT,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

describe('living-docs contract (progress-archive / plan-archive / project-status)', () => {
  test('progress-archive P-1: mixed top-level & 4-space indented entries archived verbatim, and deeper unclosed child TODO never moved', () => {
    const dir = nextDir('p1-indent-and-todo');

    // Top-level new decisions immediately followed (NO blank line!) by 31 four-space indented legacy decisions
    const decisionLines = [
      '- 2026-11-26: 顶格新决策 A（最新在上）',
      '  依据：验证顶格压在四空格缩进块上时不吞并后续独立条目',
    ];
    for (let d = 31; d >= 1; d--) {
      const month = d > 28 ? '10' : '09';
      const day = pad2(d > 28 ? d - 28 : d);
      decisionLines.push(`    - 2026-${month}-${day}: 四空格老决策 #${d}`);
      decisionLines.push(`      依据：老决策 #${d} 的更深续行必须原样保留缩进`);
    }

    // 22 closed TODOs (#1..#22); #1 has a deeper-indented unclosed child TODO (#99) right underneath without blank line!
    const todoLines = [
      '- [P1][DONE][#1] 已关闭父任务一',
      '    - [P1][OPEN][#99] 挂在已关闭条目下的更深未关闭子 TODO（严禁被带走）',
    ];
    for (let id = 2; id <= 22; id++) {
      const prefix = id % 2 === 0 ? '    ' : '';
      const st = id % 3 === 0 ? '完成' : 'DONE';
      todoLines.push(`${prefix}- [P2][${st}][#${id}] 已关闭任务 ${id}`);
    }

    const progContent = [
      '# Project Progress',
      '_Last updated: 2026-11-01_',
      '',
      '## Decisions',
      ...decisionLines,
      '',
      '## TODO',
      ...todoLines,
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'progress.md'), progContent, 'utf8');

    const r = runNode(PROGRESS_ARCHIVE, ['--root', dir, '--json']);
    assert.equal(r.status, 0, r.stderr);
    const res = JSON.parse(r.stdout.trim());
    // 32 total decisions -> retain 24 -> move 8; 22 closed TODOs -> retain 10 -> move 12
    assert.equal(res.moved.decisions, 8);
    assert.equal(res.moved.todo, 12);

    const newProg = fs.readFileSync(path.join(dir, 'progress.md'), 'utf8');
    const arch = fs.readFileSync(path.join(dir, 'progress.archive.md'), 'utf8');

    // Unclosed child TODO #99 MUST still be in progress.md and MUST NOT appear in progress.archive.md
    assert.match(newProg, /\[#99\] 挂在已关闭条目下的更深未关闭子 TODO/);
    assert.doesNotMatch(arch, /\[#99\]/);

    // Closed #1 moved to archive; 4-space oldest decisions (#1..#8) moved to archive WITH exact 4-space & 6-space indentation!
    assert.match(arch, /^- \[P1\]\[DONE\]\[#1\] 已关闭父任务一$/m);
    assert.match(arch, /^    - 2026-09-01: 四空格老决策 #1$/m);
    assert.match(arch, /^      依据：老决策 #1 的更深续行必须原样保留缩进$/m);
    assert.match(newProg, /^- 2026-11-26: 顶格新决策 A/m);
  });

  test('progress-archive P-2: single section exceeding byte ceiling triggers archive while strictly honoring item count floor', () => {
    const dir = nextDir('p2-bytes-and-floor');
    const padDone = '甲'.repeat(600); // ~1800 UTF-8 bytes per entry; 14 entries ~ 25KB > 16384B ceiling, while count 14 << 100
    const padDec = '乙'.repeat(1300); // ~3900 UTF-8 bytes per entry; 15 entries ~ 58.5KB > 32768B ceiling, floor = 12

    const doneLines = [];
    for (let i = 1; i <= 14; i++) {
      doneLines.push(`- 2026-10-${pad2(i)}: 完成大体积交付 #${i} ${padDone}`);
    }
    const decLines = [];
    for (let i = 1; i <= 15; i++) {
      decLines.push(`- 2026-10-${pad2(i)}: 超重架构决策 #${i} ${padDec}`);
    }

    fs.writeFileSync(
      path.join(dir, 'progress.md'),
      ['# Progress', '', '## Done', ...doneLines, '', '## Decisions', ...decLines, ''].join('\n'),
      'utf8',
    );

    const r = runNode(PROGRESS_ARCHIVE, ['--root', dir, '--json']);
    assert.equal(r.status, 0, r.stderr);
    const res = JSON.parse(r.stdout.trim());

    // Done: shrinks below 16384B (10 entries = ~18KB > 16384,Wait: Done floor is 10! Let's check both ceiling and floor!)
    // Actually 10 * 1835B = ~18350B > 16384B -> Done hits its floor of 10 (moved 4)!
    // Let's also verify Notes with smaller entries (~1200B * 16 = ~19.2KB > 16384B, shrinking to <= 16384B above floor 10)!
    assert.equal(res.moved.done, 4, 'Done must stop at floor of 10 entries');
    assert.equal(res.moved.decisions, 3, 'Decisions (15 * ~3.9KB) must stop at floor of 12 entries');
    assert.equal(res.bytes.done.ceiling, 16384);
    assert.equal(res.bytes.decisions.ceiling, 32768);

    // Second sub-case: Notes with 18 entries * ~1050B (~18.9KB > 16384B) shrinks cleanly to <= 16384B (above floor 10)
    const dir2 = nextDir('p2-ceiling-shrink');
    const padNote = '丙'.repeat(340); // ~1050B per entry; 18 * 1050 = 18900 > 16384; 15 * 1050 = 15750 <= 16384 (> floor 10)
    const noteLines = [];
    for (let i = 1; i <= 18; i++) {
      noteLines.push(`- 2026-10-${pad2(i)}: 调研记录 #${i} ${padNote}`);
    }
    fs.writeFileSync(path.join(dir2, 'progress.md'), ['# Progress', '', '## Notes', ...noteLines, ''].join('\n'), 'utf8');
    const r2 = runNode(PROGRESS_ARCHIVE, ['--root', dir2, '--json']);
    assert.equal(r2.status, 0, r2.stderr);
    const res2 = JSON.parse(r2.stdout.trim());
    assert.ok(res2.moved.notes > 0 && 18 - res2.moved.notes > 10);
    assert.ok(res2.bytes.notes.before > 16384);
    assert.ok(res2.bytes.notes.after <= 16384);
  });

  test('progress-archive P-3 & P-4 & same-day rejection: out-of-order dates move earliest dates, handwritten pointer untouched, same-day rejected with zero edits', () => {
    const dir = nextDir('p3-p4');
    const handWrittenPtr = '（归档指针：2026-11-04 手工搬 10 条到 progress.archive.md「Archived Decisions」；其中仍在生效的四条：R1/R2/R3/R4，原文见归档）';

    // 32 Decisions: first is 2026-10-01, last is 2026-11-28 (oldest on top),
    // BUT position 2 & 3 hold 2026-11-26 and 2026-11-27 out of order!
    const decLines = [
      '- 2026-10-01: 最早决策 D01',
      '- 2026-11-26: 乱序夹在前面的新决策 NEW-A（严禁被按位置误搬）',
      '- 2026-11-27: 乱序夹在前面的新决策 NEW-B（严禁被按位置误搬）',
    ];
    // Add D02..D29 with dates 2026-10-02 .. 2026-10-29, ending with 2026-11-28 (total 3 + 28 + 1 = 32 entries -> move 8 oldest)
    for (let d = 2; d <= 29; d++) {
      decLines.push(`- 2026-10-${pad2(d)}: 决策条目 D${pad2(d)}`);
    }
    decLines.push('- 2026-11-28: 末尾最新决策 D32');

    fs.writeFileSync(
      path.join(dir, 'progress.md'),
      ['# Progress', '', '## Decisions', handWrittenPtr, ...decLines, ''].join('\n'),
      'utf8',
    );

    const r = runNode(PROGRESS_ARCHIVE, ['--root', dir]);
    assert.equal(r.status, 0, r.stderr);

    const newProg = fs.readFileSync(path.join(dir, 'progress.md'), 'utf8');
    const arch = fs.readFileSync(path.join(dir, 'progress.archive.md'), 'utf8');

    // P-3: 8 earliest dates are 10-01 through 10-08 -> archived; NEW-A (11-26) & NEW-B (11-27) MUST stay in progress.md!
    for (let d = 1; d <= 8; d++) {
      const tag = d === 1 ? '最早决策 D01' : `决策条目 D${pad2(d)}`;
      assert.equal(arch.includes(tag), true, `expected ${tag} in archive`);
      assert.equal(newProg.includes(tag), false, `expected ${tag} removed from progress.md`);
    }
    assert.equal(newProg.includes('NEW-A'), true, 'out-of-order newer entry NEW-A must stay in progress.md');
    assert.equal(newProg.includes('NEW-B'), true, 'out-of-order newer entry NEW-B must stay in progress.md');

    // P-4: handwritten pointer preserved character-for-character, plus a separate machine pointer with 累计搬出 8 条
    assert.equal(newProg.includes(handWrittenPtr), true, 'handwritten pointer must remain verbatim');
    assert.match(newProg, /^（归档指针：累计搬出 8 条，最近一次 \d{4}-\d{2}-\d{2} 搬 8 条；原文见 progress\.archive\.md「Archived Decisions」）$/m);

    // Same-day first & last rejection: exit code 1 and zero bytes modified
    const sameDayDir = nextDir('same-day-reject');
    const sameDayLines = [];
    for (let i = 1; i <= 31; i++) {
      sameDayLines.push(`- 2026-11-20: 同日决策 #${i}`);
    }
    const origSameDay = ['# Progress', '', '## Decisions', ...sameDayLines, ''].join('\n');
    const sameDayPath = path.join(sameDayDir, 'progress.md');
    fs.writeFileSync(sameDayPath, origSameDay, 'utf8');

    const rSame = runNode(PROGRESS_ARCHIVE, ['--root', sameDayDir]);
    assert.equal(rSame.status, 1, 'same-day first & last must exit with code 1');
    assert.match(rSame.stderr, /首条与末条同日/);
    assert.equal(fs.readFileSync(sameDayPath, 'utf8'), origSameDay, 'progress.md must be untouched on same-day failure');
    assert.equal(fs.existsSync(path.join(sameDayDir, 'progress.archive.md')), false);
  });

  test('plan-archive: >20 completed Phases & >64KB ceiling, Task-only REQ pointer suffix (heading OOS REQ excluded!), plan-lint rc 0 after archive, and FAIL_AT rollback', () => {
    const dir = nextDir('plan-archive-and-lint');

    // Spec declares REQ-ORD-001 .. REQ-ORD-023 plus REQ-ORD-099 (out-of-scope in DEV-PLAN)
    const specReqs = [];
    for (let i = 1; i <= 23; i++) {
      specReqs.push(`- [REQ-ORD-${ String(i).padStart(3, '0') }] [确认] 订单功能第 ${i} 项`);
    }
    specReqs.push('- [REQ-ORD-099] [确认] 跨国多币种清算（二期规划）');
    fs.writeFileSync(
      path.join(dir, 'Product-Spec.md'),
      ['# Product Spec', '', '## 功能需求', ...specReqs, ''].join('\n'),
      'utf8',
    );

    function makePhaseSection(n, done, extraTitleNote = '', padBytes = 0) {
      const reqId = `REQ-ORD-${String(n).padStart(3, '0')}`;
      const mark = done ? ' ✅' : '';
      const filler = padBytes > 0 ? `\n补充设计说明：${'文'.repeat(Math.ceil(padBytes / 3))}\n` : '';
      return [
        `## Phase ${n}: 订单子阶段 ${n}${mark}${extraTitleNote}`,
        '- **交付内容**：完成对应需求闭环',
        '- **验证的假设**：接口契约稳定' + filler,
        '- **关键文件**：`src/order.mjs`',
        '- **Task 清单**：',
        `  - **Task ${n}.1：实现核心逻辑（${reqId}）**`,
        '- **验收标准**：单测全绿（注：范围外 REQ-ORD-099 本期不做）',
        '',
      ].join('\n');
    }

    // Put Phase 22 BEFORE Phase 1 to verify archive sorts by Phase number (moves 1 & 2, NOT 22!)
    // Also put "本期不做 REQ-ORD-099" right inside Phase 1's heading!
    const phaseBlocks = [
      makePhaseSection(22, true),
      makePhaseSection(1, true, '（本期不做 REQ-ORD-099）'),
      makePhaseSection(2, true),
    ];
    for (let n = 3; n <= 21; n++) {
      phaseBlocks.push(makePhaseSection(n, true));
    }
    phaseBlocks.push(makePhaseSection(23, false)); // active uncompleted Phase

    const planText = [
      '# DEV-PLAN',
      '',
      ...phaseBlocks,
      '## 范围外（本次不计划）',
      '- REQ-ORD-099：二期再做跨国清算',
      '',
    ].join('\n');
    const planPath = path.join(dir, 'DEV-PLAN.md');
    fs.writeFileSync(planPath, planText, 'utf8');

    // Pre-archive plan-lint passes (rc 0)
    const lintBefore = runNode(PLAN_LINT, [planPath, path.join(dir, 'Product-Spec.md')]);
    assert.equal(lintBefore.status, 0, `plan-lint before archive failed: ${lintBefore.stderr}`);

    // Fault injections PLAN_ARCHIVE_FAIL_AT=archive-write and verify MUST exit 1 and leave DEV-PLAN.md untouched
    for (const failStage of ['archive-write', 'verify']) {
      const rFail = runNode(PLAN_ARCHIVE, ['--root', dir], {
        env: { PLAN_ARCHIVE_FAIL_AT: failStage },
      });
      assert.equal(rFail.status, 1, `PLAN_ARCHIVE_FAIL_AT=${failStage} must exit 1`);
      assert.equal(fs.readFileSync(planPath, 'utf8'), planText, `DEV-PLAN.md must be untouched when FAIL_AT=${failStage}`);
      fs.rmSync(path.join(dir, 'DEV-PLAN.archive.md'), { force: true });
    }

    // Real plan-archive run: 22 completed Phases -> moves Phase 1 & Phase 2 (smallest numbers), keeps Phase 3..22 + Phase 23
    const rArch = runNode(PLAN_ARCHIVE, ['--root', dir, '--json']);
    assert.equal(rArch.status, 0, rArch.stderr);
    const archRes = JSON.parse(rArch.stdout.trim());
    assert.equal(archRes.moved, 2);

    const afterPlan = fs.readFileSync(planPath, 'utf8');
    const archFile = fs.readFileSync(path.join(dir, 'DEV-PLAN.archive.md'), 'utf8');

    assert.match(archFile, /^## Phase 1: 订单子阶段 1 ✅（本期不做 REQ-ORD-099）$/m);
    assert.match(archFile, /^## Phase 2: 订单子阶段 2 ✅$/m);
    assert.doesNotMatch(afterPlan, /^## Phase 1:/m);
    assert.match(afterPlan, /^## Phase 22:/m);

    // Red-lock: pointer suffix for Phase 1 ONLY contains Task-line REQ-ORD-001, NOT heading's REQ-ORD-099!
    assert.match(
      afterPlan,
      /^- Phase 1: 订单子阶段 1 ✅（本期不做 REQ-ORD-099） → DEV-PLAN\.archive\.md（REQ：REQ-ORD-001）$/m,
    );

    // Post-archive plan-lint MUST STILL exit 0!
    const lintAfter = runNode(PLAN_LINT, [planPath, path.join(dir, 'Product-Spec.md')]);
    assert.equal(lintAfter.status, 0, `plan-lint after archive failed: ${lintAfter.stderr}`);

    // Byte ceiling (>64KB) with <=20 completed Phases & floor of 3 completed Phases
    const volDir = nextDir('plan-archive-volume');
    const bigPhases = [1, 2, 3, 4, 5].map((n) => makePhaseSection(n, true, '', 25000)); // 5 * ~25KB = ~125KB > 65536B
    fs.writeFileSync(path.join(volDir, 'DEV-PLAN.md'), ['# DEV-PLAN', '', ...bigPhases].join('\n'), 'utf8');
    const rVol = runNode(PLAN_ARCHIVE, ['--root', volDir, '--json']);
    assert.equal(rVol.status, 0, rVol.stderr);
    const volRes = JSON.parse(rVol.stdout.trim());
    // 3 * ~25KB (~75KB) > 65536B, so it moves 2 and stops at FLOOR_COMPLETED = 3!
    assert.equal(volRes.moved, 2, 'volume ceiling must move smallest completed Phases and stop at floor of 3');
  });

  test('project-status: human lines, --table REQ matrix, --json fields, and same-day archive error surfacing', () => {
    const dir = nextDir('project-status-full');

    fs.writeFileSync(
      path.join(dir, 'Product-Spec.md'),
      [
        '# Product Spec',
        '',
        '## 功能需求',
        '- [REQ-APP-001] [确认] 登录鉴权已归档完成',
        '- [REQ-APP-002] [推断] 报表导出（修订：原定 CSV 改为 XLSX）',
        '- [REQ-APP-003] [默认] 审计日志留存 90 天',
        '- [REQ-APP-004] 告警推送未标来源且未排期',
        '- [REQ-APP-005] [确认] 二期多租户隔离',
        '',
        '## 待定问题',
        '| 问题 | 影响 | 负责人 | 截止 | 默认策略 |',
        '|---|---|---|---|---|',
        '| XLSX 单次上限多少行 | 导出内存 | 产品经理 | Phase 3 前 | 先限 5 万行 |',
        '',
      ].join('\n'),
      'utf8',
    );

    fs.writeFileSync(
      path.join(dir, 'DEV-PLAN.md'),
      [
        '# DEV-PLAN',
        '',
        '## 已归档 Phase',
        '- Phase 1: 登录基础 ✅（回放，推迟 REQ-APP-004） → DEV-PLAN.archive.md（REQ：REQ-APP-001）',
        '',
        '## Phase 2: 报表前半 ✅',
        '- **Task 清单**：',
        '  - **Task 2.1：导出后端（REQ-APP-002）**',
        '',
        '## Phase 3: 报表收尾与审计',
        '- **Task 清单**：',
        '  - **Task 3.1：导出前端（REQ-APP-002）**',
        '  - **Task 3.2：审计留存（REQ-APP-003）**',
        '',
        '## 范围外（本次不计划）',
        '- REQ-APP-005：二期实施',
        '',
      ].join('\n'),
      'utf8',
    );

    // Same-day over-threshold progress.md (>30 Decisions all on 2026-11-20) to trigger archive error surfacing
    const sameDayDecs = Array.from({ length: 31 }, (_, i) => `- 2026-11-20: 同日决策记录 #${i + 1}`);
    fs.writeFileSync(
      path.join(dir, 'progress.md'),
      ['# Progress', '', '## Pinned', '- 硬约束 1', '', '## Decisions', ...sameDayDecs, ''].join('\n'),
      'utf8',
    );

    // 1. Human mode + --table
    const rHuman = runNode(PROJECT_STATUS, ['--root', dir, '--table']);
    assert.equal(rHuman.status, 0, rHuman.stderr);
    const outLines = rHuman.stdout.trim().split(/\r?\n/);

    assert.match(outLines[0], /^现在到哪：需求 5 条（含推断 1、默认 1） · 待定 1 项 · Phase 2\/3 完成，当前 Phase 3：报表收尾与审计 · 1 个带回放待重验$/);
    assert.match(outLines[1], /^活文档：Spec \d+\.\dKB（带修订史 1 条，最长一条 \d+ 字） · DEV-PLAN \d+\.\dKB · progress \d+\.\dKB（待归档未知：.*首条与末条同日.*）$/);

    // REQ table verification (including REQ-APP-004 in archived pointer title NOT counted as archived!)
    assert.ok(rHuman.stdout.includes('| 需求 | 标记 | 阶段 | 状态 |'));
    assert.ok(rHuman.stdout.includes('| REQ-APP-001 | 确认 | Phase 1（已归档） | 完成 |'));
    assert.ok(rHuman.stdout.includes('| REQ-APP-002 | 推断 | Phase 2、Phase 3 | 进行中 |'));
    assert.ok(rHuman.stdout.includes('| REQ-APP-003 | 默认 | Phase 3 | 未开始 |'));
    assert.ok(rHuman.stdout.includes('| REQ-APP-004 | 未标 | 未排 | — |'));
    assert.ok(rHuman.stdout.includes('| REQ-APP-005 | 确认 | 范围外 | — |'));

    // 2. --json completeness (with normal archivable progress.md)
    const normalDecs = Array.from({ length: 32 }, (_, i) => `- 2026-10-${pad2((i % 28) + 1)}: 跨月决策 #${i + 1}`).concat([
      '- 2026-11-25: 最新决策收尾',
    ]);
    fs.writeFileSync(
      path.join(dir, 'progress.md'),
      ['# Progress', '', '## Pinned', '- 硬约束 1', '', '## Decisions', ...normalDecs, ''].join('\n'),
      'utf8',
    );

    const rJson = runNode(PROJECT_STATUS, ['--root', dir, '--json']);
    assert.equal(rJson.status, 0, rJson.stderr);
    const j = JSON.parse(rJson.stdout.trim());
    assert.equal(j.command, 'project-status');
    assert.equal(j.spec.exists, true);
    assert.equal(j.spec.entries, 5);
    assert.equal(j.spec.inferred, 1);
    assert.equal(j.spec.defaulted, 1);
    assert.equal(j.spec.pending, 1);
    assert.equal(j.spec.withHistory, 1);
    assert.equal(j.plan.exists, true);
    assert.equal(j.plan.total, 3);
    assert.equal(j.plan.done, 2);
    assert.deepEqual(j.plan.current, { n: 3, title: '报表收尾与审计' });
    assert.equal(j.plan.replay, 1);
    assert.equal(j.progress.exists, true);
    assert.equal(j.progress.archiveDue, 9); // 33 decisions -> keep 24 -> 9 due
    assert.equal(j.progress.pinned.count, 1);
    assert.equal(j.reqs.length, 5);
  });
});
