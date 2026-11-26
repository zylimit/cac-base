// Cross-platform test helpers for cac-base (Node >= 20, zero external dependencies).
// Enforces: os.tmpdir() isolated directories, shell: false + windowsHide: true, fileURLToPath.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export { fileURLToPath };

export const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const CAC_DIR = path.resolve(TESTS_DIR, '..');
export const REPO_ROOT = path.resolve(CAC_DIR, '..');
export const HOOKS_DIR = path.join(CAC_DIR, 'hooks');
export const HARNESS_DIR = path.join(CAC_DIR, 'harness');
export const HARNESS_ENTRY = path.join(HARNESS_DIR, 'harness.mjs');
export const AUDIT_DIR = path.join(HARNESS_DIR, 'audit');
export const SCRIPTS_DIR = path.join(CAC_DIR, 'scripts');
export const GITHOOKS_RUN = path.join(CAC_DIR, 'githooks', 'run.mjs');

/** Normalize Windows backslashes to POSIX forward slashes. */
export function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

/** Write a map of relative file paths -> string/Buffer into rootDir. */
export function writeFiles(rootDir, files = {}) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(rootDir, ...toPosix(rel).split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (Buffer.isBuffer(content)) {
      fs.writeFileSync(abs, content);
    } else {
      fs.writeFileSync(abs, String(content), 'utf8');
    }
  }
}

/** Create an isolated temporary directory under os.tmpdir(). */
export function mkTmpDir(prefix = 'cac-test-') {
  const base = fs.realpathSync.native(os.tmpdir());
  return fs.mkdtempSync(path.join(base, `${prefix}${process.pid}-`));
}

/** Run an arbitrary binary with shell: false and windowsHide: true. */
export function runCmd(cmd, args = [], opts = {}) {
  const {
    cwd = REPO_ROOT,
    input = '',
    env,
    timeout = 30000,
    encoding = 'utf8',
  } = opts;
  const r = spawnSync(cmd, args, {
    cwd,
    input,
    env: env || process.env,
    shell: false,
    windowsHide: true,
    encoding,
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
  const status = (r.status === null || r.status === undefined) ? -1 : r.status;
  return {
    status,
    code: status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error || null,
    signal: r.signal || null,
  };
}

/** Execute git inside a given directory with safe non-interactive flags. */
export function gitIn(cwd, args = [], opts = {}) {
  const baseEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    ...(opts.env || {}),
  };
  return runCmd('git', args, { ...opts, cwd, env: baseEnv });
}

/**
 * Create an isolated temporary repository under os.tmpdir() for testing hooks/harness/audit.
 * @param {object} [opts]
 * @param {string} [opts.prefix]
 * @param {boolean} [opts.git]          Initialize git repo (default: true)
 * @param {boolean} [opts.initialCommit] Create initial commit so HEAD exists (default: true when git=true)
 * @param {boolean} [opts.withProfile]  Copy .cac/harness/profile.json & .cac/.gitignore (default: true)
 * @param {boolean} [opts.withSettings] Copy .cac/settings.json (default: true)
 * @param {Record<string, string|Buffer>} [opts.files] Extra initial files to seed before initial commit
 * @returns {string} Absolute path to temporary directory
 */
export function mkTmpRepo(opts = {}) {
  const {
    prefix = 'cac-repo-',
    git = true,
    initialCommit = true,
    withProfile = true,
    withSettings = true,
    files = {},
  } = opts;

  const dir = mkTmpDir(prefix);

  // Seed .cac/.gitignore so runtime state files never pollute git status
  const srcGitignore = path.join(CAC_DIR, '.gitignore');
  if (fs.existsSync(srcGitignore)) {
    writeFiles(dir, { '.cac/.gitignore': fs.readFileSync(srcGitignore, 'utf8') });
  }
  if (withProfile) {
    const srcProfile = path.join(HARNESS_DIR, 'profile.json');
    if (fs.existsSync(srcProfile)) {
      writeFiles(dir, { '.cac/harness/profile.json': fs.readFileSync(srcProfile, 'utf8') });
    }
  }
  if (withSettings) {
    const srcSettings = path.join(CAC_DIR, 'settings.json');
    if (fs.existsSync(srcSettings)) {
      writeFiles(dir, { '.cac/settings.json': fs.readFileSync(srcSettings, 'utf8') });
    }
  }
  if (Object.keys(files).length > 0) {
    writeFiles(dir, files);
  } else if (git && initialCommit) {
    writeFiles(dir, { 'README.md': '# tmp fixture\n' });
  }

  if (git) {
    gitIn(dir, ['init', '-b', 'main']);
    // Fallback if older git lacks -b
    if (!fs.existsSync(path.join(dir, '.git'))) {
      gitIn(dir, ['init']);
    }
    gitIn(dir, ['config', 'user.email', 'tester@cac-base.local']);
    gitIn(dir, ['config', 'user.name', 'CacTester']);
    gitIn(dir, ['config', 'core.autocrlf', 'false']);
    gitIn(dir, ['config', 'commit.gpgsign', 'false']);

    if (initialCommit) {
      gitIn(dir, ['add', '-A']);
      gitIn(dir, ['commit', '-m', 'chore(fixture): initialize temporary test repository']);
    }
  }

  return dir;
}

/**
 * Safely remove a temporary directory created under os.tmpdir().
 * Refuses to delete paths outside os.tmpdir() or os.tmpdir() itself.
 */
export function cleanupTmp(dir) {
  if (!dir || typeof dir !== 'string') return;
  const resolved = path.resolve(dir);
  const tmpRaw = path.resolve(os.tmpdir());
  let tmpReal = tmpRaw;
  try { tmpReal = fs.realpathSync.native(os.tmpdir()); } catch (_e) { /* keep tmpRaw */ }

  const insideRaw = resolved.startsWith(tmpRaw + path.sep) && resolved !== tmpRaw;
  const insideReal = resolved.startsWith(tmpReal + path.sep) && resolved !== tmpReal;
  if (!insideRaw && !insideReal) {
    throw new Error(`cleanupTmp refused to delete path outside os.tmpdir(): ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

function parseLastJsonLine(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const candidate = lines[i];
    if (candidate.startsWith('{') || candidate.startsWith('[')) {
      try {
        return JSON.parse(candidate);
      } catch (_e) { /* try earlier line */ }
    }
  }
  return null;
}

function buildIsolatedEnv(cwd, opts = {}) {
  const childEnv = { ...process.env };
  if (!opts.inheritProjectEnv) {
    if (opts.projectDir === null) {
      delete childEnv.CODEAGENT3_PROJECT_DIR;
      delete childEnv.CAC_PROJECT_DIR;
    } else {
      const targetDir = opts.projectDir !== undefined ? String(opts.projectDir) : cwd;
      childEnv.CODEAGENT3_PROJECT_DIR = targetDir;
      childEnv.CAC_PROJECT_DIR = targetDir;
    }
  }
  if (opts.env && typeof opts.env === 'object') {
    for (const [k, v] of Object.entries(opts.env)) {
      if (v === undefined || v === null) delete childEnv[k];
      else childEnv[k] = String(v);
    }
  }
  return childEnv;
}

/**
 * Execute a Node script in a child process (windowsHide: true, shell: false).
 * Relative scriptPath resolves against REPO_ROOT unless absolute.
 */
export function runNode(scriptPath, args = [], opts = {}) {
  const resolvedScript = path.isAbsolute(scriptPath)
    ? scriptPath
    : path.resolve(REPO_ROOT, scriptPath);
  const cwd = opts.cwd ? path.resolve(opts.cwd) : REPO_ROOT;
  const input = opts.input !== undefined ? opts.input : '';
  const env = buildIsolatedEnv(cwd, opts);

  const r = runCmd(process.execPath, [resolvedScript, ...args], {
    cwd,
    input,
    env,
    timeout: opts.timeout || 30000,
  });

  return {
    ...r,
    json: parseLastJsonLine(r.stdout),
  };
}

/**
 * Execute a .cac/hooks/<hookName>.mjs hook with JSON event or raw stdin string.
 * @param {string} hookName e.g. 'secret-exfil-guard' or 'secret-exfil-guard.mjs'
 * @param {object|string} [eventOrRaw] JSON payload object or raw string (for malformed/truncated stdin tests)
 * @param {object} [opts] { cwd, args, env, projectDir, timeout }
 */
export function runHook(hookName, eventOrRaw = {}, opts = {}) {
  let scriptPath;
  if (path.isAbsolute(hookName)) {
    scriptPath = hookName;
  } else {
    const fname = hookName.endsWith('.mjs') ? hookName : `${hookName}.mjs`;
    scriptPath = path.join(HOOKS_DIR, fname);
  }

  const inferredCwd = opts.cwd
    || (eventOrRaw && typeof eventOrRaw === 'object' && typeof eventOrRaw.cwd === 'string' ? eventOrRaw.cwd : REPO_ROOT);
  const cwd = path.resolve(inferredCwd);
  const input = opts.rawStdin !== undefined
    ? String(opts.rawStdin)
    : (typeof eventOrRaw === 'string' ? eventOrRaw : JSON.stringify(eventOrRaw));

  return runNode(scriptPath, opts.args || [], {
    ...opts,
    cwd,
    input,
  });
}
