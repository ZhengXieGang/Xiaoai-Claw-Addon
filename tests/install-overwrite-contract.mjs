import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import os from "node:os";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const linuxInstaller = readFileSync(join(repositoryRoot, "install.sh"), "utf8");
const windowsInstaller = readFileSync(
  join(repositoryRoot, "install.cmd"),
  "utf8",
);

assert.doesNotMatch(linuxInstaller, /plugins\s+uninstall/u);
assert.doesNotMatch(windowsInstaller, /plugins\s+uninstall/iu);
assert.match(linuxInstaller, /plugins install "\$PLUGIN_INSTALL_FORCE_FLAG"/u);
assert.match(windowsInstaller, /plugins install --force/iu);
assert.match(
  windowsInstaller,
  /resolve_plugin_install_force_flag[\s\S]*?当前 OpenClaw 不支持安全覆盖安装/iu,
  "install.cmd must stop safely when --force is unavailable for an existing plugin",
);
assert.match(
  linuxInstaller,
  /plugins inspect openclaw-plugin-xiaoai-cloud --json[\s\S]*?未检测到已有插件/iu,
  "install.sh must retain a fresh-install path for older OpenClaw versions",
);
assert.match(
  windowsInstaller,
  /plugins inspect openclaw-plugin-xiaoai-cloud --json[\s\S]*?未检测到已有插件/iu,
  "install.cmd must retain a fresh-install path for older OpenClaw versions",
);

if (process.platform === "win32") {
  const windowsRoot = mkdtempSync(
    join(os.tmpdir(), "xiaoai-install-windows-contract-"),
  );
  const windowsSourceDir = join(windowsRoot, "source");
  const windowsStateDir = join(windowsRoot, "state");
  const windowsFakeOpenclaw = join(windowsRoot, "fake-openclaw.cmd");
  const windowsOldPluginMarker = join(windowsStateDir, "old-plugin.marker");

  mkdirSync(join(windowsSourceDir, "scripts"), { recursive: true });
  mkdirSync(windowsStateDir, { recursive: true });
  writeFileSync(join(windowsSourceDir, "install.cmd"), windowsInstaller, "utf8");
  writeFileSync(join(windowsSourceDir, "package.json"), "{}\n", "utf8");
  writeFileSync(
    join(windowsSourceDir, "scripts", "configure-openclaw-install.mjs"),
    "process.exit(0);\n",
    "utf8",
  );
  writeFileSync(windowsOldPluginMarker, "old-plugin\n", "utf8");

  const fakeOpenclawScript = [
    "@echo off",
    "if not \"%XIAOAI_TRACE_FILE%\"==\"\" >> \"%XIAOAI_TRACE_FILE%\" echo %*",
    "if /i \"%~1\"==\"--version\" (",
    "  echo OpenClaw 2026.7.1",
    "  exit /b 0",
    ")",
    "if /i \"%~1\"==\"plugins\" if /i \"%~2\"==\"install\" if /i \"%~3\"==\"--help\" (",
    "  if \"%XIAOAI_FORCE_SUPPORT%\"==\"1\" echo   --force Overwrite an existing plugin",
    "  exit /b 0",
    ")",
    "if /i \"%~1\"==\"plugins\" if /i \"%~2\"==\"inspect\" (",
    "  if \"%XIAOAI_EXISTING_PLUGIN%\"==\"1\" exit /b 0",
    "  if not \"%XIAOAI_INSTALLED_MARKER%\"==\"\" if exist \"%XIAOAI_INSTALLED_MARKER%\" exit /b 0",
    "  exit /b 1",
    ")",
    "if /i \"%~1\"==\"plugins\" if /i \"%~2\"==\"uninstall\" (",
    "  type nul > \"%XIAOAI_UNINSTALL_FILE%\"",
    "  exit /b 97",
    ")",
    "if /i \"%~1\"==\"plugins\" if /i \"%~2\"==\"install\" (",
    "  type nul > \"%XIAOAI_INSTALL_FILE%\"",
    "  if \"%XIAOAI_INSTALL_SHOULD_FAIL%\"==\"1\" exit /b 42",
    "  if not \"%XIAOAI_INSTALLED_MARKER%\"==\"\" type nul > \"%XIAOAI_INSTALLED_MARKER%\"",
    "  exit /b 0",
    ")",
    "if /i \"%~1\"==\"gateway\" if /i \"%~2\"==\"restart\" exit /b 0",
    "exit /b 0",
    "",
  ].join("\r\n");
  writeFileSync(windowsFakeOpenclaw, fakeOpenclawScript, "utf8");

  function runWindowsInstaller({ traceFile, uninstallFile, installFile, logFile, env }) {
    const command = [
      `call \"${join(windowsSourceDir, "install.cmd")}\"`,
      "--skip-npm-install",
      `--openclaw-bin \"${windowsFakeOpenclaw}\"`,
      `--state-dir \"${windowsStateDir}\"`,
      `--log-file \"${logFile}\"`,
    ].join(" ");
    return spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], {
      cwd: windowsSourceDir,
      encoding: "utf8",
      // cmd.exe parses its own quoting rules and does not understand the
      // backslash escaping Node normally adds for Windows argv values.
      windowsVerbatimArguments: true,
      env: {
        ...process.env,
        XIAOAI_TRACE_FILE: traceFile,
        XIAOAI_UNINSTALL_FILE: uninstallFile,
        XIAOAI_INSTALL_FILE: installFile,
        ...env,
      },
    });
  }

  const failedInstallTraceFile = join(windowsRoot, "failed-install.trace");
  const failedInstallUninstallFile = join(windowsRoot, "failed-install.uninstall");
  const failedInstallFile = join(windowsRoot, "failed-install.install");
  const failedInstallResult = runWindowsInstaller({
    traceFile: failedInstallTraceFile,
    uninstallFile: failedInstallUninstallFile,
    installFile: failedInstallFile,
    logFile: join(windowsRoot, "failed-install.log"),
    env: {
      XIAOAI_FORCE_SUPPORT: "1",
      XIAOAI_EXISTING_PLUGIN: "1",
      XIAOAI_INSTALL_SHOULD_FAIL: "1",
    },
  });
  assert.notEqual(failedInstallResult.status, 0, "the Windows fake plugin install must fail");
  assert.equal(
    readFileSync(windowsOldPluginMarker, "utf8"),
    "old-plugin\n",
    "the old Windows plugin marker must survive an install failure",
  );
  assert.equal(
    existsSync(failedInstallUninstallFile),
    false,
    "install.cmd must not uninstall before attempting the replacement",
  );
  assert.equal(
    existsSync(failedInstallFile),
    true,
    "install.cmd must attempt the force install",
  );
  assert.match(readFileSync(failedInstallTraceFile, "utf8"), /plugins install --force/iu);

  const unsupportedExistingTraceFile = join(
    windowsRoot,
    "unsupported-existing.trace",
  );
  const unsupportedExistingInstallFile = join(
    windowsRoot,
    "unsupported-existing.install",
  );
  const unsupportedExistingUninstallFile = join(
    windowsRoot,
    "unsupported-existing.uninstall",
  );
  const unsupportedExistingResult = runWindowsInstaller({
    traceFile: unsupportedExistingTraceFile,
    uninstallFile: unsupportedExistingUninstallFile,
    installFile: unsupportedExistingInstallFile,
    logFile: join(windowsRoot, "unsupported-existing.log"),
    env: {
      XIAOAI_FORCE_SUPPORT: "0",
      XIAOAI_EXISTING_PLUGIN: "1",
      XIAOAI_INSTALL_SHOULD_FAIL: "0",
    },
  });
  assert.notEqual(
    unsupportedExistingResult.status,
    0,
    "an existing Windows plugin must not be replaced without --force support",
  );
  assert.equal(
    existsSync(unsupportedExistingInstallFile),
    false,
    "an unsupported Windows overwrite must stop before installing",
  );
  assert.equal(
    existsSync(unsupportedExistingUninstallFile),
    false,
    "an unsupported Windows overwrite must not uninstall the existing plugin",
  );

  const legacyTraceFile = join(windowsRoot, "legacy.trace");
  const legacyInstallFile = join(windowsRoot, "legacy.install");
  const legacyUninstallFile = join(windowsRoot, "legacy.uninstall");
  const legacyInstalledMarker = join(windowsRoot, "legacy-installed.marker");
  const legacyResult = runWindowsInstaller({
    traceFile: legacyTraceFile,
    uninstallFile: legacyUninstallFile,
    installFile: legacyInstallFile,
    logFile: join(windowsRoot, "legacy.log"),
    env: {
      XIAOAI_FORCE_SUPPORT: "0",
      XIAOAI_EXISTING_PLUGIN: "0",
      XIAOAI_INSTALL_SHOULD_FAIL: "0",
      XIAOAI_INSTALLED_MARKER: legacyInstalledMarker,
    },
  });
  assert.equal(
    legacyResult.status,
    0,
    "a fresh Windows install must work without --force support",
  );
  assert.equal(
    existsSync(legacyInstallFile),
    true,
    "legacy Windows OpenClaw must receive a normal install",
  );
  assert.equal(
    existsSync(legacyUninstallFile),
    false,
    "a fresh Windows install must not uninstall anything",
  );
  assert.doesNotMatch(
    readFileSync(legacyTraceFile, "utf8"),
    /plugins install --force/iu,
  );

  console.log("Install overwrite contract passed (Windows runtime checks).");
  process.exit(0);
}

const testRoot = mkdtempSync(join(os.tmpdir(), "xiaoai-install-contract-"));
const sourceDir = join(testRoot, "source");
const stateDir = join(testRoot, "state");
const traceFile = join(testRoot, "openclaw.trace");
const uninstallFile = join(testRoot, "uninstall.called");
const installFile = join(testRoot, "install.called");
const fakeOpenclaw = join(testRoot, "fake-openclaw");
const logFile = join(testRoot, "installer.log");
const fakeOpenclawScript = `#!/usr/bin/env sh
set -u
command_line="$*"
printf '%s\\n' "$command_line" >> "$XIAOAI_TRACE_FILE"
case "$command_line" in
  "--version")
    printf '%s\\n' 'OpenClaw 2026.7.1 (contract-test)'
    exit 0
    ;;
  "gateway status")
    printf '%s\\n' 'Runtime: stopped'
    exit 0
    ;;
  "plugins install --help")
    if [ "\${XIAOAI_FORCE_SUPPORT:-1}" = "1" ]; then
      printf '%s\\n' '  --force Overwrite an existing plugin'
    fi
    exit 0
    ;;
  "plugins inspect"*)
    if [ "\${XIAOAI_EXISTING_PLUGIN:-1}" = "1" ]; then
      exit 0
    fi
    if [ -n "\${XIAOAI_INSTALLED_MARKER:-}" ] && [ -e "\${XIAOAI_INSTALLED_MARKER:-}" ]; then
      exit 0
    fi
    exit 1
    ;;
  "plugins uninstall"*)
    : > "$XIAOAI_UNINSTALL_FILE"
    exit 97
    ;;
  "plugins install"*)
    : > "$XIAOAI_INSTALL_FILE"
    if [ "\${XIAOAI_INSTALL_SHOULD_FAIL:-1}" = "1" ]; then
      exit 42
    fi
    if [ -n "\${XIAOAI_INSTALLED_MARKER:-}" ]; then
      : > "$XIAOAI_INSTALLED_MARKER"
    fi
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;

mkdirSync(sourceDir, { recursive: true });
mkdirSync(stateDir, { recursive: true });
writeFileSync(join(sourceDir, "install.sh"), linuxInstaller, "utf8");
writeFileSync(join(sourceDir, "package.json"), "{}\n", "utf8");
writeFileSync(join(stateDir, "old-plugin.marker"), "old-plugin\n", "utf8");
writeFileSync(fakeOpenclaw, fakeOpenclawScript, "utf8");
chmodSync(fakeOpenclaw, 0o755);

const result = spawnSync(
  "sh",
  [
    join(sourceDir, "install.sh"),
    "--skip-npm-install",
    "--openclaw-bin",
    fakeOpenclaw,
    "--state-dir",
    stateDir,
    "--log-file",
    logFile,
  ],
  {
    cwd: sourceDir,
    encoding: "utf8",
    env: {
      ...process.env,
      XIAOAI_EXISTING_PLUGIN: "1",
      XIAOAI_INSTALL_SHOULD_FAIL: "1",
      XIAOAI_TRACE_FILE: traceFile,
      XIAOAI_UNINSTALL_FILE: uninstallFile,
      XIAOAI_INSTALL_FILE: installFile,
    },
  },
);

assert.notEqual(result.status, 0, "the fake plugin install must fail");
assert.equal(
  readFileSync(join(stateDir, "old-plugin.marker"), "utf8"),
  "old-plugin\n",
  "the old plugin marker must survive an install failure",
);
assert.equal(
  !existsSync(uninstallFile),
  true,
  "install.sh must not uninstall before attempting the replacement",
);
assert.equal(
  existsSync(installFile),
  true,
  "install.sh must attempt the force install",
);
assert.match(readFileSync(traceFile, "utf8"), /plugins install --force/u);

const unsupportedExistingTraceFile = join(
  testRoot,
  "unsupported-existing.trace",
);
const unsupportedExistingInstallFile = join(
  testRoot,
  "unsupported-existing.install.called",
);
const unsupportedExistingResult = spawnSync(
  "sh",
  [
    join(sourceDir, "install.sh"),
    "--skip-npm-install",
    "--openclaw-bin",
    fakeOpenclaw,
    "--state-dir",
    stateDir,
    "--log-file",
    join(testRoot, "unsupported-existing.log"),
  ],
  {
    cwd: sourceDir,
    encoding: "utf8",
    env: {
      ...process.env,
      XIAOAI_EXISTING_PLUGIN: "1",
      XIAOAI_FORCE_SUPPORT: "0",
      XIAOAI_INSTALL_SHOULD_FAIL: "0",
      XIAOAI_TRACE_FILE: unsupportedExistingTraceFile,
      XIAOAI_UNINSTALL_FILE: uninstallFile,
      XIAOAI_INSTALL_FILE: unsupportedExistingInstallFile,
    },
  },
);
assert.notEqual(
  unsupportedExistingResult.status,
  0,
  "an existing plugin must not be replaced without --force support",
);
assert.equal(
  existsSync(unsupportedExistingInstallFile),
  false,
  "an unsupported overwrite must stop before installing",
);
assert.equal(
  existsSync(uninstallFile),
  false,
  "an unsupported overwrite must not uninstall the existing plugin",
);

const legacyRoot = mkdtempSync(
  join(os.tmpdir(), "xiaoai-install-legacy-contract-"),
);
const legacySourceDir = join(legacyRoot, "source");
const legacyStateDir = join(legacyRoot, "state");
const legacyTraceFile = join(legacyRoot, "openclaw.trace");
const legacyInstallFile = join(legacyRoot, "install.called");
const legacyInstalledMarker = join(legacyRoot, "installed.marker");
const legacyLogFile = join(legacyRoot, "installer.log");
mkdirSync(legacySourceDir, { recursive: true });
mkdirSync(legacyStateDir, { recursive: true });
mkdirSync(join(legacySourceDir, "scripts"), { recursive: true });
writeFileSync(join(legacySourceDir, "install.sh"), linuxInstaller, "utf8");
writeFileSync(join(legacySourceDir, "package.json"), "{}\n", "utf8");
writeFileSync(
  join(legacySourceDir, "scripts", "configure-openclaw-install.mjs"),
  "process.exit(0);\n",
  "utf8",
);
const legacyOpenclaw = join(legacyRoot, "fake-openclaw");
writeFileSync(legacyOpenclaw, fakeOpenclawScript, "utf8");
chmodSync(legacyOpenclaw, 0o755);
const legacyResult = spawnSync(
  "sh",
  [
    join(legacySourceDir, "install.sh"),
    "--skip-npm-install",
    "--openclaw-bin",
    legacyOpenclaw,
    "--state-dir",
    legacyStateDir,
    "--log-file",
    legacyLogFile,
  ],
  {
    cwd: legacySourceDir,
    encoding: "utf8",
    env: {
      ...process.env,
      XIAOAI_EXISTING_PLUGIN: "0",
      XIAOAI_INSTALL_SHOULD_FAIL: "0",
      XIAOAI_FORCE_SUPPORT: "0",
      XIAOAI_TRACE_FILE: legacyTraceFile,
      XIAOAI_INSTALL_FILE: legacyInstallFile,
      XIAOAI_INSTALLED_MARKER: legacyInstalledMarker,
    },
  },
);
assert.equal(
  legacyResult.status,
  0,
  "a fresh install must work without --force support",
);
assert.equal(
  existsSync(legacyInstallFile),
  true,
  "legacy OpenClaw must receive a normal install",
);
assert.doesNotMatch(
  readFileSync(legacyTraceFile, "utf8"),
  /plugins install --force/u,
);

console.log("Install overwrite contract passed (Linux failure protection).");
