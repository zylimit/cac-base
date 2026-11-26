#!/usr/bin/env node
// readable-docs.mjs —— 「人读文档」生成器的入口：串起 取事实 → 连关联绑说明 → 出页面 → 核对。
// 用法：node .cac/scripts/readable-docs.mjs <子命令> [--root <目录>] [--json]
//   init                 起草 docs/readable-src/config.json；已存在则一个字节不动、报「配置已存在」
//   init --suggest       只读：照现在的项目重做一遍起草、与配置比，报漏列的建表定义、代码目录、需求规格与架构文档；
//                        退出码 0 没有漏项、1 有漏项，配置不在退出码 2
//   build --facts-json   只取事实、不出页面：文档模型（一份 JSON）打到标准输出，提示走标准错误
//   build                出页面到 docs/readable/：先写同级临时目录，写完核对再整目录换上
//   pending [--json]     按表与模块列出要补的说明；--json 时附一份上下文，退出码恒为 0
//   note put [--file <文件>]                  交若干段「## <锚点>」加正文（不给文件读标准输入），全过才落盘、盖指纹、记 draft
//   note confirm <锚点…> | --all  --by <名字>  指纹对得上的记成 reviewed；对不上的不改、列出来，退出码 1
//   note drop <锚点…>                         删掉这几段说明
//   check [--json]       逐项比对文档与来源，一条一行「在哪：怎么不一致」，末行「不一致 N 条」；摘要走标准错误
//   structure [--page <架构首页文件>] [--json]  只读：从一张架构首页读回结构的五样，不给 --page 读 docs/readable/arch/index.html；
//                        页面不在、是没有读回标记的旧格式、项目没出架构设计都是退出码 2
//   --root   目标目录，默认 $CODEAGENT3_PROJECT_DIR / $CAC_PROJECT_DIR，再默认当前目录
//   --json   init（含 --suggest）、pending、check 与 structure 的结果只出一份 JSON（标准输出只有它）
// 退出码：0 成功；1 有不一致（check 的清单不空、note confirm 遇到指纹对不上的）；2 用法或配置错（含 note put 整批被拒、structure 取不到结构）；3 脚本自身出错（含页面落盘失败、build 落盘前的自检不过）
// 测试注入点：READABLE_FAIL_AT = render | selfcheck | leak | spec-cut | spec-render | arch-render | arch-show-key | arch-show-head | arch-drop-section | arch-doc-cut | arch-doc-render
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { cmp } from './readable/model.mjs';
import { walk, cmdInit, cmdSuggest } from './readable/init.mjs';
import { extract as extractDdl } from './readable/sources/sql-ddl.mjs';
import { extract as extractCode, isCodeFile } from './readable/sources/code-scan.mjs';
import { extract as extractSpec, extractDocs, SpecLoss } from './readable/sources/md-blocks.mjs';
import { extract as extractImports } from './readable/sources/code-imports.mjs';
import { addRoutes } from './readable/sources/code-routes.mjs';
import { ConfigError, loadConfig, loadMap, bindNotes, putNotes, confirmNotes, dropNotes, pendingList } from './readable/notes.mjs';
import { link } from './readable/links.mjs';
import { buildArch } from './readable/links-arch.mjs';
import { renderDb } from './readable/render/db.mjs';
import { renderArch } from './readable/render/arch.mjs';
import { renderHome } from './readable/render/layout.mjs';
import { renderSpec } from './readable/render/spec.mjs';
import { renderArchDocs } from './readable/render/arch-docs.mjs';
import { OUT, publish } from './readable/render/publish.mjs';
import { CheckFailed, runCheck, selfCheck, lines, summaryLine } from './readable/check.mjs';
import { StructureUnreadable, readStructure, structureLine } from './readable/structure.mjs';
const USAGE = 'node .cac/scripts/readable-docs.mjs <init [--suggest] | build [--facts-json] | check | pending | structure [--page <架构首页文件>] | note put [--file <文件>] | note confirm <锚点…>|--all --by <名字> | note drop <锚点…>> [--root <目录>] [--json]';
const NOTE_ACTIONS = ['put', 'confirm', 'drop'];
const CHECK_PAGE_CAP = 10;

function die(code, msg) { console.error(`readable-docs: ${msg}`); process.exit(code); }
const usage = (msg) => die(2, `${msg}（用法：${USAGE}）`);

function parseArgs(argv) {
  const sub = argv[0];
  if (!sub || sub.startsWith('-')) usage('缺子命令');
  if (!Object.hasOwn(COMMANDS, sub)) usage(`未知子命令：${sub}`);
  const o = { sub, root: process.env.CODEAGENT3_PROJECT_DIR || process.env.CAC_PROJECT_DIR || process.cwd(), json: false, factsJson: false, suggest: false, action: null, file: null, by: null, all: false, anchors: [], page: null };
  const value = (i, flag) => { if (argv[i] === undefined) usage(`${flag} 缺值`); return argv[i]; };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') o.root = value(++i, '--root');
    else if (a === '--json') o.json = true;
    else if (a === '--facts-json' && sub === 'build') o.factsJson = true;
    else if (a === '--suggest' && sub === 'init') o.suggest = true;
    else if (a === '--page' && sub === 'structure') o.page = value(++i, '--page');
    else if (sub === 'note' && !o.action && NOTE_ACTIONS.includes(a)) o.action = a;
    else if (o.action === 'put' && a === '--file') o.file = value(++i, '--file');
    else if (o.action === 'confirm' && a === '--by') o.by = value(++i, '--by').trim();
    else if (o.action === 'confirm' && a === '--all') o.all = true;
    else if ((o.action === 'confirm' || o.action === 'drop') && !a.startsWith('-')) o.anchors.push(a);
    else usage(`未知参数：${a}`);
  }
  if (sub === 'note' && !o.action) usage('note 后面要跟 put、confirm 或 drop');
  if (o.action === 'confirm') {
    if (!o.by) usage('note confirm 要用 --by <名字> 写明谁抽审的');
    if (/[<>\r\n]/.test(o.by)) usage('--by 的名字里不许有尖括号与换行');
    if (o.all === (o.anchors.length > 0)) usage('note confirm 要么点名锚点，要么 --all，二者取一');
  }
  if (o.action === 'drop' && !o.anchors.length) usage('note drop 后面要跟要删的锚点');
  if (o.file !== null && !(existsSync(o.file) && statSync(o.file).isFile())) usage(`--file 不是文件：${o.file}`);
  if (!existsSync(o.root) || !statSync(o.root).isDirectory()) usage(`--root 不是目录：${o.root}`);
  return o;
}

// 扫谁写谁读的文件：codeRoots 下的 .py 与 JS 一族，去掉 ignore 命中的；几个 codeRoots 重叠的只扫一次。
const codeFiles = (root, cfg) => [...new Set(cfg.codeRoots.flatMap((d) => walk(root, cfg.ignore, d)).filter(isCodeFile))].sort(cmp);

// 取事实：需求规格与架构文档切块自检 → 建表定义 → 项目判断 → 代码里的写读 → 连起来 → 代码引用与接口 → 模块汇总 → 绑说明。
function collect(root, cfg, skipped) {
  const spec = extractSpec(cfg, root), archDocs = extractDocs(cfg, root);
  const ddl = extractDdl(cfg, root, skipped);
  const map = loadMap(root, ddl.tables.map((t) => t.name));
  const scan = extractCode(cfg, root, codeFiles(root, cfg), [...ddl.tables, ...ddl.views].map((x) => x.name));
  const linked = link(ddl, scan, map, cfg.ddl);
  const unscanned = scan.unscanned.sort((a, b) => cmp(a.file, b.file));
  const ambiguous = linked.ambiguous ?? scan.ambiguous ?? [];
  const codeAll = [...new Set(cfg.codeRoots.flatMap((d) => walk(root, cfg.ignore, d)))].sort(cmp);
  const code = addRoutes(extractImports(cfg, root, codeAll), cfg, root, codeAll);
  const arch = buildArch(code, linked.usage, map.arch, cfg.codeRoots);
  const facts = { ...ddl, groups: linked.groups, usage: linked.usage, dynamic: linked.dynamic, ambiguous, codeTables: linked.codeTables, unscanned, mapProblems: map.problems, spec, archDocs, code, arch };
  return { ...facts, ...bindNotes(root, facts) };
}
const loadFacts = (o) => collect(o.root, loadConfig(o.root), {});

// 出页面（只返回「路径 → 内容」，不碰磁盘）：build 落盘与 check 第 1 项重出用的是这同一个。
function pages(root, cfg, facts) {
  const page = { ...cfg, title: typeof cfg.title === 'string' && cfg.title ? cfg.title : basename(resolve(root)) };
  const at = process.env.READABLE_FAIL_AT, hasArch = facts.arch.modules.length > 0;
  if (!hasArch && ['arch-render', 'arch-show-key', 'arch-show-head', 'arch-drop-section'].includes(at)) throw new Error(`READABLE_FAIL_AT=${at}：这个项目没有架构这一份，注入点没有可下手的地方`);
  if (at === 'arch-doc-render' && !(hasArch && facts.archDocs.length)) throw new Error(`READABLE_FAIL_AT=${at}：${hasArch ? '没配 archDocs' : '这个项目没有架构这一份'}，现有架构文档的页面不出，注入点没有可下手的地方`);
  const archDocs = hasArch ? renderArchDocs(facts.archDocs, { title: page.title }) : [];
  const arch = hasArch ? renderArch(facts, { title: page.title, docs: archDocs.map((d) => d.row) }) : null;
  const db = renderDb(facts, page, arch ? { moduleOf: arch.moduleOf } : {}), spec = facts.spec ? renderSpec(facts.spec, { title: db.title }) : null;
  const docs = [db.entry, ...(arch ? [arch.entry] : []), ...(spec ? [spec.entry] : [])];
  return { db, spec, arch, archDocs, files: [renderHome(db.title, docs), ...db.files, ...(arch ? arch.files : []), ...archDocs.flatMap((d) => d.files), ...(spec ? spec.files : [])] };
}

function cmdCheck(o) {
  const cfg = loadConfig(o.root), facts = collect(o.root, cfg, {});
  const r = runCheck({ dir: join(o.root, OUT), label: `${OUT}/`, facts, rendered: pages(o.root, cfg, facts).files });
  if (o.json) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  else { console.error(`readable-docs: ${summaryLine(r.summary)}`); console.log(lines(r.problems, CHECK_PAGE_CAP).join('\n')); }
  process.exitCode = r.ok ? 0 : 1;
}

function cmdBuild(o) {
  const cfg = loadConfig(o.root), skipped = {};
  const facts = collect(o.root, cfg, skipped);
  const cols = facts.tables.reduce((s, t) => s + t.columns.length, 0);
  const uses = Object.values(facts.usage).reduce((s, u) => [s[0] + u.writes.length, s[1] + u.reads.length], [0, 0]);
  const tally = `表 ${facts.tables.length} 张、列 ${cols} 个；未合并的动态定义 ${facts.unfolded.length}、未解析的语句 ${facts.unparsed.length}、定义冲突 ${facts.conflicts.length}、改了不存在的表 ${facts.orphanAlters.length}`
    + `；分 ${facts.groups.length} 组；代码里写 ${uses[0]} 处、读 ${uses[1]} 处，表名运行时拼的 ${facts.dynamic.length}、代码里建的表 ${facts.codeTables.length}、没扫成的文件 ${facts.unscanned.length}、项目判断里对不上的 ${facts.mapProblems.length}`
    + `；说明 ${Object.keys(facts.notes).length} 段（待更新 ${Object.values(facts.notes).filter((n) => n.state === 'stale').length}）、孤儿 ${facts.orphanNotes.length} 段`;
  const a = facts.arch, archTally = cfg.codeRoots.length ? `架构：模块 ${a.modules.length} 个（${a.source === 'map' ? '取自项目判断' : '按目录分的，还没有项目判断'}）、未归属的文件 ${a.unassigned.length} 个`
    + `；循环依赖 ${a.cycles.length} 组、越层引用 ${a.upward.reduce((s, u) => s + u.pairs.length, 0)} 处、接口 ${facts.code.routes.length} 个、项目判断里对不上的 ${a.problems.length} 条`
    + `；没解析到的引用 ${facts.code.unresolved.length} 处、运行时才定的引用 ${facts.code.dynamic.length} 处` : null;
  const sk = Object.entries(skipped).sort((a, b) => cmp(a[0], b[0]));
  if (o.factsJson) {
    process.stdout.write(`${JSON.stringify(facts, null, 2)}\n`);
    console.error(`readable-docs: ${tally}`);
    if (archTally) console.error(`readable-docs: ${archTally}`);
    if (sk.length) console.error(`readable-docs: 略过的非结构语句：${sk.map(([k, n]) => `${k} ${n}`).join('、')}`);
    return;
  }
  const { db, spec, arch, archDocs, files } = pages(o.root, cfg, facts);
  publish(o.root, files, (tmp) => selfCheck(tmp, facts));
  const bytes = files.reduce((s, f) => s + Buffer.byteLength(f.html), 0);
  console.log(`已生成 ${OUT}/：${files.length} 个页面、${bytes} 字节`);
  console.log(`  数据库设计：${tally}；组页 ${db.stats.groupPages} 页，最大一页 ${db.stats.largest} 张表`);
  if (archTally) console.log(`  ${archTally}`);
  if (arch) console.log(`  架构设计：${arch.stats.pages} 页（首页、接口总表，模块页 ${arch.stats.modules} 页）；隐去 ${arch.stats.hidden} 处`);
  const sum = (key) => archDocs.reduce((s, d) => s + d.stats[key], 0);
  if (facts.archDocs.length) console.log(`  现有架构文档：${arch ? `${archDocs.length} 份、共 ${sum('pages')} 章、${sum('blocks')} 块；隐去 ${sum('hidden')} 处` : '配了 archDocs，但这个项目没有架构这一份，没出'}`);
  if (spec) {
    const k = {};
    for (const b of facts.spec.blocks) k[b.kind] = (k[b.kind] || 0) + 1;
    const kinds = Object.entries(k).sort((a, b) => cmp(a[0], b[0])).map(([x, n]) => `${x} ${n}`).join('、');
    console.log(`  需求规格：取自 ${facts.spec.file}，${spec.stats.pages} 章、${spec.stats.blocks} 块（${kinds || '没有块'}）；隐去 ${spec.stats.hidden} 处`);
  }
  if (sk.length) console.log(`  略过的非结构语句：${sk.map(([k, n]) => `${k} ${n}`).join('、')}`);
}

const refuse = (msg) => { console.error(`readable-docs: ${msg}`); process.exitCode = 2; };
const indent = (text) => text.split(/\r?\n/).map((l) => `    ${l}`).join('\n');
const today = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

function cmdNote(o) {
  if (o.action === 'drop') {
    const r = dropNotes(o.root, o.anchors);
    if (r.missing.length) return refuse(`这几个锚点没有说明，一段都没删：${r.missing.join('、')}`);
    console.log(`已删掉 ${r.dropped.length} 段说明：${r.dropped.join('、')}`);
    return;
  }
  const facts = loadFacts(o);
  if (o.action === 'put') {
    const r = putNotes(o.root, facts, readFileSync(o.file ?? 0, 'utf8'));
    if (!r.ok) {
      for (const p of r.problems) console.error(`readable-docs: ${p.where}：${p.reasons.join('；')}`);
      return refuse(`有 ${r.problems.length} 处不过，整批没有落盘`);
    }
    console.log(`已落盘 ${r.written.length} 段说明，状态 draft：${r.written.join('、')}`);
    return;
  }
  const r = confirmNotes(o.root, facts, o.all ? null : o.anchors, o.by, today());
  if (r.missing.length) return refuse(`这几个锚点没有说明，一段都没改：${r.missing.join('、')}`);
  console.log(`已记成 reviewed（${o.by}，${today()}）${r.confirmed.length} 段${r.confirmed.length ? `：${r.confirmed.join('、')}` : ''}`);
  if (r.kept.length) console.log(`原本已抽审、--all 没动的 ${r.kept.length} 段：${r.kept.join('、')}`);
  for (const m of r.mismatched) console.log(`没改 ${m.anchor}：${m.why}`);
  if (r.mismatched.length) process.exitCode = 1;
}

function cmdPending(o) {
  const r = pendingList(o.root, loadFacts(o));
  if (o.json) { process.stdout.write(`${JSON.stringify(r, null, 2)}\n`); return; }
  const s = r.summary;
  console.log(`要补的：表 ${s.tables} 张（缺表说明 ${s.missingTables} 张）、缺含义的列 ${s.columns} 个、组 ${s.groups} 个、doc:db ${s.doc ? '要补' : '不用补'}；待更新 ${s.stale} 段、孤儿 ${s.orphans} 段`);
  const staleLines = (list) => list.forEach((x) => console.log(`  待更新 ${x.anchor}，旧正文：\n${indent(x.text)}`));
  for (const t of r.tables) {
    const what = [t.missingTable ? '缺表说明' : null, t.missingColumns.length ? `缺含义的列 ${t.missingColumns.length} 个：${t.missingColumns.join('、')}` : null].filter(Boolean);
    console.log(`${t.anchor}${what.length ? `  ${what.join('；')}` : ''}`);
    staleLines(t.stale);
  }
  if (s.modules || s.archDoc) console.log(`架构要补的：模块 ${s.modules} 个（缺说明 ${s.missingModules} 个）、doc:arch ${s.archDoc ? '要补' : '不用补'}`);
  for (const g of [...r.groups, ...(r.doc ? [r.doc] : []), ...r.modules, ...(r.archDoc ? [r.archDoc] : [])]) {
    console.log(`${g.anchor}${g.missing ? '  缺说明' : ''}`);
    if (g.stale) staleLines([g.stale]);
  }
  for (const x of r.orphans) console.log(`孤儿 ${x.anchor}（锚点已经不存在），正文：\n${indent(x.text)}`);
}

function cmdStructure(o) {
  if (o.page === null && !loadConfig(o.root).codeRoots.length) return refuse('这个项目没出架构设计（配置里 codeRoots 是空的），没有结构可取');
  const file = o.page ?? join(o.root, OUT, 'arch', 'index.html'), label = o.page ?? `${OUT}/arch/index.html`;
  if (!existsSync(file) || !statSync(file).isFile()) return refuse(`架构首页不在：${label}${o.page === null ? '（还没出过架构设计，先跑 build）' : ''}`);
  let s;
  try { s = readStructure(readFileSync(file, 'utf8')); } catch (e) { if (e instanceof StructureUnreadable) return refuse(`${label}：${e.message}`); throw e; }
  if (o.json) process.stdout.write(`${JSON.stringify(s, null, 2)}\n`);
  else console.log(structureLine(s));
}

const COMMANDS = {
  init: (o) => (o.suggest ? cmdSuggest(o) : cmdInit(o)),
  build: cmdBuild,
  check: cmdCheck,
  pending: cmdPending,
  structure: cmdStructure,
  note: cmdNote,
};

try {
  const o = parseArgs(process.argv.slice(2));
  COMMANDS[o.sub](o);
} catch (e) {
  if (e instanceof ConfigError) { console.error(`readable-docs: ${e.message}`); process.exitCode = 2; }
  else if (e instanceof CheckFailed) { console.error(`readable-docs: ${e.message}`); process.exitCode = 3; }
  else if (e instanceof SpecLoss) { console.error(`readable-docs: ${e.message}`); process.exitCode = 3; }
  else { console.error(`readable-docs: 脚本自身出错：${e?.stack || e}`); process.exitCode = 3; }
}
