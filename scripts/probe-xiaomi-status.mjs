import fs from "fs";
import path from "path";
import {
    MiIOClient,
    MiNAClient,
    MiotSpecClient,
    XiaomiAccountClient,
    pickSpeakerFeatures,
} from "../dist/src/xiaomi-client.js";

const DEFAULT_PROFILE_PATH = process.env.XIAOAI_PROFILE_PATH ||
    "/root/.openclaw/plugins/xiaoai-cloud/profile.json";
const DEFAULT_MEDIA_CANDIDATES = ["default", "app_ios", "common", "soundbox", "mibrain"];
const DEFAULT_TIMELINE_DURATION_MS = 6000;
const DEFAULT_TIMELINE_INTERVAL_MS = 180;

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function parseArgs(argv) {
    const options = {
        mode: "snapshot",
        medias: DEFAULT_MEDIA_CANDIDATES.slice(),
        durationMs: DEFAULT_TIMELINE_DURATION_MS,
        intervalMs: DEFAULT_TIMELINE_INTERVAL_MS,
        command: "",
        profilePath: DEFAULT_PROFILE_PATH,
        propsLimit: 18,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith("--")) {
            continue;
        }
        const key = token.slice(2);
        const next = argv[index + 1];
        switch (key) {
            case "mode":
                if (next) {
                    options.mode = next === "timeline" ? "timeline" : "snapshot";
                    index += 1;
                }
                break;
            case "command":
                options.command = next || "";
                index += 1;
                break;
            case "duration-ms":
                options.durationMs = Math.max(1000, readNumber(next) || DEFAULT_TIMELINE_DURATION_MS);
                index += 1;
                break;
            case "interval-ms":
                options.intervalMs = Math.max(60, readNumber(next) || DEFAULT_TIMELINE_INTERVAL_MS);
                index += 1;
                break;
            case "profile":
                options.profilePath = next || DEFAULT_PROFILE_PATH;
                index += 1;
                break;
            case "medias":
                options.medias = String(next || "")
                    .split(",")
                    .map((item) => item.trim())
                    .filter(Boolean);
                if (options.medias.length === 0) {
                    options.medias = DEFAULT_MEDIA_CANDIDATES.slice();
                }
                index += 1;
                break;
            case "props-limit":
                options.propsLimit = Math.max(1, readNumber(next) || options.propsLimit);
                index += 1;
                break;
            default:
                break;
        }
    }

    return options;
}

function simplifyMinaStatus(response) {
    const raw = response?.data?.info;
    let parsed = raw;
    if (typeof raw === "string") {
        try {
            parsed = JSON.parse(raw);
        } catch {
            parsed = undefined;
        }
    }
    return {
        code: response?.code,
        responseCode: response?.data?.code,
        status: parsed?.status,
        volume: parsed?.volume,
        loopType: parsed?.loop_type,
        mediaType: parsed?.media_type,
        audioId: parsed?.play_song_detail?.audio_id,
        position: parsed?.play_song_detail?.position,
        duration: parsed?.play_song_detail?.duration,
        trackList: Array.isArray(parsed?.track_list) ? parsed.track_list.slice(0, 6) : [],
    };
}

function simplifyMiotResult(result) {
    return {
        did: String(result?.did || ""),
        siid: readNumber(result?.siid),
        piid: readNumber(result?.piid),
        value: result?.value,
        code: readNumber(result?.code),
        updateTime: readNumber(result?.updateTime),
    };
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeProp(prop) {
    const type = readString(prop?.type) || "";
    const description = readString(prop?.description) || "";
    const access = Array.isArray(prop?.access) ? prop.access.filter(Boolean) : [];
    return {
        siid: readNumber(prop?.siid),
        piid: readNumber(prop?.piid),
        service: readString(prop?.serviceDescription) || "",
        serviceType: readString(prop?.serviceType) || "",
        type,
        description,
        access,
    };
}

function collectReadableProps(spec, limit) {
    const props = [];
    for (const service of spec?.services || []) {
        for (const property of service.properties || []) {
            const access = Array.isArray(property.access) ? property.access : [];
            if (!access.includes("read")) {
                continue;
            }
            props.push({
                siid: service.iid,
                piid: property.iid,
                serviceDescription: service.description,
                serviceType: service.type,
                type: property.type,
                description: property.description,
                access,
            });
        }
    }
    return props.slice(0, limit);
}

async function buildRuntimeContext(profilePath) {
    const profile = readJson(profilePath);
    const account = new XiaomiAccountClient({
        username: profile.account,
        tokenStorePath: profile.tokenStorePath,
        debugLogEnabled: false,
    });
    await account.loadTokenStore();

    const mina = new MiNAClient(account);
    const miio = new MiIOClient(account, profile.serverCountry || "cn");
    const specClient = new MiotSpecClient();
    const model = readString(profile.model) || "xiaomi.wifispeaker.l05c";
    const spec = await specClient.getSpecForModel(model).catch(() => null);
    const speakerFeatures = pickSpeakerFeatures(spec);

    return {
        profile,
        mina,
        miio,
        spec,
        speakerFeatures,
        deviceId: String(profile.minaDeviceId || ""),
        miDid: String(profile.miDid || ""),
    };
}

async function collectSnapshot(context, options) {
    const { profile, mina, miio, spec, speakerFeatures, deviceId, miDid } = context;
    const readableProps = collectReadableProps(spec, options.propsLimit);
    const minaStatuses = {};
    for (const mediaName of options.medias) {
        const normalizedMedia = mediaName === "default" ? undefined : mediaName;
        try {
            const result = await mina.playerGetStatus(
                deviceId,
                normalizedMedia ? { media: normalizedMedia } : undefined
            );
            minaStatuses[mediaName] = simplifyMinaStatus(result);
        } catch (error) {
            minaStatuses[mediaName] = {
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    let miotProps = [];
    if (readableProps.length > 0) {
        const results = await miio
            .miotGetProps(
                readableProps.map((item) => ({
                    did: miDid,
                    siid: item.siid,
                    piid: item.piid,
                }))
            )
            .catch(() => []);
        miotProps = readableProps.map((item, index) => ({
            ...describeProp(item),
            result: simplifyMiotResult(results[index]),
        }));
    }

    return {
        generatedAt: new Date().toISOString(),
        profile: {
            account: profile.account,
            serverCountry: profile.serverCountry,
            hardware: profile.hardware,
            speakerName: profile.speakerName,
            minaDeviceId: profile.minaDeviceId,
            miDid: profile.miDid,
        },
        speakerFeatures,
        specSummary: {
            model: readString(profile.model) || "xiaomi.wifispeaker.l05c",
            serviceCount: Array.isArray(spec?.services) ? spec.services.length : 0,
        },
        minaStatuses,
        miotProps,
    };
}

async function executeDirective(context, command) {
    const { miio, miDid, speakerFeatures } = context;
    if (speakerFeatures.executeTextDirective) {
        const action = speakerFeatures.executeTextDirective;
        const args = typeof action.silentPiid === "number" ? [command, false] : [command];
        const result = await miio.miotAction(miDid, action.siid, action.aiid, args);
        if ((readNumber(result?.code) ?? 0) === 0) {
            return result;
        }
    }
    if (speakerFeatures.messageRouterPost) {
        const action = speakerFeatures.messageRouterPost;
        return miio.miotAction(miDid, action.siid, action.aiid, [command]);
    }
    throw new Error("No execute_text_directive or message_router.post action found.");
}

async function collectTimeline(context, options) {
    const base = await collectSnapshot(context, options);
    const readableProps = collectReadableProps(context.spec, Math.min(options.propsLimit, 10));
    const startedAtMs = Date.now();
    const timeline = [];

    const commandResult = await executeDirective(context, options.command);
    const deadlineAtMs = startedAtMs + options.durationMs;

    while (Date.now() <= deadlineAtMs) {
        const nowMs = Date.now();
        const minaStatuses = {};
        for (const mediaName of options.medias) {
            const normalizedMedia = mediaName === "default" ? undefined : mediaName;
            try {
                const result = await context.mina.playerGetStatus(
                    context.deviceId,
                    normalizedMedia ? { media: normalizedMedia } : undefined
                );
                minaStatuses[mediaName] = simplifyMinaStatus(result);
            } catch (error) {
                minaStatuses[mediaName] = {
                    error: error instanceof Error ? error.message : String(error),
                };
            }
        }

        let miotProps = [];
        if (readableProps.length > 0) {
            const results = await context.miio
                .miotGetProps(
                    readableProps.map((item) => ({
                        did: context.miDid,
                        siid: item.siid,
                        piid: item.piid,
                    }))
                )
                .catch(() => []);
            miotProps = readableProps.map((item, index) => ({
                siid: item.siid,
                piid: item.piid,
                description: readString(item.description) || "",
                result: simplifyMiotResult(results[index]),
            }));
        }

        timeline.push({
            elapsedMs: nowMs - startedAtMs,
            minaStatuses,
            miotProps,
        });

        if (Date.now() + options.intervalMs > deadlineAtMs) {
            continue;
        }
        await delay(options.intervalMs);
    }

    return {
        ...base,
        command: options.command,
        commandResult,
        timeline,
    };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const context = await buildRuntimeContext(path.resolve(options.profilePath));
    if (options.mode === "timeline") {
        if (!options.command) {
            throw new Error("Timeline mode requires --command.");
        }
        console.log(JSON.stringify(await collectTimeline(context, options), null, 2));
        return;
    }
    console.log(JSON.stringify(await collectSnapshot(context, options), null, 2));
}

main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
});
