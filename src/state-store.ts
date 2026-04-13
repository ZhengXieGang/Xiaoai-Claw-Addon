import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { defaultPluginStorageDir } from "./openclaw-paths.js";

export interface PersistedCloudProfile {
    account?: string;
    serverCountry?: string;
    hardware?: string;
    speakerName?: string;
    miDid?: string;
    minaDeviceId?: string;
    tokenStorePath?: string;
    openclawChannel?: string;
    openclawTo?: string;
    openclawNotificationsDisabled?: boolean;
    wakeWordPattern?: string;
    dialogWindowSeconds?: number;
    openclawThinkingOff?: boolean;
    openclawForceNonStreaming?: boolean;
    openclawVoiceSystemPrompt?: string;
    transitionPhrases?: string[];
    debugLogEnabled?: boolean;
    voiceContextMaxTurns?: number;
    voiceContextMaxChars?: number;
    audioTailPaddingMs?: number;
    conversationPollIntervalMs?: number;
    speakerAudioLatencyProfiles?: Record<string, PersistedSpeakerAudioLatencyProfile>;
    lastAudioCalibration?: PersistedAudioCalibrationSummary;
    conversationInterceptLatencyProfiles?: Record<
        string,
        PersistedConversationInterceptLatencyProfile
    >;
    lastConversationInterceptCalibration?: PersistedConversationInterceptCalibrationSummary;
    updatedAt?: string;
}

export interface PersistedSpeakerAudioLatencyProfile {
    statusProbeEstimateMs?: number;
    pauseCommandEstimateMs?: number;
    pauseSettleEstimateMs?: number;
    stopSettleEstimateMs?: number;
    playbackDetectEstimateMs?: number;
    updatedAtMs?: number;
}

export interface PersistedAudioCalibrationSummary {
    deviceId?: string;
    deviceName?: string;
    rounds?: number;
    successCount?: number;
    failureCount?: number;
    tailPaddingMs?: number;
    startedAt?: string;
    completedAt?: string;
    lastError?: string;
    latencyProfile?: PersistedSpeakerAudioLatencyProfile;
}

export interface PersistedConversationInterceptLatencyProfile {
    conversationVisibleEstimateMs?: number;
    nativePlaybackStartEstimateMs?: number;
    interceptLeadEstimateMs?: number;
    manualOffsetMs?: number;
    updatedAtMs?: number;
}

export interface PersistedConversationInterceptCalibrationSummary {
    deviceId?: string;
    deviceName?: string;
    rounds?: number;
    successCount?: number;
    failureCount?: number;
    fallbackRounds?: number;
    strategy?: "observable" | "fallback-only" | "mixed";
    pollIntervalMs?: number;
    recommendedPollIntervalMs?: number;
    startedAt?: string;
    completedAt?: string;
    lastError?: string;
    latencyProfile?: PersistedConversationInterceptLatencyProfile;
}

export interface ConsoleEventEntry {
    id: string;
    time: string;
    kind: string;
    level: "info" | "success" | "warn" | "error";
    title: string;
    detail?: string;
    audioUrl?: string;
}

export interface PersistedSpeakerMuteState {
    mode?: "device" | "soft-volume";
    enabled?: boolean;
    restoreVolumePercent?: number;
    ignoreDeviceMuteReadback?: boolean;
    deviceMuteUnreliable?: boolean;
    softMuteUnreliable?: boolean;
    updatedAt?: string;
}

export interface PersistedConsoleState {
    accessToken?: string;
    events?: ConsoleEventEntry[];
    audioPlaybackClearedAt?: string;
    speakerMuteStates?: Record<string, PersistedSpeakerMuteState>;
    updatedAt?: string;
}

function defaultStateBaseDir(baseStateDir?: string): string {
    return defaultPluginStorageDir(baseStateDir);
}

export function defaultStateStorePath(baseStateDir?: string): string {
    return path.join(defaultStateBaseDir(baseStateDir), "profile.json");
}

export function defaultConsoleStatePath(baseStateDir?: string): string {
    return path.join(defaultStateBaseDir(baseStateDir), "console.json");
}

export async function loadPersistedProfile(filePath: string): Promise<PersistedCloudProfile> {
    try {
        const content = await readFile(filePath, "utf8");
        const parsed = JSON.parse(content) as PersistedCloudProfile;
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

export async function savePersistedProfile(filePath: string, profile: PersistedCloudProfile) {
    const next = {
        ...profile,
        updatedAt: new Date().toISOString()
    };
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(next, null, 2), {
        encoding: "utf8",
        mode: 0o600,
    });
}

export async function loadPersistedConsoleState(
    filePath: string
): Promise<PersistedConsoleState> {
    try {
        const content = await readFile(filePath, "utf8");
        const parsed = JSON.parse(content) as PersistedConsoleState;
        if (!parsed || typeof parsed !== "object") {
            return {};
        }
        return {
            accessToken:
                typeof parsed.accessToken === "string" && parsed.accessToken.trim()
                    ? parsed.accessToken.trim()
                    : undefined,
            events: Array.isArray(parsed.events)
                ? parsed.events
                    .filter((item) => item && typeof item === "object")
                    .map((item) => {
                        const entry = item as ConsoleEventEntry;
                        const audioUrl =
                            typeof entry.audioUrl === "string" ? entry.audioUrl.trim() : "";
                        return {
                            ...item,
                            audioUrl: audioUrl || undefined,
                        };
                    })
                : [],
            audioPlaybackClearedAt:
                typeof parsed.audioPlaybackClearedAt === "string" &&
                parsed.audioPlaybackClearedAt.trim()
                    ? parsed.audioPlaybackClearedAt.trim()
                    : undefined,
            speakerMuteStates:
                parsed.speakerMuteStates &&
                typeof parsed.speakerMuteStates === "object" &&
                !Array.isArray(parsed.speakerMuteStates)
                    ? Object.fromEntries(
                        Object.entries(parsed.speakerMuteStates)
                            .filter(([key]) => typeof key === "string" && key.trim())
                            .map(([key, value]) => {
                                const entry = value as PersistedSpeakerMuteState;
                                const restoreVolumePercent = Number(
                                    entry?.restoreVolumePercent
                                );
                                return [
                                    key.trim(),
                                    {
                                        mode:
                                            entry?.mode === "device" ||
                                            entry?.mode === "soft-volume"
                                                ? entry.mode
                                                : undefined,
                                        enabled:
                                            typeof entry?.enabled === "boolean"
                                                ? entry.enabled
                                                : undefined,
                                        restoreVolumePercent:
                                            Number.isFinite(restoreVolumePercent)
                                                ? Math.max(
                                                    0,
                                                    Math.min(
                                                        100,
                                                        Math.round(restoreVolumePercent)
                                                    )
                                                )
                                                : undefined,
                                        ignoreDeviceMuteReadback:
                                            typeof entry?.ignoreDeviceMuteReadback === "boolean"
                                                ? entry.ignoreDeviceMuteReadback
                                                : undefined,
                                        deviceMuteUnreliable:
                                            typeof entry?.deviceMuteUnreliable === "boolean"
                                                ? entry.deviceMuteUnreliable
                                                : undefined,
                                        softMuteUnreliable:
                                            typeof entry?.softMuteUnreliable === "boolean"
                                                ? entry.softMuteUnreliable
                                                : undefined,
                                        updatedAt:
                                            typeof entry?.updatedAt === "string" &&
                                            entry.updatedAt.trim()
                                                ? entry.updatedAt.trim()
                                                : undefined,
                                    } satisfies PersistedSpeakerMuteState,
                                ];
                            })
                    )
                    : undefined,
            updatedAt:
                typeof parsed.updatedAt === "string" && parsed.updatedAt.trim()
                    ? parsed.updatedAt.trim()
                    : undefined,
        };
    } catch {
        return {};
    }
}

export async function savePersistedConsoleState(
    filePath: string,
    state: PersistedConsoleState
) {
    const events = Array.isArray(state.events) ? state.events.slice(-300) : [];
    const next = {
        accessToken: state.accessToken,
        events,
        audioPlaybackClearedAt:
            typeof state.audioPlaybackClearedAt === "string" &&
            state.audioPlaybackClearedAt.trim()
                ? state.audioPlaybackClearedAt.trim()
                : undefined,
        speakerMuteStates:
            state.speakerMuteStates &&
            typeof state.speakerMuteStates === "object" &&
            !Array.isArray(state.speakerMuteStates)
                ? Object.fromEntries(
                    Object.entries(state.speakerMuteStates)
                        .filter(([key]) => typeof key === "string" && key.trim())
                        .map(([key, value]) => {
                            const restoreVolumePercent = Number(
                                value?.restoreVolumePercent
                            );
                            return [
                                key.trim(),
                                {
                                    mode:
                                        value?.mode === "device" ||
                                        value?.mode === "soft-volume"
                                            ? value.mode
                                            : undefined,
                                    enabled:
                                        typeof value?.enabled === "boolean"
                                            ? value.enabled
                                            : undefined,
                                    restoreVolumePercent:
                                        Number.isFinite(restoreVolumePercent)
                                            ? Math.max(
                                                0,
                                                Math.min(
                                                    100,
                                                    Math.round(restoreVolumePercent)
                                                )
                                            )
                                            : undefined,
                                    ignoreDeviceMuteReadback:
                                        typeof value?.ignoreDeviceMuteReadback === "boolean"
                                            ? value.ignoreDeviceMuteReadback
                                            : undefined,
                                    deviceMuteUnreliable:
                                        typeof value?.deviceMuteUnreliable === "boolean"
                                            ? value.deviceMuteUnreliable
                                            : undefined,
                                    softMuteUnreliable:
                                        typeof value?.softMuteUnreliable === "boolean"
                                            ? value.softMuteUnreliable
                                            : undefined,
                                    updatedAt:
                                        typeof value?.updatedAt === "string" &&
                                        value.updatedAt.trim()
                                            ? value.updatedAt.trim()
                                            : undefined,
                                } satisfies PersistedSpeakerMuteState,
                            ];
                        })
                )
                : undefined,
        updatedAt: new Date().toISOString(),
    };
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(next, null, 2), {
        encoding: "utf8",
        mode: 0o600,
    });
}
