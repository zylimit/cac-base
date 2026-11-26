#!/usr/bin/env node
// .cac/scripts/collect-feedback.mjs — Pull downstream project feedback entries back into cac-base .cac/feedback/.
// Unified pure-Node cross-platform replacement for collect-feedback.sh + collect-feedback-docs.mjs.
// Four-state merge per feedback/*.md (excluding FEEDBACK-INDEX.md & templates/):
//   new | same | updated (preserves graduated/skipped) | conflict (writes <stem>.from-<proj>.md)
// Also prints a read-only readable-docs health line per downstream project.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const TIMEOUT_MS = 60000;
const WEEK_MS = 7 * 24 * 3600 * 1000;

function die(msg, code = 1) {
  process.stderr.write(`collect-feedback: ${msg}\n`);
  process.exit(code);
}

function usageDie(msg) {
  process.stderr.write(`collect-feedback: ${msg}\n`);
  process.stderr.write('用法：node .cac/scripts/collect-feedback.mjs [--dry-run] [--json] <下游项目路径>...\n');
  process.exit(2);
}

/**
 * Extract YAML frontmatter field value (between opening and closing `---`).
 * When `raw` is false, strips inline `# ...` comments on unquoted values.
 */
function fmGet(filePath, key, raw = false) {
  const lines = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '---') return '';
  const prefix = `${key}:`;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') break;
    if (lines[i].startsWith(prefix)) {
      let v = lines[i].slice(prefix.length).replace(/^[ \t]+/, '');
      if (!raw && !/^["']/.test(v)) {
        if (v.startsWith('#')) v = '';
        else v = v.replace(/[ \t]+#.*$/, '');
      }
      return v.replace(/[ \t]+$/, '');
    }
  }
  return '';
}

/**
 * Strip `origin:`, `graduated:`, and `skipped:` lines from frontmatter for semantic equality check.
 */
function stripMutableFrontmatter(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '---') return lines.join('\n');
  const out = ['---'];
  let inFm = true;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (inFm && l === '---') {
      inFm = false;
      out.push(l);
      continue;
    }
    if (inFm && (l.startsWith('origin:') || l.startsWith('graduated:') || l.startsWith('skipped:'))) {
      continue;
    }
    out.push(l);
  }
  return out.join('\n');
}

function sameContent(fileA, fileB) {
  return stripMutableFrontmatter(fileA) === stripMutableFrontmatter(fileB);
}

function fmTitle(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  if (lines[0] === '---') {
    i = 1;
    while (i < lines.length && lines[i] !== '---') i++;
    i++;
  }
  for (; i < lines.length; i++) {
    if (lines[i].startsWith('# ')) {
      return lines[i].replace(/^# +/, '').trim();
    }
  }
  return '';
}

function setFm(filePath, key, val) {
  const lines = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n').split('\n');
  let outLines;
  if (lines[0] !== '---') {
    outLines = ['---', `${key}: ${val}`, '---', ...lines];
  } else {
    outLines = ['---'];
    let inFm = true;
    let done = false;
    const prefix = `${key}:`;
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i];
      if (inFm && l === '---') {
        if (!done) outLines.push(`${key}: ${val}`);
        inFm = false;
        outLines.push(l);
        continue;
      }
      if (inFm && l.startsWith(prefix)) {
        outLines.push(`${key}: ${val}`);
        done = true;
        continue;
      }
      outLines.push(l);
    }
  }
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, outLines.join('\n'), 'utf8');
  fs.renameSync(tmp, filePath);
}

function mergeOrigin(oldCsv, projName) {
  const seen = new Set();
  const list = [];
  for (const raw of `${oldCsv || ''},${projName || ''}`.split(',')) {
    const v = raw.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    list.push(v);
  }
  return list.join(',');
}

function indexAdd(fbDir, indexPath, fileName) {
  if (!fs.existsSync(indexPath)) {
    process.stderr.write(`collect-feedback: 本仓缺少 FEEDBACK-INDEX.md，${fileName} 未追加索引\n`);
    return;
  }
  let idxText = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');
  if (idxText.includes(`](${fileName})`)) return;
  const full = path.join(fbDir, fileName);
  const title = fmTitle(full) || fileName.replace(/\.md$/, '');
  const desc = fmGet(full, 'description');
  if (idxText.length > 0 && !idxText.endsWith('\n')) idxText += '\n';
  idxText += `- [${title}](${fileName}) — ${desc}\n`;
  fs.writeFileSync(indexPath, idxText, 'utf8');
}

function writeFrom(srcFile, fbDir, destName, projName, prevOrigin) {
  const dest = path.join(fbDir, destName);
  const lfContent = fs.readFileSync(srcFile, 'utf8').replace(/\r\n/g, '\n');
  fs.writeFileSync(dest, lfContent, 'utf8');
  setFm(dest, 'origin', mergeOrigin(prevOrigin, projName));
}

function formatReadableDocsStatus(projDir) {
  const projName = path.basename(projDir);
  const fallback = (msg) => `  人读文档  ${projName}：${msg}`;

  const runJson = (script, args, what, absentOn2 = false) => {
    const r = spawnSync(process.execPath, [script, ...args, '--root', projDir], {
      cwd: projDir,
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.error) {
      throw new Error(r.error.code === 'ETIMEDOUT' ? `${what} 超过 60 秒` : `${what} 启动失败：${r.error.message}`);
    }
    if (absentOn2 && r.status === 2) return null;
    try {
      return JSON.parse(r.stdout);
    } catch {
      const hint = (String(r.stderr || '').trim() || String(r.stdout || '').trim()).split(/\r?\n/)[0].slice(0, 120);
      throw new Error(`${what} 输出不是 JSON（退出码 ${r.status}${hint ? '：' + hint : ''}）`);
    }
  };

  const logged7d = (predicate) => {
    const log = path.join(projDir, '.cac', 'evidence', 'gate-block.log');
    if (!fs.existsSync(log)) return 0;
    const since = Date.now() - WEEK_MS;
    let count = 0;
    for (const line of fs.readFileSync(log, 'utf8').split(/\r?\n/)) {
      const [ts, gate, ...reason] = line.split('\t');
      const t = Date.parse(ts);
      if (gate === 'pre-commit-check' && predicate(reason.join('\t')) && !Number.isNaN(t) && t >= since) {
        count++;
      }
    }
    return count;
  };

  try {
    const scriptsDir = path.join(projDir, '.cac', 'scripts');
    const docsScript = path.join(scriptsDir, 'readable-docs.mjs');
    if (!fs.existsSync(docsScript)) {
      return fallback('没有生成器（框架版本较旧）');
    }
    if (!fs.existsSync(path.join(projDir, 'docs', 'readable-src', 'config.json'))) {
      return fallback('未初始化');
    }
    const status = runJson(path.join(scriptsDir, 'project-status.mjs'), ['--json'], 'project-status');
    const rd = status && status.readable;
    if (!rd || typeof rd !== 'object') throw new Error('project-status 输出缺少 readable');
    const check = runJson(docsScript, ['check', '--json'], 'readable-docs check');
    if (!Array.isArray(check.problems)) throw new Error('readable-docs check 输出缺少 problems');
    if (!rd.suggest || rd.suggest.error || !rd.suggest.missing) {
      throw new Error(`配置漏项无法读取：${(rd.suggest && rd.suggest.error) || 'suggest 缺失'}`);
    }
    const m = rd.suggest.missing;
    const len = (arr) => (Array.isArray(arr) ? arr.length : 0);
    const missingCfg = len(m.ddl) + len(m.codeRoots) + len(m.archDocs) + (m.spec ? 1 : 0);
    const problemsCount = check.problems.length;
    const staleNotes = (rd.notes && rd.notes.stale) || 0;
    const orphanNotes = (rd.notes && rd.notes.orphans) || 0;
    const unwrittenTables = (rd.unwritten && rd.unwritten.tables) || 0;
    const unwrittenMods = (rd.unwritten && rd.unwritten.modules) || 0;
    const blockedCount = logged7d((r) => r.includes('人读文档'));

    let stTail = null;
    const st = runJson(docsScript, ['structure', '--json'], 'readable-docs structure', true);
    if (st !== null) {
      const pairs = Array.isArray(st.upward) ? st.upward.reduce((s, u) => s + ((u && u.pairs) || 0), 0) : NaN;
      if (!Array.isArray(st.cycles) || !Array.isArray(st.unassigned) || !Number.isInteger(pairs)) {
        throw new Error('readable-docs structure 输出结构字段不完整');
      }
      const warn7d = logged7d((r) => r.startsWith('[advise] 结构变坏：'));
      stTail = {
        warn7d,
        text: `；结构：循环依赖 ${st.cycles.length} 组、越层引用 ${pairs} 处、未归属文件 ${st.unassigned.length} 个，近 7 天变坏提醒 ${warn7d} 次`,
      };
    }

    const mark = problemsCount || staleNotes || missingCfg || (stTail && stTail.warn7d) ? '! ' : '  ';
    return `${mark}人读文档  ${projName}：${rd.pages} 页，核对不一致 ${problemsCount} 条，未写说明的表 ${unwrittenTables} 张、模块 ${unwrittenMods} 个，待更新 ${staleNotes} 段、孤儿 ${orphanNotes} 段，配置漏项 ${missingCfg} 处，近 7 天提交前被拦 ${blockedCount} 次${stTail ? stTail.text : ''}`;
  } catch (e) {
    return fallback(`取不到（${String(e?.message || e).split(/\r?\n/)[0]}）`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  let dryRun = false;
  let jsonMode = false;
  const projects = [];

  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--json') jsonMode = true;
    else if (arg.startsWith('-')) usageDie(`未知选项：${arg}`);
    else projects.push(arg);
  }
  if (projects.length === 0) usageDie('至少指定一个下游项目路径');

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const realFb = path.join(root, '.cac', 'feedback');
  if (!fs.existsSync(realFb) || !fs.statSync(realFb).isDirectory()) {
    die(`本仓缺少 .cac/feedback/ 目录：${realFb}`);
  }

  // Validate ALL downstream project paths before modifying anything.
  const srcs = [];
  for (const p of projects) {
    if (!fs.existsSync(p)) die(`路径不存在：${p}`);
    if (!fs.statSync(p).isDirectory()) die(`不是目录：${p}`);
    const fb = path.join(p, '.cac', 'feedback');
    if (!fs.existsSync(fb) || !fs.statSync(fb).isDirectory()) {
      die(`目标没有 .cac/feedback/：${p}`);
    }
    srcs.push(path.resolve(p));
  }

  let scratchDir = null;
  let workFb = realFb;
  if (dryRun) {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cac-collect-fb-'));
    fs.cpSync(realFb, scratchDir, { recursive: true });
    workFb = scratchDir;
  }

  const counts = { new: 0, updated: 0, same: 0, conflict: 0 };
  const events = [];

  try {
    const indexPath = path.join(workFb, 'FEEDBACK-INDEX.md');
    for (const srcProj of srcs) {
      const projName = path.basename(srcProj);
      const srcFb = path.join(srcProj, '.cac', 'feedback');
      const entries = fs
        .readdirSync(srcFb, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== 'FEEDBACK-INDEX.md')
        .map((e) => e.name)
        .sort();

      for (const name of entries) {
        const srcFile = path.join(srcFb, name);
        const destFile = path.join(workFb, name);

        if (!fs.existsSync(destFile)) {
          writeFrom(srcFile, workFb, name, projName, fmGet(srcFile, 'origin'));
          indexAdd(workFb, indexPath, name);
          counts.new++;
          events.push({ status: 'new', file: name, project: projName });
          if (!jsonMode) console.log(`  new      ${name}  (${projName})`);
        } else if (sameContent(srcFile, destFile)) {
          const oldOrigin = fmGet(destFile, 'origin');
          const merged = mergeOrigin(oldOrigin, projName);
          if (merged !== oldOrigin) setFm(destFile, 'origin', merged);
          counts.same++;
          events.push({ status: 'same', file: name, project: projName });
          if (!jsonMode) console.log(`  same     ${name}  (${projName})`);
        } else {
          const oldOrigin = fmGet(destFile, 'origin');
          const originTokens = mergeOrigin(oldOrigin, '').split(',').filter(Boolean);
          if (originTokens.includes(projName)) {
            const grad = fmGet(destFile, 'graduated', true);
            const skip = fmGet(destFile, 'skipped', true);
            writeFrom(srcFile, workFb, name, projName, oldOrigin);
            if (grad) setFm(destFile, 'graduated', grad);
            if (skip) setFm(destFile, 'skipped', skip);
            counts.updated++;
            events.push({ status: 'updated', file: name, project: projName });
            if (!jsonMode) console.log(`  updated  ${name}  (${projName})`);
          } else {
            const cname = `${name.slice(0, -3)}.from-${projName.replace(/\s+/g, '-')}.md`;
            const cdest = path.join(workFb, cname);
            if (fs.existsSync(cdest) && sameContent(srcFile, cdest)) {
              counts.same++;
              events.push({ status: 'same', file: name, project: projName, conflictCopy: cname });
              if (!jsonMode) console.log(`  same     ${name}  (${projName}，已有冲突副本)`);
            } else {
              writeFrom(srcFile, workFb, cname, projName, fmGet(srcFile, 'origin'));
              indexAdd(workFb, indexPath, cname);
              counts.conflict++;
              events.push({ status: 'conflict', file: name, target: cname, project: projName });
              if (!jsonMode) console.log(`  conflict ${name} -> ${cname}  (${projName})`);
            }
          }
        }
      }
    }

    const readableLines = srcs.map((s) => formatReadableDocsStatus(s));
    if (jsonMode) {
      process.stdout.write(
        JSON.stringify({
          ok: true,
          dryRun,
          counts,
          events,
          readableStatus: readableLines,
        }) + '\n',
      );
    } else {
      for (const line of readableLines) console.log(line);
      if (dryRun) console.log('collect-feedback: dry-run，未写入任何文件');
      console.log(
        `collect-feedback: new=${counts.new} updated=${counts.updated} same=${counts.same} conflict=${counts.conflict}`,
      );
    }
  } finally {
    if (scratchDir) {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  }
}

const isMain = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isMain) {
  main();
}
