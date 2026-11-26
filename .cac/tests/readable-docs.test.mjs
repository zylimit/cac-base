// # risk: high
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..');
const READABLE_CLI = path.join(REPO_ROOT, '.cac', 'scripts', 'readable-docs.mjs');
const PAGE_SHOTS_CLI = path.join(REPO_ROOT, '.cac', 'scripts', 'page-shots.mjs');

const TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'cac-readable-test-'));
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
    maxBuffer: 64 * 1024 * 1024,
  });
}

function snapshotTree(dir) {
  const out = new Map();
  const visit = (cur) => {
    for (const ent of fs.readdirSync(cur, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) visit(full);
      else if (ent.isFile()) {
        const rel = path.relative(dir, full).replace(/\\/g, '/');
        const sha = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
        out.set(rel, sha);
      }
    }
  };
  if (fs.existsSync(dir)) visit(dir);
  return out;
}

function writeFullStackFixture(projectDir) {
  // Construct sample internal IP dynamically so static secret scanners never false-positive on test source
  const internalIp = ['10', '24', '35', '46'].join('.');

  // 1. PostgreSQL DDL (tables + FK + ALTER TABLE + INDEX + internal IP in comment to verify redaction)
  const sqlDir = path.join(projectDir, 'sql');
  fs.mkdirSync(sqlDir, { recursive: true });
  fs.writeFileSync(
    path.join(sqlDir, '001_schema.sql'),
    [
      '-- 客户账户主表（旧库迁移自 ' + internalIp + '）',
      'CREATE TABLE accounts (',
      '  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,',
      '  email TEXT NOT NULL UNIQUE, -- 登录邮箱',
      '  created_at TIMESTAMPTZ NOT NULL DEFAULT now()',
      ');',
      '',
      '-- 交易订单表',
      'CREATE TABLE orders (',
      '  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,',
      '  account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,',
      '  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0)',
      ');',
      '',
      '-- 补充下单备注列',
      'ALTER TABLE orders ADD COLUMN memo TEXT;',
      'CREATE INDEX idx_orders_account_id ON orders (account_id);',
      '',
    ].join('\n'),
    'utf8',
  );

  // 2. TypeScript / JS + Python code under src/ (reads, writes, imports, and FastAPI mounted routes)
  const billingDir = path.join(projectDir, 'src', 'billing');
  const apiDir = path.join(projectDir, 'src', 'api');
  fs.mkdirSync(billingDir, { recursive: true });
  fs.mkdirSync(apiDir, { recursive: true });

  fs.writeFileSync(
    path.join(billingDir, 'validator.ts'),
    [
      'export function ensureNonNegative(cents: number): number {',
      '  if (cents < 0) throw new Error("negative amount");',
      '  return cents;',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );

  fs.writeFileSync(
    path.join(billingDir, 'order_repo.ts'),
    [
      "import { ensureNonNegative } from './validator';",
      '',
      'export async function createAccountAndOrder(db: any, email: string, cents: number) {',
      '  const safe = ensureNonNegative(cents);',
      '  await db.query("INSERT INTO accounts (email) VALUES ($1)", [email]);',
      '  return db.query("SELECT o.id, o.amount_cents, a.email FROM orders o JOIN accounts a ON a.id = o.account_id WHERE a.email = $1", [email, safe]);',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );

  fs.writeFileSync(
    path.join(apiDir, 'orders_router.py'),
    [
      'from fastapi import APIRouter',
      '',
      'router = APIRouter(prefix="/orders")',
      '',
      '@router.post("/create")',
      'async def create_order(conn, account_id: int, amount_cents: int):',
      '    """Create a customer order row."""',
      '    await conn.execute("INSERT INTO orders (account_id, amount_cents) VALUES ($1, $2)", account_id, amount_cents)',
      '    return {"ok": True}',
      '',
      '@router.get("/list")',
      'async def list_orders(conn, account_id: int):',
      '    """List orders for a given account."""',
      '    return await conn.fetch("SELECT id, amount_cents, memo FROM orders WHERE account_id = $1", account_id)',
      '',
    ].join('\n'),
    'utf8',
  );

  fs.writeFileSync(
    path.join(apiDir, 'app.py'),
    [
      'from fastapi import FastAPI',
      'from src.api.orders_router import router as orders_router',
      '',
      'app = FastAPI()',
      'app.include_router(orders_router, prefix="/api/v1")',
      '',
    ].join('\n'),
    'utf8',
  );

  // 3. Product-Spec.md (rich Markdown blocks for zero-loss cutting & rendering verification)
  fs.writeFileSync(
    path.join(projectDir, 'Product-Spec.md'),
    [
      '# 订单服务产品规格',
      '',
      '> 核心原则：每一分钱的入账与查询都可追溯。',
      '',
      '## 1. 功能需求',
      '',
      '- [REQ-ORD-001] [确认] 创建订单并校验非负金额，支持多行续写说明',
      '  当金额小于 0 时直接拒绝写入。',
      '- [REQ-ORD-002] [确认] 按账户查询历史订单列表（含 `\\|` 转义竖线校验）',
      '',
      '| 状态码 | 含义 | 说明 |',
      '|---|---|---|',
      '| 200 | 成功 | 返回订单记录 \\| 空数组 |',
      '| 400 | 参数非法 | 金额为负数 |',
      '',
      '## 2. 接口示例',
      '',
      '```json',
      '{ "account_id": 42, "amount_cents": 1999 }',
      '```',
      '',
    ].join('\n'),
    'utf8',
  );

  // 4. Architecture-Design.md
  fs.writeFileSync(
    path.join(projectDir, 'Architecture-Design.md'),
    [
      '# 订单服务架构设计',
      '',
      '## 模块划分',
      '- `api`：对外暴露 FastAPI 路由接口。',
      '- `billing`：负责金额校验与账单持久化。',
      '',
    ].join('\n'),
    'utf8',
  );

  return { internalIp };
}

describe('readable-docs full-stack & page-shots contract', () => {
  test('init -> build -> check (rc 0, 不一致 0 条) extracts PostgreSQL DDL, JS/Python table R/W, imports, routes, Spec, and redacts internal IP', () => {
    const proj = nextDir('fullstack-init-build-check');
    const { internalIp } = writeFullStackFixture(proj);

    // 1. init
    const rInit = runNode(READABLE_CLI, ['init', '--root', proj, '--json']);
    assert.equal(rInit.status, 0, rInit.stderr);
    const initJson = JSON.parse(rInit.stdout.trim());
    assert.equal(initJson.created, true);
    assert.deepEqual(initJson.config.ddl, ['sql/001_schema.sql']);
    assert.deepEqual(initJson.config.codeRoots, ['src']);
    assert.equal(initJson.config.spec, 'Product-Spec.md');
    assert.deepEqual(initJson.config.archDocs, ['Architecture-Design.md']);

    // 2. build --facts-json verifies extracted facts across SQL, TS, Python, FastAPI routes, and architecture modules
    const rFacts = runNode(READABLE_CLI, ['build', '--facts-json', '--root', proj]);
    assert.equal(rFacts.status, 0, rFacts.stderr);
    const facts = JSON.parse(rFacts.stdout);
    assert.deepEqual(facts.tables.map((t) => t.name).sort(), ['accounts', 'orders']);
    assert.ok(facts.usage.accounts.writes.some((w) => w.file === 'src/billing/order_repo.ts'));
    assert.ok(facts.usage.accounts.reads.some((r) => r.file === 'src/billing/order_repo.ts'));
    assert.ok(facts.usage.orders.writes.some((w) => w.file === 'src/api/orders_router.py'));
    assert.ok(facts.usage.orders.reads.some((r) => r.file === 'src/api/orders_router.py'));
    assert.ok(facts.usage.orders.reads.some((r) => r.file === 'src/billing/order_repo.ts'));

    const fullPaths = facts.code.routes.map((rt) => rt.fullPath).sort();
    assert.deepEqual(fullPaths, ['/api/v1/orders/create', '/api/v1/orders/list']);
    assert.ok(facts.arch.modules.length >= 2, 'expected architecture modules summarized from src/*');
    assert.ok(facts.spec && facts.spec.blocks.length >= 6);

    // 3. build HTML pages
    const rBuild = runNode(READABLE_CLI, ['build', '--root', proj]);
    assert.equal(rBuild.status, 0, rBuild.stderr);
    const outDir = path.join(proj, 'docs', 'readable');
    assert.equal(fs.existsSync(path.join(outDir, 'index.html')), true);
    assert.equal(fs.existsSync(path.join(outDir, 'db', 'index.html')), true);
    assert.equal(fs.existsSync(path.join(outDir, 'arch', 'index.html')), true);
    assert.equal(fs.existsSync(path.join(outDir, 'spec', 'index.html')), true);

    // Verify internal IP was redacted across ALL generated HTML files
    for (const [rel] of snapshotTree(outDir)) {
      if (!rel.endsWith('.html')) continue;
      const html = fs.readFileSync(path.join(outDir, rel), 'utf8');
      assert.equal(html.includes(internalIp), false, `internal IP leaked into ${rel}`);
    }

    // 4. check reports "不一致 0 条" and exits rc 0
    const rCheck = runNode(READABLE_CLI, ['check', '--root', proj]);
    assert.equal(rCheck.status, 0, rCheck.stderr + rCheck.stdout);
    assert.match(rCheck.stdout.trim(), /不一致 0 条$/);
  });

  test('Product-Spec zero-loss selfcheck & atomic publish protection: READABLE_FAIL_AT=spec-cut, spec-render, render, selfcheck, leak all exit rc 3 and preserve existing pages untouched', () => {
    const proj = nextDir('atomic-and-fail-at');
    writeFullStackFixture(proj);
    assert.equal(runNode(READABLE_CLI, ['init', '--root', proj]).status, 0);
    assert.equal(runNode(READABLE_CLI, ['build', '--root', proj]).status, 0);

    const outDir = path.join(proj, 'docs', 'readable');
    const docsParent = path.join(proj, 'docs');
    const beforeSnap = snapshotTree(outDir);
    assert.ok(beforeSnap.size > 0);

    for (const failAt of ['spec-cut', 'spec-render', 'render', 'selfcheck', 'leak']) {
      const r = runNode(READABLE_CLI, ['build', '--root', proj], {
        env: { READABLE_FAIL_AT: failAt },
      });
      assert.equal(
        r.status,
        3,
        `READABLE_FAIL_AT=${failAt} must exit rc 3, got ${r.status}: ${r.stderr}`,
      );

      // Existing docs/readable/ pages MUST remain byte-for-byte identical
      const afterSnap = snapshotTree(outDir);
      assert.deepEqual(
        [...afterSnap.entries()],
        [...beforeSnap.entries()],
        `docs/readable was corrupted or altered under READABLE_FAIL_AT=${failAt}`,
      );

      // No leftover .readable-tmp-* directory
      const leftovers = fs.readdirSync(docsParent).filter((n) => n.startsWith('.readable-tmp-'));
      assert.deepEqual(leftovers, [], `temp publish directory left behind under READABLE_FAIL_AT=${failAt}`);
    }
  });

  test('note put -> note confirm --by -> DDL schema change marks note-stale and check exits rc 1', () => {
    const proj = nextDir('notes-lifecycle');
    writeFullStackFixture(proj);
    assert.equal(runNode(READABLE_CLI, ['init', '--root', proj]).status, 0);
    assert.equal(runNode(READABLE_CLI, ['build', '--root', proj]).status, 0);

    // 1. note put via --file
    const notesInputFile = path.join(proj, 'draft-notes.md');
    fs.writeFileSync(
      notesInputFile,
      [
        '## table:orders',
        '记录客户每次下单的应付金额与备注，一条记录对应一笔业务订单。',
        '',
        '## column:orders.amount_cents',
        '订单应付总额（单位：分，非负整数；0 表示赠品单）。',
        '',
      ].join('\n'),
      'utf8',
    );

    const rPut = runNode(READABLE_CLI, ['note', 'put', '--file', notesInputFile, '--root', proj]);
    assert.equal(rPut.status, 0, rPut.stderr);
    assert.match(rPut.stdout, /status draft|状态 draft/);

    // 2. note confirm --by
    const rConfirm = runNode(READABLE_CLI, ['note', 'confirm', 'table:orders', '--by', 'reviewer_alice', '--root', proj]);
    assert.equal(rConfirm.status, 0, rConfirm.stderr);
    assert.match(rConfirm.stdout, /reviewed（reviewer_alice/);

    // Rebuild with notes bound -> check passes with 0 inconsistencies
    assert.equal(runNode(READABLE_CLI, ['build', '--root', proj]).status, 0);
    assert.equal(runNode(READABLE_CLI, ['check', '--root', proj]).status, 0);

    // 3. Alter orders table schema (add a new column) -> table:orders slice fingerprint changes -> note-stale!
    fs.appendFileSync(
      path.join(proj, 'sql', '001_schema.sql'),
      '\nALTER TABLE orders ADD COLUMN currency TEXT NOT NULL DEFAULT \'CNY\';\n',
      'utf8',
    );
    // Rebuild HTML pages so page facts match new DDL, isolating the stale note check
    assert.equal(runNode(READABLE_CLI, ['build', '--root', proj]).status, 0);

    const rCheckStale = runNode(READABLE_CLI, ['check', '--json', '--root', proj]);
    assert.equal(rCheckStale.status, 1, 'check must exit rc 1 when a bound table note becomes stale');
    const checkJson = JSON.parse(rCheckStale.stdout);
    assert.equal(checkJson.ok, false);
    assert.equal(checkJson.summary.notes.stale, 1);
    assert.ok(
      checkJson.problems.some((p) => p.kind === 'note-stale' && p.where === 'table:orders'),
      `expected note-stale for table:orders, got: ${JSON.stringify(checkJson.problems)}`,
    );

    // Confirming a stale note without rewriting & re-putting must also fail with rc 1
    const rConfirmStale = runNode(READABLE_CLI, ['note', 'confirm', 'table:orders', '--by', 'reviewer_bob', '--root', proj]);
    assert.equal(rConfirmStale.status, 1);
  });

  test('structure reads back 5 structural metrics, and page-shots.mjs exits rc 3 when browser is absent', () => {
    const proj = nextDir('structure-and-shots');
    writeFullStackFixture(proj);
    assert.equal(runNode(READABLE_CLI, ['init', '--root', proj]).status, 0);
    assert.equal(runNode(READABLE_CLI, ['build', '--root', proj]).status, 0);

    // 1. structure (--json & human)
    const rStructJson = runNode(READABLE_CLI, ['structure', '--root', proj, '--json']);
    assert.equal(rStructJson.status, 0, rStructJson.stderr);
    const st = JSON.parse(rStructJson.stdout);
    assert.deepEqual(Object.keys(st).sort(), ['big', 'cycles', 'problems', 'unassigned', 'upward']);
    assert.ok(Array.isArray(st.cycles));
    assert.ok(Array.isArray(st.upward));
    assert.ok(Array.isArray(st.unassigned));
    assert.ok(Array.isArray(st.big));
    assert.equal(typeof st.problems, 'number');

    const rStructHuman = runNode(READABLE_CLI, ['structure', '--root', proj]);
    assert.equal(rStructHuman.status, 0, rStructHuman.stderr);
    assert.match(
      rStructHuman.stdout.trim(),
      /^结构：循环依赖 \d+ 组、越层引用 \d+ 处、未归属的文件 \d+ 个、超过 1000 行的文件 \d+ 个、项目判断里对不上的 \d+ 条$/,
    );

    // 2. page-shots.mjs: --out inside target dir fails usage check (rc 2) BEFORE browser lookup
    const readableDir = path.join(proj, 'docs', 'readable');
    const rBadOut = runNode(PAGE_SHOTS_CLI, [readableDir, 'index.html', '--out', path.join(readableDir, 'shots')]);
    assert.equal(rBadOut.status, 2);

    // 3. page-shots.mjs without browser (CHROME_PATH pointing to non-existent binary) MUST exit rc 3 and write zero images
    const shotsOut = nextDir('shots-out');
    const missingChrome = path.join(proj, 'nonexistent-chromium-bin');
    const rNoBrowser = runNode(PAGE_SHOTS_CLI, [readableDir, 'index.html', '--out', shotsOut], {
      env: { CHROME_PATH: missingChrome },
    });
    assert.equal(rNoBrowser.status, 3, `expected rc 3 when browser absent, got ${rNoBrowser.status}: ${rNoBrowser.stderr}`);
    assert.match(rNoBrowser.stderr, /看页面缺席：/);
    assert.deepEqual(fs.readdirSync(shotsOut), [], 'must not emit any screenshot files when browser is absent');
  });
});
