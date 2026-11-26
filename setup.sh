#!/usr/bin/env bash
# setup.sh — cac-base POSIX thin wrapper (WSL / Linux / macOS / Git Bash).
# Validates node >= 20 (strict integer major comparison) and forwards arguments to scripts/cac-base.mjs.
# Usage:
#   ./setup.sh [install|upgrade|uninstall|doctor] [--target <dir> | <dir>] [--dry-run] [--with-tests] [--with-harness] [--force] [--hook-form string|exec]
#   ./setup.sh manifest (--write | --check | --leak)
#   ./setup.sh pack-check
#   ./setup.sh release <version>
set -euo pipefail

usage_die() {
  printf 'setup: %s\n' "$1" >&2
  printf 'Usage: ./setup.sh [install|upgrade|uninstall|doctor] [--target <dir> | <dir>] [--dry-run] [--with-tests] [--with-harness] [--force] [--uninstall] [--hook-form string|exec]\n' >&2
  printf 'Valid options: --target <dir>  --dry-run  --with-tests  --with-harness  --force  --uninstall  --hook-form string|exec  --json  --write  --check  --leak  --strict-syntax  --out <path>  -h|--help\n' >&2
  exit 2
}

# Pre-validate flags before invoking node so misspelled options like --dryrun ALWAYS exit 2 immediately
# even before runtime checks, and are never mistaken for a target directory.
prev_need_val=""
for arg in "$@"; do
  if [ -n "$prev_need_val" ]; then
    case "$arg" in
      -*) usage_die "option $prev_need_val requires a value (got $arg)" ;;
    esac
    if [ "$prev_need_val" = "--hook-form" ]; then
      case "$arg" in
        string|exec) ;;
        *) usage_die "--hook-form expects 'string' or 'exec' (got: $arg)" ;;
      esac
    fi
    prev_need_val=""
    continue
  fi
  case "$arg" in
    -h|--help|--dry-run|--with-tests|--with-harness|--force|--uninstall|--json|--write|--check|--leak|--strict-syntax)
      ;;
    --target|--hook-form|--out)
      prev_need_val="$arg"
      ;;
    --target=*|--out=*)
      val="${arg#*=}"
      [ -n "$val" ] || usage_die "option ${arg%%=*} requires a non-empty value"
      ;;
    --hook-form=*)
      val="${arg#*=}"
      case "$val" in
        string|exec) ;;
        *) usage_die "--hook-form expects 'string' or 'exec' (got: $val)" ;;
      esac
      ;;
    -*)
      usage_die "unknown option: $arg"
      ;;
    *)
      ;;
  esac
done
if [ -n "$prev_need_val" ]; then
  usage_die "option $prev_need_val requires a value"
fi

if ! command -v node >/dev/null 2>&1; then
  printf '[setup] missing required runtime: node (>= 20)\n' >&2
  exit 3
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || printf '0')"
case "$NODE_MAJOR" in
  ''|*[!0-9]*)
    printf '[setup] unable to parse node major version: %s\n' "$(node --version 2>/dev/null || printf 'unknown')" >&2
    exit 3
    ;;
esac

if [ "$NODE_MAJOR" -lt 20 ]; then
  printf '[setup] node >= 20 required (found %s)\n' "$(node --version 2>/dev/null || printf 'unknown')" >&2
  exit 3
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/scripts/cac-base.mjs" "$@"
