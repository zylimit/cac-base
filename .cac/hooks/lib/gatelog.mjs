// gatelog.mjs — 拦停与提醒审计账本（供 gate-audit 统计活跃闸/静默闸）。
// 追加 `<ISO-8601 UTC>\t<hook>\t<reason 首行>` 到 .cac/evidence/gate-block.log。
// 旁路记账：任何 I/O 失败均静默吞掉，绝不逆转调用方的放行/阻断判决。
import fs from 'node:fs';
import path from 'node:path';

function fallbackRoot() {
  return process.env.CODEAGENT3_PROJECT_DIR || process.env.CAC_PROJECT_DIR || '';
}

export function gateLog(hook, reason, root = fallbackRoot()) {
  try {
    if (!root) return;
    const firstLine = String(reason === undefined || reason === null ? '' : reason).split(/\r?\n/)[0];
    const ts = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const dir = path.join(root, '.cac', 'evidence');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'gate-block.log'), `${ts}\t${hook || 'unknown'}\t${firstLine}\n`, 'utf8');
  } catch (_e) {
    /* 账本写失败不影响主判决 */
  }
}
