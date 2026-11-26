// Stop hook：有业务代码待审（.cac/.needs-review 未清）或大仓回执过期时拦截会话停止。
//
// 阻断与防死锁契约（HOST-CONTRACT §3.5）：
//   - 阻断输出 `{ decision: "block", reason }`（exit 0，绝不写 continue: false）；
//   - 内置同一清单签名 3 次连拦熔断（.cac/.stop-gate-strikes）：第 4 次自动释放并附醒目欠账提醒；
//   - standard 档（advise）1 小时去重提醒（.cac/.stop-gate-advised）；strict 档（block）硬拦；
//   - fail-closed：状态文件 I/O 损坏或引擎契约外崩溃绝不假绿放行。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  projectDir, readStdinJson, readTextFile, pendingReviewLines, emit, gateModeOf, runFailClosed,
} from './lib/io.mjs';
import { gateLog } from './lib/gatelog.mjs';
import { recentlyAdvised, recordAdvised, clearAdvised } from './lib/advise-dedup.mjs';
import {
  harnessEnabled, harnessExtInstalled, harnessExtMissingNotice, harnessRun, rcInContract, errHead,
} from './lib/harness.mjs';

function readStrikes(file, sig) {
  const st = readTextFile(file);
  if (!st.text) return 0;
  const lines = st.text.replace(/\r/g, '').split('\n');
  const oldSig = (lines.find((l) => l.startsWith('sig=')) || '').slice(4);
  const oldN = (lines.find((l) => l.startsWith('count=')) || '').slice(6);
  if (oldSig !== sig) return 0;
  return /^\d+$/.test(oldN) ? Number(oldN) : 0;
}

function writeStrikes(file, sig, n) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `sig=${sig}\ncount=${n}\n`, 'utf8');
}

function blockWith(reason, root) {
  gateLog('stop-gate', reason, root);
  emit({ decision: 'block', reason });
}

function adviseWith(reason, root) {
  const msg = `[advise] ${reason}`;
  gateLog('stop-gate', msg, root);
  emit({ systemMessage: msg });
}

function releaseWith(notice, root) {
  gateLog('stop-gate', notice, root);
  emit({ systemMessage: notice });
}

runFailClosed(async () => {
  const ev = readStdinJson();
  if (ev && ev.stop_hook_active) return;
  const root = projectDir(ev);
  const mode = await gateModeOf('stop-gate', root);
  if (mode === 'off') return;

  const advise = mode === 'advise';
  const decide = (reason) => (advise ? adviseWith(reason, root) : blockWith(reason, root));

  const stateFile = path.join(root, '.cac', '.needs-review');
  const strikeFile = path.join(root, '.cac', '.stop-gate-strikes');
  const advisedFile = path.join(root, '.cac', '.stop-gate-advised');

  const state = readTextFile(stateFile);
  if (state.absent) {
    fs.rmSync(strikeFile, { force: true });
    if (advise) clearAdvised(advisedFile);
    return;
  }
  if (state.error) throw state.error;

  const files = pendingReviewLines(state.text);

  if (files.length === 0) {
    if (harnessEnabled(root)) {
      if (!harnessExtInstalled(root)) {
        const notice = harnessExtMissingNotice('回执绑定校验（harness receipt verify）');
        if (advise) clearAdvised(advisedFile);
        gateLog('stop-gate', notice, root);
        emit({ systemMessage: notice });
        return;
      }
      const rv = harnessRun(['receipt', 'verify'], { cwd: root });
      const rc = rv.status;
      if (rc === 4) {
        if (advise) clearAdvised(advisedFile);
        decide('代码在上次审查后又有改动，无匹配的已通过回执（diff 已越过所有已审回执）。请重新派 code-reviewer 审查当前改动并写回执后再停止。');
        return;
      }
      if (!rcInContract(rc, 0, 3)) {
        const hsig = `harness-receipt-verify-rc${rc}`;
        const strikes = advise ? 0 : readStrikes(strikeFile, hsig);
        const head = errHead(rv.stderr) || '（引擎无 stderr 输出）';
        if (strikes >= 3) {
          fs.rmSync(strikeFile, { force: true });
          releaseWith(`stop-gate：harness receipt verify 连续 3 次以契约外退出码 ${rc} 退出，达连拦上限本次放行——请尽快排查修复：node .cac/harness/harness.mjs receipt verify。报错：${head}`, root);
          return;
        }
        if (!advise) writeStrikes(strikeFile, hsig, strikes + 1);
        decide(`stop-gate：harness receipt verify 以契约外退出码 ${rc} 退出（契约只有 0/3/4），请运行 node .cac/harness/harness.mjs receipt verify 修复后再停止。报错：${head}`);
        return;
      }
    }
    fs.rmSync(stateFile, { force: true });
    fs.rmSync(`${stateFile}.lock`, { force: true });
    fs.rmSync(strikeFile, { force: true });
    if (advise) clearAdvised(advisedFile);
    return;
  }

  const count = files.length;
  const inline = files.join('、');
  const sig = crypto.createHash('sha256').update([...files].sort().join('\n')).digest('hex');
  const strikes = advise ? 0 : readStrikes(strikeFile, sig);
  if (strikes >= 3) {
    fs.rmSync(strikeFile, { force: true });
    releaseWith(`stop-gate：同一待审清单连续拦截已达 3 次上限，本次放行——但待审清单未清空（${count} 个欠账仍在：${inline}），请尽快派 code-reviewer 完成审查。`, root);
    return;
  }
  if (!advise) writeStrikes(strikeFile, sig, strikes + 1);
  if (advise) {
    if (recentlyAdvised(advisedFile, sig)) return;
    recordAdvised(advisedFile, sig);
  }
  decide(`代码已修改但尚未完成 code review（${count} 个待审文件：${inline}）。请派发 code-reviewer sub-agent 审查（Stage 0 → 1 → 2）；通过后将 clean 写入 .cac/.needs-review 即可放行。`);
}, 'stop-gate 自检失败，fail-closed 拦停——请修复闸或状态文件后重试停止。');
