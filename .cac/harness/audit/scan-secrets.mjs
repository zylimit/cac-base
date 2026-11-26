#!/usr/bin/env node
// scan-secrets.mjs — 独立密钥与明文传输审计哨兵（零外部依赖，与治理引擎完全解耦）。
//
// 核心修复与守则：
// 1. 支持 `--staged`（文件名与字节均取自 git 索引 `git show :<path>`）、`--paths a,b`、`--json`。
// 2. 凭据文件扩展名规则（no-credentials-files）严格检测**文件路径名**（排除 .env.example/.sample/.template/.dist），绝不测文件内容。
// 3. 明文传输规则（no-insecure-transport）只拦非本地明文 `http://` 与 `ws://`（排除 localhost / 127.0.0.1 / ::1 / 0.0.0.0 / example.com / XML namespace），**绝不误拦 `https://` 或 `wss://`**！
// 4. 所有子进程调用显式 `shell: false, windowsHide: true`。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const NUL = '\0';
const MAX_BYTES = 1024 * 1024;
const MAX_REPORTED = 200;
const SUPPRESS = /(?:scan-secrets|harness-fitness):ignore/;

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

const WALK_SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'release', '.next', '.venv',
]);
const WALK_SKIP_PREFIXES = [
  '.cac/.runtime/', '.cac/evidence/', '.cac/harness/state/', '.cac/harness/receipts/',
  '.cac/harness/waivers/', '.cac/harness/trend/', '.cac/harness/evidence/',
  '.cac/agent-memory/', '.cac/worktrees/',
];

function isRuntimeRel(rel) {
  const n = toPosix(rel);
  if (n === '.cac/signals.jsonl' || n.endsWith('/signals.jsonl')) return true;
  if (/^\.cac\/\.(needs-review|needs-review\.lock|red-verified|tdd-exempt|tdd-gate-advised|stop-gate-strikes|stop-gate-advised|three-file-sync-advised|precompact-block-epoch|subagent-reminded|fast-mode)$/.test(n)) {
    return true;
  }
  return WALK_SKIP_PREFIXES.some((pre) => n.startsWith(pre));
}

function walkWorktree(rootDir) {
  const acc = [];
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_e) { return; }
    for (const ent of ents) {
      if (ent.isSymbolicLink()) continue;
      const full = path.join(dir, ent.name);
      const rel = toPosix(path.relative(rootDir, full));
      if (ent.isDirectory()) {
        if (WALK_SKIP_DIRS.has(ent.name) || isRuntimeRel(rel + '/')) continue;
        walk(full);
      } else if (ent.isFile()) {
        if (!isRuntimeRel(rel)) acc.push(rel);
      }
    }
  };
  walk(rootDir);
  return acc.sort();
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
    const merged = [];
    for (const f of tracked.concat(untracked)) {
      if (!deleted.has(f) && !seen.has(f) && !isRuntimeRel(f)) {
        seen.add(f);
        merged.push(f);
      }
    }
    return merged;
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

function indexContent(p) {
  return gitExec(['-c', 'core.quotePath=false', 'show', ':' + p]);
}

let gitlinkCache = null;
function isGitlink(p) {
  if (gitlinkCache === null) {
    gitlinkCache = new Set();
    try {
      const raw = gitExec(['-c', 'core.quotePath=false', 'ls-files', '-s', '-z'], { encoding: 'utf8' });
      for (const rec of raw.split(NUL)) {
        if (!rec.startsWith('160000 ')) continue;
        const tab = rec.indexOf('\t');
        if (tab > 0) gitlinkCache.add(toPosix(rec.slice(tab + 1)));
      }
    } catch (_e) { /* ignore */ }
  }
  return gitlinkCache.has(p);
}

// 合法样例文件白名单（先于凭据扩展名与内容检查）
const ALLOWLIST_FILE = [
  /(^|\/)\.env\.(example|sample|template|dist)$/i,
  /\.(example|sample|template)$/i,
];

// 凭据文件扩展名/文件名规则：严格仅对**文件路径名**判定，绝不匹配文件正文！
const CREDENTIAL_PATH_RE = /(?:^|\/)(?:\.env(?:\.[A-Za-z0-9_-]+)?|id_rsa(?:\.[A-Za-z0-9_.-]+)?|id_ed25519(?:\.[A-Za-z0-9_.-]+)?|\.?credentials\.json)$|\.(?:pem|p12|pfx|key|ppk)$/i;

// 明文非本地传输协议（仅匹配 http:// 与 ws://，绝不匹配 https:// 或 wss://；排除环回地址、内网示例域名与 XML 命名空间）
const INSECURE_TRANSPORT_RE = /\b(?:http|ws):\/\/(?!localhost\b|127\.(?:0\.0\.1|\d+\.\d+\.\d+)\b|0\.0\.0\.0\b|\[?::1\]?(?::|\/|["'\s]|$)|[^/\s"']+\.(?:local|localhost|example\.com)\b|(?:www\.)?example\.(?:com|org|net)\b|www\.w3\.org\b|schemas\.(?:microsoft|xmlsoap)\.com\b|purl\.org\b)[A-Za-z0-9][-A-Za-z0-9.]*(?::\d+)?(?:\/[^\s"'`<>)]*)?/;
const REGISTRY_FILES = new Set(['.npmrc', '.yarnrc']);

const SECRET_PATTERNS = [
  { id: 'private-key-block', confident: true, re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'github-token', confident: true, re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { id: 'github-fine-grained-pat', confident: true, re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { id: 'gitlab-token', confident: true, re: /\bglpat-[A-Za-z0-9_-]{16,}/ },
  { id: 'anthropic-key', confident: true, re: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  { id: 'openai-project-key', confident: true, re: /\bsk-proj-[A-Za-z0-9_-]{16,}/ },
  { id: 'openai-style-key', confident: true, re: /\bsk-[A-Za-z0-9]{20,}/ },
  { id: 'google-api-key', confident: true, re: /\bAIza[0-9A-Za-z_-]{35}/ },
  { id: 'huggingface-token', confident: true, re: /\bhf_[A-Za-z0-9]{30,}/ },
  { id: 'npm-token', confident: true, re: /\bnpm_[A-Za-z0-9]{30,}/ },
  { id: 'aws-access-key-id', confident: true, re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'aws-secret-access-key', confident: true, re: /aws_secret_access_key\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})/i, valueGroup: 1 },
  { id: 'slack-token', confident: true, re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { id: 'stripe-live-key', confident: true, re: /\b(?:sk|pk|rk)_live_[A-Za-z0-9]{12,}/ },
  { id: 'jwt', confident: true, re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { id: 'url-userinfo', confident: true, re: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s@:"]+:[^/\s@"]+@/i },
  {
    id: 'generic-assignment',
    confident: false,
    re: /(?:password|passwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*(?:(["'])([^"'\s]{12,})\1|([^"'\s]{12,}))/i,
    valueGroup: [2, 3],
    literalOnly: true,
  },
];

const PLACEHOLDER_CONTEXT = /example|sample|placeholder|dummy|redacted|changeme|xxxx|your[-_]|<[^>]+>|\$\{|process\.env|os\.environ|getenv|System\.getenv|\$env:/i;
const BARE_LITERAL = /^[A-Za-z0-9_+=-]+$/;

function credentialShaped(v) {
  if (!/[A-Za-z]/.test(v) || !/[0-9]/.test(v)) return false;
  const seen = new Set(v.split(''));
  return seen.size >= 6;
}

function literalValue(m) {
  const quoted = m[2] !== undefined;
  const v = quoted ? m[2] : m[3];
  if (v === undefined) return null;
  if (!quoted && !BARE_LITERAL.test(v)) return null;
  if (!credentialShaped(v)) return null;
  return v;
}

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf',
  '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.jar', '.war',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.mov', '.avi', '.webm',
  '.bin', '.exe', '.dll', '.so', '.dylib', '.class', '.wasm',
]);

function redactMatch(line, re) {
  const m = re.exec(line);
  if (!m) return line;
  const hit = m[0];
  return line.split(hit).join(hit.slice(0, 4) + '<REDACTED:' + hit.length + '>');
}

function redactValue(line, m, value) {
  const rel = m[0].lastIndexOf(value);
  if (rel < 0) return line.split(m[0]).join('<REDACTED:' + m[0].length + '>');
  const at = m.index + rel;
  return line.slice(0, at) + '<REDACTED:' + value.length + '>' + line.slice(at + value.length);
}

const opts = parseArgs(process.argv.slice(2));
if (opts.error || opts.usage) {
  err('scan-secrets: ' + (opts.error ? 'unknown argument ' + opts.error : opts.usage)
    + '\nusage: scan-secrets.mjs [--staged] [--paths a,b] [--json]\n');
  process.exit(2);
}

const rawPaths = opts.paths === null
  ? null
  : opts.paths.split(',').map((s) => s.trim()).filter(Boolean);
const absPaths = rawPaths === null ? null : rawPaths.map((p) => path.resolve(p));

const gitRoot = repoRoot();
if (gitRoot === null && opts.staged) {
  err('scan-secrets: --staged requires a git repository\n');
  process.exit(3);
}

const workRoot = gitRoot || process.cwd();
try {
  process.chdir(workRoot);
} catch (e) {
  err('scan-secrets: cannot enter root ' + workRoot + ': ' + oneLine((e && e.code) || e) + '\n');
  process.exit(3);
}

let files;
let source;
const degraded = [];
const notes = [];

if (absPaths !== null) {
  const relList = absPaths.map((p) => toRepoRelative(workRoot, p) || toPosix(p));
  source = opts.staged ? 'staged+paths' : 'paths';
  const indexSet = opts.staged ? gitIndexSet() : null;
  const present = [];
  const missing = [];
  for (const p of relList) {
    if (opts.staged ? indexSet.has(p) : fs.existsSync(p)) present.push(p);
    else missing.push(p);
  }
  if (present.length === 0 && missing.length > 0) {
    err('scan-secrets: --paths named ' + missing.length + ' missing path(s): ' + missing.slice(0, 5).join(' ') + '\n');
    process.exit(2);
  }
  for (const m of missing) {
    degraded.push({ file: m, kind: 'path-not-found', detail: 'named in --paths but missing' });
  }
  files = present;
} else if (gitRoot !== null) {
  files = gitFileList(opts.staged);
  source = opts.staged ? 'staged' : 'tracked';
  if (files === null) {
    err('scan-secrets: git refused to list the file set\n');
    process.exit(3);
  }
} else {
  files = walkWorktree(workRoot);
  source = 'worktree';
}

const findings = [];
const suppressed = [];
let scanned = 0;
let skippedBinary = 0;
let skippedAllowlisted = 0;
let skippedSubmodule = 0;

for (const rawFile of files) {
  const f = toPosix(rawFile);
  if (ALLOWLIST_FILE.some((re) => re.test(f))) {
    skippedAllowlisted++;
    continue;
  }

  // 规则 1：凭据文件路径检查（仅检测文件路径名 f，绝不测文件内容）
  if (CREDENTIAL_PATH_RE.test(f)) {
    findings.push({
      file: f,
      line: 1,
      rule: 'no-credentials-files',
      severity: 'error',
      excerpt: `credential file path must not be committed: ${f}`,
    });
  }

  if (BINARY_EXT.has(path.extname(f).toLowerCase())) {
    skippedBinary++;
    continue;
  }

  let text;
  try {
    if (opts.staged) {
      if (isGitlink(f)) { skippedSubmodule++; continue; }
      const buf = indexContent(f);
      if (buf.length > MAX_BYTES) {
        degraded.push({ file: f, kind: 'oversized-file', detail: `${buf.length} bytes, over 1 MB, not scanned` });
        continue;
      }
      if (buf.indexOf(0) >= 0) { skippedBinary++; continue; }
      text = buf.toString('utf8');
    } else {
      const st = fs.statSync(f);
      if (!st.isFile()) {
        if (gitRoot && isGitlink(f)) { skippedSubmodule++; continue; }
        degraded.push({ file: f, kind: 'not-a-regular-file', detail: 'listed but not a regular file' });
        continue;
      }
      if (st.size > MAX_BYTES) {
        degraded.push({ file: f, kind: 'oversized-file', detail: `${st.size} bytes, over 1 MB, not scanned` });
        continue;
      }
      text = fs.readFileSync(f, 'utf8');
      if (text.indexOf(NUL) >= 0) { skippedBinary++; continue; }
    }
  } catch (e) {
    if (gitRoot && isGitlink(f)) { skippedSubmodule++; continue; }
    degraded.push({ file: f, kind: 'unreadable-file', detail: oneLine((e && e.code) || e).slice(0, 120) });
    continue;
  }

  scanned++;
  const baseName = f.split('/').pop() || '';
  const isDocOrRegistry = REGISTRY_FILES.has(baseName) || /\.md$/i.test(f);
  const lines = text.replace(/\r\n/g, '\n').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const muted = SUPPRESS.test(line) || (i > 0 && SUPPRESS.test(lines[i - 1]));

    for (const p of SECRET_PATTERNS) {
      const m = p.re.exec(line);
      if (!m) continue;
      if (!p.confident && PLACEHOLDER_CONTEXT.test(line)) continue;
      let value = null;
      if (p.literalOnly) {
        value = literalValue(m);
        if (value === null) continue;
      } else if (typeof p.valueGroup === 'number') {
        value = m[p.valueGroup];
      }
      if (muted) {
        suppressed.push({ file: f, line: i + 1, rule: p.id });
        continue;
      }
      findings.push({
        file: f,
        line: i + 1,
        rule: p.id,
        severity: 'error',
        excerpt: (value === null || value === undefined
          ? redactMatch(line, p.re)
          : redactValue(line, m, value)).trim().slice(0, 160),
      });
    }

    // 规则 2：非本地明文传输 http:// 与 ws://（不扫纯 Markdown 文档与包管理镜像配置，绝不误拦 https:// / wss://）
    if (!isDocOrRegistry) {
      const tm = INSECURE_TRANSPORT_RE.exec(line);
      if (tm) {
        if (muted) {
          suppressed.push({ file: f, line: i + 1, rule: 'no-insecure-transport' });
        } else {
          findings.push({
            file: f,
            line: i + 1,
            rule: 'no-insecure-transport',
            severity: 'error',
            excerpt: tm[0].slice(0, 160),
          });
        }
      }
    }
  }
}

const inScope = files.length - skippedAllowlisted - skippedBinary - skippedSubmodule;
if (inScope <= 0) {
  notes.push({ file: '(scope)', note: `nothing-in-scope:listed=${files.length} in-scope=0` });
}

const errors = findings.filter((f) => f.severity === 'error');
const warnings = findings.filter((f) => f.severity !== 'error');
const code = errors.length > 0 ? 1 : (degraded.length > 0 ? 3 : 0);
const status = code === 0 ? 'ok' : (code === 3 ? 'degraded' : 'violation');

if (!opts.json) {
  for (const f of findings) {
    err((f.severity === 'error' ? ' ERR  ' : ' warn ') + f.rule.padEnd(24) + `${f.file}:${f.line}  ${f.excerpt}\n`);
  }
  for (const s of suppressed) {
    err(' mute  ' + s.rule.padEnd(24) + `${s.file}:${s.line}  silenced by ignore comment\n`);
  }
  for (const d of degraded) {
    err(' DEGR  ' + d.kind.padEnd(24) + `  ${d.file}  ${d.detail}\n`);
  }
  err(`scan-secrets: source=${source} root=${workRoot} listed=${files.length} scanned=${scanned} errors=${errors.length} warnings=${warnings.length} suppressed=${suppressed.length} degraded=${degraded.length}\n`);
}

out(JSON.stringify({
  command: 'scan-secrets',
  status,
  code,
  ok: code === 0,
  summary: `scan-secrets：${errors.length} error / ${warnings.length} warning / ${degraded.length} degraded`,
  source,
  root: workRoot,
  listed: files.length,
  inScope,
  scanned,
  skipped: { binary: skippedBinary, allowlisted: skippedAllowlisted, submodule: skippedSubmodule },
  findings: findings.slice(0, MAX_REPORTED),
  errors: errors.slice(0, MAX_REPORTED),
  warnings: warnings.slice(0, MAX_REPORTED),
  suppressed: suppressed.slice(0, MAX_REPORTED),
  degraded: degraded.slice(0, MAX_REPORTED),
  notes: notes.slice(0, MAX_REPORTED),
  counts: {
    error: errors.length,
    warning: warnings.length,
    suppressed: suppressed.length,
    degraded: degraded.length,
  },
}) + '\n');

process.exitCode = code;
