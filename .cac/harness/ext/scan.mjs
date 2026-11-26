// ext/scan.mjs — S13 fitness, S14 adapters, S15 adr-check.
// Fixes legacy codeagent-base bug: insecure transport detection NEVER misflags `https://` or `wss://`!

import fs from 'node:fs';
import path from 'node:path';
import {
  HARNESS_DIR, SOURCE_EXTS, TIER_RANK,
  catalogFilePath, changedPaths, emit, isDenied, isGitRepo, isStateExcluded, matchAny,
  normalizeTier, parseCsv, projectRoot, repoRelative, toPosixPath, whichCmd,
} from '../lib/core.mjs';
import { loadCatalog, loadCatalogFlag, moduleForPath, trackedFiles } from './catalog.mjs';

// ===========================================================================
// S13 fitness
// ===========================================================================
const FITNESS_IGNORE = 'harness-fitness:ignore';

const DEFAULT_FITNESS_RULES = [
  {
    id: 'no-secret-literal',
    attributes: ['security'],
    severity: 'error',
    forbid: '(?:api[_-]?key|secret|password|passwd|token|private[_-]?key|credential)\\s*[:=]\\s*["\'][A-Za-z0-9/+_\\-]{16,}["\']'
      + '|["\'](?:sk|pk|rk)[_-]live[_-][A-Za-z0-9]{12,}["\']'
      + '|["\']gh[pousr]_[A-Za-z0-9]{16,}["\']'
      + '|["\']xox[abposr]-[A-Za-z0-9-]{10,}["\']'
      + '|["\']AKIA[0-9A-Z]{16}["\']'
      + '|-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----',
    rationale: 'a credential written into source is published the moment the repository is shared',
    fix: 'read the value from the environment or a secrets manager; keep only a placeholder in code',
  },
  {
    id: 'no-pii-in-logs',
    attributes: ['privacy'],
    severity: 'error',
    forbid: '(?:log|logger|console|print|println|fmt\\.Print\\w*)[.\\w]*\\s*\\([^)\\n]*\\b(?:email|e_mail|ssn|social_security|passport|credit_card|card_number|phone_number|date_of_birth|dob|national_id|id_card)\\b',
    rationale: 'personal data in logs spreads to systems with weaker access control and longer retention',
    fix: 'log a stable pseudonymous identifier instead of the personal field',
  },
  {
    id: 'no-insecure-transport',
    attributes: ['security'],
    severity: 'warning',
    minimumTier: 'high',
    // Strictly matches ONLY plaintext `http://` or `ws://` (NEVER `https://` or `wss://`!),
    // excluding loopback addresses and XML/SVG namespace URIs.
    forbid: '\\b(?:http|ws):\\/\\/(?!(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\]|www\\.w3\\.org|schemas\\.))([A-Za-z0-9.-]+\\.[A-Za-z]{2,})',
    rationale: 'plaintext http:// or ws:// in high-security modules exposes traffic in transit',
    fix: 'upgrade endpoint URLs to https:// or wss://',
  },
  {
    id: 'no-silent-failure',
    attributes: ['reliability'],
    severity: 'error',
    forbid: 'catch\\s*(?:\\([^)]*\\))?\\s*\\{\\s*\\}|except[^:\\n]*:\\s*(?:pass|\\.\\.\\.)\\s*$',
    rationale: 'an empty handler converts a failure into a wrong answer that nothing reports',
    fix: 'handle the error, rethrow it, or log it with enough context to diagnose',
  },
  {
    id: 'no-unbounded-retry',
    attributes: ['resilience'],
    severity: 'warning',
    forbid: '(?:while\\s*\\(\\s*true\\s*\\)|while\\s+True\\s*:|for\\s*\\(\\s*;\\s*;\\s*\\))[\\s\\S]{0,240}?\\b(?:retry|reconnect|fetch|request|poll)\\b',
    rationale: 'a retry loop with no bound or backoff turns a transient fault into a sustained outage',
    fix: 'add a maximum attempt count and exponential backoff with jitter',
  },
  {
    id: 'no-unreferenced-deferral',
    attributes: ['safety'],
    severity: 'warning',
    minimumTier: 'high',
    forbid: '\\b(?:T\\u004FDO|FIXME|XXX|HACK)\\b(?![^\\n]*\\b(?:issue|ticket|#\\d+)\\b)',
    rationale: 'an unreferenced marker in a high-tier module is work nobody has agreed to do',
    fix: 'link the marker to a tracked issue, or resolve it',
  },
];

function loadFitnessRules(rulesFile) {
  const given = rulesFile !== undefined && rulesFile !== null && rulesFile !== false;
  const refuse = (code, detail, note) => {
    const err = new Error(note);
    err.fitnessRules = { error: code, detail };
    return err;
  };
  if (given && (typeof rulesFile !== 'string' || rulesFile.trim() === '')) {
    throw refuse('rules-file-empty', String(rulesFile), '--rules-file was given without a path; nothing was scanned');
  }
  const fp = given
    ? (path.isAbsolute(rulesFile) ? rulesFile : path.join(projectRoot(), rulesFile))
    : path.join(projectRoot(), '.cac', 'harness', 'fitness-rules.json');
  if (!fs.existsSync(fp)) {
    if (given) throw refuse('rules-file-missing', fp, 'no fitness rules file at ' + fp + '; nothing was scanned');
    return DEFAULT_FITNESS_RULES;
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) {
    if (given) throw refuse('rules-file-unreadable', fp, 'fitness rules file at ' + fp + ' does not parse (' + e.message + '); nothing was scanned');
    return DEFAULT_FITNESS_RULES;
  }
  if (!raw || !Array.isArray(raw.rules)) {
    if (given) throw refuse('rules-file-malformed', fp, 'fitness rules file at ' + fp + ' carries no rules array; nothing was scanned');
    return DEFAULT_FITNESS_RULES;
  }
  const extra = raw.rules.filter((r) => r && typeof r.id === 'string' && typeof r.forbid === 'string');
  if (given && extra.length === 0) {
    throw refuse('rules-file-empty-rules', fp, 'fitness rules file at ' + fp + ' parses to 0 rules; nothing it names was scanned');
  }
  return raw.replace === true ? extra : [...DEFAULT_FITNESS_RULES, ...extra];
}

function meetsMinimumTier(module, rule) {
  if (!module) return false;
  const floor = TIER_RANK[rule.minimumTier] || 0;
  const declared = module.attributes || {};
  return (rule.attributes || []).some((attr) => {
    const req = declared[attr];
    if (req === undefined) return false;
    return (TIER_RANK[normalizeTier(req).tier] || 0) >= floor;
  });
}

function ruleOptedOut(module, rule) {
  if (!module || !(rule.attributes || []).length) return false;
  const declared = module.attributes || {};
  return rule.attributes.every((attr) => {
    const req = declared[attr];
    if (req === undefined) return false;
    return normalizeTier(req).tier === 'none';
  });
}

function scanFitness(files, catalog, rules = DEFAULT_FITNESS_RULES) {
  const findings = [];
  for (const f of files) {
    const owner = catalog ? (() => {
      const id = moduleForPath(f.path, catalog);
      return id ? (catalog.modules || []).find((m) => m.id === id) : null;
    })() : null;
    const normContent = String(f.content || '').replace(/\r\n/g, '\n');
    const lines = normContent.split('\n');
    for (const rule of rules) {
      if (rule.appliesTo && rule.appliesTo.length && !matchAny(f.path, rule.appliesTo)) continue;
      if (owner && ruleOptedOut(owner, rule)) continue;
      if (rule.minimumTier && !meetsMinimumTier(owner, rule)) continue;
      let pattern;
      try { pattern = new RegExp(rule.forbid, 'gmi'); } catch (_e) { continue; }
      let m = pattern.exec(normContent);
      while (m) {
        const line = normContent.slice(0, m.index).split('\n').length;
        const suppressed = (lines[line - 1] || '').includes(FITNESS_IGNORE) || (lines[line - 2] || '').includes(FITNESS_IGNORE);
        if (!suppressed) {
          findings.push({
            rule: rule.id,
            attributes: rule.attributes || [],
            severity: rule.severity || 'warning',
            module: owner ? owner.id : null,
            path: f.path,
            line,
            excerpt: String(lines[line - 1] || '').trim().slice(0, 200),
            rationale: rule.rationale || '',
            fix: rule.fix || '',
          });
        }
        if (m.index === pattern.lastIndex) pattern.lastIndex++;
        m = pattern.exec(normContent);
      }
    }
  }
  return findings;
}

function cmdFitness(flags) {
  const loaded = loadCatalogFlag(flags);
  const catalog = loaded.ok ? loaded.catalog : null;
  let rules;
  try { rules = loadFitnessRules(flags['rules-file']); } catch (e) {
    if (!e || !e.fitnessRules) throw e;
    return emit({ ok: false, degraded: true, error: e.fitnessRules.error, detail: e.fitnessRules.detail, note: e.message }, 3);
  }
  const root = projectRoot();
  let subjects;
  if (typeof flags.paths === 'string') {
    subjects = parseCsv(flags.paths);
  } else if (flags.all === true) {
    if (!isGitRepo(root)) return emit({ ok: false, degraded: true, error: 'non-git', detail: 'fitness --all enumerates tracked files via git' }, 3);
    subjects = trackedFiles(catalog && catalog.maxTrackedPaths).paths;
  } else {
    const cp = changedPaths();
    subjects = Array.isArray(cp) ? cp : cp.paths;
  }
  const files = [];
  for (const p of subjects) {
    const dot = p.lastIndexOf('.');
    const ext = dot >= 0 ? p.slice(dot).toLowerCase() : '';
    if (!SOURCE_EXTS.has(ext)) continue;
    if (isDenied(p) || isStateExcluded(p)) continue;
    let content;
    try {
      const abs = path.join(root, p);
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > 1000000) continue;
      const buf = fs.readFileSync(abs);
      if (buf.includes(0)) continue;
      content = buf.toString('utf8');
    } catch (_e) { continue; }
    files.push({ path: toPosixPath(p), content });
  }
  const findings = scanFitness(files, catalog, rules);
  const errors = findings.filter((f) => f.severity === 'error');
  return emit({
    ok: errors.length === 0,
    scope: flags.all === true ? 'all-tracked' : (typeof flags.paths === 'string' ? 'explicit' : 'changed'),
    scannedFiles: files.length,
    rules: rules.length,
    counts: {
      error: errors.length,
      warning: findings.filter((f) => f.severity === 'warning').length,
      info: findings.filter((f) => f.severity === 'info').length,
    },
    findings: findings.slice(0, 200),
  }, errors.length === 0 ? 0 : 1);
}

// ===========================================================================
// S14 adapters (built-in curated table + optional .cac/harness/adapters.json override)
// ===========================================================================
const DEFAULT_ADAPTERS = [
  { id: 'sast-semgrep', attributes: ['security'], class: 'security', executable: 'semgrep', command: 'semgrep scan --error --quiet --config auto', install: 'https://semgrep.dev/docs/getting-started/', rationale: 'Rule-based SAST that scans in seconds and accepts repository-specific rules.' },
  { id: 'sca-osv-scanner', attributes: ['security'], class: 'security', executable: 'osv-scanner', command: 'osv-scanner scan source --recursive .', install: 'https://google.github.io/osv-scanner/', rationale: 'High-precision dependency scanning against the OSV database.' },
  { id: 'scan-trivy', attributes: ['security'], class: 'security', executable: 'trivy', command: 'trivy fs --exit-code 1 --severity HIGH,CRITICAL .', install: 'https://trivy.dev/latest/getting-started/installation/', rationale: 'Dependencies, container images, IaC, secrets, licences in one binary.' },
  { id: 'secrets-gitleaks', attributes: ['security', 'privacy'], class: 'security', executable: 'gitleaks', command: 'gitleaks detect --no-banner --redact', install: 'https://github.com/gitleaks/gitleaks', rationale: 'History-aware secret detection complementing working-tree fitness rules.' },
  { id: 'sbom-syft', attributes: ['security'], class: 'integrity', executable: 'syft', command: 'syft scan dir:. -o cyclonedx-json=sbom.cdx.json', install: 'https://github.com/anchore/syft', rationale: 'Produces CycloneDX SBOM artifact inventory.' },
  { id: 'pii-presidio', attributes: ['privacy'], class: 'privacy', executable: 'presidio', command: 'presidio analyze --file . --language en', install: 'https://microsoft.github.io/presidio/', rationale: 'Detects personal data in text and structured data.' },
  { id: 'mutation-stryker', attributes: ['reliability'], class: 'test', executable: 'npx', command: 'npx stryker run --incremental', install: 'https://stryker-mutator.io/', rationale: 'Measures whether tests actually catch defects via incremental mutation testing.' },
  { id: 'contract-schemathesis', attributes: ['reliability'], class: 'integration', executable: 'schemathesis', command: 'schemathesis run openapi.yaml --checks all', install: 'https://schemathesis.readthedocs.io/', rationale: 'Generates adversarial API requests from OpenAPI schemas.' },
  { id: 'load-k6', attributes: ['availability', 'performance', 'resilience'], class: 'runtime', executable: 'k6', command: 'k6 run --quiet load/smoke.js', install: 'https://grafana.com/docs/k6/latest/set-up/install-k6/', rationale: 'Asserts latency and error-rate objectives under load.' },
  { id: 'iac-checkov', attributes: ['security', 'availability'], class: 'security', executable: 'checkov', command: 'checkov --directory . --compact --quiet', install: 'https://www.checkov.io/', rationale: 'Detects infrastructure-as-code misconfigurations.' },
  { id: 'slo-openslo', attributes: ['availability', 'reliability'], class: 'static', executable: 'oslo', command: 'oslo validate -f slo/', install: 'https://github.com/OpenSLO/oslo', rationale: 'Validates SLOs declared as code.' },
];

function adaptersFilePath() {
  const local = path.join(projectRoot(), '.cac', 'harness', 'adapters.json');
  if (fs.existsSync(local)) return local;
  return path.join(HARNESS_DIR, 'adapters.json');
}

function loadAdapters() {
  const fp = adaptersFilePath();
  if (fs.existsSync(fp)) {
    try {
      const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (raw && Array.isArray(raw.adapters)) return raw.adapters;
    } catch (_e) { /* fall back to built-ins */ }
  }
  return DEFAULT_ADAPTERS;
}

function cmdAdapters(flags, positional = []) {
  const sub = positional[0] || 'list';
  const catalogue = loadAdapters();
  if (sub === 'list') {
    const want = typeof flags.attribute === 'string' ? flags.attribute : null;
    const loaded = loadCatalogFlag(flags);
    const wiredIds = loaded.ok ? Object.keys(loaded.catalog.checks || {}) : [];
    const list = catalogue
      .filter((a) => !want || (a.attributes || []).includes(want))
      .map((a) => ({
        id: a.id,
        attributes: a.attributes || [],
        class: a.class,
        executable: a.executable,
        available: whichCmd(a.executable),
        wired: wiredIds.includes(a.id),
        install: a.install,
        rationale: a.rationale,
      }));
    return emit({ ok: true, adapters: list }, 0);
  }
  if (sub === 'add') {
    const id = positional[1] || (typeof flags.id === 'string' ? flags.id : '');
    const adapter = catalogue.find((a) => a.id === id);
    if (!adapter) return emit({ ok: false, error: 'adapter-unknown', detail: id || null }, 1);
    const cp = typeof flags.catalog === 'string' ? flags.catalog : catalogFilePath();
    const loaded = loadCatalog(cp);
    if (!loaded.ok) return emit({ ok: false, degraded: true, error: loaded.error, detail: loaded.detail }, 3);
    const catalog = loaded.catalog;
    catalog.checks = catalog.checks || {};
    const already = !!catalog.checks[adapter.id];
    catalog.checks[adapter.id] = {
      command: adapter.command,
      class: adapter.class,
      ...(Array.isArray(adapter.attributes) ? { attributes: adapter.attributes } : {}),
    };
    if (flags['dry-run'] !== true && flags.dryRun !== true) {
      fs.writeFileSync(cp, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
    }
    return emit({
      ok: true,
      id: adapter.id,
      changed: !already,
      dryRun: flags['dry-run'] === true || flags.dryRun === true,
      executableAvailable: whichCmd(adapter.executable),
      install: adapter.install,
      nextStep: 'add "' + adapter.id + '" to the verification list of every module that needs ' + (adapter.attributes || []).join('/') + ' evidence',
    }, 0);
  }
  return emit({ error: 'adapters-subcommand', detail: 'usage: adapters list|add <id>', got: sub || null }, 3);
}

// ===========================================================================
// S15 adr-check
// ===========================================================================
const ADR_RETIRED_RE = /superseded|deprecated|rejected|retired|\u5df2\u5e9f\u5f03|\u5e9f\u5f03|\u5df2\u53d6\u4ee3|\u5df2\u5426\u51b3|\u5df2\u66ff\u4ee3/i;
const ADR_ONEWAY_RE = /\u5355\u5411\u95e8|one-?way\s*door/i;
const ADR_REVISIT_VAGUE_RE = /(\u4ee5\u540e\u518d|\u4e4b\u540e\u518d|\u518d\u770b|\u518d\u8bf4|\u518d\u8bae|\u5230\u65f6\u5019|\u89c6\u60c5\u51b5|\u770b\u60c5\u51b5|\u914c\u60c5|\u6301\u7eed\u5173\u6ce8|\u4fdd\u6301\u5173\u6ce8|\u5b9a\u671f(\u8bc4\u5ba1|\u56de\u987e|\u68c0\u67e5|\u590d\u76d8)|\u5f85\u5b9a|TBD|later|as needed|periodically|keep an eye)/i;
const ADR_REVISIT_STALE_RE = /(\u4e2a\u6708|\u4e2a\u661f\u671f|\u661f\u671f|\u5468|\u5b63\u5ea6|\u5e74|\u5929)(\u4e4b|\u4ee5)?\u540e(\s*$|[\s\uff0c,\u3001;\uff1b]*(\u518d\u770b|\u518d\u8bf4|\u518d\u8bae|\u518d\u5b9a|\u518d\u8bc4\u4f30|\u518d\u8ba8\u8bba|\u518d\u51b3\u5b9a|\u518d\u786e\u8ba4|\u91cd\u65b0\u8bc4\u4f30|\u91cd\u65b0\u8bc4\u5ba1|\u91cd\u65b0\u5ba1\u89c6|\u91cd\u65b0\u8003\u8651|\u91cd\u65b0\u8ba8\u8bba|\u91cd\u4f30|\u56de\u987e|\u590d\u76d8|\u590d\u5ba1|revisit|re-?evaluate|reassess|review))/i;
const ADR_REVISIT_CONDITION_RE = /(\u8d85\u8fc7|\u8d85\u51fa|\u5927\u4e8e|\u5c0f\u4e8e|\u4f4e\u4e8e|\u9ad8\u4e8e|\u8fbe\u5230|\u4e0d\u8db3|\u4e0d\u518d|\u4e00\u65e6|\u5982\u679c|\u82e5|\u5f53|\u9700\u8981|\u8981\u6c42|\u51fa\u73b0|\u65b0\u589e|\u5f15\u5165|\u63a5\u5165|\u5207\u6362|\u6362\u6210|\u505c\u6b62\u7ef4\u62a4|\u505c\u670d|\u4e0b\u7ebf|\u4e0a\u7ebf|\u5931\u8d25|\u53d1\u751f|\u5230\u671f|\u671f\u6ee1|\u8fc7\u671f|>|<|\u2265|\u2264|exceed|more than|over |when |if |need|require|reach|drop|stop|EOL|deprecat)/i;
const ADR_MANUAL_RE = /\u4eba\u5de5|\u8bc4\u5ba1|manual|review/i;
const ADR_HARNESS_CAPS = ['arch-check', 'forbiddendependencies', 'layers', 'catalog-lint', 'fitness', 'verify', 'receipt', 'attributes', 'stop-gate', 'pre-commit', 'supervisor', 'arch-trend'];

function stripMdDecoration(s) {
  return String(s == null ? '' : s).replace(/\*\*|`|\[|\]/g, '').trim();
}

function adrField(block, labels) {
  for (const label of labels) {
    const re = new RegExp('(?:^|\\n)\\s*[-*]?\\s*(?:\\*\\*)?' + label + '(?:\\*\\*)?\\s*[:\\uFF1A]\\s*([^\\n]+)', 'i');
    const m = re.exec(block);
    if (m) return stripMdDecoration(m[1]);
  }
  return '';
}

function parseInlineAdrs(content) {
  const text = String(content == null ? '' : content).replace(/\r\n?/g, '\n');
  const out = [];
  const heading = /^###\s*(ADR-[A-Za-z0-9._-]+)\s*[:\uFF1A]?\s*(.*)$/gm;
  const starts = [];
  let m = heading.exec(text);
  while (m) {
    starts.push({ id: m[1], title: stripMdDecoration(m[2]), at: m.index, bodyFrom: m.index + m[0].length });
    m = heading.exec(text);
  }
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i].bodyFrom;
    const nextHeading = text.slice(from).search(/\n#{1,3}\s/);
    const block = nextHeading === -1 ? text.slice(from) : text.slice(from, from + nextHeading);
    out.push({
      id: starts[i].id,
      title: starts[i].title,
      status: adrField(block, ['\u72b6\u6001', 'Status']) || 'accepted',
      enforcedRaw: adrField(block, ['\u6267\u6cd5\u65b9\u5f0f', 'Enforced-by', 'Enforced by']),
      revisitRaw: adrField(block, ['revisit-if', 'revisit if', '\u5931\u6548\u6761\u4ef6', '\u91cd\u65b0\u8bc4\u4f30\u6761\u4ef6']),
      reversalRaw: adrField(block, ['reversal', '\u64a4\u56de\u4ee3\u4ef7', '\u64a4\u56de\u6210\u672c']),
    });
  }
  return out;
}

function resolveEnforcement(fragment, knownChecks, knownRules) {
  const f = stripMdDecoration(fragment);
  if (!f) return null;
  const lower = f.toLowerCase();
  let best = null;
  const consider = (kind, id) => {
    if (!id) return;
    if (lower.includes(String(id).toLowerCase())) {
      if (!best || String(id).length > String(best.id).length) best = { kind, id: String(id), text: f };
    }
  };
  for (const id of (knownChecks || [])) consider('check', id);
  for (const id of (knownRules || [])) consider('fitness-rule', id);
  for (const cap of ADR_HARNESS_CAPS) consider('harness', cap);
  if (best) return best;
  if (ADR_MANUAL_RE.test(f)) return { kind: 'manual', text: f };
  return { kind: 'unknown', text: f };
}

function assessAdrRecords(records, knownChecks, knownRules) {
  const out = [];
  for (const r of (records || [])) {
    const retired = ADR_RETIRED_RE.test(String(r.status || ''));
    const fragments = String(r.enforcedRaw || '').split(/[,\uFF0C\u3001;\uFF1B/]+/).map((s) => s.trim()).filter(Boolean);
    const resolved = fragments.map((f) => resolveEnforcement(f, knownChecks, knownRules)).filter(Boolean);
    const machine = resolved.filter((t) => t.kind === 'check' || t.kind === 'fitness-rule' || t.kind === 'harness');
    const manual = resolved.filter((t) => t.kind === 'manual');
    const unknown = resolved.filter((t) => t.kind === 'unknown');
    const recognized = machine.length + manual.length;
    const revisit = stripMdDecoration(r.revisitRaw || '');
    const reversal = stripMdDecoration(r.reversalRaw || '');
    const oneWayDoor = !retired && ADR_ONEWAY_RE.test(reversal);
    const problems = [];
    if (!retired) {
      if (recognized === 0 && fragments.length === 0) problems.push('no enforcement declared (\u6267\u6cd5\u65b9\u5f0f/Enforced-by missing)');
      else if (recognized === 0) problems.push('names nothing recognizable (phantom reference reads as enforced but is not)');
      if (!revisit) problems.push('no expiry condition declared (revisit-if/\u5931\u6548\u6761\u4ef6 missing)');
      else if ((ADR_REVISIT_VAGUE_RE.test(revisit) || ADR_REVISIT_STALE_RE.test(revisit)) && !ADR_REVISIT_CONDITION_RE.test(revisit)) {
        problems.push('revisit-if is a date or a wait-and-see note, not a condition ("' + revisit + '")');
      }
      if (!reversal) problems.push('no reversal cost declared (reversal/\u64a4\u56de\u4ee3\u4ef7 missing; write the steps and rough duration, or declare \u5355\u5411\u95e8)');
    }
    const ok = retired || problems.length === 0;
    out.push({
      id: r.id,
      title: r.title || null,
      source: r.source || null,
      status: r.status || 'accepted',
      retired,
      ok,
      machineEnforced: machine.map((t) => ({ kind: t.kind, id: t.id })),
      manualOnly: !retired && machine.length === 0 && manual.length > 0,
      unrecognized: unknown.map((t) => t.text),
      oneWayDoor,
      revisit: revisit || null,
      reversal: reversal || null,
      reason: retired
        ? 'retired; exempt'
        : problems.length > 0
          ? problems.join('; ')
          : machine.length > 0
            ? 'machine-enforced'
            : 'manual enforcement declared',
    });
  }
  return { records: out, failing: out.filter((r) => !r.ok) };
}

function parseAdrDir(root, dir) {
  const abs = path.resolve(root, dir);
  let names;
  try { names = fs.readdirSync(abs); } catch (_e) { return []; }
  const out = [];
  for (const n of names.sort()) {
    if (!n.endsWith('.md')) continue;
    let content;
    try { content = fs.readFileSync(path.join(abs, n), 'utf8'); } catch (_e) { continue; }
    out.push({
      id: n.replace(/\.md$/, ''),
      source: repoRelative(path.join(abs, n)),
      status: adrField(content, ['\u72b6\u6001', 'Status']) || 'accepted',
      enforcedRaw: adrField(content, ['\u6267\u6cd5\u65b9\u5f0f', 'Enforced-by', 'Enforced by']),
      revisitRaw: adrField(content, ['revisit-if', 'revisit if', '\u5931\u6548\u6761\u4ef6', '\u91cd\u65b0\u8bc4\u4f30\u6761\u4ef6']),
      reversalRaw: adrField(content, ['reversal', '\u64a4\u56de\u4ee3\u4ef7', '\u64a4\u56de\u6210\u672c']),
    });
  }
  return out;
}

function cmdAdrCheck(flags) {
  const root = projectRoot();
  const file = typeof flags.file === 'string' ? flags.file : 'Architecture-Design.md';
  const dir = typeof flags.dir === 'string' ? flags.dir : 'docs/adr';
  const records = [];
  const filePath = path.resolve(root, file);
  const fileName = repoRelative(filePath);
  const dirName = repoRelative(path.resolve(root, dir));
  if (fs.existsSync(filePath)) {
    let content = '';
    try { content = fs.readFileSync(filePath, 'utf8'); } catch (_e) { /* unreadable */ }
    for (const r of parseInlineAdrs(content)) records.push({ ...r, source: fileName });
  }
  for (const r of parseAdrDir(root, dir)) records.push(r);
  if (records.length === 0) {
    return emit({ ok: true, records: 0, note: 'no ADR records found (' + fileName + ' / ' + dirName + '); nothing to enforce' }, 0);
  }
  const loaded = loadCatalogFlag(flags);
  const knownChecks = loaded.ok ? Object.keys(loaded.catalog.checks || {}) : [];
  const knownRules = loadFitnessRules().map((r) => r.id);
  const assessed = assessAdrRecords(records, knownChecks, knownRules);
  return emit({
    ok: assessed.failing.length === 0,
    records: assessed.records.length,
    machineEnforced: assessed.records.filter((r) => r.ok && !r.retired && !r.manualOnly).length,
    manualOnly: assessed.records.filter((r) => r.manualOnly).map((r) => r.id),
    retired: assessed.records.filter((r) => r.retired).map((r) => r.id),
    oneWayDoors: assessed.records.filter((r) => r.oneWayDoor).map((r) => ({ id: r.id, title: r.title, source: r.source, reversal: r.reversal })),
    failing: assessed.failing.map((r) => ({ id: r.id, title: r.title, source: r.source, reason: r.reason, unrecognized: r.unrecognized })),
    details: assessed.records,
  }, assessed.failing.length === 0 ? 0 : 1);
}

export {
  FITNESS_IGNORE, DEFAULT_FITNESS_RULES, loadFitnessRules, meetsMinimumTier, ruleOptedOut,
  scanFitness, cmdFitness,
  DEFAULT_ADAPTERS, adaptersFilePath, loadAdapters, cmdAdapters,
  parseInlineAdrs, resolveEnforcement, assessAdrRecords, parseAdrDir, cmdAdrCheck,
};
