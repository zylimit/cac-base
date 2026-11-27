#!/usr/bin/env node
// scripts/lib/settings-merge.mjs — Pure Node lossless merger & hook-form converter for .cac/settings.json.
// Zero npm / jq dependencies. Supports string <-> exec lossless round-trip conversion (default: string).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_BIN_RE = /^["']?node(?:\.exe)?["']?$/i;
const HOOK_SCRIPT_REL_RE = /^(?:\$\{(?:CODEAGENT3_PROJECT_DIR|CAC_PROJECT_DIR)\}[/\\]|\.[/\\])?\.cac[/\\]hooks[/\\]([A-Za-z0-9_-]+)\.mjs$/;
const STRING_CMD_RE = /^(?:["']?node(?:\.exe)?["']?)\s+(?:"([^"]+)"|'([^']+)'|(\S+))((?:\s+--[A-Za-z0-9_-]+)*)\s*$/i;
const HOOK_FLAG_ARG_RE = /^--[A-Za-z0-9_-]+$/;
const LEGACY_HOOK_RE =
  /(?:^|[/\\}]|["'\s])\.cac[/\\]hooks[/\\](?:[A-Za-z0-9_-]+\.(?:sh|ps1)|cc-bridge\.mjs)(?:$|["'\s])/i;

function stripMatchingQuotes(s) {
  const t = String(s ?? '').trim();
  if (t.length >= 2 && ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Deep-clone a JSON-compatible value.
 * @template T
 * @param {T} val
 * @returns {T}
 */
function cloneJson(val) {
  return JSON.parse(JSON.stringify(val));
}

/**
 * Identify whether a hook entry is a cac-base framework hook, and return its form, name, and optional flags (e.g. `--start`).
 * Recognizes `node` / `node.exe`, optional quotes, `${CODEAGENT3_PROJECT_DIR}` / `${CAC_PROJECT_DIR}` prefixes, and `/` or `\`.
 * Custom user hooks (arbitrary scripts, non-flag extra args, etc.) return null and are left untouched.
 * @param {any} entry
 * @returns {{ form: 'string' | 'exec', name: string, extraArgs: string[] } | null}
 */
export function classifyHookEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  if (typeof entry.command === 'string' && NODE_BIN_RE.test(entry.command.trim()) && Array.isArray(entry.args) && entry.args.length >= 1) {
    const m = HOOK_SCRIPT_REL_RE.exec(stripMatchingQuotes(entry.args[0]));
    if (m && m[1].toLowerCase() !== 'cc-bridge') {
      const rest = entry.args.slice(1).map((x) => String(x));
      if (rest.every((a) => HOOK_FLAG_ARG_RE.test(a))) {
        return { form: 'exec', name: m[1], extraArgs: rest };
      }
    }
  }
  if (!('args' in entry) && typeof entry.command === 'string') {
    const cm = STRING_CMD_RE.exec(entry.command.trim());
    if (cm) {
      const scriptPath = cm[1] ?? cm[2] ?? cm[3] ?? '';
      const pm = HOOK_SCRIPT_REL_RE.exec(scriptPath);
      if (pm && pm[1].toLowerCase() !== 'cc-bridge') {
        const extraArgs = cm[4] ? cm[4].trim().split(/\s+/).filter(Boolean) : [];
        return { form: 'string', name: pm[1], extraArgs };
      }
    }
  }
  return null;
}

/**
 * Check if a hook entry is a legacy .cac/hooks/*.sh, *.ps1, or cc-bridge.mjs entry that should be cleaned on upgrade.
 * @param {any} entry
 * @returns {boolean}
 */
export function isLegacyFrameworkHook(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const parts = [typeof entry.command === 'string' ? entry.command : ''];
  if (Array.isArray(entry.args)) {
    for (const a of entry.args) parts.push(String(a ?? ''));
  }
  return parts.some((p) => LEGACY_HOOK_RE.test(p));
}

/**
 * Compute logical deduplication ID for a hook entry within an event.
 * Framework hooks resolve to `hook:<name>` (or `hook:<name>:<flags>` when invoked with e.g. `--start`).
 * @param {any} entry
 * @returns {string}
 */
export function hookLogicalId(entry) {
  const cls = classifyHookEntry(entry);
  if (cls) {
    return cls.extraArgs.length > 0 ? `hook:${cls.name}:${cls.extraArgs.join(' ')}` : `hook:${cls.name}`;
  }
  const cmd = typeof entry?.command === 'string' ? entry.command : '';
  const args = Array.isArray(entry?.args) ? entry.args.map((x) => String(x)).join(' ') : '';
  return `custom:${cmd}\0${args}`;
}

/**
 * Rebuild a framework hook entry into target form ('string' | 'exec'), preserving extra keys and key order.
 * @param {Record<string, any>} entry
 * @param {'string' | 'exec'} form
 * @param {string} name
 * @param {string[]} [extraArgs]
 * @returns {Record<string, any>}
 */
export function rebuildHookEntry(entry, form, name, extraArgs = []) {
  const out = { type: entry.type ?? 'command' };
  if (form === 'exec') {
    out.command = 'node';
    out.args = [`.cac/hooks/${name}.mjs`, ...extraArgs];
  } else {
    out.command = ['node', `.cac/hooks/${name}.mjs`, ...extraArgs].join(' ');
  }
  for (const [k, v] of Object.entries(entry)) {
    if (k === 'type' || k === 'command' || k === 'args') continue;
    out[k] = v;
  }
  return out;
}

/**
 * Iterate over all matcher groups inside settings.hooks.
 * @param {any} data
 */
function* iterHookGroups(data) {
  const hooks = data && typeof data === 'object' ? data.hooks : null;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return;
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (g && typeof g === 'object' && Array.isArray(g.hooks)) yield g;
    }
  }
}

/**
 * Detect current framework hook registration form in a settings object.
 * @param {any} settingsObj
 * @returns {'string' | 'exec' | 'mixed' | 'none'}
 */
export function detectHookForm(settingsObj) {
  const forms = new Set();
  for (const g of iterHookGroups(settingsObj)) {
    for (const h of g.hooks) {
      const c = classifyHookEntry(h);
      if (c) forms.add(c.form);
    }
  }
  if (forms.size === 0) return 'none';
  if (forms.size > 1) return 'mixed';
  return [...forms][0];
}

/**
 * Convert all framework hook entries in a settings object to `targetForm` ('string' | 'exec').
 * Mutates a clone and returns `{ settings, converted }`.
 * @param {Record<string, any>} settingsObj
 * @param {'string' | 'exec'} targetForm
 * @returns {{ settings: Record<string, any>, converted: number }}
 */
export function convertHookForm(settingsObj, targetForm) {
  if (targetForm !== 'string' && targetForm !== 'exec') {
    throw new Error(`invalid hook form: ${targetForm} (expected 'string' or 'exec')`);
  }
  const copy = cloneJson(settingsObj);
  let converted = 0;
  for (const g of iterHookGroups(copy)) {
    g.hooks = g.hooks.map((h) => {
      const c = classifyHookEntry(h);
      if (!c) return h;
      const rebuilt = rebuildHookEntry(h, targetForm, c.name, c.extraArgs);
      if (JSON.stringify(rebuilt) !== JSON.stringify(h)) converted++;
      return rebuilt;
    });
  }
  return { settings: copy, converted };
}

/**
 * Deduplicate string array while preserving order.
 * @param {any[]} targetArr
 * @param {any[]} sourceArr
 * @returns {{ merged: any[], added: number }}
 */
function unionStringList(targetArr, sourceArr) {
  const out = Array.isArray(targetArr) ? [...targetArr] : [];
  const seen = new Set(out.map((x) => String(x)));
  let added = 0;
  for (const item of Array.isArray(sourceArr) ? sourceArr : []) {
    const key = String(item);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
      added++;
    }
  }
  return { merged: out, added };
}

/**
 * Clean legacy .sh/.ps1/cc-bridge.mjs framework hooks from target settings object (in place on clone).
 * Deletes empty groups and event keys whose groups all became empty after stripping.
 * @param {Record<string, any>} data
 * @returns {number} count of removed legacy hook entries
 */
function stripLegacyHooks(data) {
  let removed = 0;
  const hooks = data && typeof data.hooks === 'object' && !Array.isArray(data.hooks) ? data.hooks : null;
  if (!hooks) return 0;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const keptGroups = [];
    for (const g of groups) {
      if (!g || typeof g !== 'object' || !Array.isArray(g.hooks)) {
        keptGroups.push(g);
        continue;
      }
      const filtered = g.hooks.filter((h) => {
        if (isLegacyFrameworkHook(h)) {
          removed++;
          return false;
        }
        return true;
      });
      if (filtered.length > 0) {
        keptGroups.push({ ...g, hooks: filtered });
      }
    }
    if (keptGroups.length > 0) {
      hooks[event] = keptGroups;
    } else {
      delete hooks[event];
    }
  }
  return removed;
}

/**
 * Losslessly merge framework `sourceObj` into `targetObj` (or initialize from `sourceObj` when `targetObj` is null).
 * - Preserves all user custom top-level fields, custom permissions, and custom hooks.
 * - Unions security floor `permissions.deny` and `permissions.ask` from source into target.
 * - Cleans legacy `.cac/hooks/*.(sh|ps1)` entries.
 * - Deduplicates framework hooks per event by logical ID `hook:<name>`.
 * - Normalizes all framework hooks to `resolvedForm` (`hookForm` if given; else target's existing form; default `'string'`).
 *
 * @param {Record<string, any> | null} targetObj
 * @param {Record<string, any>} sourceObj
 * @param {{ hookForm?: '' | 'string' | 'exec' }} [opts]
 * @returns {{
 *   settings: Record<string, any>,
 *   resolvedForm: 'string' | 'exec',
 *   addedHooks: number,
 *   removedLegacy: number,
 *   addedPermissions: number
 * }}
 */
export function mergeSettings(targetObj, sourceObj, opts = {}) {
  const explicitForm = opts.hookForm || '';
  if (explicitForm !== '' && explicitForm !== 'string' && explicitForm !== 'exec') {
    throw new Error(`invalid hookForm: ${explicitForm} (expected '', 'string', or 'exec')`);
  }

  let resolvedForm = explicitForm;
  if (!resolvedForm) {
    if (targetObj && typeof targetObj === 'object') {
      const detected = detectHookForm(targetObj);
      resolvedForm = detected === 'exec' ? 'exec' : 'string';
    } else {
      resolvedForm = 'string';
    }
  }

  if (!targetObj) {
    const fresh = convertHookForm(sourceObj, resolvedForm);
    let hookCount = 0;
    for (const g of iterHookGroups(fresh.settings)) hookCount += g.hooks.length;
    return {
      settings: fresh.settings,
      resolvedForm,
      addedHooks: hookCount,
      removedLegacy: 0,
      addedPermissions: 0,
    };
  }

  const merged = cloneJson(targetObj);
  const src = cloneJson(sourceObj || {});
  const removedLegacy = stripLegacyHooks(merged);

  // Merge top-level missing keys from source without overwriting user's top-level keys.
  for (const [k, v] of Object.entries(src)) {
    if (k === 'hooks' || k === 'permissions') continue;
    if (!(k in merged)) {
      merged[k] = v;
    }
  }

  // Merge permissions (union deny & ask security floor while preserving user allow/deny/ask).
  let addedPermissions = 0;
  if (src.permissions && typeof src.permissions === 'object' && !Array.isArray(src.permissions)) {
    if (!merged.permissions || typeof merged.permissions !== 'object' || Array.isArray(merged.permissions)) {
      merged.permissions = cloneJson(src.permissions);
    } else {
      for (const listKey of ['deny', 'ask']) {
        if (Array.isArray(src.permissions[listKey])) {
          const u = unionStringList(merged.permissions[listKey], src.permissions[listKey]);
          merged.permissions[listKey] = u.merged;
          addedPermissions += u.added;
        }
      }
      for (const [pk, pv] of Object.entries(src.permissions)) {
        if (pk === 'deny' || pk === 'ask') continue;
        if (!(pk in merged.permissions)) merged.permissions[pk] = pv;
      }
    }
  }

  // Merge hooks per event using logical ID `hook:<name>`.
  let addedHooks = 0;
  if (src.hooks && typeof src.hooks === 'object' && !Array.isArray(src.hooks)) {
    if (!merged.hooks || typeof merged.hooks !== 'object' || Array.isArray(merged.hooks)) {
      merged.hooks = {};
    }
    for (const [event, srcGroups] of Object.entries(src.hooks)) {
      if (!Array.isArray(srcGroups)) continue;
      if (!Array.isArray(merged.hooks[event])) merged.hooks[event] = [];
      const existingIds = new Set();
      for (const tg of merged.hooks[event]) {
        if (!tg || !Array.isArray(tg.hooks)) continue;
        for (const th of tg.hooks) {
          existingIds.add(hookLogicalId(th));
        }
      }
      for (const sg of srcGroups) {
        if (!sg || typeof sg !== 'object' || !Array.isArray(sg.hooks)) continue;
        const toAdd = [];
        for (const sh of sg.hooks) {
          if (!sh || typeof sh !== 'object' || !sh.command) continue;
          const id = hookLogicalId(sh);
          if (!existingIds.has(id)) {
            existingIds.add(id);
            toAdd.push(sh);
            addedHooks++;
          }
        }
        if (toAdd.length > 0) {
          const matcherVal = sg.matcher ?? undefined;
          const compatibleGroup = merged.hooks[event].find(
            (tg) => tg && typeof tg === 'object' && Array.isArray(tg.hooks) && (tg.matcher ?? undefined) === matcherVal,
          );
          if (compatibleGroup) {
            compatibleGroup.hooks.push(...toAdd);
          } else {
            merged.hooks[event].push({ ...sg, hooks: toAdd });
          }
        }
      }
    }
  }

  const normalized = convertHookForm(merged, resolvedForm);
  return {
    settings: normalized.settings,
    resolvedForm,
    addedHooks,
    removedLegacy,
    addedPermissions,
  };
}

/**
 * Remove cac-base framework hooks from a settings object (used by uninstall), preserving user custom config.
 * @param {Record<string, any>} settingsObj
 * @returns {{ settings: Record<string, any>, removedHooks: number }}
 */
export function stripFrameworkHooks(settingsObj) {
  const copy = cloneJson(settingsObj);
  let removedHooks = stripLegacyHooks(copy);
  if (copy.hooks && typeof copy.hooks === 'object' && !Array.isArray(copy.hooks)) {
    for (const [event, groups] of Object.entries(copy.hooks)) {
      if (!Array.isArray(groups)) continue;
      const keptGroups = [];
      for (const g of groups) {
        if (!g || typeof g !== 'object' || !Array.isArray(g.hooks)) {
          keptGroups.push(g);
          continue;
        }
        const kept = g.hooks.filter((h) => {
          if (classifyHookEntry(h)) {
            removedHooks++;
            return false;
          }
          return true;
        });
        if (kept.length > 0) keptGroups.push({ ...g, hooks: kept });
      }
      if (keptGroups.length > 0) copy.hooks[event] = keptGroups;
      else delete copy.hooks[event];
    }
    if (Object.keys(copy.hooks).length === 0) delete copy.hooks;
  }
  return { settings: copy, removedHooks };
}

/**
 * Strip only framework-default `permissions.deny` and `permissions.ask` entries (used by `uninstall --force`),
 * leaving any user-added `deny` / `ask` / `allow` or other custom permission keys intact.
 * @param {Record<string, any>} settingsObj
 * @param {Record<string, any> | null | undefined} srcPermissions
 * @returns {{ settings: Record<string, any>, removedPermissions: number }}
 */
export function stripFrameworkPermissions(settingsObj, srcPermissions) {
  const copy = cloneJson(settingsObj);
  let removedPermissions = 0;
  const perms = copy && typeof copy.permissions === 'object' && !Array.isArray(copy.permissions)
    ? copy.permissions
    : null;
  if (!perms) return { settings: copy, removedPermissions: 0 };

  const srcDeny = new Set(Array.isArray(srcPermissions?.deny) ? srcPermissions.deny.map((x) => String(x)) : []);
  const srcAsk = new Set(Array.isArray(srcPermissions?.ask) ? srcPermissions.ask.map((x) => String(x)) : []);

  if (Array.isArray(perms.deny)) {
    const before = perms.deny.length;
    perms.deny = perms.deny.filter((x) => !srcDeny.has(String(x)));
    removedPermissions += before - perms.deny.length;
    if (perms.deny.length === 0) delete perms.deny;
  }
  if (Array.isArray(perms.ask)) {
    const before = perms.ask.length;
    perms.ask = perms.ask.filter((x) => !srcAsk.has(String(x)));
    removedPermissions += before - perms.ask.length;
    if (perms.ask.length === 0) delete perms.ask;
  }
  if (Object.keys(perms).length === 0) {
    delete copy.permissions;
  }
  return { settings: copy, removedPermissions };
}

/**
 * Serialize settings object with canonical 2-space indent + trailing LF.
 * @param {Record<string, any>} settingsObj
 * @returns {string}
 */
export function formatSettingsJson(settingsObj) {
  return JSON.stringify(settingsObj, null, 2) + '\n';
}

function runSelftest() {
  const srcSettings = {
    permissions: {
      deny: ['Read(.env)', 'Read(**/*.pem)'],
      ask: ['Bash(git push *)'],
    },
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash|PowerShell|Shell',
          hooks: [
            { type: 'command', command: 'node .cac/hooks/secret-exfil-guard.mjs', timeout: 10 },
            { type: 'command', command: 'node .cac/hooks/dangerous-command-guard.mjs' },
          ],
        },
        {
          matcher: 'Skill',
          hooks: [{ type: 'command', command: 'node .cac/hooks/release-gate.mjs' }],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [{ type: 'command', command: 'node .cac/hooks/release-gate.mjs' }],
        },
      ],
    },
  };

  // 1. Lossless string -> exec -> string round-trip (byte-for-byte identical)
  const originalStr = formatSettingsJson(srcSettings);
  const toExec = convertHookForm(srcSettings, 'exec');
  if (detectHookForm(toExec.settings) !== 'exec' || toExec.converted !== 4) {
    throw new Error(`expected exec form with 4 conversions, got ${detectHookForm(toExec.settings)} (${toExec.converted})`);
  }
  const backToStr = convertHookForm(toExec.settings, 'string');
  if (formatSettingsJson(backToStr.settings) !== originalStr) {
    throw new Error('string -> exec -> string round-trip was NOT byte-identical');
  }

  // 2. Merge with existing user settings + legacy .sh/.ps1 cleanup + cross-form dedup + multi-event preservation
  const userTarget = {
    customFlag: true,
    permissions: {
      allow: ['Bash(npm test)'],
      deny: ['Read(.env)', 'Read(secrets.local)'],
    },
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash|PowerShell|Shell',
          hooks: [
            { type: 'command', command: 'bash .cac/hooks/old-guard.sh' },
            { type: 'command', command: 'pwsh -File .cac/hooks/old-win.ps1' },
            { type: 'command', command: 'node', args: ['.cac/hooks/secret-exfil-guard.mjs'], timeout: 15 },
            { type: 'command', command: 'python3 scripts/my-custom-hook.py' },
          ],
        },
      ],
    },
  };

  const merged = mergeSettings(userTarget, srcSettings, { hookForm: '' });
  // Target had exec form -> preserved exec form by default when hookForm is ''
  if (merged.resolvedForm !== 'exec') {
    throw new Error(`expected resolvedForm=exec from target, got ${merged.resolvedForm}`);
  }
  if (merged.removedLegacy !== 2) {
    throw new Error(`expected 2 legacy hooks removed, got ${merged.removedLegacy}`);
  }
  // Added dangerous-command-guard (PreToolUse), release-gate (PreToolUse), release-gate (UserPromptSubmit) = 3
  if (merged.addedHooks !== 3) {
    throw new Error(`expected 3 added hooks (no duplicate secret-exfil-guard, kept multi-event release-gate), got ${merged.addedHooks}`);
  }
  if (!merged.settings.customFlag || !merged.settings.permissions.allow.includes('Bash(npm test)')) {
    throw new Error('user custom settings were lost during merge');
  }
  if (!merged.settings.permissions.deny.includes('Read(**/*.pem)') || !merged.settings.permissions.deny.includes('Read(secrets.local)')) {
    throw new Error('permissions.deny union failed');
  }

  // 3. Explicit --hook-form string converts everything cleanly while preserving custom python hook
  const mergedStr = mergeSettings(merged.settings, srcSettings, { hookForm: 'string' });
  if (mergedStr.addedHooks !== 0 || detectHookForm(mergedStr.settings) !== 'string') {
    throw new Error('idempotent second merge or string conversion failed');
  }
  const customHookStillThere = mergedStr.settings.hooks.PreToolUse[0].hooks.some(
    (h) => h.command === 'python3 scripts/my-custom-hook.py',
  );
  if (!customHookStillThere) {
    throw new Error('custom non-framework hook was lost');
  }

  // 4. cc-bridge.mjs (string + quoted/env/backslash + exec forms) stripped cleanly, empty event deleted, custom hook preserved
  const linkTarget = {
    hooks: {
      SessionStart: [
        {
          hooks: [
            { type: 'command', command: 'node .cac/hooks/cc-bridge.mjs session-start' },
            { type: 'command', command: 'node "${CODEAGENT3_PROJECT_DIR}\\.cac\\hooks\\cc-bridge.mjs" session-start' },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: 'Bash|PowerShell|Shell',
          hooks: [
            { type: 'command', command: 'node', args: ['./.cac/hooks/cc-bridge.mjs', 'pre-tool-use'] },
            { type: 'command', command: 'node scripts/keep-my-hook.mjs' },
          ],
        },
      ],
    },
  };
  const fromLink = mergeSettings(linkTarget, srcSettings, { hookForm: 'string' });
  if (fromLink.removedLegacy !== 3) {
    throw new Error(`expected 3 cc-bridge legacy hooks removed, got ${fromLink.removedLegacy}`);
  }
  if ('SessionStart' in fromLink.settings.hooks) {
    throw new Error('expected empty SessionStart event key to be deleted after stripping cc-bridge.mjs');
  }
  const preAfterBridge = fromLink.settings.hooks.PreToolUse.flatMap((g) => g.hooks);
  if (preAfterBridge.some((h) => JSON.stringify(h).includes('cc-bridge.mjs'))) {
    throw new Error('cc-bridge.mjs remained in merged settings');
  }
  if (!preAfterBridge.some((h) => h.command === 'node scripts/keep-my-hook.mjs')) {
    throw new Error('custom hook next to cc-bridge.mjs was lost');
  }

  process.stdout.write(JSON.stringify({ ok: true, tests: 4 }) + '\n');
}

const isMain = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) {
    runSelftest();
    process.exit(0);
  }
  let to = null;
  let doCheck = false;
  let file = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') doCheck = true;
    else if (a === '--to') to = argv[++i];
    else if (a.startsWith('--to=')) to = a.slice(5);
    else if (a === '--file') file = argv[++i];
    else if (a.startsWith('--file=')) file = a.slice(7);
    else {
      process.stderr.write(`settings-merge: unknown argument: ${a}\n`);
      process.exit(2);
    }
  }
  if (doCheck === (to !== null)) {
    process.stderr.write('usage: node scripts/lib/settings-merge.mjs (--check | --to string|exec) [--file <settings.json>] | --selftest\n');
    process.exit(2);
  }
  const root = process.env.CODEAGENT3_PROJECT_DIR || process.env.CAC_PROJECT_DIR || process.cwd();
  const targetFile = file || path.join(root, '.cac', 'settings.json');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
  } catch (e) {
    process.stderr.write(`settings-merge: failed to read ${targetFile}: ${e.message}\n`);
    process.exit(2);
  }
  if (doCheck) {
    const f = detectHookForm(parsed);
    process.stdout.write(`${f}\n`);
    process.exit(f === 'mixed' ? 1 : 0);
  }
  if (to !== 'string' && to !== 'exec') {
    process.stderr.write(`settings-merge: --to expects string or exec, got ${to}\n`);
    process.exit(2);
  }
  const res = convertHookForm(parsed, to);
  if (res.converted > 0) {
    fs.writeFileSync(targetFile, formatSettingsJson(res.settings), 'utf8');
  }
  process.stdout.write(JSON.stringify({ ok: true, to, converted: res.converted, file: targetFile }) + '\n');
}
