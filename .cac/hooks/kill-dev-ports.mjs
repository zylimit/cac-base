// PreToolUse(Bash|PowerShell|Shell)：启动本地开发服务器前自动清理残留占用端口（跨平台 POSIX lsof + Windows netstat/taskkill）。
// 支持环境变量 CAC_DEV_PORTS（逗号分隔端口号）自定义清理列表，默认 3000,3001,4173,5173,8080。
// 恒 exit 0，不阻断命令执行。

import { projectDir, readStdinRaw, run, fastOff, runFailOpen } from './lib/io.mjs';

const DEFAULT_PORTS = [3000, 3001, 4173, 5173, 8080];
const DEV_SERVER_RE = /\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?dev\b/;

function devPorts() {
  const raw = process.env.CAC_DEV_PORTS;
  if (!raw) return DEFAULT_PORTS;
  const picked = raw.split(',')
    .map((s) => s.trim())
    .filter((s) => /^[0-9]+$/.test(s))
    .map(Number)
    .filter((n) => n > 0 && n < 65536);
  if (!picked.length) {
    process.stderr.write('[kill-dev-ports] CAC_DEV_PORTS 无合法端口，本次跳过清理\n');
    return [];
  }
  return picked;
}

function sleepMs(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_e) { /* ignore */ }
}

function killPosix(port) {
  const r = run('lsof', ['-t', '-i', `:${port}`]);
  if (r.status !== 0) return;
  for (const pid of r.stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^[0-9]+$/.test(s))) {
    run('kill', ['-9', pid]);
  }
}

function killWindows(port, netstatOut) {
  const re = new RegExp(`:${port}\\s+.*LISTENING`, 'i');
  for (const line of netstatOut.split(/\r?\n/)) {
    if (!re.test(line)) continue;
    const pid = line.trim().split(/\s+/).pop();
    if (pid && /^[0-9]+$/.test(pid) && pid !== '0') {
      run('taskkill', ['/PID', pid, '/F']);
    }
  }
}

runFailOpen(async () => {
  const raw = readStdinRaw();
  let ev = null;
  let cmd = raw;
  try {
    ev = raw.trim() ? JSON.parse(raw) : null;
    cmd = String((ev && ev.tool_input && ev.tool_input.command) || '');
  } catch (_e) {
    ev = null;
  }
  if (!cmd || !DEV_SERVER_RE.test(cmd)) return;

  const root = projectDir(ev);
  if (await fastOff('kill-dev-ports', root)) return;

  const ports = devPorts();
  if (!ports.length) return;

  if (process.platform === 'win32') {
    const ns = run('netstat', ['-ano']);
    if (ns.status === 0) {
      for (const port of ports) killWindows(port, ns.stdout);
    }
  } else {
    for (const port of ports) killPosix(port);
  }
  sleepMs(500);
});
