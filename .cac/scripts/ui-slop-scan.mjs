#!/usr/bin/env node
// ui-slop-scan.mjs — 「AI 味界面」纯文本静态扫描闸：把 style-vocabulary.md 与 DESIGN.md 的硬约束
// 落为源码级数字判据，纯文本判定，不渲染、不依赖浏览器。
// 用法：node .cac/scripts/ui-slop-scan.mjs [--paths <逗号分隔的目录或文件>] [--json]   默认扫当前目录
// 有意为之的设计可在命中行或其上一行标注 unslop-ignore 跳过并计入已豁免。
// 退出码：0 通过或无界面源码跳过 / 1 存在 error / 2 参数用法错误。warning 只报不拦。

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const STYLE_EXT = new Set(['.css', '.scss', '.less', '.html', '.tsx', '.jsx', '.vue', '.svelte']);
const SCRIPT_EXT = new Set(['.ts', '.js']);
const UI_SIGNAL_RE = /className\s*[=:]|\bclass\s*=\s*["'`]|styled[.(`]|createGlobalStyle|StyleSheet\.create|font-?[Ff]amily|border-?[Rr]adius|letter-?[Ss]pacing|<\/[a-zA-Z][\w-]*>/;
const SKIP_DIR = new Set(['node_modules', 'dist', 'build', '.git', '.cac']);
const SKILL_EXAMPLES_RE = /(^|\/)\.cac\/skills\/.+\/examples$/;
const IGNORE_RE = /unslop-ignore/;

const toPosix = (p) => String(p).replace(/\\/g, '/');

function hslOf(r, g, b) {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  const l = (mx + mn) / 2 / 255;
  if (!d) return { h: 0, s: 0, l: l * 100 };
  let h;
  if (mx === r) h = 60 * ((((g - b) / d) % 6) + 6) % 360;
  else if (mx === g) h = 60 * ((b - r) / d + 2);
  else h = 60 * ((r - g) / d + 4);
  return { h, s: (d / 255 / (1 - Math.abs(2 * l - 1))) * 100, l: l * 100 };
}

function expandHex(tok) {
  let h = tok.replace('#', '');
  if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split('').map((c) => c + c).join('');
  else if (h.length === 8) h = h.slice(0, 6);
  return /^[0-9a-fA-F]{6}$/.test(h) ? '#' + h.toLowerCase() : null;
}

function parseColor(text) {
  const hex = /#[0-9a-fA-F]{3,8}\b/.exec(text);
  if (hex) {
    const norm = expandHex(hex[0]);
    if (norm) {
      const rgb = [1, 3, 5].map((i) => parseInt(norm.slice(i, i + 2), 16));
      return { ...hslOf(...rgb), raw: norm };
    }
  }
  const rgb = /\brgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/.exec(text);
  if (rgb) return { ...hslOf(+rgb[1], +rgb[2], +rgb[3]), raw: rgb[0] + ')' };
  const hsl = /\bhsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/.exec(text);
  if (hsl) return { h: +hsl[1] % 360, s: +hsl[2], l: +hsl[3], raw: hsl[0] + '%)' };
  return null;
}

const isPurple = (c) => !!c && c.h >= 235 && c.h < 290 && c.s >= 20 && c.l >= 12 && c.l <= 88;
const isCream = (c) => !!c && c.h >= 25 && c.h <= 60 && c.s >= 8 && c.s <= 45 && c.l >= 88;
const isTerracotta = (c) => !!c && c.h >= 8 && c.h <= 30 && c.s >= 35 && c.s <= 85 && c.l >= 40 && c.l <= 72;
const isBrandHue = (c) => !!c && c.s >= 10 && c.l > 6 && c.l < 94;

function declRe(prop) {
  const camel = prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  return new RegExp(`(?:^|[\\s;{,"'\`])(?:${prop}|${camel})\\s*:\\s*([^;{}\\n]+)`, 'gi');
}
const DECL = {
  size: declRe('font-size'),
  track: declRe('letter-spacing'),
  lead: declRe('line-height'),
  radius: declRe('border-radius'),
  family: declRe('font-family'),
};

function values(re, line) {
  re.lastIndex = 0;
  const out = [];
  let m;
  while ((m = re.exec(line))) out.push(m[1].trim().replace(/^['"`]/, '').replace(/['"`,]+$/, '').trim());
  return out;
}

const BODY_TAGS = new Set(['html', 'body', 'p']);
const BODY_CONTAINERS = new Set([
  'prose', 'content', 'article', 'paragraph', 'copy', 'body-copy',
  'body-text', 'text-body', 'rich-text', 'markdown', 'entry-content',
]);
const NOT_BODY = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'button', 'btn', 'code', 'pre',
  'badge', 'tag', 'chip', 'label', 'meta', 'caption', 'hint', 'icon',
]);

function subject(part) {
  const clean = part.replace(/\[[^\]]*\]/g, ' ').replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, ' ').trim();
  const last = clean.split(/[\s>+~]+/).filter(Boolean).pop() || '';
  const tag = (/^[a-zA-Z][\w-]*/.exec(last) || [''])[0].toLowerCase();
  const names = [...last.matchAll(/[.#]([\w-]+)/g)].map((m) => m[1].toLowerCase());
  return { tag, names };
}

function isBodyPart(part) {
  const { tag, names } = subject(part);
  if ([tag, ...names.flatMap((n) => n.split(/[-_]/))].filter(Boolean).some((w) => NOT_BODY.has(w))) return false;
  return BODY_TAGS.has(tag) || names.some((n) => BODY_CONTAINERS.has(n));
}

const isBodySel = (sel) => {
  if (!sel || sel.startsWith('@')) return false;
  const parts = sel.split(',').map((x) => x.trim()).filter(Boolean);
  return parts.length > 0 && parts.every(isBodyPart);
};

function stripComments(lines) {
  const out = [];
  let inBlock = false;
  for (const raw of lines) {
    let res = '';
    for (let i = 0; i < raw.length; i++) {
      if (inBlock) {
        if (raw[i] === '*' && raw[i + 1] === '/') { inBlock = false; i++; }
        continue;
      }
      if (raw[i] === '/' && raw[i + 1] === '*') { inBlock = true; i++; continue; }
      if (raw[i] === '/' && raw[i + 1] === '/' && raw[i - 1] !== ':') break;
      res += raw[i];
    }
    out.push(res);
  }
  return out;
}

function parenBody(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && !--depth) return s.slice(open + 1, i);
  }
  return null;
}

function topSplit(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && !depth) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

const COLOR_STOP_RE = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\bvar\(|\b(?:red|blue|green|white|black|purple|violet|indigo|orange|yellow|pink|teal|cyan|gray|grey|transparent)\b/i;

const GENERIC_FAMILY = new Set([
  'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded', '-apple-system', 'blinkmacsystemfont',
  'inherit', 'initial', 'unset', 'revert', 'emoji', 'math',
]);

const err = (code, line, message) => ({ severity: 'error', code, line, message });
const warn = (code, line, message) => ({ severity: 'warning', code, line, message });

function checkLine(code, no, sel, st) {
  const out = [];

  for (const m of code.matchAll(/(?:^|[\s;{,("'`])((?:--|[$@])?[A-Za-z][\w-]*)\s*:\s*([^;{}\n]+)/g)) {
    const name = m[1].toLowerCase();
    if (!/primary|brand/.test(name) || /^(?:--)?on-/.test(name)) continue;
    const c = parseColor(m[2]);
    if (isPurple(c)) {
      out.push(err('PURPLE_PRIMARY', no,
        `主色 ${m[1]} 取 ${c.raw}（hue ${Math.round(c.h)}）落在紫靛带——紫靛是没做选择时的默认色，换一个说得出理由的`));
    }
  }
  const tw = /\bbg-(?:purple|violet|indigo)-\d{2,3}\b/.exec(code);
  if (tw && /\bbutton\b|\bbtn\b|\bprimary\b/i.test(code)) {
    out.push(err('PURPLE_PRIMARY', no, `主按钮用了 ${tw[0]}——紫靛是没做选择时的默认色，换一个说得出理由的`));
  }

  for (const v of values(DECL.size, code)) {
    const px = /^([\d.]+)px\b/.exec(v);
    if (!px) continue;
    st.ruleFontPx = +px[1];
    if (isBodySel(sel) && +px[1] < 14) {
      out.push(err('SMALL_BODY_TEXT', no, `正文字号 ${px[1]}px < 14px（选择器 ${sel}）——正文小于 14px 读着费劲`));
    }
  }

  for (const v of values(DECL.track, code)) {
    if (!/^-\s*[\d.]/.test(v) || st.ruleFontPx === null || st.ruleFontPx >= 24) continue;
    out.push(warn('NEGATIVE_TRACKING', no, `letter-spacing ${v} 配 ${st.ruleFontPx}px 字号——小字号再收字距，字就粘一起了`));
  }

  for (const v of values(DECL.lead, code)) {
    if (!isBodySel(sel)) continue;
    let ratio = null;
    let shown = v;
    const unitless = /^([\d.]+)$/.exec(v);
    const pct = /^([\d.]+)%$/.exec(v);
    const px = /^([\d.]+)px$/.exec(v);
    if (unitless) ratio = +unitless[1];
    else if (pct) ratio = +pct[1] / 100;
    else if (px && st.ruleFontPx) {
      ratio = +px[1] / st.ruleFontPx;
      shown = `${v} 配 ${st.ruleFontPx}px 字号 = ${ratio.toFixed(2)}`;
    }
    if (ratio === null) continue;
    if (ratio < 1.4 || ratio > 1.6) {
      out.push(err('LINE_HEIGHT', no, `line-height ${shown} 不在 1.4–1.6——正文行高出这个区间就不是为阅读定的`));
    }
  }

  for (const v of values(DECL.radius, code)) {
    const nums = [...v.matchAll(/([\d.]+)px\b/g)].map((m) => +m[1]);
    if (!nums.length) continue;
    const max = Math.max(...nums);
    if (max > 8 && max < 999) out.push(warn('BIG_RADIUS', no, `border-radius ${max}px > 8px——一律大圆角是 SaaS 卡片套件的记号`));
  }
  const twRadius = /\brounded-(?:2xl|3xl)\b/.exec(code);
  if (twRadius) out.push(warn('BIG_RADIUS', no, `${twRadius[0]} 超过 8px——一律大圆角是 SaaS 卡片套件的记号`));

  for (const m of code.matchAll(/\b(?:linear|radial|conic)-gradient\s*\(/g)) {
    const body = parenBody(code, m.index + m[0].length - 1);
    if (body === null) continue;
    const stops = topSplit(body).filter((x) => COLOR_STOP_RE.test(x));
    if (stops.length > 3) out.push(warn('GRADIENT_STOPS', no, `渐变有 ${stops.length} 个色标 > 3——色标一多，渐变就是装饰而不是层级`));
  }
  return out;
}

function collect(code, no, st) {
  for (const m of code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    const norm = expandHex(m[0]);
    if (!norm) continue;
    const c = parseColor(norm);
    if (isCream(c) && !st.cream) st.cream = { line: no, raw: norm };
    if (isTerracotta(c) && !st.terra) st.terra = { line: no, raw: norm };
    if (isBrandHue(c) && !st.hexes.has(norm)) st.hexes.set(norm, no);
  }
  for (const v of values(DECL.family, code)) {
    const first = topSplit(v)[0];
    if (!first || /var\(|\$\{|\{[a-z]/i.test(first)) continue;
    const name = first.replace(/['"]/g, '').trim().toLowerCase();
    if (!name || GENERIC_FAMILY.has(name) || name.includes('mono')) continue;
    if (!st.families.has(name)) st.families.set(name, no);
  }
}

function scanFile(file, rel, findings) {
  const ext = path.extname(file).toLowerCase();
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  if (SCRIPT_EXT.has(ext) && !UI_SIGNAL_RE.test(text)) return null;

  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const code = stripComments(lines);
  const st = { ruleFontPx: null, hexes: new Map(), families: new Map(), cream: null, terra: null, exempt: 0 };
  let sel = '';

  for (let i = 0; i < lines.length; i++) {
    const c = code[i];
    const open = c.lastIndexOf('{');
    let lineSel = sel;
    if (open >= 0) {
      const head = /([^{};]*)$/.exec(c.slice(0, open));
      lineSel = (head ? head[1] : '').replace(/\s+/g, ' ').trim() || sel;
    }
    if (lineSel !== sel) st.ruleFontPx = null;

    const hits = checkLine(c, i + 1, lineSel, st);
    if (IGNORE_RE.test(lines[i]) || (i > 0 && IGNORE_RE.test(lines[i - 1]))) {
      st.exempt += hits.length;
    } else {
      for (const h of hits) findings.push({ ...h, file: rel });
      collect(c, i + 1, st);
    }

    const lastBrace = Math.max(c.lastIndexOf('{'), c.lastIndexOf('}'));
    if (lastBrace >= 0 && c[lastBrace] === '}') {
      sel = '';
      st.ruleFontPx = null;
    } else {
      sel = lineSel;
    }
  }

  const hexes = [...st.hexes.entries()];
  if (hexes.length > 5) {
    findings.push({ ...warn('TOO_MANY_COLORS', hexes[5][1], `这份文件用了 ${hexes.length} 个品牌色（${hexes.map((h) => h[0]).join(' ')}）> 5——总色一多就没有主次`), file: rel });
  }
  const families = [...st.families.entries()];
  if (families.length > 2) {
    findings.push({ ...warn('TOO_MANY_FAMILIES', families[2][1], `声明了 ${families.length} 个字族（${families.map((f) => f[0]).join(' / ')}）> 2——字族超两个，页面就没有统一的声音`), file: rel });
  }
  if (st.cream && st.terra) {
    findings.push({ ...warn('CREAM_TERRACOTTA', Math.max(st.cream.line, st.terra.line), `奶油底 ${st.cream.raw} 与陶土橙 ${st.terra.raw} 同现——这套配色是 AI 给任何题材的默认，钉死了才用`), file: rel });
  }
  return st;
}

function walk(root, out) {
  let st;
  try { st = fs.statSync(root); } catch { return; }
  if (st.isFile()) {
    const ext = path.extname(root).toLowerCase();
    if (STYLE_EXT.has(ext) || SCRIPT_EXT.has(ext)) out.push(root);
    return;
  }
  if (!st.isDirectory()) return;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name) || SKILL_EXAMPLES_RE.test(toPosix(p))) continue;
      walk(p, out);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (STYLE_EXT.has(ext) || SCRIPT_EXT.has(ext)) out.push(p);
    }
  }
}

const USAGE = '用法：node .cac/scripts/ui-slop-scan.mjs [--paths <逗号分隔的目录或文件>] [--json]';

function parseArgs(argv) {
  const opts = { paths: [], json: false, explicit: false, help: false };
  const split = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--paths') {
      if (i + 1 >= argv.length) return { error: '--paths 后面要跟逗号分隔的目录或文件' };
      opts.explicit = true;
      opts.paths = split(argv[++i]);
    } else if (a.startsWith('--paths=')) {
      opts.explicit = true;
      opts.paths = split(a.slice('--paths='.length));
    } else {
      return { error: '未知参数：' + a };
    }
  }
  if (opts.explicit && !opts.paths.length) return { error: '--paths 后面要跟逗号分隔的目录或文件' };
  if (!opts.paths.length) opts.paths = [process.cwd()];
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.error) {
    console.error('ui-slop-scan: ' + opts.error);
    console.error(USAGE);
    process.exit(2);
  }
  if (opts.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const roots = opts.paths.map((p) => path.resolve(p));
  const missing = opts.explicit ? opts.paths.filter((_, i) => !fs.existsSync(roots[i])) : [];
  if (missing.length) {
    console.error('ui-slop-scan: 路径不存在：' + missing.join('、'));
    console.error(USAGE);
    process.exit(2);
  }

  const candidates = [];
  for (const r of roots) walk(r, candidates);

  const findings = [];
  const scanned = [];
  let exempt = 0;
  for (const file of [...new Set(candidates)].sort()) {
    const r = path.relative(process.cwd(), file);
    const rel = toPosix(!r || r.startsWith('..') ? file : r);
    const st = scanFile(file, rel, findings);
    if (!st) continue;
    scanned.push(rel);
    exempt += st.exempt;
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.length - errors;
  const ok = errors === 0;

  if (opts.json) {
    console.log(JSON.stringify({
      ok,
      roots: roots.map(toPosix),
      files: scanned.length,
      errors,
      warnings,
      exempt,
      findings,
    }, null, 2));
  } else if (!scanned.length) {
    console.log('ui-slop-scan: 未找到界面源码，跳过。');
  } else {
    for (const f of findings) {
      console.log(`  ${f.severity === 'error' ? '✗' : '!'} ${f.file}:${f.line} [${f.code}] ${f.message}`);
    }
    console.log(ok
      ? `ui-slop-scan: 通过（扫描 ${scanned.length} 份界面源码，warning ${warnings}，已豁免 ${exempt}）`
      : `ui-slop-scan: 未通过（error ${errors}，warning ${warnings}，已豁免 ${exempt}）`);
  }
  process.exit(ok ? 0 : 1);
}

main();
