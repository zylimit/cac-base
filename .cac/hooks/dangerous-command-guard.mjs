// PreToolUse(Bash|PowerShell|Shell)：危险与破坏性命令安全地板闸（profile.floor，任何档位永不降级）。
//
// 合并两类高危拦截（同时覆盖 POSIX Bash、Windows PowerShell 与 CMD，跳过纯引号字符串参数避免误伤 echo/commit）：
//   1. pkill -f 宽泛进程杀死（防误杀主 Agent 宿主进程）；
//   2. 不可逆破坏性命令：
//      - rm -rf / 、rm -rf /* 、rm -rf ~ 、rm -rf ..
//      - git reset --hard 、git clean -fdx/-fd 、git push --force/-f
//      - mkfs* 、dd of=/dev/* 、fdisk / parted / diskpart
//      - PowerShell Remove-Item / ri / del / rd / rmdir 带 -Recurse + -Force 删根/盘符/家目录/上级目录
//      - PowerShell Format-Volume 、Clear-Disk 、Initialize-Disk 、Remove-Partition 、format c:
//      - cmd /c rd /s /q（及直接 rd /s /q 删根/盘符/上级）
//      - powershell / pwsh -EncodedCommand / -enc Base64 编码隐藏的上述危险命令

import { projectDir, readStdinJson, say, runFailOpen } from './lib/io.mjs';
import { gateLog } from './lib/gatelog.mjs';

// 逐段剥除前缀 wrapper 后对未加引号的真实命令段判定，避免误拦 echo "rm -rf /" 或 git commit -m "ban git reset --hard"
function splitUnquotedSegments(cmd) {
  const out = [];
  let cur = '';
  let q = null;
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
    if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
      continue;
    }
    if (ch === '$' && cmd[i + 1] === '(') {
      out.push(cur);
      cur = '';
      i += 1;
      continue;
    }
    if (ch === '$' && cmd[i + 1] === '{') {
      const vm = /^\$\{[A-Za-z_][A-Za-z0-9_:]*\}/.exec(cmd.slice(i));
      if (vm) {
        cur += vm[0];
        i += vm[0].length - 1;
        continue;
      }
    }
    if (/[;&|\n`(){}]/.test(ch)) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function findParenEnd(cmd, start, escapeBackslash) {
  let depth = 1;
  let q = null;
  for (let i = start; i < cmd.length; i += 1) {
    const ch = cmd[i];
    if (q === "'") {
      if (ch === "'") q = null;
      continue;
    }
    if (escapeBackslash && ch === '\\') {
      i += 1;
      continue;
    }
    if (q) {
      if (ch === q) q = null;
      continue;
    }
    if (ch === '"' || ch === "'") q = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// 提取双引号 "..." 内未转义的 $(...) 与 `...` 命令替换供递归审查
function extractDoubleQuotedSubstitutions(cmd) {
  const subs = [];
  let q = null;
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i];
    if (q === "'") {
      if (ch === "'") q = null;
      continue;
    }
    if (q === '"') {
      if (ch === '\\' && i + 1 < cmd.length && /[\\"$`]/.test(cmd[i + 1])) {
        i += 1;
        continue;
      }
      if (ch === '"') {
        q = null;
        continue;
      }
      if (ch === '$' && cmd[i + 1] === '(') {
        const start = i + 2;
        let end = findParenEnd(cmd, start, true);
        if (end === -1) end = findParenEnd(cmd, start, false);
        if (end !== -1) {
          subs.push(cmd.slice(start, end));
          i = end;
        } else {
          subs.push(cmd.slice(start));
          break;
        }
        continue;
      }
      if (ch === '`') {
        let end = -1;
        for (let j = i + 1; j < cmd.length; j += 1) {
          if (cmd[j] === '\\' && j + 1 < cmd.length && /[\\"$`]/.test(cmd[j + 1])) {
            j += 1;
            continue;
          }
          if (cmd[j] === '"') break;
          if (cmd[j] === '`') {
            end = j;
            break;
          }
        }
        if (end !== -1) {
          subs.push(cmd.slice(i + 1, end).replace(/\\([`\\$"])/g, '$1'));
          i = end;
          continue;
        }
      }
      continue;
    }
    if (ch === '\\' && i + 1 < cmd.length && /[\\"']/.test(cmd[i + 1])) {
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
    }
  }
  return subs;
}

function splitTokens(s) {
  const out = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
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

const WRAPPER_VERBS = new Set(['sudo', 'nohup', 'command', 'env', '&']);
const SHELL_CARRIERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe']);

function unquote(t) {
  if (t.length >= 2 && ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'"))) {
    return t.slice(1, -1);
  }
  return t;
}

// 判断目标路径是否为根、盘符根、家目录或上级目录（高危越界删除目标）
function isCatastrophicTarget(rawTarget) {
  const t = unquote(rawTarget).trim();
  if (!t || t.startsWith('-')) return false;
  // POSIX / Windows 根与通配：/  /*  \  \*
  if (/^[/\\]+\*?$/.test(t)) return true;
  // Windows 盘符根：C:  C:\  C:/  C:\*  C:/*
  if (/^[A-Za-z]:(?:[/\\]+\*?|[/\\]*)?$/.test(t)) return true;
  // 家目录：~  ~/  ~/*  ~\  $HOME  ${HOME}  $env:USERPROFILE  $env:HOME  %USERPROFILE%
  if (/^(?:~(?:[/\\]\*?)?|\$\{?HOME\}?(?:[/\\]\*?)?|\$\{?env:(?:USERPROFILE|HOME|HOMEDRIVE)\}?(?:[/\\]\*?)?|%USERPROFILE%(?:[/\\]\*?)?)$/i.test(t)) {
    return true;
  }
  // 上级逃逸：..  ../  ../*  ..\  ..\*
  if (/^\.\.(?:[/\\].*|$)/.test(t)) return true;
  return false;
}

function checkRmSegment(tokens, vi) {
  let hasRecursive = false;
  let hasForce = false;
  const targets = [];
  let optsDone = false;
  for (let i = vi + 1; i < tokens.length; i += 1) {
    const raw = tokens[i];
    const bare = unquote(raw);
    if (!optsDone && bare === '--') { optsDone = true; continue; }
    if (!optsDone && bare.startsWith('--')) {
      if (bare === '--recursive') hasRecursive = true;
      else if (bare === '--force') hasForce = true;
      else if (bare === '--no-preserve-root') return '检测到 rm --no-preserve-root 毁灭性选项';
      continue;
    }
    if (!optsDone && bare.startsWith('-') && bare.length > 1) {
      if (/[rR]/.test(bare)) hasRecursive = true;
      if (/f/.test(bare)) hasForce = true;
      continue;
    }
    targets.push(raw);
  }
  if (hasRecursive && hasForce && targets.some(isCatastrophicTarget)) {
    return '检测到 rm -rf 指向根目录 / 家目录 / 上级目录的高危删除命令';
  }
  return null;
}

const PS_REMOVE_VERBS = new Set(['remove-item', 'ri', 'del', 'erase', 'rd', 'rmdir']);

function checkPowerShellRemoveSegment(tokens, vi) {
  let hasRecurse = false;
  let hasForce = false;
  const targets = [];
  for (let i = vi + 1; i < tokens.length; i += 1) {
    const bare = unquote(tokens[i]);
    const lower = bare.toLowerCase();
    if (/^-(?:r|rec|recurse)(?::\$?true)?$/.test(lower)) { hasRecurse = true; continue; }
    if (/^-(?:fo|force)(?::\$?true)?$/.test(lower)) { hasForce = true; continue; }
    if (lower === '-path' || lower === '-literalpath' || lower === '-lp') continue;
    if (bare.startsWith('-')) continue;
    targets.push(tokens[i]);
  }
  if (hasRecurse && hasForce && targets.some(isCatastrophicTarget)) {
    return '检测到 PowerShell Remove-Item -Recurse -Force 指向根目录 / 盘符 / 家目录 / 上级目录的高危删除';
  }
  return null;
}

function checkGitSegment(tokens, vi) {
  // 找 git 子命令（跳过 -C <dir> / -c <k=v> 等全局选项）
  let i = vi + 1;
  while (i < tokens.length) {
    const bare = unquote(tokens[i]);
    if (bare === '-C' || bare === '-c' || bare === '--git-dir' || bare === '--work-tree') {
      i += 2;
      continue;
    }
    if (bare.startsWith('-')) { i += 1; continue; }
    break;
  }
  if (i >= tokens.length) return null;
  const sub = unquote(tokens[i]);
  const rest = tokens.slice(i + 1).map(unquote);

  if (sub === 'reset' && rest.includes('--hard')) {
    return '检测到 git reset --hard（会丢弃未提交工作区改动，需拆分为安全操作或由用户确认）';
  }
  if (sub === 'clean' && rest.some((a) => /^-[A-Za-z]*f/.test(a) && (/[dx]/.test(a) || rest.some((b) => /^-[A-Za-z]*[dx]/.test(b))))) {
    return '检测到 git clean -fd/-fdx（会永久删除未跟踪文件）';
  }
  if (sub === 'push' && rest.some((a) => a === '-f' || a === '--force' || a.startsWith('--force='))) {
    return '检测到 git push --force / -f（强制覆盖远端分支属于 HIGH 档受控操作）';
  }
  return null;
}

function checkSegment(seg, depth) {
  if (depth > 4) return null;
  const tokens = splitTokens(seg);
  let vi = 0;
  while (vi < tokens.length) {
    const t = unquote(tokens[vi]);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || /^\$env:[A-Za-z_][A-Za-z0-9_]*=/i.test(t)) {
      vi += 1;
      continue;
    }
    if (WRAPPER_VERBS.has(t)) {
      vi += 1;
      continue;
    }
    break;
  }
  if (vi >= tokens.length) return null;

  const verbRaw = unquote(tokens[vi]);
  const verb = verbRaw.replace(/^.*[/\\]/, '');
  const lower = verb.toLowerCase();

  // 1. Shell / PowerShell / eval / iex 载体递归检查内层命令
  if (SHELL_CARRIERS.has(lower) || lower === 'eval' || lower === 'iex' || lower === 'invoke-expression') {
    for (let i = vi + 1; i < tokens.length; i += 1) {
      const tok = tokens[i];
      if (tok.length >= 2 && (tok[0] === '"' || tok[0] === "'") && tok[tok.length - 1] === tok[0]) {
        const innerHit = checkCommand(tok.slice(1, -1), depth + 1);
        if (innerHit) return innerHit;
      }
    }
  }

  // 2. CMD /c rd /s /q 或直接 rd /s /q 删高危目录
  if (lower === 'cmd' || lower === 'cmd.exe') {
    const restJoined = tokens.slice(vi + 1).map(unquote).join(' ');
    if (/(?:^|\s)\/[ck]\s+.*\b(?:rd|rmdir)\b(?=[^\n]*\/s\b)(?=[^\n]*\/q\b)/i.test(restJoined)) {
      return '检测到 cmd /c rd /s /q 强制递归静默删除命令';
    }
    if (/(?:^|\s)\/[ck]\s+.*\bformat\s+[A-Za-z]:/i.test(restJoined)) {
      return '检测到 cmd /c format 磁盘格式化命令';
    }
  }
  if ((lower === 'rd' || lower === 'rmdir')
      && tokens.slice(vi + 1).some((a) => /^\/s$/i.test(unquote(a)))
      && tokens.slice(vi + 1).some((a) => /^\/q$/i.test(unquote(a)))) {
    const targets = tokens.slice(vi + 1).filter((a) => !unquote(a).startsWith('/'));
    if (targets.length === 0 || targets.some(isCatastrophicTarget)) {
      return '检测到 rd /s /q 指向高危目录的强制删除命令';
    }
  }

  // 3. pkill -f 宽泛匹配防误杀宿主进程
  if (verb === 'pkill' && tokens.slice(vi + 1).some((a) => /^-[A-Za-z]*f/.test(unquote(a)))) {
    return '检测到 pkill -f 宽泛匹配（极易误杀主 Agent 宿主进程；请先用 ps/pgrep 查精确 PID 再 kill <PID>）';
  }

  // 4. POSIX rm -rf 根/家目录/上级目录
  if (verb === 'rm') {
    const hit = checkRmSegment(tokens, vi);
    if (hit) return hit;
  }

  // 5. PowerShell Remove-Item -Recurse -Force 根/盘符/家目录/上级目录
  if (PS_REMOVE_VERBS.has(lower)) {
    const hit = checkPowerShellRemoveSegment(tokens, vi);
    if (hit) return hit;
  }

  // 6. Git 破坏性命令（reset --hard / clean -fdx / push --force|-f）
  if (lower === 'git' || lower === 'git.exe') {
    const hit = checkGitSegment(tokens, vi);
    if (hit) return hit;
  }

  // 7. 磁盘与分区级破坏命令（POSIX mkfs/dd/fdisk/parted + Windows Format-Volume/Clear-Disk/diskpart/format）
  if (/^mkfs(?:\.[A-Za-z0-9_-]+)?$/.test(lower)
      || lower === 'fdisk'
      || lower === 'parted'
      || lower === 'diskpart'
      || lower === 'format-volume'
      || lower === 'clear-disk'
      || lower === 'initialize-disk'
      || lower === 'remove-partition') {
    return `检测到磁盘/分区级高危破坏命令（${verb}）`;
  }
  if (lower === 'format' && tokens.slice(vi + 1).some((a) => /^[A-Za-z]:$/i.test(unquote(a)))) {
    return '检测到 format <盘符> 磁盘格式化命令';
  }
  if (verb === 'dd' && tokens.slice(vi + 1).some((a) => /^of=\/dev\//.test(unquote(a)))) {
    return '检测到 dd of=/dev/* 直接覆写块设备命令';
  }

  return null;
}

const PWSH_ENC_FLAG = '(?:ec|e(?:n(?:c(?:o(?:d(?:e(?:d(?:c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?)?)?)?)?)?)?)?)';
const PWSH_ENC_RE = new RegExp(
  `\\b(?:powershell|pwsh)(?:\\.exe)?\\b[^\\n;|&]*?\\s[-/]${PWSH_ENC_FLAG}(?:\\s+|:)\\s*["']?([A-Za-z0-9+/=]{4,})["']?`,
  'gi',
);

function checkEncodedPowerShell(cmd, depth) {
  if (depth > 3) return null;
  PWSH_ENC_RE.lastIndex = 0;
  for (const m of cmd.matchAll(PWSH_ENC_RE)) {
    let buf;
    try { buf = Buffer.from(m[1], 'base64'); } catch (_e) { continue; }
    if (!buf.length) continue;
    const u16 = buf.toString('utf16le').replace(/\0/g, '').trim();
    const u8 = buf.toString('utf8').replace(/\0/g, '').trim();
    for (const decoded of new Set([u16, u8].filter(Boolean))) {
      const hit = checkCommand(decoded, depth + 1);
      if (hit) return `检测到 PowerShell -EncodedCommand 编码隐藏危险命令（${hit}）`;
    }
  }
  return null;
}

function checkCommand(cmd, depth = 0) {
  if (depth > 4) return null;
  const encHit = checkEncodedPowerShell(cmd, depth);
  if (encHit) return encHit;
  for (const inner of extractDoubleQuotedSubstitutions(cmd)) {
    const subHit = checkCommand(inner, depth + 1);
    if (subHit) return subHit;
  }
  for (const seg of splitUnquotedSegments(cmd)) {
    const hit = checkSegment(seg, depth);
    if (hit) return hit;
  }
  return null;
}

runFailOpen(() => {
  const ev = readStdinJson();
  const cmd = ev && ev.tool_input ? String(ev.tool_input.command || '') : '';
  if (!cmd) return;

  const reason = checkCommand(cmd, 0);
  if (!reason) return;

  const root = projectDir(ev);
  process.exitCode = 2;
  say(`⛔ [dangerous-command-guard] ${reason}，已拦截。`);
  say('破坏性操作与宽泛杀进程属于安全地板（任何档位均不可自动放行）。');
  say('请改用受控、限定目录/精确 PID 的安全命令；确需执行不可逆操作时请停下交由用户亲自确认执行。');
  gateLog('dangerous-command-guard', reason, root);
});
