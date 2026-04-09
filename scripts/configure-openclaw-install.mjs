#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const DEFAULT_PLUGIN_ID = "openclaw-plugin-xiaoai-cloud";
const DEFAULT_AGENT_ID = "xiaoai";
let INSTALL_LOG_FILE = process.env.XIAOAI_INSTALL_LOG_FILE || "";
const INSTALL_LOG_CAPTURED = process.env.XIAOAI_INSTALL_LOG_CAPTURED === "1";
const localRequire = createRequire(import.meta.url);
let cachedJson5 = null;
const HOST_RUNTIME_DEPENDENCIES = [
    { name: "@slack/web-api", spec: "@slack/web-api@7.15.0" },
    { name: "@slack/bolt", spec: "@slack/bolt@4.6.0" },
    { name: "grammy", spec: "grammy@1.41.1" },
    { name: "@grammyjs/runner", spec: "@grammyjs/runner@2.0.3" },
    { name: "@grammyjs/transformer-throttler", spec: "@grammyjs/transformer-throttler@1.2.1" },
    { name: "@aws-sdk/client-bedrock", spec: "@aws-sdk/client-bedrock@3.1021.0" },
];
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
const WORKSPACE_PROMPT_FILENAME = "AGENTS.md";
const DEFAULT_XIAOAI_AGENT_SYSTEM_PROMPT = [
    "你正在通过真实小爱音箱实时语音对话。目标是尽快开口回答。",
    "默认先直接调用 xiaoai_speak，回答尽量简短；如果你已经拿到了可直接播放的音频 URL，也可以按 OpenClaw 官方 payload 格式直接返回 mediaUrl/mediaUrls，插件会自动交给小爱播放。",
    "除非确实需要别的工具，否则不要先输出文字。",
    "不要输出执行状态、工具回执或流程确认，只给用户真正需要听到的内容。",
    "如果系统或上下文里附带最近几轮对话内容，它仅用于保持连续语境；如果与当前用户最新输入冲突，以当前用户最新输入为准。",
].join(" ");
const LIGHTWEIGHT_WORKSPACE_FILES = {
    [WORKSPACE_PROMPT_FILENAME]: DEFAULT_XIAOAI_AGENT_SYSTEM_PROMPT,
    "SOUL.md": "说话风格：简洁、友好、干脆。\n",
    "USER.md": "默认面向音箱前的真实用户，用中文交流。\n",
    "IDENTITY.md": "身份：小爱语音代理。\n",
    "TOOLS.md": "只使用 xiaoai_* 工具处理音箱相关任务。\n",
    "HEARTBEAT.md": "# 保持空文件或仅保留注释即可跳过 heartbeat API 调用。\n",
    "MEMORY.md": "仅保留少量长期偏好。\n",
};
const OBSOLETE_LIGHTWEIGHT_WORKSPACE_FILES = {
    "BOOT.md": ["无需启动动作。\n", "无需启动动作。"],
    "BOOTSTRAP.md": [],
};
const LEGACY_LIGHTWEIGHT_WORKSPACE_FILES = {
    [WORKSPACE_PROMPT_FILENAME]: [
        [
            "你是小爱音箱的专属语音智能体。",
            "默认目标：尽快让音箱开口。",
            "",
            "规则：",
            "- 优先直接调用 xiaoai_speak。",
            "- 如果已经拿到可直接播放的音频 URL，也可以调用 xiaoai_play_audio。",
            "- 如果需要走 OpenClaw 官方 TTS 音频链路，可以调用 xiaoai_tts_bridge。",
            "- 回答尽量简短、自然、口语化。",
            "- 不要输出执行状态、工具回执或流程确认。",
            "- 只有用户明确要求控制设备、查询状态或修改设置时，才调用其他 xiaoai_* 工具。",
            "- 不要做与音箱语音无关的事情。",
        ].join("\n"),
        [
            "你是小爱音箱的专属语音智能体。",
            "默认目标：尽快让音箱开口。",
            "",
            "规则：",
            "- 优先直接调用 xiaoai_speak。",
            "- 如果需要走音频链路，可以调用 xiaoai_play_audio 或 xiaoai_tts_bridge。",
            "- 回答尽量简短、自然、口语化。",
            "- 不要输出执行状态、工具回执或流程确认。",
            "- 只有用户明确要求控制设备、查询状态或修改设置时，才调用其他 xiaoai_* 工具。",
            "- 不要做与音箱语音无关的事情。",
        ].join("\n"),
    ],
};
const PLUGIN_MANAGED_WORKSPACE_FILENAMES = [
    WORKSPACE_PROMPT_FILENAME,
    "SOUL.md",
    "USER.md",
    "IDENTITY.md",
    "TOOLS.md",
    "HEARTBEAT.md",
    "BOOT.md",
    "BOOTSTRAP.md",
    "MEMORY.md",
];

function printHelp() {
    console.log(`Usage: node scripts/configure-openclaw-install.mjs [options]

Options:
  --profile NAME      Use the given OpenClaw profile
  --state-dir DIR     Use the given OpenClaw state dir
  --agent ID          Dedicated agent id to use for XiaoAi forwarding
  --plugin-id ID      Plugin id to configure
  --openclaw-bin CMD  OpenClaw CLI command path (default: openclaw)
  --log-file PATH     Persist configure-stage log to PATH
  --openclaw-package-dir DIR
                      Override the detected OpenClaw npm package directory
  --help              Show this help message`);
}

function timestamp() {
    return new Date().toISOString();
}

function appendInstallerLog(line) {
    if (!INSTALL_LOG_FILE || INSTALL_LOG_CAPTURED) {
        return;
    }
    try {
        fs.mkdirSync(path.dirname(INSTALL_LOG_FILE), { recursive: true });
        fs.appendFileSync(INSTALL_LOG_FILE, `${line}\n`, "utf8");
    } catch {
        // Do not crash on logging failures.
    }
}

function logMessage(level, message) {
    const line = `${timestamp()} [${level}] ${message}`;
    appendInstallerLog(line);
    if (level === "ERROR" || level === "WARN") {
        console.error(line);
    } else {
        console.error(line);
    }
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

function configureLogging(options) {
    INSTALL_LOG_FILE = readString(options?.logFile) || INSTALL_LOG_FILE;
    if (INSTALL_LOG_FILE) {
        logInfo(`Configure-stage log file: ${INSTALL_LOG_FILE}`);
    }
}

function fail(message) {
    logError(message);
    if (INSTALL_LOG_FILE) {
        logError(`See installer log for details: ${INSTALL_LOG_FILE}`);
    }
    process.exit(1);
}

function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function ensureSupportedNodeVersion() {
    const major = Number.parseInt(String(process.versions.node || "0").split(".")[0] || "0", 10);
    if (!Number.isFinite(major) || major < 22) {
        fail(
            `[install] Node.js ${process.versions.node || "unknown"} is too old. ` +
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

function parseArgs(argv) {
    const options = {
        profile: "",
        stateDir: "",
        agentId: DEFAULT_AGENT_ID,
        pluginId: DEFAULT_PLUGIN_ID,
        openclawBin: "openclaw",
        openclawPackageDir: "",
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
            arg === "--agent" ||
            arg === "--plugin-id" ||
            arg === "--openclaw-bin" ||
            arg === "--log-file" ||
            arg === "--openclaw-package-dir"
        ) {
            const next = argv[index + 1];
            if (!next) {
                fail(`Missing value for ${arg}`);
            }
            if (arg === "--profile") {
                options.profile = next;
            } else if (arg === "--state-dir") {
                options.stateDir = next;
            } else if (arg === "--agent") {
                options.agentId = next;
            } else if (arg === "--plugin-id") {
                options.pluginId = next;
            } else if (arg === "--openclaw-package-dir") {
                options.openclawPackageDir = next;
            } else if (arg === "--log-file") {
                options.logFile = next;
            } else {
                options.openclawBin = next;
            }
            index += 1;
            continue;
        }
        fail(`Unknown option: ${arg}`);
    }

    return options;
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

function summarizeCommand(command, args, cwd) {
    const parts = [command, ...(Array.isArray(args) ? args : [])]
        .map((item) => JSON.stringify(String(item)))
        .join(" ");
    return cwd ? `${parts} (cwd=${cwd})` : parts;
}

function resolveCommandPath(command) {
    const trimmed = typeof command === "string" ? expandHome(command.trim()) : "";
    if (!trimmed) {
        return "";
    }

    const looksLikePath =
        path.isAbsolute(trimmed) ||
        trimmed.includes("/") ||
        trimmed.includes("\\");
    if (looksLikePath) {
        const absolutePath = path.resolve(trimmed);
        if (!fs.existsSync(absolutePath)) {
            return "";
        }
        try {
            return fs.realpathSync(absolutePath);
        } catch {
            return absolutePath;
        }
    }

    const whichCommand = process.platform === "win32" ? "where" : "which";
    const result = runCommand(whichCommand, [trimmed]);
    if (result.error || (result.status ?? 1) !== 0) {
        return "";
    }
    const resolved = extractCliTextLine(result.stdout);
    if (!resolved) {
        return "";
    }
    try {
        return fs.realpathSync(resolved);
    } catch {
        return resolved;
    }
}

function pushCandidateDir(candidates, value) {
    const trimmed = typeof value === "string" ? expandHome(value.trim()) : "";
    if (!trimmed) {
        return;
    }
    const absolutePath = path.resolve(trimmed);
    if (!candidates.includes(absolutePath)) {
        candidates.push(absolutePath);
    }
}

function isOpenclawPackageDir(candidate) {
    if (!candidate || !fs.existsSync(candidate)) {
        return false;
    }
    const packageJsonPath = path.join(candidate, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
        return false;
    }
    try {
        const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
        return manifest?.name === "openclaw";
    } catch {
        return false;
    }
}

function collectOpenclawPackageDirCandidates(options) {
    const candidates = [];

    pushCandidateDir(candidates, options.openclawPackageDir);

    const globalRootCommands = process.platform === "win32" ? ["npm.cmd", "pnpm.cmd"] : ["npm", "pnpm"];
    for (const command of globalRootCommands) {
        const result = runCommand(command, ["root", "-g"]);
        if (result.error || (result.status ?? 1) !== 0) {
            continue;
        }
        const globalRoot = extractCliTextLine(result.stdout);
        if (!globalRoot) {
            continue;
        }
        pushCandidateDir(candidates, path.join(globalRoot, "openclaw"));
    }

    const resolvedBinPath = resolveCommandPath(options.openclawBin);
    if (resolvedBinPath) {
        const binDir = path.dirname(resolvedBinPath);
        const parentDir = path.dirname(binDir);
        if (path.basename(binDir).toLowerCase() === "bin") {
            pushCandidateDir(candidates, parentDir);
        }
        pushCandidateDir(candidates, path.join(parentDir, "lib", "node_modules", "openclaw"));
        pushCandidateDir(candidates, path.join(parentDir, "node_modules", "openclaw"));
    }

    return candidates;
}

function resolveOpenclawPackageDir(options) {
    const candidates = collectOpenclawPackageDirCandidates(options);
    return {
        packageDir: candidates.find((candidate) => isOpenclawPackageDir(candidate)) || "",
        candidates,
    };
}

function listMissingHostRuntimeDependencies(packageDir) {
    const result = runCommand(
        process.execPath,
        [
            "-e",
            `
const { createRequire } = require("module");
const path = require("path");
const req = createRequire(path.join(process.cwd(), "package.json"));
const dependencies = ${JSON.stringify(HOST_RUNTIME_DEPENDENCIES.map((item) => item.name))};
const missing = [];
for (const dependency of dependencies) {
  try {
    req.resolve(dependency);
  } catch {
    missing.push(dependency);
  }
}
process.stdout.write(JSON.stringify(missing));
            `.trim(),
        ],
        { cwd: packageDir }
    );

    if (result.error || (result.status ?? 1) !== 0) {
        fail(
            `[install] Failed to inspect OpenClaw host runtime dependencies in ${packageDir}.${
                result.error ? ` ${result.error.message}` : ""
            }`
        );
    }

    return parseJsonFromCliOutput(result.stdout, []);
}

function ensureOpenclawHostRuntimeDependencies(options) {
    const { packageDir, candidates } = resolveOpenclawPackageDir(options);
    if (!packageDir) {
        fail(
            "[install] Unable to locate the active OpenClaw npm package directory. " +
                "Please pass --openclaw-package-dir DIR and point it at the installed openclaw package.\n" +
                `Candidates checked: ${candidates.length > 0 ? candidates.join(", ") : "<none>"}`
        );
    }
    logInfo(`[install] OpenClaw npm package dir: ${packageDir}`);

    const missingBefore = listMissingHostRuntimeDependencies(packageDir);
    if (!Array.isArray(missingBefore) || missingBefore.length === 0) {
        logInfo("[install] OpenClaw host runtime dependencies already satisfied.");
        return {
            packageDir,
            installed: false,
            missingBefore: [],
        };
    }
    logWarn(
        `[install] Missing host runtime dependencies detected: ${missingBefore.join(", ")}`
    );

    const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
    const installResult = runCommand(
        npmCommand,
        ["install", "--no-save", ...HOST_RUNTIME_DEPENDENCIES.map((item) => item.spec)],
        {
            cwd: packageDir,
            capture: false,
        }
    );

    if (installResult.error) {
        fail(
            `[install] Failed to install OpenClaw host runtime dependencies in ${packageDir}: ` +
                installResult.error.message
        );
    }
    if ((installResult.status ?? 1) !== 0) {
        fail(
            `[install] Failed to install OpenClaw host runtime dependencies in ${packageDir}. ` +
                "If OpenClaw was installed system-wide, rerun the installer with the same owner / permissions as that OpenClaw installation."
        );
    }

    const missingAfter = listMissingHostRuntimeDependencies(packageDir);
    if (Array.isArray(missingAfter) && missingAfter.length > 0) {
        fail(
            `[install] OpenClaw host runtime dependencies are still missing after install: ${missingAfter.join(", ")}`
        );
    }

    return {
        packageDir,
        installed: true,
        missingBefore,
    };
}

function createRunner(options) {
    return function runOpenclaw(args, runOptions = {}) {
        const commandArgs = [];
        if (options.profile) {
            commandArgs.push("--profile", options.profile);
        }
        commandArgs.push(...args);
        const commandSummary = summarizeCommand(
            options.openclawBin,
            commandArgs,
            runOptions.cwd || ""
        );
        logInfo(`[install] Running OpenClaw CLI: ${commandSummary}`);

        const result = spawnSync(options.openclawBin, commandArgs, {
            encoding: "utf8",
            shell: process.platform === "win32",
            env: {
                ...process.env,
                ...(options.stateDir
                    ? { OPENCLAW_STATE_DIR: path.resolve(expandHome(options.stateDir)) }
                    : {}),
            },
            stdio: runOptions.capture === false ? "inherit" : ["ignore", "pipe", "pipe"],
        });

        if (result.error) {
            fail(
                `[install] Failed to run OpenClaw CLI: ${result.error.message}\nCommand: ${commandSummary}`
            );
        }

        if ((result.status ?? 1) !== 0) {
            const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
            fail(
                `[install] OpenClaw command failed: ${commandSummary}${
                    detail ? `\n${detail}` : ""
                }`
            );
        }

        return result;
    };
}

function readJsonFile(filePath) {
    if (!fs.existsSync(filePath)) {
        return {};
    }
    const raw = fs.readFileSync(filePath, "utf8");
    try {
        return JSON.parse(raw);
    } catch {
        if (!cachedJson5) {
            try {
                cachedJson5 = localRequire("json5");
            } catch (error) {
                fail(
                    `[install] Failed to parse OpenClaw config ${filePath}. ` +
                        `The file is not strict JSON, and json5 is unavailable: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        }
        return cachedJson5.parse(raw);
    }
}

function writeJsonFile(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    if (process.platform !== "win32") {
        fs.chmodSync(filePath, 0o600);
    }
}

function uniqueStrings(values) {
    return Array.from(
        new Set(
            values
                .filter((value) => typeof value === "string")
                .map((value) => value.trim())
                .filter(Boolean)
        )
    );
}

function readString(value) {
    if (typeof value !== "string") {
        return "";
    }
    return value.trim();
}

function readStringList(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((item) =>
            typeof item === "number"
                ? String(item)
                : readString(item)
        )
        .filter(Boolean);
}

function readBoolean(value) {
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value === "number") {
        if (value === 1) {
            return true;
        }
        if (value === 0) {
            return false;
        }
        return undefined;
    }
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (!normalized) {
            return undefined;
        }
        if (["1", "true", "yes", "on"].includes(normalized)) {
            return true;
        }
        if (["0", "false", "no", "off"].includes(normalized)) {
            return false;
        }
    }
    return undefined;
}

function collectConfiguredOpenclawChannels(config) {
    const channels = isRecord(config?.channels) ? config.channels : {};
    const configured = [];
    for (const [channelId, channelConfig] of Object.entries(channels)) {
        const normalizedChannelId = readString(channelId).toLowerCase();
        if (!normalizedChannelId || !isRecord(channelConfig)) {
            continue;
        }
        if (readBoolean(channelConfig.enabled) === false) {
            continue;
        }
        configured.push(normalizedChannelId);
    }
    return uniqueStrings(configured);
}

function inferOpenclawNotificationChannel(config, preferredChannel = "") {
    const normalizedPreferred = readString(preferredChannel).toLowerCase();
    if (normalizedPreferred) {
        return normalizedPreferred;
    }
    const configuredChannels = collectConfiguredOpenclawChannels(config);
    return configuredChannels.length === 1 ? configuredChannels[0] : "";
}

function collectOpenclawNotificationTargetsFromNode(value, candidates, depth = 0) {
    if (!isRecord(value)) {
        return;
    }

    for (const item of [
        ...readStringList(value.allowFrom),
        ...readStringList(value.allowUsers),
        ...readStringList(value.allowTargets),
        ...readStringList(value.targets),
    ]) {
        candidates.add(item);
    }

    for (const item of [
        readString(value.target),
        readString(value.to),
        readString(value.chatId),
        readString(value.userId),
        readString(value.channelId),
        readString(value.roomId),
        readString(value.threadId),
        readString(value.recipient),
        readString(value.conversationId),
        readString(value.peerId),
    ].filter(Boolean)) {
        candidates.add(item);
    }

    if (depth >= 2) {
        return;
    }

    for (const nested of Object.values(value)) {
        if (isRecord(nested)) {
            collectOpenclawNotificationTargetsFromNode(nested, candidates, depth + 1);
        }
    }
}

function collectOpenclawNotificationTargets(config, channel) {
    const normalizedChannel = inferOpenclawNotificationChannel(config, channel);
    if (!normalizedChannel) {
        return [];
    }
    const channelsConfig = isRecord(config?.channels) ? config.channels : {};
    const channelConfig = isRecord(channelsConfig[normalizedChannel])
        ? channelsConfig[normalizedChannel]
        : null;
    if (!channelConfig) {
        return [];
    }

    const targets = new Set();
    collectOpenclawNotificationTargetsFromNode(channelConfig, targets);
    return Array.from(targets);
}

function inferOpenclawNotificationTarget(config, channel) {
    const targets = collectOpenclawNotificationTargets(config, channel);
    return targets.length === 1 ? targets[0] : "";
}

function stripAnsi(value) {
    return String(value || "").replace(/\u001b\[[0-9;]*m/g, "");
}

function extractCliTextLine(value) {
    const normalized = stripAnsi(value)
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean);
    return normalized.length > 0 ? normalized[normalized.length - 1] : "";
}

function parseJsonFromCliOutput(value, fallback) {
    const raw = stripAnsi(value).trim();
    if (!raw) {
        return fallback;
    }

    const starts = [];
    for (let index = 0; index < raw.length; index += 1) {
        const char = raw[index];
        if (char === "{" || char === "[") {
            starts.push(index);
        }
    }

    const candidates = [raw, ...starts.reverse().map((index) => raw.slice(index))];
    for (const candidate of candidates) {
        try {
            return JSON.parse(candidate);
        } catch {
            // Keep scanning for the real JSON payload.
        }
    }

    return fallback;
}

function deriveDedicatedWorkspace(mainWorkspace, agentId, existingWorkspace) {
    const trimmedExisting =
        typeof existingWorkspace === "string" ? existingWorkspace.trim() : "";
    const trimmedMain =
        typeof mainWorkspace === "string" ? mainWorkspace.trim() : "";

    if (trimmedExisting && trimmedExisting !== trimmedMain) {
        return trimmedExisting;
    }

    const baseWorkspace =
        trimmedMain || path.join(os.homedir(), ".openclaw", "workspace");
    const dirName = path.dirname(baseWorkspace);
    const baseName = path.basename(baseWorkspace);
    const suffix = `-${agentId}`;

    return baseName.endsWith(suffix)
        ? baseWorkspace
        : path.join(dirName, `${baseName}${suffix}`);
}

function normalizeWorkspaceFileContent(value) {
    return typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : "";
}

function loadOpenclawOfficialWorkspaceTemplates(packageDir) {
    const templates = {};
    const trimmedPackageDir = typeof packageDir === "string" ? packageDir.trim() : "";
    if (!trimmedPackageDir) {
        return templates;
    }

    const templateDir = path.join(trimmedPackageDir, "docs", "reference", "templates");
    if (!fs.existsSync(templateDir)) {
        logWarn(
            `[install] OpenClaw template directory not found, skipping template migration: ${templateDir}`
        );
        return templates;
    }

    for (const name of PLUGIN_MANAGED_WORKSPACE_FILENAMES) {
        const filePath = path.join(templateDir, name);
        if (!fs.existsSync(filePath)) {
            continue;
        }
        try {
            templates[name] = fs.readFileSync(filePath, "utf8");
        } catch (error) {
            logWarn(
                `[install] Failed to read OpenClaw template ${filePath}: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
        }
    }

    return templates;
}

function buildWorkspaceReplacementCandidates(name, content, officialTemplates) {
    const candidates = [];
    if (typeof content === "string") {
        candidates.push(content);
    }

    const legacyContent = LEGACY_LIGHTWEIGHT_WORKSPACE_FILES[name];
    if (Array.isArray(legacyContent)) {
        candidates.push(...legacyContent);
    } else if (typeof legacyContent === "string") {
        candidates.push(legacyContent);
    }

    const obsoleteContent = OBSOLETE_LIGHTWEIGHT_WORKSPACE_FILES[name];
    if (Array.isArray(obsoleteContent)) {
        candidates.push(...obsoleteContent);
    } else if (typeof obsoleteContent === "string") {
        candidates.push(obsoleteContent);
    }

    if (typeof officialTemplates[name] === "string") {
        candidates.push(officialTemplates[name]);
    }

    return uniqueStrings(
        candidates
            .map((item) => normalizeWorkspaceFileContent(item))
            .filter(Boolean)
    );
}

function shouldReplaceManagedWorkspaceFile(existingContent, replaceCandidates) {
    const normalizedExisting = normalizeWorkspaceFileContent(existingContent);
    if (!normalizedExisting) {
        return true;
    }
    return replaceCandidates.includes(normalizedExisting);
}

function ensureWorkspaceScaffold(workspacePath, options = {}) {
    const officialTemplates = loadOpenclawOfficialWorkspaceTemplates(options.openclawPackageDir);
    fs.mkdirSync(workspacePath, { recursive: true });
    for (const [name, legacyContents] of Object.entries(OBSOLETE_LIGHTWEIGHT_WORKSPACE_FILES)) {
        const filePath = path.join(workspacePath, name);
        if (!fs.existsSync(filePath)) {
            continue;
        }
        const existing = fs.readFileSync(filePath, "utf8");
        const removeCandidates = buildWorkspaceReplacementCandidates(
            name,
            "",
            officialTemplates
        );
        if (
            legacyContents.some((candidate) => existing === candidate) ||
            shouldReplaceManagedWorkspaceFile(existing, removeCandidates)
        ) {
            fs.rmSync(filePath, { force: true });
            logInfo(`[install] Removed plugin-disabled workspace template: ${filePath}`);
        }
    }
    for (const [name, content] of Object.entries(LIGHTWEIGHT_WORKSPACE_FILES)) {
        const filePath = path.join(workspacePath, name);
        if (fs.existsSync(filePath)) {
            const existing = fs.readFileSync(filePath, "utf8");
            const replaceCandidates = buildWorkspaceReplacementCandidates(
                name,
                content,
                officialTemplates
            );
            if (shouldReplaceManagedWorkspaceFile(existing, replaceCandidates)) {
                fs.writeFileSync(filePath, content, "utf8");
                logInfo(`[install] Updated managed workspace template: ${filePath}`);
            }
            continue;
        }
        fs.writeFileSync(filePath, content, "utf8");
        logInfo(`[install] Created managed workspace template: ${filePath}`);
    }
}

function resolveWorkspacePromptFile(workspacePath) {
    return path.join(workspacePath, WORKSPACE_PROMPT_FILENAME);
}

function syncWorkspacePrompt(workspacePath, desiredPrompt, replaceCandidates = []) {
    const filePath = resolveWorkspacePromptFile(workspacePath);
    const normalizedDesired = normalizeAgentSystemPrompt(desiredPrompt, true);
    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
    const normalizedExisting = normalizeAgentSystemPrompt(existing, false);
    const normalizedReplaceCandidates = uniqueStrings(
        [
            LIGHTWEIGHT_WORKSPACE_FILES[WORKSPACE_PROMPT_FILENAME],
            ...replaceCandidates,
        ]
            .map((item) => normalizeAgentSystemPrompt(item, false))
            .filter(Boolean)
    );
    const shouldReplace =
        !normalizedExisting ||
        normalizedExisting === normalizedDesired ||
        normalizedReplaceCandidates.includes(normalizedExisting);
    if (shouldReplace) {
        fs.writeFileSync(filePath, normalizedDesired, "utf8");
    }
    return {
        filePath,
        prompt: shouldReplace ? normalizedDesired : normalizedExisting || normalizedDesired,
        replaced: shouldReplace,
    };
}

function pickDedicatedToolAllow(existingAllow, pluginId) {
    const preserved = Array.isArray(existingAllow)
        ? existingAllow.filter(
            (item) =>
                typeof item === "string" &&
                (item === pluginId || item.trim().startsWith("xiaoai_"))
        )
        : [];
    return uniqueStrings([...REQUIRED_XIAOAI_TOOLS, ...preserved]);
}

function findAgentIndex(agentList, agentId) {
    return Array.isArray(agentList)
        ? agentList.findIndex((agent) => agent?.id === agentId)
        : -1;
}

function summarizeAgentConfig(agent) {
    const tools = isRecord(agent?.tools) ? agent.tools : {};
    return {
        id: typeof agent?.id === "string" ? agent.id : "",
        workspace: typeof agent?.workspace === "string" ? agent.workspace : "",
        model: typeof agent?.model === "string" ? agent.model : "",
        workspacePromptFile:
            typeof agent?.workspace === "string" && agent.workspace.trim()
                ? resolveWorkspacePromptFile(agent.workspace.trim())
                : "",
        tools: {
            profile: typeof tools.profile === "string" ? tools.profile : "",
            allow: Array.isArray(tools.allow)
                ? tools.allow.filter((item) => typeof item === "string")
                : [],
        },
    };
}

function resolveConfiguredModelRef(value) {
    if (typeof value === "string" && value.trim()) {
        return value.trim();
    }
    if (isRecord(value) && typeof value.primary === "string" && value.primary.trim()) {
        return value.primary.trim();
    }
    return "";
}

function unwrapLegacySystemPrompt(value) {
    if (typeof value !== "string") {
        return "";
    }
    const trimmed = value.replace(/\r\n?/g, "\n").trim();
    if (!trimmed) {
        return "";
    }
    const matched = trimmed.match(/^\[?\s*系统要求[:：]\s*([\s\S]*?)\s*\]?$/u);
    return (matched?.[1] || trimmed).trim();
}

function normalizeAgentSystemPrompt(value, fallbackToDefault = true) {
    const normalized = unwrapLegacySystemPrompt(value);
    if (normalized) {
        return normalized;
    }
    return fallbackToDefault ? DEFAULT_XIAOAI_AGENT_SYSTEM_PROMPT : "";
}

function determineDesiredAgent(pluginEntry, pluginId, fallbackAgentId) {
    const staleKey = `"${pluginId}"`;
    const staleConfig = isRecord(pluginEntry.entries[staleKey]?.config)
        ? pluginEntry.entries[staleKey].config
        : {};
    const currentConfig = isRecord(pluginEntry.entries[pluginId]?.config)
        ? pluginEntry.entries[pluginId].config
        : {};
    const mergedConfig = {
        ...staleConfig,
        ...currentConfig,
    };
    const configuredAgent =
        typeof mergedConfig.openclawAgent === "string" ? mergedConfig.openclawAgent.trim() : "";
    return {
        staleKey,
        mergedConfig,
        desiredAgentId:
            configuredAgent && configuredAgent !== "main" ? configuredAgent : fallbackAgentId,
    };
}

function ensureAgent(runOpenclaw, agentId, workspacePath, modelId) {
    const agents = parseJsonFromCliOutput(
        runOpenclaw(["agents", "list", "--json"]).stdout,
        []
    );
    if (Array.isArray(agents) && agents.some((agent) => agent?.id === agentId)) {
        return { created: false, agents };
    }

    const addArgs = ["agents", "add", agentId, "--workspace", String(workspacePath), "--non-interactive"];
    if (modelId) {
        addArgs.push("--model", String(modelId));
    }
    runOpenclaw(addArgs, { capture: false });

    return { created: true, agents };
}

function derivePrimaryWorkspace(mainWorkspace) {
    const trimmedMain =
        typeof mainWorkspace === "string" ? mainWorkspace.trim() : "";
    return trimmedMain || path.join(os.homedir(), ".openclaw", "workspace");
}

function buildPrimaryAgentConfig(
    configMainAgent,
    listedMainAgent,
    agentsConfig,
    desiredModel
) {
    const workspace = derivePrimaryWorkspace(
        typeof configMainAgent?.workspace === "string"
            ? configMainAgent.workspace
            : typeof listedMainAgent?.workspace === "string"
                ? listedMainAgent.workspace
                : typeof agentsConfig.defaults?.workspace === "string"
                    ? agentsConfig.defaults.workspace
                    : ""
    );
    const model =
        typeof configMainAgent?.model === "string" && configMainAgent.model.trim()
            ? configMainAgent.model.trim()
            : typeof listedMainAgent?.model === "string" && listedMainAgent.model.trim()
                ? listedMainAgent.model.trim()
                : desiredModel;

    const nextAgent = isRecord(configMainAgent) ? { ...configMainAgent } : {};
    nextAgent.id = "main";
    nextAgent.workspace = workspace;
    if (model) {
        nextAgent.model = model;
    }
    delete nextAgent.systemPrompt;
    return nextAgent;
}

function ensureDedicatedAgentDoesNotBecomeDefault(
    agentList,
    desiredAgentId,
    primaryAgentTemplate
) {
    const nextAgentList = Array.isArray(agentList) ? agentList : [];
    const targetIndex = findAgentIndex(nextAgentList, desiredAgentId);
    if (targetIndex >= 0 && isRecord(nextAgentList[targetIndex])) {
        nextAgentList[targetIndex] = {
            ...nextAgentList[targetIndex],
            default: false,
        };
    }

    const existingDefaultIndex = nextAgentList.findIndex(
        (agent) => isRecord(agent) && agent.id !== desiredAgentId && agent.default === true
    );
    if (existingDefaultIndex >= 0) {
        return nextAgentList;
    }

    const primaryAgentIndex = findAgentIndex(nextAgentList, "main");
    if (primaryAgentIndex >= 0 && isRecord(nextAgentList[primaryAgentIndex])) {
        nextAgentList[primaryAgentIndex] = {
            ...nextAgentList[primaryAgentIndex],
            default: true,
        };
        return nextAgentList;
    }

    const fallbackIndex = nextAgentList.findIndex(
        (agent) => isRecord(agent) && agent.id !== desiredAgentId
    );
    if (fallbackIndex >= 0 && isRecord(nextAgentList[fallbackIndex])) {
        nextAgentList[fallbackIndex] = {
            ...nextAgentList[fallbackIndex],
            default: true,
        };
        return nextAgentList;
    }

    nextAgentList.unshift({
        ...primaryAgentTemplate,
        id: "main",
        default: true,
    });
    return nextAgentList;
}

function configureOpenclaw(options) {
    configureLogging(options);
    logInfo(
        `[install] configure-openclaw-install started: profile=${options.profile || "<default>"}, stateDir=${options.stateDir || "<default>"}, agent=${options.agentId}, plugin=${options.pluginId}`
    );
    const runOpenclaw = createRunner(options);
    const hostRuntime = ensureOpenclawHostRuntimeDependencies(options);
    const configFile = expandHome(extractCliTextLine(runOpenclaw(["config", "file"]).stdout));
    if (!configFile) {
        fail("[install] Unable to determine the active OpenClaw config file path.");
    }
    logInfo(`[install] Active OpenClaw config file: ${configFile}`);

    const config = readJsonFile(configFile);
    const plugins = isRecord(config.plugins) ? config.plugins : {};
    const entries = isRecord(plugins.entries) ? plugins.entries : {};
    const agentsConfig = isRecord(config.agents) ? config.agents : {};
    const agentList = Array.isArray(agentsConfig.list) ? agentsConfig.list : [];

    const { staleKey, mergedConfig, desiredAgentId } = determineDesiredAgent(
        { entries },
        options.pluginId,
        options.agentId
    );

    const listedAgents = parseJsonFromCliOutput(
        runOpenclaw(["agents", "list", "--json"]).stdout,
        []
    );
    const listedMainAgent =
        (Array.isArray(listedAgents)
            ? listedAgents.find((agent) => agent?.id === "main")
            : undefined) ||
        (Array.isArray(listedAgents) ? listedAgents[0] : undefined);
    const listedTargetAgent = Array.isArray(listedAgents)
        ? listedAgents.find((agent) => agent?.id === desiredAgentId)
        : undefined;
    const configTargetAgent = agentList.find((agent) => agent?.id === desiredAgentId);
    const configMainAgent = agentList.find((agent) => agent?.id === "main");
    const desiredModel =
        resolveConfiguredModelRef(agentsConfig.defaults?.model) ||
        (typeof configMainAgent?.model === "string" ? configMainAgent.model : "") ||
        (typeof listedMainAgent?.model === "string" ? listedMainAgent.model : "") ||
        (typeof configTargetAgent?.model === "string" ? configTargetAgent.model : "") ||
        (typeof listedTargetAgent?.model === "string" ? listedTargetAgent.model : "");

    const desiredWorkspace = deriveDedicatedWorkspace(
        typeof listedMainAgent?.workspace === "string"
            ? listedMainAgent.workspace
            : typeof agentsConfig.defaults?.workspace === "string"
                ? agentsConfig.defaults.workspace
                : "",
        desiredAgentId,
        typeof configTargetAgent?.workspace === "string"
            ? configTargetAgent.workspace
            : typeof listedTargetAgent?.workspace === "string"
                ? listedTargetAgent.workspace
                : ""
    );
    ensureWorkspaceScaffold(desiredWorkspace, {
        openclawPackageDir: hostRuntime.packageDir,
    });
    logInfo(`[install] Dedicated workspace: ${desiredWorkspace}`);

    const { created } = ensureAgent(
        runOpenclaw,
        desiredAgentId,
        desiredWorkspace,
        desiredModel
    );
    logInfo(
        `[install] Dedicated agent ${created ? "created" : "already exists"}: ${desiredAgentId}`
    );

    const nextConfig = isRecord(config) ? { ...config } : {};
    const nextPlugins = isRecord(nextConfig.plugins) ? { ...nextConfig.plugins } : {};
    const nextEntries = isRecord(nextPlugins.entries) ? { ...nextPlugins.entries } : {};
    const nextAgents = isRecord(nextConfig.agents) ? { ...nextConfig.agents } : {};
    const nextAgentList = Array.isArray(nextAgents.list)
        ? nextAgents.list.map((item) => {
              const nextItem = { ...item };
              delete nextItem.systemPrompt;
              return nextItem;
          })
        : [];
    const nextTools = isRecord(nextConfig.tools) ? { ...nextConfig.tools } : {};
    const previousEntry = isRecord(nextEntries[options.pluginId]) ? { ...nextEntries[options.pluginId] } : {};
    const nextPluginConfig = isRecord(previousEntry.config)
        ? { ...previousEntry.config }
        : {};
    const inferredOpenclawChannel = inferOpenclawNotificationChannel(config);
    const resolvedOpenclawChannel =
        readString(nextPluginConfig.openclawChannel || mergedConfig.openclawChannel) ||
        inferredOpenclawChannel ||
        "telegram";
    const inferredOpenclawTo =
        readString(nextPluginConfig.openclawTo || mergedConfig.openclawTo) ||
        inferOpenclawNotificationTarget(config, resolvedOpenclawChannel);
    if (
        !readString(nextPluginConfig.openclawChannel || mergedConfig.openclawChannel) &&
        !inferredOpenclawChannel
    ) {
        logWarn(
            `[install] Unable to uniquely infer the OpenClaw notification channel. ` +
                `Falling back to "${resolvedOpenclawChannel}". ` +
                "If your active channel is not telegram, confirm openclawChannel/openclawTo in the control UI."
        );
    }

    Object.assign(nextPluginConfig, mergedConfig);
    if (!nextPluginConfig.openclawAgent || nextPluginConfig.openclawAgent === "main") {
        nextPluginConfig.openclawAgent = desiredAgentId;
    }
    nextPluginConfig.openclawChannel = resolvedOpenclawChannel;
    if (inferredOpenclawTo) {
        nextPluginConfig.openclawTo = inferredOpenclawTo;
    }

    previousEntry.enabled = true;
    previousEntry.config = nextPluginConfig;
    nextEntries[options.pluginId] = previousEntry;
    delete nextEntries[staleKey];

    const targetAgentIndex = findAgentIndex(nextAgentList, desiredAgentId);
    const configAgentCreated = targetAgentIndex < 0;
    const previousAgent =
        targetAgentIndex >= 0 && isRecord(nextAgentList[targetAgentIndex])
            ? { ...nextAgentList[targetAgentIndex] }
            : {};
    const previousTools = isRecord(previousAgent.tools) ? { ...previousAgent.tools } : {};
    const previousAgentSystemPrompt =
        typeof previousAgent.systemPrompt === "string" ? previousAgent.systemPrompt : "";

    previousAgent.id = desiredAgentId;
    previousAgent.workspace = desiredWorkspace;
    if (desiredModel) {
        previousAgent.model = desiredModel;
    }
    syncWorkspacePrompt(
        desiredWorkspace,
        previousAgentSystemPrompt ||
            nextPluginConfig.openclawVoiceSystemPrompt ||
            mergedConfig.openclawVoiceSystemPrompt,
        [
            previousAgentSystemPrompt,
            nextPluginConfig.openclawVoiceSystemPrompt,
            mergedConfig.openclawVoiceSystemPrompt,
        ]
    );
    delete previousAgent.systemPrompt;
    previousAgent.tools = {
        ...previousTools,
        profile: "minimal",
        allow: pickDedicatedToolAllow(previousTools.allow, options.pluginId),
    };
    if (targetAgentIndex >= 0) {
        nextAgentList[targetAgentIndex] = previousAgent;
    } else {
        nextAgentList.push(previousAgent);
    }
    ensureDedicatedAgentDoesNotBecomeDefault(
        nextAgentList,
        desiredAgentId,
        buildPrimaryAgentConfig(
            configMainAgent,
            listedMainAgent,
            agentsConfig,
            desiredModel
        )
    );

    const allow = Array.isArray(nextPlugins.allow)
        ? nextPlugins.allow.filter((item) => typeof item === "string" && item.trim().length > 0)
        : [];
    if (!allow.includes(options.pluginId)) {
        allow.push(options.pluginId);
    }

    const alsoAllow = uniqueStrings([
        ...(Array.isArray(nextTools.alsoAllow)
            ? nextTools.alsoAllow.filter(
                (item) => typeof item === "string" && item.trim().length > 0
            )
            : []),
        ...REQUIRED_XIAOAI_TOOLS,
    ]);

    nextPlugins.entries = nextEntries;
    nextPlugins.allow = allow;
    nextConfig.plugins = nextPlugins;
    nextAgents.list = nextAgentList;
    nextConfig.agents = nextAgents;
    nextTools.alsoAllow = alsoAllow;
    nextConfig.tools = nextTools;
    writeJsonFile(configFile, nextConfig);
    logInfo(`[install] Wrote updated OpenClaw config: ${configFile}`);

    const verifiedConfig = readJsonFile(configFile);
    const verifiedPlugins = isRecord(verifiedConfig.plugins) ? verifiedConfig.plugins : {};
    const verifiedEntries = isRecord(verifiedPlugins.entries) ? verifiedPlugins.entries : {};
    const verifiedAgentList = Array.isArray(verifiedConfig?.agents?.list)
        ? verifiedConfig.agents.list
        : [];
    const verifiedAgentIndex = findAgentIndex(verifiedAgentList, desiredAgentId);
    const verifiedPluginConfig = isRecord(verifiedEntries[options.pluginId]?.config)
        ? verifiedEntries[options.pluginId].config
        : {};
    const verifiedPluginAgent =
        typeof verifiedPluginConfig.openclawAgent === "string"
            ? verifiedPluginConfig.openclawAgent.trim()
            : "";
    const verifiedAgent = verifiedAgentList[verifiedAgentIndex];

    if (verifiedAgentIndex < 0) {
        fail(
            `[install] Dedicated agent config verification failed for "${desiredAgentId}". ` +
                "OpenClaw 官方配置把 agent 存在 agents.list[] 里，而不是 agents.<id>。"
        );
    }
    if (verifiedPluginAgent !== desiredAgentId) {
        fail(
            `[install] Plugin config verification failed for "${options.pluginId}". ` +
                `Expected openclawAgent=${desiredAgentId}, got ${verifiedPluginAgent || "<empty>"}.`
        );
    }
    if (desiredModel && verifiedAgent?.model !== desiredModel) {
        fail(
            `[install] Dedicated agent model sync failed for "${desiredAgentId}". ` +
                `Expected ${desiredModel}, got ${verifiedAgent?.model || "<empty>"}.`
        );
    }

    console.log(
        JSON.stringify(
            {
                configFile,
                pluginId: options.pluginId,
                agentId: desiredAgentId,
                workspace: desiredWorkspace,
                createdAgent: created,
                createdAgentMeaning: created
                    ? "OpenClaw CLI 新建了专属 agent。"
                    : "OpenClaw CLI 里已存在这个 agent；本次安装只做配置校正与回写。",
                configAgentCreated,
                configAgentPath: `agents.list[${verifiedAgentIndex}]`,
                configAgentVerified: summarizeAgentConfig(verifiedAgent),
                pluginConfigPath: `plugins.entries.${options.pluginId}.config.openclawAgent`,
                formatNote:
                    "OpenClaw 官方配置里的 agent 不是 agents.<id>，而是写在 agents.list[]。",
                updatedPluginConfig: {
                    openclawAgent: nextPluginConfig.openclawAgent,
                    openclawChannel: nextPluginConfig.openclawChannel,
                    openclawTo: nextPluginConfig.openclawTo || "",
                },
                updatedAgentConfig: {
                    model: previousAgent.model,
                    profile: previousAgent.tools.profile,
                    allow: previousAgent.tools.allow,
                },
                updatedGlobalTools: {
                    alsoAllow,
                },
                hostRuntime,
                allow,
            },
            null,
            2
        )
    );
    logInfo("[install] configure-openclaw-install completed successfully.");
}

ensureSupportedNodeVersion();
configureOpenclaw(parseArgs(process.argv.slice(2)));
