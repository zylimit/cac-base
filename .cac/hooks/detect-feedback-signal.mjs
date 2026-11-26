// UserPromptSubmit：检测用户发言中的纠正/反馈信号，命中时入队 .cac/signals.jsonl 并注入上下文提醒。
// 触发词从同目录 feedback-signals.txt 读取（URL 转路径一律使用 fileURLToPath），缺失时退回内置默认表。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectDir, readStdinJson, readTextFile, context, say, fastOff, runFailOpen } from './lib/io.mjs';

const DEFAULT_SIGNALS = '不是这样|别这样做|你搞错|搞错了|你错了|不对|不应该|你漏了|你忘了|改一下|不合理|你理解错|我说的不是|你确定|到底在|为什么没|没有执行|没有生效|你又忘|强调了|说过了|提醒过|怎么还|一直在|每次都|我不是让你|你先.*看|再说一遍|你到底|什么意思|能不能|不要再|别再|停下|不用管|先不要';

const CONTEXT = '检测到用户纠正/反馈信号。请严格执行纠正当场落地三步铁律：① 立即将纠正应用到当前产物与 progress.md Decisions；② 派发 feedback-observer sub-agent（使用 feedback-writer skill，传递用户原话摘录与涉及文件路径）去重记录到 .cac/feedback/ 并更新 FEEDBACK-INDEX.md；③ 向用户明确回显「这次纠正改了 X 文件 Y 段」。';

runFailOpen(async () => {
  const ev = readStdinJson();
  if (!ev) return;
  const root = projectDir(ev);
  if (await fastOff('detect-feedback-signal', root)) return;

  const prompt = String(ev.prompt || '');
  if (!prompt) return;
  // 斜杠指令如 /release-builder 不当反馈纠正计
  if (/^\s*\/[a-z0-9_-]+/i.test(prompt)) return;

  const here = path.dirname(fileURLToPath(import.meta.url));
  const sidecar = readTextFile(path.join(here, 'feedback-signals.txt'));
  let pattern;
  if (sidecar.absent) {
    pattern = DEFAULT_SIGNALS;
  } else if (sidecar.error) {
    say(`[detect-feedback-signal] feedback-signals.txt 读失败（${sidecar.error.code || 'IO'}），退回内置默认触发词。`);
    pattern = DEFAULT_SIGNALS;
  } else {
    pattern = (sidecar.text || '').replace(/\r/g, '').trim();
    if (!pattern) return;
  }

  let re;
  try {
    re = new RegExp(pattern);
  } catch (e) {
    say(`[detect-feedback-signal] feedback-signals.txt 不是合法正则，跳过触发：${e.message}`);
    return;
  }

  const m = re.exec(prompt);
  if (!m) return;

  // 信号入队 .cac/signals.jsonl（供 evolution-engine 辅助聚合）
  if (root) {
    try {
      const sigFile = path.join(root, '.cac', 'signals.jsonl');
      fs.mkdirSync(path.dirname(sigFile), { recursive: true });
      fs.appendFileSync(sigFile, JSON.stringify({
        ts: new Date().toISOString(),
        signal: m[0],
        prompt: prompt.slice(0, 160),
        sessionId: ev.session_id || '',
      }) + '\n', 'utf8');
    } catch (_e) { /* 入队失败不阻断提醒 */ }
  }

  context('UserPromptSubmit', CONTEXT);
});
