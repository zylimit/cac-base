// PreToolUse(Agent|Task)：先红后绿（red-locks-the-bug）TDD 守护闸。
//
// 仅当派发 implementer 且派单 prompt 命中线上缺陷/解析器/契约/鉴权/迁移关键词时检查：
// 须存在 2 小时内有效的 .cac/.red-verified（或显式豁免 .cac/.tdd-exempt）。
// 档位（profile.json）：fast=off 静默；standard=advise 去重提醒；strict=block（exit 2 阻断）。

import fs from 'node:fs';
import path from 'node:path';
import { projectDir, readStdinJson, say, errText, gateModeOf, runFailOpen } from './lib/io.mjs';
import { gateLog } from './lib/gatelog.mjs';
import { textSig, recentlyAdvised, recordAdvised } from './lib/advise-dedup.mjs';

const RED_LOCK_KEYWORDS = [
  'bug', '线上', '解析器', 'parser', '契约', '状态机', 'schema', '迁移', '鉴权',
  '缺陷', '修复', '生产', '崩溃', '报错', 'fix', 'hotfix', 'migration', 'auth', 'contract',
];
const WORD_START_KEYWORDS = new Map([['bug', ''], ['fix', '(?!ture)'], ['auth', '(?!or(?!i[sz]))']]);
const KEYWORD_RE = new RegExp(
  RED_LOCK_KEYWORDS
    .map((k) => (WORD_START_KEYWORDS.has(k) ? `(?:^|[^a-z])${k}${WORD_START_KEYWORDS.get(k)}` : k))
    .join('|'),
  'i',
);

const PROMPT_SIG_CHARS = 300;
const MARK_TTL_MS = 2 * 3600 * 1000;

function markLive(file) {
  let st;
  try { st = fs.statSync(file); } catch (_e) { return false; }
  if (Date.now() - st.mtimeMs <= MARK_TTL_MS) return true;
  try { fs.rmSync(file, { force: true }); } catch (e) { say(`[tdd-gate] 过期标记清理失败，仍按无标记计：${errText(e)}`); }
  return false;
}

runFailOpen(async () => {
  const ev = readStdinJson();
  const root = projectDir(ev);
  const mode = await gateModeOf('tdd-gate', root);
  if (mode === 'off') return;

  const input = ev && typeof ev.tool_input === 'object' && ev.tool_input ? ev.tool_input : {};
  if (String(input.subagent_type || '') !== 'implementer') return;
  const prompt = String(input.prompt || '');
  if (!KEYWORD_RE.test(prompt)) return;

  const cacDir = path.join(root, '.cac');
  if (markLive(path.join(cacDir, '.red-verified')) || markLive(path.join(cacDir, '.tdd-exempt'))) {
    return;
  }

  const isBlock = mode === 'block';
  if (isBlock) process.exitCode = 2;
  if (!isBlock) {
    const advisedFile = path.join(cacDir, '.tdd-gate-advised');
    const sig = textSig(prompt.slice(0, PROMPT_SIG_CHARS));
    if (recentlyAdvised(advisedFile, sig)) return;
    recordAdvised(advisedFile, sig);
  }

  say(`${isBlock ? '[block] ' : '[advise] '}TDD 闸门：派 implementer 执行缺陷/核心逻辑 GREEN 修复前须先锁定 RED 失败测试。`);
  say('正确顺序：先派 tester 写出复现该缺陷的失败测试并实跑见红 → 主 Agent 核验后写入 .cac/.red-verified（2h 有效）→ 再派 implementer 修绿。');
  say('若本 Task 确属纯样式/文案等非 TDD 场景，可创建 .cac/.tdd-exempt 显式声明豁免。');
  gateLog(
    'tdd-gate',
    isBlock ? '未验红即派 implementer 修码，strict 档拦停' : '[advise] 未验红即派 implementer，standard 档提醒',
    root,
  );
});
