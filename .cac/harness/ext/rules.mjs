// ext/rules.mjs — S22 `rules-audit`, S23 `skills-lint`, and S24 `agents-md-lint` (directory constitutions).
// Depends on ../lib/core.mjs and ./catalog.mjs.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { emit, isGitRepo, projectRoot, toPosixPath } from '../lib/core.mjs';
import { loadCatalogFlag } from './catalog.mjs';

// ===========================================================================
// S22.1 rules-audit
// ===========================================================================
const RULES_DOC = 'AGENTS.md';
const RULES_DIR = '.cac/rules';

const POINT_DIRS = [
  '.cac/hooks',
  '.cac/scripts',
  '.cac/tests',
  '.cac/harness',
  'scripts',
];
const POINT_EXTS = ['.sh', '.ps1', '.mjs'];
const WALK_DEPTH = 4;

const PROMPT_MARKERS = ['prompt-only', '\u9760\u81ea\u89c9', '(P)', '[P]'];
const NEGATIONS = ['\u4e0d', '\u975e'];
const RUNNERS = ['node', 'bash', 'sh', 'pwsh', 'powershell'];

const TEXT_BUDGET = 90;
const DEFAULT_LIMIT = 100;

function ruleLineText(line) {
  const raw = String(line);
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let body = null;
  if (/^[-*\u2022\u00b7]\s+/.test(trimmed)) body = trimmed.replace(/^[-*\u2022\u00b7]\s+/, '');
  else if (/^\d+[.)]\s+/.test(trimmed)) body = trimmed.replace(/^\d+[.)]\s+/, '');
  else if (trimmed.startsWith('|')) {
    const cells = trimmed.split('|').map((c) => c.trim()).filter((c) => c.length > 0);
    if (cells.length === 0) return null;
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) return null;
    body = cells.join(' | ');
  }
  if (body === null) return null;
  const bare = body.replace(/[*`_~#>\s]/g, '');
  if (bare.length < 4) return null;
  return body;
}

function leadingBoldToken(line) {
  const m = /^\*\*([^*]+)\*\*/.exec(String(line).trim());
  if (!m) return null;
  const t = m[1].trim();
  return t || null;
}

function backtickTokens(line) {
  const out = [];
  const re = /`([^`]*)`/g;
  let m;
  while ((m = re.exec(String(line))) !== null) {
    const t = m[1].trim();
    if (t) out.push(t);
  }
  return out;
}

function admitsPromptOnly(line) {
  const s = String(line);
  return PROMPT_MARKERS.some((mk) => {
    let from = 0;
    for (;;) {
      const i = s.indexOf(mk, from);
      if (i < 0) return false;
      if (!NEGATIONS.includes(s.slice(Math.max(0, i - 1), i))) return true;
      from = i + 1;
    }
  });
}

function collectPoints(subcommands, root = projectRoot()) {
  const files = new Set();
  const basenames = new Set();
  const counts = {};
  for (const dir of POINT_DIRS) {
    const rel = toPosixPath(dir);
    const before = files.size;
    walkPoints(path.join(root, dir), rel, files, basenames, WALK_DEPTH);
    counts[rel] = files.size - before;
  }
  for (const top of ['setup.sh', 'setup.ps1']) {
    if (fs.existsSync(path.join(root, top))) {
      files.add(top);
      basenames.add(top);
    }
  }
  return {
    subcommands: new Set(subcommands || []),
    files,
    basenames,
    counts: { subcommands: (subcommands || []).length, ...counts },
  };
}

function walkPoints(abs, rel, files, basenames, depth) {
  if (depth < 0) return;
  let entries = [];
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (_e) { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) {
      walkPoints(path.join(abs, e.name), rel + '/' + e.name, files, basenames, depth - 1);
      continue;
    }
    if (!POINT_EXTS.includes(path.extname(e.name))) continue;
    files.add(rel + '/' + e.name);
    basenames.add(e.name);
  }
}

function isUnresolvable(word) {
  return word.includes('<') || word.includes('>') || word.includes('*') || word.includes('?')
    || word.includes('{') || word.includes('}');
}

function looksExecutable(word) {
  const norm = toPosixPath(word);
  const ext = path.extname(norm);
  if (!POINT_EXTS.includes(ext)) return false;
  if (norm.startsWith('.cac/') || norm.includes('/.cac/') || norm.startsWith('scripts/')) return true;
  if (norm === 'setup.sh' || norm === 'setup.ps1') return true;
  if (ext === '.sh' || ext === '.ps1') return true;
  return false;
}

function normalizeWord(word) {
  let w = toPosixPath(word);
  if (w.includes('|')) w = w.slice(0, w.indexOf('|'));
  w = w.replace(/:\d+(-\d+)?$/, '');
  w = w.replace(/^["'(\[]+/, '').replace(/["')\].,;]+$/, '');
  return w;
}

function classifyToken(token, points) {
  const t = String(token).trim();
  if (!t) return { kind: 'none' };

  const inv = /harness\.mjs\s+([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(t);
  if (inv) {
    const word = inv[1];
    if (points.subcommands.has(word)) return { kind: 'machine', target: word, reason: 'subcommand' };
    return { kind: 'phantom', target: word, reason: 'no such harness subcommand' };
  }

  let head = t;
  for (const r of RUNNERS) {
    if (head.startsWith(r + ' ')) { head = head.slice(r.length + 1).trim(); break; }
  }
  head = head.split(/\s+/)[0] || '';
  head = normalizeWord(head);
  if (!head || isUnresolvable(head)) return { kind: 'none' };

  if (points.subcommands.has(head)) return { kind: 'machine', target: head, reason: 'subcommand' };

  const rel = head.replace(/^\.\//, '');
  if (!rel.includes('/') && POINT_EXTS.includes(path.extname(rel)) && points.basenames.has(rel)) {
    return { kind: 'machine', target: rel, reason: 'file' };
  }
  if (!looksExecutable(rel)) return { kind: 'none' };
  if (points.files.has(rel)) return { kind: 'machine', target: rel, reason: 'file' };
  if (!rel.includes('/') && points.basenames.has(rel)) {
    return { kind: 'machine', target: rel, reason: 'file' };
  }
  return { kind: 'phantom', target: rel, reason: 'no such file' };
}

function classifyRuleLine(text, points) {
  const tokens = backtickTokens(text);
  const machine = [];
  const phantom = [];
  for (const tok of tokens) {
    const r = classifyToken(tok, points);
    if (r.kind === 'machine') machine.push({ token: tok, target: r.target, reason: r.reason });
    else if (r.kind === 'phantom') phantom.push({ token: tok, target: r.target, reason: r.reason });
  }
  const bold = leadingBoldToken(text);
  if (bold) {
    const r = classifyToken(bold, points);
    if (r.kind === 'machine') machine.push({ token: bold, target: r.target, reason: r.reason });
  }
  let klass;
  if (phantom.length > 0) klass = 'phantom';
  else if (machine.length > 0) klass = 'machine';
  else if (admitsPromptOnly(text)) klass = 'prompt';
  else klass = 'unclassified';
  return { klass, machine, phantom };
}

function ruleDocs(root = projectRoot()) {
  const docs = [];
  const main = path.join(root, RULES_DOC);
  if (fs.existsSync(main)) docs.push(RULES_DOC);
  const dir = path.join(root, RULES_DIR);
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_e) { names = []; }
  for (const name of names.filter((n) => n.endsWith('.md')).sort()) {
    docs.push('.cac/rules/' + name);
  }
  return docs;
}

function clip(text, budget = TEXT_BUDGET) {
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length <= budget ? s : s.slice(0, budget) + '...';
}

function auditDoc(rel, content, points) {
  const lines = String(content).replace(/^\uFEFF/, '').split(/\r?\n/);
  const rules = [];
  let fenced = false;
  let startLine = 0;
  // Skip YAML frontmatter block if opened on line 1
  if (lines[0] === '---') {
    const endFm = lines.indexOf('---', 1);
    if (endFm > 0) startLine = endFm + 1;
  }
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const text = ruleLineText(line);
    if (text === null) continue;
    const c = classifyRuleLine(text, points);
    rules.push({ at: rel + ':' + (i + 1), klass: c.klass, text, machine: c.machine, phantom: c.phantom });
  }
  return rules;
}

function tally(rules) {
  const counts = { machine: 0, prompt: 0, phantom: 0, unclassified: 0 };
  for (const r of rules) counts[r.klass]++;
  const total = rules.length;
  const ratio = {};
  for (const k of Object.keys(counts)) {
    ratio[k] = total === 0 ? 0 : Math.round((counts[k] / total) * 1000) / 1000;
  }
  return { total, counts, ratio };
}

function positiveInt(v, fallback) {
  if (typeof v !== 'string') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function cmdRulesAudit(flags = {}, subcommands = []) {
  const root = projectRoot();
  const docs = ruleDocs(root);
  if (docs.length === 0) {
    const note = 'no rule documents found (' + RULES_DOC + ' / ' + RULES_DIR
      + '); there is no constitution to audit, which is not the same as a clean one';
    process.stderr.write(note + '\n');
    return emit({ ok: false, degraded: true, error: 'no-rules', files: [], note }, 3);
  }
  const points = collectPoints(subcommands, root);
  const limit = positiveInt(flags.limit, DEFAULT_LIMIT);
  const rules = [];
  const perFile = [];
  const unreadable = [];
  for (const rel of docs) {
    let content = '';
    try {
      content = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch (e) {
      unreadable.push({ file: rel, error: String(e && e.message ? e.message : e) });
      continue;
    }
    const found = auditDoc(rel, content, points);
    perFile.push({ file: rel, ...tally(found) });
    for (const r of found) rules.push(r);
  }
  const overall = tally(rules);
  const unclassified = rules.filter((r) => r.klass === 'unclassified');
  const phantomRules = rules.filter((r) => r.klass === 'phantom');

  for (const r of phantomRules) {
    for (const p of r.phantom) {
      process.stderr.write('PHANTOM ' + r.at + '  `' + p.token + '` -> ' + p.reason + '\n');
    }
  }
  process.stderr.write('rules ' + overall.total
    + '  machine ' + overall.counts.machine + ' (' + overall.ratio.machine + ')'
    + '  prompt ' + overall.counts.prompt + ' (' + overall.ratio.prompt + ')'
    + '  phantom ' + overall.counts.phantom
    + '  unclassified ' + overall.counts.unclassified + ' (' + overall.ratio.unclassified + ')\n');

  return emit({
    ok: phantomRules.length === 0,
    files: perFile,
    unreadable,
    enforcementPoints: points.counts,
    rules: overall.total,
    counts: overall.counts,
    ratio: overall.ratio,
    phantom: phantomRules.slice(0, limit).map((r) => ({
      at: r.at,
      tokens: r.phantom.map((p) => ({ token: p.token, target: p.target, reason: p.reason })),
      text: clip(r.text),
    })),
    phantomOmitted: Math.max(0, phantomRules.length - limit),
    unclassified: unclassified.slice(0, limit).map((r) => ({ at: r.at, text: clip(r.text) })),
    unclassifiedOmitted: Math.max(0, unclassified.length - limit),
    note: phantomRules.length === 0
      ? 'no phantom reference; the unclassified count is a worklist for a human, not a gate'
      : 'a rule names an enforcement point that does not exist; it reads as enforced and is not',
  }, phantomRules.length === 0 ? 0 : 1);
}

// ===========================================================================
// S23 skills-lint
// ===========================================================================
const SKILLS_DIR = '.cac/skills';
const SKILL_FILE = 'SKILL.md';
const DESCRIPTION_BUDGET = 180;

const TRIGGER_RES = [/\u5f53.*?\u65f6/, /\u7531.*?\u8c03\u7528/, /\bwhen\b/i, /\buse when\b/i];
const SUMMARY_TOKENS = ['\u751f\u6210', '\u901a\u8fc7', '\u5206\u9636\u6bb5', '\u8f93\u51fa', '\u652f\u6301', '\u6267\u884c', '\u5185\u7f6e', '\u7ef4\u62a4'];

function isTriggerShaped(description) {
  return TRIGGER_RES.some((re) => re.test(description))
    || description.startsWith('\u5f53') || description.startsWith('\u7531');
}

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const BOOLEAN_KEYS = ['disable-model-invocation', 'user-invocable'];
const FM_KEY_RE = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*:(?:\s+(.*))?$/;
const BLOCK_SCALAR_RE = /^[|>][+-]?[0-9]*$/;

function closingQuote(s, ch) {
  for (let i = 1; i < s.length; i++) {
    const c = s.charAt(i);
    if (ch === '"') {
      if (c === '\\') { i++; continue; }
      if (c === '"') return i + 1;
    } else if (c === "'") {
      if (s.charAt(i + 1) === "'") { i++; continue; }
      return i + 1;
    }
  }
  return -1;
}

function scalarValue(raw, n) {
  const v = String(raw);
  if (v === '') return { kind: 'ok', value: '', quoted: false, raw: v };
  const ch = v.charAt(0);
  if (ch === '"' || ch === "'") {
    const close = closingQuote(v, ch);
    if (close < 0) {
      return { kind: 'undecidable', reason: 'line ' + n + ' opens a quoted value that does not close on the same line' };
    }
    const rest = v.slice(close).trim();
    if (rest !== '' && !rest.startsWith('#')) {
      return { kind: 'error', reason: 'line ' + n + ' has text after the closing quote: ' + clip(rest, 40) };
    }
    const inner = v.slice(1, close - 1);
    return { kind: 'ok', quoted: true, raw: v, value: ch === '"' ? inner.replace(/\\"/g, '"') : inner.replace(/''/g, "'") };
  }
  if (BLOCK_SCALAR_RE.test(v)) {
    return { kind: 'undecidable', reason: 'line ' + n + ' opens a block scalar; outside the decidable subset' };
  }
  if (ch === '{' || ch === '[') {
    return { kind: 'undecidable', reason: 'line ' + n + ' uses a flow collection; outside the decidable subset' };
  }
  if (ch === '&' || ch === '*' || ch === '!') {
    return { kind: 'undecidable', reason: 'line ' + n + ' uses an anchor, alias or tag; outside the decidable subset' };
  }
  if (/^[@`%]/.test(v)) {
    return { kind: 'error', reason: 'line ' + n + ' starts a plain value with reserved indicator ' + ch };
  }
  if (/^-(\s|$)/.test(v)) {
    return { kind: 'error', reason: 'line ' + n + ' starts a plain value with "- ", which YAML reads as a sequence entry' };
  }
  if (/^[|>]/.test(v)) {
    return { kind: 'error', reason: 'line ' + n + ' has a malformed block scalar header' };
  }
  if (/:(\s|$)/.test(v)) {
    return { kind: 'error', reason: 'line ' + n + ' puts ": " inside a plain value; quote the value: ' + clip(v, 40) };
  }
  return { kind: 'ok', value: v, quoted: false, raw: v };
}

function parseFrontmatter(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split('\n').map((l) => l.replace(/\r$/, ''));
  if (lines[0] !== '---') {
    return { kind: 'error', code: 'NO_FRONTMATTER', line: 1, reason: 'the file does not open with "---"' };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { end = i; break; }
  }
  if (end < 0) {
    return { kind: 'error', code: 'UNTERMINATED_FRONTMATTER', line: 1, reason: 'the frontmatter block opened on line 1 is never closed by "---"' };
  }
  const fields = {};
  let count = 0;
  for (let i = 1; i < end; i++) {
    const raw = lines[i];
    const n = i + 1;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (/^[ \t]/.test(raw)) {
      return { kind: 'undecidable', line: n, reason: 'line ' + n + ' is indented; nested maps/lists are outside the decidable subset' };
    }
    const m = FM_KEY_RE.exec(raw);
    if (!m) {
      return { kind: 'error', code: 'MALFORMED_LINE', line: n, reason: 'line ' + n + ' is not a "key: value" pair: ' + clip(trimmed, 40) };
    }
    const res = scalarValue(String(m[2] === undefined ? '' : m[2]).trim(), n);
    if (res.kind === 'error') return { kind: 'error', code: 'MALFORMED_VALUE', line: n, reason: res.reason };
    if (res.kind === 'undecidable') return { kind: 'undecidable', line: n, reason: res.reason };
    count++;
    fields[m[1]] = { value: res.value, quoted: !!res.quoted, raw: res.raw, line: n };
  }
  if (count === 0) {
    return { kind: 'error', code: 'EMPTY_FRONTMATTER', line: 1, reason: 'the frontmatter block holds no keys' };
  }
  return { kind: 'ok', fields };
}

function lintSkillFile(dirName, relFile, text) {
  const findings = [];
  const undecidable = [];
  const parsed = parseFrontmatter(text);
  if (parsed.kind === 'undecidable') {
    undecidable.push({ at: relFile + ':' + parsed.line, reason: parsed.reason });
    return { findings, undecidable, name: null, descriptionChars: null };
  }
  if (parsed.kind === 'error') {
    findings.push({ at: relFile + ':' + parsed.line, code: parsed.code, detail: parsed.reason });
    return { findings, undecidable, name: null, descriptionChars: null };
  }
  const fields = parsed.fields;
  const at = (f) => relFile + ':' + (f ? f.line : 1);

  const nameField = fields.name;
  const name = nameField ? String(nameField.value).trim() : '';
  if (!name) {
    findings.push({ at: at(nameField), code: 'MISSING_NAME', detail: 'no name in the frontmatter' });
  } else if (!NAME_RE.test(name)) {
    findings.push({ at: at(nameField), code: 'BAD_NAME', detail: 'name "' + clip(name, 40) + '" is not kebab-case' });
  } else if (name !== dirName) {
    findings.push({ at: at(nameField), code: 'NAME_MISMATCH', detail: 'name "' + name + '" does not match directory "' + dirName + '"' });
  }

  const descField = fields.description;
  const description = descField ? String(descField.value).trim() : '';
  let descriptionChars = null;
  if (!description) {
    findings.push({ at: at(descField), code: 'MISSING_DESCRIPTION', detail: 'no description in the frontmatter' });
  } else {
    descriptionChars = Array.from(description).length;
    if (descriptionChars > DESCRIPTION_BUDGET) {
      findings.push({ at: at(descField), code: 'LONG_DESCRIPTION', detail: 'description is ' + descriptionChars + ' characters, over the budget of ' + DESCRIPTION_BUDGET });
    }
    if (!isTriggerShaped(description)) {
      const hits = SUMMARY_TOKENS.filter((t) => description.includes(t));
      findings.push({
        at: at(descField), code: 'DESCRIPTION_NOT_TRIGGER_SHAPED',
        detail: 'description states no trigger condition (\u5f53\u2026\u65f6 / \u7531\u2026\u8c03\u7528)'
          + (hits.length ? '; summary tokens: ' + hits.join(', ') : ''),
      });
    }
  }

  for (const key of BOOLEAN_KEYS) {
    const f = fields[key];
    if (!f) continue;
    const v = String(f.value);
    if (f.quoted || (v !== 'true' && v !== 'false')) {
      findings.push({
        at: at(f), code: 'STRING_BOOLEAN',
        detail: key + ' is ' + (f.quoted ? 'a quoted string' : 'not a bare true/false') + ' (' + clip(String(f.raw), 30) + ')',
      });
    }
  }

  return { findings, undecidable, name: name || null, descriptionChars };
}

function errText(e) {
  return String((e && e.code) || (e && e.message) || e);
}

function scanSkills(root = projectRoot()) {
  const rel = toPosixPath(SKILLS_DIR);
  const abs = path.join(root, SKILLS_DIR);
  const out = { dir: rel, present: false, listed: 0, inScope: 0, skills: [], findings: [], undecidable: [], unreadable: [] };
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch (e) {
    if (e && e.code === 'ENOENT') return out;
    out.present = true;
    out.unreadable.push({ at: rel, reason: 'the skills directory could not be listed: ' + errText(e) });
    return out;
  }
  out.present = true;
  const names = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();
  for (const dirName of names) {
    out.listed++;
    const relFile = rel + '/' + dirName + '/' + SKILL_FILE;
    let text;
    try {
      text = fs.readFileSync(path.join(abs, dirName, SKILL_FILE), 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') continue;
      out.unreadable.push({ at: relFile, reason: 'the file could not be read: ' + errText(e) });
      continue;
    }
    out.inScope++;
    const r = lintSkillFile(dirName, relFile, text);
    for (const f of r.findings) out.findings.push(f);
    for (const u of r.undecidable) out.undecidable.push(u);
    out.skills.push({ dir: dirName, file: relFile, name: r.name, descriptionChars: r.descriptionChars });
  }

  const byName = new Map();
  for (const s of out.skills) {
    if (!s.name) continue;
    if (!byName.has(s.name)) byName.set(s.name, []);
    byName.get(s.name).push(s);
  }
  for (const [name, group] of byName) {
    if (group.length < 2) continue;
    const dirs = group.map((s) => s.dir).join(', ');
    for (const s of group) {
      out.findings.push({ at: s.file + ':1', code: 'DUPLICATE_NAME', detail: 'name "' + name + '" is claimed by ' + group.length + ' skills (' + dirs + ')' });
    }
  }
  return out;
}

function skillsNote(r) {
  if (!r.present) return 'no skills directory (' + r.dir + '); a checkout without skills is a normal state, not a failure';
  if (r.unreadable.length > 0) return 'part of the scope could not be read; not checked is not the same as clean';
  if (r.inScope === 0) return 'nothing-in-scope:listed=' + r.listed + ' in-scope=0 (no ' + SKILL_FILE + ' under ' + r.dir + ')';
  if (r.findings.length > 0) return 'a skill whose frontmatter reads like this is dropped or misrouted by the loader';
  if (r.undecidable.length > 0) return 'a frontmatter shape outside the decidable subset was not ruled on';
  return 'every ' + SKILL_FILE + ' frontmatter parses, names itself after its directory and stays inside the description budget';
}

function cmdSkillsLint(flags = {}) {
  const r = scanSkills(projectRoot());
  const limit = positiveInt(flags.limit, DEFAULT_LIMIT);
  for (const f of r.findings.slice(0, limit)) {
    process.stderr.write('SKILL ' + f.at + '  ' + f.code + '  ' + f.detail + '\n');
  }
  for (const u of r.undecidable) process.stderr.write('UNDECIDABLE ' + u.at + '  ' + u.reason + '\n');
  for (const u of r.unreadable) process.stderr.write('UNREADABLE ' + u.at + '  ' + u.reason + '\n');
  const degraded = r.undecidable.length + r.unreadable.length > 0;
  const code = r.findings.length > 0 ? 1 : (degraded ? 3 : 0);
  return emit({
    ok: r.findings.length === 0 && !degraded,
    dir: r.dir,
    skillsDirPresent: r.present,
    listed: r.listed,
    inScope: r.inScope,
    degraded,
    skills: r.skills.slice(0, limit),
    skillsOmitted: Math.max(0, r.skills.length - limit),
    findings: r.findings.slice(0, limit),
    findingsOmitted: Math.max(0, r.findings.length - limit),
    undecidable: r.undecidable,
    unreadable: r.unreadable,
    descriptionBudget: DESCRIPTION_BUDGET,
    note: skillsNote(r),
  }, code);
}

// ===========================================================================
// S24 agents-md-lint (directory constitution for high/critical riskTier modules)
// ===========================================================================
const AGENTS_MD_FILE = 'AGENTS.md';
const SCOPED_RISK_TIERS = ['high', 'critical'];

const AGENTS_MD_SECTIONS = [
  { id: 'purpose', label: 'Purpose', en: 'purpose', zh: '\u76ee\u7684' },
  { id: 'boundaries', label: 'Boundaries', en: 'boundaries', zh: '\u8fb9\u754c' },
  { id: 'invariants', label: 'Invariants', en: 'invariants', zh: '\u4e0d\u53d8\u91cf' },
  { id: 'verification', label: 'Verification', en: 'verification', zh: '\u9a8c\u8bc1' },
];

const GLOB_CHARS = /[*?[\]{}]/;

function literalDirSegments(glob) {
  let raw = String(glob === undefined || glob === null ? '' : glob).trim();
  if (raw.startsWith('./')) raw = raw.slice(2);
  const trailingSlash = raw.endsWith('/');
  raw = raw.replace(/\/+$/, '');
  if (raw === '') return [];
  const out = [];
  let sawWildcard = false;
  for (const seg of raw.split('/')) {
    if (GLOB_CHARS.test(seg)) { sawWildcard = true; break; }
    out.push(seg);
  }
  if (!sawWildcard && !trailingSlash && out.length > 0) out.pop();
  return out;
}

function moduleRoot(paths) {
  const globs = Array.isArray(paths) ? paths : [];
  if (globs.length === 0) {
    return { kind: 'undecidable', reason: 'the module declares no paths, so it has no directory to carry a ' + AGENTS_MD_FILE };
  }
  let common = null;
  for (const g of globs) {
    const segs = literalDirSegments(g);
    if (common === null) { common = segs; continue; }
    const next = [];
    for (let i = 0; i < Math.min(common.length, segs.length); i++) {
      if (common[i] !== segs[i]) break;
      next.push(common[i]);
    }
    common = next;
  }
  if (!common || common.length === 0) {
    return {
      kind: 'undecidable',
      reason: 'its path globs (' + globs.map((g) => String(g)).join(', ')
        + ') share no directory above the repository root, so the module has no one directory to carry a ' + AGENTS_MD_FILE,
    };
  }
  return { kind: 'ok', dir: common.join('/') };
}

function sectionMatch(headingText, section) {
  const t = String(headingText);
  return t.toLowerCase().indexOf(section.en) >= 0 || t.indexOf(section.zh) >= 0;
}

function documentSections(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  const kinds = [];
  const heads = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; kinds.push('content'); continue; }
    if (fenced) { kinds.push(/^\s*$/.test(line) ? 'blank' : 'content'); continue; }
    const m = /^(#{1,4})\s+(\S.*)$/.exec(line);
    if (m) { kinds.push('heading'); heads.push({ level: m[1].length, text: m[2].trim(), index: i }); continue; }
    kinds.push(/^\s*$/.test(line) ? 'blank' : 'content');
  }
  const state = {};
  for (const s of AGENTS_MD_SECTIONS) state[s.id] = { found: false, nonEmpty: false, line: null };
  for (let h = 0; h < heads.length; h++) {
    const head = heads[h];
    const hit = AGENTS_MD_SECTIONS.find((s) => sectionMatch(head.text, s));
    if (!hit) continue;
    let end = lines.length;
    for (let k = h + 1; k < heads.length; k++) {
      if (heads[k].level <= head.level) { end = heads[k].index; break; }
    }
    let body = false;
    for (let i = head.index + 1; i < end; i++) {
      if (kinds[i] === 'content') { body = true; break; }
    }
    const cur = state[hit.id];
    if (!cur.found) { cur.found = true; cur.line = head.index + 1; }
    if (body) cur.nonEmpty = true;
  }
  return state;
}

function lintModuleDoc(moduleId, relFile, text) {
  const state = documentSections(text);
  const findings = [];
  const sections = {};
  for (const s of AGENTS_MD_SECTIONS) {
    const cur = state[s.id];
    if (!cur.found) {
      sections[s.id] = 'absent';
      findings.push({
        at: relFile + ':1', code: 'MISSING_SECTION', module: moduleId, section: s.id,
        detail: 'module "' + moduleId + '" states no ' + s.label + ' section in ' + relFile
          + '; a heading (#..####) containing "' + s.label + '" or "' + s.zh + '" is required',
      });
    } else if (!cur.nonEmpty) {
      sections[s.id] = 'empty';
      findings.push({
        at: relFile + ':' + cur.line, code: 'EMPTY_SECTION', module: moduleId, section: s.id,
        detail: 'module "' + moduleId + '" opens a ' + s.label + ' heading in ' + relFile + ' and puts nothing under it',
      });
    } else {
      sections[s.id] = 'stated';
    }
  }
  return { findings, sections };
}

function scanModuleDocs(root, catalog) {
  const modules = Array.isArray(catalog && catalog.modules) ? catalog.modules : [];
  const out = { listed: modules.length, inScope: 0, modules: [], findings: [], undecidable: [], unreadable: [] };
  for (const m of modules) {
    const id = String((m && m.id) || '');
    const tier = String((m && m.riskTier) || '').toLowerCase();
    if (!SCOPED_RISK_TIERS.includes(tier)) continue;
    out.inScope++;
    const rootRes = moduleRoot(m && m.paths);
    if (rootRes.kind !== 'ok') {
      out.undecidable.push({ at: 'module:' + id, reason: 'module "' + id + '": ' + rootRes.reason });
      out.modules.push({ id, riskTier: tier, dir: null, file: null, present: false, sections: null });
      continue;
    }
    const dir = rootRes.dir;
    const relFile = dir + '/' + AGENTS_MD_FILE;
    let text;
    try {
      text = fs.readFileSync(path.join(root, dir, AGENTS_MD_FILE), 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        const dirThere = fs.existsSync(path.join(root, dir));
        out.findings.push({
          at: relFile + ':1', code: 'MISSING_AGENTS_MD', module: id, section: null,
          detail: 'module "' + id + '" is riskTier ' + tier + ' and carries no ' + AGENTS_MD_FILE + ' at ' + relFile
            + (dirThere ? '' : ' (the directory itself is not on disk)'),
        });
        out.modules.push({ id, riskTier: tier, dir, file: relFile, present: false, sections: null });
        continue;
      }
      out.unreadable.push({ at: relFile, reason: 'module "' + id + '": the file could not be read: ' + errText(e) });
      out.modules.push({ id, riskTier: tier, dir, file: relFile, present: true, sections: null });
      continue;
    }
    const r = lintModuleDoc(id, relFile, text);
    for (const f of r.findings) out.findings.push(f);
    out.modules.push({ id, riskTier: tier, dir, file: relFile, present: true, sections: r.sections });
  }
  return out;
}

function agentsMdNote(r) {
  if (r.unreadable.length > 0) return 'part of the scope could not be read; not checked is not the same as clean';
  if (r.inScope === 0) {
    return 'nothing-in-scope:listed=' + r.listed + ' in-scope=0 (no module declares riskTier '
      + SCOPED_RISK_TIERS.join(' or ') + '), so no directory constitution is owed';
  }
  if (r.findings.length > 0) {
    return 'a high-risk module whose directory states no boundaries is one every agent has to remember the rules of; nested ' + AGENTS_MD_FILE + ' replaces that';
  }
  if (r.undecidable.length > 0) return 'a module root could not be derived from its path globs';
  return 'every high-risk module carries an ' + AGENTS_MD_FILE + ' stating its purpose, boundaries, invariants and verification';
}

function cmdAgentsMdLint(flags = {}) {
  const loaded = loadCatalogFlag(flags);
  if (!loaded.ok) {
    const note = 'no module catalog to read (' + loaded.error + '); nothing declares which modules are high risk';
    process.stderr.write(note + '\n');
    return emit({ ok: false, degraded: true, error: loaded.error, detail: loaded.detail, note }, 3);
  }
  if (!isGitRepo()) {
    const note = 'non-git: the catalog describes a tracked tree and this is not one';
    process.stderr.write(note + '\n');
    return emit({ ok: false, degraded: true, error: 'non-git', detail: note, note }, 3);
  }
  const r = scanModuleDocs(projectRoot(), loaded.catalog);
  const limit = positiveInt(flags.limit, DEFAULT_LIMIT);
  for (const f of r.findings.slice(0, limit)) {
    process.stderr.write('MODULE ' + f.at + '  ' + f.code + '  ' + f.detail + '\n');
  }
  const degraded = r.undecidable.length + r.unreadable.length > 0;
  const code = r.findings.length > 0 ? 1 : (degraded ? 3 : 0);
  return emit({
    ok: r.findings.length === 0 && !degraded,
    file: AGENTS_MD_FILE,
    listed: r.listed,
    inScope: r.inScope,
    degraded,
    modules: r.modules.slice(0, limit),
    modulesOmitted: Math.max(0, r.modules.length - limit),
    findings: r.findings.slice(0, limit),
    findingsOmitted: Math.max(0, r.findings.length - limit),
    undecidable: r.undecidable,
    unreadable: r.unreadable,
    riskTiers: SCOPED_RISK_TIERS,
    requiredSections: AGENTS_MD_SECTIONS.map((s) => s.label),
    note: agentsMdNote(r),
  }, code);
}

const cmdDocLint = cmdAgentsMdLint;

export {
  RULES_DOC, RULES_DIR, POINT_DIRS, POINT_EXTS, PROMPT_MARKERS, RUNNERS, TEXT_BUDGET,
  ruleLineText, backtickTokens, leadingBoldToken, admitsPromptOnly, collectPoints, normalizeWord, looksExecutable,
  classifyToken, classifyRuleLine, ruleDocs, clip, auditDoc, tally, positiveInt, cmdRulesAudit,
  SKILLS_DIR, SKILL_FILE, DESCRIPTION_BUDGET, BOOLEAN_KEYS,
  scalarValue, parseFrontmatter, lintSkillFile, scanSkills, skillsNote, cmdSkillsLint,
  AGENTS_MD_FILE, AGENTS_MD_SECTIONS, SCOPED_RISK_TIERS,
  literalDirSegments, moduleRoot, sectionMatch, documentSections, lintModuleDoc,
  scanModuleDocs, agentsMdNote, cmdAgentsMdLint, cmdDocLint,
};
