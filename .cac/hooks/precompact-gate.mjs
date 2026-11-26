// PreCompact：上下文压缩前守门——若有待审文件或代码改动尚未固化至 progress.md，拦一次压缩（10 分钟冷却防卡死）。
// 输出契约：`{ decision: "block", reason }`（exit 0，绝不设 continue: false）；fast 档降为 systemMessage 提醒。

import fs from 'node:fs';
import path from 'node:path';
import {
  projectDir, readStdinJson, readTextFile, pendingReviewFiles, git, porcelainZ,
  classifyChange, relToProject, emit, gateModeOf, runFailOpen,
} from './lib/io.mjs';
import { gateLog } from './lib/gatelog.mjs';

const COOLDOWN_SECONDS = 600;

runFailOpen(async () => {
  const ev = readStdinJson();
  const root = projectDir(ev);
  const mode = await gateModeOf('precompact-gate', root);
  if (mode === 'off') return;

  const mark = path.join(root, '.cac', '.precompact-block-epoch');
  const now = Math.floor(Date.now() / 1000);

  const prior = readTextFile(mark);
  if (prior.text !== null) {
    const last = prior.text.replace(/\r/g, '').split('\n').find((l) => /^\d+$/.test(l));
    if (last && now - Number(last) < COOLDOWN_SECONDS) return;
  }

  let dirtyReason = '';

  const pending = pendingReviewFiles(root);
  if (pending.length > 0) {
    dirtyReason = `待审清单未清（${pending.length} 个文件待 code review）`;
  }

  if (!dirtyReason && fs.existsSync(path.join(root, 'progress.md'))
      && git(['rev-parse', '--is-inside-work-tree'], { cwd: root }).status === 0) {
    const prefix = git(['rev-parse', '--show-prefix'], { cwd: root }).stdout.replace(/\r?\n$/, '');
    let codeDirty = false;
    let progDirty = false;

    const take = (p) => {
      const rel = relToProject(p, prefix);
      if (rel === null) return;
      const kind = classifyChange(rel);
      if (kind === 'progress') progDirty = true;
      else if (kind === 'code') codeDirty = true;
    };

    for (const p of porcelainZ(root, ['-uall', '--', '.']).paths) take(p);
    if (codeDirty && !progDirty) {
      dirtyReason = '工作树有未提交代码/家底改动但 progress.md 未同步（本轮决策尚未写入项目记忆）';
    }
  }

  if (!dirtyReason) {
    fs.rmSync(mark, { force: true });
    return;
  }

  try {
    fs.mkdirSync(path.dirname(mark), { recursive: true });
    fs.writeFileSync(mark, `${now}\n`, 'utf8');
  } catch (_e) { /* 写冷却标记失败最多多拦一次 */ }

  const reason = `压缩前守门：${dirtyReason}。上下文压缩会将对话正文替换为摘要，未落盘决策极易丢失——请先派 progress-recorder（/record）固化本轮决策/完成项并处理待审项，再重试压缩（本次拦截后 10 分钟内自动放行）。`;

  if (mode === 'advise') {
    const msg = `[fast] ${reason}`;
    gateLog('precompact-gate', msg, root);
    emit({ systemMessage: msg });
    return;
  }

  gateLog('precompact-gate', reason, root);
  emit({ decision: 'block', reason });
});
