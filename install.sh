#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SOURCE_DIR="$SCRIPT_DIR"
TEMP_RELEASE_DIR=""
DEV_MODE=0
PROFILE=""
STATE_DIR="${OPENCLAW_STATE_DIR:-}"
SKIP_NPM_INSTALL=0
PACKAGE_MANAGER="auto"
OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"
MIN_OPENCLAW_VERSION="2026.03.24"
HAS_SOURCE_TREE=0
LOG_FILE="${XIAOAI_INSTALL_LOG_FILE:-}"
CURRENT_STAGE="bootstrap"
LOG_PIPE=""
TEE_PID=""
LOG_STDIO_REDIRECTED=0
INITIAL_GATEWAY_PID=""

print_help() {
  cat <<'EOF'
Usage: ./install.sh [options]
   or: bash ./install.sh [options]

Options:
  --dev                  Install in local link mode (openclaw plugins install -l)
  --profile NAME         Use the given OpenClaw profile
  --state-dir DIR        Use the given OpenClaw state dir
  --package-manager PM   Package manager: auto | npm | pnpm
  --openclaw-bin CMD     OpenClaw CLI path or wrapper script path
  --log-file PATH        Persist installer log to PATH
  --skip-npm-install     Skip dependency install and build/runtime install step
  --help                 Show this help message

Notes:
  - You can run this script in the source repo directory.
  - You can also place this script beside a GitHub Release bundle archive
    (`openclaw-plugin-xiaoai-cloud-bundle.zip`), and it will
    auto-extract and install from that bundle.
  - Older `.tar.gz` / `.tgz` release bundles are still supported for backward compatibility.
  - If your unzip tool stripped the executable bit from install.sh,
    running `bash ./install.sh` is equally valid.
  - If your OpenClaw gateway runs in Docker or on a remote server, run this script
    inside that same container / host environment.
  - Requires OpenClaw 2026.03.24 or newer.
  - On failure, the script will print the failing stage and the installer log path.
EOF
}

timestamp() {
  date '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "unknown-time"
}

log_line() {
  level="$1"
  shift
  printf '%s [%s] %s\n' "$(timestamp)" "$level" "$*"
}

info() {
  log_line INFO "$@"
}

warn() {
  log_line WARN "$@" >&2
}

error() {
  log_line ERROR "$@" >&2
}

set_stage() {
  CURRENT_STAGE="$1"
  info "Stage: $CURRENT_STAGE"
}

cleanup_release_dir() {
  if [ -n "$TEMP_RELEASE_DIR" ] && [ -d "$TEMP_RELEASE_DIR" ]; then
    rm -rf "$TEMP_RELEASE_DIR"
  fi
}

resolve_default_log_file() {
  stamp=$(date '+%Y%m%d-%H%M%S' 2>/dev/null || echo "unknown")
  preferred_dir="$SCRIPT_DIR/install-logs"
  if mkdir -p "$preferred_dir" >/dev/null 2>&1; then
    printf '%s/xiaoai-install-%s.log\n' "$preferred_dir" "$stamp"
    return 0
  fi

  fallback_dir="${TMPDIR:-/tmp}/xiaoai-install-logs"
  mkdir -p "$fallback_dir"
  printf '%s/xiaoai-install-%s.log\n' "$fallback_dir" "$stamp"
}

setup_logging() {
  if [ -z "$LOG_FILE" ]; then
    LOG_FILE=$(resolve_default_log_file)
  fi

  log_dir=$(dirname "$LOG_FILE")
  mkdir -p "$log_dir"
  : > "$LOG_FILE"

  exec 3>&1 4>&2

  if command -v tee >/dev/null 2>&1 && command -v mkfifo >/dev/null 2>&1; then
    LOG_PIPE=$(mktemp "${TMPDIR:-/tmp}/xiaoai-install-pipe.XXXXXX")
    rm -f "$LOG_PIPE"
    if mkfifo "$LOG_PIPE"; then
      tee -a "$LOG_FILE" < "$LOG_PIPE" >&3 &
      TEE_PID=$!
      exec > "$LOG_PIPE" 2>&1
      LOG_STDIO_REDIRECTED=1
    else
      LOG_PIPE=""
      exec >> "$LOG_FILE" 2>&1
    fi
  else
    exec >> "$LOG_FILE" 2>&1
  fi

  info "Installer log: $LOG_FILE"
}

print_failure_summary() {
  exit_code="$1"
  if [ "$exit_code" -eq 0 ]; then
    printf '[install] Full log saved to %s\n' "$LOG_FILE" >&3
    return 0
  fi

  printf '\n[install] Failed during stage: %s\n' "$CURRENT_STAGE" >&4
  printf '[install] Installer log: %s\n' "$LOG_FILE" >&4
  if [ -n "$LOG_FILE" ] && [ -f "$LOG_FILE" ] && command -v tail >/dev/null 2>&1; then
    printf '[install] Recent log tail:\n' >&4
    tail -n 30 "$LOG_FILE" >&4 || true
  fi
}

finalize_logging() {
  exit_code="$1"

  if [ "$LOG_STDIO_REDIRECTED" -eq 1 ]; then
    exec 1>&3 2>&4
  fi

  if [ -n "$LOG_PIPE" ] && [ -p "$LOG_PIPE" ]; then
    rm -f "$LOG_PIPE"
  fi
  if [ -n "$TEE_PID" ]; then
    wait "$TEE_PID" 2>/dev/null || true
  fi

  print_failure_summary "$exit_code"
}

on_exit() {
  exit_code=$?
  cleanup_release_dir
  if [ -n "$LOG_FILE" ]; then
    finalize_logging "$exit_code"
  fi
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    error "Missing required command: $1"
    exit 1
  fi
}

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

resolve_extracted_source_dir() {
  if [ -f "$TEMP_RELEASE_DIR/openclaw-plugin-xiaoai-cloud/package.json" ]; then
    printf '%s\n' "$TEMP_RELEASE_DIR/openclaw-plugin-xiaoai-cloud"
    return
  fi
  if [ -f "$TEMP_RELEASE_DIR/package/package.json" ]; then
    printf '%s\n' "$TEMP_RELEASE_DIR/package"
    return
  fi
  package_json_path=$(find "$TEMP_RELEASE_DIR" -maxdepth 3 -type f -name 'package.json' | head -n 1)
  if [ -n "$package_json_path" ]; then
    dirname "$package_json_path"
    return
  fi
  echo ""
}

extract_targz_archive() {
  require_command tar
  if tar --help 2>/dev/null | grep -q -- '--no-same-owner'; then
    tar --no-same-owner -xzf "$1" -C "$2"
  else
    tar -xzf "$1" -C "$2"
  fi
}

prepare_source_dir() {
  if [ -f "$SOURCE_DIR/package.json" ]; then
    return
  fi

  set_stage "prepare_release_bundle"
  archive_path=$(find_release_archive || true)
  if [ -z "$archive_path" ]; then
    error "No package.json found in $SCRIPT_DIR, and no release bundle archive was found beside install.sh."
    error "Expected: openclaw-plugin-xiaoai-cloud-bundle.zip"
    error "Older .tar.gz / .tgz release bundles are still accepted if you already have one."
    exit 1
  fi

  TEMP_RELEASE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/xiaoai-cloud-install.XXXXXX")
  info "Extracting release bundle: $(basename "$archive_path")"
  case "$archive_path" in
    *.tar.gz|*.tgz)
      extract_targz_archive "$archive_path" "$TEMP_RELEASE_DIR"
      ;;
    *.zip)
      if command -v unzip >/dev/null 2>&1; then
        unzip -q "$archive_path" -d "$TEMP_RELEASE_DIR"
      elif command -v bsdtar >/dev/null 2>&1; then
        bsdtar -xf "$archive_path" -C "$TEMP_RELEASE_DIR"
      elif command -v python3 >/dev/null 2>&1; then
        python3 - "$archive_path" "$TEMP_RELEASE_DIR" <<'PY'
import sys, zipfile
archive, target = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(archive) as zf:
    zf.extractall(target)
PY
      else
        error "Missing required command to extract zip archive: unzip / bsdtar / python3"
        exit 1
      fi
      ;;
    *)
      error "Unsupported release bundle archive: $archive_path"
      exit 1
      ;;
  esac

  SOURCE_DIR=$(resolve_extracted_source_dir)
  if [ -z "$SOURCE_DIR" ] || [ ! -f "$SOURCE_DIR/package.json" ]; then
    error "Failed to locate package.json after extracting release bundle."
    exit 1
  fi
}

detect_source_tree() {
  HAS_SOURCE_TREE=0
  if [ -d "$SOURCE_DIR/src" ] && [ -f "$SOURCE_DIR/index.ts" ] && [ -f "$SOURCE_DIR/tsconfig.json" ]; then
    HAS_SOURCE_TREE=1
  fi
}

detect_package_manager() {
  if [ "$PACKAGE_MANAGER" = "npm" ] || [ "$PACKAGE_MANAGER" = "pnpm" ]; then
    echo "$PACKAGE_MANAGER"
    return
  fi
  if [ "$PACKAGE_MANAGER" != "auto" ]; then
    error "Unsupported package manager: $PACKAGE_MANAGER"
    exit 1
  fi

  if [ -f "$SOURCE_DIR/package-lock.json" ] && command -v npm >/dev/null 2>&1; then
    echo "npm"
    return
  fi
  if [ -f "$SOURCE_DIR/pnpm-lock.yaml" ] && command -v pnpm >/dev/null 2>&1; then
    echo "pnpm"
    return
  fi
  if command -v npm >/dev/null 2>&1; then
    echo "npm"
    return
  fi
  if command -v pnpm >/dev/null 2>&1; then
    echo "pnpm"
    return
  fi

  error "Missing required command: npm or pnpm"
  exit 1
}

ensure_supported_node() {
  node_major=$(node -p "Number(process.versions.node.split('.')[0] || 0)")
  if [ "$node_major" -lt 22 ]; then
    error "Node.js $(node -p 'process.versions.node') is too old. OpenClaw 官方文档要求插件环境使用 Node.js 22 或更高版本。"
    exit 1
  fi
}

ensure_supported_openclaw() {
  version_output=$(
    "$OPENCLAW_BIN" --version 2>&1 | tr -d '\r' | awk 'NF { line = $0 } END { print line }'
  )
  if node -e '
const raw = (process.argv[1] || "").trim();
const min = [2026, 3, 24];
const match = raw.match(/(\d{4})\.(\d{1,2})\.(\d{1,2})/);
if (!match) {
  process.exit(2);
}
const current = match.slice(1).map(Number);
for (let index = 0; index < min.length; index += 1) {
  if (current[index] > min[index]) {
    process.exit(0);
  }
  if (current[index] < min[index]) {
    process.exit(1);
  }
}
process.exit(0);
' "$version_output" >/dev/null 2>&1; then
    openclaw_version_status=0
  else
    openclaw_version_status=$?
  fi
  if [ "$openclaw_version_status" -eq 0 ]; then
    return 0
  fi
  if [ "$openclaw_version_status" -eq 2 ]; then
    error "Failed to parse OpenClaw version from: ${version_output:-<empty>}"
    error "This installer requires OpenClaw ${MIN_OPENCLAW_VERSION} or newer."
    exit 1
  fi
  error "OpenClaw ${version_output:-<unknown>} is too old. This plugin requires OpenClaw ${MIN_OPENCLAW_VERSION} or newer because it depends on the new plugin SDK / Gateway runtime."
  exit 1
}

run_pkg() {
  case "$PKG_MANAGER" in
    npm)
      npm "$@"
      ;;
    pnpm)
      pnpm "$@"
      ;;
    *)
      error "Unsupported package manager: $PKG_MANAGER"
      exit 1
      ;;
  esac
}

run_openclaw() {
  if [ -n "$STATE_DIR" ]; then
    export OPENCLAW_STATE_DIR="$STATE_DIR"
  fi
  if [ -n "$PROFILE" ]; then
    "$OPENCLAW_BIN" --profile "$PROFILE" "$@"
  else
    "$OPENCLAW_BIN" "$@"
  fi
}

resolve_plugin_install_safety_flag() {
  if run_openclaw plugins install --help 2>/dev/null | grep -q -- '--dangerously-force-unsafe-install'; then
    printf '%s\n' '--dangerously-force-unsafe-install'
    return 0
  fi
  printf '%s\n' ''
}

extract_last_nonempty_line() {
  awk 'NF { line = $0 } END { print line }'
}

expand_home_path() {
  case "$1" in
    "~")
      printf '%s\n' "$HOME"
      ;;
    "~/"*)
      printf '%s/%s\n' "$HOME" "${1#~/}"
      ;;
    *)
      printf '%s\n' "$1"
      ;;
  esac
}

resolve_active_state_dir() {
  if [ -n "$STATE_DIR" ]; then
    expand_home_path "$STATE_DIR"
    return 0
  fi

  if [ -n "${OPENCLAW_STATE_DIR:-}" ]; then
    expand_home_path "$OPENCLAW_STATE_DIR"
    return 0
  fi

  printf '%s/.openclaw\n' "$HOME"
}

read_owner_spec_for_path() {
  target_path="$1"
  if [ -z "$target_path" ] || [ ! -e "$target_path" ] || ! command -v stat >/dev/null 2>&1; then
    return 1
  fi

  if owner_spec=$(stat -c '%u:%g' "$target_path" 2>/dev/null); then
    printf '%s\n' "$owner_spec"
    return 0
  fi
  if owner_spec=$(stat -f '%u:%g' "$target_path" 2>/dev/null); then
    printf '%s\n' "$owner_spec"
    return 0
  fi
  return 1
}

resolve_target_owner_spec() {
  state_dir=$(resolve_active_state_dir)
  for candidate in \
    "$state_dir" \
    "$state_dir/extensions" \
    "$state_dir/openclaw.json"
  do
    if owner_spec=$(read_owner_spec_for_path "$candidate"); then
      printf '%s\n' "$owner_spec"
      return 0
    fi
  done

  if command -v id >/dev/null 2>&1; then
    printf '%s:%s\n' "$(id -u)" "$(id -g)"
    return 0
  fi
  return 1
}

inspect_installed_plugin_json() {
  run_openclaw plugins inspect openclaw-plugin-xiaoai-cloud --json
}

resolve_gateway_runtime_pid() {
  run_openclaw gateway status 2>/dev/null |
    sed -n 's/.*Runtime: running (pid \([0-9][0-9]*\),.*/\1/p' |
    head -n 1
}

probe_gateway_health() {
  run_openclaw gateway health >/dev/null 2>&1
}

wait_for_gateway_health() {
  timeout_seconds="${1:-60}"
  interval_seconds=2
  elapsed=0

  while [ "$elapsed" -lt "$timeout_seconds" ]; do
    if probe_gateway_health; then
      return 0
    fi
    sleep "$interval_seconds"
    elapsed=$((elapsed + interval_seconds))
  done

  return 1
}

wait_for_gateway_reload() {
  previous_pid="$1"
  timeout_seconds="${2:-75}"
  interval_seconds=2
  elapsed=0

  while [ "$elapsed" -lt "$timeout_seconds" ]; do
    current_pid=$(resolve_gateway_runtime_pid || true)
    if [ -n "$current_pid" ] && [ "$current_pid" != "$previous_pid" ]; then
      if wait_for_gateway_health 20; then
        printf '%s\n' "$current_pid"
        return 0
      fi
    fi
    sleep "$interval_seconds"
    elapsed=$((elapsed + interval_seconds))
  done

  return 1
}

ensure_gateway_running_after_install() {
  if [ -n "$INITIAL_GATEWAY_PID" ]; then
    info "[gateway] Waiting for OpenClaw automatic reload..."
    next_pid=$(wait_for_gateway_reload "$INITIAL_GATEWAY_PID" 75 || true)
    if [ -n "$next_pid" ]; then
      info "[gateway] Automatic reload detected: pid $INITIAL_GATEWAY_PID -> $next_pid"
      return 0
    fi
    warn "[gateway] Automatic reload was not detected in time; falling back to explicit restart."
  else
    info "[gateway] No running gateway detected before install."
  fi

  run_openclaw gateway restart
  if wait_for_gateway_health 120; then
    info "[gateway] Gateway health check passed after fallback restart."
    return 0
  fi

  error "[gateway] Gateway did not become healthy after fallback restart."
  return 1
}

resolve_openclaw_config_file() {
  config_file=$(run_openclaw config file 2>/dev/null | extract_last_nonempty_line || true)
  if [ -n "$config_file" ]; then
    printf '%s\n' "$config_file"
    return 0
  fi
  printf '%s/openclaw.json\n' "$(resolve_active_state_dir)"
}

normalize_installed_plugin_owner() {
  if [ "$DEV_MODE" -eq 1 ]; then
    info "[owner] Dev link install detected, skipping ownership normalization."
    return 0
  fi

  if ! command -v chown >/dev/null 2>&1 || ! command -v id >/dev/null 2>&1; then
    return 0
  fi

  state_dir=$(resolve_active_state_dir)
  plugin_path="$state_dir/extensions/openclaw-plugin-xiaoai-cloud"

  if [ ! -e "$plugin_path" ]; then
    warn "[owner] Plugin directory not found for ownership normalization: $plugin_path"
    return 0
  fi

  owner_spec=$(resolve_target_owner_spec || true)
  if [ -z "$owner_spec" ]; then
    warn "[owner] Unable to determine target owner for plugin directory: $plugin_path"
    return 0
  fi
  if chown -R "$owner_spec" "$plugin_path" >/dev/null 2>&1; then
    info "[owner] Normalized plugin directory owner: $plugin_path -> $owner_spec"
  else
    warn "[owner] Failed to normalize plugin directory owner: $plugin_path"
  fi
}

cleanup_unmanaged_plugin_install() {
  state_dir=$(resolve_active_state_dir)
  plugin_extension_path="$state_dir/extensions/openclaw-plugin-xiaoai-cloud"
  plugin_copy_path="$state_dir/plugins/openclaw-plugin-xiaoai-cloud"
  rm -rf "$plugin_extension_path" "$plugin_copy_path"

  config_file=$(resolve_openclaw_config_file || true)
  config_file=$(expand_home_path "$config_file")
  if [ -n "$config_file" ] && [ -f "$config_file" ]; then
    node - "$config_file" <<'NODE'
const fs = require("fs");
const filePath = process.argv[2];
const raw = fs.readFileSync(filePath, "utf8");
let config;
try {
  config = JSON.parse(raw);
} catch {
  const JSON5 = require("json5");
  config = JSON5.parse(raw);
}
if (config && typeof config === "object") {
  if (config.plugins && typeof config.plugins === "object") {
    if (config.plugins.entries && typeof config.plugins.entries === "object") {
      delete config.plugins.entries["openclaw-plugin-xiaoai-cloud"];
    }
    if (Array.isArray(config.plugins.allow)) {
      config.plugins.allow = config.plugins.allow.filter(
        (item) => item !== "openclaw-plugin-xiaoai-cloud"
      );
    }
  }
}
fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
NODE
  fi
}

remove_existing_plugin_install() {
  if [ "$DEV_MODE" -eq 1 ]; then
    return 0
  fi

  if run_openclaw plugins inspect openclaw-plugin-xiaoai-cloud --json >/dev/null 2>&1; then
    info "Existing plugin detected, uninstalling old version first."
    if run_openclaw plugins uninstall openclaw-plugin-xiaoai-cloud --force; then
      cleanup_unmanaged_plugin_install
      return 0
    fi
    warn "OpenClaw 标准卸载失败，正在清理残留插件目录和配置。"
    cleanup_unmanaged_plugin_install
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dev)
      DEV_MODE=1
      shift
      ;;
    --profile)
      if [ "$#" -lt 2 ]; then
        echo "Missing value for --profile" >&2
        exit 1
      fi
      PROFILE="$2"
      shift 2
      ;;
    --state-dir)
      if [ "$#" -lt 2 ]; then
        echo "Missing value for --state-dir" >&2
        exit 1
      fi
      STATE_DIR="$2"
      shift 2
      ;;
    --package-manager)
      if [ "$#" -lt 2 ]; then
        echo "Missing value for --package-manager" >&2
        exit 1
      fi
      PACKAGE_MANAGER="$2"
      shift 2
      ;;
    --openclaw-bin)
      if [ "$#" -lt 2 ]; then
        echo "Missing value for --openclaw-bin" >&2
        exit 1
      fi
      OPENCLAW_BIN="$2"
      shift 2
      ;;
    --log-file)
      if [ "$#" -lt 2 ]; then
        echo "Missing value for --log-file" >&2
        exit 1
      fi
      LOG_FILE="$2"
      shift 2
      ;;
    --skip-npm-install)
      SKIP_NPM_INSTALL=1
      shift
      ;;
    --help|-h)
      print_help
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      print_help >&2
      exit 1
      ;;
  esac
done

setup_logging
trap 'on_exit' EXIT

set_stage "prepare_source_dir"
prepare_source_dir

set_stage "preflight"
require_command node
ensure_supported_node

PKG_MANAGER=$(detect_package_manager)
require_command "$PKG_MANAGER"

if [ ! -x "$OPENCLAW_BIN" ] && ! command -v "$OPENCLAW_BIN" >/dev/null 2>&1; then
  error "OpenClaw CLI not found: $OPENCLAW_BIN"
  error "PATH=$PATH"
  exit 1
fi
ensure_supported_openclaw

detect_source_tree

info "Resolved source directory: $SOURCE_DIR"
info "Resolved package manager: $PKG_MANAGER"
info "OpenClaw binary: $OPENCLAW_BIN"
info "OpenClaw profile: ${PROFILE:-<default>}"
info "OpenClaw state dir: $(resolve_active_state_dir)"
info "Source tree mode: $( [ "$HAS_SOURCE_TREE" -eq 1 ] && printf 'source' || printf 'release-bundle' )"

cd "$SOURCE_DIR"

if [ "$SKIP_NPM_INSTALL" -ne 1 ]; then
  if [ "$HAS_SOURCE_TREE" -eq 1 ]; then
    set_stage "install_dependencies"
    info "[1/6] Installing dependencies with $PKG_MANAGER..."
    if [ "$PKG_MANAGER" = "pnpm" ]; then
      run_pkg install --no-frozen-lockfile
    else
      run_pkg install
    fi
  else
    set_stage "install_runtime_dependencies"
    info "[1/6] Installing runtime dependencies with $PKG_MANAGER..."
    if [ "$PKG_MANAGER" = "pnpm" ]; then
      run_pkg install --prod --no-frozen-lockfile
    elif [ -f "$SOURCE_DIR/package-lock.json" ]; then
      run_pkg ci --omit=dev || run_pkg install --omit=dev
    else
      run_pkg install --omit=dev
    fi
  fi
else
  info "[1/6] Skipping dependency install as requested."
fi

if [ "$HAS_SOURCE_TREE" -eq 1 ]; then
  set_stage "build_plugin"
  info "[2/6] Building plugin..."
  run_pkg run build
else
  info "[2/6] Using prebuilt release bundle, skipping build..."
fi

INITIAL_GATEWAY_PID=$(resolve_gateway_runtime_pid || true)
if [ -n "$INITIAL_GATEWAY_PID" ]; then
  info "[gateway] Detected running gateway pid before install: $INITIAL_GATEWAY_PID"
fi

set_stage "install_plugin"
info "[3/6] Installing plugin into OpenClaw..."
remove_existing_plugin_install
PLUGIN_INSTALL_SAFETY_FLAG=$(resolve_plugin_install_safety_flag)
if [ "$DEV_MODE" -eq 1 ]; then
  if [ -n "$PLUGIN_INSTALL_SAFETY_FLAG" ]; then
    run_openclaw plugins install "$PLUGIN_INSTALL_SAFETY_FLAG" -l "$SOURCE_DIR"
  else
    run_openclaw plugins install -l "$SOURCE_DIR"
  fi
else
  if [ -n "$PLUGIN_INSTALL_SAFETY_FLAG" ]; then
    run_openclaw plugins install "$PLUGIN_INSTALL_SAFETY_FLAG" "$SOURCE_DIR"
  else
    run_openclaw plugins install "$SOURCE_DIR"
  fi
fi

set_stage "normalize_owner"
info "[4/6] Normalizing installed plugin ownership..."
normalize_installed_plugin_owner

set_stage "configure_openclaw"
info "[5/6] Configuring dedicated lightweight XiaoAi agent..."
set -- --openclaw-bin "$OPENCLAW_BIN" --log-file "$LOG_FILE"
if [ -n "$PROFILE" ]; then
  set -- "$@" --profile "$PROFILE"
fi
if [ -n "$STATE_DIR" ]; then
  set -- "$@" --state-dir "$STATE_DIR"
fi
XIAOAI_INSTALL_LOG_CAPTURED=1 XIAOAI_INSTALL_LOG_FILE="$LOG_FILE" \
  node "$SOURCE_DIR/scripts/configure-openclaw-install.mjs" "$@"

set_stage "inspect_and_restart"
info "[6/6] Inspecting plugin and ensuring gateway is ready..."
inspect_installed_plugin_json
ensure_gateway_running_after_install

set_stage "completed"
echo
echo "Done. Next step:"
echo "  1. Call xiaoai_console_open"
echo "  2. Open the console link"
echo "  3. Log in and choose a XiaoAi speaker"
