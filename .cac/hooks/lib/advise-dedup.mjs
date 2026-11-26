// advise-dedup.mjs — advise 档提醒去重：同一签名在 ADVISE_REPEAT_MS（1h）内只提醒一次。
// 读写异常一律视为未提醒（宁可多说一次，绝不因状态损坏而永久静默）；block 档不走去重。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readTextFile } from './io.mjs';

export const ADVISE_REPEAT_MS = 60 * 60 * 1000;

export function listSig(items) {
  return crypto.createHash('sha256').update([...items].sort().join('\n')).digest('hex');
}

export function textSig(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

export function recentlyAdvised(markerPath, sig, repeatMs = ADVISE_REPEAT_MS) {
  const st = readTextFile(markerPath);
  if (!st.text) return false;
  const lines = st.text.replace(/\r/g, '').split('\n');
  const oldSig = (lines.find((l) => l.startsWith('sig=')) || '').slice(4);
  const ts = (lines.find((l) => l.startsWith('ts=')) || '').slice(3);
  if (oldSig !== sig || !/^\d+$/.test(ts)) return false;
  const age = Date.now() - Number(ts);
  return age >= 0 && age < repeatMs;
}

export function recordAdvised(markerPath, sig) {
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, `sig=${sig}\nts=${Date.now()}\n`, 'utf8');
  } catch (_e) { /* 写失败下次再提醒 */ }
}

export function clearAdvised(markerPath) {
  try { fs.rmSync(markerPath, { force: true }); } catch (_e) { /* ignore */ }
}
