// harness.mjs — 大仓治理引擎的独立子进程调用面（hook 侧）。
// 默认关闭：唯一启用开关是 .cac/harness/module-catalog.json。
// 调引擎一律经 process.execPath 起子进程（windowsHide: true, shell: false），绝不 import 引擎代码。
import fs from 'node:fs';
import path from 'node:path';
import { projectDir, run } from './io.mjs';

export function harnessCatalogPath(root = projectDir()) {
  return path.join(root, '.cac', 'harness', 'module-catalog.json');
}

export function harnessEnabled(root = projectDir()) {
  try { return fs.existsSync(harnessCatalogPath(root)); } catch (_e) { return false; }
}

export function harnessExtInstalled(root = projectDir()) {
  try { return fs.existsSync(path.join(root, '.cac', 'harness', 'ext')); } catch (_e) { return false; }
}

export function harnessExtMissingNotice(gateName) {
  return `大仓治理已开启（module-catalog.json 存在）但大仓引擎包未安装，本次 ${gateName} 未执行；`
    + '请运行 `pwsh setup.ps1 -WithHarness`（或 `bash setup.sh --with-harness`）加装大仓包，或移除 module-catalog.json 关闭大仓治理。';
}

export function harnessEntry(root = projectDir()) {
  return path.join(root, '.cac', 'harness', 'harness.mjs');
}

export function harnessRun(argv, opts = {}) {
  const root = opts.cwd || projectDir();
  return run(process.execPath, [harnessEntry(root), ...argv], opts);
}

export function rcInContract(rc, ...codes) {
  return codes.some((c) => Number(c) === Number(rc));
}

export function errHead(stderr) {
  return String(stderr || '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .slice(0, 3)
    .join(' ')
    .slice(0, 400);
}
