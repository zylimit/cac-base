// PreToolUse(Bash|PowerShell|Shell)：密钥读取/拷贝/外传安全地板闸（profile.floor，任何档位永不降级）。
//
// 完整保留十一轮硬化逻辑（反向白名单 METADATA_VERBS + 线性双指针 globMatch + 壳层剥离 +
// 命令替换增量重扫 + cp .env.example .env 白名单防冒名 + 16KB/500 替换上限 + 截断 stdin 阻断），
// 并原生支持 Windows PowerShell 与 CodeAgent 宿主凭据防护：
//   1. Windows 反斜杠密钥路径（Get-Content C:\proj\.env、gc ~\.ssh\id_rsa、type .\.env 等）归一检测；
//   2. 宿主敏感凭据（CODEAGENT3_X_AUTH_TOKEN / X_AUTH_TOKEN / DEVUC_REFRESH_TOKEN / ENTERPRISE_API_KEY）读取/打印/外传拦截；
//   3. PowerShell Get-ChildItem Env: 及 $env:*SECRET|TOKEN|KEY* 管道或参数外传至 Invoke-WebRequest/Invoke-RestMethod/iwr/irm/curl 拦截；
//   4. powershell / pwsh -EncodedCommand / -enc Base64（UTF-16LE 与 UTF-8）自动解码递归重扫。

import { projectDir, readStdinRaw, say, runFailOpen } from './lib/io.mjs';
import { gateLog } from './lib/gatelog.mjs';

const MAX_CMD_BYTES = 16 * 1024;
const MAX_SUBSTITUTIONS = 500;

// 密钥文件名集合（含 .credentials.json 与 Windows/POSIX 双路径）
const SECRET_NAMES = '\\.env(\\.[A-Za-z0-9_-]+)?|id_rsa[A-Za-z0-9_.-]*|id_ed25519[A-Za-z0-9_.-]*|\\S*\\.(pem|ppk|p12|pfx|key)|\\.?credentials\\.json|\\.aws/credentials|\\.ssh/\\S+';
const SECRET_CORE = `(${SECRET_NAMES})([\\s"']|$)`;
const SECRET_PATH = new RegExp(`^([^\\s"']*/)?(${SECRET_NAMES})$`, 'i');

const TYPICAL_SECRET_NAMES = [
  '.env', '.env.local', '.env.production', 'id_rsa', 'id_ed25519',
  'key.pem', 'key.ppk', 'server.key', '.aws/credentials', '.ssh/id_rsa',
];

const ARGPFX = "\\s+([^|;&]*[\\s/\\\\\"'=@])?";
const ANCHOR = '(^|;|&&|\\|\\||`|\\$\\(|\\(|\\{)\\s*';
const NET_SINKS = '(curl|wget|nc|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)';
const HOST_TOKENS = '(CODEAGENT3_X_AUTH_TOKEN|X_AUTH_TOKEN|DEVUC_REFRESH_TOKEN|ENTERPRISE_API_KEY)';

const RULES = [
  // R1：宿主核心鉴权 Token 读取 / 打印 / 外传（POSIX $VAR、PowerShell $env:VAR / Env:VAR、CMD %VAR%、printenv、代码读取）
  {
    re: new RegExp(
      `(\\$\\{?(?:env:)?${HOST_TOKENS}\\b|%${HOST_TOKENS}%|\\bEnv:[/\\\\]?${HOST_TOKENS}\\b|\\bprintenv\\s+["']?${HOST_TOKENS}\\b|process\\.env\\.${HOST_TOKENS}\\b|process\\.env\\[["']${HOST_TOKENS}["']\\]|os\\.environ[^\\n]{0,40}${HOST_TOKENS}|GetEnvironmentVariable\\s*\\(\\s*["']${HOST_TOKENS}["'])`,
      'im',
    ),
    reason: '检测到读取或打印宿主受保护凭据环境变量（CODEAGENT3_X_AUTH_TOKEN / X_AUTH_TOKEN / DEVUC_REFRESH_TOKEN / ENTERPRISE_API_KEY）',
  },
  // R2：POSIX env/printenv/set 或 PowerShell Get-ChildItem Env: 整包管道外传
  {
    re: new RegExp(
      `${ANCHOR}(?:(?:env|printenv|set)\\b|(?:Get-ChildItem|gci|dir|ls|Get-Item|gi)\\s+Env:[A-Za-z0-9_*\\\\/]*)(?=\\s|\\||$)[^|]*\\|[^;\\n]*\\b${NET_SINKS}\\b`,
      'im',
    ),
    reason: '检测到环境变量整包管道外传（env / printenv / Get-ChildItem Env: | curl/iwr/irm）',
  },
  // R2b：网络外传命令参数中内联子表达式抓取 Get-ChildItem Env:
  {
    re: new RegExp(
      `\\b${NET_SINKS}\\b[^;\\n]*\\b(?:Get-ChildItem|gci|dir|Get-Item|gi)\\s+Env:`,
      'im',
    ),
    reason: '检测到网络请求携带 Env: 环境变量枚举输出（Invoke-WebRequest/Invoke-RestMethod/curl + Get-ChildItem Env:）',
  },
  // R2c：PowerShell 敏感环境变量（$env:*SECRET* / *TOKEN* / *KEY* / *PASS* / *CRED*）经管道或参数外传至网络命令
  {
    re: new RegExp(
      `(\\$\\{?env:[A-Za-z0-9_]*(?:SECRET|TOKEN|KEY|PASS|PWD|CRED)[A-Za-z0-9_]*\\}?[^;\\n]*\\|\\s*${NET_SINKS}\\b|\\b${NET_SINKS}\\b[^;\\n]*\\$\\{?env:[A-Za-z0-9_]*(?:SECRET|TOKEN|KEY|PASS|PWD|CRED)[A-Za-z0-9_]*\\}?)`,
      'im',
    ),
    reason: '检测到 PowerShell 敏感环境变量（$env:*SECRET/TOKEN/KEY*）向网络端点外传',
  },
  // R3b：网络命令直接携带密钥文件名
  {
    re: new RegExp(`${ANCHOR}${NET_SINKS}${ARGPFX}${SECRET_CORE}`, 'im'),
    reason: '检测到网络命令携带密钥文件（curl/wget/nc/iwr/irm + 密钥文件名）',
  },
];

const ARG_REASON = '检测到命令参数是密钥文件路径（.env/id_rsa/*.pem/credentials），且动词不在只碰元数据的放行表里';

const METADATA_VERBS = new Set([
  'ls', 'stat', 'test', '[', '[[', 'file', 'du', 'chmod', 'chown', 'chgrp',
  'rm', 'unlink', 'touch', 'mkdir', 'rmdir', 'cd', 'pushd', 'popd',
  'basename', 'dirname', 'realpath', 'readlink', 'which', 'echo', 'printf', 'find',
]);

const GIT_METADATA_SUBCOMMANDS = new Set(['ls-files', 'check-ignore', 'status', 'log']);
const GIT_LOG_CONTENT_FLAGS = /^(-p|--patch|-u|-L|-G|-S|--full-diff)/;

function gitLogHasContentFlag(tokens, subIdx) {
  for (let i = subIdx + 1; i < tokens.length; i += 1) {
    const bare = tokens[i].replace(/["']/g, '');
    if (GIT_LOG_CONTENT_FLAGS.test(bare)) return true;
  }
  return false;
}

const INTERPRETER_VERBS = new Set([
  'python', 'python2', 'python3', 'node', 'nodejs', 'ruby', 'perl', 'php', 'deno', 'bun', 'eval',
]);
const SHELL_C_VERBS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const PWSH_VERBS = new Set(['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe']);

function shellCPayloadIndex(verb, tokens, vi) {
  const lower = verb.toLowerCase();
  if (PWSH_VERBS.has(lower)) {
    let i = vi + 1;
    while (i < tokens.length) {
      const bare = tokens[i].replace(/["']/g, '').toLowerCase();
      if (bare === '-c' || bare === '-command') return i + 1 < tokens.length ? i + 1 : -1;
      if (bare === '-executionpolicy' || bare === '-ep' || bare === '-windowstyle' || bare === '-inputformat' || bare === '-outputformat') {
        i += 2;
        continue;
      }
      if (bare.startsWith('-')) { i += 1; continue; }
      // PowerShell 默认无 -File 时首个位置参数即 Command
      return i;
    }
    return -1;
  }
  if (!SHELL_C_VERBS.has(verb)) return -1;
  let i = vi + 1;
  while (i < tokens.length) {
    const bare = tokens[i].replace(/["']/g, '');
    if (bare === '-c') return i + 1 < tokens.length ? i + 1 : -1;
    if (bare === '-o') { i += 2; continue; }
    if (/^-[A-Za-z]+$/.test(bare)) {
      if (bare.includes('c')) return i + 1 < tokens.length ? i + 1 : -1;
      i += 1;
      continue;
    }
    return -1;
  }
  return -1;
}

const SINGLE_CARRIER_VERBS = new Set([
  'ssh', 'sudo', 'timeout', 'watch', 'nohup', 'xargs', 'parallel', 'eval',
  'iex', 'invoke-expression',
]);

const TWO_LEVEL_CARRIER_SUBS = {
  docker: new Set(['exec', 'run']),
  kubectl: new Set(['exec']),
  podman: new Set(['exec']),
};

const GREP_VERBS = new Set(['grep', 'egrep', 'fgrep', 'rg']);

const EXAMPLE_PLACEHOLDER = 'SAMPLEFILE';
function stripExamples(s) {
  return s.replace(/\.env\.(example|sample|template|schema|dist)[A-Za-z0-9_.-]*/gi, EXAMPLE_PLACEHOLDER);
}

const COPY_MOVE_VERBS = new Set(['cp', 'mv']);
const COPY_MOVE_FLAG = /^-[rRfnvpaiuLP]+$/;
const COPY_MOVE_SAMPLE_SRC = new RegExp(`^([^\\s"'<>|;&$\`]*[/\\\\])?${EXAMPLE_PLACEHOLDER}$`);
const COPY_MOVE_SEG_META = /[<>`$]/;

function copyMoveSampleTargetIndex(seg, tokens, vi, isPowerShellCmdlet = false) {
  if (COPY_MOVE_SEG_META.test(seg)) return -1;
  // 段内若含反斜杠但并非合法 Windows 路径分隔符（例如 \-t 伪装短选项）则回退全判
  if (/\\-/.test(seg)) return -1;
  if (isPowerShellCmdlet) {
    let namedSrcIdx = -1;
    let namedDstIdx = -1;
    const posIndices = [];
    for (let i = vi + 1; i < tokens.length; i += 1) {
      const rawTok = tokens[i];
      if (rawTok.startsWith('-')) {
        const flag = rawTok.toLowerCase();
        if (flag === '-path' || flag === '-literalpath' || flag === '-lp') {
          if (namedSrcIdx !== -1 || i + 1 >= tokens.length || tokens[i + 1].startsWith('-')) return -1;
          namedSrcIdx = i + 1;
          i += 1;
          continue;
        }
        if (flag === '-destination' || flag === '-dest') {
          if (namedDstIdx !== -1 || i + 1 >= tokens.length || tokens[i + 1].startsWith('-')) return -1;
          namedDstIdx = i + 1;
          i += 1;
          continue;
        }
        if (flag === '-force' || flag === '-recurse') continue;
        return -1;
      }
      posIndices.push(i);
    }
    let srcIdx = namedSrcIdx;
    let dstIdx = namedDstIdx;
    let p = 0;
    if (srcIdx === -1 && p < posIndices.length) srcIdx = posIndices[p++];
    if (dstIdx === -1 && p < posIndices.length) dstIdx = posIndices[p++];
    if (p !== posIndices.length || srcIdx === -1 || dstIdx === -1) return -1;
    const src = tokens[srcIdx].replace(/["']/g, '');
    if (!COPY_MOVE_SAMPLE_SRC.test(src) || tokenHits(tokens[srcIdx], false)) return -1;
    return dstIdx;
  }
  const operands = [];
  for (let i = vi + 1; i < tokens.length; i += 1) {
    if (tokens[i].startsWith('-')) {
      if (!COPY_MOVE_FLAG.test(tokens[i])) return -1;
      continue;
    }
    operands.push(i);
  }
  if (operands.length !== 2) return -1;
  const src = tokens[operands[0]].replace(/["']/g, '');
  if (!COPY_MOVE_SAMPLE_SRC.test(src) || tokenHits(tokens[operands[0]], false)) return -1;
  return operands[1];
}

const COPY_MOVE_IMPERSONATION = /(^|[\s;&|(`{'"])((function\s+)?(cp|mv)\s*\(\s*\)|function\s+(cp|mv)([\s{(]|$)|alias\s+(-\S+\s+)*(cp|mv)=|Set-Alias\s+[^\n;]*(cp|mv|Copy-Item|Move-Item|Test-Path)|(PATH|BASH_ENV|ENV|LD_[A-Za-z0-9_]+|DYLD_[A-Za-z0-9_]+)\+?=|\$env:PATH\s*\+?=)/i;
let cmdImpersonatesCopyMove = false;

const PREFIX_WRAPPERS = [
  /^\s+/,
  /^sudo\s+/,
  /^nohup\s+/,
  /^nice(\s+-n\s*[0-9]+)?\s+/,
  /^timeout(\s+--?[A-Za-z-]+(\s+\S+)?)*\s+[0-9]+[smhd]?\s+/,
  /^env(\s+[A-Za-z_][A-Za-z0-9_]*=\S*)*\s+/,
];

const SHELL_C_PREFIX = /^(?:(?:ba|z|da|k)?sh\s+-l?c|(?:powershell|pwsh)(?:\.exe)?(?:\s+-(?:NoProfile|nop|NonInteractive|noni|ExecutionPolicy\s+\S+|ep\s+\S+))*\s+-(?:c|Command))\s+(["'])/i;

function stripWrappers(cmd) {
  let c = cmd;
  let prev = null;
  for (let i = 0; i < 5 && c !== prev; i += 1) {
    prev = c;
    for (const re of PREFIX_WRAPPERS) c = c.replace(re, '');
    const m = SHELL_C_PREFIX.exec(c);
    if (m) {
      const q = m[1];
      c = c.slice(m[0].length);
      if (c.endsWith(q)) c = c.slice(0, -1);
    }
  }
  return c;
}

function splitSimple(cmd) {
  const out = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i];
    if (q) {
      cur += ch;
      if (ch === q) q = null;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
    } else if (ch === '$' && cmd[i + 1] === '(') {
      out.push(cur); cur = ''; i += 1;
    } else if (ch === '$' && cmd[i + 1] === '{') {
      const vm = /^\$\{[A-Za-z_][A-Za-z0-9_:]*\}/.exec(cmd.slice(i));
      if (vm) {
        cur += vm[0];
        i += vm[0].length - 1;
      } else {
        out.push(cur); cur = '';
      }
    } else if (/[;&|\n`(){}]/.test(ch)) {
      out.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function splitTokens(s) {
  const out = [];
  let cur = '';
  let q = null;
  for (const ch of s) {
    if (q) {
      cur += ch;
      if (ch === q) q = null;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
    } else if (/\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

const GLOB_PATTERN_MAX = 512;

function parseCharClass(pattern, start) {
  let i = start;
  let negate = false;
  if (pattern[i] === '!' || pattern[i] === '^') { negate = true; i += 1; }
  const items = [];
  while (i < pattern.length && pattern[i] !== ']') {
    const ch = pattern[i];
    if (pattern[i + 1] === '-' && i + 2 < pattern.length && pattern[i + 2] !== ']') {
      const from = ch;
      const to = pattern[i + 2];
      if (from.charCodeAt(0) > to.charCodeAt(0)) return null;
      items.push({ from, to });
      i += 3;
    } else {
      items.push({ from: ch, to: ch });
      i += 1;
    }
  }
  if (i >= pattern.length) return null;
  const matcher = (c) => {
    const hit = items.some((it) => c >= it.from && c <= it.to);
    return negate ? !hit : hit;
  };
  return { matcher, next: i + 1 };
}

function tokenizeGlob(pattern) {
  const tokens = [];
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') { tokens.push({ t: 'star' }); i += 1; }
    else if (ch === '?') { tokens.push({ t: 'any' }); i += 1; }
    else if (ch === '[') {
      const cls = parseCharClass(pattern, i + 1);
      if (cls) { tokens.push({ t: 'class', matcher: cls.matcher }); i = cls.next; }
      else { tokens.push({ t: 'lit', ch: '[' }); i += 1; }
    } else {
      tokens.push({ t: 'lit', ch });
      i += 1;
    }
  }
  return tokens;
}

function tokenMatchesChar(tok, ch) {
  if (tok.t === 'lit') return tok.ch === ch;
  if (tok.t === 'any') return true;
  if (tok.t === 'class') return tok.matcher(ch);
  return false;
}

function globMatch(tokens, text) {
  let ti = 0;
  let si = 0;
  let starTi = -1;
  let starSi = -1;
  const n = tokens.length;
  const m = text.length;
  while (si < m) {
    if (ti < n && tokens[ti].t === 'star') {
      starTi = ti; starSi = si; ti += 1;
    } else if (ti < n && tokenMatchesChar(tokens[ti], text[si])) {
      ti += 1; si += 1;
    } else if (starTi !== -1) {
      ti = starTi + 1; starSi += 1; si = starSi;
    } else {
      return false;
    }
  }
  while (ti < n && tokens[ti].t === 'star') ti += 1;
  return ti === n;
}

function globHits(bare) {
  if (!/[*?[]/.test(bare)) return false;
  if (bare.length > GLOB_PATTERN_MAX) return false;
  const tokens = tokenizeGlob(bare);
  if (tokens.some((t) => t.t === 'lit' || t.t === 'class')
      && TYPICAL_SECRET_NAMES.some((name) => globMatch(tokens, name))) return true;
  const slash = bare.lastIndexOf('/');
  if (slash === -1) return false;
  const filename = bare.slice(slash + 1);
  const fnTokens = tokenizeGlob(filename);
  if (!fnTokens.some((t) => t.t === 'lit' || t.t === 'class')) return false;
  return TYPICAL_SECRET_NAMES.some((name) => globMatch(fnTokens, name.slice(name.lastIndexOf('/') + 1)));
}

function colonSuffixHits(bare) {
  // 排除 Windows 盘符前缀（如 C:/foo）被误当成冒号后无斜杠的文件名（C:/foo 在 SECRET_PATH 已判，而 C:.env 仍可命中）
  const idx = bare.lastIndexOf(':');
  if (idx === -1) return false;
  if (bare.slice(idx + 1, idx + 3) === '//') return false;
  const suffix = bare.slice(idx + 1);
  if (!suffix) return false;
  return SECRET_PATH.test(suffix) || globHits(suffix);
}

// POSIX 去一层反斜杠转义（抓 cat \.env）
function shellWordText(t) {
  let out = '';
  let q = null;
  for (let i = 0; i < t.length; i += 1) {
    const ch = t[i];
    if (q === "'") { if (ch === "'") q = null; else out += ch; continue; }
    if (ch === '\\' && i + 1 < t.length) { out += t[i + 1]; i += 1; continue; }
    if (ch === '"') { q = q === '"' ? null : '"'; continue; }
    if (ch === "'" && !q) { q = "'"; continue; }
    out += ch;
  }
  return out;
}

// Windows PowerShell 路径归一：保留反斜杠为路径分隔符 `/`（抓 Get-Content C:\proj\.env、gc ~\.ssh\id_rsa）
function winWordPosix(t) {
  let out = '';
  let q = null;
  for (let i = 0; i < t.length; i += 1) {
    const ch = t[i];
    if (q) {
      if (ch === q) q = null;
      else out += (ch === '\\' ? '/' : ch);
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    out += (ch === '\\' ? '/' : ch);
  }
  return out;
}

function singlePathHits(candidate) {
  if (!candidate) return false;
  if (SECRET_PATH.test(candidate) || globHits(candidate) || colonSuffixHits(candidate)) return true;
  const eq = candidate.indexOf('=');
  if (eq > 0) {
    const val = candidate.slice(eq + 1);
    if (SECRET_PATH.test(val) || globHits(val)) return true;
  }
  return false;
}

function tokenHits(raw, scanNested) {
  const t = raw.replace(/^[0-9]*<{1,3}/, '').replace(/^@/, '');
  const posixEscaped = shellWordText(t);
  const winPosix = winWordPosix(t);
  if (singlePathHits(posixEscaped) || (winPosix !== posixEscaped && singlePathHits(winPosix))) {
    return true;
  }
  if (!scanNested) return false;
  const quoted = t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0];
  const inner = quoted ? t.slice(1, -1) : t;
  for (const m of inner.matchAll(/'([^']*)'|"([^"]*)"/g)) {
    const s = m[1] === undefined ? m[2] : m[1];
    const sPosix = s.replace(/\\/g, '/');
    if (SECRET_PATH.test(s) || globHits(s) || SECRET_PATH.test(sPosix) || globHits(sPosix)) return true;
  }
  return false;
}

function isNestedQuoteVerb(verb, tokens, vi) {
  const lower = verb.toLowerCase();
  if (INTERPRETER_VERBS.has(lower)) return true;
  return shellCPayloadIndex(verb, tokens, vi) !== -1;
}

function gitSubcommandIndex(tokens, vi) {
  for (let i = vi + 1; i < tokens.length; i += 1) {
    const bare = tokens[i].replace(/["']/g, '');
    if (!bare.startsWith('-')) return i;
  }
  return -1;
}

function isAllowedVerb(verb, tokens, vi) {
  const lower = verb.toLowerCase();
  // 注意：POSIX type 在 Windows CMD/PowerShell 中是文件内容读取命令（同 cat），绝不进 METADATA_VERBS！
  if (METADATA_VERBS.has(verb) || (lower === 'test-path' && !cmdImpersonatesCopyMove)) return true;
  if (lower === 'git' || lower === 'git.exe') {
    const subIdx = gitSubcommandIndex(tokens, vi);
    if (subIdx === -1) return false;
    const sub = tokens[subIdx].replace(/["']/g, '');
    if (!GIT_METADATA_SUBCOMMANDS.has(sub)) return false;
    if (sub === 'log' && gitLogHasContentFlag(tokens, subIdx)) return false;
    return true;
  }
  return false;
}

function grepTokensToCheck(tokens, vi) {
  const toCheck = [];
  let patternHandled = false;
  let optionsEnded = false;
  let i = vi + 1;
  while (i < tokens.length) {
    const raw = tokens[i];
    const bare = raw.replace(/["']/g, '');
    if (!optionsEnded && bare === '--') {
      optionsEnded = true;
      i += 1;
      if (!patternHandled && i < tokens.length) {
        patternHandled = true;
        i += 1;
      }
      continue;
    }
    if (!optionsEnded && (bare === '-e' || bare === '--regexp')) {
      patternHandled = true;
      i += 2;
      continue;
    }
    if (!optionsEnded && /^--regexp=/.test(bare)) {
      patternHandled = true;
      i += 1;
      continue;
    }
    if (!optionsEnded && (bare === '-f' || bare === '--file')) {
      patternHandled = true;
      toCheck.push(raw);
      i += 1;
      continue;
    }
    if (!optionsEnded && bare.startsWith('-')) {
      toCheck.push(raw);
      i += 1;
      continue;
    }
    if (!patternHandled) {
      patternHandled = true;
      i += 1;
      continue;
    }
    toCheck.push(raw);
    i += 1;
  }
  return toCheck;
}

function checkSimple(seg) {
  const tokens = splitTokens(seg);
  let vi = 0;
  while (vi < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[vi]) || /^\$env:[A-Za-z_][A-Za-z0-9_]*=/i.test(tokens[vi]))) {
    vi += 1;
  }
  if (vi >= tokens.length) return false;
  const rawVerb = tokens[vi].replace(/["']/g, '');
  const verb = rawVerb.replace(/^.*[/\\]/, '');
  const lowerVerb = verb.toLowerCase();

  if (verb === 'source' || verb === '.' || (verb === 'hash' && tokens.slice(vi + 1).some((t) => /^-[A-Za-z]*p/.test(t)))) {
    cmdImpersonatesCopyMove = true;
  }
  if (verb === 'builtin' || verb === 'command') {
    const next = tokens.slice(vi + 1).find((t) => !t.startsWith('-'));
    if (next !== undefined && /^(source|\.)$/.test(next.replace(/["']/g, ''))) cmdImpersonatesCopyMove = true;
  }
  if (verb === 'trap' && tokens.slice(vi + 1).some((t) => /^(DEBUG|EXIT|ERR|RETURN)$/.test(t.replace(/["']/g, '')))) {
    const action = tokens.slice(vi + 1).find((t) => !t.startsWith('-'));
    if (action !== undefined && /(^|[\s;&|(])(source|\.)\s/.test(action.replace(/^["']|["']$/g, ''))) cmdImpersonatesCopyMove = true;
  }
  if (isAllowedVerb(verb, tokens, vi)) return false;

  const scanNested = isNestedQuoteVerb(verb, tokens, vi);
  let checkTokens = tokens;
  if (GREP_VERBS.has(verb)) {
    checkTokens = tokens.slice(0, vi + 1).concat(grepTokensToCheck(tokens, vi));
  } else if ((COPY_MOVE_VERBS.has(verb) && rawVerb === verb && !cmdImpersonatesCopyMove)
      || ((lowerVerb === 'copy-item' || lowerVerb === 'move-item') && rawVerb.toLowerCase() === lowerVerb && !cmdImpersonatesCopyMove)) {
    const isPsCmdlet = lowerVerb === 'copy-item' || lowerVerb === 'move-item';
    const ti = copyMoveSampleTargetIndex(seg, tokens, vi, isPsCmdlet);
    if (ti !== -1) checkTokens = tokens.filter((_, i) => i !== ti);
  }
  return checkTokens.some((t) => tokenHits(t, scanNested));
}

function isFullyQuoted(t) {
  return t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0];
}

function isCommandCarrier(verb, tokens, vi) {
  const lower = verb.toLowerCase();
  if (SINGLE_CARRIER_VERBS.has(verb) || SINGLE_CARRIER_VERBS.has(lower)) return true;
  if (verb === 'su') return tokens.some((t) => t.replace(/["']/g, '') === '-c');
  if (shellCPayloadIndex(verb, tokens, vi) !== -1) return true;
  const subs = TWO_LEVEL_CARRIER_SUBS[lower];
  if (!subs) return false;
  const next = tokens[vi + 1] ? tokens[vi + 1].replace(/["']/g, '').toLowerCase() : null;
  return next !== null && subs.has(next);
}

function carrierHits(seg, depth) {
  const tokens = splitTokens(seg);
  let vi = 0;
  while (vi < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[vi])) vi += 1;
  if (vi >= tokens.length) return false;
  if (isFullyQuoted(tokens[vi]) && /\s/.test(tokens[vi])) return scanSegments(tokens[vi].slice(1, -1), depth + 1);
  const verb = tokens[vi].replace(/["']/g, '').replace(/^.*[/\\]/, '');
  if (!isCommandCarrier(verb, tokens, vi)) return false;
  for (let i = vi + 1; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (!isFullyQuoted(t)) continue;
    const inner = t.slice(1, -1);
    for (const r of RULES) {
      if (r.re.test(inner)) return true;
    }
    if (scanSegments(inner, depth + 1)) return true;
  }
  return false;
}

function segmentHasSecretToken(seg) {
  const tokens = splitTokens(seg);
  let vi = 0;
  while (vi < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[vi])) vi += 1;
  const verb = vi < tokens.length ? tokens[vi].replace(/["']/g, '').replace(/^.*[/\\]/, '') : '';
  const scanNested = vi < tokens.length && isNestedQuoteVerb(verb, tokens, vi);
  return tokens.some((t) => tokenHits(t, scanNested));
}

const SAFE_FOREACH_PROPS = new Set([
  'name', 'fullname', 'basename', 'extension', 'directory', 'directoryname',
  'length', 'exists', 'attributes', 'mode', 'lastwritetime', 'creationtime',
]);

function extractBraceBlocks(s) {
  const blocks = [];
  let q = null;
  let depth = 0;
  let start = -1;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (q) {
      if (ch === '\\' && q === '"' && i + 1 < s.length) { i += 1; continue; }
      if (ch === q) q = null;
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === '$' && s[i + 1] === '{') {
      const vm = /^\$\{[A-Za-z_][A-Za-z0-9_:]*\}/.exec(s.slice(i));
      if (vm) { i += vm[0].length - 1; continue; }
    }
    if (ch === '{') {
      if (depth === 0) start = i + 1;
      depth += 1;
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        blocks.push(s.slice(start, i));
        start = -1;
      }
    }
  }
  return blocks;
}

function extractInlineSubstitutions(s) {
  const subs = [];
  let q = null;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (q === "'") { if (ch === "'") q = null; continue; }
    if (ch === '\\') { i += 1; continue; }
    if (ch === '$' && s[i + 1] === '(') {
      const start = i + 2;
      const end = substitutionEnd(s, start, false);
      subs.push(s.slice(start, end === -1 ? s.length : end));
      if (end === -1) break;
      i = end;
      continue;
    }
    if (ch === '`') {
      const start = i + 1;
      const end = substitutionEnd(s, start, true);
      if (end !== -1) {
        subs.push(s.slice(start, end));
        i = end;
        continue;
      }
    }
    if (q === '"') { if (ch === '"') q = null; continue; }
    if (ch === '"' || ch === "'") q = ch;
  }
  return subs;
}

function foreachScriptTriggers(body, depth = 0) {
  if (depth > 3) return false;
  if (/\[[^\]]+\]::|\.\s*(?:OpenRead|OpenText|ReadAllText|ReadAllBytes|ReadAllLines)\b/i.test(body)) {
    return true;
  }
  if (RULES.some((r) => r.re.test(body))) return true;
  for (const sub of extractInlineSubstitutions(body)) {
    if (foreachScriptTriggers(sub, depth + 1)) return true;
  }
  for (const seg of splitSimple(body)) {
    let s = stripWrappers(seg).trim();
    s = s.replace(/^(?:\$(?:env:)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*|[A-Za-z_][A-Za-z0-9_]*=\S*\s+|&\s+)+/i, '').trim();
    if (!s) continue;
    const stoks = splitTokens(s);
    if (!stoks.length) continue;
    const sverb = stoks[0].replace(/["']/g, '').replace(/^.*[/\\]/, '');
    const slower = sverb.toLowerCase();
    if (slower === 'foreach-object' || slower === '%') {
      if (laterSegmentTriggersBlock(s, depth + 1)) return true;
      continue;
    }
    if (!isAllowedVerb(sverb, stoks, 0)) return true;
  }
  return false;
}

function laterSegmentTriggersBlock(seg, depth = 0) {
  if (depth > 3) return false;
  const tokens = splitTokens(seg);
  let vi = 0;
  while (vi < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[vi]) || /^\$env:[A-Za-z_][A-Za-z0-9_]*=/i.test(tokens[vi]))) {
    vi += 1;
  }
  if (vi >= tokens.length) return false;
  const verb = tokens[vi].replace(/["']/g, '').replace(/^.*[/\\]/, '').toLowerCase();
  if (verb === 'get-content' || verb === 'gc' || verb === 'select-string' || verb === 'sls'
      || verb === 'invoke-webrequest' || verb === 'invoke-restmethod' || verb === 'iwr' || verb === 'irm') {
    return true;
  }
  if (verb === 'foreach-object' || verb === '%') {
    const blocks = extractBraceBlocks(seg);
    if (blocks.length === 0) {
      for (let i = vi + 1; i < tokens.length; i += 1) {
        const bare = tokens[i].replace(/["']/g, '');
        if (bare.startsWith('-')) continue;
        if (!SAFE_FOREACH_PROPS.has(bare.toLowerCase()) && !isAllowedVerb(bare, tokens, i)) return true;
      }
      return false;
    }
    return blocks.some((b) => foreachScriptTriggers(b, depth + 1));
  }
  if (verb !== 'xargs' && verb !== 'parallel') return false;
  for (let i = vi + 1; i < tokens.length; i += 1) {
    const bare = tokens[i].replace(/["']/g, '');
    if (bare.startsWith('-')) continue;
    if (!isAllowedVerb(bare, tokens, i)) return true;
  }
  return false;
}

function splitChains(cmd) {
  const chains = [];
  let chain = [];
  let cur = '';
  let q = null;
  let braceDepth = 0;
  const endSeg = () => { chain.push(cur); cur = ''; };
  const endChain = () => { endSeg(); chains.push(chain); chain = []; };
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i];
    if (q) {
      if (ch === '\\' && q === '"' && i + 1 < cmd.length) {
        cur += ch + cmd[i + 1];
        i += 1;
        continue;
      }
      cur += ch;
      if (ch === q) q = null;
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '$' && cmd[i + 1] === '{') {
      const vm = /^\$\{[A-Za-z_][A-Za-z0-9_:]*\}/.exec(cmd.slice(i));
      if (vm) {
        cur += vm[0];
        i += vm[0].length - 1;
        continue;
      }
    }
    if (ch === '{') {
      if (braceDepth === 0 && cur.trim() === '') {
        endChain();
      } else {
        braceDepth += 1;
        cur += ch;
      }
      continue;
    }
    if (ch === '}') {
      if (braceDepth > 0) {
        braceDepth -= 1;
        cur += ch;
      } else {
        endChain();
      }
      continue;
    }
    if (braceDepth > 0) {
      cur += ch;
      continue;
    }
    if (ch === '$' && cmd[i + 1] === '(') { endChain(); i += 1; continue; }
    if (ch === '|' && cmd[i + 1] === '|') { endChain(); i += 1; continue; }
    if (ch === '&' && cmd[i + 1] === '&') { endChain(); i += 1; continue; }
    if (ch === '|') { endSeg(); continue; }
    if (/[;&\n`()]/.test(ch)) { endChain(); continue; }
    cur += ch;
  }
  endChain();
  return chains
    .map((segs) => segs.map((s) => s.trim()).filter(Boolean))
    .filter((segs) => segs.length > 0);
}

function pipelineForwardHits(cmd) {
  for (const chain of splitChains(cmd)) {
    if (chain.length < 2) continue;
    const segs = chain.map((seg) => stripWrappers(seg));
    for (let i = 0; i < segs.length - 1; i += 1) {
      if (!segmentHasSecretToken(segs[i])) continue;
      for (let j = i + 1; j < segs.length; j += 1) {
        if (laterSegmentTriggersBlock(segs[j])) return true;
      }
    }
  }
  return false;
}

function substitutionEnd(cmd, start, backtick) {
  if (backtick) {
    for (let i = start; i < cmd.length; i += 1) {
      if (cmd[i] === '\\') { i += 1; continue; }
      if (cmd[i] === '`') return i;
    }
    return -1;
  }
  let depth = 1;
  let q = null;
  for (let i = start; i < cmd.length; i += 1) {
    const ch = cmd[i];
    if (q === "'") { if (ch === "'") q = null; continue; }
    if (ch === '\\') { i += 1; continue; }
    if (q) { if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") q = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

const SUBST_PLACEHOLDER = '$(SUBST)';
function prefixVerbIndex(tokens) {
  let vi = 0;
  for (let guard = 0; guard < 8; guard += 1) {
    while (vi < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[vi])) vi += 1;
    const w = tokens[vi];
    if (w === 'sudo' || w === 'nohup' || w === 'env') { vi += 1; continue; }
    if (w === 'nice') { vi += tokens[vi + 1] === '-n' ? 3 : 1; continue; }
    if (w === 'timeout') {
      vi += 1;
      while (vi < tokens.length && tokens[vi].startsWith('-')) vi += 1;
      vi += 1;
      continue;
    }
    if (w !== undefined && /^(ba|z|da|k)?sh$/.test(w) && /^-l?c$/.test(tokens[vi + 1] || '')) { vi += 2; continue; }
    break;
  }
  return vi;
}

function substitutionArgHits(cmd, depth) {
  let tokens = [];
  let scanned = 0;
  let q = null;
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i];
    if (q === "'") { if (ch === "'") q = null; continue; }
    const isDollar = ch === '$' && cmd[i + 1] === '(';
    if (ch === '\\') { i += 1; continue; }
    if (isDollar || ch === '`') {
      const innerStart = i + (isDollar ? 2 : 1);
      const found = substitutionEnd(cmd, innerStart, !isDollar);
      const end = found === -1 ? cmd.length : found;
      let inner = cmd.slice(innerStart, end);
      if (!isDollar) inner = inner.replace(/\\([`\\$])/g, '$1');
      if (depth < 3 && scanSegments(inner, depth + 1)) return true;
      if (found === -1 && depth < 3 && scanSegments(inner.replace(/["']/g, ''), depth + 1)) return true;
      for (const t of splitTokens(cmd.slice(scanned, i).replace(/["']/g, ''))) {
        if (t.replace(/@/g, '') !== '') tokens.push(t);
      }
      const vi = prefixVerbIndex(tokens);
      if (vi < tokens.length) {
        const verb = tokens[vi].replace(/^.*[/\\]/, '');
        if (!isAllowedVerb(verb, tokens, vi) && splitTokens(inner.replace(/\\(.)/g, '$1')).some((t) => tokenHits(t, false))) {
          return true;
        }
      }
      tokens.push(SUBST_PLACEHOLDER);
      i = end;
      scanned = end + 1;
      continue;
    }
    if (q === '"') { if (ch === '"') q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (/[;&|\n()]/.test(ch)) { tokens = []; scanned = i + 1; }
  }
  return false;
}

function scanSegments(cmd, depth) {
  if (pipelineForwardHits(cmd)) return true;
  if (substitutionArgHits(cmd, depth)) return true;
  for (const seg of splitSimple(cmd)) {
    const bare = stripWrappers(seg);
    if (bare !== seg && depth < 3) {
      if (scanSegments(bare, depth + 1)) return true;
      continue;
    }
    if (checkSimple(bare)) return true;
    if (depth < 3 && carrierHits(bare, depth)) return true;
  }
  return false;
}

// PowerShell -EncodedCommand / -enc / -en / -ec / -e 及 `/` 开关前缀缩写 Base64 解码递归重扫（兼容 UTF-16LE 与 UTF-8）
const PWSH_ENC_FLAG = '(?:ec|e(?:n(?:c(?:o(?:d(?:e(?:d(?:c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?)?)?)?)?)?)?)?)';
const PWSH_ENC_RE = new RegExp(
  `\\b(?:powershell|pwsh)(?:\\.exe)?\\b[^\\n;|&]*?\\s[-/]${PWSH_ENC_FLAG}(?:\\s+|:)\\s*["']?([A-Za-z0-9+/=]{4,})["']?`,
  'gi',
);

function checkEncodedPowerShell(cmd, encDepth) {
  if (encDepth >= 3) return null;
  PWSH_ENC_RE.lastIndex = 0;
  const matches = [...cmd.matchAll(PWSH_ENC_RE)];
  for (const m of matches) {
    const b64 = m[1];
    let buf;
    try { buf = Buffer.from(b64, 'base64'); } catch (_e) { continue; }
    if (!buf.length) continue;
    const candidates = new Set();
    // PowerShell 标准 -EncodedCommand 为 UTF-16LE
    const u16 = buf.toString('utf16le').replace(/\0/g, '').trim();
    if (u16) candidates.add(u16);
    const u8 = buf.toString('utf8').replace(/\0/g, '').trim();
    if (u8) candidates.add(u8);
    for (const decoded of candidates) {
      const hit = checkOne(decoded, encDepth + 1);
      if (hit) return `检测到 PowerShell -EncodedCommand 编码载荷命中密钥防护（${hit}）`;
    }
  }
  return null;
}

function checkOne(cmd, encDepth = 0) {
  const encHit = checkEncodedPowerShell(cmd, encDepth);
  if (encHit) return encHit;
  const c = stripExamples(cmd);
  cmdImpersonatesCopyMove = COPY_MOVE_IMPERSONATION.test(c);
  for (const r of RULES) {
    if (r.re.test(c)) return r.reason;
  }
  return scanSegments(c, 0) ? ARG_REASON : null;
}

runFailOpen(() => {
  const raw = readStdinRaw();
  let ev = {};
  if (raw.trim()) {
    try {
      ev = JSON.parse(raw);
    } catch (_e) {
      const root = projectDir(null);
      const why = `stdin 非空但解析不出（${Buffer.byteLength(raw, 'utf8')} 字节，可能是事件截断），安全闸直接阻断`;
      process.exitCode = 2;
      say(`⛔ [secret-exfil-guard] ${why}，已拦截。`);
      gateLog('secret-exfil-guard', why, root);
      return;
    }
  }
  if (!ev || typeof ev !== 'object' || typeof ev.tool_input !== 'object' || ev.tool_input === null) {
    say('[secret-exfil-guard] stdin 不是可解析的 PreToolUse 事件（截断 / 空 / null），本次未判定、降级放行。');
    return;
  }

  const root = projectDir(ev);
  const cmd = String(ev.tool_input.command || '');
  if (!cmd) return;

  const substCount = (cmd.match(/\$\(/g) || []).length + Math.ceil((cmd.match(/`/g) || []).length / 2);
  if ((substCount >= 1 && Buffer.byteLength(cmd, 'utf8') > MAX_CMD_BYTES) || substCount > MAX_SUBSTITUTIONS) {
    const why = `命令过长或命令替换过多（${Buffer.byteLength(cmd, 'utf8')} 字节、${substCount} 个替换，上限 ${MAX_CMD_BYTES} 字节 / ${MAX_SUBSTITUTIONS} 个），安全闸直接阻断`;
    process.exitCode = 2;
    say(`⛔ [secret-exfil-guard] ${why}，已拦截。`);
    gateLog('secret-exfil-guard', why, root);
    return;
  }

  const stripped = stripWrappers(cmd);
  const reason = checkOne(cmd, 0) || (stripped !== cmd ? checkOne(stripped, 0) : null);
  if (!reason) return;

  process.exitCode = 2;
  say(`⛔ [secret-exfil-guard] ${reason}，已拦截。`);
  say('密钥与隐私属于不可旁路的安全地板，任何档位（含 fast）均不豁免。正确做法：');
  say('- 需要了解配置结构 → 读取 .env.example 或文档，禁止读取真实密钥文件');
  say('- 只需确认文件存在/大小 → 使用 ls / stat / test / Test-Path 等元数据命令');
  say('- 确需轮换或迁移密钥 → 停下来向用户说明并由用户亲自执行');
  say('- 严禁读取或外传 CODEAGENT3_X_AUTH_TOKEN 等宿主鉴权凭据或整包导出 Env:');
  gateLog('secret-exfil-guard', reason, root);
});
