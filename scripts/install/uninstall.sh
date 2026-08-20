#!/usr/bin/env sh
set -eu

ENTRY_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -n "${XIAOAI_PROJECT_ROOT:-}" ]; then
  SCRIPT_DIR=$(CDPATH= cd -- "$XIAOAI_PROJECT_ROOT" && pwd)
elif [ -f "$ENTRY_DIR/package.json" ]; then
  SCRIPT_DIR="$ENTRY_DIR"
else
  SCRIPT_DIR=$(CDPATH= cd -- "$ENTRY_DIR/../.." && pwd)
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Missing required command: node" >&2
  exit 1
fi

append_node_path_entry() {
  candidate="$1"
  if [ -z "$candidate" ] || [ ! -d "$candidate" ]; then
    return 0
  fi
  case ":${NODE_PATH:-}:" in
    *":$candidate:"*)
      ;;
    *)
      NODE_PATH="${NODE_PATH:+$NODE_PATH:}$candidate"
      ;;
  esac
}

append_node_path_entry "$SCRIPT_DIR/node_modules"
if command -v npm >/dev/null 2>&1; then
  npm_root=$(npm root -g 2>/dev/null || true)
  append_node_path_entry "$npm_root"
fi
node_global_paths=$(node -p "require('module').globalPaths.join(':')" 2>/dev/null || true)
old_ifs=$IFS
IFS=:
for candidate in $node_global_paths; do
  append_node_path_entry "$candidate"
done
IFS=$old_ifs
export NODE_PATH

exec node "$SCRIPT_DIR/scripts/configure-openclaw-uninstall.mjs" "$@"
