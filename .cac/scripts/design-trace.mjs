#!/usr/bin/env node
// design-trace.mjs — 设计详述的规则 ↔ 测试 ↔ 常量双向核对（契约见 .cac/rules/design-detail.md）。
// 用法：node .cac/scripts/design-trace.mjs [--root <目录>] [--json]   默认 root 为当前目录
// 读 <root>/docs/design/*.md 的现行规则编号、代码范围与常量表，扫测试文件里的 `# rule: A, B` /
// `// rule: A, B` 标签，报四类缺口：① 文档有编号、无测试标它；② 测试标了编号、文档现行规则里没有；
// ③ 常量表的值与代码同名常量对不上（文件不存在 / 找不到定义 / 定义不唯一均算缺口）；
// ④ 结构缺口（规则标题解析不出编号、无现行规则、无代码范围行、某条通配匹配 0 个文件）。
// 退出码：0 无缺口或无设计详述跳过 / 1 有缺口 / 2 参数用法错 / 3 脚本内部错误。
// 零 npm 依赖，不静态 import .cac/harness，独立可运行。

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ID_SRC = '[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+';
const FENCE_RE = /^\s{0,3}(?:```|~~~)/;
const CODE_EXT = new Set([
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.sh', '.ps1', '.go', '.rs', '.java', '.kt',
  '.kts', '.c', '.cc', '.cpp', '.h', '.cs', '.rb', '.php', '.swift', '.scala', '.vue',
]);
const SKIP_ANY = new Set(['.git', 'node_modules', '.venv', 'venv', 'dist', 'build', 'out', '__pycache__']);
const SKIP_ROOT = new Set(['.cac', 'docs']);
const TEST_DIRS = new Set(['test', 'tests', 'spec', '__tests__']);
const TEST_NAME = /^test_|_test\.|\.test\.|\.spec\.|Tests?\.(?:java|kt)$|Tests\.[^.]+$/;

const toPosix = (p) => String(p).replace(/\\/g, '/');

function usage(msg) {
  process.stderr.write(`design-trace: ${msg}\n用法：node .cac/scripts/design-trace.mjs [--root <目录>] [--json]\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const o = { root: '.', json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--root') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) usage('--root 缺值');
      o.root = v;
    } else if (a.startsWith('--root=')) {
      const v = a.slice('--root='.length);
      if (!v) usage('--root 缺值');
      o.root = v;
    } else {
      usage(`未知参数：${a}`);
    }
  }
  return o;
}

function cleanLines(text) {
  let inFence = false;
  let inComment = false;
  return text.replace(/\r\n?/g, '\n').split('\n').map((raw) => {
    let l = raw;
    if (inComment) {
      const e = l.indexOf('-->');
      if (e < 0) return '';
      inComment = false;
      l = l.slice(e + 3);
    }
    if (FENCE_RE.test(l)) { inFence = !inFence; return ''; }
    if (inFence) return '';
    l = l.replace(/<!--.*?-->/g, '');
    const s = l.indexOf('<!--');
    if (s >= 0) { inComment = true; l = l.slice(0, s); }
    return l;
  });
}

const cell = (c) => c.replace(/`/g, '').trim();

function globToRe(raw) {
  const g = toPosix(raw.trim()).replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  const esc = (c) => c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  if (!g.includes('*')) return new RegExp('^' + esc(g) + '(?:/.*)?$');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    if (g[i] !== '*') { re += esc(g[i]); continue; }
    if (g[i + 1] === '*') {
      i++;
      if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else {
      re += '[^/]*';
    }
  }
  return new RegExp('^' + re + '$');
}

function parseDoc(file, rel) {
  const lines = cleanLines(fs.readFileSync(file, 'utf8'));
  const d = {
    rel,
    current: new Map(),
    superseded: new Map(),
    consts: [],
    globs: [],
    rangeLine: 0,
    placeholder: false,
    bad: [],
  };
  let sec = '';
  let header = null;
  const idRe = new RegExp(`^(${ID_SRC})`);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const h2 = /^##\s+(.+?)\s*$/.exec(l);
    if (h2) { sec = h2[1]; header = null; continue; }
    const rg = /^>\s*代码范围[:：](.*)$/.exec(l);
    if (rg && !d.rangeLine) {
      d.rangeLine = i + 1;
      for (const x of rg[1].matchAll(/`([^`]+)`/g)) {
        if (x[1].includes('{{')) d.placeholder = true;
        else if (x[1].trim()) d.globs.push(x[1].trim());
      }
      continue;
    }
    const h4 = /^####\s+(.*)$/.exec(l);
    if (h4) {
      if (h4[1].includes('{{')) { d.placeholder = true; continue; }
      const m = idRe.exec(h4[1].replace(/^[\s*_`]+/, ''));
      if (sec.includes('取代记录')) {
        if (m) {
          const by = /被\s*(.+?)\s*取代/.exec(h4[1]);
          d.superseded.set(m[1], by ? by[1] : '');
        }
      } else if (m) {
        if (!d.current.has(m[1])) d.current.set(m[1], i + 1);
      } else if (sec.includes('规则')) {
        d.bad.push({ line: i + 1, text: l.trim() });
      }
      continue;
    }
    if (!sec.includes('常量表') || !/^\s*\|/.test(l)) continue;
    const rowCells = l.trim().replace(/^\||\|$/g, '').split('|').map(cell);
    if (rowCells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    if (!header) {
      const idx = {
        name: rowCells.indexOf('常量名'),
        value: rowCells.indexOf('值'),
        where: rowCells.indexOf('代码位置'),
      };
      if (idx.name >= 0 && idx.value >= 0 && idx.where >= 0) header = idx;
      continue;
    }
    if (l.includes('{{')) continue;
    d.consts.push({
      name: rowCells[header.name] || '',
      value: rowCells[header.value] || '',
      where: toPosix(rowCells[header.where] || ''),
      line: i + 1,
    });
  }
  return d;
}

function listFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_e) { return; }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_ANY.has(e.name) && !(rel === '' && SKIP_ROOT.has(e.name))) {
          walk(path.join(dir, e.name), r);
        }
      } else if (e.isFile()) {
        out.push(r);
      }
    }
  };
  walk(root, '');
  return out;
}

function isTestFile(rel) {
  const parts = toPosix(rel).split('/');
  return parts.slice(0, -1).some((s) => TEST_DIRS.has(s)) || TEST_NAME.test(parts[parts.length - 1]);
}

function scanTags(root, files) {
  const tags = [];
  const stray = [];
  const re = /(?:#|\/\/)\s*rule\s*[:：]\s*(.+)$/;
  const idOnly = new RegExp(`^${ID_SRC}$`);
  for (const rel of files.filter((f) => CODE_EXT.has(path.extname(f)))) {
    let text;
    try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch (_e) { continue; }
    if (!/rule\s*[:：]/.test(text)) continue;
    const test = isTestFile(rel);
    text.split(/\r?\n/).forEach((l, i) => {
      const m = re.exec(l);
      if (!m) return;
      for (const id of m[1].split(/[,，]/).map((x) => x.trim().split(/\s+/)[0]).filter((x) => idOnly.test(x))) {
        (test ? tags : stray).push({ id, where: `${rel}:${i + 1}` });
      }
    });
  }
  return { tags, stray };
}

function stripPy(t) {
  let inTri = '';
  return t.split('\n').map((l) => {
    let out = '';
    for (let i = 0; i < l.length; i++) {
      if (inTri) {
        if (l.startsWith(inTri, i)) { inTri = ''; i += 2; }
        continue;
      }
      const tri = l.startsWith('"""', i) ? '"""' : l.startsWith("'''", i) ? "'''" : '';
      if (tri) { inTri = tri; i += 2; continue; }
      const c = l[i];
      if (c === '#') break;
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < l.length && l[j] !== c) j += l[j] === '\\' ? 2 : 1;
        out += l.slice(i, j + 1);
        i = j;
        continue;
      }
      out += c;
    }
    return out;
  });
}

function stripComments(text, ext) {
  const blank = (s) => s.replace(/[^\n]/g, '');
  let t = text.replace(/\r\n?/g, '\n');
  if (ext === '.py') return stripPy(t);
  if (ext !== '.sh' && ext !== '.ps1' && ext !== '.rb') t = t.replace(/\/\*[\s\S]*?\*\//g, blank);
  return t.split('\n').map((l) => (/^\s*(?:#|\/\/|\*)/.test(l) ? '' : l));
}

function cutValue(rest, ext) {
  let q = '';
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (q) {
      if (c === '\\') i++;
      else if (c === q) q = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if (c === ';') return rest.slice(0, i);
    else if (c === '/' && rest[i + 1] === '/') return rest.slice(0, i);
    else if (c === '#' && (ext === '.py' || ext === '.sh' || ext === '.ps1' || ext === '.rb') && (i === 0 || /\s/.test(rest[i - 1]))) return rest.slice(0, i);
  }
  return rest;
}

function findDefinitions(text, name, ext) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[^\\w$.])${esc}\\s*(?::\\s*[^=\\n]+?)?\\s*:?=(?!=)\\s*(.*)$`);
  const hits = [];
  stripComments(text, ext).forEach((l, i) => {
    const m = re.exec(l);
    if (m) hits.push({ line: i + 1, raw: cutValue(m[1], ext).trim() });
  });
  return hits;
}

function normValue(v) {
  let s = v.trim().replace(/[;,]+$/, '').trim();
  const q = /^(["'`])(.*)\1$/.exec(s);
  if (q) s = q[2];
  return s;
}

function asNumber(s) {
  const t = s.replace(/_/g, '');
  if (/^[+-]?0[xX][0-9a-fA-F]+[lLuU]*$/.test(t)) return Number(t.replace(/[lLuU]+$/, ''));
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)[lLfFdD]*$/.exec(t);
  return m ? Number(m[1]) : null;
}

function sameValue(a, b) {
  const x = normValue(a);
  const y = normValue(b);
  const nx = asNumber(x);
  const ny = asNumber(y);
  return nx !== null && ny !== null ? nx === ny : x === y;
}

function run() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help) {
    process.stdout.write('用法：node .cac/scripts/design-trace.mjs [--root <目录>] [--json]\n');
    return 0;
  }
  const root = path.resolve(opt.root);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) usage(`--root 目录不存在：${opt.root}`);

  const dir = path.join(root, 'docs', 'design');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort(); } catch (_e) { /* 无目录 */ }
  if (names.length === 0) {
    if (opt.json) process.stdout.write(JSON.stringify({ gaps: [], summary: { total: 0, skipped: true } }) + '\n');
    else process.stdout.write('没有设计详述，跳过\n');
    return 0;
  }

  const docs = names.map((n) => parseDoc(path.join(dir, n), `docs/design/${n}`));
  const files = listFiles(root);
  const { tags, stray } = scanTags(root, files);
  const tagged = new Set(tags.map((t) => t.id));
  const gaps = [];
  const gap = (kind, doc, id, where, detail) => gaps.push({ kind, doc, id, where, detail });

  for (const d of docs) {
    for (const b of d.bad) gap('structure', d.rel, '', `${d.rel}:${b.line}`, `规则段里的标题解析不出编号：${b.text}`);
    if (d.current.size === 0) gap('structure', d.rel, '', d.rel, d.placeholder ? '只有模板占位，没有一条现行规则' : '没有一条现行规则');
    if (!d.rangeLine) gap('structure', d.rel, '', d.rel, '文首没有「> 代码范围：」行');
    else if (d.globs.length === 0) gap('structure', d.rel, '', `${d.rel}:${d.rangeLine}`, '代码范围只有模板占位或没有可用通配');
    for (const g of d.globs) {
      const re = globToRe(g);
      if (!files.some((f) => re.test(f))) {
        gap('structure', d.rel, g, `${d.rel}:${d.rangeLine}`, `代码范围通配 ${g} 在项目里匹配 0 个文件（遍历跳过 ${[...SKIP_ANY].join(' ')}，根目录另跳 .cac docs）`);
      }
    }
    for (const [id, line] of d.current) {
      if (!tagged.has(id)) gap('no-test', d.rel, id, `${d.rel}:${line}`, `规则 ${id} 没有任何测试用 rule 标签标它`);
    }
  }

  const currentAll = new Set(docs.flatMap((d) => [...d.current.keys()]));
  const supAll = new Map();
  for (const d of docs) {
    for (const [id, by] of d.superseded) {
      if (!supAll.has(id)) supAll.set(id, by);
    }
  }
  for (const t of tags) {
    if (currentAll.has(t.id)) continue;
    const doc = docs.find((d) => d.superseded.has(t.id));
    const detail = supAll.has(t.id)
      ? `测试标的 ${t.id} 已被${supAll.get(t.id) ? ` ${supAll.get(t.id)} ` : ''}取代，现行规则里没有，请改标新编号`
      : `测试标的 ${t.id} 在设计详述现行规则里不存在`;
    gap('no-rule', doc ? doc.rel : '', t.id, t.where, detail);
  }

  let constCount = 0;
  for (const d of docs) {
    for (const c of d.consts) {
      if (!c.name) continue;
      constCount++;
      const where = `${d.rel}:${c.line}`;
      const file = path.join(root, c.where);
      if (!c.where || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        gap('const-mismatch', d.rel, c.name, where, `常量 ${c.name}：代码位置 ${c.where || '（空）'} 不存在`);
        continue;
      }
      const hits = findDefinitions(fs.readFileSync(file, 'utf8'), c.name, path.extname(file));
      if (hits.length === 0) gap('const-mismatch', d.rel, c.name, where, `常量 ${c.name}：在 ${c.where} 里找不到定义`);
      else if (hits.length > 1) gap('const-mismatch', d.rel, c.name, where, `常量 ${c.name}：定义不唯一，${c.where} 第 ${hits.map((h) => h.line).join('、')} 行都有赋值`);
      else if (!sameValue(c.value, hits[0].raw)) gap('const-mismatch', d.rel, c.name, where, `常量 ${c.name}：文档值 ${c.value}，代码值 ${normValue(hits[0].raw)}（${c.where}:${hits[0].line}）`);
    }
  }

  const n = (k) => gaps.filter((g) => g.kind === k).length;
  const ruleCount = docs.reduce((a, d) => a + d.current.size, 0);
  const summary = {
    total: gaps.length,
    noTest: n('no-test'),
    noRule: n('no-rule'),
    constMismatch: n('const-mismatch'),
    structure: n('structure'),
    rules: ruleCount,
    tags: tags.length,
    consts: constCount,
  };
  if (opt.json) {
    process.stdout.write(JSON.stringify({ gaps, summary, hints: stray }, null, 2) + '\n');
  } else {
    const label = { 'no-test': '无测试', 'no-rule': '编号不存在', 'const-mismatch': '常量不一致', structure: '结构' };
    for (const g of gaps) {
      process.stdout.write(`[${label[g.kind]}] ${g.where}  ${g.detail}${g.doc && g.kind === 'no-rule' ? `（设计详述 ${g.doc}）` : ''}\n`);
    }
    if (stray.length) {
      process.stdout.write(`提示：非测试文件里的标签不算数：${stray.map((s) => `${s.where}（${s.id}）`).join('、')}\n`);
    }
    process.stdout.write(`规则 ${ruleCount} 条 / 测试标签 ${tags.length} 个 / 常量 ${constCount} 个\n`);
    process.stdout.write(`缺口 ${summary.total} 条（无测试 ${summary.noTest} / 编号不存在 ${summary.noRule} / 常量不一致 ${summary.constMismatch}${summary.structure ? ` / 结构 ${summary.structure}` : ''}）\n`);
  }
  return gaps.length > 0 ? 1 : 0;
}

try {
  process.exit(run());
} catch (e) {
  process.stderr.write(`design-trace: 内部错误：${String((e && e.message) || e).split('\n')[0]}\n`);
  process.exit(3);
}
