// PostToolUse(Edit|Write|MultiEdit|NotebookEdit)：作者台账自动记录（联动大仓 `harness authorship record`）。
// 仅当 .cac/harness/module-catalog.json 存在时激活，支撑「测试者/评审者不得为被测代码作者」机器核验。

import fs from 'node:fs';
import path from 'node:path';
import { projectDir, readStdinJson, subagentIdOf, toPosix, say, fastOff, runFailOpen } from './lib/io.mjs';
import { harnessEnabled, harnessRun } from './lib/harness.mjs';

const RECORD_TIMEOUT_MS = 10000;

function escapesBase(rel) {
  return rel === '..' || rel.startsWith(`..${path.sep}`) || rel.startsWith('../') || path.isAbsolute(rel);
}

function realOrSelf(p) {
  try { return fs.realpathSync.native(p); } catch (_e) { return p; }
}

function repoRel(root, raw) {
  const rootAbs = path.resolve(root);
  const abs = path.isAbsolute(raw) || /^[A-Za-z]:[/\\]/.test(raw)
    ? path.resolve(raw)
    : path.resolve(rootAbs, raw);
  const spelling = path.relative(rootAbs, abs);
  if (spelling !== '' && !escapesBase(spelling)) return toPosix(spelling);
  const identity = path.relative(realOrSelf(rootAbs), realOrSelf(abs));
  if (identity !== '' && !escapesBase(identity)) return toPosix(identity);
  return null;
}

runFailOpen(async () => {
  const ev = readStdinJson();
  const root = projectDir(ev);
  if (await fastOff('record-authorship', root)) return;
  if (!harnessEnabled(root)) return;

  const input = ev && typeof ev.tool_input === 'object' && ev.tool_input ? ev.tool_input : {};
  const filePath = String(input.file_path || input.notebook_path || '');
  if (!filePath) return;

  const agentType = ev && ev.agent_type ? String(ev.agent_type) : '';
  const author = subagentIdOf(ev) || agentType || 'main';

  const rel = repoRel(root, filePath);
  if (rel === null) return;

  const payload = JSON.stringify({ agentId: author, agentType, files: [rel] });
  const r = harnessRun(['authorship', 'record'], { input: payload, cwd: root, timeout: RECORD_TIMEOUT_MS });
  if (r.status !== 0) {
    const head = String(r.stderr || '').split(/\r?\n/).find((l) => l.trim() !== '') || '';
    say(`[record-authorship] 作者台账未记上（${rel} ← ${author}）：harness authorship record 退出码 ${r.status}。${head}`);
  }
});
