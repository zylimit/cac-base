#!/usr/bin/env node
// supervisor.mjs — 零依赖跨平台 dev 进程监督器（Windows PowerShell / WSL / Linux 一等公民）。
// 用途：守护开发期常驻服务（dev server / worker / db proxy）：
//   - 崩溃指数退避重启 + 重启风暴熔断（breaker，保留日志证据，不死循环空转）；
//   - 可选 HTTP 健康探针识别「假活卡死」进程并自动重启；
//   - 跨平台 stop.flag 优雅停机（Windows 下不靠伪 SIGTERM 强杀导致状态谎报，子进程树用 taskkill /PID /T /F 清理）；
//   - 所有子进程调用强制携带 windowsHide: true 且优先 shell: false，杜绝 Windows 黑窗口弹窗；
//   - 运行态与日志落盘于 .cac/.runtime/supervisor/<id>/（已被 .cac/.gitignore 排除）。
//
// 用法：
//   node .cac/scripts/supervisor.mjs start --id web [--cwd dir] [--health-url http://127.0.0.1:3000/health]
//        [--health-interval-sec 15] [--max-restarts 10] [--window-sec 600] [--backoff-ms 500] -- <command ...>
//   node .cac/scripts/supervisor.mjs stop --id web
//   node .cac/scripts/supervisor.mjs status [--id web]
//   node .cac/scripts/supervisor.mjs logs --id web [--lines 80]
//
// 退出码：0 成功 / 1 运行或状态错误（含 state.json 损坏） / 3 参数用法错误。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const SHELL_META_RE = /[|&;<>()$`"'\n*?[\]#~=%]/;
const WIN_CMD_WRAPPER_RE = /\.(?:cmd|bat|ps1)$/i;
const WIN_PKG_RUNNERS = new Set(['npm', 'npx', 'pnpm', 'yarn', 'corepack']);

function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

function projectRoot() {
  return process.env.CODEAGENT3_PROJECT_DIR || process.env.CAC_PROJECT_DIR || process.cwd();
}

function baseDir() {
  return path.join(projectRoot(), '.cac', '.runtime', 'supervisor');
}

function idDir(id) {
  return path.join(baseDir(), id);
}

function safeId(id) {
  const s = String(id == null ? '' : id).replace(/[^A-Za-z0-9._-]/g, '_');
  return (s === '' || s === '.' || s === '..') ? '' : s;
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  let command = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      command = argv.slice(i + 1);
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 2) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--') || next === '--') flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional, command };
}

function statePath(id) {
  return path.join(idDir(id), 'state.json');
}

function readStateResult(id) {
  const fp = statePath(id);
  let raw;
  try {
    raw = fs.readFileSync(fp, 'utf8');
  } catch (_e) {
    return { state: null, corrupt: null };
  }
  try {
    return { state: JSON.parse(raw), corrupt: null };
  } catch (e) {
    return { state: null, corrupt: { path: fp, detail: String((e && e.message) || e) } };
  }
}

function readState(id) {
  return readStateResult(id).state;
}

function writeState(id, state) {
  const dir = idDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `state.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, statePath(id));
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const rparen = stat.lastIndexOf(')');
        if (rparen > 0) {
          const st = stat.slice(rparen + 2, rparen + 3);
          if (st === 'Z' || st === 'X') return false;
        }
      } catch (_e) { /* /proc 不可读或刚被回收 */ }
    }
    return true;
  } catch (_e) {
    return false;
  }
}

function logPath(id) {
  return path.join(idDir(id), 'service.log');
}

function rotateIfLarge(file) {
  try {
    if (fs.existsSync(file) && fs.statSync(file).size >= LOG_MAX_BYTES) {
      fs.renameSync(file, file + '.1');
    }
  } catch (_e) { /* 日志轮转失败不可中断守护 */ }
}

function logLine(id, msg) {
  const file = logPath(id);
  rotateIfLarge(file);
  try {
    fs.appendFileSync(file, `[${new Date().toISOString()}] [supervisor] ${msg}\n`, 'utf8');
  } catch (_e) { /* best effort */ }
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
      });
    } else {
      try { process.kill(-pid, 'SIGTERM'); } catch (_e) { process.kill(pid, 'SIGTERM'); }
      setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch (_e) {
          try { process.kill(pid, 'SIGKILL'); } catch (_e2) { /* 已退出 */ }
        }
      }, 3000).unref();
    }
  } catch (_e) { /* 已退出 */ }
}

function probe(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function quoteShellArg(arg) {
  if (!/[\s"&|<>^();]/.test(arg)) return arg;
  if (process.platform === 'win32') {
    return '"' + arg.replace(/"/g, '\\"') + '"';
  }
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

function formatShellCmd(command) {
  if (command.length === 1) return command[0];
  return command.map(quoteShellArg).join(' ');
}

function needsShellSpawn(command) {
  if (command.length === 1 && (/\s/.test(command[0]) || SHELL_META_RE.test(command[0]))) {
    return true;
  }
  if (process.platform === 'win32') {
    const bin = path.basename(command[0]);
    if (WIN_CMD_WRAPPER_RE.test(bin) || WIN_PKG_RUNNERS.has(bin.toLowerCase())) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// __run: 后台守护循环（由 start 子命令拉起）
// ---------------------------------------------------------------------------
async function runLoop(flags, command) {
  const id = safeId(flags.id);
  const cwd = typeof flags.cwd === 'string' ? path.resolve(flags.cwd) : projectRoot();
  const maxRestarts = num(flags['max-restarts'], 10);
  const windowSec = num(flags['window-sec'], 600);
  const backoffBase = num(flags['backoff-ms'], 500);
  const healthUrl = typeof flags['health-url'] === 'string' ? flags['health-url'] : null;
  const healthIntervalSec = num(flags['health-interval-sec'], 15);
  const cmdString = command.join(' ');
  const stopFlag = path.join(idDir(id), 'stop.flag');
  const restartTimes = [];
  let child = null;
  let stopping = false;
  let healthFails = 0;

  const state = (patch) => {
    const cur = readState(id) || {};
    writeState(id, {
      ...cur,
      id,
      cmd: cmdString,
      cwd: toPosix(cwd),
      healthUrl,
      supervisorPid: process.pid,
      restarts: restartTimes.length,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
  };

  const shutdown = (reason) => {
    if (stopping) return;
    stopping = true;
    logLine(id, 'stopping: ' + reason);
    if (child && child.pid) killTree(child.pid);
    state({ status: 'stopped', childPid: null, stoppedAt: new Date().toISOString(), stopReason: reason });
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const scheduleRestart = (why) => {
    const now = Date.now();
    restartTimes.push(now);
    while (restartTimes.length && now - restartTimes[0] > windowSec * 1000) restartTimes.shift();
    if (restartTimes.length > maxRestarts) {
      logLine(id, `breaker tripped: ${restartTimes.length} restarts within ${windowSec}s -- giving up`);
      state({ status: 'crashed', childPid: null, breaker: { restarts: restartTimes.length, windowSec } });
      process.exit(1);
    }
    const delay = Math.min(backoffBase * Math.pow(2, restartTimes.length - 1), 30000);
    logLine(id, `restart #${restartTimes.length} in ${delay}ms (${why})`);
    setTimeout(() => { if (!stopping) startChild(); }, delay);
  };

  const startChild = () => {
    rotateIfLarge(logPath(id));
    const out = fs.openSync(logPath(id), 'a');
    const useShell = needsShellSpawn(command);
    if (useShell) {
      child = spawn(formatShellCmd(command), {
        cwd,
        shell: true,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', out, out],
      });
    } else {
      child = spawn(command[0], command.slice(1), {
        cwd,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', out, out],
      });
    }
    fs.closeSync(out);
    healthFails = 0;

    let handled = false;
    child.on('error', (err) => {
      if (stopping || handled) return;
      handled = true;
      logLine(id, `child spawn error: ${err && err.message ? err.message : err}`);
      state({ status: 'backoff', childPid: null, lastExit: { code: null, signal: 'spawn-error', at: new Date().toISOString() } });
      scheduleRestart('spawn error');
    });

    if (child.pid) {
      logLine(id, `started child pid=${child.pid} shell=${useShell} cmd=${cmdString}`);
      state({ status: 'running', childPid: child.pid, startedAt: new Date().toISOString() });
    }

    child.on('exit', (code, signal) => {
      if (stopping || handled) return;
      handled = true;
      logLine(id, `child exited code=${code} signal=${signal || 'none'}`);
      state({ status: 'backoff', childPid: null, lastExit: { code, signal, at: new Date().toISOString() } });
      scheduleRestart(`exit code=${code}`);
    });
  };

  let lastProbe = 0;
  setInterval(async () => {
    if (stopping) return;
    if (fs.existsSync(stopFlag)) {
      try { fs.unlinkSync(stopFlag); } catch (_e) { /* ignore */ }
      shutdown('stop.flag');
      return;
    }
    if (healthUrl && child && child.pid && Date.now() - lastProbe >= healthIntervalSec * 1000) {
      lastProbe = Date.now();
      const ok = await probe(healthUrl);
      if (ok) {
        healthFails = 0;
        return;
      }
      healthFails++;
      logLine(id, `health probe failed (${healthFails}/3): ${healthUrl}`);
      if (healthFails >= 3) {
        logLine(id, `health breaker: killing hung child pid=${child.pid}`);
        healthFails = 0;
        const pid = child.pid;
        child.removeAllListeners('exit');
        killTree(pid);
        state({ status: 'backoff', childPid: null, lastExit: { code: null, signal: 'health-probe', at: new Date().toISOString() } });
        scheduleRestart('health probe failed 3x');
      }
    }
  }, 1000);

  startChild();
}

function num(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) || n <= 0 ? dflt : n;
}

// ---------------------------------------------------------------------------
// CLI 子命令
// ---------------------------------------------------------------------------
function cmdStart(flags, command) {
  const id = safeId(flags.id);
  if (!id) return die('start requires --id <name> (A-Za-z0-9._-)', 3);
  if (!command.length) return die('start requires "-- <command ...>" after the flags', 3);
  const found = readStateResult(id);
  if (found.corrupt) {
    return die(
      `id "${id}": ${rel(found.corrupt.path)} will not parse (${found.corrupt.detail}); `
      + 'refusing to start a second supervisor behind an unreadable state.json',
      1,
    );
  }
  const existing = found.state;
  if (existing && existing.status === 'running' && pidAlive(existing.supervisorPid)) {
    return die(`id "${id}" is already running (supervisor pid ${existing.supervisorPid}); stop it first`, 1);
  }
  fs.mkdirSync(idDir(id), { recursive: true });
  try { fs.unlinkSync(path.join(idDir(id), 'stop.flag')); } catch (_e) { /* none */ }

  const args = [SELF, '__run', '--id', id];
  for (const k of ['cwd', 'max-restarts', 'window-sec', 'backoff-ms', 'health-url', 'health-interval-sec']) {
    if (typeof flags[k] === 'string') args.push('--' + k, flags[k]);
  }
  args.push('--', ...command);

  const root = projectRoot();
  const sup = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    shell: false,
    env: { ...process.env, CAC_PROJECT_DIR: root },
  });
  sup.unref();

  const deadline = Date.now() + 5000;
  const wait = () => {
    const st = readState(id);
    if (st && st.supervisorPid && pidAlive(st.supervisorPid)) {
      emit({
        ok: true,
        id,
        supervisorPid: st.supervisorPid,
        childPid: st.childPid || null,
        status: st.status,
        log: rel(logPath(id)),
      });
      return;
    }
    if (Date.now() > deadline) {
      return die(`supervisor did not report a live state within 5s; check ${rel(logPath(id))}`, 1);
    }
    setTimeout(wait, 150);
  };
  wait();
}

function cmdStop(flags) {
  const id = safeId(flags.id);
  if (!id) return die('stop requires --id <name>', 3);
  const found = readStateResult(id);
  if (found.corrupt) {
    return die(
      `id "${id}": ${rel(found.corrupt.path)} is corrupt (${found.corrupt.detail}); `
      + 'check for a live supervisor manually before removing state.json',
      1,
    );
  }
  const st = found.state;
  if (!st) return die(`no state for id "${id}"`, 1);

  fs.writeFileSync(path.join(idDir(id), 'stop.flag'), new Date().toISOString() + '\n', 'utf8');
  const supAlive = !!(st.supervisorPid && pidAlive(st.supervisorPid));
  const flagOnly = process.platform === 'win32';
  if (supAlive && !flagOnly) {
    try { process.kill(st.supervisorPid, 'SIGTERM'); } catch (_e) { /* stop.flag 兜底 */ }
  }

  let reaped = false;
  const reapOrphan = (pid) => {
    if (!reaped && pid && pidAlive(pid)) {
      reaped = true;
      killTree(pid);
    }
  };
  if (!(supAlive && flagOnly)) reapOrphan(st.childPid);

  const timeoutMs = flagOnly ? 15000 : 6000;
  const deadline = Date.now() + timeoutMs;
  const wait = () => {
    const cur = readState(id);
    const supGone = !cur || !cur.supervisorPid || !pidAlive(cur.supervisorPid);
    const childGone = !cur || !cur.childPid || !pidAlive(cur.childPid);
    if (supGone && childGone) {
      emit({ ok: true, id, status: 'stopped' });
      return;
    }
    if (supGone && !childGone) reapOrphan(cur.childPid);
    if (Date.now() > deadline) {
      return die(
        `stop did not converge within ${Math.round(timeoutMs / 1000)}s `
        + `(supervisor=${supGone ? 'gone' : 'alive'}, child=${childGone ? 'gone' : 'alive'})`,
        1,
      );
    }
    setTimeout(wait, 200);
  };
  wait();
}

function cmdStatus(flags) {
  const one = typeof flags.id === 'string' ? safeId(flags.id) : null;
  let ids = [];
  try {
    ids = fs.readdirSync(baseDir()).filter((n) => fs.existsSync(path.join(baseDir(), n, 'state.json')));
  } catch (e) {
    if (!e || e.code !== 'ENOENT') {
      const detail = String((e && e.message) || e);
      process.stderr.write(`status: ${rel(baseDir())} cannot be listed (${detail}); services are unknown, not absent\n`);
      emit({ ok: false, error: 'state-dir-unreadable', path: rel(baseDir()), detail });
      process.exitCode = 1;
      return;
    }
    ids = [];
  }
  if (one) ids = ids.filter((n) => n === one);
  let corrupt = 0;
  const services = ids.map((n) => {
    const found = readStateResult(n);
    if (found.corrupt) {
      corrupt++;
      process.stderr.write(`status: ${rel(found.corrupt.path)} will not parse (${found.corrupt.detail}); liveness is unknown\n`);
      return {
        id: n,
        status: 'corrupt',
        statePath: rel(found.corrupt.path),
        detail: found.corrupt.detail,
        log: rel(logPath(n)),
      };
    }
    const st = found.state || {};
    const supAlive = pidAlive(st.supervisorPid);
    const childAlive = pidAlive(st.childPid);
    const status = st.status === 'stopped' || st.status === 'crashed'
      ? st.status
      : (supAlive ? (childAlive ? 'running' : (st.status || 'backoff')) : 'dead');
    return {
      id: n,
      status,
      supervisorPid: st.supervisorPid || null,
      supervisorAlive: supAlive,
      childPid: st.childPid || null,
      childAlive,
      restarts: st.restarts || 0,
      cmd: st.cmd || null,
      healthUrl: st.healthUrl || null,
      lastExit: st.lastExit || null,
      updatedAt: st.updatedAt || null,
      log: rel(logPath(n)),
    };
  });
  emit({ ok: corrupt === 0, services });
  if (corrupt) process.exitCode = 1;
}

function cmdLogs(flags) {
  const id = safeId(flags.id);
  if (!id) return die('logs requires --id <name>', 3);
  const lines = num(flags.lines, 80);
  let text = '';
  try {
    text = fs.readFileSync(logPath(id), 'utf8');
  } catch (_e) {
    return die(`no log for id "${id}"`, 1);
  }
  const tail = text.replace(/\r\n?/g, '\n').split('\n').filter(Boolean).slice(-lines);
  process.stdout.write(tail.join('\n') + '\n');
}

function rel(p) {
  return toPosix(path.relative(projectRoot(), p));
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function die(msg, code = 1) {
  process.stderr.write(String(msg) + '\n');
  process.exit(code);
}

function usage() {
  return [
    'usage: node .cac/scripts/supervisor.mjs <verb>',
    '  start --id <name> [--cwd dir] [--health-url url] [--health-interval-sec 15]',
    '        [--max-restarts 10] [--window-sec 600] [--backoff-ms 500] -- <command ...>',
    '  stop --id <name>',
    '  status [--id <name>]',
    '  logs --id <name> [--lines 80]',
  ].join('\n');
}

const { flags, positional, command } = parseArgs(process.argv.slice(2));
const verb = positional[0] || process.argv[2];
switch (verb) {
  case 'start':  cmdStart(flags, command); break;
  case 'stop':   cmdStop(flags); break;
  case 'status': cmdStatus(flags); break;
  case 'logs':   cmdLogs(flags); break;
  case '__run':  runLoop(flags, command); break;
  default:       die(usage(), 3);
}
