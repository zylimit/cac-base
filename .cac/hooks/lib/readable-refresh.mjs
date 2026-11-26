// readable-refresh.mjs — pre-commit-check 中「提交前自动重出人读工程文档并核对结构退化」。
// 仅当项目含 docs/readable-src/config.json 时激活；生成器位于 .cac/scripts/readable-docs.mjs。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, git, say, errText, toPosix } from './io.mjs';
import { gateLog } from './gatelog.mjs';

const CONFIG = 'docs/readable-src/config.json';
const SCRIPT = '.cac/scripts/readable-docs.mjs';
const OUT = 'docs/readable';
const BUILD_TIMEOUT_MS = 10000;
const CHECK_TIMEOUT_MS = 5000;
const SUGGEST_TIMEOUT_MS = 3000;
const STRUCT_TIMEOUT_MS = 3000;
const MAX_BUFFER = 64 * 1024 * 1024;
const LIST_CAP = 5;
const OUT_OF_SYNC = '人读文档这次没重出，现在与来源不同步';
const ARCH_INDEX = `${OUT}/arch/index.html`;
const NAME_CAP = 3;
const WORSE_HEAD = '人读文档·结构：这次提交多了';
const WORSE_LOG = '[advise] 结构变坏：';

const local = (root, rel) => path.join(root, ...rel.split('/'));

function runDocs(root, sub, timeout) {
  return run(process.execPath, [local(root, SCRIPT), ...sub, '--root', root], {
    cwd: root,
    timeout,
    maxBuffer: MAX_BUFFER,
  });
}

function failReason(r, timeout) {
  if (r.error && r.error.code === 'ETIMEDOUT') return `超过 ${timeout / 1000} 秒没跑完，已中止`;
  if (r.error) return `起不来：${errText(r.error)}`;
  const text = `${r.stderr}${r.stdout}`.trimEnd();
  return `退出码 ${r.status}${text ? `：\n${text}` : '（无输出）'}`;
}

function unstagedPages(root) {
  const diff = git(['-c', 'core.quotePath=false', 'diff', '--relative', '--no-renames', '--name-status', '-z', '--', OUT], { cwd: root });
  const others = git(['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard', '-z', '--', OUT], { cwd: root });
  for (const r of [diff, others]) {
    if (r.status !== 0) return { error: r.error ? errText(r.error) : (r.stderr.trim() || `git 退出码 ${r.status}`) };
  }
  const changed = new Map();
  const recs = diff.stdout.split('\0');
  for (let i = 0; i + 1 < recs.length; i += 2) {
    if (recs[i]) changed.set(toPosix(recs[i + 1]), recs[i] === 'D' ? '删掉' : '改动');
  }
  for (const p of others.stdout.split('\0')) {
    if (p) changed.set(toPosix(p), '新增');
  }
  return { paths: [...changed.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)) };
}

function noteDebt(root) {
  const r = runDocs(root, ['check', '--json'], CHECK_TIMEOUT_MS);
  if (r.error || (r.status !== 0 && r.status !== 1)) return { error: `readable-docs.mjs check --json ${failReason(r, CHECK_TIMEOUT_MS)}` };
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch (e) { return { error: `check --json 的输出不是 JSON：${errText(e)}` }; }
  const problems = parsed && Array.isArray(parsed.problems) ? parsed.problems : null;
  if (!problems) return { error: 'check --json 的输出里没有 problems 清单' };
  const count = (kind) => problems.filter((p) => p && p.kind === kind).length;
  return { stale: count('note-stale'), orphan: count('note-orphan') };
}

function configGaps(root) {
  const r = runDocs(root, ['init', '--suggest', '--json'], SUGGEST_TIMEOUT_MS);
  if (r.error || (r.status !== 0 && r.status !== 1)) return { error: `readable-docs.mjs init --suggest --json ${failReason(r, SUGGEST_TIMEOUT_MS)}` };
  if (r.status === 0) return { gaps: [] };
  let m;
  try { m = JSON.parse(r.stdout).missing; } catch (e) { return { error: `init --suggest --json 的输出不是 JSON：${errText(e)}` }; }
  const list = (key, xs) => (Array.isArray(xs) && xs.length
    ? `${key} 漏了 ${xs.slice(0, LIST_CAP).join('、')}${xs.length > LIST_CAP ? ` 等 ${xs.length} 个` : ''}` : null);
  const gaps = m && typeof m === 'object'
    ? [list('ddl', m.ddl), list('codeRoots', m.codeRoots), m.spec ? `spec 是 null 而根目录有 ${m.spec}` : null, list('archDocs', m.archDocs)].filter(Boolean)
    : [];
  return gaps.length ? { gaps } : { error: 'init --suggest --json 退出码 1，输出里却认不出漏了什么' };
}

function structureOf(root, page) {
  const r = runDocs(root, ['structure', '--page', page, '--json'], STRUCT_TIMEOUT_MS);
  if (!r.error && r.status === 2) return { skip: true };
  if (r.error) return { error: `readable-docs.mjs structure ${failReason(r, STRUCT_TIMEOUT_MS)}` };
  if (r.status !== 0) {
    const first = `${r.stderr}${r.stdout}`.split(/\r?\n/).find((l) => l.trim());
    return { error: `readable-docs.mjs structure 退出码 ${r.status}${first ? `：${first.trim()}` : '（无输出）'}` };
  }
  let s;
  try { s = JSON.parse(r.stdout); } catch (e) { return { error: `structure --json 的输出不是 JSON：${errText(e)}` }; }
  const ok = s && ['cycles', 'upward', 'unassigned', 'big'].every((k) => Array.isArray(s[k])) && Number.isInteger(s.problems)
    && [...s.cycles, ...s.upward].every((u) => u && typeof u.key === 'string' && Number.isInteger(u.pairs));
  return ok ? { s } : { error: 'structure --json 的输出里五样不全或形状不对' };
}

function worsened(prev, cur) {
  const members = (c) => c.split(' ').sort().join(' ');
  const fresh = (was, now) => { const had = new Set(was); return now.filter((x) => !had.has(x)); };
  const grew = (was, now, norm, what) => {
    const before = new Map(was.map((x) => [norm(x.key), x.pairs]));
    return now.filter((x) => !before.has(norm(x.key)) || x.pairs > before.get(norm(x.key)))
      .map((x) => `「${x.key}」${before.has(norm(x.key)) ? `文件对 ${before.get(norm(x.key))}→${x.pairs}` : `${what}、${x.pairs} 对文件`}`);
  };
  const cycles = grew(prev.cycles, cur.cycles, members, '新的一组');
  const upward = grew(prev.upward, cur.upward, (k) => k, '新的一对');
  const named = (what, unit, list) => (list.length ? `${what} ${list.length} ${unit}：${list.slice(0, NAME_CAP).join('、')}${list.length > NAME_CAP ? `，另 ${list.length - NAME_CAP} ${unit}` : ''}` : null);
  const q = (xs) => xs.map((x) => `「${x}」`);
  return [
    named('循环依赖', '组', cycles),
    named('越层引用', '对模块', upward),
    named('未归属的文件', '个', q(fresh(prev.unassigned, cur.unassigned))),
    named('超过 1000 行的文件', '个', q(fresh(prev.big, cur.big))),
    cur.problems > prev.problems ? `项目判断里对不上的 ${prev.problems}→${cur.problems} 条` : null,
  ].filter(Boolean);
}

function headPage(root) {
  const v = git(['rev-parse', '-q', '--verify', `HEAD:./${ARCH_INDEX}`], { cwd: root });
  if (!v.error && v.status === 1) return { skip: true };
  const c = v.status === 0 ? git(['cat-file', 'blob', v.stdout.trim()], { cwd: root, maxBuffer: MAX_BUFFER }) : v;
  if (c.error || c.status !== 0) return { error: `git 取不出上一个提交里的 ${ARCH_INDEX}（${c.error ? errText(c.error) : (c.stderr.trim() || `退出码 ${c.status}`)}）` };
  return { text: c.stdout };
}

function structureWatch(root) {
  let tmp = null;
  try {
    const curFile = local(root, ARCH_INDEX);
    if (!fs.existsSync(curFile)) return;
    const head = headPage(root);
    if (head.skip) return;
    const brief = (why) => Array.from(String(why).split(/\r?\n/)[0]).slice(0, 120).join('');
    const cannot = (why) => say(`⚠️ 人读文档已重出，但没比成结构（${brief(why)}）——不拦这次提交。`);
    if (head.error) { cannot(head.error); return; }
    if (head.text === fs.readFileSync(curFile, 'utf8')) return;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cac-readable-structure-'));
    const prevFile = path.join(tmp, 'index.html');
    fs.writeFileSync(prevFile, head.text, 'utf8');
    const prev = structureOf(root, prevFile);
    const cur = structureOf(root, curFile);
    if (prev.error || cur.error) { cannot(prev.error || cur.error); return; }
    if (prev.skip || cur.skip) return;
    const more = worsened(prev.s, cur.s);
    if (!more.length) return;
    say(`${WORSE_HEAD} ${more.join('；')}——是有意的在提交说明里写明原因，不是就先理顺再提交。`);
    gateLog('pre-commit-check', `${WORSE_LOG}${more.join('；')}`, root);
  } catch (e) {
    say(`⚠️ 人读文档已重出，但比结构那一步自身出错（${Array.from(errText(e).split(/\r?\n/)[0]).slice(0, 120).join('')}）——不拦这次提交。`);
  } finally {
    if (tmp) {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { say(`⚠️ 比结构用的临时目录没删掉（${tmp}：${errText(e)}）`); }
    }
  }
}

function reportChanges(paths, mode, root) {
  const n = (what) => paths.filter(([, k]) => k === what).length;
  const head = `docs/readable/ 有 ${paths.length} 页重出后变了、还没暂存（改动 ${n('改动')}、新增 ${n('新增')}、删掉 ${n('删掉')}）`;
  const list = paths.slice(0, LIST_CAP).map(([p, k]) => `  ${k} ${p}`);
  if (paths.length > LIST_CAP) list.push(`  另有 ${paths.length - LIST_CAP} 页`);
  const hint = 'git add docs/readable 之后重提——生成是确定的，暂存后再提交这一段就过。';
  if (mode === 'advise') {
    say(`⚠️ 人读文档：${head}：\n${list.join('\n')}\n${hint}`);
    say('[fast] fast 档不拦本次 commit——不 git add，这些页就不在这次提交里，仓里的文档落后于代码。');
    gateLog('pre-commit-check', `[fast] 人读文档 ${paths.length} 页没暂存，advise 档放行 commit`, root);
    return false;
  }
  say(`❌ 人读文档：${head}，commit 被阻止：\n${list.join('\n')}\n${hint}`);
  gateLog('pre-commit-check', `人读文档 ${paths.length} 页重出后没暂存，commit 被阻止`, root);
  return true;
}

function refresh(root, mode) {
  if (!fs.existsSync(local(root, SCRIPT))) {
    say(`⚠️ 有 ${CONFIG} 但没装 ${SCRIPT}，${OUT_OF_SYNC}——不拦这次提交，补装框架后重出。`);
    gateLog('pre-commit-check', `人读文档没重出（没装 ${SCRIPT}），放行 commit`, root);
    return false;
  }
  const b = runDocs(root, ['build'], BUILD_TIMEOUT_MS);
  if (b.error || b.status !== 0) {
    say(`⚠️ 人读文档重出失败（readable-docs.mjs build ${failReason(b, BUILD_TIMEOUT_MS)}）\n${OUT_OF_SYNC}——不拦这次提交，修好后手跑 build 再提交一次。`);
    const short = b.error ? (b.error.code === 'ETIMEDOUT' ? '超时' : errText(b.error)) : `退出码 ${b.status}`;
    gateLog('pre-commit-check', `人读文档没重出（build ${short}），放行 commit`, root);
    return false;
  }
  if (b.stderr.trim()) say(b.stderr.trimEnd());

  const ch = unstagedPages(root);
  const held = ch.error ? false : (ch.paths.length > 0 && reportChanges(ch.paths, mode, root));
  if (ch.error) say(`⚠️ 人读文档已重出，但查不了 docs/readable/ 的暂存状态（${ch.error}）——不拦这次提交，提交前自己 git status 看一眼。`);

  const debt = noteDebt(root);
  if (debt.error) say(`⚠️ 人读文档已重出，但没数成说明的状态（${debt.error}）——不拦这次提交。`);
  else if (debt.stale || debt.orphan) {
    say(`⚠️ 人读文档有 ${debt.stale} 段说明待更新、${debt.orphan} 段成了孤儿——不拦这次提交，任务验收前补齐（node ${SCRIPT} pending 看清单）。`);
  }

  const cfg = configGaps(root);
  if (cfg.error) say(`⚠️ 人读文档已重出，但没查成配置有没有漏项（${cfg.error}）——不拦这次提交。`);
  else if (cfg.gaps.length) {
    say(`⚠️ 人读文档的配置没跟上项目：${cfg.gaps.join('；')}——不拦这次提交，填进 ${CONFIG}（不该算的写进 ignore）后重出（node ${SCRIPT} init --suggest 看清单）。`);
  }

  if (!ch.error && !ch.paths.length) structureWatch(root);
  return held;
}

export function refreshReadableDocs(root, mode) {
  if (!fs.existsSync(local(root, CONFIG))) return false;
  try {
    return refresh(root, mode);
  } catch (e) {
    say(`⚠️ 人读文档那一段自身出错（${errText(e)}），${OUT_OF_SYNC}——不拦这次提交。`);
    gateLog('pre-commit-check', `人读文档那一段自身出错，放行 commit：${errText(e)}`, root);
    return false;
  }
}
