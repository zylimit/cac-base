// Stop hook：三文件同步铁律（progress.md + Product-Spec/CHANGELOG 成对）与设计详述（design-detail-sync）守门闸。
//
// C1：工作树有未提交代码/家底改动（含 .cac/ 与 .cac/rules/AGENTS.md）且 progress.md 未同步；
// C2：Product-Spec.md 与 Product-Spec-CHANGELOG.md 均存在时仅改了其中一份；
// DD：改动文件命中 docs/design/*.md 文首 `> 代码范围：` 通配而对应设计详述未同步。
// 档位：standard 下 advise（1h 去重提醒）；strict（及家底改动自动升档）下 block（带 3 振熔断防死锁）。

import fs from 'node:fs';
import path from 'node:path';
import {
  projectDir, readStdinJson, readTextFile, git, porcelainZ, classifyChange, relToProject,
  emit, gateModeOf, runFailClosed,
} from './lib/io.mjs';
import { gateLog } from './lib/gatelog.mjs';
import { listSig, recentlyAdvised, recordAdvised, clearAdvised } from './lib/advise-dedup.mjs';

function globToRe(raw) {
  const g = raw.trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  if (!g.includes('*')) return new RegExp('^' + g.replace(/[.+?^${}()|[\]\\]/g, '\\$&') + '(?:/.*)?$');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else {
        re += '[^/]*';
      }
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$');
}

function designDetails(root) {
  const dir = path.join(root, 'docs', 'design');
  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort(); } catch (_e) { return []; }
  const out = [];
  for (const n of names) {
    const full = path.join(dir, n);
    let st;
    try { st = fs.statSync(full); } catch (_e) { continue; }
    if (!st.isFile()) continue;
    const text = fs.readFileSync(full, 'utf8');
    const m = /^>\s*代码范围[:：](.*)$/m.exec(text);
    const globs = m ? [...m[1].matchAll(/`([^`]+)`/g)].map((x) => x[1].trim()).filter((x) => x && !x.includes('{{')) : [];
    out.push({ rel: `docs/design/${n}`, res: globs.map(globToRe) });
  }
  return out;
}

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

runFailClosed(async () => {
  const ev = readStdinJson();
  if (ev && ev.stop_hook_active) return;
  const root = projectDir(ev);
  const mode = await gateModeOf('three-file-sync-gate', root);
  const ddMode = await gateModeOf('design-detail-sync', root);
  if (mode === 'off' && ddMode === 'off') return;

  const c12 = mode !== 'off' && fs.existsSync(path.join(root, 'progress.md'));
  const dds = ddMode !== 'off' ? designDetails(root) : [];
  if (!c12 && dds.length === 0) return;

  if (git(['rev-parse', '--is-inside-work-tree'], { cwd: root }).status !== 0) return;

  const prefix = git(['rev-parse', '--show-prefix'], { cwd: root }).stdout.replace(/\r?\n$/, '');

  let codeDirty = false;
  let progDirty = false;
  let specDirty = false;
  let changelogDirty = false;
  let firstCode = '';
  const changed = new Set();

  const take = (p) => {
    const rel = relToProject(p, prefix);
    if (rel === null) return;
    changed.add(rel);
    switch (classifyChange(rel)) {
      case 'progress': progDirty = true; break;
      case 'spec': specDirty = true; break;
      case 'changelog': changelogDirty = true; break;
      case 'code':
        codeDirty = true;
        if (!firstCode) firstCode = rel;
        break;
      default: break;
    }
  };

  const st = porcelainZ(root, ['-uall', '--', '.']);
  if (st.status !== 0) {
    const head = String(st.stderr || '').split(/\r?\n/).filter((l) => l.trim() !== '').slice(0, 2).join(' ').slice(0, 300);
    throw new Error(`git status --porcelain -z 以 ${st.status} 退出：${head || '（无 stderr）'}`);
  }
  for (const p of st.paths) take(p);

  const reasons = [];
  const kinds = [];

  if (c12 && codeDirty && !progDirty) {
    kinds.push('C1');
    reasons.push(`三文件同步铁律：检测到未提交的代码/家底改动（如 ${firstCode}）但 progress.md 未同步。请把本轮决策、完成项或新任务写入 progress.md 后重试停止。`);
  }

  if (c12 && fs.existsSync(path.join(root, 'Product-Spec.md')) && fs.existsSync(path.join(root, 'Product-Spec-CHANGELOG.md'))) {
    if (specDirty && !changelogDirty) {
      kinds.push('C2a');
      reasons.push('Product-Spec.md 有未提交改动但 Product-Spec-CHANGELOG.md 未同步，需求变更须成对更新两份文件。');
    }
    if (changelogDirty && !specDirty) {
      kinds.push('C2b');
      reasons.push('Product-Spec-CHANGELOG.md 有未提交改动但 Product-Spec.md 未同步，需求变更须成对更新两份文件。');
    }
  }

  const ddReasons = [];
  if (ddMode !== 'off') {
    for (const d of dds) {
      if (changed.has(d.rel)) continue;
      const hit = [...changed].filter((f) => !f.startsWith('docs/design/') && d.res.some((re) => re.test(f)));
      if (hit.length === 0) continue;
      const names = hit.slice(0, 3).join('、') + (hit.length > 3 ? ` 等 ${hit.length} 个` : '');
      kinds.push(`DD:${d.rel}`);
      ddReasons.push(`设计详述同步：改动了 ${names}（落在 ${d.rel} 的代码范围内），但 ${d.rel} 未同步。`);
    }
  }

  const blocking = (reasons.length > 0 && mode !== 'advise') || (ddReasons.length > 0 && ddMode === 'block');
  const advisedFile = path.join(root, '.cac', '.three-file-sync-advised');
  const strikeFile = path.join(root, '.cac', '.runtime', 'three-file-sync-strikes');

  if (reasons.length === 0 && ddReasons.length === 0) {
    if (mode === 'advise') clearAdvised(advisedFile);
    try { fs.rmSync(strikeFile, { force: true }); } catch (_e) { /* ignore */ }
    return;
  }

  if (mode === 'advise' && reasons.length > 0 && !blocking) {
    const sig = listSig(kinds);
    if (recentlyAdvised(advisedFile, sig)) reasons.length = 0;
    else recordAdvised(advisedFile, sig);
  }

  if (reasons.length === 0 && ddReasons.length === 0) return;

  const tag = (list, m) => (blocking && m === 'advise' ? list.map((r) => `（仅提醒）${r}`) : list);
  const reason = [...tag(reasons, mode), ...tag(ddReasons, ddMode)].join(' ');

  if (!blocking) {
    const msg = `[advise] ${reason}`;
    gateLog('three-file-sync-gate', msg, root);
    emit({ systemMessage: msg });
    return;
  }

  // block 档同样配置 3 振熔断（子代理或自动无人值守环境防止无限死锁）
  const blockSig = listSig(kinds);
  const strikes = readStrikes(strikeFile, blockSig);
  if (strikes >= 3) {
    try { fs.rmSync(strikeFile, { force: true }); } catch (_e) { /* ignore */ }
    const notice = `three-file-sync-gate：连续拦截已达 3 次上限，本次放行——但同步欠账仍在：${reason}`;
    gateLog('three-file-sync-gate', notice, root);
    emit({ systemMessage: notice });
    return;
  }
  writeStrikes(strikeFile, blockSig, strikes + 1);

  gateLog('three-file-sync-gate', reason, root);
  emit({ decision: 'block', reason });
}, 'three-file-sync-gate 自检失败，fail-closed 拦停——请修复闸后重试停止。');
