#!/usr/bin/env node
// check-syntax.mjs — 框架与项目资产语法哨兵（零外部依赖，与治理引擎完全解耦）。
//
// 检查范围：
//   - .mjs / .cjs / .js        → node --check
//   - .json                    → JSON.parse（兼容 UTF-8 BOM）
//   - .sh 与 .cac/githooks/*   → sh -n / bash -n（缺失则标记 skippedClasses → rc 3）
//   - .ps1                     → pwsh / powershell Language.Parser（缺失则标记 skippedClasses → rc 3）
//   - SKILL.md / agents       → 强制要求 YAML frontmatter 严谨子集校验（完整兼容 \r?\n CRLF）
//   - .cac/rules & ext/rules  → YAML frontmatter 可选（无头视为常驻自动注入规则；有头校验语法，且 .cac/rules/AGENTS.md 严禁包含任何 YAML frontmatter）
// 支持 `--staged`（从 git 索引物化临时文件检验真实暂存字节）、`--paths a,b`、`--json`。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import process from 'node:process';

const NUL = '\0';
const BOM = 0xFEFF;
const TAB = '\t';

function out(s) {
  try { fs.writeSync(1, s); } catch (_e) { process.stdout.write(s); }
}
function err(s) {
  try { fs.writeSync(2, s); } catch (_e) { process.stderr.write(s); }
}
function oneLine(s) {
  return String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim();
}
function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

function parseArgs(argv) {
  const opts = { staged: false, json: false, paths: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--staged') opts.staged = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--paths') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('-')) return { usage: '--paths needs a comma-separated value' };
      opts.paths = v;
      i++;
    } else if (a.startsWith('--paths=')) {
      opts.paths = a.slice('--paths='.length);
      if (!opts.paths) return { usage: '--paths= needs a comma-separated value' };
    } else {
      return { error: a };
    }
  }
  if (opts.paths !== null && opts.paths.split(',').map((s) => s.trim()).filter(Boolean).length === 0) {
    return { usage: '--paths resolved to an empty file set' };
  }
  return opts;
}

function gitExec(args, extraOpts = {}) {
  return execFileSync('git', args, {
    shell: false,
    windowsHide: true,
    maxBuffer: 1 << 28,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...extraOpts,
  });
}

function repoRoot() {
  try {
    const r = gitExec(['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    return r || null;
  } catch (_e) {
    return null;
  }
}

function toRepoRelative(root, abs) {
  if (!root) return null;
  const rel = path.relative(root, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return toPosix(rel);
}

const RUNTIME_SKIP_PREFIXES = [
  '.cac/.runtime/', '.cac/evidence/', '.cac/harness/state/', '.cac/harness/receipts/',
  '.cac/harness/waivers/', '.cac/harness/trend/', '.cac/harness/evidence/',
  '.cac/agent-memory/', '.cac/worktrees/',
];

function isRuntimeRel(f) {
  if (f === '.cac/signals.jsonl' || f.endsWith('/signals.jsonl')) return true;
  return RUNTIME_SKIP_PREFIXES.some((pre) => f.startsWith(pre));
}

function gitFileList(staged) {
  try {
    if (staged) {
      return gitExec(['-c', 'core.quotePath=false', 'diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'], { encoding: 'utf8' })
        .split(NUL).map(toPosix).filter(Boolean);
    }
    const tracked = gitExec(['-c', 'core.quotePath=false', 'ls-files', '-z'], { encoding: 'utf8' })
      .split(NUL).map(toPosix).filter(Boolean);
    const deleted = new Set(
      gitExec(['-c', 'core.quotePath=false', 'ls-files', '--deleted', '-z'], { encoding: 'utf8' })
        .split(NUL).map(toPosix).filter(Boolean),
    );
    const untracked = gitExec(['-c', 'core.quotePath=false', 'ls-files', '-z', '--others', '--exclude-standard'], { encoding: 'utf8' })
      .split(NUL).map(toPosix).filter(Boolean);
    const seen = new Set();
    const outList = [];
    for (const f of tracked.concat(untracked)) {
      if (!deleted.has(f) && !seen.has(f) && !isRuntimeRel(f)) { seen.add(f); outList.push(f); }
    }
    return outList;
  } catch (_e) {
    return null;
  }
}

function gitIndexSet() {
  try {
    return new Set(
      gitExec(['-c', 'core.quotePath=false', 'ls-files', '-z'], { encoding: 'utf8' })
        .split(NUL).map(toPosix).filter(Boolean),
    );
  } catch (_e) {
    return new Set();
  }
}

function headFileCount() {
  try {
    const raw = gitExec(['-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', '-z', 'HEAD'], { encoding: 'utf8' });
    return raw.split(NUL).filter(Boolean).length;
  } catch (_e) {
    return -1;
  }
}

function indexContent(p) {
  return gitExec(['-c', 'core.quotePath=false', 'show', ':' + p]);
}

const opts = parseArgs(process.argv.slice(2));
if (opts.error || opts.usage) {
  err('check-syntax: ' + (opts.error ? 'unknown argument ' + opts.error : opts.usage)
    + '\nusage: check-syntax.mjs [--staged] [--paths a,b] [--json]\n');
  process.exit(2);
}

const rawPaths = opts.paths === null
  ? null
  : opts.paths.split(',').map((s) => s.trim()).filter(Boolean);
const absPaths = rawPaths === null ? null : rawPaths.map((p) => path.resolve(p));

const root = repoRoot();
if (root === null && opts.paths === null) {
  err('check-syntax: not a git repository; pass --paths to check an explicit file list\n');
  process.exit(3);
}
if (root === null && opts.staged) {
  err('check-syntax: --staged needs a git repository\n');
  process.exit(2);
}
if (root !== null) {
  try {
    process.chdir(root);
  } catch (e) {
    err('check-syntax: cannot enter repository root ' + root + ': ' + oneLine((e && e.code) || e) + '\n');
    process.exit(3);
  }
}

const failures = [];
const skippedClasses = [];
const undecidable = [];
const degraded = [];
const notes = [];
const missingPaths = [];
const counts = {};

const fromIndex = opts.staged;
let files;
let source;

if (absPaths !== null) {
  files = root === null ? rawPaths.map(toPosix) : absPaths.map((p) => toRepoRelative(root, p) || toPosix(p));
  source = fromIndex ? 'staged+paths' : 'paths';
  const idx = fromIndex ? gitIndexSet() : null;
  const present = [];
  for (const p of files) {
    if (fromIndex ? idx.has(p) : fs.existsSync(p)) present.push(p);
    else missingPaths.push(p);
  }
  if (present.length === 0 && missingPaths.length > 0) {
    err('check-syntax: --paths named ' + missingPaths.length + ' missing path(s): ' + missingPaths.slice(0, 5).join(' ') + '\n');
    process.exit(2);
  }
  files = present;
} else {
  files = gitFileList(opts.staged);
  source = opts.staged ? 'staged' : 'tracked';
  if (files === null) {
    err('check-syntax: git refused to list the file set\n');
    process.exit(3);
  }
}

const jsFiles = files.filter((f) => /\.(mjs|cjs|js)$/i.test(f));
const jsonFiles = files.filter((f) => /\.json$/i.test(f));
const shFiles = files.filter((f) => /\.sh$/i.test(f) || /(^|\/)\.cac\/githooks\/(pre-commit|commit-msg|pre-push)$/.test(f));
const ps1Files = files.filter((f) => /\.ps1$/i.test(f));
const fmFiles = files.filter((f) =>
  /(^|\/)skills?\/[^/]+\/SKILL\.md$/i.test(f)
  || /(^|\/)\.cac\/agents\/[^/]+\.md$/i.test(f)
  || /(^|\/)\.cac\/(?:harness\/ext\/)?rules\/[^/]+\.md$/i.test(f));

let stagedDir = null;
let stagedSeq = 0;

function stagedTemp() {
  if (stagedDir === null) stagedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cac-audit-staged-'));
  return stagedDir;
}

function cleanupStaged() {
  if (stagedDir === null) return;
  try { fs.rmSync(stagedDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  stagedDir = null;
}
process.on('exit', cleanupStaged);

function readText(f) {
  const t = fromIndex ? indexContent(f).toString('utf8') : fs.readFileSync(f, 'utf8');
  return t.charCodeAt(0) === BOM ? t.slice(1) : t;
}

function onDisk(f, kind) {
  if (!fromIndex) return f;
  try {
    const target = path.join(stagedTemp(), String(stagedSeq++) + '_' + path.basename(f));
    fs.writeFileSync(target, indexContent(f));
    return target;
  } catch (e) {
    degraded.push({ file: f, kind, detail: 'staged content could not be read: ' + oneLine((e && e.code) || e).slice(0, 120) });
    return null;
  }
}

function firstLines(s, n) {
  return String(s || '').trim().split(/\r?\n/).slice(0, n).join(' | ').slice(0, 240);
}

function retarget(text, disk, orig) {
  return disk === orig ? String(text || '') : String(text || '').split(disk).join(orig);
}

// 1. JavaScript: node --check
counts.js = jsFiles.length;
for (const f of jsFiles) {
  const disk = onDisk(f, 'js');
  if (disk === null) continue;
  const r = spawnSync(process.execPath, ['--check', disk], {
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    failures.push({ file: f, kind: 'js', error: firstLines(retarget(r.stderr, disk, f), 3) });
  }
}

// 2. JSON: JSON.parse
counts.json = jsonFiles.length;
for (const f of jsonFiles) {
  let text;
  try {
    text = readText(f);
  } catch (e) {
    degraded.push({ file: f, kind: 'json', detail: 'not read: ' + oneLine((e && e.code) || e).slice(0, 120) });
    continue;
  }
  try {
    JSON.parse(text);
  } catch (e) {
    failures.push({ file: f, kind: 'json', error: String((e && e.message) || e).slice(0, 240) });
  }
}

// 3. Shell: bash -n 或 sh -n
counts.sh = shFiles.length;
function findPosixShell() {
  for (const sh of ['bash', 'sh']) {
    const r = spawnSync(sh, ['-c', 'exit 0'], { shell: false, windowsHide: true, encoding: 'utf8' });
    if (!r.error && r.status === 0) return sh;
  }
  return null;
}

if (shFiles.length > 0) {
  const shExe = findPosixShell();
  if (!shExe) {
    skippedClasses.push({ kind: 'sh', count: shFiles.length, reason: 'neither bash nor sh available on PATH' });
  } else {
    for (const f of shFiles) {
      const disk = onDisk(f, 'sh');
      if (disk === null) continue;
      const r = spawnSync(shExe, ['-n', disk], { shell: false, windowsHide: true, encoding: 'utf8' });
      if (r.status !== 0) {
        failures.push({ file: f, kind: 'sh', error: firstLines(retarget(r.stderr, disk, f), 3) });
      }
    }
  }
}

// 4. PowerShell: Language.Parser::ParseFile
counts.ps1 = ps1Files.length;
function findPwsh() {
  for (const exe of ['pwsh', 'powershell']) {
    const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
    });
    if (!r.error && r.status === 0) return exe;
  }
  return null;
}

if (ps1Files.length > 0) {
  const exe = findPwsh();
  if (!exe) {
    skippedClasses.push({ kind: 'ps1', count: ps1Files.length, reason: 'neither pwsh nor powershell available on PATH' });
  } else {
    const backToSource = new Map();
    const checkList = [];
    for (const f of ps1Files) {
      const disk = onDisk(f, 'ps1');
      if (disk === null) continue;
      backToSource.set(path.resolve(disk), f);
      checkList.push(disk);
    }
    const listDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cac-audit-ps1-'));
    const listFile = path.join(listDir, 'files.txt');
    try {
      fs.writeFileSync(listFile, checkList.join('\n'), 'utf8');
      const quoted = "'" + listFile.split("'").join("''") + "'";
      const script =
        "$ErrorActionPreference = 'Continue'; "
        + 'foreach ($p in Get-Content -LiteralPath ' + quoted + ') { '
        + 'if (-not $p) { continue }; '
        + '$t = $null; $e = $null; '
        + '[void][System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$t, [ref]$e); '
        + "if ($e -and $e.Count -gt 0) { Write-Output (('BAD' + [char]9 + $p + [char]9 + $e[0].Message)) } "
        + '}';
      const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', script], {
        shell: false,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 1 << 26,
      });
      if (r.error || r.status !== 0) {
        failures.push({ file: '(ps1 batch)', kind: 'ps1-checker', error: firstLines((r.stderr || '') + ' ' + String(r.error || ''), 3) });
      } else {
        for (const line of String(r.stdout || '').split(/\r?\n/)) {
          const parts = line.split(TAB);
          if (parts[0] === 'BAD' && parts[1]) {
            const reported = backToSource.get(path.resolve(parts[1])) || parts[1];
            failures.push({ file: reported, kind: 'ps1', error: String(parts[2] || '').slice(0, 240) });
          }
        }
      }
    } finally {
      try { fs.rmSync(listDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
    }
  }
}

// 5. YAML Frontmatter（完整兼容 \r?\n CRLF）
counts.frontmatter = fmFiles.length;

const KEY_RE = /^(?:[A-Za-z_][A-Za-z0-9_.-]*|"[^"]*"|'[^']*')\s*:(?:\s(.*))?$/;
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

function plainScalarProblem(v, n) {
  if (v === '') return null;
  if (/:(\s|$)/.test(v)) {
    return { kind: 'error', reason: `line ${n} puts ": " inside an unquoted value; quote it: ${v.slice(0, 60)}` };
  }
  if (/^[@`%]/.test(v)) {
    return { kind: 'error', reason: `line ${n} starts an unquoted value with reserved indicator (${v.charAt(0)}): ${v.slice(0, 60)}` };
  }
  if (/^-(\s|$)/.test(v)) {
    return { kind: 'error', reason: `line ${n} starts an unquoted value with "- ": ${v.slice(0, 60)}` };
  }
  if (/^[|>]/.test(v) && !BLOCK_SCALAR_RE.test(v)) {
    return { kind: 'error', reason: `line ${n} has malformed block scalar header (${v.slice(0, 8)})` };
  }
  return null;
}

function frontmatterCheck(rawText) {
  // 统一使用 \r?\n 切分并剥除尾部残留 \r，彻底兼容 Windows CRLF
  const text = String(rawText).replace(/^\uFEFF/, '');
  if (!/^---\r?\n/.test(text)) {
    return { kind: 'error', reason: 'first line is not "---" (missing YAML frontmatter)' };
  }
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\r$/, ''));
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---' && lines[i] === '---') { end = i; break; }
  }
  if (end < 0) return { kind: 'error', reason: 'unterminated frontmatter: no closing "---"' };

  let keys = 0;
  let sawKey = false;
  let openQuote = null;
  let block = null;
  let lastKey = null;
  let unsure = null;
  const stack = [0];

  const openColumn = (indent, n, trimmed) => {
    const top = stack[stack.length - 1];
    if (indent > top) { stack.push(indent); return null; }
    if (indent === top) return null;
    while (stack.length && stack[stack.length - 1] > indent) stack.pop();
    if (stack.length === 0 || stack[stack.length - 1] !== indent) {
      return { kind: 'error', reason: `line ${n} dedents to column ${indent}, which no enclosing block opened: ${trimmed.slice(0, 60)}` };
    }
    return null;
  };

  const classifyValue = (value, n) => {
    if (value === '') return { kind: 'empty', problem: null };
    const ch = value.charAt(0);
    if (ch === '"' || ch === "'") {
      if (closingQuote(value, ch) < 0) openQuote = { ch, line: n };
      return { kind: 'scalar', problem: null };
    }
    if (BLOCK_SCALAR_RE.test(value)) return { kind: 'block', problem: null };
    // 允许单行简单字符串数组如 ["a", "b"]（常见于 paths/tools frontmatter）
    if (ch === '[' && value.endsWith(']')) {
      try {
        const parsed = JSON.parse(value.replace(/'([^']*)'/g, '"$1"'));
        if (Array.isArray(parsed)) return { kind: 'scalar', problem: null };
      } catch (_e) { /* fall through */ }
      if (!unsure) unsure = `line ${n} uses a complex flow sequence outside checker subset`;
      return { kind: 'scalar', problem: null };
    }
    if (ch === '{' || ch === '[') {
      if (!unsure) unsure = `line ${n} uses a flow collection outside checker subset`;
      return { kind: 'scalar', problem: null };
    }
    if (ch === '&' || ch === '*' || ch === '!') {
      if (!unsure) unsure = `line ${n} uses an anchor, alias or tag outside checker subset`;
      return { kind: 'scalar', problem: null };
    }
    return { kind: 'scalar', problem: plainScalarProblem(value, n) };
  };

  for (let i = 1; i < end; i++) {
    const raw = lines[i];
    const n = i + 1;

    if (openQuote) {
      if (closingQuote(openQuote.ch + raw, openQuote.ch) >= 0) openQuote = null;
      continue;
    }

    const lead = /^[ \t]*/.exec(raw)[0];

    if (block) {
      if (raw.trim() === '') continue;
      if (lead.length > block.indent) {
        if (raw.slice(0, block.indent + 1).indexOf(TAB) >= 0) {
          return { kind: 'error', reason: `line ${n} indents a block scalar body with a tab` };
        }
        continue;
      }
      block = null;
    }

    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    if (lead.indexOf(TAB) >= 0) {
      return { kind: 'error', reason: `line ${n} indents with a tab; YAML forbids tabs in indentation` };
    }
    const indent = lead.length;
    const content = raw.slice(indent);

    if (lastKey && lastKey.hadValue && indent > lastKey.indent) {
      const bad = plainScalarProblem(content, n);
      if (bad) return bad;
      continue;
    }

    if (/^\?(\s|$)/.test(content) || /^<<\s*:/.test(content) || /^%/.test(content)) {
      if (!unsure) unsure = `line ${n} uses explicit key, merge key or directive`;
      const col = openColumn(indent, n, trimmed);
      if (col) return col;
      lastKey = { indent, hadValue: false };
      continue;
    }

    if (/^-(\s|$)/.test(content)) {
      if (!sawKey) return { kind: 'error', reason: `line ${n} is a list item with no key above it` };
      const col = openColumn(indent, n, trimmed);
      if (col) return col;
      const after = content.slice(1);
      const item = after.trim();
      const km = KEY_RE.exec(item);
      const v = km ? String(km[1] === undefined ? '' : km[1]).trim() : item;
      const res = classifyValue(v, n);
      if (res.problem) return res.problem;
      if (res.kind === 'block') block = { indent };
      lastKey = { indent: indent + 1 + (after.length - after.trimStart().length), hadValue: res.kind !== 'empty' };
      continue;
    }

    const m = KEY_RE.exec(content);
    if (m) {
      const col = openColumn(indent, n, trimmed);
      if (col) return col;
      keys++;
      sawKey = true;
      const res = classifyValue(String(m[1] === undefined ? '' : m[1]).trim(), n);
      if (res.problem) return res.problem;
      lastKey = { indent, hadValue: res.kind !== 'empty' };
      if (res.kind === 'block') block = { indent };
      continue;
    }

    if (lastKey && indent > lastKey.indent) {
      const bad = plainScalarProblem(content, n);
      if (bad) return bad;
      continue;
    }
    return { kind: 'error', reason: `line ${n} is neither "key: value", a list item, nor a continuation: ${trimmed.slice(0, 60)}` };
  }

  if (openQuote) {
    return { kind: 'error', reason: `quoted value opened on line ${openQuote.line} is never closed` };
  }
  if (keys === 0) return { kind: 'error', reason: 'frontmatter block contains no keys' };
  if (unsure) return { kind: 'undecidable', reason: unsure };
  return null;
}

function hasYamlFrontmatterHeader(rawText) {
  const text = String(rawText ?? '').replace(/^\uFEFF/, '');
  return /^---(?:[ \t]*\r?\n|[ \t]*$)/.test(text);
}

for (const f of fmFiles) {
  let text;
  try {
    text = readText(f);
  } catch (e) {
    failures.push({ file: f, kind: 'frontmatter', error: 'unreadable: ' + oneLine((e && e.code) || e).slice(0, 120) });
    continue;
  }
  const cleanText = String(text).replace(/^\uFEFF/, '');
  const isRuleFile = /(^|\/)\.cac\/(?:harness\/ext\/)?rules\/[^/]+\.md$/i.test(f);
  const isMainAgentsRule = /(^|\/)\.cac\/rules\/AGENTS\.md$/i.test(f);

  // .cac/rules/AGENTS.md must NEVER contain any YAML frontmatter header (aligned with HOST-CONTRACT §2).
  if (isMainAgentsRule) {
    if (hasYamlFrontmatterHeader(cleanText)) {
      failures.push({
        file: f,
        kind: 'frontmatter',
        error: '.cac/rules/AGENTS.md must not contain YAML frontmatter (including paths: or any "---" header; must stay pure Markdown for host startup auto-injection)',
      });
    }
    continue;
  }

  // .cac/rules/*.md and .cac/harness/ext/rules/*.md have optional YAML frontmatter:
  // headerless files are valid always-on rules auto-injected by codeagent at session start.
  if (isRuleFile && !hasYamlFrontmatterHeader(cleanText)) {
    continue;
  }

  const problem = frontmatterCheck(cleanText);
  if (problem && problem.kind === 'error') {
    failures.push({ file: f, kind: 'frontmatter', error: problem.reason });
    continue;
  }
  if (problem && problem.kind === 'undecidable') {
    undecidable.push({ file: f, kind: 'frontmatter', reason: problem.reason });
  }
}

cleanupStaged();

for (const p of missingPaths) {
  degraded.push({ file: p, kind: 'path-not-found', detail: 'named in --paths but missing' });
}
const inScope = counts.js + counts.json + counts.sh + counts.ps1 + counts.frontmatter;
if (inScope === 0) {
  notes.push({ file: '(scope)', note: `nothing-in-scope:listed=${files.length} in-scope=0` });
}
if (source === 'tracked' && files.length === 0) {
  const head = headFileCount();
  if (head > 0) {
    degraded.push({
      file: '(scope)',
      kind: 'listing-empty-but-repo-nonempty',
      detail: `git listed 0 tracked paths but HEAD holds ${head}`,
    });
  }
}

const code = failures.length > 0
  ? 1
  : ((skippedClasses.length + undecidable.length + degraded.length) > 0 ? 3 : 0);
const status = code === 0 ? 'ok' : (code === 3 ? 'degraded' : 'violation');

if (!opts.json) {
  for (const f of failures) err(` FAIL  ${f.kind.padEnd(12)}${f.file}  ${f.error}\n`);
  for (const u of undecidable) err(` UNDECIDABLE  ${u.kind.padEnd(6)}${u.file}  ${u.reason}\n`);
  for (const s of skippedClasses) err(` SKIPPED  ${s.kind.padEnd(10)}${s.count} file(s): ${s.reason}\n`);
  for (const d of degraded) err(` DEGR  ${d.kind.padEnd(16)}  ${d.file}  ${d.detail}\n`);
  err(`check-syntax: source=${source} root=${root || '(none)'} listed=${files.length} in-scope=${inScope} js=${counts.js} json=${counts.json} sh=${counts.sh} ps1=${counts.ps1} frontmatter=${counts.frontmatter} failures=${failures.length} skipped=${skippedClasses.length} degraded=${degraded.length}\n`);
}

out(JSON.stringify({
  command: 'check-syntax',
  status,
  code,
  ok: code === 0,
  summary: `check-syntax：checked ${inScope} file(s), ${failures.length} failure(s), ${skippedClasses.length + undecidable.length + degraded.length} degraded`,
  node: process.version,
  source,
  root,
  listed: files.length,
  inScope,
  checked: counts,
  failures,
  bad: failures,
  skipped: skippedClasses,
  undecidable,
  degraded,
  notes,
}) + '\n');

process.exitCode = code;
