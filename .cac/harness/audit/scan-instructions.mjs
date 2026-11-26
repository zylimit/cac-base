#!/usr/bin/env node
// scan-instructions.mjs — 指令文件注入、端点篡改、隐藏字符与绕闸诱导独立哨兵（零外部依赖）。
//
// 扫描范围：.cac/rules/AGENTS.md、.cac/rules/*.md、.cac/harness/ext/rules/*.md、skills/*/SKILL.md、
//           .cac/agents/*.md、.cac/settings(.local).json 及常见跨工具指令文件（含子模块或异构根 AGENTS.md）。
// 支持 `--staged`（从 git index 读取真实暂存字节）、`--paths a,b`、`--json`。
// 自动兼容 CRLF（\r\n 归一后再按行扫描）与 UTF-8 BOM。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const NUL = '\0';
const MAX_BYTES = 1024 * 1024;
const MAX_REPORTED = 200;

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
      if (!deleted.has(f) && !seen.has(f)) { seen.add(f); outList.push(f); }
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

const INSTRUCTION_PATTERNS = [
  /(^|\/)AGENTS(\.local)?\.md$/i,
  /(^|\/)GEMINI\.md$/i,
  /(^|\/)\.cac\/rules\/.+\.md$/i,
  /(^|\/)\.cac\/harness\/ext\/rules\/.+\.md$/i,
  /(^|\/)skills?\/[^/]+\/SKILL\.md$/i,
  /(^|\/)\.cac\/agents\/[^/]+\.md$/i,
  /(^|\/)\.cac\/settings(\.local)?\.json$/i,
  /(^|\/)\.cursorrules$/i,
  /(^|\/)\.cursor\/rules\//i,
  /(^|\/)\.github\/copilot-instructions\.md$/i,
  /(^|\/)\.windsurfrules$/i,
];

const HIDDEN_CLASS = '[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF]';
const HIDDEN_GLOBAL = new RegExp(HIDDEN_CLASS, 'g');

const ENDPOINT_NAME =
  '[A-Z0-9_]*(?:ANTHROPIC|OPENAI|GEMINI|CODEAGENT|VERTEX|BEDROCK|LLM)[A-Z0-9_]*'
  + '(?:BASE_URL|API_BASE|API_KEY|AUTH_TOKEN|API_TOKEN|ENDPOINT)'
  + '|HTTPS?_PROXY|ALL_PROXY';

// 禁止/治理限制语境不算肯定式绕闸指令（覆盖英文与中文禁止词及审批拦截说明）
const PROHIBITION = /\b(?:never|do\s+not|don't|must\s+not|shall\s+not|should\s+not|cannot|can't|forbidden|prohibited|refuses?\s+to|block(?:s|ed|ing)?|deny|denied|high)\b|禁止|不许|不得|不要|严禁|不能|必停|批准|审批|拦截|阻断|拒绝|防|切勿/i;
const CLAUSE_BREAK = /[.;:!?。；！？]/;

const RULES = [
  {
    id: 'endpoint-override',
    severity: 'error',
    message: 'redirects model or proxy endpoint in an instruction/settings file.',
    re: new RegExp('\\b(?:' + ENDPOINT_NAME + ')\\b["\']?\\s*[:=]|\\bsetx\\s+["\']?(?:' + ENDPOINT_NAME + ')\\b|\\$env:(?:' + ENDPOINT_NAME + ')\\s*=', 'i'),
    maskUrl: true,
    affirmativeOnly: true,
  },
  {
    id: 'embedded-credential',
    severity: 'error',
    message: 'carries credential-shaped literal material inside an instruction file.',
    re: /\bsk-ant-[A-Za-z0-9_-]{16,}|\bsk-proj-[A-Za-z0-9_-]{16,}|\bsk-[A-Za-z0-9]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bglpat-[A-Za-z0-9_-]{16,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{35}|\bhf_[A-Za-z0-9]{30,}|\bnpm_[A-Za-z0-9]{30,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    redact: true,
  },
  {
    id: 'instruction-override',
    severity: 'error',
    message: 'claims authority over higher-level system or safety instructions.',
    re: /\bignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|rules|prompts)\b|\bdisregard\s+(?:the\s+)?(?:system|previous|above)\b|\byou\s+are\s+now\s+[a-z]|\bforget\s+(?:everything|all\s+previous)\b|\boverride\s+(?:the\s+)?(?:system|safety)\b/i,
    affirmativeOnly: true,
  },
  {
    id: 'exfiltration-command',
    severity: 'error',
    message: 'tells the agent to upload repository or environment data to an external endpoint.',
    re: /\b(?:curl|CURL|Curl|Invoke-WebRequest|Invoke-Webrequest|invoke-webrequest|Invoke-RestMethod|invoke-restmethod|iwr|IWR|irm|IRM)\b[^\n]{0,120}(?:\s-d\b|\s--data\b|\s--data-binary\b|\s--data-raw\b|\s--upload-file\b|\s-F\b|\s-T\b|-Method\s+Post\b|-Body\b)|\b(?:wget|WGET|Wget)\b[^\n]{0,120}(?:\s--post-data\b|\s--post-file\b|\s--body-data\b|\s--body-file\b|\s--method=POST\b)|\bnc\b\s+-[a-z]*\s*\d{1,5}\b/,
    affirmativeOnly: true,
  },
  {
    id: 'silent-execution',
    severity: 'error',
    message: 'pipes a downloaded script straight into a shell or Invoke-Expression.',
    re: /\b(?:curl|wget)\b[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:ba)?sh\b|\biex\s*\(\s*(?:new-object|iwr|irm|invoke-webrequest|invoke-restmethod)/i,
    affirmativeOnly: true,
  },
  {
    id: 'hidden-characters',
    severity: 'error',
    message: 'contains zero-width or bidirectional control characters invisible to human reviewers.',
    re: new RegExp(HIDDEN_CLASS),
  },
  {
    id: 'gate-disable-instruction',
    severity: 'error',
    message: 'instructs the agent to bypass verification hooks or gates.',
    re: /--no-verify|\bskip[- ]?(?:the\s+)?(?:hook|gate|check|test)s?\b|\bdisable\s+(?:the\s+)?(?:hook|gate|lint|check)s?\b/i,
    affirmativeOnly: true,
  },
  {
    id: 'secret-file-read',
    severity: 'warning',
    message: 'names a secret-bearing path inside an instruction file.',
    re: /(?:^|[\s"'\x60(\[])(?:\.env(?:\.[a-z]+)?|id_rsa|id_ed25519|\.ssh\/|\.aws\/credentials|\.npmrc)\b/i,
    except: /\.env\.(?:example|sample|template|dist)\b|"Read\([^)]+\)"/i,
  },
];

for (const r of RULES) {
  if (r.except) r.exceptAll = new RegExp(r.except.source, r.except.flags.replace(/g/g, '') + 'g');
}

function redactMatch(line, re) {
  const m = re.exec(line);
  if (!m) return line;
  const hit = m[0];
  return line.split(hit).join(hit.slice(0, 4) + '<REDACTED:' + hit.length + '>');
}

function maskUrlCredentials(s) {
  return s
    .replace(/(\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1<REDACTED>@')
    .replace(/([?&](?:token|key|api[-_]?key|access[-_]?token|password|secret)=)[^&\s"'\x60]+/gi, '$1<REDACTED>');
}

function reveal(s) {
  return s.replace(HIDDEN_GLOBAL, (ch) => '<U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') + '>');
}

const opts = parseArgs(process.argv.slice(2));
if (opts.error || opts.usage) {
  err('scan-instructions: ' + (opts.error ? 'unknown argument ' + opts.error : opts.usage)
    + '\nusage: scan-instructions.mjs [--staged] [--paths a,b] [--json]\n');
  process.exit(2);
}

const rawPaths = opts.paths === null
  ? null
  : opts.paths.split(',').map((s) => s.trim()).filter(Boolean);
const absPaths = rawPaths === null ? null : rawPaths.map((p) => path.resolve(p));

const root = repoRoot();
if (root === null && opts.paths === null) {
  err('scan-instructions: not a git repository; pass --paths to scan an explicit file list\n');
  process.exit(3);
}
if (root === null && opts.staged) {
  err('scan-instructions: --staged needs a git repository\n');
  process.exit(2);
}
if (root !== null) {
  try {
    process.chdir(root);
  } catch (e) {
    err('scan-instructions: cannot enter repository root ' + root + ': ' + oneLine((e && e.code) || e) + '\n');
    process.exit(3);
  }
}

const fromIndex = opts.staged;
let candidates;
let source;
const missingPaths = [];

if (absPaths !== null) {
  candidates = root === null ? rawPaths.map(toPosix) : absPaths.map((p) => toRepoRelative(root, p) || toPosix(p));
  source = fromIndex ? 'staged+paths' : 'paths';
  const idx = fromIndex ? gitIndexSet() : null;
  const present = [];
  for (const p of candidates) {
    if (fromIndex ? idx.has(p) : fs.existsSync(p)) present.push(p);
    else missingPaths.push(p);
  }
  if (present.length === 0 && missingPaths.length > 0) {
    err('scan-instructions: --paths named ' + missingPaths.length + ' missing path(s): ' + missingPaths.slice(0, 5).join(' ') + '\n');
    process.exit(2);
  }
  candidates = present;
} else {
  candidates = gitFileList(opts.staged);
  source = opts.staged ? 'staged' : 'tracked';
  if (candidates === null) {
    err('scan-instructions: git refused to list the file set\n');
    process.exit(3);
  }
}

const isInstruction = (f) => INSTRUCTION_PATTERNS.some((re) => re.test(f));
const targets = candidates.filter(isInstruction);

const findings = [];
const degraded = [];
const notes = [];
let scanned = 0;
let prohibitionSkips = 0;
let crlfNormalizedFiles = 0;

for (const f of targets) {
  let text;
  try {
    if (fromIndex) {
      const buf = indexContent(f);
      if (buf.length > MAX_BYTES) {
        degraded.push({ file: f, kind: 'oversized-file', detail: `${buf.length} bytes, over 1 MB, not scanned` });
        continue;
      }
      text = buf.toString('utf8');
    } else {
      const st = fs.statSync(f);
      if (!st.isFile()) {
        degraded.push({ file: f, kind: 'not-a-regular-file', detail: 'listed but not a regular file' });
        continue;
      }
      if (st.size > MAX_BYTES) {
        degraded.push({ file: f, kind: 'oversized-file', detail: `${st.size} bytes, over 1 MB, not scanned` });
        continue;
      }
      text = fs.readFileSync(f, 'utf8');
    }
  } catch (e) {
    degraded.push({ file: f, kind: 'unreadable-file', detail: oneLine((e && e.code) || e).slice(0, 120) });
    continue;
  }

  scanned++;
  if (text.charCodeAt(0) === 0xFEFF) {
    text = text.slice(1);
    notes.push({ file: f, note: 'utf8-bom-stripped-before-scan' });
  }
  if (text.indexOf('\r\n') !== -1) {
    text = text.replace(/\r\n/g, '\n');
    crlfNormalizedFiles++;
  }

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of RULES) {
      const m = rule.re.exec(line);
      if (!m) continue;
      if (rule.except && rule.except.test(line) && !rule.re.test(line.replace(rule.exceptAll, ''))) continue;
      if (rule.affirmativeOnly) {
        const before = line.slice(0, m.index).split(CLAUSE_BREAK).pop() || '';
        if (PROHIBITION.test(before) || PROHIBITION.test(line)) {
          prohibitionSkips++;
          continue;
        }
      }
      let raw = line;
      if (rule.redact) raw = redactMatch(line, rule.re);
      else if (rule.maskUrl) raw = maskUrlCredentials(line);
      findings.push({
        file: f,
        line: i + 1,
        rule: rule.id,
        severity: rule.severity,
        excerpt: reveal(raw.trim()).slice(0, 160),
      });
    }
  }
}

if (crlfNormalizedFiles > 0) {
  notes.push({ file: '(scope)', note: `crlf-normalized-before-scan:files=${crlfNormalizedFiles}` });
}
for (const p of missingPaths) {
  degraded.push({ file: p, kind: 'path-not-found', detail: 'named in --paths but missing' });
}
if (targets.length === 0) {
  notes.push({ file: '(scope)', note: `nothing-in-scope:listed=${candidates.length} in-scope=0` });
}
if (source === 'tracked' && candidates.length === 0) {
  const head = headFileCount();
  if (head > 0) {
    degraded.push({
      file: '(scope)',
      kind: 'listing-empty-but-repo-nonempty',
      detail: `git listed 0 tracked paths but HEAD holds ${head}`,
    });
  }
}

const errors = findings.filter((f) => f.severity === 'error');
const warnings = findings.filter((f) => f.severity !== 'error');
const code = errors.length > 0 ? 1 : (degraded.length > 0 ? 3 : 0);
const status = code === 0 ? 'ok' : (code === 3 ? 'degraded' : 'violation');

if (!opts.json) {
  for (const f of findings) {
    err((f.severity === 'error' ? ' ERR  ' : ' warn ') + f.rule.padEnd(26) + `${f.file}:${f.line}  ${f.excerpt}\n`);
  }
  for (const d of degraded) {
    err(' DEGR  ' + d.kind.padEnd(26) + `  ${d.file}  ${d.detail}\n`);
  }
  err(`scan-instructions: source=${source} root=${root || '(none)'} listed=${candidates.length} in-scope=${targets.length} scanned=${scanned} errors=${errors.length} warnings=${warnings.length} degraded=${degraded.length}\n`);
}

out(JSON.stringify({
  command: 'scan-instructions',
  status,
  code,
  ok: code === 0,
  summary: `scan-instructions：${errors.length} error / ${warnings.length} warning / ${degraded.length} degraded`,
  source,
  root,
  listed: candidates.length,
  inScope: targets.length,
  scanned,
  findings: findings.slice(0, MAX_REPORTED),
  errors: errors.slice(0, MAX_REPORTED),
  warnings: warnings.slice(0, MAX_REPORTED),
  degraded: degraded.slice(0, MAX_REPORTED),
  notes: notes.slice(0, MAX_REPORTED),
  counts: {
    error: errors.length,
    warning: warnings.length,
    prohibitionSkips,
    degraded: degraded.length,
  },
}) + '\n');

process.exitCode = code;
