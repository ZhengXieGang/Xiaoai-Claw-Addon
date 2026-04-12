#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const DEFAULT_PLUGIN_ID = "openclaw-plugin-xiaoai-cloud";
const DEFAULT_AGENT_ID = "xiaoai";
const DEFAULT_PLUGIN_STATE_SUBDIR = path.join("plugins", "xiaoai-cloud");
const REQUIRED_XIAOAI_TOOLS = [
    "xiaoai_speak",
    "xiaoai_play_audio",
    "xiaoai_tts_bridge",
    "xiaoai_set_volume",
    "xiaoai_get_volume",
    "xiaoai_new_session",
    "xiaoai_wake_up",
    "xiaoai_execute",
    "xiaoai_set_mode",
    "xiaoai_set_wake_word",
    "xiaoai_get_status",
    "xiaoai_login_begin",
    "xiaoai_login_status",
    "xiaoai_console_open",
    "xiaoai_set_dialog_window",
    "xiaoai_update_settings",
];

const localRequire = createRequire(import.meta.url);
let cachedJson5 = null;
let UNINSTALL_LOG_FILE = process.env.XIAOAI_UNINSTALL_LOG_FILE || "";

function printHelp() {
    console.log(`Usage: node scripts/configure-openclaw-uninstall.mjs [options]

Options:
  --profile NAME         Use the given OpenClaw profile
  --state-dir DIR        Use the given OpenClaw state dir
  --openclaw-bin CMD     OpenClaw CLI command path (default: openclaw)
  --plugin-id ID         Plugin id to uninstall (default: ${DEFAULT_PLUGIN_ID})
  --agent ID             Override the dedicated agent id to clean up
  --keep-agent           Preserve the dedicated agent and its workspace
  --remove-agent         Remove the dedicated agent and its workspace
  --keep-history         Preserve the dedicated agent conversation history
  --remove-history       Remove the dedicated agent conversation history
  --non-interactive      Do not prompt; unspecified preserve flags default to false
  --log-file PATH        Persist uninstall log to PATH
  --help                 Show this help message

Notes:
  - If you preserve conversation history but remove the dedicated agent,
    the history will be moved into <state-dir>/plugin-backups/.
  - If you preserve the dedicated agent, its xiaoai_* tool references remain
    in that agent, but those tools will not work until the plugin is reinstalled.
`);
}

function timestamp() {
    return new Date().toISOString();
}

function appendUninstallLog(line) {
    if (!UNINSTALL_LOG_FILE) {
        return;
    }
    try {
        fs.mkdirSync(path.dirname(UNINSTALL_LOG_FILE), { recursive: true });
        fs.appendFileSync(UNINSTALL_LOG_FILE, `${line}\n`, "utf8");
    } catch {
        // Ignore log persistence errors.
    }
}

function logMessage(level, message) {
    const line = `${timestamp()} [${level}] ${message}`;
    appendUninstallLog(line);
    console.error(line);
}

function logInfo(message) {
    logMessage("INFO", message);
}

function logWarn(message) {
    logMessage("WARN", message);
}

function logError(message) {
    logMessage("ERROR", message);
}

function fail(message) {
    logError(message);
    if (UNINSTALL_LOG_FILE) {
        logError(`See uninstall log for details: ${UNINSTALL_LOG_FILE}`);
    }
    process.exit(1);
}

function readString(value) {
    if (typeof value !== "string") {
        return "";
    }
    return value.trim();
}

function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function loadJson5() {
    if (!cachedJson5) {
        cachedJson5 = localRequire("json5");
    }
    return cachedJson5;
}

function readJsonFile(filePath, fallback = {}) {
    if (!filePath || !fs.existsSync(filePath)) {
        return fallback;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) {
        return fallback;
    }
    try {
        return JSON.parse(raw);
    } catch {
        return loadJson5().parse(raw);
    }
}

function writeJsonFile(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function ensureSupportedNodeVersion() {
    const major = Number.parseInt(String(process.versions.node || "0").split(".")[0] || "0", 10);
    if (!Number.isFinite(major) || major < 22) {
        fail(
            `Node.js ${process.versions.node || "unknown"} is too old. ` +
                "OpenClaw 官方文档要求插件环境使用 Node.js 22 或更高版本。"
        );
    }
}

function expandHome(value) {
    if (!value) {
        return value;
    }
    if (value === "~") {
        return os.homedir();
    }
    if (value.startsWith("~/") || value.startsWith("~\\")) {
        return path.join(os.homedir(), value.slice(2));
    }
    return value;
}

function defaultUninstallLogFile() {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const rootDir = path.resolve(scriptDir, "..");
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
    return path.join(rootDir, "uninstall-logs", `xiaoai-uninstall-${stamp}.log`);
}

function configureLogging(options) {
    UNINSTALL_LOG_FILE = readString(options.logFile) || UNINSTALL_LOG_FILE || defaultUninstallLogFile();
    logInfo(`Uninstall log file: ${UNINSTALL_LOG_FILE}`);
}

function parseArgs(argv) {
    const options = {
        profile: "",
        stateDir: "",
        openclawBin: "openclaw",
        pluginId: DEFAULT_PLUGIN_ID,
        agentId: "",
        keepAgent: undefined,
        keepHistory: undefined,
        nonInteractive: false,
        logFile: "",
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--help" || arg === "-h") {
            printHelp();
            process.exit(0);
        }
        if (
            arg === "--profile" ||
            arg === "--state-dir" ||
            arg === "--openclaw-bin" ||
            arg === "--plugin-id" ||
            arg === "--agent" ||
            arg === "--log-file"
        ) {
            const next = argv[index + 1];
            if (!next) {
                fail(`Missing value for ${arg}`);
            }
            if (arg === "--profile") {
                options.profile = next;
            } else if (arg === "--state-dir") {
                options.stateDir = next;
            } else if (arg === "--openclaw-bin") {
                options.openclawBin = next;
            } else if (arg === "--plugin-id") {
                options.pluginId = next;
            } else if (arg === "--agent") {
                options.agentId = next;
            } else if (arg === "--log-file") {
                options.logFile = next;
            }
            index += 1;
            continue;
        }
        if (arg === "--keep-agent") {
            options.keepAgent = true;
            continue;
        }
        if (arg === "--remove-agent") {
            options.keepAgent = false;
            continue;
        }
        if (arg === "--keep-history") {
            options.keepHistory = true;
            continue;
        }
        if (arg === "--remove-history") {
            options.keepHistory = false;
            continue;
        }
        if (arg === "--non-interactive") {
            options.nonInteractive = true;
            continue;
        }
        fail(`Unknown option: ${arg}`);
    }

    options.profile = readString(options.profile);
    options.stateDir = readString(options.stateDir);
    options.openclawBin = readString(options.openclawBin) || "openclaw";
    options.pluginId = readString(options.pluginId) || DEFAULT_PLUGIN_ID;
    options.agentId = readString(options.agentId);
    options.logFile = readString(options.logFile);
    return options;
}

function summarizeCommand(command, args, cwd) {
    const parts = [command, ...(Array.isArray(args) ? args : [])]
        .map((item) => JSON.stringify(String(item)))
        .join(" ");
    return cwd ? `${parts} (cwd=${cwd})` : parts;
}

function runCommand(command, args, runOptions = {}) {
    return spawnSync(command, args, {
        encoding: "utf8",
        shell: process.platform === "win32",
        cwd: runOptions.cwd,
        env: {
            ...process.env,
            ...(runOptions.env ?? {}),
        },
        stdio: runOptions.capture === false ? "inherit" : ["ignore", "pipe", "pipe"],
    });
}

function createOpenclawRunner(options) {
    const safeWorkingDirectory = path.resolve(
        expandHome(options.stateDir) || os.homedir()
    );
    return (args, runOptions = {}) => {
        const commandArgs = [];
        if (options.profile) {
            commandArgs.push("--profile", options.profile);
        }
        commandArgs.push(...args);

        if (runOptions.logCommand !== false) {
            logInfo(
                `[uninstall] Running OpenClaw CLI: ${summarizeCommand(
                    options.openclawBin,
                    commandArgs,
                    runOptions.cwd
                )}`
            );
        }

        const result = runCommand(options.openclawBin, commandArgs, {
            ...runOptions,
            cwd: runOptions.cwd || safeWorkingDirectory,
            env: {
                ...(runOptions.env ?? {}),
                ...(options.stateDir ? { OPENCLAW_STATE_DIR: options.stateDir } : {}),
            },
        });
        if (result.error) {
            throw result.error;
        }
        return result;
    };
}

function readCliStdout(result) {
    return typeof result.stdout === "string" ? result.stdout.trim() : "";
}

function readCliStderr(result) {
    return typeof result.stderr === "string" ? result.stderr.trim() : "";
}

function resolveOpenclawConfigFile(runOpenclaw, fallbackStateDir) {
    const result = runOpenclaw(["config", "file"]);
    const stdout = readCliStdout(result);
    if (result.status === 0 && stdout) {
        return path.resolve(expandHome(stdout.split(/\r?\n/).filter(Boolean).at(-1) || stdout));
    }
    if (fallbackStateDir) {
        return path.join(fallbackStateDir, "openclaw.json");
    }
    return path.join(os.homedir(), ".openclaw", "openclaw.json");
}

function resolveStateDir(options, configFile) {
    const configured = readString(options.stateDir || process.env.OPENCLAW_STATE_DIR);
    if (configured) {
        return path.resolve(expandHome(configured));
    }
    if (configFile) {
        return path.dirname(configFile);
    }
    return path.join(os.homedir(), ".openclaw");
}

function findAgentIndex(agentList, agentId) {
    return Array.isArray(agentList)
        ? agentList.findIndex((agent) => readString(agent?.id) === agentId)
        : -1;
}

function resolveManagedWorkspacePath(stateDir, agentId) {
    return path.join(stateDir, `workspace-${agentId}`);
}

function collectContext(config, options, stateDir) {
    const plugins = isRecord(config?.plugins) ? config.plugins : {};
    const entries = isRecord(plugins.entries) ? plugins.entries : {};
    const stalePluginKey = JSON.stringify(options.pluginId);
    const staleConfig = isRecord(entries[stalePluginKey]?.config) ? entries[stalePluginKey].config : {};
    const pluginConfig = isRecord(entries[options.pluginId]?.config) ? entries[options.pluginId].config : {};
    const mergedPluginConfig = {
        ...staleConfig,
        ...pluginConfig,
    };

    const configuredAgent = readString(mergedPluginConfig.openclawAgent);
    const agentId =
        readString(options.agentId) ||
        (configuredAgent && configuredAgent !== "main" ? configuredAgent : DEFAULT_AGENT_ID);

    const agentList = Array.isArray(config?.agents?.list) ? config.agents.list : [];
    const agentIndex = findAgentIndex(agentList, agentId);
    const agent = agentIndex >= 0 ? agentList[agentIndex] : undefined;
    const workspacePath =
        readString(agent?.workspace) || resolveManagedWorkspacePath(stateDir, agentId);

    return {
        pluginId: options.pluginId,
        stalePluginKey,
        agentId,
        stateDir,
        configFile: "",
        pluginConfig: mergedPluginConfig,
        agentIndex,
        agent,
        workspacePath: path.resolve(expandHome(workspacePath)),
        managedWorkspacePath: resolveManagedWorkspacePath(stateDir, agentId),
        agentDir: path.join(stateDir, "agents", agentId),
        sessionsDir: path.join(stateDir, "agents", agentId, "sessions"),
        extensionDir: path.join(stateDir, "extensions", options.pluginId),
        pluginCopyDir: path.join(stateDir, "plugins", options.pluginId),
        pluginStateDir: path.join(stateDir, DEFAULT_PLUGIN_STATE_SUBDIR),
    };
}

function pathExists(targetPath) {
    return Boolean(targetPath) && fs.existsSync(targetPath);
}

async function promptYesNo(question, defaultValue = false) {
    const suffix = defaultValue ? " [Y/n]: " : " [y/N]: ";
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    try {
        while (true) {
            const answer = readString(await rl.question(`${question}${suffix}`)).toLowerCase();
            if (!answer) {
                return defaultValue;
            }
            if (answer === "y" || answer === "yes") {
                return true;
            }
            if (answer === "n" || answer === "no") {
                return false;
            }
        }
    } finally {
        rl.close();
    }
}

async function resolveRetentionChoices(options, context) {
    const interactive =
        !options.nonInteractive && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);

    let keepAgent = options.keepAgent;
    let keepHistory = options.keepHistory;

    const agentExists =
        context.agentIndex >= 0 ||
        pathExists(context.agentDir) ||
        pathExists(context.workspacePath);
    const historyExists = pathExists(context.sessionsDir);

    if (typeof keepAgent !== "boolean") {
        if (!agentExists) {
            keepAgent = false;
        } else if (interactive) {
            keepAgent = await promptYesNo(
                `是否保留专用 agent "${context.agentId}" 及其 workspace？`,
                false
            );
        } else {
            keepAgent = false;
        }
    }

    if (typeof keepHistory !== "boolean") {
        if (!historyExists) {
            keepHistory = false;
        } else if (interactive) {
            keepHistory = await promptYesNo(
                keepAgent
                    ? `是否保留 agent "${context.agentId}" 的对话记录？`
                    : `是否保留 agent "${context.agentId}" 的对话记录备份？`,
                false
            );
        } else {
            keepHistory = false;
        }
    }

    logInfo(
        `[uninstall] Retention choices resolved: keepAgent=${String(
            keepAgent
        )}, keepHistory=${String(keepHistory)}`
    );

    return {
        keepAgent: Boolean(keepAgent),
        keepHistory: Boolean(keepHistory),
        agentExists,
        historyExists,
    };
}

function uniqueStrings(values) {
    const next = [];
    const seen = new Set();
    for (const value of values) {
        const normalized = readString(value);
        if (!normalized || seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        next.push(normalized);
    }
    return next;
}

function pruneConfig(config, context, retention) {
    const nextConfig = isRecord(config) ? { ...config } : {};
    const nextPlugins = isRecord(nextConfig.plugins) ? { ...nextConfig.plugins } : {};
    const nextEntries = isRecord(nextPlugins.entries) ? { ...nextPlugins.entries } : {};
    const nextInstalls = isRecord(nextPlugins.installs) ? { ...nextPlugins.installs } : {};
    let changed = false;

    if (Object.prototype.hasOwnProperty.call(nextEntries, context.pluginId)) {
        delete nextEntries[context.pluginId];
        changed = true;
    }
    if (Object.prototype.hasOwnProperty.call(nextEntries, context.stalePluginKey)) {
        delete nextEntries[context.stalePluginKey];
        changed = true;
    }
    if (Object.prototype.hasOwnProperty.call(nextInstalls, context.pluginId)) {
        delete nextInstalls[context.pluginId];
        changed = true;
    }
    if (Object.prototype.hasOwnProperty.call(nextInstalls, context.stalePluginKey)) {
        delete nextInstalls[context.stalePluginKey];
        changed = true;
    }

    if (Array.isArray(nextPlugins.allow)) {
        const filteredAllow = uniqueStrings(nextPlugins.allow).filter(
            (item) => item !== context.pluginId && item !== context.stalePluginKey
        );
        if (filteredAllow.length !== nextPlugins.allow.length) {
            changed = true;
        }
        nextPlugins.allow = filteredAllow;
    }
    if (Object.keys(nextEntries).length > 0 || isRecord(nextPlugins.entries)) {
        nextPlugins.entries = nextEntries;
    }
    if (Object.keys(nextInstalls).length > 0 || isRecord(nextPlugins.installs)) {
        nextPlugins.installs = nextInstalls;
    }
    nextConfig.plugins = nextPlugins;

    if (!retention.keepAgent && Array.isArray(nextConfig?.agents?.list)) {
        const previousLength = nextConfig.agents.list.length;
        nextConfig.agents = {
            ...nextConfig.agents,
            list: nextConfig.agents.list.filter(
                (agent) => readString(agent?.id) !== context.agentId
            ),
        };
        if (nextConfig.agents.list.length !== previousLength) {
            changed = true;
        }
    }

    if (Array.isArray(nextConfig?.tools?.alsoAllow)) {
        const filteredAlsoAllow = uniqueStrings(nextConfig.tools.alsoAllow).filter(
            (item) => !REQUIRED_XIAOAI_TOOLS.includes(item)
        );
        if (filteredAlsoAllow.length !== nextConfig.tools.alsoAllow.length) {
            changed = true;
        }
        nextConfig.tools = {
            ...nextConfig.tools,
            alsoAllow: filteredAlsoAllow,
        };
    }

    return {
        config: nextConfig,
        changed,
    };
}

function isManagedWorkspace(context) {
    return path.resolve(context.workspacePath) === path.resolve(context.managedWorkspacePath);
}

function removePath(targetPath, removedPaths) {
    if (!pathExists(targetPath)) {
        return;
    }
    fs.rmSync(targetPath, { recursive: true, force: true });
    removedPaths.push(targetPath);
}

function backupHistory(context, backupPaths) {
    if (!pathExists(context.sessionsDir)) {
        return "";
    }
    const stamp = new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\..*$/, "")
        .replace("T", "-");
    const backupRoot = path.join(
        context.stateDir,
        "plugin-backups",
        `${context.pluginId}-history-${context.agentId}-${stamp}`
    );
    const backupTarget = path.join(backupRoot, "sessions");
    fs.mkdirSync(backupRoot, { recursive: true });
    fs.renameSync(context.sessionsDir, backupTarget);
    backupPaths.push(backupRoot);
    return backupRoot;
}

function cleanupFilesystem(context, retention) {
    const removedPaths = [];
    const preservedPaths = [];
    const backupPaths = [];

    removePath(context.extensionDir, removedPaths);
    removePath(context.pluginCopyDir, removedPaths);
    removePath(context.pluginStateDir, removedPaths);

    if (retention.keepAgent) {
        if (pathExists(context.agentDir)) {
            preservedPaths.push(context.agentDir);
        }
        if (pathExists(context.workspacePath)) {
            preservedPaths.push(context.workspacePath);
        }
        if (retention.keepHistory) {
            if (pathExists(context.sessionsDir)) {
                preservedPaths.push(context.sessionsDir);
            }
        } else {
            removePath(context.sessionsDir, removedPaths);
        }
        return {
            removedPaths,
            preservedPaths,
            backupPaths,
            historyBackupPath: "",
        };
    }

    const historyBackupPath = retention.keepHistory
        ? backupHistory(context, backupPaths)
        : "";

    removePath(context.agentDir, removedPaths);
    if (isManagedWorkspace(context)) {
        removePath(context.workspacePath, removedPaths);
    } else if (pathExists(context.workspacePath)) {
        preservedPaths.push(context.workspacePath);
        logWarn(
            `[uninstall] Preserved custom workspace path because it is not the managed default: ${context.workspacePath}`
        );
    }

    return {
        removedPaths,
        preservedPaths,
        backupPaths,
        historyBackupPath,
    };
}

function resolveGatewayRuntimePid(runOpenclaw) {
    const result = runOpenclaw(["gateway", "status"], { logCommand: false });
    if (result.status !== 0) {
        return "";
    }
    const matched = readCliStdout(result).match(/Runtime:\s+running \(pid (\d+)/);
    return matched?.[1] || "";
}

function probeGatewayHealth(runOpenclaw) {
    const result = runOpenclaw(["gateway", "health"], { logCommand: false });
    return result.status === 0;
}

function sleep(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForGatewayHealth(runOpenclaw, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (probeGatewayHealth(runOpenclaw)) {
            return true;
        }
        sleep(2_000);
    }
    return false;
}

function waitForGatewayReload(runOpenclaw, previousPid, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const currentPid = resolveGatewayRuntimePid(runOpenclaw);
        if (currentPid && currentPid !== previousPid) {
            if (waitForGatewayHealth(runOpenclaw, 20_000)) {
                return currentPid;
            }
        }
        sleep(2_000);
    }
    return "";
}

function ensureGatewayReadyAfterUninstall(runOpenclaw, initialPid) {
    if (initialPid) {
        logInfo("[uninstall] Waiting for OpenClaw automatic reload...");
        const nextPid = waitForGatewayReload(runOpenclaw, initialPid, 30_000);
        if (nextPid) {
            logInfo(`[uninstall] Automatic reload detected: pid ${initialPid} -> ${nextPid}`);
            return {
                automaticReload: true,
                previousPid: initialPid,
                currentPid: nextPid,
            };
        }
        if (probeGatewayHealth(runOpenclaw)) {
            logInfo("[uninstall] No gateway restart detected; gateway remains healthy.");
            return {
                automaticReload: false,
                previousPid: initialPid,
                currentPid: initialPid,
            };
        }
        logWarn("[uninstall] Gateway is not healthy after uninstall; falling back to explicit restart.");
    } else if (probeGatewayHealth(runOpenclaw)) {
        logInfo("[uninstall] Gateway is healthy after uninstall; no explicit restart needed.");
        return {
            automaticReload: false,
            previousPid: "",
            currentPid: resolveGatewayRuntimePid(runOpenclaw),
        };
    }

    let result = runOpenclaw(["gateway", "restart"]);
    if (result.status !== 0) {
        logWarn(readCliStderr(result) || "[uninstall] gateway restart failed; attempting gateway start.");
        result = runOpenclaw(["gateway", "start"]);
        if (result.status !== 0) {
            fail(readCliStderr(result) || "OpenClaw gateway start failed after uninstall.");
        }
    }

    if (!waitForGatewayHealth(runOpenclaw, 120_000)) {
        fail("OpenClaw gateway did not become healthy after uninstall.");
    }
    const currentPid = resolveGatewayRuntimePid(runOpenclaw);
    logInfo("[uninstall] Gateway health check passed after explicit service recovery.");
    return {
        automaticReload: false,
        previousPid: initialPid,
        currentPid,
    };
}

function tryUninstallPlugin(runOpenclaw, pluginId) {
    const result = runOpenclaw(["plugins", "uninstall", pluginId, "--force"]);
    if (result.status === 0) {
        return {
            attempted: true,
            success: true,
            stderr: readCliStderr(result),
            stdout: readCliStdout(result),
        };
    }
    const stderr = readCliStderr(result);
    logWarn(
        stderr
            ? `[uninstall] OpenClaw standard uninstall reported an error: ${stderr}`
            : `[uninstall] OpenClaw standard uninstall reported exit code ${result.status}. Continuing with residual cleanup.`
    );
    return {
        attempted: true,
        success: false,
        stderr,
        stdout: readCliStdout(result),
    };
}

async function uninstallPlugin(options) {
    ensureSupportedNodeVersion();
    configureLogging(options);

    const runOpenclaw = createOpenclawRunner(options);
    const initialConfigFile = resolveOpenclawConfigFile(
        runOpenclaw,
        options.stateDir ? path.resolve(expandHome(options.stateDir)) : ""
    );
    const stateDir = resolveStateDir(options, initialConfigFile);
    const configFile = resolveOpenclawConfigFile(runOpenclaw, stateDir);
    const initialConfig = readJsonFile(configFile, {});
    const context = collectContext(initialConfig, options, stateDir);
    context.configFile = configFile;

    logInfo(`[uninstall] Active OpenClaw config file: ${configFile}`);
    logInfo(`[uninstall] Active OpenClaw state dir: ${stateDir}`);
    logInfo(`[uninstall] Resolved dedicated agent: ${context.agentId || "<none>"}`);

    const retention = await resolveRetentionChoices(options, context);
    const initialGatewayPid = resolveGatewayRuntimePid(runOpenclaw);
    if (initialGatewayPid) {
        logInfo(`[uninstall] Detected running gateway pid before uninstall: ${initialGatewayPid}`);
    }

    const uninstallResult = tryUninstallPlugin(runOpenclaw, options.pluginId);
    const currentConfig = readJsonFile(configFile, {});
    const pruned = pruneConfig(currentConfig, context, retention);
    if (pruned.changed) {
        writeJsonFile(configFile, pruned.config);
        logInfo(`[uninstall] Wrote updated OpenClaw config: ${configFile}`);
    } else {
        logInfo("[uninstall] OpenClaw config already clean; no additional config write needed.");
    }

    const filesystem = cleanupFilesystem(context, retention);
    const gateway = ensureGatewayReadyAfterUninstall(runOpenclaw, initialGatewayPid);

    if (retention.keepAgent) {
        logWarn(
            `[uninstall] Preserved agent "${context.agentId}". It still references xiaoai_* tools and will not work until the plugin is reinstalled or the agent is manually edited.`
        );
    }

    const summary = {
        pluginId: options.pluginId,
        configFile,
        stateDir,
        agentId: context.agentId,
        keepAgent: retention.keepAgent,
        keepHistory: retention.keepHistory,
        pluginUninstall: uninstallResult,
        configUpdated: pruned.changed,
        removedPaths: filesystem.removedPaths,
        preservedPaths: filesystem.preservedPaths,
        historyBackupPath: filesystem.historyBackupPath,
        gateway,
    };

    console.log(JSON.stringify(summary, null, 2));
    logInfo("[uninstall] configure-openclaw-uninstall completed successfully.");
}

uninstallPlugin(parseArgs(process.argv.slice(2))).catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
});
