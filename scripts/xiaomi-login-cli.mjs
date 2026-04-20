import fs from "fs/promises";
import path from "path";

const CLOUD_LOGIN_SIDS = ["xiaomiio", "micoapi"];
const DEFAULT_SERVER_COUNTRY = process.env.XIAOAI_SERVER_COUNTRY || "cn";

function readString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseBooleanFlag(token) {
    return token.startsWith("--no-") ? false : true;
}

function parseArgs(argv) {
    const options = {
        command: "login",
        json: false,
        sendCode: false,
        listDevices: true,
        keepSession: false,
        help: false,
        account: readString(process.env.XIAOAI_ACCOUNT),
        password: readString(process.env.XIAOAI_PASSWORD),
        serverCountry: readString(process.env.XIAOAI_SERVER_COUNTRY) || DEFAULT_SERVER_COUNTRY,
        tokenStorePath: readString(process.env.XIAOAI_TOKEN_STORE_PATH),
        sessionFile: readString(process.env.XIAOAI_LOGIN_SESSION_PATH),
        debugLogPath: readString(process.env.XIAOAI_DEBUG_LOG_PATH),
        pythonCommand: readString(process.env.XIAOAI_PYTHON_COMMAND),
        preferredMethod: undefined,
        sid: undefined,
        ticket: undefined,
        stateDir: readString(process.env.OPENCLAW_STATE_DIR),
    };

    let commandResolved = false;
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token) {
            continue;
        }
        if (!token.startsWith("-") && !commandResolved) {
            options.command = token;
            commandResolved = true;
            continue;
        }
        if (token === "-h" || token === "--help") {
            options.help = true;
            continue;
        }
        if (!token.startsWith("--")) {
            continue;
        }

        const [rawKey, inlineValue] = token.slice(2).split("=", 2);
        const isBoolean = inlineValue === undefined && (index + 1 >= argv.length || argv[index + 1]?.startsWith("-"));
        const nextValue = inlineValue ?? (isBoolean ? undefined : argv[index + 1]);
        if (inlineValue === undefined && !isBoolean) {
            index += 1;
        }

        const value = nextValue;
        switch (rawKey) {
            case "json":
            case "no-json":
                options.json = parseBooleanFlag(token);
                break;
            case "send-code":
            case "no-send-code":
                options.sendCode = parseBooleanFlag(token);
                break;
            case "list-devices":
            case "no-list-devices":
                options.listDevices = parseBooleanFlag(token);
                break;
            case "keep-session":
            case "no-keep-session":
                options.keepSession = parseBooleanFlag(token);
                break;
            case "account":
                options.account = readString(value);
                break;
            case "password":
                options.password = readString(value);
                break;
            case "server-country":
                options.serverCountry = readString(value) || DEFAULT_SERVER_COUNTRY;
                break;
            case "token-store":
                options.tokenStorePath = readString(value);
                break;
            case "session-file":
                options.sessionFile = readString(value);
                break;
            case "debug-log":
                options.debugLogPath = readString(value);
                break;
            case "python-command":
                options.pythonCommand = readString(value);
                break;
            case "method":
                options.preferredMethod = readString(value);
                break;
            case "sid":
                options.sid = readString(value);
                break;
            case "ticket":
                options.ticket = readString(value);
                break;
            case "state-dir":
                options.stateDir = readString(value);
                break;
            default:
                break;
        }
    }

    return options;
}

function usageText() {
    return `
XiaoAI CLI 登录调试工具

用法：
  node scripts/xiaomi-login-cli.mjs login --account <账号> --password <密码> [--send-code]
  node scripts/xiaomi-login-cli.mjs send-code --session-file <验证状态文件> [--method phone|email]
  node scripts/xiaomi-login-cli.mjs continue --session-file <验证状态文件> --password <密码> [--ticket <验证码>]
  node scripts/xiaomi-login-cli.mjs refresh --session-file <验证状态文件> [--sid micoapi|xiaomiio|all]

常用参数：
  --account           小米账号，也可用环境变量 XIAOAI_ACCOUNT
  --password          小米密码，也可用环境变量 XIAOAI_PASSWORD
  --server-country    地区，默认 cn
  --token-store       token store 路径，默认按账号和地区自动推导
  --session-file      二次验证状态文件路径，默认与 token store 同目录
  --debug-log         调试日志路径，默认与 token store 同目录
  --method            验证方式，phone 或 email
  --sid               指定要刷新的 sid，支持 micoapi、xiaomiio、all
  --send-code         登录进入二次验证后，直接让服务端发验证码
  --ticket            短信/邮箱验证码
  --no-list-devices   成功后跳过列设备
  --json              以 JSON 输出，方便脚本或 AI 解析

建议：
  1. 先执行 login，若进入二次验证会生成一个 session-file。
  2. 再执行 send-code 触发短信或邮箱验证码。
  3. 最后执行 continue 提交 ticket；如果你已在官方页面完成验证，也可以不带 --ticket 直接继续。
  4. 如果验证码已通过、但某个 sid 补齐失败，可执行 refresh 只刷新缺失的 sid。
`.trim();
}

async function loadSdk() {
    try {
        return await import("../dist/src/xiaomi-client.js");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
            [
                "无法加载 dist/src/xiaomi-client.js。",
                "请先运行 `npm run build`，或者直接使用 `npm run login:cli -- ...`。",
                message,
            ].join("\n")
        );
    }
}

function resolveTokenStorePath(sdk, options) {
    const explicit = readString(options.tokenStorePath);
    if (explicit) {
        return path.resolve(explicit);
    }
    const account = readString(options.account);
    if (!account) {
        throw new Error("缺少账号，无法推导默认 token store 路径。");
    }
    return path.resolve(
        sdk.defaultTokenStorePath(account, options.serverCountry || DEFAULT_SERVER_COUNTRY, options.stateDir)
    );
}

function defaultSessionFilePath(tokenStorePath) {
    const parsed = path.parse(tokenStorePath);
    return path.join(parsed.dir, `${parsed.name}.verification.json`);
}

function defaultDebugLogPath(tokenStorePath) {
    const parsed = path.parse(tokenStorePath);
    return path.join(parsed.dir, `${parsed.name}.login-debug.ndjson`);
}

async function ensureDirForFile(filePath) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function readJsonFile(filePath) {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJsonFile(filePath, payload) {
    await ensureDirForFile(filePath);
    await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function normalizeMethod(method) {
    if (method === "phone" || method === "email") {
        return method;
    }
    return undefined;
}

function normalizeSidSelection(value) {
    const normalized = readString(value)?.toLowerCase();
    if (!normalized) {
        return "all";
    }
    if (normalized === "all") {
        return "all";
    }
    if (normalized === "micoapi" || normalized === "xiaomiio") {
        return normalized;
    }
    throw new Error("`--sid` 只支持 micoapi、xiaomiio 或 all。");
}

function resolveTargetSids(value) {
    const normalized = normalizeSidSelection(value);
    if (normalized === "all") {
        return [...CLOUD_LOGIN_SIDS];
    }
    return [normalized];
}

function summarizeMinaDevices(devices) {
    return Array.isArray(devices)
        ? devices.map((item) => ({
              name: readString(item?.name) || readString(item?.alias) || "unknown",
              alias: readString(item?.alias),
              hardware: readString(item?.hardware),
              deviceId: readString(item?.deviceID),
              miotDid: readString(item?.miotDID ? String(item.miotDID) : undefined),
          }))
        : [];
}

function summarizeMiioDevices(devices) {
    return Array.isArray(devices)
        ? devices.map((item) => ({
              name: readString(item?.name) || "unknown",
              model: readString(item?.model),
              did: readString(item?.did),
              tokenPresent: Boolean(readString(item?.token)),
          }))
        : [];
}

async function collectDeviceSnapshots(sdk, accountClient, region) {
    const mina = new sdk.MiNAClient(accountClient);
    const miio = new sdk.MiIOClient(accountClient, region);
    const [minaResult, miioResult] = await Promise.allSettled([
        mina.deviceList(),
        miio.deviceListFull(),
    ]);

    return {
        mina:
            minaResult.status === "fulfilled"
                ? {
                      ok: true,
                      devices: summarizeMinaDevices(minaResult.value),
                  }
                : {
                      ok: false,
                      error:
                          minaResult.reason instanceof Error
                              ? minaResult.reason.message
                              : String(minaResult.reason),
                  },
        miio:
            miioResult.status === "fulfilled"
                ? {
                      ok: true,
                      devices: summarizeMiioDevices(miioResult.value),
                  }
                : {
                      ok: false,
                      error:
                          miioResult.reason instanceof Error
                              ? miioResult.reason.message
                              : String(miioResult.reason),
                  },
    };
}

function buildSessionPayload(base) {
    return {
        version: 1,
        createdAt: base.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        account: base.account,
        sid: base.sid,
        serverCountry: base.serverCountry,
        tokenStorePath: base.tokenStorePath,
        debugLogPath: base.debugLogPath,
        pythonCommand: base.pythonCommand,
        verifyUrl: base.verifyUrl,
        openUrl: base.openUrl,
        methods: Array.isArray(base.methods) ? base.methods : [],
        verification: base.verification,
    };
}

async function saveVerificationSession(sessionFile, payload) {
    const session = buildSessionPayload(payload);
    await writeJsonFile(sessionFile, session);
    return session;
}

async function loadVerificationSession(sessionFile) {
    const session = await readJsonFile(path.resolve(sessionFile));
    if (!session || typeof session !== "object" || !session.verification || !session.sid) {
        throw new Error("验证状态文件格式无效。");
    }
    return session;
}

async function loadTokenStoreSnapshot(tokenStorePath) {
    try {
        const payload = await readJsonFile(path.resolve(tokenStorePath));
        return payload && typeof payload === "object" ? payload : null;
    } catch {
        return null;
    }
}

function printHumanResult(result) {
    const lines = [];
    if (result.message) {
        lines.push(result.message);
    }
    if (result.command) {
        lines.push(`命令: ${result.command}`);
    }
    if (result.tokenStorePath) {
        lines.push(`token store: ${result.tokenStorePath}`);
    }
    if (result.debugLogPath) {
        lines.push(`调试日志: ${result.debugLogPath}`);
    }
    if (result.sessionFile) {
        lines.push(`验证状态文件: ${result.sessionFile}`);
    }
    if (result.sid) {
        lines.push(`当前 sid: ${result.sid}`);
    }
    if (Array.isArray(result.methods) && result.methods.length > 0) {
        lines.push(`可用验证方式: ${result.methods.join(", ")}`);
    }
    if (result.openUrl) {
        lines.push(`官方验证页面: ${result.openUrl}`);
    } else if (result.verifyUrl) {
        lines.push(`验证地址: ${result.verifyUrl}`);
    }
    if (result.nextSteps && result.nextSteps.length > 0) {
        lines.push("下一步:");
        for (const step of result.nextSteps) {
            lines.push(`  ${step}`);
        }
    }
    if (result.devices?.mina?.ok) {
        lines.push(`MiNA 设备数: ${result.devices.mina.devices.length}`);
    }
    if (result.devices?.miio?.ok) {
        lines.push(`MiIO 设备数: ${result.devices.miio.devices.length}`);
    }
    if (result.devices?.mina?.ok && result.devices.mina.devices.length > 0) {
        for (const item of result.devices.mina.devices.slice(0, 8)) {
            lines.push(`  Mina: ${item.name} | hardware=${item.hardware || "-"} | deviceId=${item.deviceId || "-"}`);
        }
    }
    if (result.devices?.miio?.ok && result.devices.miio.devices.length > 0) {
        for (const item of result.devices.miio.devices.slice(0, 8)) {
            lines.push(`  MiIO: ${item.name} | model=${item.model || "-"} | did=${item.did || "-"}`);
        }
    }
    if (result.devices?.mina && !result.devices.mina.ok) {
        lines.push(`MiNA 列设备失败: ${result.devices.mina.error}`);
    }
    if (result.devices?.miio && !result.devices.miio.ok) {
        lines.push(`MiIO 列设备失败: ${result.devices.miio.error}`);
    }
    console.log(lines.join("\n"));
}

function emitResult(options, result) {
    if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
    }
    printHumanResult(result);
}

async function createAccountClient(sdk, options, account, tokenStorePath, debugLogPath) {
    return new sdk.XiaomiAccountClient({
        username: account,
        password: options.password,
        tokenStorePath,
        debugLogPath,
        debugLogEnabled: Boolean(debugLogPath),
        pythonCommand: options.pythonCommand,
    });
}

async function loginRequiredSids(accountClient, sids = CLOUD_LOGIN_SIDS) {
    for (const sid of sids) {
        await accountClient.login(sid);
    }
}

async function continueVerification(sdk, accountClient, sid, ticket) {
    const trimmedTicket = readString(ticket);
    if (trimmedTicket) {
        await accountClient.completeVerification(sid, trimmedTicket);
    } else {
        await accountClient.login(sid);
    }
    for (const nextSid of CLOUD_LOGIN_SIDS) {
        if (nextSid === sid) {
            continue;
        }
        await accountClient.login(nextSid);
    }
}

async function enrichVerificationContext(accountClient, preferredMethod) {
    let openUrl;
    let pageMessage;
    try {
        const prepared = await accountClient.prepareVerificationPage(preferredMethod);
        openUrl = readString(prepared?.openUrl);
        pageMessage = readString(prepared?.message);
    } catch (error) {
        pageMessage = error instanceof Error ? error.message : String(error);
    }

    const verification = accountClient.getVerificationState();
    return {
        verification,
        methods: verification?.verifyMethods || [],
        verifyUrl: readString(verification?.verifyUrl),
        openUrl,
        pageMessage,
    };
}

function buildContinueCommand(options, sessionFile, includeTicket = false) {
    const pieces = [
        "npm run login:cli -- continue",
        `--session-file "${sessionFile}"`,
    ];
    if (!options.password) {
        pieces.push("--password <小米密码>");
    }
    if (includeTicket) {
        pieces.push("--ticket <验证码>");
    }
    return pieces.join(" ");
}

function buildRefreshCommand(options, sessionFile, sid = "all") {
    const pieces = [
        "npm run login:cli -- refresh",
        `--session-file "${sessionFile}"`,
    ];
    if (sid && sid !== "all") {
        pieces.push(`--sid ${sid}`);
    }
    if (options.pythonCommand) {
        pieces.push(`--python-command "${options.pythonCommand}"`);
    }
    return pieces.join(" ");
}

function buildPythonInstallCommand(pythonCommand) {
    const explicit = readString(pythonCommand);
    if (explicit) {
        return `${explicit} -m pip install requests`;
    }
    if (process.platform === "win32") {
        return "py -3 -m pip install requests";
    }
    return "python3 -m pip install requests";
}

function shouldSuggestPythonRequestsFix(message) {
    const normalized = String(message || "").toLowerCase();
    return normalized.includes("requests") || normalized.includes("micoapi 登录辅助") || normalized.includes("python");
}

function extractTokenStateSummary(tokenStore) {
    if (!tokenStore || typeof tokenStore !== "object") {
        return undefined;
    }
    return {
        hasPassToken: Boolean(readString(tokenStore.passToken)),
        hasXiaomiio: Boolean(Array.isArray(tokenStore.xiaomiio) && tokenStore.xiaomiio.length >= 2),
        hasMicoapi: Boolean(Array.isArray(tokenStore.micoapi) && tokenStore.micoapi.length >= 2),
    };
}

async function emitStructuredCommandFailure(options, result) {
    emitResult(options, {
        ok: false,
        ...result,
    });
}

async function runLoginCommand(sdk, options) {
    const account = readString(options.account);
    const password = readString(options.password);
    if (!account) {
        throw new Error("login 命令需要 --account 或环境变量 XIAOAI_ACCOUNT。");
    }
    if (!password) {
        throw new Error("login 命令需要 --password 或环境变量 XIAOAI_PASSWORD。");
    }

    const tokenStorePath = resolveTokenStorePath(sdk, options);
    const sessionFile = path.resolve(
        readString(options.sessionFile) || defaultSessionFilePath(tokenStorePath)
    );
    const debugLogPath = path.resolve(
        readString(options.debugLogPath) || defaultDebugLogPath(tokenStorePath)
    );
    const preferredMethod = normalizeMethod(options.preferredMethod);
    const accountClient = await createAccountClient(
        sdk,
        options,
        account,
        tokenStorePath,
        debugLogPath
    );

    await accountClient.resetDebugLog({
        flow: "xiaomi_login_cli",
        account,
        serverCountry: options.serverCountry,
        tokenStorePath,
    });
    await accountClient.invalidateSid("micoapi").catch(() => undefined);
    await accountClient.invalidateSid("xiaomiio").catch(() => undefined);
    await accountClient.clearStoredPassToken().catch(() => undefined);

    try {
        await loginRequiredSids(accountClient);
        const devices = options.listDevices
            ? await collectDeviceSnapshots(sdk, accountClient, options.serverCountry)
            : undefined;
        await fs.rm(sessionFile, { force: true }).catch(() => undefined);
        emitResult(options, {
            ok: true,
            command: "login",
            message: "登录成功，xiaomiio 和 micoapi 登录态已刷新。",
            tokenStorePath,
            debugLogPath,
            devices,
        });
        return;
    } catch (error) {
        if (!(error instanceof sdk.XiaomiVerificationRequiredError)) {
            throw error;
        }

        const context = await enrichVerificationContext(accountClient, preferredMethod);
        const codeRequest = options.sendCode
            ? await accountClient.requestVerificationCode(preferredMethod)
            : null;
        const verification = accountClient.getVerificationState() || error.state;
        const session = await saveVerificationSession(sessionFile, {
            account,
            sid: error.sid,
            serverCountry: options.serverCountry,
            tokenStorePath,
            debugLogPath,
            pythonCommand: options.pythonCommand,
            verifyUrl: context.verifyUrl || error.verifyUrl,
            openUrl: context.openUrl || error.verifyUrl,
            methods: context.methods.length ? context.methods : error.methods,
            verification,
        });

        emitResult(options, {
            ok: false,
            command: "login",
            message: [
                "登录已进入二次验证。",
                codeRequest?.message,
                context.pageMessage && context.pageMessage !== codeRequest?.message
                    ? `页面准备信息: ${context.pageMessage}`
                    : undefined,
            ]
                .filter(Boolean)
                .join("\n"),
            sessionFile,
            sid: session.sid,
            methods: session.methods,
            verifyUrl: session.verifyUrl,
            openUrl: session.openUrl,
            tokenStorePath,
            debugLogPath,
            nextSteps: [
                `发送验证码: npm run login:cli -- send-code --session-file "${sessionFile}"${preferredMethod ? ` --method ${preferredMethod}` : ""}`,
                `提交验证码: ${buildContinueCommand(options, sessionFile, true)}`,
                `官方页面已验证后直接继续: ${buildContinueCommand(options, sessionFile, false)}`,
            ],
        });
    }
}

async function runSendCodeCommand(sdk, options) {
    const preferredMethod = normalizeMethod(options.preferredMethod);
    const sessionFile = readString(options.sessionFile);
    if (!sessionFile) {
        throw new Error("send-code 命令需要 --session-file。");
    }
    const session = await loadVerificationSession(sessionFile);
    const tokenStorePath = path.resolve(session.tokenStorePath);
    const debugLogPath = path.resolve(
        readString(options.debugLogPath) || readString(session.debugLogPath) || defaultDebugLogPath(tokenStorePath)
    );
    const accountClient = new sdk.XiaomiAccountClient({
        username: session.account,
        tokenStorePath,
        debugLogPath,
        debugLogEnabled: Boolean(debugLogPath),
        pythonCommand: readString(options.pythonCommand) || readString(session.pythonCommand),
    });
    accountClient.setVerificationState(session.verification);

    const sendResult = await accountClient.requestVerificationCode(preferredMethod);
    const context = await enrichVerificationContext(accountClient, preferredMethod);
    const nextSession = await saveVerificationSession(path.resolve(sessionFile), {
        ...session,
        sid: session.sid,
        debugLogPath,
        verifyUrl: context.verifyUrl || session.verifyUrl,
        openUrl: context.openUrl || session.openUrl,
        methods: context.methods.length ? context.methods : session.methods,
        verification: accountClient.getVerificationState() || session.verification,
    });

    emitResult(options, {
        ok: true,
        command: "send-code",
        message: sendResult.message,
        sessionFile: path.resolve(sessionFile),
        sid: nextSession.sid,
        methods: nextSession.methods,
        openUrl: nextSession.openUrl,
        verifyUrl: nextSession.verifyUrl,
        debugLogPath,
        nextSteps: [
            `收到验证码后继续: ${buildContinueCommand(options, path.resolve(sessionFile), true)}`,
            `如果你改走官方页面，可完成后执行: ${buildContinueCommand(options, path.resolve(sessionFile), false)}`,
        ],
    });
}

async function runContinueCommand(sdk, options) {
    const sessionFile = readString(options.sessionFile);
    if (!sessionFile) {
        throw new Error("continue 命令需要 --session-file。");
    }
    const password = readString(options.password);
    if (!password) {
        throw new Error("continue 命令需要 --password 或环境变量 XIAOAI_PASSWORD。");
    }

    const session = await loadVerificationSession(sessionFile);
    const tokenStorePath = path.resolve(session.tokenStorePath);
    const debugLogPath = path.resolve(
        readString(options.debugLogPath) || readString(session.debugLogPath) || defaultDebugLogPath(tokenStorePath)
    );
    const accountClient = new sdk.XiaomiAccountClient({
        username: session.account,
        password,
        tokenStorePath,
        debugLogPath,
        debugLogEnabled: Boolean(debugLogPath),
        pythonCommand: readString(options.pythonCommand) || readString(session.pythonCommand),
    });
    accountClient.setVerificationState(session.verification);

    try {
        await continueVerification(sdk, accountClient, session.sid, options.ticket);
        const devices = options.listDevices
            ? await collectDeviceSnapshots(sdk, accountClient, session.serverCountry || options.serverCountry)
            : undefined;
        if (!options.keepSession) {
            await fs.rm(path.resolve(sessionFile), { force: true }).catch(() => undefined);
        }
        emitResult(options, {
            ok: true,
            command: "continue",
            message: readString(options.ticket)
                ? "验证码已提交，登录继续成功。"
                : "已按官方页面状态继续登录成功。",
            tokenStorePath,
            debugLogPath,
            sessionFile: options.keepSession ? path.resolve(sessionFile) : undefined,
            devices,
        });
        return;
    } catch (error) {
        if (!(error instanceof sdk.XiaomiVerificationRequiredError)) {
            const message = error instanceof Error ? error.message : String(error);
            const tokenStore = await loadTokenStoreSnapshot(tokenStorePath);
            const tokenState = extractTokenStateSummary(tokenStore);
            const nextSteps = [];
            if (shouldSuggestPythonRequestsFix(message)) {
                nextSteps.push(`补 Python 依赖: ${buildPythonInstallCommand(readString(options.pythonCommand) || readString(session.pythonCommand))}`);
                nextSteps.push(`补齐缺失 sid: ${buildRefreshCommand(
                    {
                        ...options,
                        pythonCommand: readString(options.pythonCommand) || readString(session.pythonCommand),
                    },
                    path.resolve(sessionFile),
                    tokenState?.hasXiaomiio && !tokenState?.hasMicoapi ? "micoapi" : "all"
                )}`);
            }
            await emitStructuredCommandFailure(options, {
                command: "continue",
                message,
                sessionFile: path.resolve(sessionFile),
                tokenStorePath,
                debugLogPath,
                tokenState,
                nextSteps,
            });
            return;
        }

        const preferredMethod = normalizeMethod(options.preferredMethod);
        const context = await enrichVerificationContext(accountClient, preferredMethod);
        const updatedSession = await saveVerificationSession(path.resolve(sessionFile), {
            ...session,
            sid: error.sid,
            debugLogPath,
            verifyUrl: context.verifyUrl || error.verifyUrl,
            openUrl: context.openUrl || error.verifyUrl,
            methods: context.methods.length ? context.methods : error.methods,
            verification: accountClient.getVerificationState() || error.state,
        });
        emitResult(options, {
            ok: false,
            command: "continue",
            message: readString(options.ticket)
                ? "验证码提交后仍需进一步验证，请按新的验证状态继续。"
                : [
                      "官方验证结果暂时还没有同步到当前登录会话。",
                      "如果页面刚显示 ok，请等待 2-3 秒后再执行一次 continue。",
                  ].join("\n"),
            sessionFile: path.resolve(sessionFile),
            sid: updatedSession.sid,
            methods: updatedSession.methods,
            verifyUrl: updatedSession.verifyUrl,
            openUrl: updatedSession.openUrl,
            debugLogPath,
            nextSteps: [
                `重新发验证码: npm run login:cli -- send-code --session-file "${path.resolve(sessionFile)}"`,
                `再次继续: ${buildContinueCommand(options, path.resolve(sessionFile), Boolean(readString(options.ticket)))}`,
            ],
        });
    }
}

async function runRefreshCommand(sdk, options) {
    const sessionFile = readString(options.sessionFile);
    const session = sessionFile ? await loadVerificationSession(sessionFile) : null;
    const account = readString(options.account) || readString(session?.account);
    if (!account) {
        throw new Error("refresh 命令需要 --account，或通过 --session-file 提供账号信息。");
    }

    const tokenStorePath = session
        ? path.resolve(session.tokenStorePath)
        : resolveTokenStorePath(sdk, options);
    const debugLogPath = path.resolve(
        readString(options.debugLogPath) ||
            readString(session?.debugLogPath) ||
            defaultDebugLogPath(tokenStorePath)
    );
    const pythonCommand = readString(options.pythonCommand) || readString(session?.pythonCommand);
    const region = readString(session?.serverCountry) || options.serverCountry;
    const targetSids = resolveTargetSids(options.sid);
    const accountClient = new sdk.XiaomiAccountClient({
        username: account,
        password: options.password,
        tokenStorePath,
        debugLogPath,
        debugLogEnabled: Boolean(debugLogPath),
        pythonCommand,
    });

    try {
        await loginRequiredSids(accountClient, targetSids);
        const devices = options.listDevices
            ? await collectDeviceSnapshots(sdk, accountClient, region)
            : undefined;
        emitResult(options, {
            ok: true,
            command: "refresh",
            message:
                targetSids.length === CLOUD_LOGIN_SIDS.length
                    ? "现有 token store 的 sid 已全部刷新完成。"
                    : `已刷新 ${targetSids.join(", ")} 登录态。`,
            tokenStorePath,
            debugLogPath,
            sessionFile: sessionFile ? path.resolve(sessionFile) : undefined,
            devices,
        });
        return;
    } catch (error) {
        if (error instanceof sdk.XiaomiVerificationRequiredError) {
            const preferredMethod = normalizeMethod(options.preferredMethod);
            const context = await enrichVerificationContext(accountClient, preferredMethod);
            const codeRequest = options.sendCode
                ? await accountClient.requestVerificationCode(preferredMethod)
                : null;
            const nextSessionFile = path.resolve(
                sessionFile || defaultSessionFilePath(tokenStorePath)
            );
            const nextSession = await saveVerificationSession(nextSessionFile, {
                createdAt: session?.createdAt,
                account,
                sid: error.sid,
                serverCountry: region,
                tokenStorePath,
                debugLogPath,
                pythonCommand,
                verifyUrl: context.verifyUrl || error.verifyUrl,
                openUrl: context.openUrl || error.verifyUrl,
                methods: context.methods.length ? context.methods : error.methods,
                verification: accountClient.getVerificationState() || error.state,
            });
            emitResult(options, {
                ok: false,
                command: "refresh",
                message: [
                    "刷新登录态时再次进入二次验证。",
                    codeRequest?.message,
                ]
                    .filter(Boolean)
                    .join("\n"),
                sessionFile: nextSessionFile,
                sid: nextSession.sid,
                methods: nextSession.methods,
                verifyUrl: nextSession.verifyUrl,
                openUrl: nextSession.openUrl,
                tokenStorePath,
                debugLogPath,
                nextSteps: [
                    `发送验证码: npm run login:cli -- send-code --session-file "${nextSessionFile}"`,
                    `提交验证码: ${buildContinueCommand(options, nextSessionFile, true)}`,
                ],
            });
            return;
        }

        const message = error instanceof Error ? error.message : String(error);
        const tokenStore = await loadTokenStoreSnapshot(tokenStorePath);
        const tokenState = extractTokenStateSummary(tokenStore);
        const nextSteps = [];
        if (shouldSuggestPythonRequestsFix(message)) {
            nextSteps.push(`补 Python 依赖: ${buildPythonInstallCommand(pythonCommand)}`);
            nextSteps.push(`依赖补好后重试: ${buildRefreshCommand(
                {
                    ...options,
                    pythonCommand,
                },
                sessionFile ? path.resolve(sessionFile) : defaultSessionFilePath(tokenStorePath),
                normalizeSidSelection(options.sid)
            )}`);
        }
        await emitStructuredCommandFailure(options, {
            command: "refresh",
            message,
            tokenStorePath,
            debugLogPath,
            sessionFile: sessionFile ? path.resolve(sessionFile) : undefined,
            tokenState,
            nextSteps,
        });
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log(usageText());
        return;
    }

    const sdk = await loadSdk();
    switch (options.command) {
        case "login":
            await runLoginCommand(sdk, options);
            return;
        case "send-code":
            await runSendCodeCommand(sdk, options);
            return;
        case "continue":
            await runContinueCommand(sdk, options);
            return;
        case "refresh":
            await runRefreshCommand(sdk, options);
            return;
        default:
            throw new Error(`未知命令：${options.command}\n\n${usageText()}`);
    }
}

main().catch((error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(message);
    process.exitCode = 1;
});
