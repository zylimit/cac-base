#!/usr/bin/env node
// .cac/scripts/doctor.mjs — Full pure-Node integrity & configuration health check for cac-base.
// Self-contained (Node >= 20 built-ins only) so it runs identically in both cac-base and downstream projects.
// Supports default human output (`✓ / ✗ / !`) and `--json` single-line JSON output.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CORE_RULES = [
  'dev-workflow-details',
  'subagent-dispatch',
  'file-structure',
  'memory-systems',
  'design-detail',
  'domain-rulings',
];

const CORE_AGENTS = [
  'implementer',
  'code-reviewer',
  'tester',
  'deployer',
  'researcher',
  'feedback-observer',
  'evolution-runner',
  'progress-recorder',
  'domain-recorder',
];

const CORE_HOOK_LIBS = ['io', 'gatelog', 'tier', 'harness'];

const CORE_SCRIPTS = [
  'doctor.mjs',
  'project-status.mjs',
  'progress-archive.mjs',
  'plan-archive.mjs',
  'plan-lint.mjs',
  'predev-lint.mjs',
  'ui-audit.mjs',
  'ui-slop-scan.mjs',
  'design-trace.mjs',
  'page-shots.mjs',
  'readable-docs.mjs',
  'supervisor.mjs',
  'test-age.mjs',
  'gate-audit.mjs',
  'install-githooks.mjs',
  'collect-feedback.mjs',
];

const CODEAGENT_CANDIDATES = ['codeagent', 'codeAgentCLI', 'codeagentcli', 'cac'];
const MAN_MAX_NAMED = 20;

function toPosix(p) {
  return String(p ?? '').replace(/\\/g, '/');
}

function hasYamlFrontmatterHeader(rawText) {
  const text = String(rawText ?? '').replace(/^\uFEFF/, '');
  return /^---(?:[ \t]*\r?\n|[ \t]*$)/.test(text);
}

function hashLfFile(fullPath) {
  const buf = fs.readFileSync(fullPath);
  let hasCr = false;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0d) {
      hasCr = true;
      break;
    }
  }
  let norm = buf;
  if (hasCr) {
    const tmp = Buffer.allocUnsafe(buf.length);
    let n = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== 0x0d) tmp[n++] = buf[i];
    }
    norm = tmp.subarray(0, n);
  }
  return createHash('sha256').update(norm).digest('hex');
}

function whichCmd(exe) {
  if (!exe) return null;
  if (exe.includes('/') || exe.includes('\\')) {
    return fs.existsSync(exe) ? exe : null;
  }
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD;.PS1').split(';').map((s) => s.trim()).filter(Boolean)
    : [''];
  for (const d of dirs) {
    if (process.platform === 'win32') {
      const direct = path.join(d, exe);
      if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
    }
    for (const ext of exts) {
      const cand = path.join(d, exe + ext);
      try {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function parseDoctorArgs(argv) {
  let jsonMode = false;
  let rootArg = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') {
      jsonMode = true;
    } else if (a === '--root') {
      const next = argv[++i];
      if (!next || next.startsWith('-')) {
        process.stderr.write('doctor: --root requires a directory path\n');
        process.exit(2);
      }
      rootArg = next;
    } else if (a.startsWith('--root=')) {
      rootArg = a.slice(7);
    } else if (a === '-h' || a === '--help') {
      process.stdout.write('usage: node .cac/scripts/doctor.mjs [target-dir] [--root <dir>] [--json]\n');
      process.exit(0);
    } else if (a.startsWith('-')) {
      process.stderr.write(`doctor: unknown option: ${a}\n`);
      process.exit(2);
    } else if (rootArg === null) {
      rootArg = a;
    } else {
      process.stderr.write(`doctor: unexpected extra argument: ${a}\n`);
      process.exit(2);
    }
  }
  return { jsonMode, rootArg: rootArg || '.' };
}

function extractHookScriptPath(entry, root) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  let rawRef = '';
  if (Array.isArray(entry.args) && entry.args.length > 0 && /^["']?node(?:\.exe)?["']?$/i.test(String(entry.command || '').trim())) {
    rawRef = String(entry.args[0] || '').trim().replace(/^(['"])(.*)\1$/, '$2');
  } else if (!('args' in entry) && typeof entry.command === 'string') {
    const m = /^["']?node(?:\.exe)?["']?\s+(?:"([^"]+\.mjs)"|'([^']+\.mjs)'|([^"'\s]+\.mjs))(?:\s|$)/i.exec(entry.command.trim());
    if (m) rawRef = m[1] ?? m[2] ?? m[3] ?? '';
  }
  if (!rawRef) return null;
  const expanded = rawRef
    .split('${CODEAGENT3_PROJECT_DIR}').join(root)
    .split('${CAC_PROJECT_DIR}').join(root);
  const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(root, expanded);
  return { rawRef, resolved };
}

function verifyManifestFile(root, relManifestPath, label, { ok, bad, note }) {
  const fullManifest = path.join(root, relManifestPath);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(fullManifest, 'utf8'));
  } catch (e) {
    bad(`${label} 不是合法 JSON（${e.message}）`);
    return;
  }
  if (!data || !Array.isArray(data.files)) {
    bad(`${label} 结构损坏（缺少 files 数组）`);
    return;
  }
  let checked = 0;
  let missing = 0;
  let mismatch = 0;
  for (const item of data.files) {
    if (!item || typeof item.path !== 'string' || typeof item.sha256 !== 'string') continue;
    const rel = toPosix(item.path);
    const full = path.join(root, rel);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      missing++;
      if (missing <= MAN_MAX_NAMED) {
        bad(`${label} 缺件：${rel} 已登记但本地缺失（期望 ${item.sha256.slice(0, 8)}）`);
      }
      continue;
    }
    checked++;
    const actual = hashLfFile(full);
    if (actual !== item.sha256) {
      mismatch++;
      if (mismatch <= MAN_MAX_NAMED) {
        bad(`${label} 篡改/漂移：${rel} 期望 ${item.sha256.slice(0, 8)} 实际 ${actual.slice(0, 8)}`);
      }
    }
  }
  if (mismatch > MAN_MAX_NAMED) {
    bad(`${label} 另有 ${mismatch - MAN_MAX_NAMED} 条 SHA 不符未逐条列出`);
  }
  if (missing > MAN_MAX_NAMED) {
    bad(`${label} 另有 ${missing - MAN_MAX_NAMED} 条缺件未逐条列出`);
  }
  if (checked === 0 && missing === 0) {
    note(`${label} 存在但包含 0 条文件记录`);
  } else if (mismatch === 0 && missing === 0) {
    ok(`${label} 全量比对 ${checked} 条 LF-SHA256 一致`);
  } else {
    if (mismatch > 0) bad(`${label} 全量比对 ${checked} 条，${mismatch} 条 LF-SHA256 不符`);
    if (missing > 0) bad(`${label} 另有 ${missing} 条登记文件在本地缺失`);
  }
}

export function runDoctor(rawTarget, { jsonMode = false } = {}) {
  const segs = String(rawTarget).split(/[\\/]+/);
  if (segs.includes('..')) {
    process.stderr.write(`doctor: 路径不安全（含 '..'）：${rawTarget}\n`);
    process.exit(2);
  }
  const root = path.resolve(rawTarget);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    process.stderr.write(`doctor: 目标目录不存在：${rawTarget}\n`);
    process.exit(2);
  }

  const items = [];
  const errors = [];
  const warnings = [];
  let okCount = 0;
  let badCount = 0;
  let noteCount = 0;

  const ok = (msg) => {
    okCount++;
    items.push({ level: 'ok', message: msg });
    if (!jsonMode) process.stdout.write(`✓ ${msg}\n`);
  };
  const bad = (msg) => {
    badCount++;
    errors.push(msg);
    items.push({ level: 'bad', message: msg });
    if (!jsonMode) process.stderr.write(`✗ ${msg}\n`);
  };
  const note = (msg) => {
    noteCount++;
    warnings.push(msg);
    items.push({ level: 'note', message: msg });
    if (!jsonMode) process.stderr.write(`! ${msg}\n`);
  };
  const info = (msg) => {
    items.push({ level: 'info', message: msg });
    if (!jsonMode) process.stdout.write(`- ${msg}\n`);
  };

  // ① .cac/.runtime/install.marker 是否 interrupted
  const markerPath = path.join(root, '.cac', '.runtime', 'install.marker');
  if (fs.existsSync(markerPath)) {
    let rawMarker = '';
    try {
      rawMarker = fs.readFileSync(markerPath, 'utf8');
    } catch {
      rawMarker = 'interrupted';
    }
    if (rawMarker.includes('interrupted')) {
      bad('上次安装未完成（.cac/.runtime/install.marker 状态为 interrupted）：请重跑 setup 补装');
    } else {
      note('存在 .cac/.runtime/install.marker（可能有安装进程正在执行）');
    }
  } else {
    ok('安装事务状态干净（无残留 install.marker）');
  }

  // ② .cac/rules/AGENTS.md 主控宪法（严禁含任何 YAML frontmatter）与 6 核心按需细则存在
  const rulesDir = path.join(root, '.cac', 'rules');
  if (fs.existsSync(rulesDir) && fs.statSync(rulesDir).isDirectory()) {
    ok('.cac/rules 目录存在');
  } else {
    bad('.cac/rules 目录缺失');
  }

  const agentsMdPath = path.join(rulesDir, 'AGENTS.md');
  let agentsMdText = '';
  if (fs.existsSync(agentsMdPath) && fs.statSync(agentsMdPath).isFile() && fs.statSync(agentsMdPath).size > 0) {
    agentsMdText = fs.readFileSync(agentsMdPath, 'utf8');
    if (hasYamlFrontmatterHeader(agentsMdText)) {
      bad('.cac/rules/AGENTS.md 不得包含 YAML frontmatter（含 paths: 等任何头部，必须保持纯 Markdown 以确保宿主启动自动注入）');
    } else {
      ok('.cac/rules/AGENTS.md 存在（无 YAML frontmatter，启动自动注入）');
    }
  } else {
    bad('.cac/rules/AGENTS.md 缺失或为空');
  }

  for (const r of CORE_RULES) {
    const rp = path.join(rulesDir, `${r}.md`);
    if (fs.existsSync(rp) && fs.statSync(rp).size > 0) {
      ok(`rule ${r}.md`);
    } else {
      bad(`rule ${r}.md 缺失或为空`);
    }
  }

  // ③ .cac/agents/ 9 个核心角色存在且与 .cac/rules/AGENTS.md 调度表双向对齐
  const agentsDir = path.join(root, '.cac', 'agents');
  if (fs.existsSync(agentsDir) && fs.statSync(agentsDir).isDirectory()) {
    ok('.cac/agents 目录存在');
  } else {
    bad('.cac/agents 目录缺失');
  }
  for (const role of CORE_AGENTS) {
    const ap = path.join(agentsDir, `${role}.md`);
    if (fs.existsSync(ap) && fs.statSync(ap).size > 0) {
      ok(`agent ${role}`);
    } else {
      bad(`agent ${role} 缺失或为空`);
    }
  }

  if (agentsMdText) {
    const regSet = new Set();
    const re = /\.cac\/agents\/([A-Za-z0-9_.-]+)\.md/g;
    let m;
    while ((m = re.exec(agentsMdText)) !== null) {
      regSet.add(m[1]);
    }
    const registered = [...regSet].sort();
    if (registered.length < CORE_AGENTS.length) {
      bad(`.cac/rules/AGENTS.md 调度表仅解析到 ${registered.length} 个角色（至少应含 ${CORE_AGENTS.length} 个核心角色）`);
    } else {
      const missingOnDisk = registered.filter((name) => !fs.existsSync(path.join(agentsDir, `${name}.md`)));
      if (missingOnDisk.length === 0) {
        ok(`agent 名单与 .cac/rules/AGENTS.md 调度表一致（已登记 ${registered.length} 个角色）`);
      } else {
        bad(`.cac/rules/AGENTS.md 调度表已登记但本地缺失：${missingOnDisk.join(', ')}`);
      }
      if (fs.existsSync(agentsDir)) {
        for (const ent of fs.readdirSync(agentsDir, { withFileTypes: true })) {
          if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
          const roleName = ent.name.slice(0, -3);
          if (!regSet.has(roleName)) {
            note(`agent ${roleName} 未登记进 .cac/rules/AGENTS.md 调度表（主 Agent 不会自动调度）`);
          }
        }
      }
    }
  }

  // ④ .cac/skills/*/SKILL.md 齐全且非空
  const skillsDir = path.join(root, '.cac', 'skills');
  if (!fs.existsSync(skillsDir) || !fs.statSync(skillsDir).isDirectory()) {
    bad('.cac/skills 目录缺失');
  } else {
    ok('.cac/skills 目录存在');
    const skillDirs = fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
    if (skillDirs.length === 0) {
      bad('.cac/skills 下没有任何技能目录');
    } else {
      let validSkills = 0;
      for (const s of skillDirs) {
        const skFile = path.join(skillsDir, s, 'SKILL.md');
        if (!fs.existsSync(skFile)) {
          bad(`skill ${s} 缺少 SKILL.md`);
        } else if (fs.readFileSync(skFile, 'utf8').trim().length === 0) {
          bad(`skill ${s}/SKILL.md 内容为空`);
        } else {
          validSkills++;
        }
      }
      if (validSkills === skillDirs.length) {
        ok(`.cac/skills 全部 ${validSkills} 个技能均含非空 SKILL.md`);
      }
    }
  }

  // ⑤ .cac/hooks/*.mjs 与 .cac/hooks/lib/*.mjs 全部通过 node --check 语法校验
  const hooksDir = path.join(root, '.cac', 'hooks');
  const hooksLibDir = path.join(hooksDir, 'lib');
  if (!fs.existsSync(hooksDir) || !fs.statSync(hooksDir).isDirectory()) {
    bad('.cac/hooks 目录缺失');
  } else {
    ok('.cac/hooks 目录存在');
    for (const libName of CORE_HOOK_LIBS) {
      const lp = path.join(hooksLibDir, `${libName}.mjs`);
      if (fs.existsSync(lp)) ok(`hooks/lib/${libName}.mjs 存在`);
      else bad(`hooks/lib/${libName}.mjs 缺失`);
    }

    const hookFiles = [];
    for (const ent of fs.readdirSync(hooksDir, { withFileTypes: true })) {
      if (ent.isFile() && ent.name.endsWith('.mjs')) hookFiles.push(path.join(hooksDir, ent.name));
    }
    if (fs.existsSync(hooksLibDir) && fs.statSync(hooksLibDir).isDirectory()) {
      for (const ent of fs.readdirSync(hooksLibDir, { withFileTypes: true })) {
        if (ent.isFile() && ent.name.endsWith('.mjs')) hookFiles.push(path.join(hooksLibDir, ent.name));
      }
    }
    hookFiles.sort();

    if (hookFiles.length === 0) {
      bad('.cac/hooks 下没有发现任何 .mjs 钩子文件');
    } else {
      let syntaxBad = 0;
      for (const hf of hookFiles) {
        const rel = toPosix(path.relative(root, hf));
        const r = spawnSync(process.execPath, ['--check', hf], {
          cwd: root,
          shell: false,
          windowsHide: true,
          encoding: 'utf8',
          timeout: 10000,
        });
        if (r.status !== 0) {
          syntaxBad++;
          bad(`hook 语法错误 ${rel}（node --check 失败）`);
        }
      }
      if (syntaxBad === 0) {
        ok(`hooks 语法校验通过（共 ${hookFiles.length} 个 .mjs 文件）`);
      }
    }
  }

  // ⑥ .cac/settings.json 合法 JSON 且每条注册 hook 指向的脚本真实存在（同时识别 string 与 exec 形态）
  const settingsPath = path.join(root, '.cac', 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    bad('.cac/settings.json 缺失');
  } else {
    let settingsObj = null;
    try {
      const clean = fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, '');
      settingsObj = JSON.parse(clean);
      ok('.cac/settings.json 是合法 JSON');
    } catch (e) {
      bad(`.cac/settings.json 不是合法 JSON（${e.message}）`);
    }
    if (settingsObj && typeof settingsObj === 'object') {
      const missingHooks = [];
      let checkedHooks = 0;
      for (const groups of Object.values(settingsObj.hooks || {})) {
        if (!Array.isArray(groups)) continue;
        for (const g of groups) {
          for (const h of (g && Array.isArray(g.hooks) ? g.hooks : [])) {
            const ref = extractHookScriptPath(h, root);
            if (!ref) continue;
            checkedHooks++;
            if (!fs.existsSync(ref.resolved) || !fs.statSync(ref.resolved).isFile()) {
              missingHooks.push(ref.rawRef);
            }
          }
        }
      }
      if (missingHooks.length > 0) {
        bad(`settings.json 有注册 hook 指向不存在的脚本：${[...new Set(missingHooks)].join(', ')}`);
      } else {
        ok(`settings.json 注册的全部 ${checkedHooks} 条 hook 均指向真实存在的脚本`);
      }
    }
  }

  // ⑦ .cac/scripts/ 核心脚本齐全
  const scriptsDir = path.join(root, '.cac', 'scripts');
  for (const s of CORE_SCRIPTS) {
    const sp = path.join(scriptsDir, s);
    if (fs.existsSync(sp) && fs.statSync(sp).isFile()) {
      ok(`.cac/scripts/${s} 存在`);
    } else {
      bad(`.cac/scripts/${s} 缺失`);
    }
  }
  if (fs.existsSync(path.join(root, 'setup.sh')) && fs.existsSync(path.join(root, '.git'))) {
    if (fs.existsSync(path.join(root, 'scripts', 'cac-base.mjs'))) {
      ok('scripts/cac-base.mjs 存在（框架源仓）');
    } else {
      bad('scripts/cac-base.mjs 缺失（框架源仓）');
    }
  }

  // ⑧ 运行时 node >= 20、git、codeagent（按序探 codeagent/codeAgentCLI/codeagentcli/cac，拿不到仅 note 不判红）
  const nodeMajor = parseInt(String(process.versions.node || '0').split('.')[0], 10);
  if (Number.isInteger(nodeMajor) && nodeMajor >= 20) {
    ok(`node 运行时可用（${process.version} >= v20）`);
  } else {
    bad(`node 版本过低（当前 ${process.version}，要求 >= v20.0.0）`);
  }

  const gitBin = whichCmd('git');
  if (gitBin) {
    ok('git 可用');
  } else {
    note('未检测到 git；git 相关治理与提交钩子能力受限');
  }

  let foundCliName = null;
  let foundCliVer = '';
  for (const cand of CODEAGENT_CANDIDATES) {
    const bin = whichCmd(cand);
    if (bin) {
      foundCliName = cand;
      const vr = spawnSync(bin, ['--version'], {
        shell: false,
        windowsHide: true,
        encoding: 'utf8',
        timeout: 5000,
      });
      if (!vr.error && vr.stdout) {
        foundCliVer = String(vr.stdout).trim().split(/\r?\n/)[0] || '';
      }
      break;
    }
  }
  if (foundCliName) {
    ok(`CodeAgent CLI 可用（${foundCliName}${foundCliVer ? ': ' + foundCliVer : ''}）`);
  } else {
    note('未检测到 codeagent CLI（按序探测 codeagent / codeAgentCLI / codeagentcli / cac）；仅提示不判红');
  }

  // ⑨ 大仓治理一致性：若存在 .cac/harness/module-catalog.json 但未装 .cac/harness/ext 则判 bad
  const harnessEntry = path.join(root, '.cac', 'harness', 'harness.mjs');
  const harnessCore = path.join(root, '.cac', 'harness', 'lib', 'core.mjs');
  const extDir = path.join(root, '.cac', 'harness', 'ext');
  const catalogFile = path.join(root, '.cac', 'harness', 'module-catalog.json');

  if (fs.existsSync(harnessEntry) && fs.existsSync(harnessCore)) {
    ok('.cac/harness 核心运行时存在（harness.mjs + lib/core.mjs）');
  } else {
    bad('.cac/harness 核心运行时缺失（需同时具备 harness.mjs 与 lib/core.mjs）');
  }

  const extInstalled = fs.existsSync(extDir) && fs.statSync(extDir).isDirectory();
  if (extInstalled) {
    ok('harness ext/ 已安装（大仓治理扩展包就绪）');
  } else {
    note('harness ext/ 未安装（默认轻装；大仓项目可运行 setup --with-harness 加装）');
  }

  if (fs.existsSync(catalogFile)) {
    if (extInstalled) {
      ok('module-catalog.json 与 harness ext/ 配套一致');
    } else {
      bad('存在 .cac/harness/module-catalog.json 但未装 .cac/harness/ext（配置自相矛盾：请运行 setup --with-harness 补装或移除 catalog）');
    }
  } else {
    info('module-catalog.json 未放置（大仓治理默认关闭）');
  }

  // ⑩ 全量比对 .cac/FRAMEWORK-MANIFEST.json（以及存在时的 FRAMEWORK-MANIFEST-OPTIONAL.json）每条记录的 LF-SHA256
  const mainManifest = path.join(root, '.cac', 'FRAMEWORK-MANIFEST.json');
  if (!fs.existsSync(mainManifest)) {
    bad('.cac/FRAMEWORK-MANIFEST.json 缺失（请运行 node scripts/cac-base.mjs manifest --write 或重跑 setup）');
  } else {
    verifyManifestFile(root, '.cac/FRAMEWORK-MANIFEST.json', 'FRAMEWORK-MANIFEST.json', { ok, bad, note });
  }

  const optManifest = path.join(root, '.cac', 'FRAMEWORK-MANIFEST-OPTIONAL.json');
  if (fs.existsSync(optManifest)) {
    verifyManifestFile(root, '.cac/FRAMEWORK-MANIFEST-OPTIONAL.json', 'FRAMEWORK-MANIFEST-OPTIONAL.json', { ok, bad, note });
  }

  // ⑪ 若项目有 docs/readable-src/config.json 则调 readable-docs.mjs check --json 做提示（note 不判红）
  const readableCfg = path.join(root, 'docs', 'readable-src', 'config.json');
  const readableScript = path.join(root, '.cac', 'scripts', 'readable-docs.mjs');
  if (fs.existsSync(readableCfg) && fs.existsSync(readableScript)) {
    const rd = spawnSync(process.execPath, [readableScript, 'check', '--json', '--root', root], {
      cwd: root,
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (rd.error) {
      note(`人读文档核对未能完成（${rd.error.message}）：可手跑 node .cac/scripts/readable-docs.mjs check`);
    } else {
      let problems = null;
      try {
        const parsed = JSON.parse(String(rd.stdout || '').trim());
        if (parsed && Array.isArray(parsed.problems)) problems = parsed.problems;
      } catch {
        problems = null;
      }
      if (!problems) {
        note('人读文档核对未返回有效 JSON：可手跑 node .cac/scripts/readable-docs.mjs check 检查原因');
      } else {
        const stalePages = problems.filter((x) => x && ['stale-page', 'missing-page', 'extra-page'].includes(x.kind)).length;
        const staleNotes = problems.filter((x) => x && x.kind === 'note-stale').length;
        if (stalePages > 0) {
          note(`人读文档有 ${stalePages} 页与当前源码不同步：请运行 node .cac/scripts/readable-docs.mjs build 更新`);
        }
        if (staleNotes > 0) {
          note(`人读文档有 ${staleNotes} 段说明待更新：请运行 node .cac/scripts/readable-docs.mjs pending 查看`);
        }
        if (stalePages === 0 && staleNotes === 0 && problems.length === 0) {
          ok('人读文档（readable-docs）核对一致（0 条差异）');
        }
      }
    }
  }

  const code = badCount > 0 ? 1 : 0;
  const status = badCount > 0 ? 'violation' : 'ok';
  const summary = badCount > 0
    ? `doctor: 自检失败（${badCount} 项错误，${noteCount} 项提示）`
    : noteCount > 0
      ? `doctor: 通过（${okCount} 项正常，有 ${noteCount} 项告警提示）`
      : `doctor: 通过（${okCount} 项全部正常）`;

  if (jsonMode) {
    process.stdout.write(
      JSON.stringify({
        status,
        code,
        ok: code === 0,
        summary,
        detail: {
          root: toPosix(root),
          counts: { ok: okCount, bad: badCount, note: noteCount },
          errors,
          warnings,
        },
      }) + '\n',
    );
  } else {
    process.stdout.write(`${summary}\n`);
  }

  return code;
}

const isMain = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isMain) {
  const { jsonMode, rootArg } = parseDoctorArgs(process.argv.slice(2));
  const exitCode = runDoctor(rootArg, { jsonMode });
  process.exit(exitCode);
}
