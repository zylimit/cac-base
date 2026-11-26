// SubagentStart (--start) & SubagentStop：子代理会话记账 + 执行类取证提醒 + strict 档回执信封校验。
//
// 实证契约（HOST-CONTRACT §3.4 & §3.5）：
//   1. SubagentStart（传入 `--start`）：记录会话启动至 .cac/harness/state/sessions.jsonl 后立即放行；
//   2. SubagentStop：
//      - 从 `ev.last_assistant_message` 直接读取回传文本（严禁递归 walk(ev) 误抓其他字段！）；
//      - 在 `strict` 档（mode === 'block'）且 `!ev.stop_hook_active` 且非豁免角色且 `last_assistant_message` 非空时，
//        校验是否含四态 `Status:`（DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED，tester 另兼容 PASS / FAIL）
//        与 `Evidence:`（或 `证据:`）；缺失则输出 `{ decision: "block", reason }`（绝不设 continue: false）打回补齐一次！
//        若 `ev.stop_hook_active === true`，直接放行绝不二次打回，彻底杜绝死循环。
//      - 对执行类角色（implementer | code-reviewer | tester | deployer）去重注入取证与 Domain findings 提醒。

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  projectDir, readStdinJson, readTextFile, subagentIdOf, block, context, emit, gateModeOf, runFailOpen,
} from './lib/io.mjs';
import { gateLog } from './lib/gatelog.mjs';

const EXEC_ROLES = new Set(['implementer', 'code-reviewer', 'tester', 'deployer']);
const EXEMPT_ROLES = new Set([
  'researcher',
  'impact-analyst',
  'evolution-runner',
  'feedback-observer',
  'progress-recorder',
  'domain-recorder',
]);

const STATUS_FOUR_RE = /(?:^|\n)[\s>*+-]*\**\s*(?:Status|状态)\s*\**\s*[:：]\s*`?\**\s*(DONE_WITH_CONCERNS|DONE|NEEDS_CONTEXT|BLOCKED)\b/i;
const TESTER_VERDICT_RE = /(?:^|\n)[\s>*+-]*\**\s*(?:Status|状态|Verdict|测试结论|结论)\s*\**\s*[:：]\s*`?\**\s*(PASS|FAIL)\b/i;
const EVIDENCE_RE = /(?:^|\n)[\s>*+-]*\**\s*(?:Evidence|证据)\s*\**\s*[:：]/i;

function validateEnvelope(text, role) {
  const s = String(text || '');
  const hasFourState = STATUS_FOUR_RE.test(s);
  const hasTesterPassFail = role === 'tester' && TESTER_VERDICT_RE.test(s);
  const hasStatus = hasFourState || hasTesterPassFail;
  const hasEvidence = EVIDENCE_RE.test(s);
  const missing = [];
  if (!hasStatus) missing.push(role === 'tester' ? 'Status(四态或PASS/FAIL)' : 'Status(DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED)');
  if (!hasEvidence) missing.push('Evidence');
  return { ok: missing.length === 0, missing };
}

function appendJsonl(filePath, obj) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
  } catch (_e) { /* 记账失败不影响主流程 */ }
}

function markRemindedOnce(root, ev, role) {
  const key = subagentIdOf(ev) || createHash('sha256')
    .update(`${(ev && ev.session_id) || ''}|${role}|${(ev && (ev.agent_transcript_path || ev.transcript_path)) || ''}`)
    .digest('hex');
  const seenFile = path.join(root, '.cac', '.subagent-reminded');
  const prior = (readTextFile(seenFile).text || '').replace(/\r/g, '').split('\n').filter(Boolean);
  if (prior.includes(key)) return false;
  try {
    fs.mkdirSync(path.dirname(seenFile), { recursive: true });
    prior.push(key);
    const trimmed = prior.length > 50 ? prior.slice(-50) : prior;
    fs.writeFileSync(seenFile, trimmed.join('\n') + '\n', 'utf8');
  } catch (_e) { /* 写失败最多多提醒一次 */ }
  return true;
}

function hasDomainFindings(receipt) {
  const label = /(?:^|\n)[\s>*+-]*\**\s*domain findings\s*\**\s*[:：]?/i.exec(receipt);
  if (!label) return false;
  const tail = receipt.slice(label.index + label[0].length);
  const found = tail.split(/\n[\s>*+-]*\**\s*(?:needs review by|evidence)\b/i)[0].replace(/[\s*`_>-]/g, '');
  return found !== '' && !/^(?:none|n\/a)\b|^无(?![\u4e00-\u9fff])/i.test(found);
}

runFailOpen(async () => {
  const isStart = process.argv.includes('--start');
  const ev = readStdinJson();
  const root = projectDir(ev);
  const role = ev ? String(ev.agent_type || ev.subagent_type || ev.subagent_name || '').trim() : '';
  const agentId = subagentIdOf(ev);
  const stateDir = path.join(root, '.cac', 'harness', 'state');

  appendJsonl(path.join(stateDir, 'sessions.jsonl'), {
    ts: new Date().toISOString(),
    event: isStart ? 'subagent_start' : 'subagent_stop',
    agentType: role,
    agentId,
    sessionId: (ev && ev.session_id) || '',
  });

  // SubagentStart：记账完毕直接放行
  if (isStart) return;

  // SubagentStop：stop_hook_active 重入防死锁保护
  const stopHookActive = Boolean(ev && ev.stop_hook_active);
  const mode = await gateModeOf('subagent-bookkeeping', root);
  if (mode === 'off') return;

  // 严格只读 ev.last_assistant_message，绝不用 walk(ev)
  const receipt = (ev && typeof ev.last_assistant_message === 'string') ? ev.last_assistant_message : '';
  const isExempt = role ? EXEMPT_ROLES.has(role) : false;

  let adviseWarning = '';
  if (!isExempt && receipt.trim() !== '') {
    const check = validateEnvelope(receipt, role);
    if (!check.ok) {
      const reason = `子代理回执信封不完整（${role || 'subagent'} 缺少 ${check.missing.join('、')} 字段）。请在同一条消息中输出完整回执信封（含 Status / Changed / Verified / Not verified / Needs review by / Evidence / Business assumptions 等段），主 Agent 只接收你最后一条完整回复。`;
      appendJsonl(path.join(stateDir, 'envelope-violations.jsonl'), {
        ts: new Date().toISOString(),
        agentType: role,
        agentId,
        missing: check.missing,
        mode,
        stopHookActive,
      });
      if (mode === 'block' && !stopHookActive) {
        gateLog('subagent-bookkeeping', reason, root);
        block(reason);
        return;
      }
      if (!stopHookActive) {
        adviseWarning = `[advise] ${reason}`;
        gateLog('subagent-bookkeeping', adviseWarning, root);
      }
    }
  }

  // 执行类角色注入取证与 Domain findings 提醒（每个子代理实例只提醒一次）
  const shouldRemindExec = EXEC_ROLES.has(role) || (!role && !isExempt);
  if (shouldRemindExec && !stopHookActive && markRemindedOnce(root, ev, role)) {
    const labelName = role || '子 Agent';
    const domainTail = hasDomainFindings(receipt)
      ? '回执里报了 Domain findings 领域发现的，请写清手头客观证据类别（实测 / 外网标准 / 内部规范）；定论归主 Agent，你只报线索不判结论。'
      : '';
    const msg = `${labelName}：收工前请核对——自报（完成/通过）不算客观证据，每条结论须锚定实际跑过的命令与真实退出码；若需补充或修正回执，必须把完整回执在一条消息里整份重发（主 Agent 只收得到最后一条消息）；未执行或环境受限的项如实填入 Not verified。${domainTail}`;
    context('SubagentStop', msg, adviseWarning ? { systemMessage: adviseWarning } : {});
    return;
  }

  if (adviseWarning) {
    emit({ systemMessage: adviseWarning });
  }
});
