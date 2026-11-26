// # risk: medium
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..');
const PREDEV_LINT = path.join(REPO_ROOT, '.cac', 'scripts', 'predev-lint.mjs');
const PLAN_LINT = path.join(REPO_ROOT, '.cac', 'scripts', 'plan-lint.mjs');
const DESIGN_TRACE = path.join(REPO_ROOT, '.cac', 'scripts', 'design-trace.mjs');
const UI_SLOP_SCAN = path.join(REPO_ROOT, '.cac', 'scripts', 'ui-slop-scan.mjs');
const SUPERVISOR = path.join(REPO_ROOT, '.cac', 'scripts', 'supervisor.mjs');

const TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'cac-predev-design-test-'));
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

describe('predev-lint / plan-lint / design-trace / ui-slop-scan / supervisor', () => {
  test('predev-lint.mjs: skips empty dir (rc 0), passes compliant 5-doc suite (rc 0), and blocks missing sections & placeholders (rc 1)', () => {
    const emptyDir = nextDir('predev-empty');
    assert.equal(runNode(PREDEV_LINT, ['--root', emptyDir]).status, 0);

    // Compliant 5-doc project
    const goodDir = nextDir('predev-good');
    fs.writeFileSync(
      path.join(goodDir, 'Product-Spec.md'),
      [
        '# 产品规格',
        '## 产品概述',
        '面向仓储盘点的离线扫码工具。',
        '## 应用场景',
        '冷链仓库无信号环境下盘点。',
        '## 成功判据',
        '| 指标 | 目标 |',
        '|---|---|',
        '| 单件扫码耗时 | <= 200ms |',
        '## 范围与非目标',
        '- SCOPE-1：支持离线缓存同步。',
        '## 功能需求',
        '- [REQ-INV-001] [确认] 扫码录入批次号与数量',
        '## 规则与例外',
        '重码时提示合并确认。',
        '## 关键流程',
        'FLOW-1：扫码 -> 本地落库 -> 联网回传。',
        '## 决策依据',
        '盘点员戴手套单手操作。',
        '## 技术方向',
        'SQLite 本地持久化。',
        '## 待定问题',
        '| 问题 | 影响什么 | 谁能答 | 押后到 | 不答先按什么做 |',
        '|---|---|---|---|---|',
        '| 条码前缀长度 | 校验正则 | 仓管主管 | Phase 2 前 | 默认允许 8-20 位 |',
        '## 澄清记录',
        '- 2026-11-26：确认只做一维码与二维码。',
        '',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(goodDir, 'Design-Brief.md'),
      [
        '# 界面设计简报',
        '## 信息架构',
        '- SCREEN-1：盘点扫码主页（对应 FLOW-1、SCOPE-1）',
        '### SCREEN-1 盘点扫码主页',
        '- **必需状态**：空态 / 扫码成功 / 离线待同步 / 报错重试',
        '- **响应式**：360px 手持终端至 1024px 平板横屏',
        '',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(goodDir, 'DESIGN.md'),
      [
        '---',
        'colors:',
        '  primary: "#0f766e"',
        '  surface: "#f8fafc"',
        '---',
        '## Overview',
        '高对比工业手持风格，主色使用 {colors.primary}，底色使用 {colors.surface}。',
        '## Colors',
        '深青主色配浅灰底面。',
        '## Typography',
        '正文 16px，行高 1.5。',
        '## Layout',
        '单列大触控区。',
        '## Elevation',
        '低阴影边界分隔。',
        '## Shapes',
        '4px 圆角。',
        '## Components',
        '全宽确认按钮。',
        "## Do's and Don'ts",
        '禁止小于 44px 的点击区域。',
        '',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(goodDir, 'Architecture-Design.md'),
      [
        '# 架构设计',
        '## 架构概览',
        '本地优先单向同步架构。',
        '## 模块划分',
        'scanner / storage / sync 三模块。',
        '## 依赖规则',
        'scanner 不直接依赖 sync。',
        '## 运行与部署包络',
        '离线手持端独立运行。',
        '## 关键决策记录',
        '### ADR-001 离线幂等同步队列',
        '- **背景**：弱网重连会产生重复提交。',
        '- **决策**：按批次幂等键去重。',
        '- **被拒备选**：服务端锁表同步，吞吐太低。',
        '- **执法方式**：集成测试回放断网重发。',
        '',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(goodDir, 'DFX-Spec.md'),
      [
        '# DFX 规格',
        '## 优先级栈',
        '1. 数据零丢失（可靠性）',
        '2. 扫码即时反馈（性能）',
        '## 维度总表',
        '| 维度 | 目标度量 |',
        '|---|---|',
        '| 可靠性 | 断电丢单 0 条 |',
        '| 性能 | P99 <= 200ms |',
        '## 延迟预算',
        '| 层级 | 预算 | 重试 | 失败时 fallback |',
        '|---|---|---|---|',
        '| 解码层 | 80ms | 0 | 提示重扫 |',
        '| 本地写库 | 40ms | 1 次 | 写备用日志 |',
        '| 端到端 | 200ms | 0 | 本地排队 |',
        '',
      ].join('\n'),
      'utf8',
    );

    const rGood = runNode(PREDEV_LINT, ['--root', goodDir, '--json']);
    assert.equal(rGood.status, 0, rGood.stdout + rGood.stderr);
    const goodJson = JSON.parse(rGood.stdout);
    assert.equal(goodJson.ok, true);
    assert.equal(goodJson.errors, 0);
    assert.equal(goodJson.checked.length, 5);

    // Non-compliant predev docs: missing sections, placeholders, unresolved tokens, multi-layer retry & budget overflow
    const badDir = nextDir('predev-bad');
    fs.writeFileSync(
      path.join(badDir, 'Product-Spec.md'),
      [
        '# 残缺规格',
        '## 产品概述',
        '这里留了模板槽 {{project_name}} 和 <未填占位> 以及待补说明。',
        '## 功能需求',
        '- [REQ-X-001] 没有来源标记的条目',
        '- [REQ-X-002] [确认] [待定] 混入待定标记',
        '',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(badDir, 'DESIGN.md'),
      [
        '---',
        'colors:',
        '  primary: "#0f766e"',
        '---',
        '## Colors',
        '引用了不存在的 {colors.nonexistent}。',
        '## Overview',
        '顺序反了。',
        '',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(badDir, 'DFX-Spec.md'),
      [
        '# DFX',
        '## 优先级栈',
        '1. 只有一项不成栈',
        '## 维度总表',
        '| 维度 | 度量 |',
        '|---|---|',
        '| 可用性 | 尽量稳定无数字 |',
        '## 预算表',
        '| 层 | 预算 | 重试 | fallback |',
        '|---|---|---|---|',
        '| 网关 | 150ms | 2 次 | 降级 |',
        '| 下游 | 150ms | 3 次 | 报错 |',
        '| 端到端 | 200ms | 0 | 超时提示 |',
        '',
      ].join('\n'),
      'utf8',
    );

    const rBad = runNode(PREDEV_LINT, ['--root', badDir, '--json']);
    assert.equal(rBad.status, 1);
    const badJson = JSON.parse(rBad.stdout);
    assert.equal(badJson.ok, false);
    const errCodes = new Set(badJson.findings.filter((f) => f.severity === 'error').map((f) => f.code));
    for (const expected of [
      'MISSING_SECTION',
      'PLACEHOLDER',
      'NO_SOURCE_MARK',
      'PENDING_IN_REQUIREMENT',
      'MISSING_TOKEN',
      'UNRESOLVED_TOKEN',
      'SECTION_ORDER',
      'PRIORITY_STACK_TOO_SHORT',
      'UNMEASURED',
      'BUDGET_OVER_END_TO_END',
      'RETRY_LAYERS_OVER_ONE',
    ]) {
      assert.equal(errCodes.has(expected), true, `expected error code ${expected}, got: ${[...errCodes].join(', ')}`);
    }
  });

  test('plan-lint.mjs: skips absent DEV-PLAN (rc 0), passes compliant plan (rc 0), and catches placeholders, missing fields & REQ mismatches (rc 1)', () => {
    const emptyDir = nextDir('plan-empty');
    assert.equal(runNode(PLAN_LINT, [path.join(emptyDir, 'DEV-PLAN.md')]).status, 0);

    const dir = nextDir('plan-check');
    const specFile = path.join(dir, 'Product-Spec.md');
    const planFile = path.join(dir, 'DEV-PLAN.md');

    fs.writeFileSync(
      specFile,
      [
        '# Spec',
        '## 功能需求',
        '- [REQ-PAY-001] [确认] 支付下单',
        '- [REQ-PAY-002] [确认] 支付回调验签',
        '- [REQ-PAY-003] [确认] 跨境结算',
        '',
      ].join('\n'),
      'utf8',
    );

    // Compliant plan
    fs.writeFileSync(
      planFile,
      [
        '# DEV-PLAN',
        '## 已归档 Phase',
        '- Phase 1: 下单基础 ✅ → DEV-PLAN.archive.md（REQ：REQ-PAY-001）',
        '## Phase 2: 回调验签',
        '- **交付内容**：验签中间件',
        '- **验证的假设**：公钥轮换平滑',
        '- **关键文件**：`src/verify.mjs`',
        '- **Task 清单**：',
        '  - **Task 2.1：实现验签（REQ-PAY-002）**',
        '- **验收标准**：验签测试全绿',
        '## 范围外（本次不计划）',
        '- REQ-PAY-003：二期支持跨境结算',
        '',
      ].join('\n'),
      'utf8',
    );
    assert.equal(runNode(PLAN_LINT, [planFile, specFile, '--json']).status, 0);

    // Broken plan: placeholder TBD, missing **验证的假设**, REQ-PAY-002 uncovered, dangling REQ-PAY-999, OOS conflict on REQ-PAY-001
    fs.writeFileSync(
      planFile,
      [
        '# DEV-PLAN',
        '## Phase 1: 残缺阶段',
        '- **交付内容**：TBD 待补充',
        '- **关键文件**：`src/pay.mjs`',
        '- **Task 清单**：',
        '  - **Task 1.1：实现下单（REQ-PAY-001, REQ-PAY-999）**',
        '- **验收标准**：单测通过',
        '## 范围外（本次不计划）',
        '- REQ-PAY-001：既在 Task 又写范围外',
        '- REQ-PAY-003：',
        '',
      ].join('\n'),
      'utf8',
    );
    const rBad = runNode(PLAN_LINT, [planFile, specFile, '--json']);
    assert.equal(rBad.status, 1);
    const badJson = JSON.parse(rBad.stdout);
    assert.equal(badJson.ok, false);
    const joined = badJson.failures.join('\n');
    assert.match(joined, /占位符命中/);
    assert.match(joined, /缺字段 \*\*验证的假设\*\*/);
    assert.match(joined, /需求没人做: REQ-PAY-002/);
    assert.match(joined, /悬空引用: REQ-PAY-999/);
    assert.match(joined, /范围外声明与 Task 矛盾: REQ-PAY-001/);
    assert.match(joined, /范围外声明缺原因: REQ-PAY-003/);
  });

  test('design-trace.mjs: passes aligned rules/tests/constants (rc 0) and detects all 4 gap categories (no-test, no-rule, const-mismatch, structure)', () => {
    const emptyDir = nextDir('trace-empty');
    assert.equal(runNode(DESIGN_TRACE, ['--root', emptyDir]).status, 0);

    // Compliant project
    const goodDir = nextDir('trace-good');
    fs.mkdirSync(path.join(goodDir, 'docs', 'design'), { recursive: true });
    fs.mkdirSync(path.join(goodDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(goodDir, 'tests'), { recursive: true });

    fs.writeFileSync(
      path.join(goodDir, 'docs', 'design', 'quota.md'),
      [
        '# 配额计费详述',
        '> 代码范围：`src/**`',
        '',
        '## 业务规则',
        '#### QUOTA-01 免费额度上限',
        '每个免费账户每日上限 500 次请求。',
        '',
        '## 常量表',
        '| 常量名 | 值 | 代码位置 | 说明 |',
        '|---|---|---|---|',
        '| FREE_DAILY_LIMIT | 500 | src/quota.mjs | 免费日限额 |',
        '',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(path.join(goodDir, 'src', 'quota.mjs'), 'export const FREE_DAILY_LIMIT = 500;\n', 'utf8');
    fs.writeFileSync(
      path.join(goodDir, 'tests', 'quota.test.mjs'),
      '// rule: QUOTA-01\nexport const tested = true;\n',
      'utf8',
    );

    const rGood = runNode(DESIGN_TRACE, ['--root', goodDir, '--json']);
    assert.equal(rGood.status, 0, rGood.stdout + rGood.stderr);
    assert.equal(JSON.parse(rGood.stdout).summary.total, 0);

    // Introduce all 4 gap types simultaneously:
    // 1) no-test: QUOTA-02 added without test tag
    // 2) no-rule: test tags QUOTA-OLD-01 (superseded) and QUOTA-999 (non-existent)
    // 3) const-mismatch: FREE_DAILY_LIMIT is 500 in doc vs 800 in src/quota.mjs
    // 4) structure: malformed rule heading under 业务规则 + unmatched glob `missing_dir/**`
    fs.writeFileSync(
      path.join(goodDir, 'docs', 'design', 'quota.md'),
      [
        '# 配额计费详述',
        '> 代码范围：`src/**`, `missing_dir/**`',
        '',
        '## 业务规则',
        '#### QUOTA-01 免费额度上限',
        '每日上限 500 次。',
        '#### QUOTA-02 超额阶梯冻结',
        '超额后冻结 15 分钟。',
        '#### 没有写编号的违规小标题',
        '缺少规则 ID。',
        '',
        '## 取代记录',
        '#### QUOTA-OLD-01 被 QUOTA-01 取代',
        '旧版日限额规则。',
        '',
        '## 常量表',
        '| 常量名 | 值 | 代码位置 | 说明 |',
        '|---|---|---|---|',
        '| FREE_DAILY_LIMIT | 500 | src/quota.mjs | 免费日限额 |',
        '',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(path.join(goodDir, 'src', 'quota.mjs'), 'export const FREE_DAILY_LIMIT = 800;\n', 'utf8');
    fs.writeFileSync(
      path.join(goodDir, 'tests', 'quota.test.mjs'),
      '// rule: QUOTA-01, QUOTA-OLD-01, QUOTA-999\nexport const tested = true;\n',
      'utf8',
    );

    const rBad = runNode(DESIGN_TRACE, ['--root', goodDir, '--json']);
    assert.equal(rBad.status, 1);
    const badJson = JSON.parse(rBad.stdout);
    assert.ok(badJson.summary.noTest >= 1, 'expected no-test gap');
    assert.ok(badJson.summary.noRule >= 2, 'expected no-rule gaps (superseded + non-existent)');
    assert.ok(badJson.summary.constMismatch >= 1, 'expected const-mismatch gap');
    assert.ok(badJson.summary.structure >= 2, 'expected structure gaps (bad heading + 0-match glob)');
  });

  test('ui-slop-scan.mjs: skips non-UI dir, passes clean CSS, blocks purple primary / tiny body text / bad line-height, and honors unslop-ignore', () => {
    const noUiDir = nextDir('slop-no-ui');
    fs.writeFileSync(path.join(noUiDir, 'logic.js'), 'export const sum = (a, b) => a + b;\n', 'utf8');
    assert.equal(runNode(UI_SLOP_SCAN, ['--paths', noUiDir]).status, 0);

    // Clean UI stylesheet
    const cleanDir = nextDir('slop-clean');
    fs.writeFileSync(
      path.join(cleanDir, 'app.css'),
      [
        ':root { --primary: #0f766e; --surface: #f8fafc; }',
        'body { font-size: 16px; line-height: 1.5; border-radius: 6px; }',
        '',
      ].join('\n'),
      'utf8',
    );
    const rClean = runNode(UI_SLOP_SCAN, ['--paths', cleanDir, '--json']);
    assert.equal(rClean.status, 0, rClean.stdout);
    assert.equal(JSON.parse(rClean.stdout).ok, true);

    // Slop UI stylesheet -> rc 1
    const dirtyDir = nextDir('slop-dirty');
    fs.writeFileSync(
      path.join(dirtyDir, 'slop.css'),
      [
        ':root { --primary-color: #6366f1; }',
        'body { font-size: 12px; line-height: 1.2; border-radius: 16px; }',
        '',
      ].join('\n'),
      'utf8',
    );
    const rDirty = runNode(UI_SLOP_SCAN, ['--paths', dirtyDir, '--json']);
    assert.equal(rDirty.status, 1);
    const dirtyJson = JSON.parse(rDirty.stdout);
    const codes = new Set(dirtyJson.findings.map((f) => f.code));
    assert.equal(codes.has('PURPLE_PRIMARY'), true);
    assert.equal(codes.has('SMALL_BODY_TEXT'), true);
    assert.equal(codes.has('LINE_HEIGHT'), true);
    assert.equal(codes.has('BIG_RADIUS'), true);

    // Intentional override with unslop-ignore -> rc 0 and exempt > 0
    const exemptDir = nextDir('slop-exempt');
    fs.writeFileSync(
      path.join(exemptDir, 'exempt.css'),
      [
        '/* unslop-ignore */',
        ':root { --primary-color: #6366f1; }',
        'body { font-size: 16px; line-height: 1.5; }',
        '',
      ].join('\n'),
      'utf8',
    );
    const rExempt = runNode(UI_SLOP_SCAN, ['--paths', exemptDir, '--json']);
    assert.equal(rExempt.status, 0, rExempt.stdout);
    assert.ok(JSON.parse(rExempt.stdout).exempt >= 1);
  });

  test('supervisor.mjs: start, duplicate-start guard, status, logs, and graceful stop lifecycle', () => {
    const supRoot = nextDir('supervisor-proj');
    const workerScript = path.join(supRoot, 'worker.mjs');
    fs.writeFileSync(
      workerScript,
      [
        'console.log("worker-ready-banner");',
        'setInterval(() => {}, 1000);',
        '',
      ].join('\n'),
      'utf8',
    );

    const env = { CAC_PROJECT_DIR: supRoot, CODEAGENT3_PROJECT_DIR: supRoot };

    try {
      // 1. Initial status is empty
      const rInit = runNode(SUPERVISOR, ['status'], { cwd: supRoot, env });
      assert.equal(rInit.status, 0, rInit.stderr);
      assert.deepEqual(JSON.parse(rInit.stdout.trim()), { ok: true, services: [] });

      // 2. Start background worker under supervisor
      const rStart = runNode(SUPERVISOR, ['start', '--id', 'demo-worker', '--', process.execPath, workerScript], {
        cwd: supRoot,
        env,
      });
      assert.equal(rStart.status, 0, `supervisor start failed: ${rStart.stderr}`);
      const startObj = JSON.parse(rStart.stdout.trim());
      assert.equal(startObj.ok, true);
      assert.equal(startObj.id, 'demo-worker');
      assert.ok(Number.isInteger(startObj.supervisorPid) && startObj.supervisorPid > 0);

      // 3. Duplicate start while running must be rejected with rc 1
      const rDup = runNode(SUPERVISOR, ['start', '--id', 'demo-worker', '--', process.execPath, workerScript], {
        cwd: supRoot,
        env,
      });
      assert.equal(rDup.status, 1, 'duplicate supervisor start must exit rc 1');

      // 4. Status shows running service
      const rStatus = runNode(SUPERVISOR, ['status', '--id', 'demo-worker'], { cwd: supRoot, env });
      assert.equal(rStatus.status, 0, rStatus.stderr);
      const stObj = JSON.parse(rStatus.stdout.trim());
      assert.equal(stObj.ok, true);
      assert.equal(stObj.services.length, 1);
      assert.equal(stObj.services[0].status, 'running');
      assert.equal(stObj.services[0].supervisorAlive, true);
      assert.equal(stObj.services[0].childAlive, true);

      // 5. Logs contain supervisor start record
      const rLogs = runNode(SUPERVISOR, ['logs', '--id', 'demo-worker', '--lines', '50'], { cwd: supRoot, env });
      assert.equal(rLogs.status, 0, rLogs.stderr);
      assert.match(rLogs.stdout, /started child pid=/);

      // 6. Stop cleanly converges both supervisor and child process
      const rStop = runNode(SUPERVISOR, ['stop', '--id', 'demo-worker'], { cwd: supRoot, env });
      assert.equal(rStop.status, 0, `supervisor stop failed: ${rStop.stderr}`);
      assert.deepEqual(JSON.parse(rStop.stdout.trim()), { ok: true, id: 'demo-worker', status: 'stopped' });

      const rAfter = runNode(SUPERVISOR, ['status', '--id', 'demo-worker'], { cwd: supRoot, env });
      assert.equal(rAfter.status, 0);
      const afterSvc = JSON.parse(rAfter.stdout.trim()).services[0];
      assert.equal(afterSvc.status, 'stopped');
      assert.equal(afterSvc.supervisorAlive, false);
      assert.equal(afterSvc.childAlive, false);
    } finally {
      // Defensive cleanup in case an assertion failed mid-test
      runNode(SUPERVISOR, ['stop', '--id', 'demo-worker'], { cwd: supRoot, env });
    }
  });
});
