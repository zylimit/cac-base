// PreToolUse(Edit|Write|MultiEdit|NotebookEdit)：拦截主 Agent 直接编写业务源码。
//
// 实证机制（HOST-CONTRACT §3.3）：
//   主 Agent 工具调用不含 agent_id / agent_type；子代理调用原生携带 agent_id 与 agent_type。
// 档位（profile.json）：off 静默放行；advise（fast 档）仅告警记账；block（standard / strict 档）exit 2 硬拦。

import fs from 'node:fs';
import path from 'node:path';
import { projectDir, readStdinJson, subagentIdOf, toPosix, say, gateModeOf, runFailOpen } from './lib/io.mjs';
import { gateLog } from './lib/gatelog.mjs';

const WRITER_SUBAGENTS = new Set(['implementer', 'tester']);

const EXEMPT = /^(?:\.cac\/|domain\/|docs\/|AGENTS\.md$|Product-Spec|DEV-PLAN|progress(?:\.archive)?\.md$|CHANGELOG)|\.(?:md|json|toml|sh|ps1)$/i;
const SOURCE = /(?:^|\/)(?:src|app|lib|components|pages|api|server|client|utils|models|services)\//;

function normalizeTarget(rawPath, root) {
  const posixRaw = toPosix(rawPath).trim();
  if (!posixRaw) return '';
  const isWinAbs = /^[A-Za-z]:\//.test(posixRaw);
  const isPosixAbs = posixRaw.startsWith('/');
  if (isPosixAbs || isWinAbs) {
    const foldedAbs = isWinAbs
      ? posixRaw.slice(0, 2) + path.posix.normalize(posixRaw.slice(2))
      : path.posix.normalize(posixRaw);
    const rootCandidates = [toPosix(path.resolve(root)).replace(/\/+$/, '')];
    try {
      const realRoot = toPosix(fs.realpathSync.native(root)).replace(/\/+$/, '');
      if (!rootCandidates.includes(realRoot)) rootCandidates.push(realRoot);
    } catch (_e) { /* ignore */ }
    for (const r of rootCandidates) {
      const cmpRoot = isWinAbs ? r.toLowerCase() : r;
      const cmpTarget = isWinAbs ? foldedAbs.toLowerCase() : foldedAbs;
      if (cmpTarget === cmpRoot) return '.';
      if (cmpTarget.startsWith(`${cmpRoot}/`)) return foldedAbs.slice(r.length + 1);
    }
    return foldedAbs;
  }
  return path.posix.normalize(posixRaw).replace(/^(?:\.\/)+/, '');
}

runFailOpen(async () => {
  const ev = readStdinJson();
  const root = projectDir(ev);
  const mode = await gateModeOf('no-direct-code-guard', root);
  if (mode === 'off') return;

  const subId = subagentIdOf(ev);
  const agentType = ev && ev.agent_type ? String(ev.agent_type).trim() : '';
  if (subId && (!agentType || WRITER_SUBAGENTS.has(agentType))) return;

  const input = ev && typeof ev.tool_input === 'object' && ev.tool_input ? ev.tool_input : {};
  const rawFilePath = String(input.file_path || input.notebook_path || input.path || '');
  const filePath = normalizeTarget(rawFilePath, root);
  if (!filePath) return;

  if (EXEMPT.test(filePath)) return;
  if (!SOURCE.test(filePath)) return;

  if (mode !== 'advise') process.exitCode = 2;
  const who = (subId || agentType) ? `非写码子代理 (${agentType || subId})` : '主 Agent';
  say(`⚠️  [no-direct-code-guard] ${who} 不应直接修改业务源码：${filePath}`);
  say('请派发 implementer（或测试场景派 tester）Sub-Agent 执行受控编码，保持主从职责隔离。');
  gateLog('no-direct-code-guard', `${mode === 'advise' ? '[advise] ' : ''}${who} 直接写业务源码被拦：${filePath}`, root);
});
