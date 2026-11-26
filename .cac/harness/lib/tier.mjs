// lib/tier.mjs — `harness.mjs tier <status|set|explain|validate>` 实现。
// 单一判定解析器复自 .cac/hooks/lib/tier.mjs（允许「引擎 → hook lib」单向依赖）；
// 本模块是 .cac/.runtime/tier.json 的唯一写入方。
import fs from 'node:fs';
import path from 'node:path';
import {
  BUILTIN_FLOOR, DEFAULT_PROFILE, TIERS, effectiveTier, gateMode, kindOf, loadProfile, rank, readSession,
} from '../../hooks/lib/tier.mjs';
import { gateLog } from '../../hooks/lib/gatelog.mjs';
import { die, emit, projectRoot, repoRelative } from './core.mjs';

const MAX_FAST_HOURS = 8;
const GUARD_MODES = ['off', 'advise', 'block'];
const RECORDER_MODES = ['off', 'on'];
const PROFILE_KEYS = ['version', 'default', 'floor', 'hooks', 'raise', 'overrides'];
const HOOK_ROW_KEYS = ['kind', 'fast', 'standard', 'strict'];
const RAISE_KEYS = ['to', 'paths'];

function runtimeFile(root) {
  return path.join(root, '.cac', '.runtime', 'tier.json');
}

/** 内嵌于宿主 Hook 内的子闸（随宿主 Hook 注册即视为已注册）。 */
const SUB_GATES = { 'design-detail-sync': 'three-file-sync-gate' };

/**
 * 从 .cac/settings.json 提取实际注册的 Hook ID（同时兼容 string form `command` 与数组 `args`）。
 * @returns {{ids:string[], readable:boolean}}
 */
function registeredHooks(root) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(root, '.cac', 'settings.json'), 'utf8');
  } catch (_e) {
    return { ids: [], readable: false };
  }
  let settings;
  try {
    const clean = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
    settings = JSON.parse(clean.replace(/\r/g, ''));
  } catch (_e) {
    return { ids: [], readable: false };
  }
  const ids = new Set();
  for (const matchers of Object.values((settings && settings.hooks) || {})) {
    for (const matcher of (Array.isArray(matchers) ? matchers : [])) {
      for (const entry of ((matcher && matcher.hooks) || [])) {
        if (entry && typeof entry.command === 'string') {
          const cmdRe = /(?:^|[\s"'/\\])([^/\\\s"']+)\.mjs(?=\s|$|["'])/g;
          let m;
          while ((m = cmdRe.exec(entry.command)) !== null) {
            ids.add(m[1]);
          }
        }
        for (const arg of (Array.isArray(entry && entry.args) ? entry.args : [])) {
          const m = /([^/\\]+)\.mjs$/.exec(String(arg));
          if (m) ids.add(m[1]);
        }
      }
    }
  }
  for (const [sub, host] of Object.entries(SUB_GATES)) {
    if (ids.has(host)) ids.add(sub);
  }
  return { ids: [...ids].sort(), readable: true };
}

function knownHooks(root, profile) {
  const reg = registeredHooks(root);
  const ids = new Set(reg.ids);
  for (const id of Object.keys((profile && profile.hooks) || {})) ids.add(id);
  for (const id of (Array.isArray(profile && profile.floor) ? profile.floor : [])) ids.add(id);
  for (const id of BUILTIN_FLOOR) ids.add(id);
  return { ids: [...ids].sort(), registered: reg };
}

function isFloor(id, profile) {
  const declared = Array.isArray(profile && profile.floor) ? profile.floor : [];
  return BUILTIN_FLOOR.has(id) || declared.includes(id);
}

/**
 * 校验 profile.json 结构、单调性与 settings.json 注册对齐。
 * @param {object} profile
 * @param {string[]} registered
 * @returns {{code:string,hook?:string,message:string}[]}
 */
function validateProfile(profile, registered) {
  const v = [];
  const add = (code, message, hook) => v.push(hook ? { code, hook, message } : { code, message });

  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    add('NOT_AN_OBJECT', 'profile.json must be a JSON object');
    return v;
  }
  for (const key of Object.keys(profile)) {
    if (!PROFILE_KEYS.includes(key)) {
      add('UNKNOWN_FIELD', `unknown top-level field "${key}"`);
    }
  }
  if (rank(profile.default) < 0) {
    add('BAD_DEFAULT', `default must be one of ${TIERS.join(' / ')}, got ${JSON.stringify(profile.default)}`);
  }

  const floor = Array.isArray(profile.floor) ? profile.floor : null;
  if (!floor) {
    add('BAD_FLOOR', 'floor must be an array of hook ids');
  } else {
    for (const id of floor) {
      if (registered.length && !registered.includes(id)) {
        add('FLOOR_NOT_A_HOOK', `floor names "${id}", which no registered hook answers to`, id);
      }
    }
    for (const reqFloor of BUILTIN_FLOOR) {
      if (!floor.includes(reqFloor)) {
        add('MISSING_BUILTIN_FLOOR', `floor omits built-in safety floor hook "${reqFloor}"`, reqFloor);
      }
    }
  }

  const hooks = profile.hooks && typeof profile.hooks === 'object' && !Array.isArray(profile.hooks)
    ? profile.hooks : null;
  if (!hooks) {
    add('BAD_HOOKS', 'hooks must be an object keyed by hook id');
  } else {
    for (const [id, row] of Object.entries(hooks)) {
      if (floor && isFloor(id, profile)) {
        add('FLOOR_IN_TABLE', `floor hook "${id}" also appears in hooks table; floor gates cannot be lowered`, id);
        continue;
      }
      if (registered.length && !registered.includes(id)) {
        add('NOT_A_HOOK', `hooks table has a row for "${id}", which no registered hook answers to`, id);
        continue;
      }
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        add('BAD_ROW', `the row for "${id}" is not an object`, id);
        continue;
      }
      for (const key of Object.keys(row)) {
        if (!HOOK_ROW_KEYS.includes(key)) {
          add('UNKNOWN_ROW_FIELD', `the row for "${id}" has an unknown field "${key}"`, id);
        }
      }
      const kind = row.kind;
      if (kind !== 'guard' && kind !== 'recorder') {
        add('BAD_KIND', `the row for "${id}" declares kind ${JSON.stringify(kind)}; must be guard or recorder`, id);
        continue;
      }
      const legal = kind === 'guard' ? GUARD_MODES : RECORDER_MODES;
      let monotonic = true;
      let previous = -1;
      for (const tier of TIERS) {
        const value = row[tier];
        const at = legal.indexOf(value);
        if (at < 0) {
          add('BAD_MODE', `the row for "${id}" sets ${tier}=${JSON.stringify(value)}; legal modes: ${legal.join(' | ')}`, id);
          monotonic = false;
          break;
        }
        if (at < previous) monotonic = false;
        previous = at;
      }
      if (!monotonic && !v.some((f) => f.hook === id && f.code === 'BAD_MODE')) {
        add('NOT_MONOTONIC', `the row for "${id}" is stricter at a lower tier (${TIERS.map((t) => `${t}=${row[t]}`).join(', ')})`, id);
      }
    }
    for (const id of registered) {
      if (!hooks[id] && !isFloor(id, profile)) {
        add('UNREGISTERED', `registered hook "${id}" is in neither hooks table nor floor`, id);
      }
    }
  }

  const raise = profile.raise;
  if (!raise || typeof raise !== 'object' || Array.isArray(raise)) {
    add('BAD_RAISE', 'raise must be an object with to / paths');
  } else {
    for (const key of Object.keys(raise)) {
      if (!RAISE_KEYS.includes(key)) add('UNKNOWN_RAISE_FIELD', `raise has an unknown field "${key}"`);
    }
    if (rank(raise.to) < 0) {
      add('BAD_RAISE_TO', `raise.to must be one of ${TIERS.join(' / ')}, got ${JSON.stringify(raise.to)}`);
    }
    if (!Array.isArray(raise.paths) || raise.paths.some((p) => typeof p !== 'string')) {
      add('BAD_RAISE_PATHS', 'raise.paths must be an array of glob strings');
    }
  }

  const overrides = profile.overrides;
  if (overrides !== undefined) {
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
      add('BAD_OVERRIDES', 'overrides must be an object keyed by hook id');
    } else {
      for (const [id, value] of Object.entries(overrides)) {
        if (isFloor(id, profile)) {
          add('OVERRIDE_ON_FLOOR', `overrides names floor hook "${id}", which cannot be overridden`, id);
          continue;
        }
        const legal = (hooks && hooks[id] && hooks[id].kind === 'recorder') ? RECORDER_MODES : GUARD_MODES;
        if (!legal.includes(value)) {
          add('BAD_OVERRIDE', `overrides sets "${id}" to ${JSON.stringify(value)}; must be one of ${legal.join(' / ')}`, id);
        }
      }
    }
  }
  return v;
}

function governancePaths(root = projectRoot()) {
  const { profile } = loadProfile(root);
  const paths = (profile && profile.raise && profile.raise.paths) || null;
  return Array.isArray(paths) && paths.every((p) => typeof p === 'string')
    ? paths : DEFAULT_PROFILE.raise.paths;
}

function tierState(root = projectRoot()) {
  const eff = effectiveTier({ projectDir: root });
  const expires = eff.sticky === true || eff.expiresEpoch === null ? NaN : Number(eff.expiresEpoch);
  const session = eff.sticky === true ? readSession(root) : null;
  return {
    reason: session && typeof session.reason === 'string' ? session.reason : null,
    tier: eff.tier,
    source: eff.source,
    fast: eff.tier === 'fast',
    sticky: eff.sticky === true,
    raisedBy: eff.raisedBy || null,
    expiresEpoch: Number.isFinite(expires) ? expires : null,
    remainingHours: Number.isFinite(expires)
      ? Math.max(0, Math.round((expires * 1000 - Date.now()) / 360000) / 10)
      : null,
  };
}

function modeTable(root, profile) {
  const out = {};
  for (const id of knownHooks(root, profile).ids) out[id] = gateMode(id, { projectDir: root });
  return out;
}

function humanState(state) {
  const bits = [
    state.sticky && state.tier === 'fast' ? 'fast (sticky, until revoked)' : state.tier,
    'source=' + state.source,
  ];
  if (state.remainingHours !== null) bits.push(state.remainingHours + 'h left');
  if (state.raisedBy && state.raisedBy.length) {
    bits.push('raised by ' + state.raisedBy.slice(0, 3).join(', ')
      + (state.raisedBy.length > 3 ? ' and ' + (state.raisedBy.length - 3) + ' more' : ''));
  }
  return 'tier: ' + bits.join(', ') + (state.sticky && state.reason ? ' -- ' + state.reason : '');
}

function cmdTierStatus(root) {
  const { profile, present } = loadProfile(root);
  const state = tierState(root);
  process.stderr.write(humanState(state)
    + (present ? '' : ' (no profile.json installed; running on built-in default table)') + '\n');
  return emit({
    status: 'ok',
    code: 0,
    tier: state.tier,
    source: state.source,
    ...(state.raisedBy && state.raisedBy.length ? { raisedBy: state.raisedBy } : {}),
    ...(state.sticky ? { sticky: true, expiresEpoch: null } : {}),
    ...(state.expiresEpoch === null ? {} : { expiresEpoch: state.expiresEpoch, remainingHours: state.remainingHours }),
    default: present && rank(profile.default) >= 0 ? profile.default : DEFAULT_PROFILE.default,
    profilePresent: present,
    hooks: modeTable(root, profile),
  }, 0);
}

function cmdTierExplain(root, id) {
  const { profile } = loadProfile(root);
  const known = knownHooks(root, profile);
  if (!id) {
    return die('usage: tier explain <hook-id>\nknown: ' + known.ids.join(', ') + '\n', 2);
  }
  if (!known.ids.includes(id)) {
    return die('unknown hook id: ' + id + '\nknown: ' + known.ids.join(', ') + '\n', 2);
  }
  const kind = kindOf(id, root);
  const floor = isFloor(id, profile);
  const row = (profile.hooks || {})[id];
  const strongest = kind === 'guard' ? 'block' : 'on';
  const tiers = {};
  for (const t of TIERS) tiers[t] = floor ? strongest : ((row && row[t]) || strongest);
  const ov = (profile.overrides || {})[id];
  const state = tierState(root);
  const effective = gateMode(id, { projectDir: root });
  const source = floor ? 'floor' : (typeof ov === 'string' ? 'override' : state.source);
  const out = {
    status: 'ok',
    code: 0,
    hook: id,
    kind,
    floor,
    tiers,
    effective,
    tier: state.tier,
    source,
    ...(typeof ov === 'string' ? { override: ov } : {}),
    ...(state.raisedBy && state.raisedBy.length ? { raisedBy: state.raisedBy } : {}),
  };
  process.stderr.write(id + ': ' + effective + ' now (' + kind + ', source ' + source + ') -- '
    + TIERS.map((t) => t + '=' + tiers[t]).join(', ') + '\n');
  return emit(out, 0);
}

function cmdTierSet(root, target, flags) {
  const usage = 'usage: tier set <' + TIERS.join('|') + '> [--hours N | --sticky] [--reason "why"]\n';
  if (!target) return die('missing tier\n' + usage, 2);
  if (rank(target) < 0) return die('unknown tier: ' + target + '\n' + usage, 2);
  const reason = typeof flags.reason === 'string' ? flags.reason.trim() : '';
  if (target === 'fast' && !reason) {
    return die('tier set fast requires --reason\n' + usage, 2);
  }
  const hoursGiven = Object.prototype.hasOwnProperty.call(flags, 'hours');
  if (hoursGiven && target !== 'fast') {
    return die('--hours applies to fast only\n' + usage, 2);
  }
  const sticky = Object.prototype.hasOwnProperty.call(flags, 'sticky');
  if (sticky && target !== 'fast') {
    return die('--sticky applies to fast only\n' + usage, 2);
  }
  if (sticky && hoursGiven) {
    return die('--sticky and --hours are mutually exclusive\n' + usage, 2);
  }
  let hours = MAX_FAST_HOURS;
  let clamped = false;
  if (hoursGiven) {
    const n = Number(flags.hours);
    if (typeof flags.hours !== 'string' || !Number.isFinite(n) || n <= 0) {
      return die('--hours must be a positive number of hours\n' + usage, 2);
    }
    hours = n;
    if (hours > MAX_FAST_HOURS) { hours = MAX_FAST_HOURS; clamped = true; }
  }

  const now = Math.floor(Date.now() / 1000);
  const record = {
    tier: target,
    reason,
    by: 'user',
    set_epoch: now,
    ...(target === 'fast' && sticky ? { sticky: true, expires_epoch: null } : {}),
    ...(target === 'fast' && !sticky ? { expires_epoch: now + Math.round(hours * 3600) } : {}),
  };
  const file = runtimeFile(root);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record) + '\n', { encoding: 'utf8' });
  } catch (e) {
    return die('could not write ' + repoRelative(file) + ': ' + String((e && e.message) || e) + '\n', 1);
  }

  const until = record.expires_epoch ? new Date(record.expires_epoch * 1000).toISOString()
    : (sticky ? 'sticky, until revoked' : 'no expiry');
  gateLog('tier', 'set ' + target + ' (' + until + ')' + (reason ? ' -- ' + reason : ''), root);
  if (clamped) {
    process.stderr.write(`--hours ${flags.hours} capped at ${MAX_FAST_HOURS}h\n`);
  }
  process.stderr.write('tier: ' + target + (record.expires_epoch ? ' until ' + until : '')
    + (sticky ? ' (sticky, until revoked; tier set standard to revoke)' : '')
    + (reason ? ' -- ' + reason : '') + '\n');
  return emit({
    status: 'ok',
    code: 0,
    tier: target,
    path: repoRelative(file),
    expiresEpoch: record.expires_epoch === undefined ? null : record.expires_epoch,
    ...(sticky ? { sticky: true } : {}),
    hours: target === 'fast' && !sticky ? hours : null,
    clamped,
    effective: tierState(root).tier,
  }, 0);
}

function cmdTierValidate(root) {
  const { profile, present, corrupt, path: file } = loadProfile(root);
  if (!present) {
    process.stderr.write('no ' + repoRelative(file) + ': built-in default table is in force\n');
    return emit({ status: 'degraded', code: 3, ok: null, note: 'no-profile', file: repoRelative(file), violations: [] }, 3);
  }
  if (corrupt) {
    process.stderr.write(repoRelative(file) + ' could not be parsed as JSON\n');
    return emit({
      status: 'violation',
      code: 1,
      ok: false,
      file: repoRelative(file),
      violations: [{ code: 'UNREADABLE', message: 'profile.json could not be read as JSON' }],
    }, 1);
  }
  const reg = registeredHooks(root);
  const violations = validateProfile(profile, reg.ids);
  for (const f of violations) process.stderr.write(f.code + ': ' + f.message + '\n');
  if (!reg.readable) {
    process.stderr.write('.cac/settings.json could not be read; hook-registration rules skipped\n');
    return emit({
      status: 'degraded',
      code: 3,
      ok: null,
      degraded: true,
      degradedReason: 'settings-unreadable',
      degradedFile: '.cac/settings.json',
      file: repoRelative(file),
      registeredHooks: 0,
      registeredHooksReadable: false,
      violations,
    }, 3);
  }
  const code = violations.length ? 1 : 0;
  return emit({
    status: code === 0 ? 'ok' : 'violation',
    code,
    ok: violations.length === 0,
    degraded: false,
    file: repoRelative(file),
    registeredHooks: reg.ids.length,
    registeredHooksReadable: reg.readable,
    violations,
  }, code);
}

function cmdTier(flags, positional) {
  const root = projectRoot();
  const sub = positional[0];
  switch (sub) {
    case 'status':   return cmdTierStatus(root);
    case 'explain':  return cmdTierExplain(root, positional[1]);
    case 'set':      return cmdTierSet(root, positional[1], flags);
    case 'validate': return cmdTierValidate(root);
    default:
      return die((sub ? 'unknown tier sub-command: ' + sub + '\n' : 'missing tier sub-command\n')
        + 'usage: tier status | set <' + TIERS.join('|') + '> [--hours N | --sticky] [--reason "why"] | '
        + 'explain <hook-id> | validate\n', 2);
  }
}

export {
  MAX_FAST_HOURS, validateProfile, registeredHooks, knownHooks, modeTable, tierState,
  governancePaths, cmdTier, readSession,
};
