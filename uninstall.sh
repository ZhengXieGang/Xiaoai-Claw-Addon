#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
IMPLEMENTATION="$SCRIPT_DIR/scripts/install/uninstall.sh"
if [ -f "$IMPLEMENTATION" ]; then
  export XIAOAI_PROJECT_ROOT="$SCRIPT_DIR"
  exec sh "$IMPLEMENTATION" "$@"
fi

if [ -f "$SCRIPT_DIR/scripts/configure-openclaw-uninstall.mjs" ]; then
  export XIAOAI_PROJECT_ROOT="$SCRIPT_DIR"
  exec node "$SCRIPT_DIR/scripts/configure-openclaw-uninstall.mjs" "$@"
fi

find_release_archive() {
  for candidate in \
    "$SCRIPT_DIR"/openclaw-plugin-xiaoai-cloud-bundle.zip \
    "$SCRIPT_DIR"/openclaw-plugin-xiaoai-cloud-*.zip \
    "$SCRIPT_DIR"/openclaw-plugin-xiaoai-cloud-bundle.tar.gz \
    "$SCRIPT_DIR"/openclaw-plugin-xiaoai-cloud-*.tgz \
    "$SCRIPT_DIR"/openclaw-plugin-xiaoai-cloud-*.tar.gz
  do
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
}

archive=$(find_release_archive || true)
if [ -z "$archive" ]; then
  echo "Missing uninstaller implementation: $IMPLEMENTATION" >&2
  echo "Run uninstall.sh from a complete Release bundle or repository checkout." >&2
  exit 1
fi

temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/xiaoai-uninstall-entry.XXXXXX")
cleanup() { rm -rf "$temp_dir"; }
trap cleanup EXIT HUP INT TERM
case "$archive" in
  *.zip)
    if command -v unzip >/dev/null 2>&1; then
      unzip -q "$archive" -d "$temp_dir"
    elif command -v bsdtar >/dev/null 2>&1; then
      bsdtar -xf "$archive" -C "$temp_dir"
    elif command -v python3 >/dev/null 2>&1; then
      python3 - "$archive" "$temp_dir" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as zf:
    zf.extractall(sys.argv[2])
PY
    else
      echo "Missing required command to extract zip archive: unzip / bsdtar / python3" >&2
      exit 1
    fi
    ;;
  *.tar.gz|*.tgz)
    tar -xzf "$archive" -C "$temp_dir"
    ;;
  *)
    echo "Unsupported release bundle archive: $archive" >&2
    exit 1
    ;;
esac

bundle_root=""
for candidate in \
  "$temp_dir/openclaw-plugin-xiaoai-cloud" \
  "$temp_dir/package" \
  "$temp_dir"
do
  if [ -f "$candidate/scripts/install/uninstall.sh" ] || [ -f "$candidate/uninstall.sh" ]; then
    bundle_root="$candidate"
    break
  fi
done
if [ -z "$bundle_root" ]; then
  echo "Failed to locate an uninstaller in $archive" >&2
  exit 1
fi
export XIAOAI_PROJECT_ROOT="$bundle_root"
if [ -f "$bundle_root/scripts/install/uninstall.sh" ]; then
  sh "$bundle_root/scripts/install/uninstall.sh" "$@"
else
  sh "$bundle_root/uninstall.sh" "$@"
fi
