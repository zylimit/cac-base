// ext/selftest.mjs — Self-contained regression suite for `.cac/harness/ext/*`.
// Zero external fixture file dependencies; explicitly locks all 4 legacy codeagent-base engine bug fixes.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  HARNESS_DIR, isDenied, matchAny, normalizeTier, specificity, toPosixPath, withDirLock,
} from '../lib/core.mjs';
import { classifyPath, lintCatalog } from './catalog.mjs';
import {
  analyzeImpact, compareRatchet, expandSourceFiles, extractImports, findCycles, layerViolation,
  moduleForSpecifier, scanArch,
} from './graph.mjs';
import { buildPack } from './context.mjs';
import {
  aggregateStates, applyWaiver, assessAttributes, contentHash, isProtectedCheck, matchReceipts,
  receiptIntact, requiredChecks, runCheck, safeTaskId, validateWaiver, verifyPlan, waivePlan,
} from './quality.mjs';
import { DEFAULT_FITNESS_RULES, assessAdrRecords, scanFitness } from './scan.mjs';
import {
  GENESIS, appendLedger, auditGates, buildPlan, chainHash, evidenceFindings, gateReason,
  ledgerFilePath, ledgerLine, ledgerReport, parseLedgerLines, planRetention, retentionRefusal,
  riskFindings, sha256Lf, verifyLedgerChain,
} from './evidence.mjs';
import {
  assessBudget, buildTaskRecord, completeBlockers, latestGateRecord, validateEnvelope,
} from './task.mjs';
import {
  REQUIRED_SECTIONS, collectReferences, dodStatus, lintSpecDoc, placeholderBrackets, traceReport,
} from './spec.mjs';
import {
  REVIEW_PROFILES, authorSetFor, backlogViolations, computeVerdict, currentStage,
  reviewLenses, stagePassed, validateClaims, validateFindings,
} from './review.mjs';
import {
  applyArchivePlan, extractIronLaws, isTrackedWork, pendingReviewCount, planArchive, syncFindings,
} from './memory.mjs';
import {
  classifyRuleLine, collectPoints, documentSections, lintModuleDoc, lintSkillFile, parseFrontmatter,
} from './rules.mjs';
import {
  checkReviewQueue, gateEstablished, manifestFindings, manifestIncludes, parseManifest,
  releaseVerdict, result,
} from './release.mjs';
import { draftCatalog, closeCoverage, planModules } from './init.mjs';

const INLINE_FIXTURES = {
  good: {
    version: 1,
    modules: [
      { id: 'core', paths: ['core/**'], riskTier: 'low' },
      { id: 'db', paths: ['db/**'], dependsOn: ['core'], riskTier: 'medium' },
      { id: 'auth', paths: ['auth/**'], dependsOn: ['db'], riskTier: 'high' },
      { id: 'api', paths: ['api/**'], dependsOn: ['auth'], riskTier: 'medium' },
    ],
    global: ['package.json'],
    ignored: ['README.md', 'docs/**'],
  },
  badCatchall: {
    version: 1,
    modules: [{ id: 'everything', paths: ['**/*'], riskTier: 'low' }],
  },
  badUnmapped: {
    version: 1,
    modules: [{ id: 'core', paths: ['core/**'], riskTier: 'low' }],
  },
  badOverlap: {
    version: 1,
    modules: [
      { id: 'core', paths: ['core/**'], riskTier: 'low' },
      { id: 'shared', paths: ['core/shared/**'], riskTier: 'low' },
    ],
  },
  badDangling: {
    version: 1,
    modules: [{ id: 'api', paths: ['api/**'], dependsOn: ['missing-mod'], riskTier: 'low' }],
  },
};

function attrCatalog(overrides = {}) {
  return {
    version: 1,
    modules: [{
      id: 'pay',
      paths: ['pay/**'],
      riskTier: 'high',
      verification: overrides.verification || ['sec-scan'],
      attributes: overrides.attributes || { security: 'critical' },
    }],
    checks: {
      'sec-scan': { command: process.execPath + ' --version', class: 'security', attributes: ['security'] },
      'sec-audit': { command: process.execPath + ' --version', class: 'security', attributes: ['security'] },
      ...(overrides.checks || {}),
    },
  };
}

function selftestCases() {
  const NODE = process.execPath;
  const hasCode = (errors, code) => errors.some((e) => e.code === code);
  const good = INLINE_FIXTURES.good;
  const goodTracked = [
    'core/index.ts', 'db/schema.ts', 'auth/login.ts', 'api/routes.ts',
    'package.json', 'README.md', 'docs/guide.md',
  ];

  const chainLines = (records) => {
    const out = [];
    let prev = GENESIS;
    for (const r of records) {
      const line = ledgerLine(r, prev);
      prev = line.chain;
      out.push(line);
    }
    return out;
  };

  const gateRec = (over = {}) => ({
    command: 'gate',
    at: '2026-01-01T00:00:00.000Z',
    gate: 'PASS',
    reason: 'all-executed-checks-passed',
    diffHash: 'D0',
    planHash: 'P0',
    scopeSource: 'computed',
    scopeRequested: null,
    modules: ['pay'],
    degraded: false,
    fastActive: false,
    skippedByFastMode: [],
    results: [],
    ...over,
  });

  const envelope = (over = {}) => ({
    id: 'T1',
    goal: 'g',
    scope: 's',
    outOfScope: 'o',
    existingPattern: 'p',
    businessContext: 'why: fresh delegate needs context',
    verification: 'v',
    escalation: 'e',
    ...over,
  });

  const okReceipt = (over = {}) => {
    const r = {
      taskId: 'T1',
      baseCommit: 'c0',
      diffHash: 'D0',
      reviewer: 'rev',
      verdict: 'ACCEPT',
      scope: 's',
      timestamp: '2026-01-01T00:00:00.000Z',
      ...over,
    };
    r.contentHash = contentHash(r);
    return r;
  };

  const [S_OVERVIEW, S_SCENARIO, S_REQUIREMENT, S_TECH] = REQUIRED_SECTIONS;
  const specDoc = (requirementLines, over = {}) => [
    '# Product Spec',
    '',
    '## ' + S_OVERVIEW,
    over.overview === undefined ? 'a governance tool for teams' : over.overview,
    '',
    '## ' + S_SCENARIO,
    over.scenario === undefined ? '- commit flow: edit code, run gate, read receipt' : over.scenario,
    '',
    '## ' + S_REQUIREMENT,
    ...requirementLines,
    '',
    '## ' + S_TECH,
    over.tech === undefined ? '| dimension | choice | reason |' : over.tech,
    '',
  ].join('\n');

  return [
    // --- S1 / S4 catalog & classification ---
    ['ext: toPosixPath normalizes Windows separators idempotently', () => {
      assert.equal(toPosixPath('a\\b\\c'), 'a/b/c');
      assert.equal(toPosixPath(path.win32.join('.cac', 'AGENTS.md')), '.cac/AGENTS.md');
      assert.ok(specificity('src/auth/**') > specificity('src/**'));
      assert.ok(!matchAny('src/a/b.ts', ['src/*']));
    }],
    ['ext: catalog-lint validates good and catches CATCH_ALL / UNMAPPED / OVERLAP / DANGLING_DEP', () => {
      assert.equal(classifyPath('db/schema.ts', good).moduleId, 'db');
      assert.equal(classifyPath('weird/x', good).kind, 'unmapped');
      assert.ok(lintCatalog(good, goodTracked).ok);
      assert.ok(hasCode(lintCatalog(INLINE_FIXTURES.badCatchall, []).errors, 'CATCH_ALL'));
      assert.ok(hasCode(lintCatalog(INLINE_FIXTURES.badUnmapped, ['weird/x.ts']).errors, 'UNMAPPED'));
      assert.ok(hasCode(lintCatalog(INLINE_FIXTURES.badOverlap, ['core/shared/x.ts']).errors, 'OVERLAP'));
      assert.ok(hasCode(lintCatalog(INLINE_FIXTURES.badDangling, []).errors, 'DANGLING_DEP'));
    }],
    ['ext: catalog-lint scale smoke (120 modules x 5000 paths < 2500ms)', () => {
      const modules = [];
      const paths = [];
      for (let i = 0; i < 120; i++) {
        modules.push({ id: 'm' + i, paths: ['pkg/m' + i + '/**'], riskTier: 'low' });
      }
      for (let i = 0; i < 5000; i++) paths.push('pkg/m' + (i % 120) + '/f' + i + '.ts');
      const t0 = Date.now();
      for (const p of paths) assert.equal(classifyPath(p, { version: 1, modules }).kind, 'module');
      assert.ok(Date.now() - t0 < 2500, 'classification exceeded 2.5s budget');
    }],

    // --- S5 impact + S6 context-pack ---
    ['ext: impact computes reverse dependency closure and conservative unmapped fanout', () => {
      const r = analyzeImpact(['db/x.ts'], good, {});
      assert.ok(r.affected.includes('db') && r.affected.includes('auth') && r.affected.includes('api'));
      assert.ok(!r.affected.includes('core'));
      assert.equal(r.degraded, false);
      const u = analyzeImpact(['unknown/file.ts'], good, {});
      assert.equal(u.degraded, true);
      assert.equal(u.affected.length, 4);
    }],
    ['ext: context-pack excludes .cac runtime/receipts and secrets from included[]', () => {
      assert.ok(isDenied('.cac/harness/receipts/foo.json'));
      assert.ok(isDenied('.cac/.runtime/supervisor/web/state.json'));
      const r = buildPack({
        diffHash: 'd',
        diffChars: 0,
        candidateFiles: [
          { path: '.env', bytes: 10 },
          { path: '.cac/harness/receipts/x.json', bytes: 10 },
          { path: 'src/real.ts', bytes: 10 },
        ],
      });
      const inc = r.included.map((f) => f.path);
      assert.deepEqual(inc, ['<canonical-diff>', 'src/real.ts']);
      assert.ok(r.denied.includes('.env') && r.denied.includes('.cac/harness/receipts/x.json'));
    }],

    // --- BUG FIX #1 REGRESSION: arch-check directory recursion (NO EISDIR) ---
    ['ext [BUGFIX-1]: scanArch recursively walks nested directories without throwing EISDIR', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cac-selftest-arch-'));
      try {
        fs.mkdirSync(path.join(tmp, 'src', 'core', 'sub'), { recursive: true });
        fs.mkdirSync(path.join(tmp, 'src', 'analytics', 'nested'), { recursive: true });
        fs.mkdirSync(path.join(tmp, 'src', 'pii-store'), { recursive: true });
        fs.writeFileSync(path.join(tmp, 'src', 'core', 'sub', 'util.mjs'), 'export const u = 1;\n', 'utf8');
        fs.writeFileSync(path.join(tmp, 'src', 'pii-store', 'vault.mjs'), 'export const s = 2;\n', 'utf8');
        fs.writeFileSync(
          path.join(tmp, 'src', 'analytics', 'nested', 'track.mjs'),
          'import { u } from "../../core/sub/util.mjs";\nimport { s } from "../../pii-store/vault.mjs";\nexport const t = u + s;\n',
          'utf8',
        );
        const cat = {
          version: 1,
          modules: [
            { id: 'core', paths: ['src/core/**'], riskTier: 'low' },
            { id: 'pii-store', paths: ['src/pii-store/**'], riskTier: 'high' },
            { id: 'analytics', paths: ['src/analytics/**'], forbiddenDependencies: ['pii-store'], riskTier: 'medium' },
          ],
        };
        // Pass directory paths AND glob paths directly into candidatePaths: must NEVER throw EISDIR!
        const expanded = expandSourceFiles(tmp, ['src/core', 'src/analytics/**', 'src/pii-store']);
        assert.equal(expanded.length, 3);
        const rep = scanArch(tmp, cat, { candidatePaths: ['src/core', 'src/analytics', 'src/pii-store'] });
        assert.equal(rep.scannedFiles, 3);
        assert.equal(rep.ok, false);
        assert.equal(rep.forbiddenDependencies.length, 1);
        assert.equal(rep.forbiddenDependencies[0].from, 'analytics');
        assert.equal(rep.forbiddenDependencies[0].to, 'pii-store');
        assert.equal(rep.undeclaredDependencies.length, 1);
        assert.equal(rep.undeclaredDependencies[0].from, 'analytics');
        assert.equal(rep.undeclaredDependencies[0].to, 'core');
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }],

    // --- BUG FIX #2 REGRESSION: security / safety / privacy non-bypassable + non-duplicate attributes ---
    ['ext [BUGFIX-2]: security / safety / privacy NEVER skipped in fast or waived by checkId or attribute, and zero duplicate attributes', () => {
      // 1) Protected via `class` OR via `attributes[]` (even if class is 'quality')!
      for (const prot of ['security', 'safety', 'privacy']) {
        const byClass = { id: 'c-' + prot, command: NODE + ' --version', class: prot, allowFastSkip: true };
        const byAttr = { id: 'a-' + prot, command: NODE + ' --version', class: 'quality', attributes: [prot], allowFastSkip: true };
        assert.ok(isProtectedCheck(byClass));
        assert.ok(isProtectedCheck(byAttr));
        // Fast mode MUST NOT skip either!
        assert.equal(runCheck(byClass, { fastActive: true }).state, 'PASS');
        assert.equal(runCheck(byAttr, { fastActive: true }).state, 'PASS');
        // Pre-execution waivePlan MUST block waivers on both!
        const wp = waivePlan(
          [{ module: 'pay', spec: byClass }, { module: 'pay', spec: byAttr }],
          [{ scope: 'c-' + prot }, { scope: 'a-' + prot }],
        );
        assert.equal(wp.waiversBlocked.length, 2);
        assert.equal(wp.plan[0].waiver, null);
        assert.equal(wp.plan[1].waiver, null);
        // Post-hoc applyWaiver MUST NOT rewrite FAIL on either!
        assert.equal(applyWaiver({ ...byClass, state: 'FAIL', exit: 1 }, [{ scope: 'c-' + prot }]).state, 'FAIL');
        assert.equal(applyWaiver({ ...byAttr, state: 'FAIL', exit: 1 }, [{ scope: 'a-' + prot }]).state, 'FAIL');
        // Waiver validator rejects scope/reason naming protected attribute
        const wErrs = validateWaiver({
          version: 1, owner: 'u', reason: 'defer check', scope: 'attribute:pay/' + prot,
          expiry: '2099-01-01T00:00:00.000Z', compensation: 'fix later', created_at: '2026-01-01T00:00:00.000Z',
        });
        assert.ok(wErrs.length > 0, 'waiver must reject ' + prot);
      }

      // 2) Even if a hand-edited waiver file bypassed validateWaiver for `high` tier security/safety/privacy,
      // assessAttributes refuses to waive protected attributes AND never emits duplicate entries!
      const cat = attrCatalog({
        verification: [],
        attributes: { security: 'high', safety: 'high', privacy: 'high', resilience: 'high' },
      });
      const forgedWaivers = [
        { scope: 'attribute:pay/security' },
        { scope: 'attribute:pay/safety' },
        { scope: 'attribute:pay/privacy' },
        { scope: 'attribute:pay/resilience' },
      ];
      // Duplicate moduleIds passed in `affectedIds` must STILL emit each module+attribute AT MOST ONCE!
      const assessed = assessAttributes(['pay', 'pay'], cat, [], forgedWaivers);
      assert.equal(assessed.attributes.length, 4, 'must not duplicate attributes');
      assert.equal(assessed.blockingGaps.length, 3, 'security/safety/privacy high gaps must remain blocking without duplicates');
      assert.deepEqual(assessed.blockingGaps.map((g) => g.attribute).sort(), ['privacy', 'safety', 'security']);
    }],

    // --- BUG FIX #3 REGRESSION: fitness / scan never misflags https:// or wss:// ---
    ['ext [BUGFIX-3]: scanFitness catches plaintext http:// and ws:// in high-security module while NEVER flagging https:// or wss://', () => {
      const highSecCat = {
        version: 1,
        modules: [{ id: 'pay', paths: ['pay/**'], attributes: { security: 'high' } }],
      };
      const cleanSecure = [
        'const api = "https://api.payments.acme.io/v1/charge";',
        'const stream = "wss://events.payments.acme.io/live";',
        'const local = "http://localhost:3000/health";',
        'const lo = "http://127.0.0.1:8080/ready";',
      ].join('\n');
      const secureFindings = scanFitness([{ path: 'pay/client.ts', content: cleanSecure }], highSecCat, DEFAULT_FITNESS_RULES);
      assert.equal(secureFindings.length, 0, 'https://, wss://, and localhost http:// must produce 0 findings: ' + JSON.stringify(secureFindings));

      const insecure = [
        'const bad1 = "http://' + 'api.payments.acme.io/v1";', // scan-secrets:ignore harness-fitness:ignore
        'const bad2 = "ws://' + 'stream.payments.acme.io/live";', // scan-secrets:ignore harness-fitness:ignore
      ].join('\n');
      const badFindings = scanFitness([{ path: 'pay/client.ts', content: insecure }], highSecCat, DEFAULT_FITNESS_RULES);
      assert.equal(badFindings.filter((f) => f.rule === 'no-insecure-transport').length, 2);
    }],

    // --- BUG FIX #4 REGRESSION: release review-queue & audit logs never deadlock clean state ---
    ['ext [BUGFIX-4]: release review-queue passes when .cac/.needs-review is missing/empty/clean even with populated audit logs', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cac-selftest-rel-'));
      const savedCodeAgent = process.env.CODEAGENT3_PROJECT_DIR;
      const savedCac = process.env.CAC_PROJECT_DIR;
      try {
        process.env.CODEAGENT3_PROJECT_DIR = tmp;
        process.env.CAC_PROJECT_DIR = tmp;
        fs.mkdirSync(path.join(tmp, '.cac', 'evidence'), { recursive: true });
        fs.mkdirSync(path.join(tmp, '.cac', 'harness', 'state'), { recursive: true });
        // Populate non-empty gate-block.log and ledger.jsonl: MUST NOT lock release!
        fs.writeFileSync(path.join(tmp, '.cac', 'evidence', 'gate-block.log'), '2026-01-01T00:00:00Z\tstop-gate\tblock\treason\n', 'utf8');
        appendLedger(gateRec());

        // Missing .needs-review -> PASS
        assert.equal(pendingReviewCount(), 0);
        assert.equal(checkReviewQueue().status, 'PASS');

        // Clean .needs-review -> PASS
        fs.writeFileSync(path.join(tmp, '.cac', '.needs-review'), 'clean\r\n', 'utf8');
        assert.equal(pendingReviewCount(), 0);
        assert.equal(checkReviewQueue().status, 'PASS');

        // Actual pending file -> FAIL with actionable nextStep
        fs.writeFileSync(path.join(tmp, '.cac', '.needs-review'), 'src/dirty.mjs\n', 'utf8');
        assert.equal(pendingReviewCount(), 1);
        const failRes = checkReviewQueue();
        assert.equal(failRes.status, 'FAIL');
        assert.ok(failRes.nextStep && failRes.nextStep.includes('.cac/.needs-review'));
      } finally {
        if (savedCodeAgent === undefined) delete process.env.CODEAGENT3_PROJECT_DIR;
        else process.env.CODEAGENT3_PROJECT_DIR = savedCodeAgent;
        if (savedCac === undefined) delete process.env.CAC_PROJECT_DIR;
        else process.env.CAC_PROJECT_DIR = savedCac;
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }],

    // --- S7 / S8 / S12 / S13 / S15 / S16 core assertions ---
    ['ext: receipt tamper detection, stale diff detection, and safeTaskId', () => {
      const r = okReceipt({ diffHash: 'H1' });
      assert.ok(receiptIntact(r));
      assert.ok(!receiptIntact({ ...r, verdict: 'tampered' }));
      assert.equal(matchReceipts([r], 'H2').matched, null);
      assert.equal(safeTaskId('../../etc/passwd'), '.._.._etc_passwd');
    }],
    ['ext: runCheck 4-state + emptyPlan BLOCKED', () => {
      assert.equal(runCheck({ id: 'x' }, {}).state, 'BLOCKED');
      assert.equal(runCheck({ id: 'x', command: '__missing_bin_999__ arg' }, {}).state, 'BLOCKED');
      assert.equal(runCheck({ id: 'ok', command: NODE + ' --version' }, {}).state, 'PASS');
      assert.equal(aggregateStates(['PASS', 'FAIL', 'BLOCKED']), 'FAIL');
      const plan = verifyPlan(['a/x.js'], { modules: [{ id: 'a', paths: ['a/**'] }] });
      assert.equal(plan.state, 'BLOCKED');
      assert.equal(plan.emptyPlan, true);
      assert.deepEqual(requiredChecks('high', { verification: ['x'] }, { riskChecks: { high: ['a'] } }), ['x']);
    }],
    ['ext: graph helpers (extractImports, moduleForSpecifier, layerViolation, findCycles, compareRatchet)', () => {
      const got = extractImports('src/x.ts', 'import a from "mod-a";\nconst b = require("./rel");\n');
      assert.ok(got.includes('mod-a') && got.includes('./rel'));
      const cat = {
        layers: ['app', 'domain'],
        modules: [
          { id: 'core', paths: ['core/**'], provides: ['@acme'] },
          { id: 'db', paths: ['db/**'], provides: ['@acme/db'] },
        ],
      };
      assert.equal(moduleForSpecifier(cat, '@acme/db/client'), 'db');
      assert.ok(/may not depend/.test(layerViolation(cat, { id: 'd', layer: 'domain' }, { id: 'a', layer: 'app' })));
      assert.ok(findCycles(new Map([['a', new Set(['b'])], ['b', new Set(['a'])]])).length >= 1);
      const rat = compareRatchet([
        { undeclared: 2, forbidden: 0, cycles: 0, undeclaredEdges: ['a->b', 'b->c'] },
        { undeclared: 2, forbidden: 0, cycles: 0, undeclaredEdges: ['a->b', 'x->y'] },
      ]);
      assert.ok(rat.regressed.some((x) => x.metric === 'undeclared' && x.newEdges.includes('x->y')));
    }],
    ['ext: fitness rules + ADR enforcement checks', () => {
      const secretSrc = 'const apiKey = "' + 'AKIAABCDEFGHIJKLMNOP";\n'; // scan-secrets:ignore harness-fitness:ignore
      assert.ok(scanFitness([{ path: 'src/a.ts', content: secretSrc }], null, DEFAULT_FITNESS_RULES).some((x) => x.rule === 'no-secret-literal'));
      const adr = assessAdrRecords([
        { id: 'ADR-1', status: 'accepted', enforcedRaw: 'arch-check', revisitRaw: '\u9700\u8981\u591a\u79df\u6237', reversalRaw: '\u5355\u5411\u95e8' },
        { id: 'ADR-2', status: 'accepted', enforcedRaw: 'phantom-check', revisitRaw: '\u9700\u8981\u591a\u79df\u6237', reversalRaw: '\u5355\u5411\u95e8' },
      ], [], DEFAULT_FITNESS_RULES.map((x) => x.id));
      assert.equal(adr.failing.length, 1);
      assert.equal(adr.failing[0].id, 'ADR-2');
    }],

    // --- S17 evidence & ledger + S18 task & budget ---
    ['ext: hash-chained ledger detects content/chain/evidence tampering and survives interrupted partial line', () => {
      const lines = chainLines([gateRec(), gateRec({ gate: 'FAIL' }), gateRec()]);
      assert.ok(verifyLedgerChain(lines).ok);
      lines[1].gate = 'PASS';
      assert.ok(verifyLedgerChain(lines).breaks.some((b) => b.reason === 'content-hash-mismatch'));
      assert.equal(ledgerReport({ entries: [], unreadable: 'EACCES' }).code, 3);
      const ev = evidenceFindings(
        chainLines([gateRec({ results: [{ id: 'u', evidence: 'e/u.log', evidenceSha256: sha256Lf('orig') }] })]),
        { readFile: () => 'tampered' },
      );
      assert.equal(ev.ok, false);
      assert.equal(ev.breaks[0].reason, 'evidence-tampered');
      assert.equal(buildPlan([], attrCatalog()).empty, true);
      assert.equal(gateReason('PASS', { checks: [{ state: 'PASS' }], attributeGaps: [], emptyPlan: false }), 'all-executed-checks-passed');
      assert.equal(auditGates(chainLines([gateRec({ results: [{ id: 'u', state: 'PASS' }] })]), { checks: { u: {} } }).neverIntervened.length, 1);
      assert.deepEqual(
        planRetention([{ path: 'a', mtimeMs: 10 }, { path: 'b', mtimeMs: 5 }], { protectedPaths: new Set(['b']), keep: 0, cutoffMs: 0 }).map((p) => p.path),
        ['a'],
      );
      assert.equal(retentionRefusal('EACCES', null).reason, 'ledger-unreadable');
      assert.ok(riskFindings({ ledgerEntries: lines }).findings.some((f) => f.code === 'LEDGER_BROKEN'));

      // Partial interrupted line framing test
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cac-selftest-ledger-'));
      const saved = process.env.CODEAGENT3_PROJECT_DIR;
      try {
        process.env.CODEAGENT3_PROJECT_DIR = dir;
        appendLedger({ command: 'gate', at: 'T1' });
        fs.appendFileSync(ledgerFilePath(), '{"command":"gate","at":"T2', 'utf8');
        appendLedger({ command: 'gate', at: 'T3' });
        const parsed = parseLedgerLines(fs.readFileSync(ledgerFilePath(), 'utf8'));
        assert.equal(parsed.length, 3);
        assert.equal(parsed[2].at, 'T3');
      } finally {
        if (saved === undefined) delete process.env.CODEAGENT3_PROJECT_DIR;
        else process.env.CODEAGENT3_PROJECT_DIR = saved;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }],
    ['ext: task envelope validation, completeBlockers, budget, and dir lock', () => {
      assert.ok(validateEnvelope(envelope()).ok);
      assert.deepEqual(validateEnvelope(envelope({ businessContext: '' })).missing, ['businessContext']);
      assert.equal(buildTaskRecord(envelope({ id: '../bad' }), { now: 'T', baseCommit: 'c0' }).id, '.._bad');
      assert.deepEqual(completeBlockers({
        latestGate: gateRec({ gate: 'PASS', diffHash: 'D0', results: [{ id: 'u', state: 'PASS' }] }),
        currentDiffHash: 'D0',
        receipts: [okReceipt()],
        ledgerOk: true,
        evidenceOk: true,
        planEmpty: false,
      }), []);
      assert.ok(completeBlockers({
        latestGate: gateRec({ scopeSource: 'caller' }),
        currentDiffHash: 'D0',
        receipts: [okReceipt()],
        ledgerOk: true,
        evidenceOk: true,
        planEmpty: false,
      }).some((b) => b.includes('--changed')));
      assert.equal(latestGateRecord(chainLines([gateRec({ diffHash: 'A' }), gateRec({ diffHash: 'B' })])).diffHash, 'B');
      assert.ok(!assessBudget({ changedFiles: 10 }, { maxChangedFiles: 5 }).ok);

      const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cac-selftest-lock-'));
      try {
        const res = withDirLock(path.join(lockDir, 't.lock'), () => 'locked');
        assert.equal(res, 'locked');
      } finally {
        fs.rmSync(lockDir, { recursive: true, force: true });
      }
    }],

    // --- S19 spec-lint / trace + S20 review + S21 memory + S22-S25 rules/init/release ---
    ['ext: spec-lint and traceReport', () => {
      const ok = lintSpecDoc(specDoc(['- [REQ-CORE-001] login: user submits token -> session opens']), 'Product-Spec.md');
      assert.ok(ok.ok);
      assert.equal(ok.ids.length, 1);
      assert.deepEqual(placeholderBrackets('latency <100ms | availability >99.9%'), []);
      assert.equal(dodStatus(0), 'PASS');
      assert.equal(dodStatus(3), 'DEGRADED');
      const col = collectReferences([{ path: 'tests/auth.test.ts', content: '// REQ-CORE-001' }], ['**/*.test.*'], null);
      assert.ok(traceReport(ok.ids, col, 1).ok);
    }],
    ['ext: review stages, verdict disagreement (1 error beats clean lenses), and self-review block', () => {
      assert.ok(REVIEW_PROFILES.team.includes('correctness'));
      assert.ok(validateClaims({ claims: [{ statement: 'tests green', evidence: 'npm test -> 0' }] }).ok);
      assert.ok(!validateFindings({ findings: [{ severity: 'error', summary: 'unlocated' }] }).ok);
      assert.ok(backlogViolations({ owner: 'a', expiry: '2099-01-01T00:00:00Z', summary: 'fix later', lens: 'security' }).length > 0);

      const session = {
        requiredLenses: ['correctness', 'testing', 'security'],
        blue: { claims: [{ statement: 's', evidence: 'e' }] },
        lenses: {
          correctness: { agentId: 'impl-1', unable: false, findings: [] },
          testing: { agentId: 'tester-1', unable: false, findings: [] },
          security: { agentId: 'rev-1', unable: false, findings: [] },
        },
        lineage: [],
      };
      assert.equal(currentStage(session), 3);
      assert.ok(stagePassed(session, 1));
      const authors = authorSetFor([{ agentId: 'impl-1', files: ['src/a.mjs'] }], new Set(['src/a.mjs']));
      const selfBlocked = computeVerdict(session, { authors });
      assert.equal(selfBlocked.ok, false);
      assert.equal(selfBlocked.verdict, null);
      assert.equal(selfBlocked.selfReviewed.length, 1);

      const cleanVerdict = computeVerdict(session, { authors: new Map() });
      assert.equal(cleanVerdict.verdict, 'ACCEPT');

      const oneErrSession = {
        ...session,
        lenses: {
          ...session.lenses,
          security: { agentId: 'rev-1', unable: false, findings: [{ severity: 'error', location: 'src/a.mjs:1', summary: 'leak' }] },
        },
      };
      assert.equal(computeVerdict(oneErrSession).verdict, 'FIX_REQUIRED');
      assert.ok(reviewLenses(null).includes('correctness'));
    }],
    ['ext: memory (AGENTS.md iron laws, archive, syncFindings) + rules/skills/agents-md-lint + init + release', () => {
      const laws = extractIronLaws('[十条核心铁律——每条写明谁在守]\n    1. **主 Agent 不写码**：闸守\n[审批三档]\n    - **LOW**：直接跑\n');
      assert.deepEqual(laws, ['主 Agent 不写码']);
      assert.ok(isTrackedWork('.cac/hooks/stop-gate.mjs'));
      assert.ok(isTrackedWork('AGENTS.md'));
      assert.ok(!isTrackedWork('.cac/.runtime/tier.json'));
      const sf = syncFindings(['src/a.mjs', 'Product-Spec.md'], { progressPresent: true, specPresent: true, changelogPresent: true });
      assert.equal(sf.length, 2);

      const prog = '# Progress\n\n## Done\n- 2026-01-03 newest\n- 2026-01-02 mid\n- 2026-01-01 oldest\n';
      const ap = planArchive(prog, { maxEntries: 2 });
      assert.equal(ap.moving, 1);
      assert.ok(applyArchivePlan(prog, ap).progress.includes('progress.archive.md'));

      // rules-audit phantom vs machine
      const pts = collectPoints(['doctor', 'selftest']);
      assert.equal(classifyRuleLine('run `node .cac/harness/harness.mjs doctor`', pts).klass, 'machine');
      assert.equal(classifyRuleLine('run `node .cac/harness/harness.mjs ghost-cmd`', pts).klass, 'phantom');
      assert.equal(classifyRuleLine('run `node .cac/hooks/ghost-hook.mjs`', pts).klass, 'phantom');

      // skills-lint + agents-md-lint
      assert.equal(parseFrontmatter('---\nname: demo-skill\ndescription: 当用户需要演示时触发\n---\n').kind, 'ok');
      assert.equal(lintSkillFile('demo-skill', '.cac/skills/demo-skill/SKILL.md', '---\nname: demo-skill\ndescription: 当用户需要演示时触发\n---\n').findings.length, 0);
      const modDoc = '# Module\n## Purpose\np\n## Boundaries\nb\n## Invariants\ni\n## Verification\nv\n';
      assert.ok(documentSections(modDoc).purpose.nonEmpty);
      assert.equal(lintModuleDoc('pay', 'pay/AGENTS.md', modDoc).findings.length, 0);

      // init draft passes catalog-lint
      const tracked = ['src/a/one.mjs', 'src/a/two.mjs', 'src/b/one.mjs', 'src/b/two.mjs', 'package.json', 'README.md'];
      const draft = draftCatalog(planModules(tracked));
      closeCoverage(draft, tracked);
      assert.ok(lintCatalog(draft, tracked).ok);

      // release manifest JSON parser + exclusions + verdict
      assert.ok(!manifestIncludes('FRAMEWORK-MANIFEST.json'));
      assert.ok(!manifestIncludes('settings.json'));
      assert.ok(!manifestIncludes('harness/ext/catalog.mjs'));
      assert.ok(manifestIncludes('feedback/templates/feedback-index-template.md'));
      assert.ok(!manifestIncludes('feedback/FEEDBACK-INDEX.md'));
      assert.ok(manifestIncludes('hooks/stop-gate.mjs'));
      const pm = parseManifest(JSON.stringify({ version: 1, engine: 'cac-base', files: [{ path: '.cac/hooks/a.mjs', sha256: 'abc', bytes: 3 }] }));
      assert.equal(pm.get('hooks/a.mjs'), 'abc');
      assert.equal(manifestFindings(pm, new Map([['hooks/a.mjs', 'abc']])).changed.length, 0);
      assert.ok(gateEstablished(gateRec({ results: [{ id: 'u', state: 'PASS' }] })));
      assert.ok(!gateEstablished(gateRec({ scopeSource: 'caller' })));
      assert.equal(releaseVerdict([result('worktree', 'PASS', 'ok'), result('ci', 'DEGRADED', 'unknown')]).exit, 0);
      assert.equal(releaseVerdict([result('ci', 'DEGRADED', 'unknown')]).exit, 3);
    }],
  ];
}

export { selftestCases, attrCatalog };
