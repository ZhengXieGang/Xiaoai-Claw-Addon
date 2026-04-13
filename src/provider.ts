import path from "path";
import { mkdir, readFile, readdir, stat, unlink, utimes, writeFile } from "fs/promises";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { execFile, spawn } from "child_process";
import { networkInterfaces } from "os";
import { fileURLToPath } from "url";
import JSON5 from "json5";
import { renderConsoleAccessPage, renderConsolePage } from "./console-page.js";
import {
    resolveOpenclawConfigPath,
    resolvePluginStorageDir,
} from "./openclaw-paths.js";
import { loadGatewayClientCtor } from "./openclaw-gateway-runtime.js";
import type { GatewayClientLike } from "./openclaw-gateway-runtime.js";
import {
    LoginDeviceCandidate,
    LoginDiscoveryPayload,
    LoginPortal,
    LoginPortalSessionSnapshot,
    LoginSessionSeed,
    LoginSubmission,
    LoginSuccessPayload,
    VerificationPageOpenPayload,
    LoginVerificationPayload,
    VerificationTicketSubmission,
} from "./auth-portal.js";
import {
    ConsoleEventEntry,
    PersistedAudioCalibrationSummary,
    PersistedConversationInterceptCalibrationSummary,
    PersistedConversationInterceptLatencyProfile,
    PersistedSpeakerAudioLatencyProfile,
    PersistedSpeakerMuteState,
    defaultStateStorePath,
    defaultConsoleStatePath,
    loadPersistedProfile,
    loadPersistedConsoleState,
    savePersistedProfile,
    savePersistedConsoleState,
} from "./state-store.js";
import {
    MiIOClient,
    MiioDeviceInfo,
    MiNAClient,
    MinaDeviceInfo,
    MiotSpecClient,
    SpeakerFeatureMap,
    XiaomiAccountClient,
    XiaomiPythonRuntimeStatus,
    XiaomiSid,
    XiaomiVerificationMethod,
    XiaomiVerificationRequiredError,
    XiaomiVerificationState,
    defaultTokenStorePath,
    pickSpeakerFeatures,
    selectMiioDevice,
    selectMinaDevice,
} from "./xiaomi-client.js";

type InterceptMode = "wake" | "proxy" | "silent";

interface PluginConfig {
    account?: string;
    password?: string;
    serverCountry: string;
    hardware?: string;
    speakerName?: string;
    miDid?: string;
    minaDeviceId?: string;
    tokenStorePath: string;
    stateStorePath: string;
    consoleStatePath: string;
    storageDir: string;
    debugLogPath: string;
    pythonCommand?: string;
    pollIntervalMs: number;
    authListenHost: string;
    authPort: number;
    authRoutePath: string;
    publicBaseUrl?: string;
    audioPublicBaseUrl?: string;
    openclawAgent?: string;
    openclawChannel: string;
    openclawTo?: string;
    openclawNotificationsDisabled: boolean;
    openclawCliPath: string;
    openclawThinkingOff: boolean;
    openclawForceNonStreaming: boolean;
    openclawVoiceSystemPrompt: string;
    transitionPhrases: string[];
    debugLogEnabled: boolean;
    voiceContextMaxTurns: number;
    voiceContextMaxChars: number;
    wakeWordPattern: string;
    dialogWindowSeconds: number;
    audioTailPaddingMs: number;
}

interface DeviceContext {
    hardware: string;
    model: string;
    miDid: string;
    minaDeviceId: string;
    name: string;
    speakerFeatures: SpeakerFeatureMap;
}

interface ActionContext {
    device: DeviceContext;
    miio: MiIOClient;
    mina: MiNAClient;
}

interface PendingVerificationContext {
    kind: "discover_password" | "login_password";
    sid: XiaomiSid;
    payload: LoginSubmission;
    state: XiaomiVerificationState;
}

interface VolumeSnapshot {
    percent: number;
    raw: number;
    source: "miot" | "mina" | "cache";
    muted?: boolean;
    deviceMuted?: boolean;
    unmuteBlocked?: boolean;
    muteSupported?: boolean;
    pending?: boolean;
}

interface SpeakerMuteSyncResult {
    ok: boolean;
    mode: "property" | "property.numeric" | "action.mute_on" | "action.mute_off" | "none";
    code?: number;
    siid?: number;
    piid?: number;
    aiid?: number;
}

interface PendingVolumeState {
    sequence: number;
    snapshot: {
        percent: number;
        raw: number;
        muted?: boolean;
        deviceMuted?: boolean;
        unmuteBlocked?: boolean;
        muteSupported?: boolean;
    };
    setAt: number;
    expiresAt: number;
}

type SpeakerMuteControlMode = "device" | "soft-volume";

interface VoiceContextTurn {
    sessionKey: string;
    role: "user" | "assistant";
    text: string;
    timeMs: number;
}

interface ConsoleBootstrapPayload {
    ready: boolean;
    authenticated?: boolean;
    account?: string;
    serverCountry?: string;
    mode: InterceptMode;
    modeLabel: string;
    wakeWordPattern?: string;
    dialogWindowSeconds: number;
    openclawThinkingOff: boolean;
    thinkingEnabled: boolean;
    openclawForceNonStreaming: boolean;
    openclawAgentId?: string;
    openclawContextTokens?: number;
    openclawContextWindow?: number;
    openclawVoiceSystemPrompt: string;
    transitionPhrases: string[];
    debugLogEnabled: boolean;
    voiceContextMaxTurns: number;
    voiceContextMaxChars: number;
    debugLogPath?: string;
    helperStatus: string;
    lastConversationAt?: string;
    lastConversationQuery?: string;
    lastError?: string;
    lastErrorTransient?: boolean;
    consoleUrl?: string;
    loginUrl?: string;
    loginHint?: string;
    device?: {
        name?: string;
        hardware?: string;
        model?: string;
        miDid?: string;
        minaDeviceId?: string;
    };
    volume?: {
        percent: number;
        muted?: boolean;
        deviceMuted?: boolean;
        unmuteBlocked?: boolean;
        muteSupported?: boolean;
        pending?: boolean;
    } | null;
    audioPlayback?: {
        source: "speaker";
        title?: string;
        status: "idle" | "playing" | "paused";
        audioUrl?: string;
        positionSeconds?: number;
        durationSeconds?: number;
    } | null;
    openclawRoute?: ConsoleOpenclawRouteState;
    openclawWorkspaceFiles?: ConsoleOpenclawWorkspaceState;
    audioCalibration?: ConsoleAudioCalibrationState;
    conversationInterceptCalibration?: ConsoleConversationInterceptCalibrationState;
}

interface ConsoleSpeakerAudioLatencyProfile {
    statusProbeEstimateMs?: number;
    pauseCommandEstimateMs?: number;
    pauseSettleEstimateMs?: number;
    stopSettleEstimateMs?: number;
    playbackDetectEstimateMs?: number;
    updatedAt?: string;
}

interface ConsoleCalibrationPrompt {
    state: "missing" | "recalibrate";
    title: string;
    detail: string;
}

interface ConsoleAudioCalibrationState {
    running: boolean;
    tailPaddingMs: number;
    currentProfile?: ConsoleSpeakerAudioLatencyProfile;
    lastRun?: PersistedAudioCalibrationSummary;
    prompt?: ConsoleCalibrationPrompt;
}

interface ConsoleConversationInterceptLatencyProfile {
    conversationVisibleEstimateMs?: number;
    nativePlaybackStartEstimateMs?: number;
    interceptLeadEstimateMs?: number;
    manualOffsetMs?: number;
    updatedAt?: string;
}

interface ConsoleConversationInterceptCalibrationState {
    running: boolean;
    pollIntervalMs: number;
    recommendedPollIntervalMs?: number;
    manualOffsetMs: number;
    currentProfile?: ConsoleConversationInterceptLatencyProfile;
    lastRun?: PersistedConversationInterceptCalibrationSummary;
    prompt?: ConsoleCalibrationPrompt;
}

interface ConsoleOpenclawModelOption {
    ref: string;
    name: string;
    provider: string;
    contextWindow?: number;
    reasoning: boolean;
    input?: string[];
}

interface OpenclawAgentModelState {
    agentId: string;
    model?: string;
    contextTokens?: number;
    contextWindow?: number;
    systemPrompt?: string;
    models: ConsoleOpenclawModelOption[];
}

interface ConsoleOpenclawRouteChannelOption {
    id: string;
    label: string;
    configured: boolean;
    targets: string[];
}

interface ConsoleOpenclawRouteState {
    agentId: string;
    channel: string;
    target?: string;
    enabled: boolean;
    channels: ConsoleOpenclawRouteChannelOption[];
}

type OpenclawWorkspaceFileId =
    | "agents"
    | "identity"
    | "tools"
    | "heartbeat"
    | "boot"
    | "memory";

interface ConsoleOpenclawWorkspaceFileState {
    id: OpenclawWorkspaceFileId;
    filename: string;
    label: string;
    description: string;
    enabled: boolean;
    customized: boolean;
    defaultEnabled: boolean;
    disableAllowed: boolean;
    defaultContent: string;
    content: string;
}

interface ConsoleOpenclawWorkspaceState {
    agentId: string;
    files: ConsoleOpenclawWorkspaceFileState[];
}

interface ConsoleConversationEntry {
    id: string;
    requestId?: string;
    time: string;
    query: string;
    answers: string[];
}

interface ConsoleDeviceOption extends LoginDeviceCandidate {
    selected: boolean;
}

interface ActiveVoiceAgentRun {
    id: string;
    label: string;
    sessionKey?: string;
    startedAtMs: number;
    firstSpeakObserved: boolean;
}

interface RecentOpenclawSpeech {
    text: string;
    timeMs: number;
}

interface OpenclawReplyPayload {
    text?: string;
    mediaUrl?: string | null;
    mediaUrls?: string[];
}

interface OpenclawAgentFinalResult {
    runId?: string;
    status?: string;
    summary?: string;
    result?: {
        payloads?: OpenclawReplyPayload[];
        meta?: Record<string, any>;
        stopReason?: string;
    };
}

interface OpenclawGatewayAuthState {
    mode: string;
    token?: string;
    password?: string;
    bearerSecret: string;
    globalConfig?: Record<string, any>;
}

interface RecentSelfTriggeredQuery {
    text: string;
    comparable: string;
    source: "execute" | "speak";
    timeMs: number;
}

interface AudioRelayEntry {
    id: string;
    sourceUrl?: string;
    localSourceUrl?: string;
    extension: string;
    transcodeToMp3?: boolean;
    buffer?: Buffer;
    filePath?: string;
    contentType?: string;
    sourceLabel?: string;
    createdAtMs: number;
    expiresAtMs: number;
    hitCount: number;
    durationMs?: number;
    tailPaddingMs?: number;
    lastHitAtMs?: number;
    lastHitAddress?: string;
}

type AudioPlaybackStrategy =
    | "original-direct"
    | "original-music"
    | "relay-direct-mp3"
    | "relay-direct"
    | "relay-music"
    | "relay-music-mp3";

interface PreparedSpeakerAudioSource {
    playbackUrl: string;
    standardized: boolean;
    standardizationError?: string;
}

interface GeneratedAudioAsset {
    audioBuffer: Buffer;
    audioExtension: string;
    cacheHit?: boolean;
}

interface AudioPlaybackCapabilityEntry {
    preferredStrategy?: AudioPlaybackStrategy;
    skipSpeakerUntilMs?: number;
    lastFailureAtMs?: number;
    lastSuccessAtMs?: number;
}

interface ExternalAudioMusicRequest {
    expectedAudioId: string;
    data: Record<string, any>;
}

interface SpeakerPlaybackSnapshot {
    status?: number;
    volume?: number;
    mediaType?: number;
    loopType?: number;
    audioId?: string;
    position?: number;
    duration?: number;
    trackList: string[];
}

interface SpeakerPlaybackVerifyOptions {
    expectedAudioId?: string;
    relayUrl?: string;
    relayHitCount?: number;
    allowRelayHitStart?: boolean;
}

interface SpeakerPlaybackVerifyResult {
    started: boolean;
    snapshot: SpeakerPlaybackSnapshot | null;
    relayHitObserved: boolean;
    relayHitCount?: number;
    startedByRelayHit?: boolean;
}

interface ExternalAudioLoopGuard {
    token: string;
    deviceId: string;
    expectedAudioId?: string;
    restoreLoopType?: number;
    startedWithUrl: string;
    title?: string;
    armedAtMs: number;
    deadlineAtMs?: number;
    deadlineHandling?: boolean;
    deadlineTimer?: NodeJS.Timeout;
    lastSnapshot?: SpeakerPlaybackSnapshot | null;
    lastSnapshotAtMs?: number;
}

interface SpeakerAudioLatencyProfile {
    statusProbeEstimateMs?: number;
    pauseCommandEstimateMs?: number;
    pauseSettleEstimateMs?: number;
    stopSettleEstimateMs?: number;
    playbackDetectEstimateMs?: number;
    updatedAtMs: number;
}

interface ConversationInterceptLatencyProfile {
    conversationVisibleEstimateMs?: number;
    nativePlaybackStartEstimateMs?: number;
    interceptLeadEstimateMs?: number;
    manualOffsetMs?: number;
    updatedAtMs: number;
}

interface ConversationInterceptHint {
    answersPresent?: boolean;
    answerCount?: number;
    recordAgeMs?: number;
}

interface ConversationInterceptRuntimeState {
    updatedAtMs: number;
    lateRecordScore: number;
    playbackReboundScore: number;
    lastPlaybackDetectedElapsedMs?: number;
}

type SpeakerAudioLatencyKey =
    | "statusProbeEstimateMs"
    | "pauseCommandEstimateMs"
    | "pauseSettleEstimateMs"
    | "stopSettleEstimateMs"
    | "playbackDetectEstimateMs";

type ConversationInterceptLatencyKey =
    | "conversationVisibleEstimateMs"
    | "nativePlaybackStartEstimateMs"
    | "interceptLeadEstimateMs";

interface ConversationFetchLatencyProfile {
    estimateMs: number;
    updatedAtMs: number;
}

interface ConversationInterceptGuardPlan {
    aggressive: boolean;
    silenceMode: "pause" | "fast-stop";
    manualOffsetMs: number;
    estimatedSpeechOnsetMs: number;
    primaryLeadReserveMs: number;
    primarySilenceDelayMs: number;
    suppressTransitionPrompt: boolean;
    guardDelaysMs: number[];
    lateRecordFollowUpDelayMs: number;
    runtimeMonitorPollMs: number;
    runtimeMonitorDurationMs: number;
    transitionGraceMs: number;
}

interface ConversationInterceptSupplementalGuardState {
    attemptsUsed: number;
    lastAttemptAtMs: number;
}

const DEFAULT_TRANSITION_PHRASES = ["让我想想", "嗯，稍等一下", "好的，我想想"];
const DEFAULT_WAKE_WORD_PATTERN = "小[虾瞎侠下夏霞]";
const DEFAULT_DIALOG_WINDOW_SECONDS = 30;
const DEFAULT_AUTH_PORT = 17890;
const DEFAULT_DEBUG_LOG_ENABLED = true;
const DEFAULT_VOICE_CONTEXT_MAX_TURNS = 6;
const DEFAULT_VOICE_CONTEXT_MAX_CHARS = 1400;
const MAX_VOICE_CONTEXT_TURNS = 24;
const MAX_VOICE_CONTEXT_CHARS = 8000;
const MAX_OPENCLAW_VOICE_SYSTEM_PROMPT_CHARS = 6000;
const MAX_TRANSITION_PHRASES = 12;
const MAX_TRANSITION_PHRASE_CHARS = 40;
const OPENCLAW_AGENT_PROMPT_FILENAME = "AGENTS.md";
const DEFAULT_XIAOAI_AGENT_WORKSPACE_PROMPT =
    "你正在通过真实小爱音箱实时语音对话。目标是尽快开口回答。默认先直接调用 xiaoai_speak，回答尽量简短；如果你已经拿到了可直接播放的音频 URL，也可以按 OpenClaw 官方 payload 格式直接返回 mediaUrl/mediaUrls，插件会自动交给小爱播放。除非确实需要别的工具，否则不要先输出文字。不要输出执行状态、工具回执或流程确认，只给用户真正需要听到的内容。";
const OPENCLAW_WORKSPACE_FILE_DEFINITIONS: Array<{
    id: OpenclawWorkspaceFileId;
    filename: string;
    label: string;
    description: string;
    defaultContent: string;
    defaultEnabled: boolean;
    disableAllowed: boolean;
}> = [
    {
        id: "agents",
        filename: OPENCLAW_AGENT_PROMPT_FILENAME,
        label: "系统提示词",
        description:
            "这里会直接写入专属 workspace 的 AGENTS.md，由 OpenClaw bootstrap 机制在每轮自动注入，留空保存会恢复默认内容。",
        defaultContent: DEFAULT_XIAOAI_AGENT_WORKSPACE_PROMPT,
        defaultEnabled: true,
        disableAllowed: false,
    },
    {
        id: "identity",
        filename: "IDENTITY.md",
        label: "身份提示",
        description: "补充这个专属 agent 的身份设定。",
        defaultContent: "身份：小爱语音代理。",
        defaultEnabled: true,
        disableAllowed: true,
    },
    {
        id: "tools",
        filename: "TOOLS.md",
        label: "工具约束",
        description: "约束这个专属 agent 在 workspace 里优先使用哪些工具。",
        defaultContent: "只使用 xiaoai_* 工具处理音箱相关任务。",
        defaultEnabled: true,
        disableAllowed: true,
    },
    {
        id: "heartbeat",
        filename: "HEARTBEAT.md",
        label: "心跳说明",
        description: "默认只保留注释，避免为这个专属 agent 触发额外 heartbeat 任务。",
        defaultContent: "# 保持空文件或仅保留注释即可跳过 heartbeat API 调用。",
        defaultEnabled: true,
        disableAllowed: true,
    },
    {
        id: "boot",
        filename: "BOOT.md",
        label: "启动检查",
        description: "只有你确实需要 boot check 指令时才建议启用；默认保持禁用。",
        defaultContent: "无需启动动作。",
        defaultEnabled: false,
        disableAllowed: true,
    },
    {
        id: "memory",
        filename: "MEMORY.md",
        label: "长期记忆",
        description: "存放这个专属 agent 的少量长期偏好或常驻记忆。",
        defaultContent: "仅保留少量长期偏好。",
        defaultEnabled: true,
        disableAllowed: true,
    },
];
const CLOUD_LOGIN_SIDS: XiaomiSid[] = ["xiaomiio", "micoapi"];
const PAUSE_RETRY_DELAYS_MS = [0, 120];
const SPEAKER_COMMAND_VERIFY_DELAYS_MS = [80, 160, 320, 600, 900];
const SPEAKER_COMMAND_FAST_VERIFY_DELAYS_MS = [40, 80, 140];
const SPEAKER_MUTE_READBACK_VERIFY_DELAYS_MS = [120, 360, 900];
const SOFT_VOLUME_MUTE_READBACK_MAX_PERCENT = 5;
const SOFT_VOLUME_UNMUTE_SETTLE_PROBE_DELAYS_MS = [1500, 3500, 6500];
const VOLUME_CACHE_GRACE_MS = 3500;
const CONSOLE_COOKIE_NAME = "xiaoai_console_token";
const CONSOLE_EVENT_LIMIT = 300;
const CONSOLE_FETCH_LIMIT = 50;
const CONSOLE_JSON_BODY_LIMIT_BYTES = 64 * 1024;
const HELPER_STATUS_CACHE_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 320;
const MIN_POLL_INTERVAL_MS = 80;
const MAX_POLL_INTERVAL_MS = 10_000;
const MIN_RECOMMENDED_POLL_INTERVAL_MS = 120;
const IDLE_POLL_INTERVAL_MS = 900;
const FAST_POLL_INTERVAL_MS = 80;
const FAST_POLL_WINDOW_MS = 15_000;
const POLL_ACTIVITY_GRACE_MS = 20_000;
const STARTUP_POLL_GRACE_MS = 20_000;
const POLL_TRANSIENT_BACKOFF_STEPS_MS = [180, 260, 420, 700, 1100, 1700];
const POLL_TRANSIENT_BACKOFF_WINDOW_MS = 12_000;
const POLL_RATE_LIMIT_BACKOFF_MS = 3_200;
const POLL_RATE_LIMIT_BACKOFF_WINDOW_MS = 24_000;
const SELF_TRIGGER_QUERY_IGNORE_WINDOW_MS = 8_000;
const MAX_SELF_TRIGGER_QUERY_HISTORY = 16;
const CONVERSATION_WAIT_POLL_DELAYS_MS = [250, 350, 500, 700, 900, 1200];
const OPENCLAW_INTERCEPT_DETECTION_GRACE_MS = 3500;
const OPENCLAW_AGENT_SUBMIT_TIMEOUT_MS = 15_000;
const OPENCLAW_AGENT_WAIT_TIMEOUT_MS = 620_000;
const AUDIO_RELAY_TTL_MS = 10 * 60 * 1000;
const MAX_AUDIO_RELAY_ENTRIES = 24;
const TTS_BRIDGE_CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_TTS_BRIDGE_CACHE_FILES = 32;
const TTS_BRIDGE_CACHE_FORMAT_VERSION = "v3";
const AUDIO_PLAYBACK_VERIFY_DELAYS_MS = [100, 220, 420, 750];
const AUDIO_RELAY_MAX_BYTES = 24 * 1024 * 1024;
const DEFAULT_AUDIO_RELAY_TAIL_SILENCE_MS = 1500;
const MIN_AUDIO_RELAY_TAIL_SILENCE_MS = 0;
const MAX_AUDIO_RELAY_TAIL_SILENCE_MS = 10_000;
const AUDIO_CALIBRATION_SAMPLE_DURATIONS_MS = [450, 800, 1200];
const AUDIO_CALIBRATION_ROUND_SETTLE_MS = 500;
const AUDIO_PLAYBACK_SKIP_TTL_MS = 10 * 60 * 1000;
const AUDIO_STANDARDIZE_TIMEOUT_MS = 45_000;
const CONVERSATION_INTERCEPT_CALIBRATION_TIMEOUT_MS = 12_000;
const CONVERSATION_INTERCEPT_CALIBRATION_POLL_MS = 90;
const CONVERSATION_INTERCEPT_CALIBRATION_SETTLE_MS = 450;
const CONVERSATION_INTERCEPT_CALIBRATION_DEBUG_SAMPLE_LIMIT = 10;
const CONVERSATION_INTERCEPT_CALIBRATION_POST_VISIBLE_OBSERVE_MIN_MS = 220;
const CONVERSATION_INTERCEPT_CALIBRATION_POST_VISIBLE_OBSERVE_MAX_MS = 480;
const CONVERSATION_INTERCEPT_FALLBACK_GUARD_MAX_DELAY_MS = 1_800;
const CONVERSATION_INTERCEPT_MAX_SUPPLEMENTAL_ATTEMPTS = 2;
const CONVERSATION_INTERCEPT_SUPPLEMENTAL_MIN_SPACING_MS = 180;
const CONVERSATION_INTERCEPT_RUNTIME_MAX_INTERVENTIONS = 1;
const CONVERSATION_INTERCEPT_LATE_RECORD_BURST_DELAY_MS = 120;
const CONVERSATION_INTERCEPT_LATE_RECORD_FORWARD_GATE_DELAYS_MS = [
    0, 60, 140, 240, 360,
];
const MIN_CONVERSATION_INTERCEPT_MANUAL_OFFSET_MS = -900;
const MAX_CONVERSATION_INTERCEPT_MANUAL_OFFSET_MS = 900;
const CONVERSATION_INTERCEPT_MANUAL_OFFSET_STEP_MS = 25;
const CONVERSATION_INTERCEPT_RUNTIME_MONITOR_MIN_MS = 1400;
const CONVERSATION_INTERCEPT_RUNTIME_MONITOR_MAX_MS = 3200;
const CONVERSATION_INTERCEPT_RUNTIME_MONITOR_POLL_MS = 120;
const CONVERSATION_INTERCEPT_RUNTIME_MONITOR_AGGRESSIVE_POLL_MS = 90;
const CONVERSATION_INTERCEPT_TRANSITION_GRACE_MIN_MS = 320;
const CONVERSATION_INTERCEPT_TRANSITION_GRACE_MAX_MS = 1200;
const CONVERSATION_FETCH_ESTIMATE_DEFAULT_MS = 320;
const CONVERSATION_FETCH_HEDGE_MIN_DELAY_MS = 70;
const CONVERSATION_FETCH_HEDGE_MAX_DELAY_MS = 140;
const MAX_CONVERSATION_FETCH_INFLIGHT = 2;
const CONVERSATION_STARTUP_STALE_RECORD_IGNORE_MS = 45_000;
const SPEAKER_INTERRUPT_BURST_VERIFY_DELAYS_MS = [0, 40, 80, 140, 220];
const CONVERSATION_INTERCEPT_CALIBRATION_QUERIES = [
    "现在几点",
    "今天星期几",
    "今天天气怎么样",
    "现在是几月几号",
    "今天几号",
];
const MIN_OPENCLAW_CONTEXT_TOKENS = 1;
const MAX_OPENCLAW_CONTEXT_TOKENS = 2_000_000;
const EXTERNAL_AUDIO_NON_LOOP_TYPE = 3;
const EXTERNAL_AUDIO_LOOP_GUARD_POLL_MS = 180;
const EXTERNAL_AUDIO_LOOP_GUARD_NEAR_END_POLL_MS = 45;
const EXTERNAL_AUDIO_LOOP_GUARD_NEAR_END_MS = 1600;
const EXTERNAL_AUDIO_LOOP_GUARD_RESTART_POSITION_MS = 900;
const EXTERNAL_AUDIO_LOOP_GUARD_DEADLINE_LEAD_MS = 320;
const EXTERNAL_AUDIO_LOOP_GUARD_TAIL_PADDING_RESERVE_MS = 120;
const EXTERNAL_AUDIO_LOOP_GUARD_DEADLINE_GRACE_MS = 300;
const EXTERNAL_AUDIO_LOOP_GUARD_SNAPSHOT_FRESH_MS = 900;
const EXTERNAL_AUDIO_LOOP_GUARD_DEADLINE_STATUS_TIMEOUT_MS = 60;
const STATIC_ASSET_CACHE_MAX_AGE_SECONDS = 300;
const EXTERNAL_AUDIO_CP_ID = "355454500";
const EXTERNAL_AUDIO_ORIGIN = "xiaowei";
const MP3_TRANSCODE_PREFERRED_EXTENSIONS = new Set([".flac", ".ape"]);
const MP3_TRANSCODE_OPTIONAL_EXTENSIONS = new Set([".wav", ".ogg", ".oga", ".opus"]);
const FFPROBE_CACHE_TTL_MS = 10 * 60 * 1000;
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT_DIR = path.resolve(MODULE_DIR, "..", "..");
const STATIC_ASSETS_DIR = path.join(PLUGIN_ROOT_DIR, "assets");

type JsonSchema = Record<string, any>;

class HttpError extends Error {
    readonly statusCode: number;
    readonly payload?: Record<string, any>;

    constructor(statusCode: number, message: string, payload?: Record<string, any>) {
        super(message);
        this.name = "HttpError";
        this.statusCode = statusCode;
        this.payload = payload;
    }
}

function clamp(value: number, min: number, max: number) {
    return Math.max(min, Math.min(max, value));
}

function percentileFromSorted(values: readonly number[], percentile: number) {
    if (!values.length) {
        return undefined;
    }
    const safePercentile = clamp(percentile, 0, 1);
    if (values.length === 1) {
        return values[0];
    }
    const index = (values.length - 1) * safePercentile;
    const lowerIndex = Math.floor(index);
    const upperIndex = Math.ceil(index);
    if (lowerIndex === upperIndex) {
        return values[lowerIndex];
    }
    const lower = values[lowerIndex] ?? values[0];
    const upper = values[upperIndex] ?? values[values.length - 1];
    const weight = index - lowerIndex;
    return lower + (upper - lower) * weight;
}

function appendTimingSample<K extends string>(
    buckets: Partial<Record<K, number[]>> | undefined,
    key: K,
    observedMs?: number,
    maxMs = 20_000
) {
    const value = readNumber(observedMs);
    if (
        !buckets ||
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value <= 0
    ) {
        return;
    }
    const next = buckets[key] || [];
    next.push(clamp(Math.round(value), 1, maxMs));
    buckets[key] = next.slice(-18);
}

function buildRobustTimingEstimate(
    values: readonly number[] | undefined,
    options?: {
        cap?: number;
        percentile?: number;
        headroom?: number;
    }
) {
    const normalized = (values || [])
        .map((value) => clamp(Math.round(Number(value) || 0), 1, options?.cap || 20_000))
        .filter((value) => Number.isFinite(value) && value > 0)
        .sort((left, right) => left - right);
    if (!normalized.length) {
        return undefined;
    }
    const trimCount =
        normalized.length >= 5
            ? Math.min(2, Math.floor((normalized.length - 1) / 4))
            : 0;
    const core =
        trimCount > 0 && normalized.length > trimCount * 2
            ? normalized.slice(trimCount, normalized.length - trimCount)
            : normalized;
    const percentileValue =
        percentileFromSorted(core, options?.percentile ?? 0.6) ??
        core[Math.floor(core.length / 2)] ??
        normalized[Math.floor(normalized.length / 2)];
    const estimate = Math.round(
        percentileValue * Math.max(1, Number(options?.headroom) || 1)
    );
    return clamp(estimate, 1, options?.cap || 20_000);
}

function normalizeSpeakerVolumePercent(raw: number, min?: number, max?: number) {
    const resolvedMin = typeof min === "number" && Number.isFinite(min) ? min : 0;
    const resolvedMax = typeof max === "number" && Number.isFinite(max) ? max : 100;
    if (resolvedMax <= resolvedMin) {
        return clamp(Math.round(raw), 0, 100);
    }
    const percent = ((raw - resolvedMin) / (resolvedMax - resolvedMin)) * 100;
    return clamp(Math.round(percent), 0, 100);
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function htmlEscape(value: string) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function safeTokenEquals(expected?: string, candidate?: string) {
    if (!expected || !candidate) {
        return false;
    }
    const left = Buffer.from(expected);
    const right = Buffer.from(candidate);
    if (left.length !== right.length) {
        return false;
    }
    return timingSafeEqual(left, right);
}

function schemaObject(
    properties: Record<string, JsonSchema>,
    options?: { required?: string[] }
): JsonSchema {
    return {
        type: "object",
        properties,
        required: options?.required ?? Object.keys(properties),
        additionalProperties: false,
    };
}

function schemaString(options?: Record<string, any>): JsonSchema {
    return {
        type: "string",
        ...(options || {}),
    };
}

function schemaNumber(options?: Record<string, any>): JsonSchema {
    return {
        type: "number",
        ...(options || {}),
    };
}

function schemaBoolean(options?: Record<string, any>): JsonSchema {
    return {
        type: "boolean",
        ...(options || {}),
    };
}

function schemaLiteral(value: string | number | boolean): JsonSchema {
    return {
        type: typeof value,
        const: value,
    };
}

function schemaUnion(anyOf: JsonSchema[]): JsonSchema {
    return {
        anyOf,
    };
}

async function readJsonBody(request: any): Promise<any> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of request) {
        const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += nextChunk.length;
        if (totalBytes > CONSOLE_JSON_BODY_LIMIT_BYTES) {
            throw new HttpError(413, "请求体过大，请精简后重试。");
        }
        chunks.push(nextChunk);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (!text) {
        return {};
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new HttpError(400, "请求体不是合法的 JSON。");
    }
}

function shouldSendCrossOriginOpenerPolicy(response: any) {
    const request = response?.req;
    const forwardedProto = readRequestHeader(request, "x-forwarded-proto")?.toLowerCase();
    const forwardedHost = readRequestHeader(request, "x-forwarded-host");
    const host = forwardedHost || readRequestHeader(request, "host");
    const protocol =
        forwardedProto === "https" || Boolean(request?.socket?.encrypted)
            ? "https"
            : "http";
    if (protocol === "https" || !host) {
        return true;
    }
    try {
        return isLoopbackHostname(new URL(`${protocol}://${host}`).hostname);
    } catch {
        return false;
    }
}

function applySecurityHeaders(response: any) {
    response.setHeader("Cache-Control", "no-store, max-age=0");
    response.setHeader("Pragma", "no-cache");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    if (shouldSendCrossOriginOpenerPolicy(response)) {
        response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    }
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("X-Permitted-Cross-Domain-Policies", "none");
    response.setHeader(
        "Permissions-Policy",
        "camera=(), microphone=(), geolocation=()"
    );
    response.setHeader("X-Robots-Tag", "noindex, nofollow");
}

function applyHtmlSecurityHeaders(response: any) {
    applySecurityHeaders(response);
    response.setHeader(
        "Content-Security-Policy",
        [
            "default-src 'self'",
            "base-uri 'none'",
            "frame-ancestors 'none'",
            "form-action 'self'",
            "img-src 'self' data:",
            "style-src 'self' 'unsafe-inline'",
            "font-src 'self'",
            "script-src 'self' 'unsafe-inline'",
            "connect-src 'self'",
            "media-src 'self' http: https: blob:",
        ].join("; ")
    );
}

function sendJson(response: any, statusCode: number, payload: any) {
    response.statusCode = statusCode;
    applySecurityHeaders(response);
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(payload));
}

function sendHtml(response: any, html: string, statusCode = 200) {
    response.statusCode = statusCode;
    applyHtmlSecurityHeaders(response);
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(html);
}

function sendBuffer(
    response: any,
    statusCode: number,
    payload: Buffer,
    contentType: string
) {
    response.statusCode = statusCode;
    applySecurityHeaders(response);
    response.setHeader("Content-Type", contentType);
    response.end(payload);
}

function sendRedirect(response: any, location: string) {
    response.statusCode = 302;
    applySecurityHeaders(response);
    response.setHeader("Location", location);
    response.end("");
}

function sendText(response: any, statusCode: number, text: string) {
    response.statusCode = statusCode;
    applySecurityHeaders(response);
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.end(text);
}

function sendAssetNotModified(response: any, etag: string, modifiedAtMs: number) {
    response.statusCode = 304;
    response.setHeader(
        "Cache-Control",
        `public, max-age=${STATIC_ASSET_CACHE_MAX_AGE_SECONDS}, must-revalidate`
    );
    response.setHeader("ETag", etag);
    response.setHeader("Last-Modified", new Date(modifiedAtMs).toUTCString());
    response.end("");
}

function sendAssetBuffer(
    response: any,
    payload: Buffer,
    contentType: string,
    options: {
        etag: string;
        modifiedAtMs: number;
    }
) {
    response.statusCode = 200;
    response.setHeader(
        "Cache-Control",
        `public, max-age=${STATIC_ASSET_CACHE_MAX_AGE_SECONDS}, must-revalidate`
    );
    response.setHeader("ETag", options.etag);
    response.setHeader("Last-Modified", new Date(options.modifiedAtMs).toUTCString());
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Type", contentType);
    response.end(payload);
}

function normalizeRoutePath(value: string) {
    const trimmed = value.trim();
    if (!trimmed || trimmed === "/") {
        return "/";
    }
    const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    return withLeadingSlash.replace(/\/+$/, "") || "/";
}

function consoleAssetBasePath(routePath: string) {
    const basePath = normalizeRoutePath(routePath);
    return basePath === "/" ? "/assets" : `${basePath}/assets`;
}

function contentTypeForAsset(assetPath: string) {
    const extension = path.extname(assetPath).toLowerCase();
    switch (extension) {
        case ".css":
            return "text/css; charset=utf-8";
        case ".js":
            return "text/javascript; charset=utf-8";
        case ".json":
            return "application/json; charset=utf-8";
        case ".woff2":
            return "font/woff2";
        case ".woff":
            return "font/woff";
        case ".ttf":
            return "font/ttf";
        case ".otf":
            return "font/otf";
        case ".svg":
            return "image/svg+xml; charset=utf-8";
        case ".md":
        case ".txt":
            return "text/plain; charset=utf-8";
        default:
            return "application/octet-stream";
    }
}

function contentTypeForAudioExtension(extension: string) {
    switch (extension.toLowerCase()) {
        case ".mp3":
            return "audio/mpeg";
        case ".wav":
            return "audio/wav";
        case ".ogg":
            return "audio/ogg";
        case ".m4a":
        case ".mp4":
            return "audio/mp4";
        case ".aac":
            return "audio/aac";
        case ".flac":
            return "audio/flac";
        default:
            return "application/octet-stream";
    }
}

function readAudioSourceExtension(value: string) {
    try {
        const extension = path.extname(new URL(value).pathname || "").toLowerCase();
        return extension || undefined;
    } catch {
        return undefined;
    }
}

function isLikelyDirectPlayableAudioExtension(extension: string | undefined) {
    if (!extension) {
        return false;
    }
    return [".mp3", ".m4a", ".mp4", ".aac"].includes(extension.toLowerCase());
}

function looksLikeIpHostname(hostname: string) {
    return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

function isLoopbackHostname(hostname: string) {
    const normalized = hostname.trim().toLowerCase();
    if (!normalized) {
        return false;
    }
    return (
        normalized === "localhost" ||
        normalized === "0.0.0.0" ||
        normalized === "::1" ||
        normalized.startsWith("127.")
    );
}

function isPrivateHostname(hostname: string) {
    const normalized = hostname.trim().toLowerCase();
    if (!normalized) {
        return false;
    }
    if (
        normalized === "localhost" ||
        normalized === "0.0.0.0" ||
        normalized === "::1" ||
        normalized.endsWith(".local")
    ) {
        return true;
    }
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)) {
        const [a, b] = normalized.split(".").map((item) => Number(item));
        return (
            a === 10 ||
            a === 127 ||
            a === 192 && b === 168 ||
            a === 172 && b >= 16 && b <= 31 ||
            a === 169 && b === 254
        );
    }
    if (normalized.includes(":")) {
        return (
            normalized === "::1" ||
            normalized.startsWith("fe80:") ||
            normalized.startsWith("fc") ||
            normalized.startsWith("fd")
        );
    }
    return false;
}

function scoreConsoleBaseUrl(value: string) {
    try {
        const parsed = new URL(value);
        const hostname = parsed.hostname.trim().toLowerCase();
        if (!hostname) {
            return 0;
        }

        let score = 0;
        if (isLoopbackHostname(hostname)) {
            score += 400;
        }
        if (parsed.protocol === "https:") {
            score += 300;
        }
        if (!looksLikeIpHostname(hostname)) {
            score += 120;
        }
        if (!isLoopbackHostname(hostname) && !isPrivateHostname(hostname)) {
            score += 40;
        }
        if (!parsed.port || parsed.port === "80" || parsed.port === "443") {
            score += 10;
        }
        return score;
    } catch {
        return 0;
    }
}

function sortConsoleBaseUrls(values: string[]) {
    return values
        .map((value, index) => ({
            value,
            index,
            score: scoreConsoleBaseUrl(value),
        }))
        .sort((left, right) => right.score - left.score || left.index - right.index)
        .map((item) => item.value);
}

function isVirtualNetworkInterfaceName(name: string) {
    const normalized = name.trim().toLowerCase();
    if (!normalized) {
        return true;
    }
    return /^(?:lo|docker|br-|veth|podman|virbr|tailscale|tun|tap|utun|zt|wg|vboxnet|vmnet)/i.test(
        normalized
    );
}

function readLocalLanIpv4Addresses() {
    const candidates: Array<{ name: string; address: string; priority: number }> = [];
    for (const [name, entries] of Object.entries(networkInterfaces())) {
        const normalizedEntries = Array.isArray(entries)
            ? (entries as Array<{
                family?: string | number;
                internal?: boolean;
                address?: string;
            }>)
            : [];
        if (normalizedEntries.length === 0 || isVirtualNetworkInterfaceName(name)) {
            continue;
        }
        const normalizedName = name.trim().toLowerCase();
        const priority = /^(?:en|eth|eno|ens|enp|wlan|wlp|wl|wifi)/i.test(normalizedName)
            ? 0
            : 100;
        for (const entry of normalizedEntries) {
            const family =
                typeof entry.family === "string"
                    ? entry.family
                    : entry.family === 4
                        ? "IPv4"
                        : entry.family === 6
                            ? "IPv6"
                            : "";
            if (family !== "IPv4" || entry.internal) {
                continue;
            }
            const address = readString((entry as any).address);
            if (
                !address ||
                !isPrivateHostname(address) ||
                address.startsWith("169.254.")
            ) {
                continue;
            }
            candidates.push({
                name: normalizedName,
                address,
                priority,
            });
        }
    }
    return uniqueStrings(
        candidates
            .sort(
                (left, right) =>
                    left.priority - right.priority ||
                    left.name.localeCompare(right.name) ||
                    left.address.localeCompare(right.address)
            )
            .map((item) => item.address)
    );
}

function mediaUrlHostKey(value: string) {
    try {
        return new URL(value).host.toLowerCase() || "unknown";
    } catch {
        return "unknown";
    }
}

function shouldPreferRelayForMediaUrl(value: string) {
    try {
        return isPrivateHostname(new URL(value).hostname);
    } catch {
        return false;
    }
}

function uniqueStrings(values: string[]) {
    return Array.from(
        new Set(
            values
                .filter((value) => typeof value === "string")
                .map((value) => value.trim())
                .filter(Boolean)
        )
    );
}

function decodeURIComponentSafe(value: string) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function parseCookies(headerValue: string | undefined) {
    const cookies: Record<string, string> = {};
    if (!headerValue) {
        return cookies;
    }
    for (const item of headerValue.split(";")) {
        const index = item.indexOf("=");
        if (index <= 0) {
            continue;
        }
        const key = item.slice(0, index).trim();
        const rawValue = item.slice(index + 1).trim();
        if (!key) {
            continue;
        }
        cookies[key] = decodeURIComponentSafe(rawValue);
    }
    return cookies;
}

function readRequestHeader(
    request: any,
    name: string
): string | undefined {
    const raw =
        request?.headers?.[name] ??
        request?.headers?.[name.toLowerCase()];
    return readString(Array.isArray(raw) ? raw[0] : raw);
}

function normalizeEventText(value: string | undefined, maxLength = 280) {
    if (!value) {
        return undefined;
    }
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized) {
        return undefined;
    }
    return normalized.length <= maxLength
        ? normalized
        : `${normalized.slice(0, maxLength - 1)}…`;
}

function comparableConversationText(value: string | undefined) {
    const normalized = normalizeEventText(value, 280);
    if (!normalized) {
        return "";
    }

    return normalized
        .toLowerCase()
        .replace(/[\s"'`“”‘’]/g, "")
        .replace(/[，。！？、；：,.!?;:()[\]{}<>《》【】\-_=+~]/g, "");
}

function comparableDirectiveText(value: string | undefined) {
    const normalized = comparableConversationText(value);
    if (!normalized) {
        return "";
    }

    return normalized
        .replace(/^(?:小爱同学|小爱|帮我|请你|请|麻烦你|麻烦|帮忙|替我|给我|把|将)+/g, "")
        .replace(/(?:小爱同学|小爱|同学|帮我|请你|请|麻烦你|麻烦|帮忙|替我|给我)/g, "")
        .replace(/(?:一下子?|一下下|一下吧|一下啊|一下呀|一下呢|一下啦|一下嘛|一下呗|一下哦|一下喔|一下哈)/g, "")
        .replace(/(?:帮忙|帮下忙|帮下我|顺便)/g, "")
        .replace(/(?:关闭)/g, "关")
        .replace(/(?:打开)/g, "开")
        .replace(/(?:一下)/g, "")
        .replace(/(?:啊|呀|呢|啦|嘛|呗|哦|喔|哈|吧)+$/g, "")
        .trim();
}

function trimTextFromStart(value: string | undefined, maxLength: number) {
    if (!value) {
        return undefined;
    }
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized) {
        return undefined;
    }
    if (normalized.length <= maxLength) {
        return normalized;
    }
    return `…${normalized.slice(-(maxLength - 1))}`;
}

function pickFirstString(...values: Array<any>): string | undefined {
    for (const value of values) {
        if (typeof value === "string" && value.trim()) {
            return value.trim();
        }
    }
    return undefined;
}

function readString(value: any): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
}

function normalizeDeviceCapabilityKey(value: string | undefined) {
    return readString(value)?.replace(/\s+/g, "").toLowerCase();
}

function normalizeSpeakerFeaturesForDevice(speakerFeatures: SpeakerFeatureMap) {
    return speakerFeatures;
}

function unwrapOpenclawVoiceSystemPrompt(value: string) {
    const matched = value.match(/^\[?\s*系统要求[:：]\s*([\s\S]*?)\s*\]?$/u);
    return matched?.[1]?.trim() || value;
}

function normalizeOpenclawVoiceSystemPrompt(
    value: any,
    options?: { fallbackToDefault?: boolean }
) {
    const fallbackToDefault = options?.fallbackToDefault !== false;
    const raw = typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : "";
    const normalized = raw
        ? unwrapOpenclawVoiceSystemPrompt(raw)
              .slice(0, MAX_OPENCLAW_VOICE_SYSTEM_PROMPT_CHARS)
              .trim()
        : "";
    if (normalized) {
        return normalized;
    }
    return fallbackToDefault ? DEFAULT_XIAOAI_AGENT_WORKSPACE_PROMPT : "";
}

function findOpenclawWorkspaceFileDefinition(fileRef: any) {
    const normalized = readString(fileRef)?.toLowerCase();
    if (!normalized) {
        return undefined;
    }
    return OPENCLAW_WORKSPACE_FILE_DEFINITIONS.find(
        (item) =>
            item.id === normalized ||
            item.filename.toLowerCase() === normalized ||
            item.label.toLowerCase() === normalized
    );
}

function normalizeOpenclawWorkspaceFileContent(
    definition: {
        id: OpenclawWorkspaceFileId;
        defaultContent: string;
    },
    value: any,
    options?: { fallbackToDefault?: boolean }
) {
    const fallbackToDefault = options?.fallbackToDefault !== false;
    if (definition.id === "agents") {
        return normalizeOpenclawVoiceSystemPrompt(value, {
            fallbackToDefault,
        });
    }
    const raw = typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : "";
    const normalized = raw
        ? raw
              .slice(0, MAX_OPENCLAW_VOICE_SYSTEM_PROMPT_CHARS)
              .trim()
        : "";
    if (normalized) {
        return normalized;
    }
    return fallbackToDefault ? definition.defaultContent : "";
}

function normalizeTransitionPhrasesInput(
    value: any,
    options?: { fallbackToDefault?: boolean }
) {
    const fallbackToDefault = options?.fallbackToDefault !== false;
    const candidates = Array.isArray(value)
        ? value
        : typeof value === "string"
            ? value.replace(/\r\n?/g, "\n").split("\n")
            : [];
    const normalized = uniqueStrings(
        candidates
            .map((item) =>
                typeof item === "string" ? item.slice(0, MAX_TRANSITION_PHRASE_CHARS) : ""
            )
            .filter(Boolean)
    ).slice(0, MAX_TRANSITION_PHRASES);
    if (normalized.length > 0) {
        return normalized;
    }
    return fallbackToDefault ? DEFAULT_TRANSITION_PHRASES.slice() : [];
}

function readJsonObject<T>(value: string, label: string): T {
    try {
        return JSON.parse(value) as T;
    } catch (error) {
        throw new Error(
            `${label} 返回的 JSON 无法解析: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }
}

function resolveConfiguredOpenclawModel(value: any): string | undefined {
    return pickFirstString(
        readString(value),
        readString(value?.primary)
    );
}

function normalizeOpenclawModelRef(value: any): string | undefined {
    const raw = readString(value);
    if (!raw) {
        return undefined;
    }
    const firstSlash = raw.indexOf("/");
    if (firstSlash <= 0 || firstSlash >= raw.length - 1) {
        return undefined;
    }
    return raw;
}

function toConsoleOpenclawModelOption(value: any): ConsoleOpenclawModelOption | undefined {
    const provider = readString(value?.provider);
    const modelId = readString(value?.id);
    if (!provider || !modelId) {
        return undefined;
    }
    const input = Array.isArray(value?.input)
        ? value.input
            .map((item: any) => readString(item))
            .filter((item: string | undefined): item is string => Boolean(item))
        : undefined;
    return {
        ref: `${provider}/${modelId}`,
        name: readString(value?.name) || `${provider}/${modelId}`,
        provider,
        contextWindow: readNumber(value?.contextWindow),
        reasoning: readBoolean(value?.reasoning) ?? false,
        input: input && input.length > 0 ? input : undefined,
    };
}

function mergeConsoleOpenclawModelOption(
    current: ConsoleOpenclawModelOption | undefined,
    next: ConsoleOpenclawModelOption
): ConsoleOpenclawModelOption {
    if (!current) {
        return next;
    }
    return {
        ref: current.ref,
        name: current.name !== current.ref ? current.name : next.name,
        provider: current.provider || next.provider,
        contextWindow: current.contextWindow ?? next.contextWindow,
        reasoning: current.reasoning || next.reasoning,
        input:
            current.input && current.input.length > 0
                ? current.input
                : next.input,
    };
}

function collectConfiguredOpenclawModels(
    globalConfig: Record<string, any> | undefined
): ConsoleOpenclawModelOption[] {
    const modelMap = new Map<string, ConsoleOpenclawModelOption>();
    const providers =
        globalConfig?.models?.providers &&
            typeof globalConfig.models.providers === "object"
            ? globalConfig.models.providers
            : undefined;

    if (providers) {
        for (const [providerId, providerConfig] of Object.entries(providers)) {
            const provider = readString(providerId);
            if (!provider) {
                continue;
            }
            const items = Array.isArray((providerConfig as any)?.models)
                ? (providerConfig as any).models
                : [];
            for (const item of items) {
                const option = toConsoleOpenclawModelOption({
                    ...(item && typeof item === "object" ? item : {}),
                    provider,
                });
                if (!option) {
                    continue;
                }
                modelMap.set(
                    option.ref,
                    mergeConsoleOpenclawModelOption(
                        modelMap.get(option.ref),
                        option
                    )
                );
            }
        }
    }

    const catalog =
        globalConfig?.agents?.defaults?.models &&
            typeof globalConfig.agents.defaults.models === "object" &&
            !Array.isArray(globalConfig.agents.defaults.models)
            ? globalConfig.agents.defaults.models
            : undefined;
    if (!catalog) {
        return Array.from(modelMap.values());
    }

    const orderedModels: ConsoleOpenclawModelOption[] = [];
    for (const [entryKey, entryValue] of Object.entries(catalog)) {
        const ref =
            normalizeOpenclawModelRef(entryKey) ||
            normalizeOpenclawModelRef((entryValue as any)?.ref);
        if (!ref) {
            continue;
        }
        const provider =
            readString((entryValue as any)?.provider) || ref.split("/")[0] || "unknown";
        const input = Array.isArray((entryValue as any)?.input)
            ? (entryValue as any).input
                .map((item: any) => readString(item))
                .filter((item: string | undefined): item is string => Boolean(item))
            : undefined;
        const option: ConsoleOpenclawModelOption = {
            ref,
            name:
                readString((entryValue as any)?.alias) ||
                readString((entryValue as any)?.name) ||
                ref,
            provider,
            contextWindow: readNumber((entryValue as any)?.contextWindow),
            reasoning: readBoolean((entryValue as any)?.reasoning) ?? false,
            input: input && input.length > 0 ? input : undefined,
        };
        orderedModels.push(
            mergeConsoleOpenclawModelOption(modelMap.get(ref), option)
        );
    }
    return orderedModels.length > 0
        ? orderedModels
        : Array.from(modelMap.values());
}

function readStringList(value: any): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((item) =>
            typeof item === "number"
                ? String(item)
                : readString(item)
        )
        .filter((item): item is string => Boolean(item));
}

function formatConsoleOpenclawChannelLabel(channelId: string) {
    const normalized = readString(channelId)?.toLowerCase() || "";
    if (!normalized) {
        return "未命名渠道";
    }

    const aliasMap: Record<string, string> = {
        qqbot: "QQ Bot",
        wecom: "企业微信",
        telegram: "Telegram",
        slack: "Slack",
        discord: "Discord",
        feishu: "飞书",
        dingtalk: "钉钉",
        email: "Email",
        sms: "SMS",
        webhook: "Webhook",
        serverchan: "ServerChan",
    };
    if (aliasMap[normalized]) {
        return aliasMap[normalized];
    }
    return normalized
        .split(/[_-]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
}

function collectConfiguredOpenclawChannels(
    globalConfig: Record<string, any> | undefined
) {
    const channelsConfig =
        globalConfig?.channels && typeof globalConfig.channels === "object"
            ? globalConfig.channels
            : undefined;
    if (!channelsConfig) {
        return [];
    }

    return Object.entries(channelsConfig)
        .filter(([channelId, value]) => {
            const normalizedChannelId = readString(channelId)?.toLowerCase();
            return Boolean(
                normalizedChannelId &&
                    value &&
                    typeof value === "object" &&
                    !Array.isArray(value) &&
                    readBoolean((value as any).enabled) !== false
            );
        })
        .map(([channelId]) => readString(channelId)?.toLowerCase())
        .filter((value): value is string => Boolean(value));
}

function collectOpenclawNotificationTargetsFromNode(
    value: any,
    candidates: Set<string>,
    depth = 0
) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return;
    }

    for (const item of [
        ...readStringList((value as any).allowFrom),
        ...readStringList((value as any).allowUsers),
        ...readStringList((value as any).allowTargets),
        ...readStringList((value as any).targets),
    ]) {
        candidates.add(item);
    }

    for (const item of [
        readString((value as any).target),
        readString((value as any).to),
        readString((value as any).chatId),
        readString((value as any).userId),
        readString((value as any).channelId),
        readString((value as any).roomId),
        readString((value as any).threadId),
        readString((value as any).recipient),
        readString((value as any).conversationId),
        readString((value as any).peerId),
    ].filter((item): item is string => Boolean(item))) {
        candidates.add(item);
    }

    if (depth >= 2) {
        return;
    }

    for (const nested of Object.values(value)) {
        if (nested && typeof nested === "object" && !Array.isArray(nested)) {
            collectOpenclawNotificationTargetsFromNode(nested, candidates, depth + 1);
        }
    }
}

function collectOpenclawNotificationTargets(
    globalConfig: Record<string, any> | undefined,
    channel: string | undefined
) {
    const normalizedChannel = readString(channel)?.toLowerCase();
    if (!normalizedChannel) {
        return [];
    }
    const channelsConfig =
        globalConfig?.channels && typeof globalConfig.channels === "object"
            ? globalConfig.channels
            : undefined;
    const channelConfig =
        channelsConfig &&
        (channelsConfig as any)[normalizedChannel] &&
        typeof (channelsConfig as any)[normalizedChannel] === "object"
            ? (channelsConfig as any)[normalizedChannel]
            : undefined;
    if (!channelConfig) {
        return [];
    }

    const candidates = new Set<string>();
    collectOpenclawNotificationTargetsFromNode(channelConfig, candidates);
    return Array.from(candidates);
}

function inferConfiguredOpenclawChannel(
    globalConfig: Record<string, any> | undefined
) {
    const configuredChannels = collectConfiguredOpenclawChannels(globalConfig);
    return configuredChannels.length === 1
        ? configuredChannels[0]
        : undefined;
}

function inferOpenclawNotificationTarget(
    globalConfig: Record<string, any> | undefined,
    channel: string | undefined
) {
    const candidates = collectOpenclawNotificationTargets(globalConfig, channel);
    return candidates.length === 1 ? candidates[0] : undefined;
}

function maskAccountLabel(value: string | undefined): string | undefined {
    const raw = readString(value);
    if (!raw) {
        return undefined;
    }
    const atIndex = raw.indexOf("@");
    if (atIndex > 0) {
        const local = raw.slice(0, atIndex);
        const domain = raw.slice(atIndex);
        const visible = local.slice(0, Math.min(3, local.length));
        return `${visible}${local.length > 3 ? "***" : ""}${domain}`;
    }
    if (raw.length <= 5) {
        if (raw.length <= 2) {
            return raw;
        }
        return `${raw.slice(0, 1)}${"*".repeat(Math.max(1, raw.length - 2))}${raw.slice(-1)}`;
    }
    return `${raw.slice(0, 3)}${"*".repeat(Math.max(1, raw.length - 5))}${raw.slice(-2)}`;
}

function readNumber(value: any): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return undefined;
}

function readBoolean(value: any): boolean | undefined {
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

function normalizeAudioTailPaddingMs(
    value: any,
    fallback = DEFAULT_AUDIO_RELAY_TAIL_SILENCE_MS
) {
    const resolvedFallback = clamp(
        Math.round(Number(fallback) || DEFAULT_AUDIO_RELAY_TAIL_SILENCE_MS),
        MIN_AUDIO_RELAY_TAIL_SILENCE_MS,
        MAX_AUDIO_RELAY_TAIL_SILENCE_MS
    );
    const parsed = readNumber(value);
    if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
        return resolvedFallback;
    }
    return clamp(
        Math.round(parsed),
        MIN_AUDIO_RELAY_TAIL_SILENCE_MS,
        MAX_AUDIO_RELAY_TAIL_SILENCE_MS
    );
}

function normalizePollIntervalMs(value: any, fallback = DEFAULT_POLL_INTERVAL_MS) {
    const resolvedFallback = clamp(
        Math.round(Number(fallback) || DEFAULT_POLL_INTERVAL_MS),
        MIN_POLL_INTERVAL_MS,
        MAX_POLL_INTERVAL_MS
    );
    const parsed = readNumber(value);
    if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
        return resolvedFallback;
    }
    return clamp(Math.round(parsed), MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS);
}

function normalizeConversationInterceptManualOffsetMs(
    value: any,
    fallback = 0
) {
    const resolvedFallback = clamp(
        Math.round(Number(fallback) || 0),
        MIN_CONVERSATION_INTERCEPT_MANUAL_OFFSET_MS,
        MAX_CONVERSATION_INTERCEPT_MANUAL_OFFSET_MS
    );
    const parsed = readNumber(value);
    if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
        return resolvedFallback;
    }
    return clamp(
        Math.round(parsed / CONVERSATION_INTERCEPT_MANUAL_OFFSET_STEP_MS) *
            CONVERSATION_INTERCEPT_MANUAL_OFFSET_STEP_MS,
        MIN_CONVERSATION_INTERCEPT_MANUAL_OFFSET_MS,
        MAX_CONVERSATION_INTERCEPT_MANUAL_OFFSET_MS
    );
}

function normalizeOpenclawContextTokens(
    value: any,
    fallback?: number
): number | undefined {
    const parsed = readNumber(value);
    const candidate =
        typeof parsed === "number" && Number.isFinite(parsed)
            ? parsed
            : readNumber(fallback);
    if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
        return undefined;
    }
    return clamp(
        Math.round(candidate),
        MIN_OPENCLAW_CONTEXT_TOKENS,
        MAX_OPENCLAW_CONTEXT_TOKENS
    );
}

function escapeRegexLiteral(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeWakeWordPatternInput(value: any) {
    const raw = readString(value);
    if (!raw) {
        throw new Error("请输入唤醒词或正则源码。");
    }
    const pattern = /[\\^$.*+?()[\]{}|]/.test(raw)
        ? raw
        : escapeRegexLiteral(raw);
    try {
        new RegExp(pattern);
    } catch (error) {
        throw new Error(`唤醒词规则无效: ${error instanceof Error ? error.message : String(error)}`);
    }
    return pattern;
}

function pickWakeWordPattern(...values: Array<any>) {
    for (const value of values) {
        const raw = readString(value);
        if (!raw) {
            continue;
        }
        try {
            return normalizeWakeWordPatternInput(raw);
        } catch {
            continue;
        }
    }
    return DEFAULT_WAKE_WORD_PATTERN;
}

function normalizeHttpPath(value: string | undefined, fallback: string) {
    const raw = readString(value) || fallback;
    if (raw === "/") {
        return "/";
    }
    const withLeadingSlash = raw.startsWith("/") ? raw : `/${raw}`;
    return withLeadingSlash.replace(/\/+$/, "") || fallback;
}

function normalizeBaseUrl(value: string | undefined) {
    if (!value) {
        return undefined;
    }
    try {
        const url = new URL(value);
        url.hash = "";
        return url.toString().replace(/\/+$/, "");
    } catch {
        return undefined;
    }
}

function normalizeRemoteMediaUrl(value: string | undefined) {
    if (!value) {
        return undefined;
    }
    try {
        const url = new URL(value);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            return undefined;
        }
        return url.toString();
    } catch {
        return undefined;
    }
}

function websocketUrlToHttp(value: string | undefined) {
    if (!value) {
        return undefined;
    }
    try {
        const url = new URL(value);
        if (url.protocol === "ws:") {
            url.protocol = "http:";
        } else if (url.protocol === "wss:") {
            url.protocol = "https:";
        } else if (url.protocol !== "http:" && url.protocol !== "https:") {
            return undefined;
        }
        url.hash = "";
        return url.toString().replace(/\/+$/, "");
    } catch {
        return undefined;
    }
}

function normalizeWebsocketUrl(value: string | undefined) {
    if (!value) {
        return undefined;
    }
    try {
        const url = new URL(value);
        if (url.protocol === "http:") {
            url.protocol = "ws:";
        } else if (url.protocol === "https:") {
            url.protocol = "wss:";
        } else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
            return undefined;
        }
        url.hash = "";
        return url.toString().replace(/\/+$/, "");
    } catch {
        return undefined;
    }
}

function hardwareFromModel(model: string | undefined): string | undefined {
    if (!model) {
        return undefined;
    }
    const parts = model.split(".");
    const suffix = parts[parts.length - 1]?.trim();
    return suffix ? suffix.toUpperCase() : undefined;
}

function readMinaDeviceModel(device: MinaDeviceInfo | null | undefined): string | undefined {
    if (!device || typeof device !== "object") {
        return undefined;
    }
    return pickFirstString(
        readString((device as any).model),
        readString((device as any).deviceModel),
        readString((device as any).miotModel),
        readString((device as any).modelName)
    );
}

async function readApiConfig(api: any): Promise<Record<string, any>> {
    const candidates: any[] = [];

    if (api && typeof api.getConfig === "function") {
        try {
            candidates.push(await Promise.resolve(api.getConfig()));
        } catch {
            // Ignore unsupported config APIs and fall back to env.
        }
    }

    if (api && typeof api.config === "object") {
        candidates.push(api.config);
    }
    if (api && typeof api.pluginConfig === "object") {
        candidates.push(api.pluginConfig);
    }
    if (api?.context && typeof api.context.config === "object") {
        candidates.push(api.context.config);
    }
    if (api?.runtime && typeof api.runtime.config === "object") {
        candidates.push(api.runtime.config);
    }

    return Object.assign({}, ...candidates.filter((item) => item && typeof item === "object"));
}

async function readOpenclawGlobalConfig(api?: any) {
    try {
        const raw = await readFile(resolveOpenclawConfigPath({ api }), "utf8");
        const parsed = JSON5.parse(raw);
        return parsed && typeof parsed === "object"
            ? (parsed as Record<string, any>)
            : undefined;
    } catch {
        return undefined;
    }
}

async function discoverGatewayBaseUrls(api: any): Promise<string[]> {
    const urls = new Set<string>();
    const addUrl = (value: string | undefined) => {
        const normalized =
            normalizeBaseUrl(value) || websocketUrlToHttp(value);
        if (normalized) {
            urls.add(normalized);
        }
    };

    addUrl(api?.runtime?.gateway?.publicUrl);
    addUrl(api?.runtime?.gateway?.url);
    addUrl(api?.gateway?.publicUrl);
    addUrl(api?.gateway?.url);

    const globalConfig = await readOpenclawGlobalConfig(api);
    const gatewayConfig = globalConfig?.gateway;
    addUrl(gatewayConfig?.publicUrl);
    addUrl(gatewayConfig?.externalUrl);

    const allowedOrigins = gatewayConfig?.controlUi?.allowedOrigins;
    if (Array.isArray(allowedOrigins)) {
        for (const origin of allowedOrigins) {
            const normalized = normalizeBaseUrl(readString(origin));
            if (
                normalized &&
                !normalized.includes("://localhost") &&
                !normalized.includes("://127.0.0.1") &&
                !normalized.includes("://[::1]")
            ) {
                urls.add(normalized);
            }
        }
    }

    const customBindHost = readString(gatewayConfig?.customBindHost);
    const gatewayPort = clamp(
        Math.round(
            readNumber(gatewayConfig?.publicPort) ||
                readNumber(gatewayConfig?.port) ||
                18798
        ),
        1,
        65535
    );
    if (customBindHost) {
        urls.add(`http://${customBindHost}:${gatewayPort}`);
        if (gatewayPort === 443) {
            urls.add(`https://${customBindHost}`);
        }
    }

    return Array.from(urls);
}

async function resolvePluginConfig(
    api: any,
    options?: { stateDir?: string }
): Promise<PluginConfig> {
    const apiConfig = await readApiConfig(api);
    const env = process.env;
    const globalConfig = await readOpenclawGlobalConfig(api);
    const storageDir = resolvePluginStorageDir({
        api,
        serviceStateDir: options?.stateDir,
    });
    const defaultProfilePath = defaultStateStorePath(storageDir);

    const stateStorePath =
        pickFirstString(
            apiConfig.stateStorePath,
            env.XIAOAI_CLOUD_STATE_STORE,
            defaultProfilePath
        ) || defaultProfilePath;
    const defaultConsolePath = defaultConsoleStatePath(storageDir);
    const consoleStatePath =
        pickFirstString(
            apiConfig.consoleStatePath,
            env.XIAOAI_CLOUD_CONSOLE_STATE,
            defaultConsolePath
        ) || defaultConsolePath;

    const persisted = await loadPersistedProfile(stateStorePath);

    const account = pickFirstString(
        apiConfig.account,
        env.XIAOAI_CLOUD_ACCOUNT,
        env.MI_USER,
        persisted.account
    );

    const serverCountry =
        pickFirstString(
            apiConfig.serverCountry,
            env.XIAOAI_CLOUD_SERVER_COUNTRY,
            persisted.serverCountry,
            "cn"
        ) || "cn";

    const tokenStorePath =
        pickFirstString(
            apiConfig.tokenStorePath,
            env.XIAOAI_CLOUD_TOKEN_STORE,
            persisted.tokenStorePath,
            account
                ? defaultTokenStorePath(account, serverCountry, storageDir)
                : undefined
        ) || defaultTokenStorePath("anonymous", serverCountry, storageDir);
    const debugLogPath =
        pickFirstString(
            apiConfig.debugLogPath,
            env.XIAOAI_CLOUD_DEBUG_LOG,
            path.join(storageDir, "xiaomi-network.log")
        ) || path.join(storageDir, "xiaomi-network.log");
    const pythonCommand = pickFirstString(
        apiConfig.pythonCommand,
        env.XIAOAI_CLOUD_PYTHON
    );
    const openclawThinkingOff =
        readBoolean(apiConfig.openclawThinkingOff) ??
        readBoolean(env.XIAOAI_CLOUD_OPENCLAW_THINKING_OFF) ??
        readBoolean(persisted.openclawThinkingOff) ??
        true;
    const openclawForceNonStreaming =
        readBoolean(apiConfig.openclawForceNonStreaming) ??
        readBoolean(env.XIAOAI_CLOUD_OPENCLAW_FORCE_NON_STREAMING) ??
        readBoolean(persisted.openclawForceNonStreaming) ??
        false;
    const openclawVoiceSystemPrompt = normalizeOpenclawVoiceSystemPrompt(
        pickFirstString(
            apiConfig.openclawVoiceSystemPrompt,
            env.XIAOAI_CLOUD_OPENCLAW_VOICE_SYSTEM_PROMPT,
            persisted.openclawVoiceSystemPrompt
        ),
        { fallbackToDefault: true }
    );
    const transitionPhrases = normalizeTransitionPhrasesInput(
        apiConfig.transitionPhrases ??
            env.XIAOAI_CLOUD_TRANSITION_PHRASES ??
            persisted.transitionPhrases,
        { fallbackToDefault: true }
    );
    const debugLogEnabled =
        readBoolean(apiConfig.debugLogEnabled) ??
        readBoolean(env.XIAOAI_CLOUD_DEBUG_LOG_ENABLED) ??
        readBoolean(persisted.debugLogEnabled) ??
        DEFAULT_DEBUG_LOG_ENABLED;
    const voiceContextMaxTurns = clamp(
        Math.round(
            readNumber(apiConfig.voiceContextMaxTurns) ??
            readNumber(env.XIAOAI_CLOUD_VOICE_CONTEXT_MAX_TURNS) ??
            readNumber(persisted.voiceContextMaxTurns) ??
            DEFAULT_VOICE_CONTEXT_MAX_TURNS
        ),
        0,
        MAX_VOICE_CONTEXT_TURNS
    );
    const voiceContextMaxChars = clamp(
        Math.round(
            readNumber(apiConfig.voiceContextMaxChars) ??
            readNumber(env.XIAOAI_CLOUD_VOICE_CONTEXT_MAX_CHARS) ??
            readNumber(persisted.voiceContextMaxChars) ??
            DEFAULT_VOICE_CONTEXT_MAX_CHARS
        ),
        0,
        MAX_VOICE_CONTEXT_CHARS
    );
    const audioTailPaddingMs = normalizeAudioTailPaddingMs(
        readNumber(apiConfig.audioTailPaddingMs) ??
            readNumber(env.XIAOAI_CLOUD_AUDIO_TAIL_PADDING_MS) ??
            readNumber(persisted.audioTailPaddingMs)
    );
    const explicitOpenclawChannel = pickFirstString(
        apiConfig.openclawChannel,
        env.XIAOAI_CLOUD_OPENCLAW_CHANNEL
    );
    const explicitOpenclawTo = pickFirstString(
        apiConfig.openclawTo,
        env.XIAOAI_CLOUD_OPENCLAW_TO
    );
    const inferredOpenclawChannel = inferConfiguredOpenclawChannel(globalConfig);
    const openclawNotificationsDisabled =
        readBoolean(apiConfig.openclawNotificationsDisabled) ??
        readBoolean(env.XIAOAI_CLOUD_OPENCLAW_NOTIFICATIONS_DISABLED) ??
        (explicitOpenclawTo ? false : readBoolean(persisted.openclawNotificationsDisabled)) ??
        false;
    const resolvedOpenclawChannel =
        pickFirstString(
            explicitOpenclawChannel,
            persisted.openclawChannel,
            inferredOpenclawChannel,
            "telegram"
        ) || inferredOpenclawChannel || "telegram";
    const resolvedOpenclawTo =
        openclawNotificationsDisabled
            ? undefined
            : pickFirstString(
                explicitOpenclawTo,
                persisted.openclawTo
            ) || inferOpenclawNotificationTarget(globalConfig, resolvedOpenclawChannel);

    return {
        account,
        password: pickFirstString(
            apiConfig.password,
            env.XIAOAI_CLOUD_PASSWORD,
            env.MI_PASS
        ),
        serverCountry,
        hardware: pickFirstString(
            apiConfig.hardware,
            env.XIAOAI_CLOUD_HARDWARE,
            persisted.hardware
        ),
        speakerName: pickFirstString(
            apiConfig.speakerName,
            env.XIAOAI_CLOUD_SPEAKER_NAME,
            persisted.speakerName
        ),
        miDid: pickFirstString(
            apiConfig.miDid,
            env.XIAOAI_CLOUD_MI_DID,
            env.MI_DID,
            persisted.miDid
        ),
        minaDeviceId: pickFirstString(
            apiConfig.minaDeviceId,
            env.XIAOAI_CLOUD_MINA_DEVICE_ID,
            persisted.minaDeviceId
        ),
        tokenStorePath,
        stateStorePath,
        consoleStatePath,
        storageDir,
        debugLogPath,
        pythonCommand,
        pollIntervalMs: normalizePollIntervalMs(
            readNumber(apiConfig.pollIntervalMs) ??
                readNumber(env.XIAOAI_CLOUD_POLL_INTERVAL_MS) ??
                readNumber(persisted.conversationPollIntervalMs),
            DEFAULT_POLL_INTERVAL_MS
        ),
        authListenHost:
            pickFirstString(
                apiConfig.authListenHost,
                env.XIAOAI_CLOUD_AUTH_LISTEN_HOST,
                "0.0.0.0"
            ) || "0.0.0.0",
        authPort: clamp(
            Math.round(
                readNumber(apiConfig.authPort) ||
                readNumber(env.XIAOAI_CLOUD_AUTH_PORT) ||
                DEFAULT_AUTH_PORT
            ),
            1,
            65535
        ),
        authRoutePath: normalizeHttpPath(
            pickFirstString(
                apiConfig.authRoutePath,
                env.XIAOAI_CLOUD_AUTH_ROUTE_PATH,
                "/api/xiaoai-cloud"
            ),
            "/api/xiaoai-cloud"
        ),
        publicBaseUrl: pickFirstString(
            apiConfig.publicBaseUrl,
            env.XIAOAI_CLOUD_PUBLIC_BASE_URL
        ),
        audioPublicBaseUrl: pickFirstString(
            apiConfig.audioPublicBaseUrl,
            env.XIAOAI_CLOUD_AUDIO_PUBLIC_BASE_URL
        ),
        openclawAgent: pickFirstString(
            apiConfig.openclawAgent,
            env.XIAOAI_CLOUD_OPENCLAW_AGENT
        ),
        openclawChannel: resolvedOpenclawChannel,
        openclawTo: resolvedOpenclawTo,
        openclawNotificationsDisabled,
        openclawCliPath:
            pickFirstString(
                apiConfig.openclawCliPath,
                env.XIAOAI_CLOUD_OPENCLAW_CLI,
                "openclaw"
            ) || "openclaw",
        openclawThinkingOff,
        openclawForceNonStreaming,
        openclawVoiceSystemPrompt,
        transitionPhrases,
        debugLogEnabled,
        voiceContextMaxTurns,
        voiceContextMaxChars,
        wakeWordPattern: pickWakeWordPattern(
            apiConfig.wakeWordPattern,
            env.XIAOAI_CLOUD_WAKE_WORD_PATTERN,
            persisted.wakeWordPattern,
            DEFAULT_WAKE_WORD_PATTERN
        ),
        dialogWindowSeconds: clamp(
            Math.round(
                readNumber(apiConfig.dialogWindowSeconds) ||
                readNumber(env.XIAOAI_CLOUD_DIALOG_WINDOW_SECONDS) ||
                readNumber(persisted.dialogWindowSeconds) ||
                DEFAULT_DIALOG_WINDOW_SECONDS
            ),
            5,
            300
        ),
        audioTailPaddingMs,
    };
}

class XiaoaiCloudPlugin {
    private static sharedRecentSelfTriggeredQueries: RecentSelfTriggeredQuery[] = [];
    private readonly api: any;
    private initPromise?: Promise<void>;
    private config?: PluginConfig;
    private toolsRegistered = false;
    private serviceStateDir?: string;
    private loginPortal?: LoginPortal;
    private loginRouteRegisteredPath?: string;
    private loginSessionId?: string;
    private loginNotificationSessionId?: string;
    private startServicePromise?: Promise<void>;
    private consoleState?: {
        accessToken?: string;
        events?: ConsoleEventEntry[];
        audioPlaybackClearedAt?: string;
        speakerMuteStates?: Record<string, PersistedSpeakerMuteState>;
    };
    private consoleStateLoaded = false;
    private consoleStateWriteQueue: Promise<void> = Promise.resolve();
    private speakerControlMutationQueue: Promise<void> = Promise.resolve();
    private pendingAgentPromptCount = 0;
    private debugTraceSequence = 0;
    private readonly pendingVerifications = new Map<string, PendingVerificationContext>();
    private accountClient?: XiaomiAccountClient;
    private minaClient?: MiNAClient;
    private miioClient?: MiIOClient;
    private specClient?: MiotSpecClient;
    private device?: DeviceContext;
    private lastError?: string;
    private polling = false;
    private pollTimer?: NodeJS.Timeout;
    private lastConversationTimestamp = 0;
    private lastConversationRequestId = "";
    private lastConversationQuery = "";
    private currentMode: InterceptMode = "wake";
    private continuousDialogWindow = DEFAULT_DIALOG_WINDOW_SECONDS;
    private lastOpenclawSpeakTime = 0;
    private lastDialogWindowOpenedAt = 0;
    private lastNonZeroVolume = 15;
    private volumeMutationSequence = 0;
    private pendingVolumeState?: PendingVolumeState;
    private lastKnownVolumeSnapshot?: VolumeSnapshot;
    private waitingForResponse = false;
    private wakeWordPatternSource = DEFAULT_WAKE_WORD_PATTERN;
    private wakeWordRegex = new RegExp(DEFAULT_WAKE_WORD_PATTERN);
    private helperStatusCache?: {
        status?: XiaomiPythonRuntimeStatus;
        expiresAt: number;
    };
    private fastPollUntil = 0;
    private pollTransientBackoffStep = -1;
    private pollTransientBackoffFloorMs = 0;
    private pollTransientBackoffUntil = 0;
    private pollTransientBackoffReason?: "network" | "rate_limit";
    private pollingStartedAt = 0;
    private nextPollAt = 0;
    private pollLoopRunner?: () => void;
    private latestConversationFetchKey?: string;
    private latestConversationFetchPromise?: Promise<any | null>;
    private conversationFetchInflightCount = 0;
    private openclawVoiceSessionKey?: string;
    private openclawVoiceSessionExpiresAt = 0;
    private voiceContextTurns: VoiceContextTurn[] = [];
    private voiceContextArchiveSessionKey?: string;
    private voiceContextArchiveText = "";
    private activeVoiceAgentRuns: ActiveVoiceAgentRun[] = [];
    private lastOpenclawSpeech?: RecentOpenclawSpeech;
    private recentSelfTriggeredQueries: RecentSelfTriggeredQuery[] = [];
    private openclawGatewayClient?: GatewayClientLike;
    private openclawGatewayClientReady?: Promise<GatewayClientLike>;
    private notificationChannelUnavailableUntil = 0;
    private notificationChannelUnavailableMessage = "";
    private pendingGatewayRestart = false;
    private readonly audioRelayEntries = new Map<string, AudioRelayEntry>();
    private readonly audioPlaybackCapability = new Map<string, AudioPlaybackCapabilityEntry>();
    private readonly externalAudioLoopGuards = new Map<string, ExternalAudioLoopGuard>();
    private readonly speakerAudioLatencyProfiles = new Map<string, SpeakerAudioLatencyProfile>();
    private readonly conversationFetchLatencyProfiles = new Map<
        string,
        ConversationFetchLatencyProfile
    >();
    private readonly conversationInterceptLatencyProfiles = new Map<
        string,
        ConversationInterceptLatencyProfile
    >();
    private readonly conversationInterceptRuntimeStates = new Map<
        string,
        ConversationInterceptRuntimeState
    >();
    private calibrationProfilesHydrated = false;
    private audioCalibrationRunning = false;
    private conversationInterceptCalibrationRunning = false;
    private activeSpeakerAudioCalibrationDeviceId?: string;
    private activeSpeakerAudioCalibrationSamples?: Partial<
        Record<SpeakerAudioLatencyKey, number[]>
    >;
    private activeConversationCalibrationDeviceId?: string;
    private activeConversationCalibrationSamples?: Partial<
        Record<ConversationInterceptLatencyKey, number[]>
    >;
    private lastAudioCalibration?: PersistedAudioCalibrationSummary;
    private lastConversationInterceptCalibration?: PersistedConversationInterceptCalibrationSummary;
    private readonly ttsBridgeInflightAssets = new Map<string, Promise<GeneratedAudioAsset>>();
    private ffmpegAvailable?: boolean;
    private ffmpegAvailabilityProbe?: Promise<boolean>;
    private ffmpegAvailabilityExpiresAt = 0;

    constructor(api: any) {
        this.api = api;
    }

    registerTools() {
        if (this.toolsRegistered) {
            return;
        }
        this.toolsRegistered = true;
        this.registerPluginTools();
    }

    start() {
        void this.startService();
    }

    async startService(ctx?: { stateDir?: string }) {
        this.serviceStateDir = readString(ctx?.stateDir);
        if (this.startServicePromise) {
            return this.startServicePromise;
        }

        this.startServicePromise = (async () => {
            this.registerTools();
            try {
                const config = await this.loadConfig(false);
                this.ensureGatewayRouteRegistered(config);
            } catch (error) {
                console.error(
                    `[XiaoAI Cloud] 控制台路由初始化失败: ${this.errorMessage(error)}`
                );
            }
            this.ensureReady()
                .then(() => this.startPolling())
                .catch((error) => {
                    this.lastError = this.errorMessage(error);
                    this.reportInitializationOutcome(error);
                });
        })().catch((error) => {
            this.startServicePromise = undefined;
            throw error;
        });

        return this.startServicePromise;
    }

    async stopService() {
        this.stopPolling();
        await this.stopOpenclawGatewayClient();
        this.initPromise = undefined;
        this.config = undefined;
        this.accountClient = undefined;
        this.minaClient = undefined;
        this.miioClient = undefined;
        this.specClient = undefined;
        this.device = undefined;
        this.lastConversationTimestamp = 0;
        this.lastConversationRequestId = "";
        this.lastConversationQuery = "";
        this.latestConversationFetchKey = undefined;
        this.latestConversationFetchPromise = undefined;
        this.clearInterceptWindowState();
        this.wakeWordPatternSource = DEFAULT_WAKE_WORD_PATTERN;
        this.wakeWordRegex = new RegExp(DEFAULT_WAKE_WORD_PATTERN);
        this.continuousDialogWindow = DEFAULT_DIALOG_WINDOW_SECONDS;
        this.serviceStateDir = undefined;
        this.pendingVerifications.clear();
        this.pendingVolumeState = undefined;
        this.lastKnownVolumeSnapshot = undefined;
        this.consoleState = undefined;
        this.consoleStateLoaded = false;
        this.helperStatusCache = undefined;
        this.pendingGatewayRestart = false;
        this.fastPollUntil = 0;
        this.nextPollAt = 0;
        this.pollLoopRunner = undefined;
        this.voiceContextTurns = [];
        this.voiceContextArchiveSessionKey = undefined;
        this.voiceContextArchiveText = "";
        this.clearAllExternalAudioLoopGuards();

        if (this.loginPortal) {
            await this.loginPortal.stop();
            this.loginPortal = undefined;
        }

        this.activeVoiceAgentRuns = [];
        this.pendingAgentPromptCount = 0;
        this.startServicePromise = undefined;

        this.loginSessionId = undefined;
        this.loginNotificationSessionId = undefined;
        this.loginRouteRegisteredPath = undefined;
    }

    private errorMessage(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }
        return String(error);
    }

    private isTransientNetworkError(message: string): boolean {
        const lower = message.toLowerCase();
        return [
            "fetch failed",
            "etimedout",
            "econnreset",
            "eai_again",
            "enotfound",
            "econnrefused",
            "timeout",
            "socket hang up",
            "network error",
        ].some((keyword) => lower.includes(keyword));
    }

    private isRateLimitedNetworkError(message: string): boolean {
        const lower = message.toLowerCase();
        return [
            "http 429",
            "429 too many",
            "too many requests",
            "rate limit",
            "rate limited",
            "throttle",
            "throttled",
            "限频",
            "限流",
            "频率",
        ].some((keyword) => lower.includes(keyword));
    }

    private clearPollTransientBackoff() {
        this.pollTransientBackoffStep = -1;
        this.pollTransientBackoffFloorMs = 0;
        this.pollTransientBackoffUntil = 0;
        this.pollTransientBackoffReason = undefined;
    }

    private currentPollTransientBackoffFloorMs(nowMs = Date.now()) {
        if (
            this.pollTransientBackoffFloorMs <= 0 ||
            this.pollTransientBackoffUntil <= nowMs
        ) {
            this.clearPollTransientBackoff();
            return 0;
        }
        return this.pollTransientBackoffFloorMs;
    }

    private notePollTransientBackoff(message: string) {
        const nowMs = Date.now();
        const rateLimited = this.isRateLimitedNetworkError(message);
        let floorMs = 0;
        let untilMs = 0;

        if (rateLimited) {
            this.pollTransientBackoffStep = Math.max(
                this.pollTransientBackoffStep,
                POLL_TRANSIENT_BACKOFF_STEPS_MS.length - 1
            );
            floorMs = Math.max(
                this.currentPollTransientBackoffFloorMs(nowMs),
                POLL_RATE_LIMIT_BACKOFF_MS
            );
            untilMs = Math.max(
                this.pollTransientBackoffUntil,
                nowMs + POLL_RATE_LIMIT_BACKOFF_WINDOW_MS
            );
            this.pollTransientBackoffReason = "rate_limit";
        } else {
            this.pollTransientBackoffStep = clamp(
                this.pollTransientBackoffStep + 1,
                0,
                POLL_TRANSIENT_BACKOFF_STEPS_MS.length - 1
            );
            floorMs = Math.max(
                this.currentPollTransientBackoffFloorMs(nowMs),
                POLL_TRANSIENT_BACKOFF_STEPS_MS[this.pollTransientBackoffStep] || 0
            );
            untilMs = Math.max(
                this.pollTransientBackoffUntil,
                nowMs +
                    Math.max(
                        POLL_TRANSIENT_BACKOFF_WINDOW_MS,
                        floorMs * 8
                    )
            );
            this.pollTransientBackoffReason = "network";
        }

        this.pollTransientBackoffFloorMs = floorMs;
        this.pollTransientBackoffUntil = untilMs;
        return {
            floorMs,
            untilMs,
            reason: this.pollTransientBackoffReason,
            rateLimited,
        };
    }

    private isLoginPreparationError(message: string) {
        const lower = message.toLowerCase();
        return (
            lower.includes("requires password login") ||
            lower.includes("not authenticated") ||
            lower.includes("token store is not ready") ||
            lower.includes("xiaomi sid") ||
            lower.includes("xiaomi login failed") ||
            message.includes("请输入小米账号") ||
            message.includes("请输入小米账号密码") ||
            message.includes("当前账号下没有发现可用的小爱音箱") ||
            message.includes("无法从小爱设备列表中定位目标音箱") ||
            message.includes("无法确定音箱 hardware") ||
            message.includes("无法确定音箱 DID") ||
            message.includes("小爱云后端尚未初始化")
        );
    }

    private reportInitializationOutcome(error: unknown) {
        const message = this.errorMessage(error);
        const session = this.getLoginSessionSnapshot();
        if (
            this.isDeviceSelectionRequiredMessage(message) &&
            this.lastError === "账号已登录，请先在概览页选择要接管的音箱。"
        ) {
            console.warn("[XiaoAI Cloud] 账号已登录，等待在控制台选择设备。");
            return;
        }
        if (session && this.isLoginPreparationError(message)) {
            console.warn(
                `[XiaoAI Cloud] 当前还未完成登录或设备选择，登录入口已准备好: ${session.primaryUrl}`
            );
            return;
        }
        console.error(`[XiaoAI Cloud] 初始化失败: ${message}`);
    }

    private isDeviceSelectionRequiredMessage(message: string) {
        return (
            message.includes("无法从小爱设备列表中定位目标音箱") ||
            message.includes("无法确定音箱 hardware") ||
            message.includes("无法确定音箱 DID")
        );
    }

    private hasDeviceSelectionSeed(
        value?: Partial<Pick<PluginConfig, "hardware" | "speakerName" | "miDid" | "minaDeviceId">>
    ) {
        return Boolean(
            pickFirstString(
                value?.minaDeviceId,
                value?.miDid,
                value?.speakerName,
                value?.hardware
            )
        );
    }

    private async hasPersistedAccountSession(config?: PluginConfig) {
        const resolvedConfig = config || (await this.loadConfig(false));
        const accountClient =
            this.accountClient ||
            new XiaomiAccountClient({
                username: resolvedConfig.account || "status-only",
                tokenStorePath: resolvedConfig.tokenStorePath,
                debugLogPath: resolvedConfig.debugLogPath,
                debugLogEnabled: resolvedConfig.debugLogEnabled,
                pythonCommand: resolvedConfig.pythonCommand,
            });
        await accountClient.loadTokenStore();
        return Boolean(
            accountClient.getSidToken("micoapi") ||
            accountClient.getSidToken("xiaomiio") ||
            accountClient.getUserId()
        );
    }

    private async appendDebugTrace(event: string, details: Record<string, any>) {
        try {
            const config =
                this.config ||
                (await this.loadConfig(false).catch(() => undefined));
            const debugLogEnabled = config?.debugLogEnabled ?? DEFAULT_DEBUG_LOG_ENABLED;
            const debugLogPath =
                config?.debugLogPath ||
                path.join(
                    resolvePluginStorageDir({
                        api: this.api,
                        serviceStateDir: this.serviceStateDir,
                    }),
                    "xiaomi-network.log"
                );
            if (!debugLogEnabled || !debugLogPath) {
                return;
            }
            const traceDetails = {
                source: "provider",
                seq: ++this.debugTraceSequence,
                ...details,
            };
            const tracer =
                this.accountClient ||
                new XiaomiAccountClient({
                    username: config?.account || "trace-only",
                    tokenStorePath: config?.tokenStorePath,
                    debugLogPath,
                    debugLogEnabled,
                    pythonCommand: config?.pythonCommand,
                });
            try {
                await tracer.traceEvent(event, traceDetails);
                return;
            } catch {
                await mkdir(path.dirname(debugLogPath), { recursive: true });
                await writeFile(
                    debugLogPath,
                    `${JSON.stringify({
                        ts: new Date().toISOString(),
                        seq: traceDetails.seq,
                        event,
                        details: traceDetails,
                    })}\n`,
                    { encoding: "utf8", flag: "a" }
                );
            }
        } catch {
            // Ignore provider trace failures to avoid breaking runtime behavior.
        }
    }

    private normalizeSpeakerAudioLatencyProfile(
        value: any
    ): SpeakerAudioLatencyProfile | undefined {
        if (!value || typeof value !== "object") {
            return undefined;
        }
        const next: SpeakerAudioLatencyProfile = {
            updatedAtMs: Math.max(
                0,
                Math.round(readNumber(value.updatedAtMs) || Date.now())
            ),
        };
        let hasEstimate = false;
        ([
            "statusProbeEstimateMs",
            "pauseCommandEstimateMs",
            "pauseSettleEstimateMs",
            "stopSettleEstimateMs",
            "playbackDetectEstimateMs",
        ] as const).forEach((key) => {
            const estimate = readNumber(value[key]);
            if (
                typeof estimate === "number" &&
                Number.isFinite(estimate) &&
                estimate > 0
            ) {
                next[key] = clamp(Math.round(estimate), 1, 10_000);
                hasEstimate = true;
            }
        });
        return hasEstimate ? next : undefined;
    }

    private serializeSpeakerAudioLatencyProfileForPersistence(
        profile?: SpeakerAudioLatencyProfile | null
    ): PersistedSpeakerAudioLatencyProfile | undefined {
        const normalized = this.normalizeSpeakerAudioLatencyProfile(profile);
        if (!normalized) {
            return undefined;
        }
        return {
            statusProbeEstimateMs: normalized.statusProbeEstimateMs,
            pauseCommandEstimateMs: normalized.pauseCommandEstimateMs,
            pauseSettleEstimateMs: normalized.pauseSettleEstimateMs,
            stopSettleEstimateMs: normalized.stopSettleEstimateMs,
            playbackDetectEstimateMs: normalized.playbackDetectEstimateMs,
            updatedAtMs: normalized.updatedAtMs,
        };
    }

    private buildConsoleSpeakerAudioLatencyProfile(
        profile?: SpeakerAudioLatencyProfile | null
    ): ConsoleSpeakerAudioLatencyProfile | undefined {
        const normalized = this.normalizeSpeakerAudioLatencyProfile(profile);
        if (!normalized) {
            return undefined;
        }
        return {
            statusProbeEstimateMs: normalized.statusProbeEstimateMs,
            pauseCommandEstimateMs: normalized.pauseCommandEstimateMs,
            pauseSettleEstimateMs: normalized.pauseSettleEstimateMs,
            stopSettleEstimateMs: normalized.stopSettleEstimateMs,
            playbackDetectEstimateMs: normalized.playbackDetectEstimateMs,
            updatedAt:
                normalized.updatedAtMs > 0
                    ? new Date(normalized.updatedAtMs).toISOString()
                    : undefined,
        };
    }

    private buildConsoleAudioCalibrationPrompt(
        device?: DeviceContext | null
    ): ConsoleCalibrationPrompt | undefined {
        const deviceId = readString(device?.minaDeviceId);
        if (!deviceId) {
            return undefined;
        }
        const deviceName = readString(device?.name) || deviceId;
        const currentProfile = this.readSpeakerAudioLatencyProfile(deviceId);
        const lastRun = this.lastAudioCalibration;
        const lastRunDeviceId = readString(lastRun?.deviceId);
        if (!currentProfile) {
            return {
                state: "missing",
                title: "当前设备还没做音频校准",
                detail: `${deviceName} 还没有音频时序画像，建议先跑一遍音频时序校准。`,
            };
        }
        if (lastRunDeviceId !== deviceId) {
            return {
                state: "recalibrate",
                title: "当前设备建议重跑音频校准",
                detail: lastRunDeviceId
                    ? `最近一次完整音频校准属于另一台设备，切换到 ${deviceName} 后建议重跑。`
                    : `${deviceName} 目前只有历史画像，缺少当前设备的完整音频校准摘要，建议重跑。`,
            };
        }
        return undefined;
    }

    private serializeSpeakerAudioLatencyProfilesForPersistence() {
        const entries = Array.from(this.speakerAudioLatencyProfiles.entries())
            .map(([deviceId, profile]) => {
                const normalizedDeviceId = readString(deviceId);
                const normalizedProfile =
                    this.serializeSpeakerAudioLatencyProfileForPersistence(profile);
                if (!normalizedDeviceId || !normalizedProfile) {
                    return undefined;
                }
                return [normalizedDeviceId, normalizedProfile] as const;
            })
            .filter(Boolean) as Array<
            readonly [string, PersistedSpeakerAudioLatencyProfile]
        >;
        return entries.length > 0 ? Object.fromEntries(entries) : undefined;
    }

    private normalizePersistedAudioCalibrationSummary(
        value: any
    ): PersistedAudioCalibrationSummary | undefined {
        if (!value || typeof value !== "object") {
            return undefined;
        }
        const latencyProfile = this.serializeSpeakerAudioLatencyProfileForPersistence(
            value.latencyProfile
        );
        const rounds = readNumber(value.rounds);
        const successCount = readNumber(value.successCount);
        const failureCount = readNumber(value.failureCount);
        const tailPaddingMs = readNumber(value.tailPaddingMs);
        const summary: PersistedAudioCalibrationSummary = {
            deviceId: readString(value.deviceId) || undefined,
            deviceName: readString(value.deviceName) || undefined,
            rounds:
                typeof rounds === "number" && Number.isFinite(rounds) && rounds > 0
                    ? Math.max(1, Math.round(rounds))
                    : undefined,
            successCount:
                typeof successCount === "number" &&
                Number.isFinite(successCount) &&
                successCount >= 0
                    ? Math.max(0, Math.round(successCount))
                    : undefined,
            failureCount:
                typeof failureCount === "number" &&
                Number.isFinite(failureCount) &&
                failureCount >= 0
                    ? Math.max(0, Math.round(failureCount))
                    : undefined,
            tailPaddingMs:
                typeof tailPaddingMs === "number" &&
                Number.isFinite(tailPaddingMs) &&
                tailPaddingMs >= 0
                    ? Math.max(0, Math.round(tailPaddingMs))
                    : undefined,
            startedAt: readString(value.startedAt) || undefined,
            completedAt: readString(value.completedAt) || undefined,
            lastError: readString(value.lastError) || undefined,
            latencyProfile,
        };
        return Object.values(summary).some((item) => item !== undefined)
            ? summary
            : undefined;
    }

    private normalizeConversationInterceptLatencyProfile(
        value: any
    ): ConversationInterceptLatencyProfile | undefined {
        if (!value || typeof value !== "object") {
            return undefined;
        }
        const next: ConversationInterceptLatencyProfile = {
            updatedAtMs: Math.max(
                0,
                Math.round(readNumber(value.updatedAtMs) || Date.now())
            ),
        };
        let hasEstimate = false;
        ([
            "conversationVisibleEstimateMs",
            "nativePlaybackStartEstimateMs",
            "interceptLeadEstimateMs",
        ] as const).forEach((key) => {
            const estimate = readNumber(value[key]);
            if (
                typeof estimate === "number" &&
                Number.isFinite(estimate) &&
                estimate > 0
            ) {
                next[key] = clamp(Math.round(estimate), 1, 20_000);
                hasEstimate = true;
            }
        });
        const manualOffsetMs = readNumber(value.manualOffsetMs);
        if (typeof manualOffsetMs === "number" && Number.isFinite(manualOffsetMs)) {
            next.manualOffsetMs = normalizeConversationInterceptManualOffsetMs(
                manualOffsetMs
            );
            hasEstimate = true;
        }
        return hasEstimate ? next : undefined;
    }

    private serializeConversationInterceptLatencyProfileForPersistence(
        profile?: ConversationInterceptLatencyProfile | null
    ): PersistedConversationInterceptLatencyProfile | undefined {
        const normalized = this.normalizeConversationInterceptLatencyProfile(profile);
        if (!normalized) {
            return undefined;
        }
        return {
            conversationVisibleEstimateMs:
                normalized.conversationVisibleEstimateMs,
            nativePlaybackStartEstimateMs:
                normalized.nativePlaybackStartEstimateMs,
            interceptLeadEstimateMs: normalized.interceptLeadEstimateMs,
            manualOffsetMs: normalized.manualOffsetMs,
            updatedAtMs: normalized.updatedAtMs,
        };
    }

    private buildConsoleConversationInterceptLatencyProfile(
        profile?: ConversationInterceptLatencyProfile | null
    ): ConsoleConversationInterceptLatencyProfile | undefined {
        const normalized = this.normalizeConversationInterceptLatencyProfile(profile);
        if (!normalized) {
            return undefined;
        }
        return {
            conversationVisibleEstimateMs:
                normalized.conversationVisibleEstimateMs,
            nativePlaybackStartEstimateMs:
                normalized.nativePlaybackStartEstimateMs,
            interceptLeadEstimateMs: normalized.interceptLeadEstimateMs,
            manualOffsetMs: normalized.manualOffsetMs,
            updatedAt:
                normalized.updatedAtMs > 0
                    ? new Date(normalized.updatedAtMs).toISOString()
                    : undefined,
        };
    }

    private buildConsoleConversationInterceptCalibrationSummary(
        summary?: PersistedConversationInterceptCalibrationSummary | null
    ): PersistedConversationInterceptCalibrationSummary | undefined {
        if (!summary) {
            return undefined;
        }
        const rawStrategy = readString(summary.strategy);
        const strategy: PersistedConversationInterceptCalibrationSummary["strategy"] =
            rawStrategy === "observable" ||
            rawStrategy === "fallback-only" ||
            rawStrategy === "mixed"
                ? rawStrategy
                : this.classifyConversationInterceptCalibrationStrategy(summary);
        return strategy
            ? {
                ...summary,
                strategy,
            }
            : summary;
    }

    private buildConsoleConversationInterceptCalibrationPrompt(
        device?: DeviceContext | null
    ): ConsoleCalibrationPrompt | undefined {
        const deviceId = readString(device?.minaDeviceId);
        if (!deviceId) {
            return undefined;
        }
        const deviceName = readString(device?.name) || deviceId;
        const currentProfile =
            this.readConversationInterceptLatencyProfile(deviceId);
        const lastRun = this.lastConversationInterceptCalibration;
        const lastRunDeviceId = readString(lastRun?.deviceId);
        if (!currentProfile) {
            return {
                state: "missing",
                title: "当前设备还没做对话校准",
                detail: `${deviceName} 还没有对话拦截画像，建议先跑一遍对话拦截校准，确认这台设备的拦截策略。`,
            };
        }
        if (lastRunDeviceId !== deviceId) {
            return {
                state: "recalibrate",
                title: "当前设备建议重跑对话校准",
                detail: lastRunDeviceId
                    ? `最近一次完整对话拦截校准属于另一台设备，切换到 ${deviceName} 后不要沿用上一台的结果。`
                    : `${deviceName} 目前只有历史画像，缺少当前设备的完整对话拦截校准摘要，建议重跑。`,
            };
        }
        return undefined;
    }

    private async runRequestedCalibration(
        mode: "audio" | "conversation" | "all"
    ) {
        const { device } = await this.ensureActionContext();
        const audioPrompt = this.buildConsoleAudioCalibrationPrompt(device);
        const conversationPrompt =
            this.buildConsoleConversationInterceptCalibrationPrompt(device);
        const audioRequested = mode === "audio" || mode === "all";
        const conversationRequested =
            mode === "conversation" || mode === "all";
        const runAudio =
            audioRequested ||
            (!audioRequested &&
                conversationRequested &&
                Boolean(audioPrompt));
        const runConversation =
            conversationRequested ||
            (!conversationRequested &&
                audioRequested &&
                Boolean(conversationPrompt));
        const busyParts: string[] = [];
        if (runAudio && this.audioCalibrationRunning) {
            busyParts.push("音频时序校准");
        }
        if (
            runConversation &&
            this.conversationInterceptCalibrationRunning
        ) {
            busyParts.push("对话拦截校准");
        }
        let audio:
            | PersistedAudioCalibrationSummary
            | undefined;
        let conversation:
            | PersistedConversationInterceptCalibrationSummary
            | undefined;
        let audioError: string | undefined;
        let conversationError: string | undefined;

        if (busyParts.length === 0) {
            if (runAudio) {
                try {
                    audio = await this.runSpeakerAudioCalibration();
                } catch (error) {
                    audioError =
                        this.errorMessage(error) || "音频时序校准失败。";
                }
            }
            if (runConversation) {
                try {
                    conversation =
                        await this.runConversationInterceptCalibration();
                } catch (error) {
                    conversationError =
                        this.errorMessage(error) || "对话拦截校准失败。";
                }
            }
        }

        return {
            requestedMode: mode,
            deviceId: device.minaDeviceId,
            deviceName: device.name,
            runAudio,
            runConversation,
            autoIncludedAudio: runAudio && !audioRequested,
            autoIncludedConversation:
                runConversation && !conversationRequested,
            busyMessage:
                busyParts.length > 0
                    ? `${busyParts.join("和")}正在进行中，请稍后再试。`
                    : undefined,
            audio,
            conversation,
            audioError,
            conversationError,
        };
    }

    private buildCalibrationOutcomeMessage(
        result: Awaited<ReturnType<XiaoaiCloudPlugin["runRequestedCalibration"]>>
    ) {
        const completed: string[] = [];
        const failed: string[] = [];
        if (result.audio) {
            completed.push(
                result.autoIncludedAudio
                    ? "音频时序校准（已补跑）"
                    : "音频时序校准"
            );
        } else if (result.runAudio && result.audioError) {
            failed.push(`音频时序校准失败：${result.audioError}`);
        }
        if (result.conversation) {
            completed.push(
                result.autoIncludedConversation
                    ? "对话拦截校准（已补跑）"
                    : "对话拦截校准"
            );
        } else if (result.runConversation && result.conversationError) {
            failed.push(`对话拦截校准失败：${result.conversationError}`);
        }
        const parts: string[] = [];
        if (completed.length > 0) {
            parts.push(`${completed.join("、")}已完成`);
        }
        if (failed.length > 0) {
            parts.push(failed.join("；"));
        }
        return {
            ok: completed.length > 0 && failed.length === 0,
            message:
                parts.length > 0
                    ? `${parts.join("；")}。`
                    : "没有执行任何校准。",
        };
    }

    private buildAudioCalibrationCompletionText(
        calibration: PersistedAudioCalibrationSummary,
        label = "音频时序校准"
    ) {
        const successCount = readNumber(calibration.successCount) || 0;
        const rounds = readNumber(calibration.rounds) || 0;
        const tailPaddingMs = readNumber(calibration.tailPaddingMs);
        return (
            `${label}完成。\n` +
            `成功轮次: ${successCount}/${rounds || successCount}\n` +
            (typeof tailPaddingMs === "number"
                ? `当前空余延迟: ${tailPaddingMs}ms\n`
                : "") +
            (calibration.lastError
                ? `最后错误: ${calibration.lastError}`
                : "没有新的异常。")
        );
    }

    private buildConversationCalibrationCompletionText(
        calibration: PersistedConversationInterceptCalibrationSummary,
        label = "对话拦截校准"
    ) {
        const successCount = readNumber(calibration.successCount) || 0;
        const rounds = readNumber(calibration.rounds) || 0;
        const strategy =
            readString(calibration.strategy) ||
            this.classifyConversationInterceptCalibrationStrategy(
                calibration
            );
        const pollIntervalMs = readNumber(calibration.pollIntervalMs);
        const recommendedPollIntervalMs = readNumber(
            calibration.recommendedPollIntervalMs
        );
        return (
            `${label}完成。\n` +
            `成功轮次: ${successCount}/${rounds || successCount}\n` +
            (strategy ? `校准策略: ${strategy}\n` : "") +
            (typeof pollIntervalMs === "number"
                ? `当前轮询间隔: ${pollIntervalMs}ms\n`
                : "") +
            (typeof recommendedPollIntervalMs === "number"
                ? `建议轮询间隔: ${recommendedPollIntervalMs}ms\n`
                : "") +
            (calibration.lastError
                ? `最后错误: ${calibration.lastError}`
                : "没有新的异常。")
        );
    }

    private serializeConversationInterceptLatencyProfilesForPersistence() {
        const entries = Array.from(this.conversationInterceptLatencyProfiles.entries())
            .map(([deviceId, profile]) => {
                const normalizedDeviceId = readString(deviceId);
                const normalizedProfile =
                    this.serializeConversationInterceptLatencyProfileForPersistence(
                        profile
                    );
                if (!normalizedDeviceId || !normalizedProfile) {
                    return undefined;
                }
                return [normalizedDeviceId, normalizedProfile] as const;
            })
            .filter(Boolean) as Array<
            readonly [string, PersistedConversationInterceptLatencyProfile]
        >;
        return entries.length > 0 ? Object.fromEntries(entries) : undefined;
    }

    private normalizePersistedConversationInterceptCalibrationSummary(
        value: any
    ): PersistedConversationInterceptCalibrationSummary | undefined {
        if (!value || typeof value !== "object") {
            return undefined;
        }
        const latencyProfile =
            this.serializeConversationInterceptLatencyProfileForPersistence(
                value.latencyProfile
            );
        const rounds = readNumber(value.rounds);
        const successCount = readNumber(value.successCount);
        const failureCount = readNumber(value.failureCount);
        const fallbackRounds = readNumber(value.fallbackRounds);
        const rawStrategy = readString(value.strategy);
        const strategy: PersistedConversationInterceptCalibrationSummary["strategy"] =
            rawStrategy === "observable" ||
            rawStrategy === "fallback-only" ||
            rawStrategy === "mixed"
                ? rawStrategy
                : undefined;
        const pollIntervalMs = readNumber(value.pollIntervalMs);
        const recommendedPollIntervalMs = readNumber(value.recommendedPollIntervalMs);
        const summary: PersistedConversationInterceptCalibrationSummary = {
            deviceId: readString(value.deviceId) || undefined,
            deviceName: readString(value.deviceName) || undefined,
            rounds:
                typeof rounds === "number" && Number.isFinite(rounds) && rounds > 0
                    ? Math.max(1, Math.round(rounds))
                    : undefined,
            successCount:
                typeof successCount === "number" &&
                Number.isFinite(successCount) &&
                successCount >= 0
                    ? Math.max(0, Math.round(successCount))
                    : undefined,
            failureCount:
                typeof failureCount === "number" &&
                Number.isFinite(failureCount) &&
                failureCount >= 0
                    ? Math.max(0, Math.round(failureCount))
                    : undefined,
            fallbackRounds:
                typeof fallbackRounds === "number" &&
                Number.isFinite(fallbackRounds) &&
                fallbackRounds >= 0
                    ? Math.max(0, Math.round(fallbackRounds))
                    : undefined,
            strategy:
                strategy === "observable" ||
                strategy === "fallback-only" ||
                strategy === "mixed"
                    ? strategy
                    : undefined,
            pollIntervalMs:
                typeof pollIntervalMs === "number" && Number.isFinite(pollIntervalMs)
                    ? normalizePollIntervalMs(pollIntervalMs)
                    : undefined,
            recommendedPollIntervalMs:
                typeof recommendedPollIntervalMs === "number" &&
                Number.isFinite(recommendedPollIntervalMs)
                    ? normalizePollIntervalMs(recommendedPollIntervalMs)
                    : undefined,
            startedAt: readString(value.startedAt) || undefined,
            completedAt: readString(value.completedAt) || undefined,
            lastError: readString(value.lastError) || undefined,
            latencyProfile,
        };
        return Object.values(summary).some((item) => item !== undefined)
            ? summary
            : undefined;
    }

    private classifyConversationInterceptCalibrationStrategy(
        summary?: Pick<
            PersistedConversationInterceptCalibrationSummary,
            "successCount" | "fallbackRounds"
        > | null
    ): "observable" | "fallback-only" | "mixed" | undefined {
        const successCount = readNumber(summary?.successCount) || 0;
        const fallbackRounds = readNumber(summary?.fallbackRounds) || 0;
        if (successCount <= 0) {
            return undefined;
        }
        if (fallbackRounds <= 0) {
            return "observable";
        }
        if (fallbackRounds >= successCount) {
            return "fallback-only";
        }
        return "mixed";
    }

    private async hydratePersistedAudioCalibrationState(config: PluginConfig) {
        if (this.calibrationProfilesHydrated) {
            return;
        }
        this.calibrationProfilesHydrated = true;
        const persisted = (await loadPersistedProfile(config.stateStorePath).catch(
            () => ({})
        )) as Record<string, any>;
        const latencyProfiles =
            persisted.speakerAudioLatencyProfiles &&
            typeof persisted.speakerAudioLatencyProfiles === "object" &&
            !Array.isArray(persisted.speakerAudioLatencyProfiles)
                ? persisted.speakerAudioLatencyProfiles
                : undefined;
        if (latencyProfiles) {
            Object.entries(latencyProfiles).forEach(([deviceId, profile]) => {
                const normalizedDeviceId = readString(deviceId);
                const normalizedProfile = this.normalizeSpeakerAudioLatencyProfile(profile);
                if (normalizedDeviceId && normalizedProfile) {
                    this.speakerAudioLatencyProfiles.set(
                        normalizedDeviceId,
                        normalizedProfile
                    );
                }
            });
        }
        const interceptLatencyProfiles =
            persisted.conversationInterceptLatencyProfiles &&
            typeof persisted.conversationInterceptLatencyProfiles === "object" &&
            !Array.isArray(persisted.conversationInterceptLatencyProfiles)
                ? persisted.conversationInterceptLatencyProfiles
                : undefined;
        if (interceptLatencyProfiles) {
            Object.entries(interceptLatencyProfiles).forEach(([deviceId, profile]) => {
                const normalizedDeviceId = readString(deviceId);
                const normalizedProfile =
                    this.normalizeConversationInterceptLatencyProfile(profile);
                if (normalizedDeviceId && normalizedProfile) {
                    this.conversationInterceptLatencyProfiles.set(
                        normalizedDeviceId,
                        normalizedProfile
                    );
                }
            });
        }
        this.lastAudioCalibration = this.normalizePersistedAudioCalibrationSummary(
            persisted.lastAudioCalibration
        );
        this.lastConversationInterceptCalibration =
            this.normalizePersistedConversationInterceptCalibrationSummary(
                persisted.lastConversationInterceptCalibration
            );
    }

    private buildPersistedProfile(
        config: PluginConfig,
        device?: DeviceContext
    ) {
        return {
            account: config.account,
            serverCountry: config.serverCountry,
            hardware: device?.hardware || config.hardware,
            speakerName: pickFirstString(config.speakerName, device?.name),
            miDid: device?.miDid || config.miDid,
            minaDeviceId: device?.minaDeviceId || config.minaDeviceId,
            tokenStorePath: config.tokenStorePath,
            openclawChannel: config.openclawChannel,
            openclawTo: config.openclawTo,
            openclawNotificationsDisabled: config.openclawNotificationsDisabled,
            wakeWordPattern: config.wakeWordPattern,
            dialogWindowSeconds: config.dialogWindowSeconds,
            openclawThinkingOff: config.openclawThinkingOff,
            openclawForceNonStreaming: config.openclawForceNonStreaming,
            openclawVoiceSystemPrompt:
                config.openclawVoiceSystemPrompt === DEFAULT_XIAOAI_AGENT_WORKSPACE_PROMPT
                    ? undefined
                    : config.openclawVoiceSystemPrompt,
            transitionPhrases:
                JSON.stringify(config.transitionPhrases || []) ===
                JSON.stringify(DEFAULT_TRANSITION_PHRASES)
                    ? undefined
                    : config.transitionPhrases,
            debugLogEnabled: config.debugLogEnabled,
            voiceContextMaxTurns: config.voiceContextMaxTurns,
            voiceContextMaxChars: config.voiceContextMaxChars,
            audioTailPaddingMs: config.audioTailPaddingMs,
            conversationPollIntervalMs: config.pollIntervalMs,
            speakerAudioLatencyProfiles:
                this.serializeSpeakerAudioLatencyProfilesForPersistence(),
            lastAudioCalibration: this.lastAudioCalibration,
            conversationInterceptLatencyProfiles:
                this.serializeConversationInterceptLatencyProfilesForPersistence(),
            lastConversationInterceptCalibration:
                this.lastConversationInterceptCalibration,
        };
    }

    private getAudioRelayTailPaddingMs(config?: PluginConfig) {
        return normalizeAudioTailPaddingMs(
            config?.audioTailPaddingMs ?? this.config?.audioTailPaddingMs
        );
    }

    private buildConsoleAudioCalibrationState(): ConsoleAudioCalibrationState {
        const currentDevice = this.device;
        return {
            running: this.audioCalibrationRunning,
            tailPaddingMs: this.getAudioRelayTailPaddingMs(),
            currentProfile: this.buildConsoleSpeakerAudioLatencyProfile(
                this.readSpeakerAudioLatencyProfile(currentDevice?.minaDeviceId)
            ),
            lastRun: this.lastAudioCalibration,
            prompt: this.buildConsoleAudioCalibrationPrompt(currentDevice),
        };
    }

    private buildConsoleConversationInterceptCalibrationState(): ConsoleConversationInterceptCalibrationState {
        const currentDevice = this.device;
        const currentProfile = this.buildConsoleConversationInterceptLatencyProfile(
            this.readConversationInterceptLatencyProfile(currentDevice?.minaDeviceId)
        );
        const recommendedPollIntervalMs = this.recommendConversationPollIntervalMs(
            currentDevice?.minaDeviceId,
            this.config?.pollIntervalMs
        );
        return {
            running: this.conversationInterceptCalibrationRunning,
            pollIntervalMs: normalizePollIntervalMs(
                this.config?.pollIntervalMs,
                DEFAULT_POLL_INTERVAL_MS
            ),
            recommendedPollIntervalMs,
            manualOffsetMs: normalizeConversationInterceptManualOffsetMs(
                currentProfile?.manualOffsetMs
            ),
            currentProfile,
            lastRun: this.buildConsoleConversationInterceptCalibrationSummary(
                this.lastConversationInterceptCalibration
            ),
            prompt: this.buildConsoleConversationInterceptCalibrationPrompt(
                currentDevice
            ),
        };
    }

    private async loadConfig(force = false): Promise<PluginConfig> {
        if (!force && this.config) {
            return this.config;
        }

        const config = await resolvePluginConfig(this.api, {
            stateDir: this.serviceStateDir
        });
        this.config = config;
        await this.hydratePersistedAudioCalibrationState(config);
        this.wakeWordPatternSource = config.wakeWordPattern;
        this.wakeWordRegex = new RegExp(config.wakeWordPattern);
        this.continuousDialogWindow = clamp(
            Math.round(config.dialogWindowSeconds || DEFAULT_DIALOG_WINDOW_SECONDS),
            5,
            300
        );
        return config;
    }

    private async loadConsoleState(force = false) {
        if (!force && this.consoleStateLoaded && this.consoleState) {
            return this.consoleState;
        }

        const config = await this.loadConfig(false);
        const stored = await loadPersistedConsoleState(config.consoleStatePath);
        this.consoleState = {
            accessToken: stored.accessToken,
            events: Array.isArray(stored.events)
                ? stored.events.slice(-CONSOLE_EVENT_LIMIT)
                : [],
            audioPlaybackClearedAt: readString(stored.audioPlaybackClearedAt),
            speakerMuteStates:
                stored.speakerMuteStates &&
                typeof stored.speakerMuteStates === "object"
                    ? { ...stored.speakerMuteStates }
                    : undefined,
        };
        this.consoleStateLoaded = true;
        return this.consoleState;
    }

    private async mutateConsoleState(
        mutator: (state: {
            accessToken?: string;
            events?: ConsoleEventEntry[];
            audioPlaybackClearedAt?: string;
            speakerMuteStates?: Record<string, PersistedSpeakerMuteState>;
        }) => void | Promise<void>,
        options?: { forceReload?: boolean }
    ) {
        const run = async () => {
            const state = await this.loadConsoleState(options?.forceReload === true);
            await mutator(state);
            state.events = Array.isArray(state.events)
                ? state.events.slice(-CONSOLE_EVENT_LIMIT)
                : [];
            const config = await this.loadConfig(false);
            await savePersistedConsoleState(config.consoleStatePath, {
                accessToken: state.accessToken,
                events: state.events,
                audioPlaybackClearedAt: state.audioPlaybackClearedAt,
                speakerMuteStates: state.speakerMuteStates,
            });
        };

        const next = this.consoleStateWriteQueue.then(run, run);
        this.consoleStateWriteQueue = next.catch(() => undefined);
        await next;
    }

    private buildSpeakerMuteStateKey(device?: DeviceContext | null) {
        if (!device) {
            return undefined;
        }
        return [device.model, device.miDid, device.minaDeviceId]
            .map((item) => readString(item))
            .filter((item): item is string => Boolean(item))
            .join("|");
    }

    private normalizeStoredSpeakerMuteState(
        value?: PersistedSpeakerMuteState | null
    ): PersistedSpeakerMuteState {
        const restoreVolumePercent = readNumber(value?.restoreVolumePercent);
        return {
            mode:
                value?.mode === "device" || value?.mode === "soft-volume"
                    ? value.mode
                    : undefined,
            enabled: typeof value?.enabled === "boolean" ? value.enabled : undefined,
            restoreVolumePercent:
                typeof restoreVolumePercent === "number"
                    ? clamp(Math.round(restoreVolumePercent), 0, 100)
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
            updatedAt: readString(value?.updatedAt),
        };
    }

    private mergePendingSoftMuteState(
        storedState: PersistedSpeakerMuteState,
        pendingSnapshot?: VolumeSnapshot | null
    ) {
        if (!pendingSnapshot || pendingSnapshot.muted !== true) {
            return storedState;
        }

        const pendingPercent = clamp(Math.round(pendingSnapshot.percent), 0, 100);
        const pendingRaw = Number.isFinite(pendingSnapshot.raw)
            ? pendingSnapshot.raw
            : pendingPercent;
        if (pendingRaw > SOFT_VOLUME_MUTE_READBACK_MAX_PERCENT) {
            return storedState;
        }

        return this.normalizeStoredSpeakerMuteState({
            ...storedState,
            mode: "soft-volume",
            enabled: true,
            restoreVolumePercent: pendingPercent,
            ignoreDeviceMuteReadback: true,
        });
    }

    private async getStoredSpeakerMuteState(device?: DeviceContext | null) {
        const key = this.buildSpeakerMuteStateKey(device);
        if (!key) {
            return {};
        }
        const state = await this.loadConsoleState(true);
        return this.normalizeStoredSpeakerMuteState(state.speakerMuteStates?.[key]);
    }

    private async persistSpeakerMuteState(
        device: DeviceContext,
        nextState: PersistedSpeakerMuteState
    ) {
        const key = this.buildSpeakerMuteStateKey(device);
        if (!key) {
            return {};
        }

        let normalized: PersistedSpeakerMuteState = {};

        await this.mutateConsoleState((state) => {
            const bucket =
                state.speakerMuteStates && typeof state.speakerMuteStates === "object"
                    ? { ...state.speakerMuteStates }
                    : {};
            const current = this.normalizeStoredSpeakerMuteState(bucket[key]);
            normalized = this.normalizeStoredSpeakerMuteState({
                ...current,
                ...nextState,
                updatedAt: new Date().toISOString(),
            });
            if (
                !normalized.mode &&
                typeof normalized.enabled !== "boolean" &&
                typeof normalized.restoreVolumePercent !== "number" &&
                typeof normalized.deviceMuteUnreliable !== "boolean" &&
                typeof normalized.softMuteUnreliable !== "boolean"
            ) {
                delete bucket[key];
            } else {
                bucket[key] = normalized;
            }
            state.speakerMuteStates = Object.keys(bucket).length > 0 ? bucket : undefined;
        }, { forceReload: true });

        return normalized;
    }

    private async updateSpeakerMuteReliability(
        device: DeviceContext,
        updates: {
            deviceMuteUnreliable?: boolean;
            softMuteUnreliable?: boolean;
        }
    ) {
        const current = await this.getStoredSpeakerMuteState(device).catch(
            () => ({} as PersistedSpeakerMuteState)
        );
        return this.persistSpeakerMuteState(device, {
            ...current,
            ...updates,
        });
    }

    private shouldTrustDeviceMuteReadback(
        device: DeviceContext,
        storedState: PersistedSpeakerMuteState
    ) {
        if (storedState.deviceMuteUnreliable === true || !this.hasDeviceMuteTransport(device)) {
            return false;
        }
        if (!device.speakerFeatures.volume) {
            return true;
        }
        if (storedState.mode === "device") {
            return true;
        }
        return storedState.ignoreDeviceMuteReadback === false;
    }

    private resolveTrustedDeviceMuteReadback(
        device: DeviceContext,
        storedState: PersistedSpeakerMuteState,
        observedDeviceMuted?: boolean
    ) {
        if (typeof observedDeviceMuted !== "boolean") {
            return undefined;
        }
        return this.shouldTrustDeviceMuteReadback(device, storedState)
            ? observedDeviceMuted
            : false;
    }

    private async resolveSoftVolumeObservedState(
        device: DeviceContext,
        storedState: PersistedSpeakerMuteState,
        observedPercent: number,
        observedDeviceMuted?: boolean
    ) {
        const normalizedPercent = clamp(Math.round(observedPercent), 0, 100);
        if (storedState.mode !== "soft-volume") {
            return {
                muted: storedState.enabled === true,
                effectivePercent: normalizedPercent,
            };
        }

        const ignoreDeviceMuteReadback = storedState.ignoreDeviceMuteReadback !== false;
        const effectiveDeviceMuted = ignoreDeviceMuteReadback
            ? false
            : this.resolveTrustedDeviceMuteReadback(
                device,
                storedState,
                observedDeviceMuted
            );
        const storedRestoreVolume = readNumber(storedState.restoreVolumePercent);
        const preservedRestoreVolume =
            typeof storedRestoreVolume === "number"
                ? clamp(Math.round(storedRestoreVolume), 0, 100)
                : normalizedPercent;
        const nextEnabled =
            storedState.enabled === true &&
            normalizedPercent <= SOFT_VOLUME_MUTE_READBACK_MAX_PERCENT;
        const effectiveMuted = effectiveDeviceMuted === true || nextEnabled;
        const nextRestoreVolumePercent =
            nextEnabled ? preservedRestoreVolume : normalizedPercent;
        const displayPercent = clamp(
            Math.round(
                readNumber(nextEnabled ? preservedRestoreVolume : normalizedPercent) || 0
            ),
            0,
            100
        );

        if (
            nextEnabled !== storedState.enabled ||
            nextRestoreVolumePercent !== storedState.restoreVolumePercent ||
            storedState.ignoreDeviceMuteReadback !== ignoreDeviceMuteReadback
        ) {
            await this.persistSpeakerMuteState(device, {
                mode: "soft-volume",
                enabled: nextEnabled,
                restoreVolumePercent: nextRestoreVolumePercent,
                ignoreDeviceMuteReadback,
            });
        }

        return {
            muted: effectiveMuted,
            effectivePercent: displayPercent,
        };
    }

    private resolveStoredSpeakerMuteFlag(
        storedState: PersistedSpeakerMuteState,
        deviceMuted?: boolean
    ) {
        const effectiveDeviceMuted =
            storedState.deviceMuteUnreliable === true ? false : deviceMuted;
        if (storedState.mode === "soft-volume") {
            return storedState.enabled === true || effectiveDeviceMuted === true;
        }
        if (storedState.mode === "device") {
            return effectiveDeviceMuted === true;
        }
        return storedState.enabled === true;
    }

    private isSpeakerUnmuteBlocked(
        storedState: PersistedSpeakerMuteState,
        deviceMuted?: boolean
    ) {
        const effectiveDeviceMuted =
            storedState.deviceMuteUnreliable === true ? false : deviceMuted;
        if (effectiveDeviceMuted !== true) {
            return false;
        }
        if (storedState.mode === "soft-volume" || storedState.mode === "device") {
            return storedState.enabled !== true;
        }
        return false;
    }

    private hasDeviceMuteTransport(device?: DeviceContext | null) {
        return Boolean(
            device?.speakerFeatures.mute ||
            device?.speakerFeatures.muteOn ||
            device?.speakerFeatures.muteOff
        );
    }

    private isDeviceMuteControlSupportedFor(
        device?: DeviceContext | null,
        storedState?: PersistedSpeakerMuteState
    ) {
        return this.hasDeviceMuteTransport(device) && storedState?.deviceMuteUnreliable !== true;
    }

    private isSoftMuteControlSupportedFor(
        device?: DeviceContext | null,
        storedState?: PersistedSpeakerMuteState
    ) {
        return Boolean(device?.speakerFeatures.volume) && storedState?.softMuteUnreliable !== true;
    }

    private isSpeakerMuteControlSupportedFor(
        device?: DeviceContext | null,
        storedState?: PersistedSpeakerMuteState
    ) {
        return (
            this.isDeviceMuteControlSupportedFor(device, storedState) ||
            this.isSoftMuteControlSupportedFor(device, storedState)
        );
    }

    private buildObservedVolumeSnapshot(
        device: DeviceContext,
        storedState: PersistedSpeakerMuteState,
        observedPercent: number,
        raw: number,
        source: "miot" | "mina",
        deviceMuted?: boolean,
        softMuteState?: {
            muted?: boolean;
            effectivePercent?: number;
        } | null
    ): VolumeSnapshot {
        const normalizedPercent = clamp(Math.round(observedPercent), 0, 100);
        const trustedDeviceMuted = this.resolveTrustedDeviceMuteReadback(
            device,
            storedState,
            deviceMuted
        );
        return {
            percent: softMuteState?.effectivePercent ?? normalizedPercent,
            raw,
            muted:
                softMuteState?.muted ??
                this.resolveStoredSpeakerMuteFlag(storedState, trustedDeviceMuted),
            source,
            deviceMuted: trustedDeviceMuted === true,
            unmuteBlocked: this.isSpeakerUnmuteBlocked(storedState, trustedDeviceMuted),
            muteSupported: this.isSpeakerMuteControlSupportedFor(device, storedState),
        };
    }

    private async appendConsoleEvent(
        kind: string,
        title: string,
        detail?: string,
        level: ConsoleEventEntry["level"] = "info",
        options?: { audioUrl?: string }
    ) {
        const entry: ConsoleEventEntry = {
            id: randomBytes(10).toString("hex"),
            time: new Date().toISOString(),
            kind: normalizeEventText(kind, 60) || "event",
            level,
            title: normalizeEventText(title, 120) || "未命名事件",
            detail: normalizeEventText(detail, 600),
            audioUrl: normalizeRemoteMediaUrl(readString(options?.audioUrl)),
        };

        await this.mutateConsoleState((state) => {
            const events = Array.isArray(state.events) ? state.events : [];
            events.push(entry);
            state.events = events.slice(-CONSOLE_EVENT_LIMIT);
            if (entry.audioUrl) {
                state.audioPlaybackClearedAt = undefined;
            }
        }, { forceReload: true });
    }

    private async clearConsoleAudioPlaybackState() {
        await this.mutateConsoleState((state) => {
            state.audioPlaybackClearedAt = new Date().toISOString();
        }, { forceReload: true });
    }

    private recordConsoleEvent(
        kind: string,
        title: string,
        detail?: string,
        level: ConsoleEventEntry["level"] = "info",
        options?: { audioUrl?: string }
    ) {
        void this.appendConsoleEvent(kind, title, detail, level, options).catch(() => undefined);
    }

    private async getConsoleEvents(limit = 80) {
        const state = await this.loadConsoleState(false);
        const max = clamp(Math.round(limit || 80), 1, CONSOLE_EVENT_LIMIT);
        const events = Array.isArray(state.events) ? state.events : [];
        return events.slice(-max).reverse();
    }

    private async getConsoleAccessToken() {
        const state = await this.loadConsoleState(false);
        if (state.accessToken) {
            return state.accessToken;
        }

        const token = randomBytes(24).toString("hex");
        await this.mutateConsoleState((draft) => {
            draft.accessToken = token;
        }, { forceReload: true });
        return token;
    }

    private async computeConsoleBaseUrls() {
        const config = await this.loadConfig(false);
        const explicitBases: string[] = [];
        const discoveredBases: string[] = [];
        const addCandidate = (
            value: string | undefined,
            options?: { explicit?: boolean }
        ) => {
            const normalized = normalizeBaseUrl(value);
            if (!normalized) {
                return;
            }
            try {
                const parsed = new URL(normalized);
                const target = options?.explicit ? explicitBases : discoveredBases;
                target.push(parsed.toString().replace(/\/+$/, ""));
            } catch {
                // Ignore malformed bases here and let other candidates continue.
            }
        };

        addCandidate(config.publicBaseUrl, { explicit: true });
        for (const gatewayBase of await discoverGatewayBaseUrls(this.api)) {
            const trimmed = gatewayBase.trim();
            if (trimmed) {
                addCandidate(`${trimmed.replace(/\/+$/, "")}${config.authRoutePath}`);
            }
        }
        const orderedBases = uniqueStrings([
            ...explicitBases,
            ...sortConsoleBaseUrls(discoveredBases),
        ]);
        if (orderedBases.length === 0) {
            return [config.authRoutePath];
        }
        return orderedBases;
    }

    private async computeAudioRelayBaseUrls() {
        const config = await this.loadConfig(false);
        const preferredBases: string[] = [];
        const directBases: string[] = [];
        const loopbackBases: string[] = [];
        const addCandidate = (value: string | undefined, options?: { preferred?: boolean }) => {
            const normalized = normalizeBaseUrl(value);
            if (!normalized) {
                return;
            }
            try {
                const parsed = new URL(normalized);
                const target = isLoopbackHostname(parsed.hostname)
                    ? loopbackBases
                    : options?.preferred
                        ? preferredBases
                    : directBases;
                if (parsed.protocol === "https:" && looksLikeIpHostname(parsed.hostname)) {
                    const httpParsed = new URL(parsed.toString());
                    httpParsed.protocol = "http:";
                    if (httpParsed.port === "443") {
                        httpParsed.port = "";
                    }
                    target.push(httpParsed.toString().replace(/\/+$/, ""));
                }
                target.push(parsed.toString().replace(/\/+$/, ""));
            } catch {
                // Ignore malformed bases here and let other candidates continue.
            }
        };

        addCandidate(config.audioPublicBaseUrl, { preferred: true });
        addCandidate(config.publicBaseUrl);
        for (const gatewayBase of await discoverGatewayBaseUrls(this.api)) {
            const trimmed = gatewayBase.trim();
            if (!trimmed) {
                continue;
            }
            addCandidate(`${trimmed.replace(/\/+$/, "")}${config.authRoutePath}`);
        }

        if (
            !config.audioPublicBaseUrl &&
            !config.publicBaseUrl &&
            preferredBases.length === 0 &&
            directBases.length === 0
        ) {
            for (const lanBase of await this.computeLanAudioRelayBaseUrls(config)) {
                addCandidate(lanBase, { preferred: true });
            }
        }

        return uniqueStrings([...preferredBases, ...directBases, ...loopbackBases]);
    }

    private async computeLanAudioRelayBaseUrls(config: PluginConfig) {
        if (typeof this.api?.registerHttpRoute !== "function") {
            return [];
        }

        const globalConfig = await readOpenclawGlobalConfig(this.api).catch(() => undefined);
        const gatewayConfig = globalConfig?.gateway;
        const customBindHost = readString(gatewayConfig?.customBindHost)?.trim().toLowerCase();
        if (customBindHost && isLoopbackHostname(customBindHost)) {
            return [];
        }

        const gatewayPort = clamp(
            Math.round(
                readNumber(gatewayConfig?.publicPort) ||
                readNumber(gatewayConfig?.port) ||
                18798
            ),
            1,
            65535
        );
        const hosts = customBindHost && isPrivateHostname(customBindHost)
            ? [customBindHost]
            : readLocalLanIpv4Addresses();
        const urls: string[] = [];

        for (const host of hosts) {
            if (!host || isLoopbackHostname(host)) {
                continue;
            }
            if (gatewayPort === 80) {
                urls.push(`http://${host}${config.authRoutePath}`);
            } else if (gatewayPort === 443) {
                urls.push(`https://${host}${config.authRoutePath}`);
                urls.push(`http://${host}${config.authRoutePath}`);
            } else {
                urls.push(`http://${host}:${gatewayPort}${config.authRoutePath}`);
            }
        }

        return uniqueStrings(urls);
    }

    private async computeSpeakerReachableAudioRelayBaseUrls() {
        const bases = await this.computeAudioRelayBaseUrls();
        return bases.filter((value) => {
            const normalized = normalizeBaseUrl(value);
            if (!normalized) {
                return false;
            }
            try {
                return !isLoopbackHostname(new URL(normalized).hostname);
            } catch {
                return false;
            }
        });
    }

    private async getConsoleEntryUrl() {
        const [baseUrl] = await this.computeConsoleBaseUrls();
        const accessToken = await this.getConsoleAccessToken();
        return `${baseUrl.replace(/\/+$/, "")}/console?access_token=${encodeURIComponent(accessToken)}`;
    }

    private extractConversationAnswerText(answer: any): string | undefined {
        const direct = pickFirstString(
            answer?.tts?.text,
            answer?.text,
            answer?.content,
            answer?.say,
            answer?.spokenText
        );
        if (direct) {
            return direct;
        }

        if (Array.isArray(answer?.texts)) {
            const joined = answer.texts
                .map((item: any) => (typeof item === "string" ? item.trim() : ""))
                .filter(Boolean)
                .join("\n");
            return joined || undefined;
        }

        const type = pickFirstString(answer?.type, "UNKNOWN") || "UNKNOWN";
        return type === "TTS" ? undefined : `[${type}]`;
    }

    private normalizeConversationRecord(
        record: any,
        fallbackIndex = 0
    ): ConsoleConversationEntry {
        const requestId = readString(record?.requestId);
        const timestamp = readNumber(record?.time) || Date.now();
        const query =
            normalizeEventText(
                typeof record?.query === "string" ? record.query : "",
                1000
            ) || "";
        const answers = Array.isArray(record?.answers)
            ? record.answers
                .map((item: any) => this.extractConversationAnswerText(item))
                .filter((item: string | undefined): item is string => Boolean(item))
            : [];

        return {
            id: requestId || `${timestamp}-${fallbackIndex}`,
            requestId,
            time: new Date(timestamp).toISOString(),
            query,
            answers,
        };
    }

    private async fetchConversationHistory(limit = 20): Promise<ConsoleConversationEntry[]> {
        await this.ensureReady();
        if (!this.minaClient || !this.device) {
            throw new Error("小爱云后端尚未初始化。");
        }
        try {
            const response = await this.minaClient.fetchConversation(
                this.device.hardware,
                this.device.minaDeviceId,
                clamp(Math.round(limit || 20), 1, CONSOLE_FETCH_LIMIT)
            );
            const rawData = response?.data;
            const payload =
                typeof rawData === "string"
                    ? readJsonObject<Record<string, any>>(rawData, "小爱会话历史 data")
                    : rawData;
            const records = Array.isArray(payload?.records) ? payload.records : [];

            return records
                .map((record: any, index: number) =>
                    this.normalizeConversationRecord(record, index)
                )
                .filter(
                    (item: ConsoleConversationEntry) =>
                        item.query || item.answers.length > 0
                )
                .sort(
                    (left: ConsoleConversationEntry, right: ConsoleConversationEntry) =>
                        Date.parse(left.time) - Date.parse(right.time)
                );
        } catch (error) {
            const message = this.errorMessage(error);
            if (!this.isTransientNetworkError(message)) {
                throw error;
            }
            await this.appendDebugTrace("conversation_history_transient_error", {
                message,
                limit,
            });
            console.warn(
                `[XiaoAI Cloud] 拉取会话历史暂时失败，将在下次请求时重试: ${message}`
            );
            return [];
        }
    }

    private async fetchLocalSpeechConversationHistory(
        limit = 20
    ): Promise<ConsoleConversationEntry[]> {
        const state = await this.loadConsoleState(false);
        const max = clamp(Math.round(limit || 20), 1, CONSOLE_FETCH_LIMIT);
        const items = (Array.isArray(state.events) ? state.events : [])
            .filter(
                (item: any) =>
                    item &&
                    typeof item === "object" &&
                    (
                        item.kind === "tool.speak" ||
                        item.kind === "tool.audio" ||
                        item.kind === "tool.reply" ||
                        item.kind === "console.speak" ||
                        item.kind === "console.audio"
                    ) &&
                    typeof item.detail === "string" &&
                    item.detail.trim()
            )
            .map((item: any, index: number) => ({
                id: `local-speak-${item.id || index}`,
                time:
                    typeof item.time === "string" && item.time.trim()
                        ? item.time
                        : new Date().toISOString(),
                query: "",
                answers: [normalizeEventText(item.detail, 1000) || item.detail.trim()],
            }))
            .sort(
                (left: ConsoleConversationEntry, right: ConsoleConversationEntry) =>
                    Date.parse(left.time) - Date.parse(right.time)
            );

        return items.slice(-max);
    }

    private async getConsoleConversationFeed(limit = 20): Promise<ConsoleConversationEntry[]> {
        const max = clamp(Math.round(limit || 20), 1, CONSOLE_FETCH_LIMIT);
        const [localEntries, cloudEntries] = await Promise.all([
            this.fetchLocalSpeechConversationHistory(max),
            this.minaClient && this.device
                ? this.fetchConversationHistory(max).catch((error) => {
                    const message = this.errorMessage(error);
                    if (this.isTransientNetworkError(message)) {
                        return [];
                    }
                    throw error;
                })
                : Promise.resolve([] as ConsoleConversationEntry[]),
        ]);

        return [...cloudEntries, ...localEntries]
            .sort(
                (left: ConsoleConversationEntry, right: ConsoleConversationEntry) =>
                    Date.parse(left.time) - Date.parse(right.time)
            )
            .slice(-max);
    }

    private async findRecentOpenclawSpeechResult(
        query: string,
        startedAt: number
    ): Promise<ConsoleConversationEntry | null> {
        const normalizedQuery = normalizeEventText(query, 1000) || query.trim();
        const inMemorySpeech = this.lastOpenclawSpeech;
        if (
            inMemorySpeech &&
            inMemorySpeech.timeMs >= startedAt - 1000 &&
            inMemorySpeech.text
        ) {
            return {
                id: `openclaw-${inMemorySpeech.timeMs}`,
                time: new Date(inMemorySpeech.timeMs).toISOString(),
                query: normalizedQuery,
                answers: [inMemorySpeech.text],
            };
        }

        const state = await this.loadConsoleState(true).catch(() => undefined);
        const events = Array.isArray(state?.events) ? state?.events : [];
        const matched = [...events]
            .reverse()
            .find((item) => {
                const itemTime = Date.parse(item.time);
                return (
                    (
                        item.kind === "tool.speak" ||
                        item.kind === "tool.audio" ||
                        item.kind === "tool.reply"
                    ) &&
                    Number.isFinite(itemTime) &&
                    itemTime >= startedAt - 1000 &&
                    Boolean(item.detail)
                );
            });
        if (!matched?.detail) {
            return null;
        }
        return {
            id: matched.id,
            time: matched.time,
            query: normalizedQuery,
            answers: [matched.detail],
        };
    }

    private async waitForConversationResult(
        query: string,
        startedAt: number,
        timeoutMs = 15000,
        options?: { preferOpenclaw?: boolean }
    ): Promise<ConsoleConversationEntry | null> {
        const normalizedQuery = normalizeEventText(query, 1000) || query.trim();
        const deadline = Date.now() + timeoutMs;
        let attempt = 0;
        const preferOpenclaw = Boolean(options?.preferOpenclaw);

        while (Date.now() < deadline) {
            const openclawSpeech = await this.findRecentOpenclawSpeechResult(
                normalizedQuery,
                startedAt
            );
            if (openclawSpeech) {
                return openclawSpeech;
            }

            const history = await this.fetchConversationHistory(6).catch(() => []);
            const matched = history.find((item) => {
                const itemTime = Date.parse(item.time);
                return (
                    item.query === normalizedQuery &&
                    Number.isFinite(itemTime) &&
                    itemTime >= startedAt - 5000
                );
            });
            const openclawPending =
                this.waitingForResponse || this.pendingAgentPromptCount > 0;
            const withinInterceptGrace =
                preferOpenclaw &&
                Date.now() < startedAt + OPENCLAW_INTERCEPT_DETECTION_GRACE_MS;
            if (
                matched &&
                matched.answers.length > 0 &&
                !openclawPending &&
                !withinInterceptGrace
            ) {
                return matched;
            }
            const waitMs =
                CONVERSATION_WAIT_POLL_DELAYS_MS[
                    Math.min(attempt, CONVERSATION_WAIT_POLL_DELAYS_MS.length - 1)
                ] || 900;
            attempt += 1;
            await sleep(waitMs);
        }

        return null;
    }

    private async buildConsoleBootstrap(): Promise<ConsoleBootstrapPayload> {
        const config = await this.loadConfig(false).catch(() => this.config);
        const [
            helperStatus,
            hasPersistedSession,
            volume,
            consoleUrl,
            audioPlayback,
            openclawAgentState,
            openclawRoute,
            openclawWorkspaceFiles,
        ] = await Promise.all([
            this.getMicoapiHelperStatus(config),
            config?.account
                ? this.hasPersistedAccountSession(config).catch(() => false)
                : Promise.resolve(false),
            this.device ? this.getVolumeSnapshot().catch(() => null) : Promise.resolve(null),
            this.getConsoleEntryUrl().catch(() => undefined),
            this.buildConsoleAudioPlayback().catch(() => null),
            config
                ? this.queryOpenclawAgentModelState(config).catch(() => undefined)
                : Promise.resolve(undefined),
            config
                ? this.buildConsoleOpenclawRouteState(config).catch(() => undefined)
                : Promise.resolve(undefined),
            config
                ? this.queryOpenclawWorkspaceFilesState(config).catch(() => undefined)
                : Promise.resolve(undefined),
        ]);
        const agentsWorkspaceFile = openclawWorkspaceFiles?.files.find(
            (item) => item.id === "agents"
        );
        const authenticated = Boolean(this.device) || Boolean(config?.account && hasPersistedSession);
        const session =
            this.getLoginSessionSnapshot() ||
            (!this.device && !authenticated
                ? await this.ensureLoginSession(false).catch(() => null)
                : null);
        const modeNames: Record<InterceptMode, string> = {
            wake: "唤醒模式",
            proxy: "代理模式",
            silent: "静默模式",
        };

        return {
            ready: Boolean(this.device),
            authenticated,
            account: maskAccountLabel(config?.account),
            serverCountry: config?.serverCountry,
            mode: this.currentMode,
            modeLabel: modeNames[this.currentMode],
            wakeWordPattern:
                this.wakeWordPatternSource ||
                config?.wakeWordPattern ||
                DEFAULT_WAKE_WORD_PATTERN,
            dialogWindowSeconds: this.continuousDialogWindow,
            openclawThinkingOff: config?.openclawThinkingOff ?? true,
            thinkingEnabled: !(config?.openclawThinkingOff ?? true),
            openclawForceNonStreaming: config?.openclawForceNonStreaming ?? false,
            openclawAgentId: openclawAgentState?.agentId,
            openclawContextTokens: openclawAgentState?.contextTokens,
            openclawContextWindow: openclawAgentState?.contextWindow,
            openclawVoiceSystemPrompt:
                agentsWorkspaceFile?.content ||
                openclawAgentState?.systemPrompt ||
                config?.openclawVoiceSystemPrompt ||
                DEFAULT_XIAOAI_AGENT_WORKSPACE_PROMPT,
            transitionPhrases:
                config?.transitionPhrases?.slice() || DEFAULT_TRANSITION_PHRASES.slice(),
            debugLogEnabled: config?.debugLogEnabled ?? DEFAULT_DEBUG_LOG_ENABLED,
            voiceContextMaxTurns:
                config?.voiceContextMaxTurns ?? DEFAULT_VOICE_CONTEXT_MAX_TURNS,
            voiceContextMaxChars:
                config?.voiceContextMaxChars ?? DEFAULT_VOICE_CONTEXT_MAX_CHARS,
            debugLogPath: config?.debugLogPath,
            helperStatus: this.formatMicoapiHelperStatus(helperStatus),
            lastConversationAt:
                this.lastConversationTimestamp > 0
                    ? new Date(this.lastConversationTimestamp).toISOString()
                    : undefined,
            lastConversationQuery: this.lastConversationQuery || undefined,
            lastError: this.lastError,
            lastErrorTransient: this.lastError
                ? this.isTransientNetworkError(this.lastError)
                : undefined,
            consoleUrl,
            loginUrl: authenticated ? undefined : session?.primaryUrl,
            loginHint: authenticated
                ? this.lastError || "账号已登录，请先在概览页选择要接管的音箱。"
                : session?.message || session?.error || this.lastError,
            device: this.device
                ? {
                    name: this.device.name,
                    hardware: this.device.hardware,
                    model: this.device.model,
                    miDid: this.device.miDid,
                    minaDeviceId: this.device.minaDeviceId,
                }
                : undefined,
            volume: volume
                ? {
                    percent: volume.percent,
                    muted: volume.muted,
                    deviceMuted: volume.deviceMuted,
                    unmuteBlocked: volume.unmuteBlocked,
                    muteSupported: volume.muteSupported !== false,
                    pending: volume.pending,
                }
                : null,
            audioPlayback,
            openclawRoute,
            openclawWorkspaceFiles,
            audioCalibration: this.buildConsoleAudioCalibrationState(),
            conversationInterceptCalibration:
                this.buildConsoleConversationInterceptCalibrationState(),
        };
    }

    private isBrowserFallbackAudioEvent(entry?: ConsoleEventEntry | null) {
        const summary = [
            readString(entry?.kind),
            readString(entry?.title),
            readString(entry?.detail),
        ]
            .filter(Boolean)
            .join(" ");
        return summary.includes("浏览器兜底");
    }

    private describeConsoleAudioEvent(entry?: ConsoleEventEntry | null) {
        return pickFirstString(readString(entry?.detail), readString(entry?.title));
    }

    private findLatestSpeakerAudioEvent(
        events: ConsoleEventEntry[] | undefined,
        options?: { afterMs?: number; beforeMs?: number }
    ) {
        const entries = Array.isArray(events) ? [...events].reverse() : [];
        const afterMs = readNumber(options?.afterMs);
        const beforeMs = readNumber(options?.beforeMs);
        return entries.find((entry) => {
            if (!normalizeRemoteMediaUrl(readString(entry?.audioUrl))) {
                return false;
            }
            if (this.isBrowserFallbackAudioEvent(entry)) {
                return false;
            }
            const timeMs = Date.parse(readString(entry?.time) || "");
            if (typeof afterMs === "number" && Number.isFinite(timeMs) && timeMs <= afterMs) {
                return false;
            }
            if (typeof beforeMs === "number" && Number.isFinite(timeMs) && timeMs >= beforeMs) {
                return false;
            }
            return true;
        });
    }

    private async buildConsoleAudioPlayback(): Promise<ConsoleBootstrapPayload["audioPlayback"]> {
        if (!this.device || !this.minaClient) {
            return null;
        }

        const [consoleState, statusResponse] = await Promise.all([
            this.loadConsoleState(false).catch(() => undefined),
            this.minaClient.playerGetStatus(this.device.minaDeviceId).catch(() => undefined),
        ]);
        const snapshot = this.readSpeakerPlaybackSnapshot(statusResponse);
        const statusCode = readNumber(snapshot?.status);
        const status: "idle" | "playing" | "paused" =
            statusCode === 1 ? "playing" : statusCode === 2 ? "paused" : "idle";
        const clearedAtMs = Date.parse(
            readString(consoleState?.audioPlaybackClearedAt) || ""
        );
        const latestAudioEvent = this.findLatestSpeakerAudioEvent(consoleState?.events, {
            afterMs: clearedAtMs,
        });
        const title = this.normalizeAudioReplyTitle(
            this.describeConsoleAudioEvent(latestAudioEvent)
        );
        const position = readNumber(snapshot?.position);
        const duration = readNumber(snapshot?.duration);

        if (
            !title &&
            (status === "idle" || Number.isFinite(clearedAtMs)) &&
            !(status === "playing" && typeof duration === "number" && duration > 0)
        ) {
            return null;
        }

        return {
            source: "speaker",
            title,
            status,
            audioUrl: normalizeRemoteMediaUrl(readString(latestAudioEvent?.audioUrl)),
            positionSeconds:
                typeof position === "number" && Number.isFinite(position)
                    ? Math.max(0, position / 1000)
                    : undefined,
            durationSeconds:
                typeof duration === "number" && Number.isFinite(duration)
                    ? Math.max(0, duration / 1000)
                    : undefined,
        };
    }

    private async queryOpenclawAgentModelState(
        config: PluginConfig
    ): Promise<OpenclawAgentModelState> {
        const globalConfig = await readOpenclawGlobalConfig(this.api);
        const agentId = this.resolveManagedOpenclawAgentId(config, globalConfig);
        const { agentConfig } = this.readOpenclawAgentConfig(globalConfig, agentId);
        const currentModel =
            resolveConfiguredOpenclawModel(agentConfig?.model) ||
            resolveConfiguredOpenclawModel(globalConfig?.agents?.defaults?.model);
        const models = collectConfiguredOpenclawModels(globalConfig);
        const currentModelOption = currentModel
            ? models.find((item) => item.ref === currentModel)
            : undefined;
        const workspacePath = this.resolveOpenclawAgentWorkspacePath(
            agentId,
            agentConfig,
            globalConfig
        );
        const promptState = await this.readOpenclawAgentWorkspacePromptState(
            workspacePath,
            config.openclawVoiceSystemPrompt
        );
        return {
            agentId,
            model: currentModel,
            contextTokens: this.resolveOpenclawAgentContextTokens(
                agentConfig,
                globalConfig
            ),
            contextWindow:
                typeof currentModelOption?.contextWindow === "number" &&
                Number.isFinite(currentModelOption.contextWindow)
                    ? Math.max(1, Math.round(currentModelOption.contextWindow))
                    : undefined,
            systemPrompt: promptState.prompt,
            models,
        };
    }

    private async buildConsoleOpenclawRouteState(
        config: PluginConfig
    ): Promise<ConsoleOpenclawRouteState> {
        const globalConfig = await readOpenclawGlobalConfig(this.api);
        const configuredChannels = collectConfiguredOpenclawChannels(globalConfig);
        const currentChannel =
            readString(config.openclawChannel)?.toLowerCase() ||
            inferConfiguredOpenclawChannel(globalConfig) ||
            "telegram";
        const channelIds = Array.from(
            new Set(
                [currentChannel, ...configuredChannels].filter(
                    (item): item is string => Boolean(readString(item))
                )
            )
        );
        const channels = channelIds.map((channelId) => ({
            id: channelId,
            label: formatConsoleOpenclawChannelLabel(channelId),
            configured: configuredChannels.includes(channelId),
            targets: collectOpenclawNotificationTargets(globalConfig, channelId),
        }));

        return {
            agentId: readString(config.openclawAgent) || "main",
            channel: currentChannel,
            target: readString(config.openclawTo),
            enabled:
                config.openclawNotificationsDisabled !== true &&
                Boolean(readString(config.openclawTo)),
            channels,
        };
    }

    private readOpenclawAgentListFromConfig(globalConfig: Record<string, any> | undefined) {
        return Array.isArray(globalConfig?.agents?.list)
            ? globalConfig.agents.list
            : undefined;
    }

    private readOpenclawAgentConfig(
        globalConfig: Record<string, any> | undefined,
        agentId: string
    ) {
        const agentsList = this.readOpenclawAgentListFromConfig(globalConfig);
        const agentIndex = Array.isArray(agentsList)
            ? agentsList.findIndex((item) => readString(item?.id) === agentId)
            : -1;
        const agentConfig =
            agentIndex >= 0 && Array.isArray(agentsList)
                ? agentsList[agentIndex]
                : undefined;
        return {
            agentsList,
            agentIndex,
            agentConfig,
        };
    }

    private resolveManagedOpenclawAgentId(
        config: PluginConfig | undefined,
        globalConfig?: Record<string, any> | undefined
    ) {
        const explicitAgentId = readString(config?.openclawAgent);
        if (explicitAgentId) {
            return explicitAgentId;
        }
        const preferredAgentId = "xiaoai";
        const { agentConfig } = this.readOpenclawAgentConfig(
            globalConfig,
            preferredAgentId
        );
        return agentConfig ? preferredAgentId : "main";
    }

    private resolveOpenclawAgentContextTokens(
        agentConfig: Record<string, any> | undefined,
        globalConfig: Record<string, any> | undefined
    ) {
        return (
            normalizeOpenclawContextTokens(agentConfig?.contextTokens) ??
            normalizeOpenclawContextTokens(globalConfig?.agents?.defaults?.contextTokens)
        );
    }

    private resolveOpenclawAgentWorkspacePath(
        agentId: string,
        agentConfig: Record<string, any> | undefined,
        globalConfig: Record<string, any> | undefined
    ) {
        const explicitWorkspace = readString(agentConfig?.workspace);
        if (explicitWorkspace) {
            return explicitWorkspace;
        }
        return agentId === "main"
            ? readString(globalConfig?.agents?.defaults?.workspace)
            : "";
    }

    private async readOpenclawAgentWorkspacePromptState(
        workspacePath: string | undefined,
        fallbackPrompt?: string
    ) {
        const prompt = normalizeOpenclawVoiceSystemPrompt(fallbackPrompt, {
            fallbackToDefault: true,
        });
        if (!workspacePath) {
            return {
                prompt,
                exists: false,
                filePath: undefined,
                raw: "",
            };
        }
        const filePath = path.join(workspacePath, OPENCLAW_AGENT_PROMPT_FILENAME);
        try {
            const raw = await readFile(filePath, "utf8");
            return {
                prompt: normalizeOpenclawVoiceSystemPrompt(raw, {
                    fallbackToDefault: true,
                }),
                exists: true,
                filePath,
                raw,
            };
        } catch {
            return {
                prompt,
                exists: false,
                filePath,
                raw: "",
            };
        }
    }

    private async writeOpenclawAgentWorkspacePrompt(
        workspacePath: string,
        prompt: string
    ) {
        await mkdir(workspacePath, { recursive: true });
        await writeFile(
            path.join(workspacePath, OPENCLAW_AGENT_PROMPT_FILENAME),
            `${normalizeOpenclawVoiceSystemPrompt(prompt, {
                fallbackToDefault: true,
            })}\n`,
            "utf8"
        );
    }

    private async readOpenclawWorkspaceFileState(
        workspacePath: string | undefined,
        fileRef: OpenclawWorkspaceFileId | string
    ): Promise<ConsoleOpenclawWorkspaceFileState> {
        const definition = findOpenclawWorkspaceFileDefinition(fileRef);
        if (!definition) {
            throw new Error(`不支持的 workspace 文件: ${String(fileRef || "")}`);
        }
        const filePath = workspacePath ? path.join(workspacePath, definition.filename) : "";
        let raw = "";
        let fileExists = false;
        if (filePath) {
            try {
                raw = await readFile(filePath, "utf8");
                fileExists = true;
            } catch {
                raw = "";
                fileExists = false;
            }
        }
        const normalizedStored = normalizeOpenclawWorkspaceFileContent(definition, raw, {
            fallbackToDefault: false,
        });
        const enabled = fileExists && Boolean(normalizedStored);
        return {
            id: definition.id,
            filename: definition.filename,
            label: definition.label,
            description: definition.description,
            enabled,
            customized: enabled && normalizedStored !== definition.defaultContent,
            defaultEnabled: definition.defaultEnabled,
            disableAllowed: definition.disableAllowed,
            defaultContent: definition.defaultContent,
            content: enabled ? normalizedStored : definition.defaultContent,
        };
    }

    private async writeOpenclawWorkspaceFile(
        workspacePath: string,
        fileRef: OpenclawWorkspaceFileId | string,
        content: string
    ) {
        const definition = findOpenclawWorkspaceFileDefinition(fileRef);
        if (!definition) {
            throw new Error(`不支持的 workspace 文件: ${String(fileRef || "")}`);
        }
        const normalized = normalizeOpenclawWorkspaceFileContent(definition, content, {
            fallbackToDefault: true,
        });
        await mkdir(workspacePath, { recursive: true });
        await writeFile(
            path.join(workspacePath, definition.filename),
            `${normalized}\n`,
            "utf8"
        );
        return normalized;
    }

    private async disableOpenclawWorkspaceFile(
        workspacePath: string,
        fileRef: OpenclawWorkspaceFileId | string
    ) {
        const definition = findOpenclawWorkspaceFileDefinition(fileRef);
        if (!definition) {
            throw new Error(`不支持的 workspace 文件: ${String(fileRef || "")}`);
        }
        if (!definition.disableAllowed) {
            throw new Error(`${definition.filename} 是核心提示文件，当前不支持在控制台禁用。`);
        }
        const filePath = path.join(workspacePath, definition.filename);
        await mkdir(workspacePath, { recursive: true });
        if (definition.id === "boot") {
            try {
                await unlink(filePath);
            } catch (error) {
                const code =
                    error && typeof error === "object" && "code" in error
                        ? String((error as NodeJS.ErrnoException).code || "")
                        : "";
                if (code !== "ENOENT") {
                    throw error;
                }
            }
            return;
        }
        await writeFile(filePath, "", "utf8");
    }

    private async queryOpenclawWorkspaceFilesState(
        config: PluginConfig
    ): Promise<ConsoleOpenclawWorkspaceState> {
        const agentId = readString(config.openclawAgent) || "main";
        const globalConfig = await readOpenclawGlobalConfig(this.api);
        const { agentConfig } = this.readOpenclawAgentConfig(globalConfig, agentId);
        const workspacePath = this.resolveOpenclawAgentWorkspacePath(
            agentId,
            agentConfig,
            globalConfig
        );
        return {
            agentId,
            files: await Promise.all(
                OPENCLAW_WORKSPACE_FILE_DEFINITIONS.map((item) =>
                    this.readOpenclawWorkspaceFileState(workspacePath, item.id)
                )
            ),
        };
    }

    private readOpenclawResponsesEndpointEnabled(
        globalConfig: Record<string, any> | undefined
    ) {
        const raw = globalConfig?.gateway?.http?.endpoints?.responses;
        if (typeof raw === "boolean") {
            return raw;
        }
        return readBoolean(raw?.enabled) ?? false;
    }

    private async readOpenclawGatewayAuthState(): Promise<OpenclawGatewayAuthState> {
        const globalConfig = await readOpenclawGlobalConfig(this.api);
        const mode = readString(globalConfig?.gateway?.auth?.mode) || "token";
        const token =
            readString(globalConfig?.gateway?.auth?.token) ||
            readString(globalConfig?.gateway?.remote?.token);
        const password = readString(globalConfig?.gateway?.auth?.password);
        const bearerSecret = mode === "password" ? password : token;
        if (!bearerSecret) {
            if (mode === "password") {
                throw new Error(
                    "Gateway 当前是 password 鉴权，但配置里没有可用密码，暂时不能直连官方 HTTP/Gateway 接口。"
                );
            }
            throw new Error("缺少 OpenClaw Gateway token，暂时不能直连官方 HTTP/Gateway 接口。");
        }
        return {
            mode,
            token,
            password,
            bearerSecret,
            globalConfig,
        };
    }

    private async ensureOpenclawResponsesEndpointEnabled(config: PluginConfig) {
        const authState = await this.readOpenclawGatewayAuthState();
        if (this.readOpenclawResponsesEndpointEnabled(authState.globalConfig)) {
            return {
                enabled: true,
                changed: false,
                restarting: false,
            };
        }

        await this.runOpenclawCli(
            [
                config.openclawCliPath,
                "config",
                "set",
                "gateway.http.endpoints.responses.enabled",
                "true",
                "--strict-json",
            ],
            "启用 OpenClaw Responses 端点",
            20_000
        );
        this.scheduleGatewayRestart(config, "OpenClaw 网关重启");
        return {
            enabled: true,
            changed: true,
            restarting: true,
        };
    }

    private scheduleGatewayRestart(config: PluginConfig, reason: string) {
        if (this.pendingGatewayRestart) {
            return;
        }
        this.pendingGatewayRestart = true;
        setTimeout(() => {
            void this.runOpenclawCli(
                [config.openclawCliPath, "gateway", "restart"],
                reason,
                60_000
            )
                .catch((error) => {
                    this.pendingGatewayRestart = false;
                    console.error(
                        `[XiaoAI Cloud] ${reason}失败: ${this.errorMessage(error)}`
                    );
                });
        }, 240);
    }

    private async updateOpenclawAgentModel(modelInput: string) {
        const nextModel = normalizeOpenclawModelRef(modelInput);
        if (!nextModel) {
            throw new HttpError(400, "模型参数无效，请使用 provider/model 格式。");
        }

        const config = await this.loadConfig(false);
        const agentId = readString(config.openclawAgent) || "main";
        const modelState = await this.queryOpenclawAgentModelState(config).catch(
            (): OpenclawAgentModelState => ({
                agentId,
                model: undefined,
                models: [],
            })
        );
        if (
            modelState.models.length > 0 &&
            !modelState.models.some((item) => item.ref === nextModel)
        ) {
            throw new HttpError(
                400,
                `模型 ${nextModel} 不在当前 OpenClaw 配置里的可选列表中。`
            );
        }

        const globalConfig = await readOpenclawGlobalConfig(this.api);
        const agentsList = this.readOpenclawAgentListFromConfig(globalConfig);
        const agentIndex = Array.isArray(agentsList)
            ? agentsList.findIndex((item) => readString(item?.id) === agentId)
            : -1;
        if (agentIndex < 0) {
            throw new Error(`没有找到 id 为 ${agentId} 的 OpenClaw agent。`);
        }

        const previousModel =
            resolveConfiguredOpenclawModel(agentsList[agentIndex]?.model) ||
            modelState.model;
        if (previousModel === nextModel) {
            return {
                agentId,
                model: nextModel,
                previousModel,
                changed: false,
                restarting: false,
            };
        }

        await this.runOpenclawCli(
            [
                config.openclawCliPath,
                "config",
                "set",
                `agents.list[${agentIndex}].model`,
                JSON.stringify(nextModel),
                "--strict-json",
            ],
            "OpenClaw 模型写入",
            20_000
        );
        this.scheduleGatewayRestart(config, "OpenClaw 网关重启");
        return {
            agentId,
            model: nextModel,
            previousModel,
            changed: true,
            restarting: true,
        };
    }

    private async updateOpenclawAgentContextTokens(contextTokensInput: number) {
        const nextContextTokens = normalizeOpenclawContextTokens(contextTokensInput);
        if (typeof nextContextTokens !== "number") {
            throw new HttpError(400, "上下文窗口参数无效，必须是正整数。");
        }

        const config = await this.loadConfig(false);
        const globalConfig = await readOpenclawGlobalConfig(this.api);
        const agentId = this.resolveManagedOpenclawAgentId(config, globalConfig);
        const { agentsList, agentIndex, agentConfig } = this.readOpenclawAgentConfig(
            globalConfig,
            agentId
        );
        if (agentIndex < 0 || !Array.isArray(agentsList)) {
            throw new Error(`没有找到 id 为 ${agentId} 的 OpenClaw agent。`);
        }

        const previousContextTokens =
            this.resolveOpenclawAgentContextTokens(agentConfig, globalConfig);
        const previousRawContextTokens = normalizeOpenclawContextTokens(
            agentConfig?.contextTokens
        );
        const changed = previousRawContextTokens !== nextContextTokens;
        if (!changed) {
            return {
                agentId,
                contextTokens: nextContextTokens,
                previousContextTokens,
                changed: false,
                restarting: false,
            };
        }

        await this.runOpenclawCli(
            [
                config.openclawCliPath,
                "config",
                "set",
                `agents.list[${agentIndex}].contextTokens`,
                JSON.stringify(nextContextTokens),
                "--strict-json",
            ],
            "OpenClaw 上下文窗口写入",
            20_000
        );
        this.scheduleGatewayRestart(config, "OpenClaw 网关重启");
        return {
            agentId,
            contextTokens: nextContextTokens,
            previousContextTokens,
            changed: true,
            restarting: true,
        };
    }

    private async getMicoapiHelperStatus(
        config?: PluginConfig
    ): Promise<XiaomiPythonRuntimeStatus | undefined> {
        const now = Date.now();
        if (this.helperStatusCache && now < this.helperStatusCache.expiresAt) {
            return this.helperStatusCache.status;
        }
        try {
            const resolvedConfig = config || (await this.loadConfig(false));
            const tracer =
                this.accountClient ||
                new XiaomiAccountClient({
                    username: resolvedConfig.account || "status-only",
                    tokenStorePath: resolvedConfig.tokenStorePath,
                    debugLogPath: resolvedConfig.debugLogPath,
                    debugLogEnabled: resolvedConfig.debugLogEnabled,
                    pythonCommand: resolvedConfig.pythonCommand,
                });
            const status = await tracer.getMicoapiPythonRuntimeStatus();
            this.helperStatusCache = {
                status,
                expiresAt: now + HELPER_STATUS_CACHE_MS,
            };
            return status;
        } catch {
            this.helperStatusCache = {
                status: undefined,
                expiresAt: now + Math.min(HELPER_STATUS_CACHE_MS, 10_000),
            };
            return undefined;
        }
    }

    private formatMicoapiHelperStatus(status: XiaomiPythonRuntimeStatus | undefined) {
        if (!status) {
            return "未知";
        }
        if (status.ready) {
            const versions = [
                status.pythonVersion ? `Python ${status.pythonVersion}` : undefined,
                status.requestsVersion ? `requests ${status.requestsVersion}` : undefined,
            ]
                .filter(Boolean)
                .join(", ");
            return `已就绪 (${[status.command, versions].filter(Boolean).join(" | ")})`;
        }
        switch (status.kind) {
            case "missing_python":
                return `缺少 Python (${status.command || "自动探测"}): ${status.detail}`;
            case "missing_requests":
                return `缺少 requests (${status.command || "自动探测"}): ${status.detail}`;
            case "probe_failed":
                return `探测失败 (${status.command || "自动探测"}): ${status.detail}`;
            default:
                return status.detail;
        }
    }

    private async logMicoapiHelperStatus(
        config: PluginConfig,
        accountClient: XiaomiAccountClient
    ) {
        try {
            await accountClient.loadTokenStore();
            const hasStoredMicoapi = Boolean(accountClient.getSidToken("micoapi"));
            const helperStatus = await accountClient.getMicoapiPythonRuntimeStatus();
            this.helperStatusCache = {
                status: helperStatus,
                expiresAt: Date.now() + HELPER_STATUS_CACHE_MS,
            };
            await accountClient.traceEvent("runtime_dependency_status", {
                hasStoredMicoapi,
                micoapiHelper: helperStatus,
                pythonCommand: config.pythonCommand || null,
            });
            if (!hasStoredMicoapi && !helperStatus.ready) {
                console.warn(
                    `[XiaoAI Cloud] micoapi 登录辅助未就绪: ${helperStatus.detail}`
                );
                console.warn(
                    `[XiaoAI Cloud] 若需账号密码登录，请先补齐 Python 依赖或设置 pythonCommand。调试日志: ${config.debugLogPath}`
                );
            }
        } catch (error) {
            await this.appendDebugTrace("runtime_dependency_status_error", {
                message: this.errorMessage(error),
            });
        }
    }

    private async ensureReady() {
        if (!this.initPromise) {
            this.initPromise = this.initialize().catch(async (error) => {
                this.initPromise = undefined;
                await this.handleInitializationFailure(error).catch((portalError) => {
                    console.error(
                        `[XiaoAI Cloud] 生成登录入口失败: ${this.errorMessage(portalError)}`
                    );
                });
                throw error;
            });
        }
        return this.initPromise;
    }

    private async initialize() {
        const config = await this.loadConfig(true);
        console.log(
            `[XiaoAI Cloud] 小米网络调试日志: ${config.debugLogPath} (${config.debugLogEnabled ? "已开启" : "已关闭"})`
        );

        this.accountClient = new XiaomiAccountClient({
            username: config.account || "xiaoai-cloud",
            password: config.password,
            tokenStorePath: config.tokenStorePath,
            debugLogPath: config.debugLogPath,
            debugLogEnabled: config.debugLogEnabled,
            pythonCommand: config.pythonCommand,
        });
        await this.accountClient.maintainDebugLog(true).catch(() => undefined);
        await this.logMicoapiHelperStatus(config, this.accountClient);
        this.minaClient = new MiNAClient(this.accountClient);
        this.miioClient = new MiIOClient(this.accountClient, config.serverCountry);
        this.specClient = new MiotSpecClient();
        this.device = await this.resolveDeviceContextFor(
            config,
            this.minaClient,
            this.miioClient,
            this.specClient
        );
        await this.primeConversationCursor();
        await this.persistResolvedProfile(config, this.device, false);
        this.lastError = undefined;

        console.log(
            `=== XiaoAI Cloud 已就绪 | 模式: ${this.currentMode} | 窗口: ${this.continuousDialogWindow}s | 设备: ${this.device.name} (${this.device.hardware}/${this.device.model}) ===`
        );
        this.recordConsoleEvent(
            "system.ready",
            "插件已就绪",
            `${this.device.name} (${this.device.hardware}/${this.device.model})`,
            "success"
        );
    }

    private async ensureLoginPortal(): Promise<LoginPortal> {
        const config = await this.loadConfig(false);
        if (this.loginPortal) {
            await this.loginPortal.start();
            return this.loginPortal;
        }

        const gatewayBaseUrls = await discoverGatewayBaseUrls(this.api);
        const portal = new LoginPortal({
            listenHost: config.authListenHost,
            port: config.authPort,
            publicBaseUrl: config.publicBaseUrl,
            routeBasePath:
                typeof this.api?.registerHttpRoute === "function"
                    ? config.authRoutePath
                    : undefined,
            gatewayBaseUrls,
            standaloneOptional: typeof this.api?.registerHttpRoute === "function",
            onPasswordDiscover: async (sessionId, payload) =>
                this.handlePasswordDiscover(sessionId, payload),
            onPasswordLogin: async (sessionId, payload) =>
                this.handlePasswordLogin(sessionId, payload),
            onVerifyTicket: async (sessionId, payload) =>
                this.handleVerificationTicket(sessionId, payload),
            onPrepareVerificationPage: async (sessionId, payload) =>
                this.handlePrepareVerificationPage(sessionId, payload.preferredMethod),
            onTrace: async (event, details) =>
                this.appendDebugTrace(event, details),
        });
        await portal.start();
        this.ensureGatewayRouteRegistered(config);
        this.loginPortal = portal;
        return portal;
    }

    private matchGatewayRoutePath(routeBasePath: string, pathname: string) {
        const normalized = normalizeHttpPath(routeBasePath, "/");
        if (normalized === "/") {
            return pathname;
        }
        if (pathname === normalized) {
            return "/";
        }
        if (pathname.startsWith(`${normalized}/`)) {
            return pathname.slice(normalized.length) || "/";
        }
        return null;
    }

    private isSecureHttpRequest(request: any, config: PluginConfig) {
        const forwardedProto = Array.isArray(request?.headers?.["x-forwarded-proto"])
            ? request.headers["x-forwarded-proto"][0]
            : request?.headers?.["x-forwarded-proto"];
        const normalizedProto = readString(forwardedProto)?.toLowerCase();
        return (
            normalizedProto === "https" ||
            Boolean(request?.socket?.encrypted) ||
            Boolean(config.publicBaseUrl?.startsWith("https://"))
        );
    }

    private setConsoleAccessCookie(response: any, request: any, config: PluginConfig) {
        const parts = [
            `${CONSOLE_COOKIE_NAME}=${encodeURIComponent(this.consoleState?.accessToken || "")}`,
            `Path=${config.authRoutePath}`,
            "HttpOnly",
            "SameSite=Lax",
            `Max-Age=${30 * 24 * 60 * 60}`,
        ];
        if (this.isSecureHttpRequest(request, config)) {
            parts.push("Secure");
        }
        response.setHeader("Set-Cookie", parts.join("; "));
    }

    private resolveConsoleRequestOrigin(request: any, config: PluginConfig) {
        const forwardedProto = readRequestHeader(request, "x-forwarded-proto")?.toLowerCase();
        const forwardedHost = readRequestHeader(request, "x-forwarded-host");
        const host = forwardedHost || readRequestHeader(request, "host");
        if (!host) {
            return undefined;
        }
        const protocol =
            forwardedProto === "https" ||
            Boolean(request?.socket?.encrypted) ||
            Boolean(config.publicBaseUrl?.startsWith("https://"))
                ? "https"
                : "http";
        return `${protocol}://${host}`;
    }

    private isTrustedConsoleMutationRequest(request: any, config: PluginConfig) {
        const secFetchSite = readRequestHeader(request, "sec-fetch-site")?.toLowerCase();
        if (secFetchSite) {
            return ["same-origin", "same-site", "none"].includes(secFetchSite);
        }

        const expectedOrigin = this.resolveConsoleRequestOrigin(request, config);
        if (!expectedOrigin) {
            return true;
        }

        const originHeader = readRequestHeader(request, "origin");
        if (originHeader) {
            return originHeader === expectedOrigin;
        }

        const refererHeader = readRequestHeader(request, "referer");
        if (!refererHeader) {
            return true;
        }

        try {
            return new URL(refererHeader).origin === expectedOrigin;
        } catch {
            return false;
        }
    }

    private async resolveConsoleAuthorization(
        request: any,
        requestUrl: URL
    ) {
        const expected = await this.getConsoleAccessToken();
        const headerToken = readString(
            Array.isArray(request?.headers?.["x-xiaoai-console-token"])
                ? request.headers["x-xiaoai-console-token"][0]
                : request?.headers?.["x-xiaoai-console-token"]
        );
        const queryToken = readString(requestUrl.searchParams.get("access_token") || undefined);
        const cookies = parseCookies(
            Array.isArray(request?.headers?.cookie)
                ? request.headers.cookie.join("; ")
                : request?.headers?.cookie
        );
        const cookieToken = readString(cookies[CONSOLE_COOKIE_NAME]);

        return {
            expected,
            fromHeader: headerToken,
            fromQuery: queryToken,
            fromCookie: cookieToken,
            authorized:
                safeTokenEquals(expected, headerToken) ||
                safeTokenEquals(expected, queryToken) ||
                safeTokenEquals(expected, cookieToken),
        };
    }

    private async handleConsoleApiRoute(
        config: PluginConfig,
        request: any,
        response: any,
        requestUrl: URL,
        matchedPath: string
    ) {
        const auth = await this.resolveConsoleAuthorization(request, requestUrl);
        if (!auth.authorized) {
            sendJson(response, 401, {
                error: "控制台访问口令无效，请使用插件提供的后台完整链接重新进入。",
            });
            return true;
        }

        const requestMethod = (request.method || "GET").toUpperCase();
        const headerAuthorized = safeTokenEquals(auth.expected, auth.fromHeader);
        const queryAuthorized = safeTokenEquals(auth.expected, auth.fromQuery);
        if (
            requestMethod === "POST" &&
            !headerAuthorized &&
            !queryAuthorized &&
            !this.isTrustedConsoleMutationRequest(request, config)
        ) {
            sendJson(response, 403, {
                error: "检测到异常来源的控制台写请求，已拒绝处理。",
            });
            return true;
        }

        const action = matchedPath.replace(/^\/api\/?/, "");
        try {
            if (requestMethod === "GET" && action === "bootstrap") {
                sendJson(response, 200, await this.buildConsoleBootstrap());
                return true;
            }
            if (requestMethod === "GET" && action === "conversations") {
                const limit = clamp(
                    Math.round(Number(requestUrl.searchParams.get("limit") || "30")),
                    1,
                    CONSOLE_FETCH_LIMIT
                );
                sendJson(response, 200, {
                    items: await this.getConsoleConversationFeed(limit),
                });
                return true;
            }
            if (requestMethod === "GET" && action === "events") {
                const limit = clamp(
                    Math.round(Number(requestUrl.searchParams.get("limit") || "80")),
                    1,
                    CONSOLE_EVENT_LIMIT
                );
                sendJson(response, 200, {
                    items: await this.getConsoleEvents(limit),
                });
                return true;
            }
            if (requestMethod === "GET" && action === "device/list") {
                sendJson(response, 200, {
                    items: await this.listConsoleDevices(),
                });
                return true;
            }
            if (requestMethod === "GET" && action === "openclaw/model") {
                sendJson(response, 200, await this.queryOpenclawAgentModelState(config));
                return true;
            }
            if (requestMethod === "GET" && action === "openclaw/route") {
                sendJson(response, 200, await this.buildConsoleOpenclawRouteState(config));
                return true;
            }
            if (requestMethod === "POST" && action === "chat/send") {
                const body = await readJsonBody(request);
                const text = readString(body?.text);
                if (!text) {
                    sendJson(response, 400, { error: "请输入要发给小爱的文字。" });
                    return true;
                }
                const startedAt = Date.now();
                const ok = await this.executeDirective(text, false);
                if (!ok) {
                    throw new Error("小爱暂时没有接受这条指令。");
                }
                await this.appendConsoleEvent(
                    "console.chat",
                    "控制台发给小爱",
                    text,
                    "success"
                );
                const conversation = await this.waitForConversationResult(text, startedAt, 15000, {
                    preferOpenclaw: this.shouldInterceptQuery(text),
                });
                sendJson(response, 200, {
                    ok: true,
                    message: conversation
                        ? "消息已发给小爱，并且已经等到回复。"
                        : "消息已发给小爱，回复可能还在路上。",
                    conversation,
                });
                return true;
            }
            if (requestMethod === "POST" && action === "speaker/speak") {
                const body = await readJsonBody(request);
                const text = readString(body?.text);
                if (!text) {
                    sendJson(response, 400, { error: "请输入要直接播报的文字。" });
                    return true;
                }
                this.waitingForResponse = false;
                const ok = await this.playText(text);
                if (!ok) {
                    throw new Error("播报失败。");
                }
                await this.appendConsoleEvent(
                    "console.speak",
                    "控制台让小爱播报",
                    text,
                    "success"
                );
                sendJson(response, 200, {
                    ok: true,
                    message: `播报完成：${text}`,
                });
                return true;
            }
            if (requestMethod === "POST" && action === "speaker/play-audio") {
                const body = await readJsonBody(request);
                const url = normalizeRemoteMediaUrl(readString(body?.url));
                const title = readString(body?.title);
                const audioDetail = url ? this.describeAudioReply(url, title) : undefined;
                const interrupt = readBoolean(body?.interrupt) !== false;
                const forceRetry = readBoolean(body?.forceRetry) !== false;
                if (!url) {
                    sendJson(response, 400, {
                        error: "请输入可直接访问的 http/https 音频 URL。",
                    });
                    return true;
                }
                this.waitingForResponse = false;
                let played: Awaited<ReturnType<XiaoaiCloudPlugin["playAudioUrl"]>> | null = null;
                let playbackErrorMessage = "";
                try {
                    played = await this.playAudioUrl(url, {
                        title,
                        interrupt,
                        ignoreRecentFailure: forceRetry,
                        consoleEventKind: "console.audio",
                        consoleEventTitle: "控制台让小爱播放音频",
                    });
                } catch (error) {
                    playbackErrorMessage =
                        this.errorMessage(error) || "音箱没有真正开始播放这段音频。";
                    this.recordConsoleEvent(
                        "console.audio",
                        "控制台让小爱播放音频失败",
                        audioDetail,
                        "warn",
                        { audioUrl: url }
                    );
                }
                if (!played) {
                    sendJson(response, 502, {
                        error:
                            playbackErrorMessage ||
                            "音箱没有真正开始播放这段音频。",
                    });
                    return true;
                }
                sendJson(response, 200, {
                    ok: true,
                    playback: "speaker",
                    message: `${played.detail}，已开始播放。`,
                    title: this.normalizeAudioReplyTitle(played.detail),
                    detail: played.detail,
                    url: played.url,
                });
                return true;
            }
            if (requestMethod === "POST" && action === "speaker/pause") {
                const ok = await this.pauseSpeaker().catch(() => false);
                this.recordConsoleEvent(
                    "console.audio",
                    ok ? "控制台暂停当前音频" : "控制台暂停音频失败",
                    ok ? "已发送暂停指令。" : "暂停指令发送失败。",
                    ok ? "success" : "error"
                );
                sendJson(response, ok ? 200 : 500, {
                    ok,
                    message: ok ? "已发送暂停指令。" : "暂停失败，请稍后再试。",
                });
                return true;
            }
            if (requestMethod === "POST" && action === "speaker/resume") {
                const ok = await this.resumeSpeaker().catch(() => false);
                this.recordConsoleEvent(
                    "console.audio",
                    ok ? "控制台继续当前音频" : "控制台继续音频失败",
                    ok ? "已发送继续播放指令。" : "继续播放指令发送失败。",
                    ok ? "success" : "error"
                );
                sendJson(response, ok ? 200 : 500, {
                    ok,
                    message: ok ? "已发送继续播放指令。" : "继续播放失败，请稍后再试。",
                });
                return true;
            }
            if (requestMethod === "POST" && action === "speaker/stop") {
                const ok = await this.stopSpeaker().catch(() => false);
                if (ok) {
                    await this.clearConsoleAudioPlaybackState();
                }
                this.recordConsoleEvent(
                    "console.audio",
                    ok ? "控制台停止当前音频" : "控制台停止音频失败",
                    ok ? "已停止当前音频，并清空当前播放展示。" : "停止指令发送失败。",
                    ok ? "success" : "error"
                );
                sendJson(response, ok ? 200 : 500, {
                    ok,
                    cleared: ok,
                    message: ok
                        ? "已停止当前音频，并清空当前播放展示。"
                        : "停止失败，请稍后再试。",
                });
                return true;
            }
            if (requestMethod === "POST" && action === "device/audio-calibration") {
                const calibration = await this.runRequestedCalibration("audio");
                if (calibration.busyMessage) {
                    sendJson(response, 409, {
                        error: calibration.busyMessage,
                    });
                    return true;
                }
                const outcome = this.buildCalibrationOutcomeMessage(calibration);
                sendJson(response, outcome.ok ? 200 : 500, outcome.ok
                    ? {
                        ok: true,
                        message: outcome.message,
                        calibration,
                    }
                    : {
                        error: outcome.message,
                        calibration,
                    });
                return true;
            }
            if (requestMethod === "POST" && action === "device/conversation-intercept-calibration") {
                const calibration =
                    await this.runRequestedCalibration("conversation");
                if (calibration.busyMessage) {
                    sendJson(response, 409, {
                        error: calibration.busyMessage,
                    });
                    return true;
                }
                const outcome = this.buildCalibrationOutcomeMessage(calibration);
                sendJson(response, outcome.ok ? 200 : 500, outcome.ok
                    ? {
                        ok: true,
                        message: outcome.message,
                        calibration,
                    }
                    : {
                        error: outcome.message,
                        calibration,
                    });
                return true;
            }
            if (requestMethod === "POST" && action === "device/audio-tail-padding") {
                const body = await readJsonBody(request);
                const tailPaddingMs = readNumber(
                    body?.tailPaddingMs ?? body?.milliseconds ?? body?.ms
                );
                const tailPaddingSeconds = readNumber(body?.seconds);
                const resolvedInput =
                    typeof tailPaddingMs === "number"
                        ? tailPaddingMs
                        : typeof tailPaddingSeconds === "number"
                            ? tailPaddingSeconds * 1000
                            : undefined;
                if (typeof resolvedInput !== "number" || !Number.isFinite(resolvedInput)) {
                    sendJson(response, 400, { error: "空余延迟参数无效。" });
                    return true;
                }
                const result = await this.updateAudioTailPaddingMs(resolvedInput);
                await this.appendConsoleEvent(
                    "console.audio_tail_padding",
                    "控制台修改空余延迟",
                    `${result.previousTailPaddingMs}ms -> ${result.tailPaddingMs}ms`,
                    "success"
                );
                sendJson(response, 200, {
                    ok: true,
                    tailPaddingMs: result.tailPaddingMs,
                    calibration: this.buildConsoleAudioCalibrationState(),
                    message: result.changed
                        ? `空余延迟已更新为 ${result.tailPaddingMs}ms`
                        : `当前空余延迟保持 ${result.tailPaddingMs}ms`,
                });
                return true;
            }
            if (requestMethod === "POST" && action === "device/poll-interval") {
                const body = await readJsonBody(request);
                const pollIntervalMs = readNumber(
                    body?.pollIntervalMs ?? body?.milliseconds ?? body?.ms
                );
                if (
                    typeof pollIntervalMs !== "number" ||
                    !Number.isFinite(pollIntervalMs)
                ) {
                    sendJson(response, 400, { error: "轮询间隔参数无效。" });
                    return true;
                }
                const result = await this.updatePollIntervalMs(pollIntervalMs);
                const lowPollIntervalWarning =
                    result.pollIntervalMs < MIN_RECOMMENDED_POLL_INTERVAL_MS
                        ? `低于 ${MIN_RECOMMENDED_POLL_INTERVAL_MS}ms 不建议，容易放大小米侧超时并触发自动退避。`
                        : undefined;
                await this.appendConsoleEvent(
                    "console.poll_interval",
                    "控制台修改轮询间隔",
                    `${result.previousPollIntervalMs}ms -> ${result.pollIntervalMs}ms`,
                    "success"
                );
                sendJson(response, 200, {
                    ok: true,
                    pollIntervalMs: result.pollIntervalMs,
                    calibration: this.buildConsoleConversationInterceptCalibrationState(),
                    warning: lowPollIntervalWarning,
                    message: result.changed
                        ? lowPollIntervalWarning
                            ? `轮询间隔已更新为 ${result.pollIntervalMs}ms。${lowPollIntervalWarning}`
                            : `轮询间隔已更新为 ${result.pollIntervalMs}ms`
                        : lowPollIntervalWarning
                            ? `当前轮询间隔保持 ${result.pollIntervalMs}ms。${lowPollIntervalWarning}`
                        : `当前轮询间隔保持 ${result.pollIntervalMs}ms`,
                });
                return true;
            }
            if (
                requestMethod === "POST" &&
                action === "device/conversation-intercept-offset"
            ) {
                const body = await readJsonBody(request);
                const manualOffsetMs = readNumber(
                    body?.manualOffsetMs ?? body?.milliseconds ?? body?.ms
                );
                if (
                    typeof manualOffsetMs !== "number" ||
                    !Number.isFinite(manualOffsetMs)
                ) {
                    sendJson(response, 400, { error: "对话拦截微调参数无效。" });
                    return true;
                }
                const result =
                    await this.updateConversationInterceptManualOffsetMs(
                        manualOffsetMs
                    );
                await this.appendConsoleEvent(
                    "console.conversation_intercept_offset",
                    "控制台微调对话拦截",
                    `${result.previousManualOffsetMs}ms -> ${result.manualOffsetMs}ms`,
                    "success"
                );
                sendJson(response, 200, {
                    ok: true,
                    manualOffsetMs: result.manualOffsetMs,
                    calibration: this.buildConsoleConversationInterceptCalibrationState(),
                    message: result.changed
                        ? `对话拦截微调已更新为 ${result.manualOffsetMs}ms`
                        : `当前对话拦截微调保持 ${result.manualOffsetMs}ms`,
                });
                return true;
            }
            if (requestMethod === "POST" && action === "device/wake-up") {
                const ok = await this.wakeUpSpeaker();
                if (!ok) {
                    throw new Error("唤醒失败。");
                }
                await this.appendConsoleEvent(
                    "console.wake",
                    "控制台远程唤醒",
                    "已发送唤醒指令。",
                    "success"
                );
                sendJson(response, 200, {
                    ok: true,
                    message: "唤醒指令已发送。",
                });
                return true;
            }
            if (requestMethod === "POST" && action === "device/select") {
                const body = await readJsonBody(request);
                const minaDeviceId = readString(body?.minaDeviceId);
                const device = await this.selectConsoleDevice(minaDeviceId || "");
                sendJson(response, 200, {
                    ok: true,
                    message: `已切换到 ${device.name} (${device.hardware}/${device.model})`,
                });
                return true;
            }
            if (requestMethod === "POST" && action === "device/volume") {
                const body = await readJsonBody(request);
                const volume = clamp(Math.round(Number(body?.volume)), 0, 100);
                if (!Number.isFinite(volume)) {
                    sendJson(response, 400, { error: "音量参数无效。" });
                    return true;
                }
                const ok = await this.runSpeakerControlMutation("volume", volume, () =>
                    this.setVolumePercent(volume)
                );
                if (!ok) {
                    throw new Error("音量设置失败。");
                }
                await this.appendConsoleEvent(
                    "console.volume",
                    "控制台设置音量",
                    `播放音量调整到 ${volume}%，播放静音开关保持不变`,
                    "success"
                );
                const volumeState = await this.readConsoleVolumeMutationResult({
                    percent: volume,
                });
                sendJson(response, 200, {
                    ok: true,
                    message: `播放音量已设为 ${volume}%。`,
                    volume: volumeState,
                });
                return true;
            }
            if (requestMethod === "POST" && action === "device/mute") {
                const storedMuteState = await this.getStoredSpeakerMuteState(this.device).catch(
                    () => ({} as PersistedSpeakerMuteState)
                );
                if (!this.isSpeakerMuteControlSupportedFor(this.device, storedMuteState)) {
                    const volumeState = await this.readConsoleVolumeMutationResult();
                    sendJson(response, 409, {
                        error:
                            "当前设备不支持可靠的播放静音控制。设备静音链路和软静音链路都已验证为不可靠，已禁用该开关。",
                        volume: volumeState,
                    });
                    return true;
                }
                const body = await readJsonBody(request);
                const muted = readBoolean(body?.muted);
                if (typeof muted !== "boolean") {
                    sendJson(response, 400, { error: "静音参数无效。" });
                    return true;
                }
                const ok = await this.runSpeakerControlMutation("mute", muted, () =>
                    this.setSpeakerMuted(muted)
                );
                const volumeState = await this.readConsoleVolumeMutationResult({
                    muted,
                });
                if (!ok) {
                    throw new HttpError(
                        409,
                        muted
                            ? "播放静音设置失败。"
                            : "关闭播放静音未生效，设备真实回读仍显示为已开启，需在音箱侧手动解除一次。",
                        { volume: volumeState }
                    );
                }
                await this.appendConsoleEvent(
                    "console.mute",
                    "控制台切换播放静音",
                    muted ? "已打开播放静音" : "已关闭播放静音",
                    "success"
                );
                sendJson(response, 200, {
                    ok: true,
                    muted,
                    message: muted ? "已打开播放静音。" : "已关闭播放静音。",
                    volume: volumeState,
                });
                return true;
            }
            if (requestMethod === "POST" && action === "device/mode") {
                const body = await readJsonBody(request);
                const mode = readString(body?.mode) as InterceptMode | undefined;
                if (!mode || !["wake", "proxy", "silent"].includes(mode)) {
                    sendJson(response, 400, { error: "模式参数无效。" });
                    return true;
                }
                const oldMode = this.currentMode;
                this.applyInterceptMode(mode);
                const modeNames: Record<InterceptMode, string> = {
                    wake: "唤醒模式",
                    proxy: "代理模式",
                    silent: "静默模式",
                };
                if (mode === oldMode) {
                    sendJson(response, 200, {
                        ok: true,
                        message: `当前已经是「${modeNames[this.currentMode]}」`,
                    });
                    return true;
                }
                await this.appendConsoleEvent(
                    "console.mode",
                    "控制台切换模式",
                    `${modeNames[oldMode]} -> ${modeNames[this.currentMode]}`,
                    "success"
                );
                sendJson(response, 200, {
                    ok: true,
                    message: `模式已从「${modeNames[oldMode]}」切换到「${modeNames[this.currentMode]}」`,
                });
                return true;
            }
            if (requestMethod === "POST" && action === "device/wake-word") {
                const body = await readJsonBody(request);
                const input = readString(body?.pattern ?? body?.wakeWord ?? body?.text);
                if (!input) {
                    sendJson(response, 400, { error: "请输入新的唤醒词或正则源码。" });
                    return true;
                }
                const result = await this.updateWakeWordPattern(input);
                await this.appendConsoleEvent(
                    "console.wake_word",
                    "控制台修改唤醒词",
                    `${result.previousPattern} -> ${result.pattern}`,
                    "success"
                );
                sendJson(response, 200, {
                    ok: true,
                    pattern: result.pattern,
                    message: result.changed
                        ? `唤醒词已更新为：${result.pattern}`
                        : `当前唤醒词保持不变：${result.pattern}`,
                });
                return true;
            }
            if (requestMethod === "POST" && action === "device/dialog-window") {
                const body = await readJsonBody(request);
                const seconds = Number(body?.seconds);
                if (!Number.isFinite(seconds)) {
                    sendJson(response, 400, { error: "对话窗口时长无效。" });
                    return true;
                }
                const result = await this.updateDialogWindowSeconds(seconds);
                await this.appendConsoleEvent(
                    "console.dialog_window",
                    "控制台修改对话窗口",
                    `${result.previousSeconds}秒 -> ${result.seconds}秒`,
                    "success"
                );
                sendJson(response, 200, {
                    ok: true,
                    seconds: result.seconds,
                    message: result.changed
                        ? `免唤醒对话窗口已更新为 ${result.seconds} 秒`
                        : `当前免唤醒对话窗口保持 ${result.seconds} 秒`,
                });
                return true;
            }
            if (requestMethod === "POST" && action === "openclaw/thinking") {
                const body = await readJsonBody(request);
                const thinkingEnabled = readBoolean(body?.thinkingEnabled);
                const enabled = readBoolean(
                    typeof thinkingEnabled === "boolean"
                        ? !thinkingEnabled
                        : body?.enabled ?? body?.thinkingOff ?? body?.openclawThinkingOff
                );
                if (typeof enabled !== "boolean") {
                    sendJson(response, 400, { error: "开关参数无效。" });
                    return true;
                }
                const result = await this.updateOpenclawThinkingOff(enabled);
                await this.appendConsoleEvent(
                    "console.openclaw_thinking",
                    "控制台修改思考模式",
                    result.enabled
                        ? "已关闭思考"
                        : "已打开思考",
                    "success"
                );
                sendJson(response, 200, {
                    ok: true,
                    enabled: result.enabled,
                    thinkingEnabled: !result.enabled,
                    message: result.changed
                        ? result.enabled
                            ? "已关闭思考，后续语音转发会默认附加 --thinking off。"
                            : "已打开思考，后续语音转发将恢复默认 thinking。"
                        : result.enabled
                            ? "思考当前已经是关闭状态。"
                        : "思考当前已经是打开状态。",
                });
                return true;
            }
            if (requestMethod === "POST" && action === "openclaw/non-streaming") {
                const body = await readJsonBody(request);
                const enabled = readBoolean(
                    body?.enabled ??
                        body?.forceNonStreamingEnabled ??
                        body?.openclawForceNonStreaming
                );
                if (typeof enabled !== "boolean") {
                    sendJson(response, 400, { error: "非流式开关参数无效。" });
                    return true;
                }
                const result = await this.updateOpenclawForceNonStreaming(enabled);
                await this.appendConsoleEvent(
                    "console.openclaw_non_streaming",
                    "控制台修改非流式请求",
                    result.enabled ? "已开启强制非流式" : "已关闭强制非流式",
                    result.enabled ? "success" : "warn"
                );
                sendJson(response, 200, {
                    ok: true,
                    enabled: result.enabled,
                    restarting: result.restarting,
                    message: result.enabled
                        ? result.endpointChanged
                            ? "已开启强制非流式，正在自动启用 OpenClaw /v1/responses 并重启网关。"
                            : "已开启强制非流式，后续会改走 OpenClaw 官方 /v1/responses 非流式接口。"
                        : "已关闭强制非流式，后续恢复默认流式 agent 请求。",
                });
                return true;
            }
            if (requestMethod === "POST" && action === "openclaw/model") {
                const body = await readJsonBody(request);
                const model = readString(body?.model ?? body?.ref);
                if (!model) {
                    sendJson(response, 400, { error: "请选择要切换到的模型。" });
                    return true;
                }
                const result = await this.updateOpenclawAgentModel(model);
                await this.appendConsoleEvent(
                    "console.openclaw_model",
                    "控制台切换 OpenClaw 模型",
                    result.changed
                        ? `${result.agentId}: ${result.previousModel || "未设置"} -> ${result.model}`
                        : `${result.agentId}: ${result.model}`,
                    "success"
                );
                sendJson(response, 200, {
                    ok: true,
                    agentId: result.agentId,
                    model: result.model,
                    restarting: result.restarting,
                    message: result.changed
                        ? `模型已切换为 ${result.model}，网关正在自动重启。`
                        : `当前模型已经是 ${result.model}。`,
                });
                return true;
            }
            if (requestMethod === "POST" && action === "openclaw/route") {
                const body = await readJsonBody(request);
                const result = await this.updateOpenclawNotificationRoute({
                    channel: body?.channel,
                    target: body?.target,
                    disableNotification:
                        body?.disableNotification ??
                        body?.disabled ??
                        body?.enabled === false,
                });
                const routeState = await this.buildConsoleOpenclawRouteState(
                    this.config || config
                );
                await this.appendConsoleEvent(
                    "console.openclaw_route",
                    "控制台修改通知渠道",
                    result.enabled
                        ? `${result.previousChannel}/${result.previousTarget || "未配置"} -> ${result.channel}/${result.target || "未配置"}`
                        : `${result.previousChannel}/${result.previousTarget || "未配置"} -> 已关闭通知`,
                    "success"
                );
                sendJson(response, 200, {
                    ok: true,
                    route: routeState,
                    message: result.enabled
                        ? `插件通知已改为 ${result.channel} / ${result.target}。`
                        : "已关闭插件通知渠道；小爱对话仍会固定走专属 xiaoai agent。",
                });
                return true;
            }
            if (requestMethod === "POST" && action === "debug-log") {
                const body = await readJsonBody(request);
                const enabled = readBoolean(body?.enabled ?? body?.debugLogEnabled);
                if (typeof enabled !== "boolean") {
                    sendJson(response, 400, { error: "日志开关参数无效。" });
                    return true;
                }
                const result = await this.updateDebugLogEnabled(enabled);
                await this.appendConsoleEvent(
                    "console.debug_log",
                    "控制台修改调试日志",
                    result.enabled ? "已开启调试日志" : "已关闭调试日志",
                    "success"
                );
                sendJson(response, 200, {
                    ok: true,
                    enabled: result.enabled,
                    message: result.changed
                        ? result.enabled
                            ? "已开启调试日志，后续会继续写入网络与性能排查信息。"
                            : "已关闭调试日志，后续将停止写入详细调试文件。"
                        : result.enabled
                            ? "调试日志已经处于开启状态。"
                            : "调试日志已经处于关闭状态。",
                });
                return true;
            }
            if (
                requestMethod === "POST" &&
                (action === "openclaw/context-tokens" ||
                    action === "openclaw/voice-context")
            ) {
                const body = await readJsonBody(request);
                const contextTokens = readNumber(
                    body?.contextTokens ?? body?.tokens ?? body?.contextWindow
                );
                if (typeof contextTokens !== "number" || !Number.isFinite(contextTokens)) {
                    sendJson(response, 400, { error: "上下文窗口参数无效。" });
                    return true;
                }
                const result = await this.updateOpenclawAgentContextTokens(
                    contextTokens
                );
                await this.appendConsoleEvent(
                    "console.openclaw_context_tokens",
                    "控制台修改 xiaoai agent 上下文窗口",
                    `${result.agentId}: ${result.previousContextTokens || "未设置"} -> ${result.contextTokens}`,
                    "success"
                );
                sendJson(response, 200, {
                    ok: true,
                    agentId: result.agentId,
                    contextTokens: result.contextTokens,
                    restarting: result.restarting,
                    message: result.changed
                        ? `已将 ${result.agentId} 的上下文窗口设为 ${result.contextTokens} tokens，网关正在自动重启。`
                        : `当前 ${result.agentId} 的上下文窗口已经是 ${result.contextTokens} tokens。`,
                });
                return true;
            }
            if (requestMethod === "POST" && action === "openclaw/voice-system-prompt") {
                const body = await readJsonBody(request);
                const result = await this.updateOpenclawVoiceSystemPrompt(
                    typeof body?.prompt === "string"
                        ? body.prompt
                        : body?.openclawVoiceSystemPrompt
                );
                await this.appendConsoleEvent(
                    "console.voice_system_prompt",
                    "控制台修改 OpenClaw 系统提示词",
                    result.customized ? "已更新自定义提示词" : "已恢复默认提示词",
                    "success"
                );
                sendJson(response, 200, {
                    ok: true,
                    prompt: result.prompt,
                    customized: result.customized,
                    message: result.changed
                        ? result.customized
                            ? `已写入 xiaoai agent workspace 的 ${OPENCLAW_AGENT_PROMPT_FILENAME}。新会话会按新的提示词执行。`
                            : `已恢复 xiaoai agent workspace 的默认 ${OPENCLAW_AGENT_PROMPT_FILENAME} 内容。`
                        : result.customized
                            ? `当前 xiaoai agent workspace 的自定义 ${OPENCLAW_AGENT_PROMPT_FILENAME} 保持不变。`
                            : `当前 xiaoai agent workspace 已在使用默认 ${OPENCLAW_AGENT_PROMPT_FILENAME} 内容。`,
                });
                return true;
            }
            if (requestMethod === "POST" && action === "openclaw/workspace-file") {
                const body = await readJsonBody(request);
                const result = await this.updateOpenclawWorkspaceFile(
                    body?.file ?? body?.filename ?? body?.id,
                    {
                        content:
                            typeof body?.content === "string"
                                ? body.content
                                : typeof body?.prompt === "string"
                                    ? body.prompt
                                    : typeof body?.value === "string"
                                        ? body.value
                                        : "",
                        enabled:
                            typeof body?.enabled === "boolean" ? body.enabled : undefined,
                    }
                );
                await this.appendConsoleEvent(
                    "console.workspace_file",
                    "控制台修改 workspace 文件",
                    `${result.file.filename} · ${
                        result.disabled
                            ? "已禁用"
                            : result.file.customized
                                ? "已保存自定义内容"
                                : "已恢复默认内容"
                    }`,
                    "success"
                );
                sendJson(response, 200, {
                    ok: true,
                    file: result.file,
                    disabled: result.disabled,
                    message: result.disabled
                        ? result.file.filename === "BOOT.md"
                            ? `已禁用 xiaoai agent workspace 的 ${result.file.filename}；文件已移除。`
                            : `已禁用 xiaoai agent workspace 的 ${result.file.filename}；文件内容已清空。`
                        : result.file.customized
                            ? `已保存 xiaoai agent workspace 的 ${result.file.filename}。`
                            : `已恢复 xiaoai agent workspace 的 ${result.file.filename} 默认内容。`,
                });
                return true;
            }
            if (requestMethod === "POST" && action === "device/transition-phrases") {
                const body = await readJsonBody(request);
                const result = await this.updateTransitionPhrases(
                    body?.phrases ??
                        body?.transitionPhrases ??
                        body?.phrasesText
                );
                await this.appendConsoleEvent(
                    "console.transition_phrases",
                    "控制台修改过渡播报词",
                    result.phrases.join(" / "),
                    "success"
                );
                sendJson(response, 200, {
                    ok: true,
                    phrases: result.phrases,
                    customized: result.customized,
                    message: result.changed
                        ? result.customized
                            ? "过渡播报词已保存。拦截后会随机播报其中一句。"
                            : "已恢复默认过渡播报词。"
                        : result.customized
                            ? "当前过渡播报词保持不变。"
                            : "当前正在使用默认过渡播报词。",
                });
                return true;
            }
            if (requestMethod === "POST" && action === "account/logout") {
                const payload = await this.logoutConsoleAccount();
                sendJson(response, 200, {
                    ok: true,
                    ...payload,
                });
                return true;
            }
        } catch (error) {
            const message = this.errorMessage(error);
            this.recordConsoleEvent("console.error", "控制台请求失败", message, "error");
            sendJson(
                response,
                error instanceof HttpError ? error.statusCode : 500,
                {
                    error: message,
                    ...(error instanceof HttpError && error.payload ? error.payload : {}),
                }
            );
            return true;
        }

        return false;
    }

    private async handleConsoleHttpRoute(
        config: PluginConfig,
        request: any,
        response: any,
        requestUrl: URL,
        matchedPath: string
    ) {
        if (matchedPath === "/audio-relay" || matchedPath.startsWith("/audio-relay/")) {
            return this.handleAudioRelayHttpRoute(request, response, matchedPath);
        }

        if (matchedPath === "/assets" || matchedPath.startsWith("/assets/")) {
            let decodedPath = matchedPath;
            try {
                decodedPath = decodeURIComponent(matchedPath);
            } catch {
                sendText(response, 400, "Invalid asset path");
                return true;
            }
            const relativeAssetPath = decodedPath
                .replace(/^\/assets\/?/, "")
                .replace(/^\/+/, "");
            const assetPath = path.resolve(STATIC_ASSETS_DIR, relativeAssetPath);
            const assetsRootWithSep = `${STATIC_ASSETS_DIR}${path.sep}`;
            if (
                assetPath !== STATIC_ASSETS_DIR &&
                !assetPath.startsWith(assetsRootWithSep)
            ) {
                sendText(response, 403, "Forbidden");
                return true;
            }

            try {
                const assetStat = await stat(assetPath);
                const etag = `W/"${assetStat.size.toString(16)}-${Math.floor(assetStat.mtimeMs).toString(16)}"`;
                const ifNoneMatch = readRequestHeader(request, "if-none-match");
                if (
                    ifNoneMatch &&
                    ifNoneMatch
                        .split(",")
                        .map((item) => item.trim())
                        .includes(etag)
                ) {
                    sendAssetNotModified(response, etag, assetStat.mtimeMs);
                    return true;
                }

                const payload = await readFile(assetPath);
                sendAssetBuffer(response, payload, contentTypeForAsset(assetPath), {
                    etag,
                    modifiedAtMs: assetStat.mtimeMs,
                });
            } catch (error: any) {
                if (error && error.code === "ENOENT") {
                    sendText(response, 404, "Not found");
                } else {
                    sendText(response, 500, "Failed to load asset");
                }
            }
            return true;
        }

        if (matchedPath === "/" || matchedPath === "/console" || matchedPath === "/console/") {
            const auth = await this.resolveConsoleAuthorization(request, requestUrl);
            if (!auth.authorized) {
                sendHtml(
                    response,
                    renderConsoleAccessPage({
                        assetBasePath: consoleAssetBasePath(config.authRoutePath),
                        hint: auth.fromQuery
                            ? "访问口令无效。请重新使用插件生成的后台完整链接打开。"
                            : undefined,
                    })
                );
                return true;
            }

            this.setConsoleAccessCookie(response, request, config);
            sendHtml(
                response,
                renderConsolePage({
                    assetBasePath: consoleAssetBasePath(config.authRoutePath),
                })
            );
            return true;
        }

        if (matchedPath.startsWith("/api/")) {
            return this.handleConsoleApiRoute(
                config,
                request,
                response,
                requestUrl,
                matchedPath
            );
        }

        return false;
    }

    private ensureGatewayRouteRegistered(config: PluginConfig) {
        if (typeof this.api?.registerHttpRoute !== "function") {
            return;
        }
        if (this.loginRouteRegisteredPath === config.authRoutePath) {
            return;
        }

        this.api.registerHttpRoute({
            path: config.authRoutePath,
            auth: "plugin",
            match: "prefix",
            replaceExisting: true,
            handler: async (request: any, response: any) => {
                try {
                    const requestUrl = new URL(
                        request.url || "/",
                        `http://${request.headers.host || "localhost"}`
                    );
                    const matchedPath = this.matchGatewayRoutePath(
                        config.authRoutePath,
                        requestUrl.pathname
                    );
                    if (!matchedPath) {
                        return false;
                    }

                    if (
                        await this.handleConsoleHttpRoute(
                            config,
                            request,
                            response,
                            requestUrl,
                            matchedPath
                        )
                    ) {
                        return true;
                    }

                    if (matchedPath.startsWith("/auth/")) {
                        const portal = await this.ensureLoginPortal();
                        if (await portal.handleHttpRoute(request, response)) {
                            return true;
                        }
                    }

                    sendText(response, 404, "Not found");
                    return true;
                } catch (error) {
                    sendJson(response, error instanceof HttpError ? error.statusCode : 500, {
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    });
                    return true;
                }
            },
        });
        this.loginRouteRegisteredPath = config.authRoutePath;
        console.log(
            `[XiaoAI Cloud] 已注册 Gateway 控制路由: ${config.authRoutePath}`
        );
    }

    private buildLoginSeed(config: PluginConfig): LoginSessionSeed {
        return {
            account: config.account,
            serverCountry: config.serverCountry,
            hardware: config.hardware,
            speakerName: config.speakerName,
            miDid: config.miDid,
            minaDeviceId: config.minaDeviceId,
            tokenStorePath: config.tokenStorePath,
        };
    }

    private getLoginSessionSnapshot(): LoginPortalSessionSnapshot | null {
        if (!this.loginPortal || !this.loginSessionId) {
            return null;
        }
        return this.loginPortal.getSessionSnapshot(this.loginSessionId);
    }

    private async ensureLoginSession(forceNew = false): Promise<LoginPortalSessionSnapshot> {
        const config = await this.loadConfig(false);
        const portal = await this.ensureLoginPortal();
        const existing = !forceNew ? this.getLoginSessionSnapshot() : null;
        if (existing && existing.status !== "success") {
            return existing;
        }

        const session = await portal.createSession(this.buildLoginSeed(config));
        this.loginSessionId = session.id;
        if (forceNew) {
            this.loginNotificationSessionId = undefined;
        }
        console.log(
            `[XiaoAI Cloud] 登录会话已创建: ${session.primaryUrl}`
        );
        await this.appendDebugTrace("login_session_ready", {
            sessionId: session.id,
            primaryUrl: session.primaryUrl,
            expiresAt: session.expiresAt,
            forceNew,
            authRoutePath: config.authRoutePath,
        });
        this.recordConsoleEvent(
            "login.session",
            "已生成新的登录入口",
            session.primaryUrl,
            "warn"
        );
        return session;
    }

    private async announceLoginSession(
        session: LoginPortalSessionSnapshot,
        reason?: string,
        force = false
    ) {
        if (!force && this.loginNotificationSessionId === session.id) {
            return;
        }

        const backupUrls = session.allUrls
            .filter((item) => item && item !== session.primaryUrl)
            .slice(0, 1);
        const lines = [
            "小爱直连插件目前还没完成登录，已经为你生成了一个临时登录入口。",
            reason ? `当前原因：${reason}` : undefined,
            "",
            `登录地址：${session.primaryUrl}`,
            backupUrls.length > 0
                ? `备用地址：\n${backupUrls.join("\n")}`
                : undefined,
            `过期时间：${session.expiresAt}`,
            "",
            "这个临时入口默认只保留一小段时间，建议在自己的私聊里完成登录，不要转发到群聊。",
            "",
            "登录完成后插件会自动继续初始化，不需要重启 OpenClaw。",
        ].filter((item): item is string => Boolean(item));

        try {
            await this.sendOpenclawNotification(lines.join("\n"), "登录通知");
            this.loginNotificationSessionId = session.id;
        } catch (error) {
            console.error(
                `[XiaoAI Cloud] 发送登录通知失败: ${this.errorMessage(error)}`
            );
            console.error(
                `[XiaoAI Cloud] 登录入口保留中，可稍后手动打开：${session.primaryUrl}`
            );
        }
    }

    private async notifyLoginSuccess(device: DeviceContext) {
        try {
            const consoleUrl = await this.getConsoleEntryUrl().catch(() => undefined);
            await this.sendOpenclawNotification(
                [
                    "小爱直连登录已经完成。",
                    `设备：${device.name} (${device.hardware}/${device.model})`,
                    consoleUrl ? `后台控制台：${consoleUrl}` : undefined,
                    "现在可以继续直接对话了。",
                ].filter((item): item is string => Boolean(item)).join("\n"),
                "登录成功通知"
            );
        } catch (error) {
            console.error(
                `[XiaoAI Cloud] 发送登录成功通知失败: ${this.errorMessage(error)}`
            );
        }
        this.recordConsoleEvent(
            "login.success",
            "登录完成",
            `${device.name} (${device.hardware}/${device.model})`,
            "success"
        );
    }

    private async handleInitializationFailure(error: unknown) {
        const message = this.errorMessage(error);
        const config = await this.loadConfig(false).catch(() => this.config);
        const accountLinked =
            Boolean(config?.account) &&
            await this.hasPersistedAccountSession(config).catch(() => false);
        if (this.isDeviceSelectionRequiredMessage(message) && accountLinked) {
            this.lastError = "账号已登录，请先在概览页选择要接管的音箱。";
            await this.appendDebugTrace("initialization_waiting_for_device", {
                message,
                resolvedMessage: this.lastError,
            });
            this.recordConsoleEvent(
                "system.init",
                "等待选择设备",
                this.lastError,
                "warn"
            );
            return;
        }
        this.lastError = message;
        await this.appendDebugTrace("initialization_failure", {
            message,
        });
        this.recordConsoleEvent("system.init", "初始化需要用户处理", message, "warn");
        const session = await this.ensureLoginSession(false);
        await this.announceLoginSession(session, message);
    }

    private stopPolling() {
        this.polling = false;
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = undefined;
        }
        this.pollingStartedAt = 0;
        this.nextPollAt = 0;
        this.pollLoopRunner = undefined;
    }

    private recentPollingActivityAtMs() {
        return Math.max(
            this.pollingStartedAt,
            this.lastConversationTimestamp,
            Math.round(this.lastDialogWindowOpenedAt * 1000),
            Math.round(this.lastOpenclawSpeakTime * 1000)
        );
    }

    private currentPollInterval(config?: PluginConfig) {
        const baseInterval = clamp(
            config?.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS,
            MIN_POLL_INTERVAL_MS,
            MAX_POLL_INTERVAL_MS
        );
        let desiredInterval = baseInterval;
        if (Date.now() < this.fastPollUntil) {
            desiredInterval = Math.min(baseInterval, FAST_POLL_INTERVAL_MS);
        } else {
            const activeUntil =
                this.recentPollingActivityAtMs() +
                Math.max(POLL_ACTIVITY_GRACE_MS, STARTUP_POLL_GRACE_MS);
            if (Date.now() <= activeUntil || this.currentMode !== "silent") {
                desiredInterval = baseInterval;
            } else {
                desiredInterval = Math.max(baseInterval, IDLE_POLL_INTERVAL_MS);
            }
        }
        const backoffFloorMs = this.currentPollTransientBackoffFloorMs();
        return backoffFloorMs > 0
            ? Math.max(desiredInterval, backoffFloorMs)
            : desiredInterval;
    }

    private schedulePollingLoop(delayMs: number) {
        if (!this.polling || !this.pollLoopRunner) {
            return;
        }
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
        }
        const safeDelay = clamp(Math.round(delayMs || 0), 0, 10000);
        this.nextPollAt = Date.now() + safeDelay;
        this.pollTimer = setTimeout(() => {
            this.pollTimer = undefined;
            this.nextPollAt = 0;
            this.pollLoopRunner?.();
        }, safeDelay);
    }

    private armFastPolling(windowMs = FAST_POLL_WINDOW_MS) {
        this.fastPollUntil = Math.max(this.fastPollUntil, Date.now() + windowMs);
        if (!this.polling || !this.pollLoopRunner) {
            return;
        }
        const desiredDelay = this.currentPollInterval(this.config);
        if (!this.pollTimer) {
            this.schedulePollingLoop(desiredDelay);
            return;
        }
        if (!this.nextPollAt || this.nextPollAt > Date.now() + desiredDelay + 20) {
            this.schedulePollingLoop(desiredDelay);
        }
    }

    private armDialogWindow(nowSeconds = Date.now() / 1000) {
        this.lastDialogWindowOpenedAt = nowSeconds;
        this.openclawVoiceSessionExpiresAt = Math.max(
            this.openclawVoiceSessionExpiresAt,
            (nowSeconds + this.continuousDialogWindow + 2) * 1000
        );
        this.armFastPolling(
            Math.max(FAST_POLL_WINDOW_MS, (this.continuousDialogWindow + 2) * 1000)
        );
    }

    private clearInterceptWindowState() {
        this.waitingForResponse = false;
        this.lastDialogWindowOpenedAt = 0;
    }

    private applyInterceptMode(mode: InterceptMode) {
        this.currentMode = mode;
        this.clearInterceptWindowState();
    }

    private resetRuntimeState(options?: { preserveVoiceSession?: boolean }) {
        const preserveVoiceSession = options?.preserveVoiceSession === true;
        this.stopPolling();
        this.initPromise = undefined;
        this.config = undefined;
        this.accountClient = undefined;
        this.minaClient = undefined;
        this.miioClient = undefined;
        this.specClient = undefined;
        this.device = undefined;
        this.lastConversationTimestamp = 0;
        this.lastConversationRequestId = "";
        this.lastConversationQuery = "";
        this.latestConversationFetchKey = undefined;
        this.latestConversationFetchPromise = undefined;
        this.clearInterceptWindowState();
        this.continuousDialogWindow = DEFAULT_DIALOG_WINDOW_SECONDS;
        this.helperStatusCache = undefined;
        this.fastPollUntil = 0;
        this.clearPollTransientBackoff();
        this.notificationChannelUnavailableUntil = 0;
        this.notificationChannelUnavailableMessage = "";
        this.activeVoiceAgentRuns = [];
        this.pendingAgentPromptCount = 0;
        if (!preserveVoiceSession) {
            this.openclawVoiceSessionKey = undefined;
            this.openclawVoiceSessionExpiresAt = 0;
            this.voiceContextTurns = [];
            this.voiceContextArchiveSessionKey = undefined;
            this.voiceContextArchiveText = "";
        }
    }

    private shouldResetRuntime(message: string): boolean {
        if (this.isTransientNetworkError(message)) {
            return false;
        }
        const lower = message.toLowerCase();
        const keywords = [
            "not authenticated",
            "token store",
            "service token",
            "account session",
            "auth",
            "token",
            "login",
            "password",
            "sid",
            "账号",
            "小米",
            "音箱",
            "hardware",
            "did",
        ];
        return keywords.some((keyword) => lower.includes(keyword));
    }

    private decorateNotReadyError(error: unknown): Error {
        const message = this.errorMessage(error);
        const session = this.getLoginSessionSnapshot();
        if (!session) {
            return error instanceof Error ? error : new Error(message);
        }
        return new Error(
            `${message}\n登录入口：${session.primaryUrl}`
        );
    }

    private withDeviceDiscoverHint(error: unknown): Error {
        const message = this.errorMessage(error);
        if (
            message.includes("无法从小爱设备列表中定位目标音箱") ||
            message.includes("无法确定音箱 hardware") ||
            message.includes("无法确定音箱 DID")
        ) {
            return new Error(
                `${message}\n可以先在登录页点击“发现设备”，从候选列表里点选目标音箱后再继续。`
            );
        }
        return error instanceof Error ? error : new Error(message);
    }

    private createVerificationPayload(
        error: XiaomiVerificationRequiredError
    ): LoginVerificationPayload {
        const methodLabels =
            error.methods.length > 0
                ? `验证方式：${error.methods
                      .map((item) => (item === "phone" ? "短信验证码" : "邮箱验证码"))
                      .join(" / ")}`
                : undefined;
        return {
            message: [
                error.message,
                methodLabels,
                "先点页面上的“打开验证页面”按钮，在官方页面获取验证码。",
                "回到当前页面填写验证码后，再点“登录”继续。",
            ]
                .filter(Boolean)
                .join("\n"),
            verification: {
                verifyUrl: error.verifyUrl,
                methods: error.methods,
            },
        };
    }

    private resolveLoginTokenStorePath(
        baseConfig: PluginConfig,
        account: string | undefined,
        serverCountry: string,
        requestedPath?: string
    ) {
        if (requestedPath) {
            return requestedPath;
        }

        const normalizedAccount = account || "anonymous";
        if (account && baseConfig.account && account !== baseConfig.account) {
            return defaultTokenStorePath(
                account,
                serverCountry,
                baseConfig.storageDir
            );
        }

        return (
            baseConfig.tokenStorePath ||
            defaultTokenStorePath(
                normalizedAccount,
                serverCountry,
                baseConfig.storageDir
            )
        );
    }

    private buildLoginDeviceCandidates(
        minaDevices: MinaDeviceInfo[],
        miioDevices: MiioDeviceInfo[]
    ): LoginDeviceCandidate[] {
        const candidates = new Map<string, LoginDeviceCandidate>();

        for (const minaDevice of minaDevices) {
            const minaDeviceId = readString(String(minaDevice.deviceID || ""));
            if (!minaDeviceId) {
                continue;
            }

            const rawDid = readString(String(minaDevice.miotDID || ""));
            const alias = readString(minaDevice.alias);
            const name = readString(minaDevice.name);
            const minaHardware = readString(minaDevice.hardware);

            const miioDevice =
                (rawDid
                    ? selectMiioDevice(miioDevices, { miDid: rawDid })
                    : null) ||
                selectMiioDevice(miioDevices, {
                    speakerName: pickFirstString(alias, name),
                    hardware: minaHardware,
                }) ||
                (minaHardware
                    ? selectMiioDevice(miioDevices, { hardware: minaHardware })
                    : null);

            const hardware = pickFirstString(
                minaHardware,
                hardwareFromModel(readString(miioDevice?.model))
            );
            const miDid = pickFirstString(rawDid, readString(miioDevice?.did));
            const speakerName =
                pickFirstString(
                    readString(miioDevice?.name),
                    alias,
                    name,
                    hardware,
                    minaDeviceId
                ) || minaDeviceId;
            const model = readString(miioDevice?.model);
            const key = [minaDeviceId, miDid || "", hardware || ""].join("|");

            candidates.set(key, {
                speakerName,
                hardware,
                miDid,
                minaDeviceId,
                model,
            });
        }

        return Array.from(candidates.values()).sort((left, right) =>
            left.speakerName.localeCompare(right.speakerName, "zh-CN")
        );
    }

    private async discoverAvailableDevices(
        config: PluginConfig,
        accountClient: XiaomiAccountClient
    ): Promise<LoginDeviceCandidate[]> {
        const mina = new MiNAClient(accountClient);
        const miio = new MiIOClient(accountClient, config.serverCountry);
        const [minaDevices, miioDevices] = await Promise.all([
            mina.deviceList(),
            miio.deviceListFull(),
        ]);

        const devices = this.buildLoginDeviceCandidates(minaDevices, miioDevices);
        if (!devices.length) {
            throw new Error("当前账号下没有发现可用的小爱音箱。");
        }
        return devices;
    }

    private createAccountClientForConfig(
        config: PluginConfig,
        usernameFallback = "console"
    ) {
        return new XiaomiAccountClient({
            username: config.account || usernameFallback,
            password: config.password,
            tokenStorePath: config.tokenStorePath,
            debugLogPath: config.debugLogPath,
            debugLogEnabled: config.debugLogEnabled,
            pythonCommand: config.pythonCommand,
        });
    }

    private matchesDeviceCandidate(
        candidate: LoginDeviceCandidate,
        current?: {
            hardware?: string;
            miDid?: string;
            minaDeviceId?: string;
            speakerName?: string;
            name?: string;
        }
    ) {
        if (!current) {
            return false;
        }
        const currentName = pickFirstString(current.speakerName, current.name);
        return (
            (Boolean(candidate.minaDeviceId) &&
                Boolean(current.minaDeviceId) &&
                candidate.minaDeviceId === current.minaDeviceId) ||
            (Boolean(candidate.miDid) &&
                Boolean(current.miDid) &&
                candidate.miDid === current.miDid) ||
            (Boolean(candidate.hardware) &&
                Boolean(current.hardware) &&
                candidate.hardware === current.hardware &&
                Boolean(candidate.speakerName) &&
                Boolean(currentName) &&
                candidate.speakerName === currentName)
        );
    }

    private async listConsoleDevices(): Promise<ConsoleDeviceOption[]> {
        const config = await this.loadConfig(false);
        const accountClient = this.accountClient || this.createAccountClientForConfig(config);
        const devices = await this.discoverAvailableDevices(config, accountClient);
        const current = this.device
            ? {
                hardware: this.device.hardware,
                miDid: this.device.miDid,
                minaDeviceId: this.device.minaDeviceId,
                name: this.device.name,
            }
            : {
                hardware: config.hardware,
                miDid: config.miDid,
                minaDeviceId: config.minaDeviceId,
                speakerName: config.speakerName,
            };

        return devices
            .map((item) => ({
                ...item,
                selected: this.matchesDeviceCandidate(item, current),
            }))
            .sort((left, right) => {
                if (left.selected !== right.selected) {
                    return left.selected ? -1 : 1;
                }
                return left.speakerName.localeCompare(right.speakerName, "zh-CN");
            });
    }

    private async selectConsoleDevice(minaDeviceId: string) {
        if (!minaDeviceId) {
            throw new Error("请选择要切换的小爱设备。");
        }

        const config = await this.loadConfig(false);
        const accountClient = this.accountClient || this.createAccountClientForConfig(config);
        const devices = await this.discoverAvailableDevices(config, accountClient);
        const target =
            devices.find((item) => item.minaDeviceId === minaDeviceId) ||
            null;
        if (!target) {
            throw new Error("没有在当前账号下找到要切换的设备。");
        }

        const previousDevice = this.device
            ? `${this.device.name} (${this.device.hardware}/${this.device.model})`
            : "未绑定设备";
        const nextConfig: PluginConfig = {
            ...config,
            hardware: pickFirstString(target.hardware, config.hardware),
            speakerName: pickFirstString(target.speakerName, config.speakerName),
            miDid: pickFirstString(target.miDid, config.miDid),
            minaDeviceId: pickFirstString(target.minaDeviceId, config.minaDeviceId),
        };
        const device = await this.validateCloudConfig(nextConfig, accountClient);
        await accountClient.saveTokenStore().catch(() => undefined);
        await this.persistResolvedProfile(nextConfig, device, true);
        await this.reinitializeAfterLogin();
        await this.appendConsoleEvent(
            "console.device",
            "控制台切换设备",
            `${previousDevice} -> ${device.name} (${device.hardware}/${device.model})`,
            "success"
        );
        return device;
    }

    private async safeUnlink(filePath?: string) {
        if (!filePath) {
            return;
        }
        try {
            await unlink(filePath);
        } catch (error: any) {
            if (error?.code !== "ENOENT") {
                throw error;
            }
        }
    }

    private async logoutConsoleAccount() {
        const config = await this.loadConfig(false);
        const accountClient = this.accountClient || this.createAccountClientForConfig(config, "logout");
        const previousDevice = this.device
            ? `${this.device.name} (${this.device.hardware}/${this.device.model})`
            : "未绑定设备";

        await accountClient.invalidateSid("micoapi").catch(() => undefined);
        await accountClient.invalidateSid("xiaomiio").catch(() => undefined);
        await accountClient.clearStoredPassToken().catch(() => undefined);
        await this.safeUnlink(config.tokenStorePath).catch(() => undefined);
        const nextConfig = {
            ...config,
            account: undefined,
            hardware: undefined,
            speakerName: undefined,
            miDid: undefined,
            minaDeviceId: undefined,
        } satisfies PluginConfig;
        await savePersistedProfile(
            config.stateStorePath,
            this.buildPersistedProfile(nextConfig)
        );

        this.resetRuntimeState();
        const session = await this.ensureLoginSession(true).catch(() => null);
        await this.appendConsoleEvent(
            "console.logout",
            "控制台退出登录",
            previousDevice,
            "warn"
        );

        const message = config.password
            ? "已清空本地登录态；由于插件配置里仍保存了账号密码，后续可能再次自动登录。"
            : "已清空本地登录态。";
        return {
            message: session?.primaryUrl
                ? `${message} 需要时可以重新打开登录入口继续授权。`
                : message,
            loginUrl: session?.primaryUrl,
        };
    }

    private async buildPasswordLoginConfig(
        payload: LoginSubmission
    ): Promise<PluginConfig> {
        const account = readString(payload.account);
        if (!account) {
            throw new Error("请输入小米账号。");
        }
        if (!payload.password) {
            throw new Error("请输入小米账号密码。");
        }

        const baseConfig = await this.loadConfig(false);
        const serverCountry = payload.serverCountry || baseConfig.serverCountry;
        return {
            ...baseConfig,
            account,
            password: payload.password,
            serverCountry,
            hardware: pickFirstString(payload.hardware, baseConfig.hardware),
            speakerName: pickFirstString(payload.speakerName, baseConfig.speakerName),
            miDid: pickFirstString(payload.miDid, baseConfig.miDid),
            minaDeviceId: pickFirstString(
                payload.minaDeviceId,
                baseConfig.minaDeviceId
            ),
            tokenStorePath: this.resolveLoginTokenStorePath(
                baseConfig,
                account,
                serverCountry,
                payload.tokenStorePath
            ),
        };
    }

    private async handlePasswordDiscover(
        sessionId: string,
        payload: LoginSubmission
    ): Promise<LoginDiscoveryPayload | LoginVerificationPayload> {
        const nextConfig = await this.buildPasswordLoginConfig(payload);
        this.pendingVerifications.delete(sessionId);

        try {
            const accountClient = new XiaomiAccountClient({
                username: nextConfig.account || "anonymous",
                password: payload.password,
                tokenStorePath: nextConfig.tokenStorePath,
                debugLogPath: nextConfig.debugLogPath,
                debugLogEnabled: nextConfig.debugLogEnabled,
                pythonCommand: nextConfig.pythonCommand,
            });
            await accountClient.resetDebugLog({
                flow: "discover_password",
                account: nextConfig.account || "anonymous",
                serverCountry: nextConfig.serverCountry,
                tokenStorePath: nextConfig.tokenStorePath,
            });
            await accountClient.invalidateSid("micoapi").catch(() => undefined);
            await accountClient.invalidateSid("xiaomiio").catch(() => undefined);
            await accountClient.clearStoredPassToken().catch(() => undefined);
            await this.loginRequiredSids(accountClient);
            const devices = await this.discoverAvailableDevices(nextConfig, accountClient);

            return {
                message:
                    devices.length === 1
                        ? `已发现 1 台可用小爱，表单已可以直接使用这台设备。`
                        : `已发现 ${devices.length} 台可用小爱，请点选你要接管的音箱。`,
                devices,
            };
        } catch (error) {
            if (error instanceof XiaomiVerificationRequiredError) {
                this.pendingVerifications.set(sessionId, {
                    kind: "discover_password",
                    sid: error.sid,
                    payload,
                    state: error.state,
                });
                return this.createVerificationPayload(error);
            }
            throw this.withDeviceDiscoverHint(error);
        }
    }

    private async persistResolvedProfile(
        config: PluginConfig,
        device?: DeviceContext,
        strict = false
    ) {
        try {
            await savePersistedProfile(
                config.stateStorePath,
                this.buildPersistedProfile(config, device)
            );
        } catch (error) {
            if (strict) {
                throw error;
            }
            console.error(
                `[XiaoAI Cloud] 写入状态文件失败: ${this.errorMessage(error)}`
            );
        }
    }

    private async updateWakeWordPattern(patternInput: string) {
        const nextPattern = normalizeWakeWordPatternInput(patternInput);
        const config = await this.loadConfig(false);
        const previousPattern =
            this.wakeWordPatternSource ||
            config.wakeWordPattern ||
            DEFAULT_WAKE_WORD_PATTERN;
        const nextRegex = new RegExp(nextPattern);
        const nextConfig: PluginConfig = {
            ...config,
            wakeWordPattern: nextPattern,
        };
        this.config = nextConfig;
        this.wakeWordPatternSource = nextPattern;
        this.wakeWordRegex = nextRegex;
        await this.persistResolvedProfile(nextConfig, this.device, true);
        return {
            pattern: nextPattern,
            previousPattern,
            changed: nextPattern !== previousPattern,
        };
    }

    private async updateDialogWindowSeconds(secondsInput: number) {
        const config = await this.loadConfig(false);
        const previousSeconds = this.continuousDialogWindow || config.dialogWindowSeconds;
        const nextSeconds = clamp(
            Math.round(Number(secondsInput) || DEFAULT_DIALOG_WINDOW_SECONDS),
            5,
            300
        );
        const nextConfig: PluginConfig = {
            ...config,
            dialogWindowSeconds: nextSeconds,
        };
        this.config = nextConfig;
        this.continuousDialogWindow = nextSeconds;
        await this.persistResolvedProfile(nextConfig, this.device, true);
        return {
            seconds: nextSeconds,
            previousSeconds,
            changed: nextSeconds !== previousSeconds,
        };
    }

    private async updatePollIntervalMs(msInput: number) {
        const config = await this.loadConfig(false);
        const previousPollIntervalMs = normalizePollIntervalMs(
            config.pollIntervalMs,
            DEFAULT_POLL_INTERVAL_MS
        );
        const pollIntervalMs = normalizePollIntervalMs(
            msInput,
            previousPollIntervalMs
        );
        const nextConfig: PluginConfig = {
            ...config,
            pollIntervalMs,
        };
        this.config = nextConfig;
        await this.persistResolvedProfile(nextConfig, this.device, true);
        return {
            pollIntervalMs,
            previousPollIntervalMs,
            changed: pollIntervalMs !== previousPollIntervalMs,
        };
    }

    private async updateConversationInterceptManualOffsetMs(msInput: number) {
        const config = await this.loadConfig(false);
        const deviceId = readString(this.device?.minaDeviceId);
        if (!deviceId) {
            throw new Error("当前还没有选定可写入画像的设备。");
        }
        const currentProfile = this.readConversationInterceptLatencyProfile(deviceId) || {
            updatedAtMs: 0,
        };
        const previousManualOffsetMs = normalizeConversationInterceptManualOffsetMs(
            currentProfile.manualOffsetMs
        );
        const manualOffsetMs = normalizeConversationInterceptManualOffsetMs(
            msInput,
            previousManualOffsetMs
        );
        const nextProfile: ConversationInterceptLatencyProfile = {
            ...currentProfile,
            manualOffsetMs,
            updatedAtMs: Date.now(),
        };
        this.conversationInterceptLatencyProfiles.set(deviceId, nextProfile);
        await this.persistResolvedProfile(config, this.device, true);
        return {
            deviceId,
            manualOffsetMs,
            previousManualOffsetMs,
            changed: manualOffsetMs !== previousManualOffsetMs,
        };
    }

    private async updateAudioTailPaddingMs(msInput: number) {
        const config = await this.loadConfig(false);
        const previousTailPaddingMs = this.getAudioRelayTailPaddingMs(config);
        const tailPaddingMs = normalizeAudioTailPaddingMs(
            msInput,
            previousTailPaddingMs
        );
        const nextConfig: PluginConfig = {
            ...config,
            audioTailPaddingMs: tailPaddingMs,
        };
        this.config = nextConfig;
        await this.persistResolvedProfile(nextConfig, this.device, true);
        return {
            tailPaddingMs,
            previousTailPaddingMs,
            changed: tailPaddingMs !== previousTailPaddingMs,
        };
    }

    private async updateOpenclawNotificationRoute(input: {
        channel?: string;
        target?: string;
        disableNotification?: boolean;
    }) {
        const config = await this.loadConfig(false);
        const globalConfig = await readOpenclawGlobalConfig(this.api);
        const previousChannel = readString(config.openclawChannel) || "telegram";
        const previousTarget = readString(config.openclawTo);
        const previousEnabled =
            config.openclawNotificationsDisabled !== true && Boolean(previousTarget);
        const disableNotification = readBoolean(input.disableNotification) === true;
        const nextChannel =
            readString(input.channel)?.toLowerCase() ||
            previousChannel ||
            inferConfiguredOpenclawChannel(globalConfig) ||
            "telegram";

        if (!nextChannel) {
            throw new HttpError(400, "通知渠道参数无效。");
        }

        let nextTarget: string | undefined;
        if (!disableNotification) {
            const explicitTarget = readString(input.target);
            nextTarget =
                explicitTarget ||
                inferOpenclawNotificationTarget(globalConfig, nextChannel);
            if (!nextTarget) {
                throw new HttpError(
                    400,
                    `渠道 ${nextChannel} 没有唯一可用目标，请手动填写目标。`
                );
            }
        }

        const nextConfig: PluginConfig = {
            ...config,
            openclawChannel: nextChannel,
            openclawTo: nextTarget,
            openclawNotificationsDisabled: disableNotification,
        };
        this.config = nextConfig;
        await this.persistResolvedProfile(nextConfig, this.device, true);

        return {
            channel: nextChannel,
            target: nextTarget,
            enabled: !disableNotification && Boolean(nextTarget),
            previousChannel,
            previousTarget,
            previousEnabled,
            changed:
                nextChannel !== previousChannel ||
                nextTarget !== previousTarget ||
                (!disableNotification && Boolean(nextTarget)) !== previousEnabled,
        };
    }

    private async updateOpenclawThinkingOff(enabledInput: boolean) {
        const config = await this.loadConfig(false);
        const previousEnabled = config.openclawThinkingOff;
        const nextEnabled = Boolean(enabledInput);
        const nextConfig: PluginConfig = {
            ...config,
            openclawThinkingOff: nextEnabled,
        };
        this.config = nextConfig;
        await this.persistResolvedProfile(nextConfig, this.device, true);
        return {
            enabled: nextEnabled,
            previousEnabled,
            changed: nextEnabled !== previousEnabled,
        };
    }

    private async updateOpenclawForceNonStreaming(enabledInput: boolean) {
        const config = await this.loadConfig(false);
        const previousEnabled = config.openclawForceNonStreaming;
        const nextEnabled = Boolean(enabledInput);
        let endpointChanged = false;
        let restarting = false;

        if (nextEnabled) {
            const endpointResult = await this.ensureOpenclawResponsesEndpointEnabled(config);
            endpointChanged = endpointResult.changed;
            restarting = endpointResult.restarting;
        }

        const nextConfig: PluginConfig = {
            ...config,
            openclawForceNonStreaming: nextEnabled,
        };
        this.config = nextConfig;
        await this.persistResolvedProfile(nextConfig, this.device, true);
        return {
            enabled: nextEnabled,
            previousEnabled,
            changed: nextEnabled !== previousEnabled,
            endpointChanged,
            restarting,
        };
    }

    private async updateOpenclawWorkspaceFile(
        fileRef: OpenclawWorkspaceFileId | string,
        options?: {
            content?: string;
            enabled?: boolean;
        }
    ) {
        const definition = findOpenclawWorkspaceFileDefinition(fileRef);
        if (!definition) {
            throw new Error(`不支持的 workspace 文件: ${String(fileRef || "")}`);
        }
        const config = await this.loadConfig(false);
        const agentId = readString(config.openclawAgent) || "main";
        const globalConfig = await readOpenclawGlobalConfig(this.api);
        const { agentConfig } = this.readOpenclawAgentConfig(globalConfig, agentId);
        if (!agentConfig) {
            throw new Error(`没有找到 id 为 ${agentId} 的 OpenClaw agent。`);
        }
        const workspacePath = this.resolveOpenclawAgentWorkspacePath(
            agentId,
            agentConfig,
            globalConfig
        );
        if (!workspacePath) {
            throw new Error(
                `没有找到 id 为 ${agentId} 的 OpenClaw agent workspace，暂时不能写入 ${definition.filename}。`
            );
        }

        const previousFile = await this.readOpenclawWorkspaceFileState(
            workspacePath,
            definition.id
        );
        const requestedEnabled = typeof options?.enabled === "boolean" ? options.enabled : true;

        if (!requestedEnabled) {
            await this.disableOpenclawWorkspaceFile(workspacePath, definition.id);
            const file = await this.readOpenclawWorkspaceFileState(workspacePath, definition.id);
            return {
                file,
                previousFile,
                changed: previousFile.enabled,
                disabled: true,
            };
        }

        const normalizedContent = await this.writeOpenclawWorkspaceFile(
            workspacePath,
            definition.id,
            options?.content ?? ""
        );
        if (definition.id === "agents") {
            const nextConfig: PluginConfig = {
                ...config,
                openclawVoiceSystemPrompt: normalizedContent,
            };
            this.config = nextConfig;
            await this.persistResolvedProfile(nextConfig, this.device, true);
        }
        const file = await this.readOpenclawWorkspaceFileState(workspacePath, definition.id);
        return {
            file,
            previousFile,
            changed:
                !previousFile.enabled ||
                previousFile.content !== file.content ||
                previousFile.customized !== file.customized,
            disabled: false,
        };
    }

    private async updateOpenclawVoiceSystemPrompt(promptInput: string | undefined) {
        const result = await this.updateOpenclawWorkspaceFile("agents", {
            content: promptInput,
            enabled: true,
        });
        return {
            prompt: result.file.content,
            previousPrompt: result.previousFile.content,
            changed: result.changed,
            customized: result.file.customized,
            restarting: false,
        };
    }

    private async updateTransitionPhrases(phrasesInput: any) {
        const config = await this.loadConfig(false);
        const previousPhrases = normalizeTransitionPhrasesInput(config.transitionPhrases, {
            fallbackToDefault: true,
        });
        const nextPhrases = normalizeTransitionPhrasesInput(phrasesInput, {
            fallbackToDefault: true,
        });
        const nextConfig: PluginConfig = {
            ...config,
            transitionPhrases: nextPhrases,
        };
        this.config = nextConfig;
        await this.persistResolvedProfile(nextConfig, this.device, true);
        return {
            phrases: nextPhrases,
            previousPhrases,
            changed: JSON.stringify(nextPhrases) !== JSON.stringify(previousPhrases),
            customized:
                JSON.stringify(nextPhrases) !== JSON.stringify(DEFAULT_TRANSITION_PHRASES),
        };
    }

    private async updateDebugLogEnabled(enabledInput: boolean) {
        const config = await this.loadConfig(false);
        const previousEnabled = config.debugLogEnabled;
        const nextEnabled = Boolean(enabledInput);
        const nextConfig: PluginConfig = {
            ...config,
            debugLogEnabled: nextEnabled,
        };
        this.config = nextConfig;
        this.accountClient?.setDebugLogEnabled(nextEnabled);
        if (nextEnabled) {
            await this.accountClient?.maintainDebugLog(true).catch(() => undefined);
        }
        await this.persistResolvedProfile(nextConfig, this.device, true);
        return {
            enabled: nextEnabled,
            previousEnabled,
            changed: nextEnabled !== previousEnabled,
        };
    }

    private async updateVoiceContextLimits(turnsInput: number, charsInput: number) {
        const config = await this.loadConfig(false);
        const previousTurns = config.voiceContextMaxTurns;
        const previousChars = config.voiceContextMaxChars;
        const nextTurns = clamp(
            Math.round(Number(turnsInput) || 0),
            0,
            MAX_VOICE_CONTEXT_TURNS
        );
        const nextChars = clamp(
            Math.round(Number(charsInput) || 0),
            0,
            MAX_VOICE_CONTEXT_CHARS
        );
        const nextConfig: PluginConfig = {
            ...config,
            voiceContextMaxTurns: nextTurns,
            voiceContextMaxChars: nextChars,
        };
        this.config = nextConfig;
        if (nextTurns === 0 || nextChars === 0) {
            this.voiceContextTurns = [];
            this.voiceContextArchiveSessionKey = undefined;
            this.voiceContextArchiveText = "";
        } else if (this.voiceContextTurns.length > nextTurns) {
            const overflowTurns = this.voiceContextTurns.slice(0, this.voiceContextTurns.length - nextTurns);
            this.mergeVoiceContextArchive(
                this.openclawVoiceSessionKey,
                overflowTurns,
                nextChars
            );
            this.voiceContextTurns = this.voiceContextTurns.slice(-nextTurns);
        }
        await this.persistResolvedProfile(nextConfig, this.device, true);
        return {
            turns: nextTurns,
            chars: nextChars,
            previousTurns,
            previousChars,
            changed: nextTurns !== previousTurns || nextChars !== previousChars,
        };
    }

    private async finalizeAccountLoginWithoutDevice(
        config: PluginConfig,
        accountClient: XiaomiAccountClient
    ) {
        const message = "账号已登录，请返回控制台选择要接管的音箱。";
        await accountClient.saveTokenStore();
        this.stopPolling();
        this.initPromise = undefined;
        this.config = config;
        this.accountClient = accountClient;
        this.minaClient = new MiNAClient(accountClient);
        this.miioClient = new MiIOClient(accountClient, config.serverCountry);
        this.specClient = new MiotSpecClient();
        this.device = undefined;
        this.lastConversationTimestamp = 0;
        this.lastConversationRequestId = "";
        this.lastConversationQuery = "";
        this.waitingForResponse = false;
        this.lastDialogWindowOpenedAt = 0;
        this.lastError = message;
        await this.persistResolvedProfile(config, undefined, true);
        await this.appendConsoleEvent(
            "login.account_ready",
            "账号已登录",
            message,
            "success"
        );
        return {
            message,
        };
    }

    private async validateCloudConfig(
        config: PluginConfig,
        accountClient: XiaomiAccountClient
    ): Promise<DeviceContext> {
        const mina = new MiNAClient(accountClient);
        const miio = new MiIOClient(accountClient, config.serverCountry);
        const spec = new MiotSpecClient();
        const device = await this.resolveDeviceContextFor(config, mina, miio, spec);
        await this.fetchLatestConversationFor(mina, device).catch(() => null);
        return device;
    }

    private async reinitializeAfterLogin() {
        this.resetRuntimeState();

        try {
            await this.ensureReady();
            this.startPolling();
        } catch (error) {
            throw new Error(
                `登录信息已保存，但插件重新初始化失败: ${this.errorMessage(
                    this.decorateNotReadyError(error)
                )}`
            );
        }
    }

    private async loginRequiredSids(accountClient: XiaomiAccountClient) {
        for (const sid of CLOUD_LOGIN_SIDS) {
            await accountClient.login(sid);
        }
    }

    private async continueVerifiedLogin(
        accountClient: XiaomiAccountClient,
        sid: XiaomiSid,
        ticket: string
    ) {
        await accountClient.completeVerification(sid, ticket);
        for (const nextSid of CLOUD_LOGIN_SIDS) {
            if (nextSid === sid) {
                continue;
            }
            await accountClient.login(nextSid);
        }
    }

    private async handlePasswordLogin(
        sessionId: string,
        payload: LoginSubmission
    ): Promise<LoginSuccessPayload | LoginVerificationPayload> {
        const nextConfig = await this.buildPasswordLoginConfig(payload);
        this.pendingVerifications.delete(sessionId);

        try {
            const accountClient = new XiaomiAccountClient({
                username: nextConfig.account || "anonymous",
                password: payload.password,
                tokenStorePath: nextConfig.tokenStorePath,
                debugLogPath: nextConfig.debugLogPath,
                debugLogEnabled: nextConfig.debugLogEnabled,
                pythonCommand: nextConfig.pythonCommand,
            });
            await accountClient.resetDebugLog({
                flow: "login_password",
                account: nextConfig.account || "anonymous",
                serverCountry: nextConfig.serverCountry,
                tokenStorePath: nextConfig.tokenStorePath,
            });
            await accountClient.invalidateSid("micoapi").catch(() => undefined);
            await accountClient.invalidateSid("xiaomiio").catch(() => undefined);
            await accountClient.clearStoredPassToken().catch(() => undefined);
            await this.loginRequiredSids(accountClient);

            if (!this.hasDeviceSelectionSeed(nextConfig)) {
                return this.finalizeAccountLoginWithoutDevice(nextConfig, accountClient);
            }

            const device = await this.validateCloudConfig(nextConfig, accountClient);
            await this.persistResolvedProfile(nextConfig, device, true);
            await this.reinitializeAfterLogin();
            await this.notifyLoginSuccess(device);

            return {
                message: `登录成功，已接入设备 ${device.name} (${device.hardware}/${device.model})。`,
            };
        } catch (error) {
            if (error instanceof XiaomiVerificationRequiredError) {
                this.pendingVerifications.set(sessionId, {
                    kind: "login_password",
                    sid: error.sid,
                    payload,
                    state: error.state,
                });
                return this.createVerificationPayload(error);
            }
            throw this.withDeviceDiscoverHint(error);
        }
    }

    private async handleVerificationTicket(
        sessionId: string,
        payload: VerificationTicketSubmission
    ): Promise<LoginDiscoveryPayload | LoginSuccessPayload | LoginVerificationPayload> {
        const ticket = readString(payload.ticket);
        if (!ticket) {
            throw new Error("请输入短信或邮箱收到的验证码。");
        }

        const pending = this.pendingVerifications.get(sessionId);
        if (!pending) {
            throw new Error("当前没有待处理的二次验证会话，请重新点一次“登录”。");
        }

        const nextConfig = await this.buildPasswordLoginConfig(pending.payload);
        const accountClient = new XiaomiAccountClient({
            username: nextConfig.account || "anonymous",
            password: nextConfig.password,
            tokenStorePath: nextConfig.tokenStorePath,
            debugLogPath: nextConfig.debugLogPath,
            debugLogEnabled: nextConfig.debugLogEnabled,
            pythonCommand: nextConfig.pythonCommand,
        });
        accountClient.setVerificationState(pending.state);

        try {
            await this.continueVerifiedLogin(accountClient, pending.sid, ticket);
        } catch (error) {
            if (error instanceof XiaomiVerificationRequiredError) {
                this.pendingVerifications.set(sessionId, {
                    ...pending,
                    sid: error.sid,
                    state: error.state,
                });
                return this.createVerificationPayload(error);
            }
            throw error instanceof Error ? error : new Error(this.errorMessage(error));
        }

        this.pendingVerifications.delete(sessionId);

        if (pending.kind === "discover_password") {
            const devices = await this.discoverAvailableDevices(nextConfig, accountClient);
            return {
                message:
                    devices.length === 1
                        ? "验证码校验通过，已发现 1 台可用小爱。"
                        : `验证码校验通过，已发现 ${devices.length} 台可用小爱，请点选目标音箱。`,
                devices,
            };
        }

        if (!this.hasDeviceSelectionSeed(nextConfig)) {
            return this.finalizeAccountLoginWithoutDevice(nextConfig, accountClient);
        }

        const device = await this.validateCloudConfig(nextConfig, accountClient);
        await this.persistResolvedProfile(nextConfig, device, true);
        await this.reinitializeAfterLogin();
        await this.notifyLoginSuccess(device);

        return {
            message: `验证完成，已接入设备 ${device.name} (${device.hardware}/${device.model})。`,
        };
    }

    private async handlePrepareVerificationPage(
        sessionId: string,
        preferredMethod?: XiaomiVerificationMethod
    ): Promise<VerificationPageOpenPayload> {
        const pending = this.pendingVerifications.get(sessionId);
        if (!pending) {
            throw new Error("当前没有待处理的二次验证会话，请重新点一次“登录”。");
        }

        const nextConfig = await this.buildPasswordLoginConfig(pending.payload);
        const accountClient = new XiaomiAccountClient({
            username: nextConfig.account || "anonymous",
            password: nextConfig.password,
            tokenStorePath: nextConfig.tokenStorePath,
            debugLogPath: nextConfig.debugLogPath,
            debugLogEnabled: nextConfig.debugLogEnabled,
            pythonCommand: nextConfig.pythonCommand,
        });
        accountClient.setVerificationState(pending.state);

        const result = await accountClient.prepareVerificationPage(preferredMethod);
        const nextState = accountClient.getVerificationState() || pending.state;
        this.pendingVerifications.set(sessionId, {
            ...pending,
            state: nextState,
        });

        return {
            message: result.message,
            openUrl: result.openUrl,
            verification: {
                verifyUrl: nextState.verifyUrl,
                methods: nextState.verifyMethods,
            },
        };
    }

    private async resolveDeviceContextFor(
        config: PluginConfig,
        minaClient: MiNAClient,
        miioClient: MiIOClient,
        specClient: MiotSpecClient
    ): Promise<DeviceContext> {
        const minaDevices = await minaClient.deviceList();
        const selectedMinaDevice =
            selectMinaDevice(minaDevices, {
                miDid: config.miDid,
                minaDeviceId: config.minaDeviceId,
                hardware: config.hardware,
                speakerName: config.speakerName,
            }) ||
            (() => {
                if (config.minaDeviceId && config.hardware) {
                    return {
                        deviceID: config.minaDeviceId,
                        hardware: config.hardware,
                        miotDID: config.miDid,
                        alias: config.speakerName || config.hardware,
                        name: config.speakerName || config.hardware,
                    };
                }
                return null;
            })();

        if (!selectedMinaDevice?.deviceID) {
            throw new Error(
                "无法从小爱设备列表中定位目标音箱。请至少提供 speakerName、hardware、miDid 或 minaDeviceId。"
            );
        }

        const minaModel = readMinaDeviceModel(selectedMinaDevice);
        const inferredHardware =
            pickFirstString(
                config.hardware,
                selectedMinaDevice.hardware,
                hardwareFromModel(minaModel)
            ) || undefined;
        const miioDevices = await miioClient.deviceListFull();
        const selectedMiioDevice =
            selectMiioDevice(miioDevices, {
                miDid: pickFirstString(config.miDid, String(selectedMinaDevice.miotDID || "")),
                speakerName: config.speakerName,
                model: minaModel,
                hardware: inferredHardware,
            }) ||
            (() => {
                const model = pickFirstString(
                    minaModel,
                    inferredHardware ? `xiaomi.wifispeaker.${inferredHardware.toLowerCase()}` : undefined
                );
                if (!model) {
                    return null;
                }
                return {
                    did:
                        pickFirstString(
                            config.miDid,
                            String(selectedMinaDevice.miotDID || "")
                        ) || "",
                    model,
                    name: config.speakerName,
                } as const;
            })();

        const hardware = pickFirstString(
            config.hardware,
            selectedMinaDevice.hardware,
            hardwareFromModel(selectedMiioDevice?.model),
            hardwareFromModel(minaModel)
        );
        const miDid = pickFirstString(
            config.miDid,
            String(selectedMinaDevice.miotDID || ""),
            selectedMiioDevice?.did
        );
        const model = pickFirstString(
            selectedMiioDevice?.model,
            minaModel,
            hardware ? `xiaomi.wifispeaker.${hardware.toLowerCase()}` : undefined
        );
        const name = pickFirstString(
            config.speakerName,
            selectedMiioDevice?.name,
            readString(selectedMinaDevice.alias),
            readString(selectedMinaDevice.name),
            hardware
        );

        if (!hardware) {
            throw new Error(
                "无法确定音箱 hardware。请在配置或登录页面中显式填写 hardware，或确保能从设备 model 自动识别。"
            );
        }
        if (!miDid) {
            throw new Error(
                "无法确定音箱 DID。请在配置或登录页面中显式填写 miDid。"
            );
        }
        if (!model) {
            throw new Error("无法确定音箱 model。");
        }

        const spec = await specClient.getSpecForModel(model);
        const speakerFeatures = normalizeSpeakerFeaturesForDevice(pickSpeakerFeatures(spec));

        return {
            hardware,
            model,
            miDid,
            minaDeviceId: String(selectedMinaDevice.deviceID),
            name: name || `${hardware}/${miDid}`,
            speakerFeatures,
        };
    }

    private async resolveDeviceContext(): Promise<DeviceContext> {
        if (!this.config || !this.minaClient || !this.miioClient || !this.specClient) {
            throw new Error("XiaoAI Cloud 客户端尚未初始化。");
        }
        return this.resolveDeviceContextFor(
            this.config,
            this.minaClient,
            this.miioClient,
            this.specClient
        );
    }

    private noteConversationFetchLatency(deviceId?: string, observedMs?: number) {
        const normalizedDeviceId = readString(deviceId);
        const nextObservedMs = readNumber(observedMs);
        if (
            !normalizedDeviceId ||
            typeof nextObservedMs !== "number" ||
            !Number.isFinite(nextObservedMs) ||
            nextObservedMs <= 0
        ) {
            return undefined;
        }
        const boundedObservedMs = clamp(Math.round(nextObservedMs), 40, 5_000);
        const current = this.conversationFetchLatencyProfiles.get(normalizedDeviceId);
        const previousEstimate = readNumber(current?.estimateMs);
        const nextEstimate =
            typeof previousEstimate === "number" && Number.isFinite(previousEstimate)
                ? boundedObservedMs >= previousEstimate
                    ? clamp(
                        Math.round(
                            previousEstimate * 0.72 +
                                Math.min(
                                    boundedObservedMs,
                                    Math.max(
                                        previousEstimate * 1.8,
                                        previousEstimate + 240
                                    )
                                ) *
                                    0.28
                        ),
                        40,
                        5_000
                    )
                    : clamp(
                        Math.round(
                            previousEstimate * 0.38 + boundedObservedMs * 0.62
                        ),
                        40,
                        5_000
                    )
                : boundedObservedMs;
        this.conversationFetchLatencyProfiles.set(normalizedDeviceId, {
            estimateMs: nextEstimate,
            updatedAtMs: Date.now(),
        });
        return nextEstimate;
    }

    private readConversationFetchLatencyEstimate(deviceId?: string) {
        const normalizedDeviceId = readString(deviceId);
        if (!normalizedDeviceId) {
            return undefined;
        }
        return readNumber(
            this.conversationFetchLatencyProfiles.get(normalizedDeviceId)?.estimateMs
        );
    }

    private shouldUseHedgedConversationFetch(deviceId?: string) {
        return Boolean(
            readString(deviceId) &&
                (this.conversationInterceptCalibrationRunning ||
                    this.waitingForResponse ||
                    Date.now() < this.fastPollUntil)
        );
    }

    private computeConversationFetchHedgeDelayMs(deviceId?: string) {
        const estimateMs =
            this.readConversationFetchLatencyEstimate(deviceId) ||
            CONVERSATION_FETCH_ESTIMATE_DEFAULT_MS;
        const currentPollMs = this.currentPollInterval(this.config);
        return clamp(
            Math.round(
                Math.max(
                    CONVERSATION_FETCH_HEDGE_MIN_DELAY_MS,
                    Math.min(estimateMs * 0.33, currentPollMs + 20)
                )
            ),
            CONVERSATION_FETCH_HEDGE_MIN_DELAY_MS,
            CONVERSATION_FETCH_HEDGE_MAX_DELAY_MS
        );
    }

    private async performConversationFetch(
        minaClient: MiNAClient,
        device: DeviceContext
    ): Promise<any | null> {
        const startedAtMs = Date.now();
        this.conversationFetchInflightCount += 1;
        try {
            const response = await minaClient.fetchConversation(
                device.hardware,
                device.minaDeviceId,
                3
            );
            const rawData = response?.data;
            const payload =
                typeof rawData === "string"
                    ? readJsonObject<Record<string, any>>(rawData, "小爱最新会话 data")
                    : rawData;
            const records = Array.isArray(payload?.records) ? payload.records : [];
            this.noteConversationFetchLatency(
                device.minaDeviceId,
                Date.now() - startedAtMs
            );
            return this.selectLatestConversationCandidate(records);
        } finally {
            this.conversationFetchInflightCount = Math.max(
                0,
                this.conversationFetchInflightCount - 1
            );
        }
    }

    private selectLatestConversationCandidate(records: any[]): any | null {
        if (!Array.isArray(records) || records.length <= 0) {
            return null;
        }
        const candidates = records
            .map((record, index) => ({
                record,
                normalized: this.normalizeConversationRecord(record, index),
                timestamp: readNumber(record?.time) || 0,
            }))
            .filter((item) => item.normalized.query)
            .sort((left, right) => {
                if (left.timestamp !== right.timestamp) {
                    return right.timestamp - left.timestamp;
                }
                return left.normalized.answers.length - right.normalized.answers.length;
            });
        if (candidates.length <= 0) {
            return records[0] || null;
        }
        const freshestTimestamp = candidates[0]?.timestamp || 0;
        const nearFreshCandidates = candidates.filter((item) => {
            if (freshestTimestamp <= 0 || item.timestamp <= 0) {
                return true;
            }
            return freshestTimestamp - item.timestamp <= 2500;
        });
        const earliestVisibleCandidate = nearFreshCandidates.find(
            (item) => item.normalized.answers.length <= 0
        );
        return (
            earliestVisibleCandidate?.record ||
            nearFreshCandidates[0]?.record ||
            candidates[0]?.record ||
            records[0] ||
            null
        );
    }

    private async fetchLatestConversationFor(
        minaClient: MiNAClient,
        device: DeviceContext,
        options?: {
            hedged?: boolean;
        }
    ): Promise<any | null> {
        const key = `${device.hardware}:${device.minaDeviceId}`;
        const allowHedge =
            options?.hedged === true &&
            this.shouldUseHedgedConversationFetch(device.minaDeviceId) &&
            this.conversationFetchInflightCount < MAX_CONVERSATION_FETCH_INFLIGHT - 1;
        if (allowHedge) {
            const primaryStartedAtMs = Date.now();
            const primary = this.performConversationFetch(minaClient, device).then(
                (record) => ({
                    record,
                    source: "primary" as const,
                    elapsedMs: Math.max(0, Date.now() - primaryStartedAtMs),
                })
            );
            const hedgeDelayMs = this.computeConversationFetchHedgeDelayMs(
                device.minaDeviceId
            );
            const hedge = (async () => {
                await sleep(hedgeDelayMs);
                if (
                    this.conversationFetchInflightCount >=
                    MAX_CONVERSATION_FETCH_INFLIGHT
                ) {
                    return primary;
                }
                const hedgeStartedAtMs = Date.now();
                const record = await this.performConversationFetch(minaClient, device);
                return {
                    record,
                    source: "hedge" as const,
                    elapsedMs: Math.max(0, Date.now() - hedgeStartedAtMs),
                };
            })();
            const winner = await Promise.race([primary, hedge]);
            if (winner.source === "hedge") {
                void this.appendDebugTrace("conversation_fetch_hedged_won", {
                    deviceId: device.minaDeviceId,
                    hedgeDelayMs,
                    elapsedMs: winner.elapsedMs,
                    estimateMs: this.readConversationFetchLatencyEstimate(
                        device.minaDeviceId
                    ),
                });
            }
            return winner.record;
        }
        if (
            this.latestConversationFetchPromise &&
            this.latestConversationFetchKey === key
        ) {
            return this.latestConversationFetchPromise;
        }

        const request = this.performConversationFetch(minaClient, device);

        this.latestConversationFetchKey = key;
        this.latestConversationFetchPromise = request;

        try {
            return await request;
        } finally {
            if (this.latestConversationFetchPromise === request) {
                this.latestConversationFetchKey = undefined;
                this.latestConversationFetchPromise = undefined;
            }
        }
    }

    private async primeConversationCursor() {
        if (!this.minaClient || !this.device) {
            return;
        }
        try {
            const latest = await this.fetchLatestConversationFor(
                this.minaClient,
                this.device,
                { hedged: true }
            );
            if (!latest) {
                return;
            }
            this.lastConversationTimestamp = Number(latest.time || 0);
            this.lastConversationRequestId = String(latest.requestId || "");
            this.lastConversationQuery = String(latest.query || "");
        } catch (error) {
            const message = this.errorMessage(error);
            if (!this.isTransientNetworkError(message)) {
                this.lastError = message;
            }
            await this.appendDebugTrace("conversation_cursor_prime_failed", {
                message,
            });
            console.warn(
                `[XiaoAI Cloud] 初始化时读取最近会话失败，稍后会自动重试: ${message}`
            );
        }
    }

    private async fetchLatestConversation(): Promise<any | null> {
        if (!this.minaClient || !this.device) {
            throw new Error("小爱云后端尚未初始化。");
        }

        return this.fetchLatestConversationFor(this.minaClient, this.device, {
            hedged: true,
        });
    }

    private startPolling() {
        if (this.polling) {
            return;
        }
        this.polling = true;
        this.pollingStartedAt = Date.now();

        const loop = async () => {
            if (!this.polling) {
                return;
            }

            const cycleStartedAt = Date.now();
            try {
                await this.pollConversationOnce();
            } catch (error) {
                const message = this.errorMessage(error);
                if (
                    this.isTransientNetworkError(message) ||
                    this.isRateLimitedNetworkError(message)
                ) {
                    const backoff = this.notePollTransientBackoff(message);
                    console.warn(
                        `[XiaoAI Cloud] 会话轮询暂时失败，将自动重试${
                            backoff.floorMs > 0
                                ? `，并临时退避到 ${backoff.floorMs}ms`
                                : ""
                        }: ${message}`
                    );
                    await this.appendDebugTrace("conversation_poll_transient_error", {
                        message,
                        backoffFloorMs: backoff.floorMs,
                        backoffReason: backoff.reason,
                        backoffUntil: new Date(backoff.untilMs).toISOString(),
                    });
                } else {
                    this.lastError = message;
                    console.error(`[XiaoAI Cloud] 会话轮询失败: ${message}`);
                }
                if (this.shouldResetRuntime(message)) {
                    this.resetRuntimeState({ preserveVoiceSession: true });
                    await this.handleInitializationFailure(error).catch((portalError) => {
                        console.error(
                            `[XiaoAI Cloud] 会话异常后生成登录入口失败: ${this.errorMessage(
                                portalError
                            )}`
                        );
                    });
                }
            } finally {
                if (this.polling) {
                    const config = await this.loadConfig(false).catch(() => this.config);
                    if (config) {
                        const desiredInterval = this.currentPollInterval(config);
                        const elapsedMs = Date.now() - cycleStartedAt;
                        this.schedulePollingLoop(Math.max(0, desiredInterval - elapsedMs));
                    }
                }
            }
        };

        this.pollLoopRunner = () => {
            void loop().catch((error) => {
                this.lastError = this.errorMessage(error);
                console.error(`[XiaoAI Cloud] 启动轮询失败: ${this.lastError}`);
            });
        };

        this.pollLoopRunner();
    }

    private async pollConversationOnce() {
        await this.ensureReady();
        const latest = await this.fetchLatestConversation();
        if (!latest) {
            return;
        }

        const latestTimestamp = Number(latest.time || 0);
        const latestRequestId = String(latest.requestId || "");
        const latestQuery = String(latest.query || "").trim();
        const recordAgeMs =
            latestTimestamp > 0 ? Math.max(0, Date.now() - latestTimestamp) : 0;

        if (!latestQuery) {
            return;
        }

        const normalizedConversation = this.normalizeConversationRecord(latest);

        const isDuplicate =
            latestTimestamp < this.lastConversationTimestamp ||
            (latestTimestamp === this.lastConversationTimestamp &&
                latestRequestId &&
                latestRequestId === this.lastConversationRequestId) ||
            (latestTimestamp === this.lastConversationTimestamp &&
                !latestRequestId &&
                latestQuery === this.lastConversationQuery);

        if (isDuplicate) {
            return;
        }

        this.lastConversationTimestamp = latestTimestamp;
        this.lastConversationRequestId = latestRequestId;
        this.lastConversationQuery = latestQuery;

        if (
            this.shouldIgnoreStartupStaleConversationRecord(
                recordAgeMs,
                normalizedConversation.answers.length > 0
            )
        ) {
            await this.appendDebugTrace("conversation_record_ignored", {
                reason: "startup_stale_answered_record",
                requestId: latestRequestId || undefined,
                query: latestQuery,
                recordAgeMs,
                answerCount: normalizedConversation.answers.length,
            });
            return;
        }

        if (this.shouldIgnoreSelfTriggeredQuery(latestQuery, latestTimestamp || Date.now())) {
            return;
        }
        this.recordConsoleEvent(
            "conversation.user",
            "用户对小爱说",
            normalizedConversation.query,
            "info"
        );
        for (const answer of normalizedConversation.answers) {
            this.recordConsoleEvent(
                "conversation.answer",
                "小爱回复",
                answer,
                "success"
            );
        }

        console.log(`<- [语音识别/云端] "${latestQuery}" | 当前模式: ${this.currentMode}`);
        await this.handleIncomingQuery(latestQuery, {
            answersPresent: normalizedConversation.answers.length > 0,
            answerCount: normalizedConversation.answers.length,
            recordAgeMs,
        });
    }

    private async handleIncomingQuery(
        query: string,
        hint?: ConversationInterceptHint
    ) {
        switch (this.currentMode) {
            case "silent":
                console.log("   [静默] 跳过，不拦截");
                return;
            case "proxy":
                console.log("   [代理] 拦截所有对话");
                this.armFastPolling();
                {
                    const renewVoiceSession = this.shouldStartNewVoiceSession(query);
                    if (renewVoiceSession) {
                        console.log("   [会话] 检测到显式新会话请求，将切换到新的 OpenClaw 会话");
                    }
                    await this.interceptAndForward(query, {
                        renewVoiceSession,
                        interceptHint: hint,
                    });
                }
                return;
            case "wake":
            default: {
                const currentTime = Date.now() / 1000;
                const timeSinceWindowOpened = currentTime - this.lastDialogWindowOpenedAt;
                const isWakeWordTriggered = this.wakeWordRegex.test(query);
                const isContinuousDialog =
                    this.lastDialogWindowOpenedAt > 0 &&
                    timeSinceWindowOpened <= this.continuousDialogWindow;

                if (isWakeWordTriggered || isContinuousDialog) {
                    this.armDialogWindow(currentTime);
                    const renewVoiceSession = this.shouldStartNewVoiceSession(query);
                    console.log(
                        `   [唤醒] 捕获: "${query}" (唤醒词: ${isWakeWordTriggered}, 免唤醒: ${isContinuousDialog})`
                    );
                    if (renewVoiceSession) {
                        console.log("   [会话] 检测到显式新会话请求，将切换到新的 OpenClaw 会话");
                    }
                    await this.interceptAndForward(query, {
                        renewVoiceSession,
                        interceptHint: hint,
                    });
                } else {
                    const windowState =
                        this.lastDialogWindowOpenedAt > 0
                            ? `${timeSinceWindowOpened.toFixed(1)}s`
                            : "从未激活";
                    console.log(
                        `   [唤醒] 跳过：无唤醒词且不在对话窗口内 (距上次窗口激活 ${windowState})`
                    );
                }
            }
        }
    }

    private pruneRecentSelfTriggeredQueries(nowMs = Date.now()) {
        this.recentSelfTriggeredQueries = this.recentSelfTriggeredQueries
            .filter((item) => nowMs - item.timeMs <= SELF_TRIGGER_QUERY_IGNORE_WINDOW_MS)
            .slice(-MAX_SELF_TRIGGER_QUERY_HISTORY);
        XiaoaiCloudPlugin.sharedRecentSelfTriggeredQueries =
            XiaoaiCloudPlugin.sharedRecentSelfTriggeredQueries
                .filter((item) => nowMs - item.timeMs <= SELF_TRIGGER_QUERY_IGNORE_WINDOW_MS)
                .slice(-MAX_SELF_TRIGGER_QUERY_HISTORY);
    }

    private rememberSelfTriggeredQuery(text: string, source: RecentSelfTriggeredQuery["source"]) {
        const normalized = normalizeEventText(text, 240) || text.trim();
        if (!normalized) {
            return;
        }

        const comparable = comparableDirectiveText(normalized) || comparableConversationText(normalized);
        const timeMs = Date.now();
        this.pruneRecentSelfTriggeredQueries(timeMs);
        this.recentSelfTriggeredQueries.push({
            text: normalized,
            comparable,
            source,
            timeMs,
        });
        XiaoaiCloudPlugin.sharedRecentSelfTriggeredQueries.push({
            text: normalized,
            comparable,
            source,
            timeMs,
        });
        this.pruneRecentSelfTriggeredQueries(timeMs);
        console.log(`   [回声抑制] 记录主动执行指令: "${normalized}"`);
        void this.appendDebugTrace("conversation_self_trigger_recorded", {
            text: normalized,
            comparable,
            source,
            timeMs,
        });
    }

    private shouldIgnoreSelfTriggeredQuery(query: string, queryTimeMs: number) {
        const normalized = normalizeEventText(query, 240) || query.trim();
        if (!normalized) {
            return false;
        }

        const comparable = comparableDirectiveText(normalized) || comparableConversationText(normalized);
        this.pruneRecentSelfTriggeredQueries(queryTimeMs || Date.now());
        const matched = [
            ...this.recentSelfTriggeredQueries,
            ...XiaoaiCloudPlugin.sharedRecentSelfTriggeredQueries,
        ]
            .sort((left, right) => right.timeMs - left.timeMs)
            .find((item) => {
                if (queryTimeMs < item.timeMs) {
                    return false;
                }
                if (queryTimeMs - item.timeMs > SELF_TRIGGER_QUERY_IGNORE_WINDOW_MS) {
                    return false;
                }
                if (item.text === normalized || (comparable && comparable === item.comparable)) {
                    return true;
                }
                if (!comparable || !item.comparable) {
                    return false;
                }
                return (
                    comparable.includes(item.comparable) ||
                    item.comparable.includes(comparable)
                );
            });

        if (!matched) {
            return false;
        }

        const deltaMs = Math.max(0, queryTimeMs - matched.timeMs);
        console.log(
            `   [回声抑制] 忽略最近由插件主动触发的执行指令回灌: "${normalized}" | ${deltaMs}ms`
        );
        void this.appendDebugTrace("conversation_self_trigger_ignored", {
            query: normalized,
            source: matched.source,
            deltaMs,
        });
        return true;
    }

    private shouldStartNewVoiceSession(query: string) {
        const normalized = normalizeEventText(query, 200) || query.trim();
        if (!normalized) {
            return false;
        }

        if (/(不要|别|不用|不必|无需).{0,8}(新会话|新对话|新聊天|重置|清空|从头开始)/.test(normalized)) {
            return false;
        }

        return [
            /(开启|开个|打开|开始|新建|创建|换个|切换到|重新开|重开)(?:一个|一段|个)?新(?:的)?(会话|对话|聊天)/,
            /(重置|清空)(?:一下|当前|这次|这一轮)?(会话|对话|上下文|记忆)/,
            /从头开始(?:聊|对话|说|继续聊)/,
            /(忘掉|清掉)(?:之前|前面)(?:的)?(内容|上下文|记忆|对话)/,
        ].some((pattern) => pattern.test(normalized));
    }

    private remoteWakeArmsDialogWindow() {
        return false;
    }

    private shouldInterceptQuery(query: string, nowSeconds = Date.now() / 1000) {
        if (!query.trim()) {
            return false;
        }
        switch (this.currentMode) {
            case "silent":
                return false;
            case "proxy":
                return true;
            case "wake":
            default: {
                const timeSinceWindowOpened = nowSeconds - this.lastDialogWindowOpenedAt;
                const isWakeWordTriggered = this.wakeWordRegex.test(query);
                const isContinuousDialog =
                    this.lastDialogWindowOpenedAt > 0 &&
                    timeSinceWindowOpened <= this.continuousDialogWindow;
                return isWakeWordTriggered || isContinuousDialog;
            }
        }
    }

    private hasActiveOpenclawVoiceSession() {
        return Boolean(this.openclawVoiceSessionKey);
    }

    private buildOpenclawVoiceSessionKey(token?: string) {
        const agentId = readString(this.config?.openclawAgent) || "main";
        const baseKey = `agent:${agentId}:xiaoai-voice`;
        return token ? `${baseKey}:${token}` : baseKey;
    }

    private resetOpenclawVoiceSession(options?: { fresh?: boolean }) {
        const token = options?.fresh
            ? `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`
            : undefined;
        this.openclawVoiceSessionKey = this.buildOpenclawVoiceSessionKey(token);
        this.openclawVoiceSessionExpiresAt = 0;
        this.voiceContextTurns = [];
        this.voiceContextArchiveSessionKey = undefined;
        this.voiceContextArchiveText = "";
    }

    private resolveOpenclawVoiceSessionKey(forceNew = false) {
        const nowSeconds = Date.now() / 1000;
        const baseSessionKey = this.buildOpenclawVoiceSessionKey();
        const baseSessionPrefix = `${baseSessionKey}:`;
        const hasCompatibleSessionKey = Boolean(
            this.openclawVoiceSessionKey &&
                (this.openclawVoiceSessionKey === baseSessionKey ||
                    this.openclawVoiceSessionKey.startsWith(baseSessionPrefix))
        );
        if (forceNew) {
            this.resetOpenclawVoiceSession({ fresh: true });
        } else if (!hasCompatibleSessionKey || !this.hasActiveOpenclawVoiceSession()) {
            this.resetOpenclawVoiceSession();
        }
        this.openclawVoiceSessionExpiresAt = Math.max(
            this.openclawVoiceSessionExpiresAt,
            (nowSeconds + this.continuousDialogWindow + 2) * 1000
        );
        return this.openclawVoiceSessionKey as string;
    }

    private compressVoiceContextTurns(turns: VoiceContextTurn[], maxChars: number) {
        const fragments = turns
            .map((turn) => {
                const roleLabel = turn.role === "user" ? "用户" : "你";
                const text = normalizeEventText(turn.text, Math.min(180, maxChars));
                return text ? `${roleLabel}:${text}` : undefined;
            })
            .filter((item): item is string => Boolean(item));
        return trimTextFromStart(fragments.join("；"), maxChars) || "";
    }

    private mergeVoiceContextArchive(
        sessionKey: string | undefined,
        turns: VoiceContextTurn[],
        maxChars: number
    ) {
        if (!sessionKey || turns.length === 0 || maxChars <= 0) {
            return;
        }
        const summaryBudget = clamp(Math.round(maxChars * 0.45), 160, 1800);
        const nextChunk = this.compressVoiceContextTurns(turns, summaryBudget);
        if (!nextChunk) {
            return;
        }

        const existing =
            this.voiceContextArchiveSessionKey === sessionKey
                ? this.voiceContextArchiveText
                : "";
        const merged = [existing, nextChunk].filter(Boolean).join("；");
        this.voiceContextArchiveSessionKey = sessionKey;
        this.voiceContextArchiveText = trimTextFromStart(merged, summaryBudget) || "";
    }

    private recordVoiceContextTurn(
        role: VoiceContextTurn["role"],
        text: string,
        sessionKey = this.openclawVoiceSessionKey
    ) {
        void role;
        void text;
        void sessionKey;
    }

    private buildVoiceContextPrompt(sessionKey: string) {
        void sessionKey;
        return "";
    }

    private buildVoiceSessionNotice(options?: { renewVoiceSession?: boolean }) {
        if (!options?.renewVoiceSession) {
            return "";
        }
        return "会话说明：用户要求从全新的会话开始，本轮不要参考更早上下文。";
    }

    private async ensureActionContext() {
        try {
            await this.ensureReady();
        } catch (error) {
            throw this.decorateNotReadyError(error);
        }

        if (!this.device || !this.miioClient || !this.minaClient) {
            throw new Error("小爱云后端尚未准备好。");
        }
        return {
            device: this.device,
            miio: this.miioClient,
            mina: this.minaClient,
        };
    }

    private async playText(text: string) {
        const { device, miio, mina } = await this.ensureActionContext();
        const action = device.speakerFeatures.playText;
        if (action) {
            const result = await miio.miotAction(device.miDid, action.siid, action.aiid, [text]);
            if (result.code === 0) {
                this.rememberSelfTriggeredQuery(text, "speak");
                return true;
            }
            await this.appendDebugTrace("speaker_play_text_failed_code", {
                code: result.code,
                siid: action.siid,
                aiid: action.aiid,
            });
        }
        const messageRouterPost = device.speakerFeatures.messageRouterPost;
        if (messageRouterPost) {
            const result = await miio.miotAction(
                device.miDid,
                messageRouterPost.siid,
                messageRouterPost.aiid,
                [`跟我说 ${text}`]
            );
            if (result.code === 0) {
                this.rememberSelfTriggeredQuery(text, "speak");
                return true;
            }
            await this.appendDebugTrace("speaker_message_router_post_failed_code", {
                code: result.code,
                siid: messageRouterPost.siid,
                aiid: messageRouterPost.aiid,
                mode: "speak",
            });
        }
        const fallback = await mina.textToSpeech(device.minaDeviceId, text);
        if (fallback?.code !== 0) {
            await this.appendDebugTrace("speaker_mina_tts_failed_code", {
                code: fallback?.code,
            });
        }
        if (fallback?.code === 0) {
            this.rememberSelfTriggeredQuery(text, "speak");
            return true;
        }
        return false;
    }

    private normalizeAudioReplyTitle(title?: string) {
        let normalized = normalizeEventText(title, 120);
        while (normalized) {
            const next = normalized.replace(/^\s*音频回复[:：]\s*/u, "").trim();
            if (next === normalized) {
                break;
            }
            normalized = next;
        }
        return normalized || undefined;
    }

    private describeAudioReply(url: string, title?: string) {
        const normalizedTitle = this.normalizeAudioReplyTitle(title);
        if (normalizedTitle) {
            return `音频回复：${normalizedTitle}`;
        }
        try {
            const parsed = new URL(url);
            const filename = decodeURIComponentSafe(
                parsed.pathname.split("/").pop() || ""
            ).trim();
            if (filename) {
                return `音频回复：${filename}`;
            }
            return `音频回复：${parsed.host}`;
        } catch {
            return "音频回复";
        }
    }

    private readSpeakerPlaybackSnapshot(result: any): SpeakerPlaybackSnapshot | null {
        const raw = result?.data?.info;
        let parsed = raw;
        if (typeof raw === "string") {
            try {
                parsed = JSON.parse(raw);
            } catch {
                parsed = undefined;
            }
        }
        if (!parsed || typeof parsed !== "object") {
            return null;
        }

        const trackList = Array.isArray((parsed as any).track_list)
            ? (parsed as any).track_list
                .map((item: any) => readString(item))
                .filter((item: string | undefined): item is string => Boolean(item))
            : [];

        return {
            status: readNumber((parsed as any).status),
            volume: readNumber((parsed as any).volume),
            mediaType: readNumber((parsed as any).media_type),
            loopType: readNumber((parsed as any).loop_type),
            audioId: readString((parsed as any)?.play_song_detail?.audio_id),
            position: readNumber((parsed as any)?.play_song_detail?.position),
            duration: readNumber((parsed as any)?.play_song_detail?.duration),
            trackList,
        };
    }

    private hasSpeakerPlaybackContext(snapshot: SpeakerPlaybackSnapshot | null) {
        if (!snapshot) {
            return false;
        }
        if (snapshot.status === 1 || snapshot.status === 2) {
            return true;
        }
        if (readString(snapshot.audioId)) {
            return true;
        }
        if ((snapshot.trackList || []).length > 0) {
            return true;
        }
        const duration = readNumber(snapshot.duration);
        if (typeof duration === "number" && duration > 0) {
            return true;
        }
        const position = readNumber(snapshot.position);
        return typeof position === "number" && position > 0;
    }

    private isSpeakerPlaybackActivelyPlaying(snapshot: SpeakerPlaybackSnapshot | null) {
        if (!snapshot) {
            return false;
        }
        const position = Math.max(0, readNumber(snapshot.position) || 0);
        return readNumber(snapshot.status) === 1 || position > 0;
    }

    private summarizeSpeakerPlaybackSnapshot(
        snapshot: SpeakerPlaybackSnapshot | null
    ) {
        if (!snapshot) {
            return null;
        }
        return {
            status: readNumber(snapshot.status),
            mediaType: readNumber(snapshot.mediaType),
            loopType: readNumber(snapshot.loopType),
            audioId: readString(snapshot.audioId) || "",
            position: Math.max(0, readNumber(snapshot.position) || 0),
            duration: Math.max(0, readNumber(snapshot.duration) || 0),
            trackList: Array.isArray(snapshot.trackList)
                ? snapshot.trackList.slice(0, 4)
                : [],
            hasContext: this.hasSpeakerPlaybackContext(snapshot),
            active: this.isSpeakerPlaybackActivelyPlaying(snapshot),
        };
    }

    private detectConversationInterceptCalibrationPlaybackReason(
        baseline: SpeakerPlaybackSnapshot | null,
        previous: SpeakerPlaybackSnapshot | null,
        current: SpeakerPlaybackSnapshot | null
    ) {
        if (!current) {
            return undefined;
        }
        const reference = previous || baseline;
        if (this.isSpeakerPlaybackActivelyPlaying(current)) {
            return "active";
        }
        if (this.hasSpeakerPlaybackStarted(reference, current)) {
            return "started";
        }
        if (this.hasSpeakerPlaybackQueued(reference, current)) {
            return "queued";
        }

        const baselineHasContext = this.hasSpeakerPlaybackContext(baseline);
        const previousHasContext = this.hasSpeakerPlaybackContext(previous);
        const currentHasContext = this.hasSpeakerPlaybackContext(current);
        const baselineStatus = readNumber(baseline?.status);
        const previousStatus = readNumber(previous?.status);
        const currentStatus = readNumber(current.status);
        const baselineAudioId = readString(baseline?.audioId) || "";
        const currentAudioId = readString(current.audioId) || "";
        const baselineTrackList = (baseline?.trackList || []).join(",");
        const currentTrackList = (current.trackList || []).join(",");
        const baselinePosition = Math.max(0, readNumber(baseline?.position) || 0);
        const previousPosition = Math.max(0, readNumber(previous?.position) || 0);
        const currentPosition = Math.max(0, readNumber(current.position) || 0);
        const baselineDuration = Math.max(0, readNumber(baseline?.duration) || 0);
        const currentDuration = Math.max(0, readNumber(current.duration) || 0);
        const baselineMediaType = readNumber(baseline?.mediaType);
        const currentMediaType = readNumber(current.mediaType);

        if (currentHasContext && !baselineHasContext) {
            return "context_appeared";
        }
        if (currentAudioId && currentAudioId !== baselineAudioId) {
            return "audio_id_changed";
        }
        if (currentTrackList && currentTrackList !== baselineTrackList) {
            return "track_list_changed";
        }
        if (currentPosition > Math.max(baselinePosition, previousPosition)) {
            return "position_advanced";
        }
        if (
            currentHasContext &&
            currentDuration > 0 &&
            currentDuration !== baselineDuration
        ) {
            return "duration_changed";
        }
        if (
            currentHasContext &&
            typeof currentMediaType === "number" &&
            currentMediaType !== baselineMediaType
        ) {
            return "media_type_changed";
        }
        if (
            currentHasContext &&
            typeof currentStatus === "number" &&
            currentStatus !== baselineStatus &&
            (!previousHasContext || currentStatus !== previousStatus)
        ) {
            return "status_changed_with_context";
        }
        return undefined;
    }

    private isSpeakerPlaybackStopped(snapshot: SpeakerPlaybackSnapshot | null) {
        if (!snapshot) {
            return true;
        }
        if (snapshot.status === 0) {
            return true;
        }
        return !this.hasSpeakerPlaybackContext(snapshot);
    }

    private isSpeakerPlaybackPausedOrStopped(snapshot: SpeakerPlaybackSnapshot | null) {
        if (!snapshot) {
            return true;
        }
        if (snapshot.status === 2) {
            return true;
        }
        return this.isSpeakerPlaybackStopped(snapshot);
    }

    private speakerSnapshotHasAudioId(
        snapshot: SpeakerPlaybackSnapshot | null,
        expectedAudioId?: string
    ) {
        const audioId = readString(expectedAudioId);
        if (!snapshot || !audioId) {
            return false;
        }
        if ((snapshot.audioId || "") === audioId) {
            return true;
        }
        return (snapshot.trackList || []).includes(audioId);
    }

    private hasSpeakerPlaybackQueued(
        before: SpeakerPlaybackSnapshot | null,
        after: SpeakerPlaybackSnapshot | null,
        options?: SpeakerPlaybackVerifyOptions
    ) {
        if (!after) {
            return false;
        }

        const expectedAudioId = readString(options?.expectedAudioId);
        if (expectedAudioId) {
            return (
                this.speakerSnapshotHasAudioId(after, expectedAudioId) &&
                !this.speakerSnapshotHasAudioId(before, expectedAudioId)
            );
        }

        if ((after.audioId || "") !== (before?.audioId || "")) {
            return true;
        }
        if ((after.trackList || []).join(",") !== (before?.trackList || []).join(",")) {
            return true;
        }
        return false;
    }

    private hasSpeakerPlaybackStarted(
        before: SpeakerPlaybackSnapshot | null,
        after: SpeakerPlaybackSnapshot | null,
        options?: SpeakerPlaybackVerifyOptions
    ) {
        if (!after || after.status !== 1) {
            return false;
        }

        const afterPosition = readNumber(after.position);
        const beforePosition = readNumber(before?.position);
        if (typeof afterPosition === "number" && afterPosition > 0) {
            return true;
        }
        if (
            typeof afterPosition === "number" &&
            typeof beforePosition === "number" &&
            afterPosition > beforePosition
        ) {
            return true;
        }

        const expectedAudioId = readString(options?.expectedAudioId);
        if (expectedAudioId && this.speakerSnapshotHasAudioId(after, expectedAudioId)) {
            return true;
        }

        return false;
    }

    private async verifySpeakerPlaybackStarted(
        mina: MiNAClient,
        deviceId: string,
        before: SpeakerPlaybackSnapshot | null,
        options?: SpeakerPlaybackVerifyOptions
    ): Promise<SpeakerPlaybackVerifyResult> {
        let lastSnapshot: SpeakerPlaybackSnapshot | null = before;
        const relayUsageBefore =
            typeof options?.relayHitCount === "number"
                ? options.relayHitCount
                : options?.relayUrl
                    ? (this.readAudioRelayUsageForUrl(options.relayUrl)?.hitCount || 0)
                    : undefined;
        let relayHitObserved = false;
        let relayHitCount = relayUsageBefore;

        const probePlaybackState = async (): Promise<SpeakerPlaybackVerifyResult | null> => {
            const current = await this.readSpeakerPlaybackSnapshotWithTiming(mina, deviceId);
            if (options?.relayUrl) {
                const usage = this.readAudioRelayUsageForUrl(options.relayUrl);
                if (usage) {
                    relayHitCount = usage.hitCount;
                    if (
                        typeof relayUsageBefore === "number" &&
                        usage.hitCount > relayUsageBefore
                    ) {
                        relayHitObserved = true;
                    }
                }
            }
            if (this.hasSpeakerPlaybackQueued(lastSnapshot, current, options)) {
                return {
                    started: true,
                    snapshot: current,
                    relayHitObserved,
                    relayHitCount,
                };
            }
            if (this.hasSpeakerPlaybackStarted(lastSnapshot, current, options)) {
                return {
                    started: true,
                    snapshot: current,
                    relayHitObserved,
                    relayHitCount,
                };
            }
            if (options?.allowRelayHitStart && options?.relayUrl && relayHitObserved) {
                return {
                    started: true,
                    snapshot: current || lastSnapshot,
                    relayHitObserved,
                    relayHitCount,
                    startedByRelayHit: true,
                };
            }
            lastSnapshot = current;
            return null;
        };

        const immediateResult = await probePlaybackState();
        if (immediateResult) {
            return immediateResult;
        }

        for (const delayMs of AUDIO_PLAYBACK_VERIFY_DELAYS_MS) {
            if (delayMs > 0) {
                await sleep(delayMs);
            }
            const delayedResult = await probePlaybackState();
            if (delayedResult) {
                return delayedResult;
            }
        }
        return {
            started: Boolean(
                options?.relayUrl &&
                    relayHitObserved &&
                    (options?.allowRelayHitStart || !options?.expectedAudioId)
            ),
            snapshot: lastSnapshot,
            relayHitObserved,
            relayHitCount,
            startedByRelayHit: Boolean(
                options?.relayUrl &&
                    relayHitObserved &&
                    (options?.allowRelayHitStart || !options?.expectedAudioId)
            ),
        };
    }

    private async verifySpeakerCommandState(
        mina: MiNAClient,
        deviceId: string,
        predicate: (snapshot: SpeakerPlaybackSnapshot | null) => boolean,
        delaysMs = SPEAKER_COMMAND_VERIFY_DELAYS_MS
    ) {
        let lastSnapshot: SpeakerPlaybackSnapshot | null = null;
        for (const delayMs of delaysMs) {
            if (delayMs > 0) {
                await sleep(delayMs);
            }
            lastSnapshot = await this.readSpeakerPlaybackSnapshotWithTiming(mina, deviceId);
            if (predicate(lastSnapshot)) {
                return {
                    ok: true,
                    snapshot: lastSnapshot,
                };
            }
        }
        return {
            ok: false,
            snapshot: lastSnapshot,
        };
    }

    private async finalizeSpeakerStopSuccess(
        mina: MiNAClient,
        deviceId: string,
        options?: { preserveLoopGuard?: boolean }
    ) {
        const guard = options?.preserveLoopGuard
            ? this.readExternalAudioLoopGuard(deviceId)
            : this.takeExternalAudioLoopGuard(deviceId);
        if (
            guard &&
            !options?.preserveLoopGuard &&
            typeof guard.restoreLoopType === "number" &&
            guard.restoreLoopType !== EXTERNAL_AUDIO_NON_LOOP_TYPE
        ) {
            await this.setSpeakerLoopType(
                mina,
                deviceId,
                guard.restoreLoopType,
                "manual-stop",
                {
                    expectedAudioId: guard.expectedAudioId,
                    title: guard.title,
                }
            ).catch(() => undefined);
        }
    }

    private readExternalAudioLoopGuard(deviceId: string, token?: string) {
        const guard = this.externalAudioLoopGuards.get(deviceId);
        if (!guard) {
            return undefined;
        }
        if (token && guard.token !== token) {
            return undefined;
        }
        return guard;
    }

    private rememberExternalAudioLoopGuardSnapshot(
        deviceId: string,
        token: string,
        snapshot?: SpeakerPlaybackSnapshot | null
    ) {
        const guard = this.readExternalAudioLoopGuard(deviceId, token);
        if (!guard) {
            return;
        }
        guard.lastSnapshot = snapshot || null;
        guard.lastSnapshotAtMs = Date.now();
        this.externalAudioLoopGuards.set(deviceId, guard);
    }

    private clearExternalAudioLoopGuardDeadlineTimer(guard?: ExternalAudioLoopGuard) {
        if (!guard?.deadlineTimer) {
            return;
        }
        clearTimeout(guard.deadlineTimer);
        guard.deadlineTimer = undefined;
    }

    private clearAllExternalAudioLoopGuards() {
        for (const guard of this.externalAudioLoopGuards.values()) {
            this.clearExternalAudioLoopGuardDeadlineTimer(guard);
        }
        this.externalAudioLoopGuards.clear();
    }

    private takeExternalAudioLoopGuard(deviceId: string) {
        const guard = this.externalAudioLoopGuards.get(deviceId);
        if (!guard) {
            return undefined;
        }
        this.clearExternalAudioLoopGuardDeadlineTimer(guard);
        this.externalAudioLoopGuards.delete(deviceId);
        return guard;
    }

    private beginExternalAudioLoopGuardDeadlineHandling(deviceId: string, token: string) {
        const guard = this.readExternalAudioLoopGuard(deviceId, token);
        if (!guard || guard.deadlineHandling) {
            return undefined;
        }
        this.clearExternalAudioLoopGuardDeadlineTimer(guard);
        guard.deadlineHandling = true;
        this.externalAudioLoopGuards.set(deviceId, guard);
        return guard;
    }

    private async setSpeakerLoopType(
        mina: MiNAClient,
        deviceId: string,
        loopType: number,
        reason: string,
        details?: Record<string, any>
    ) {
        let response: any;
        let ok = false;
        let errorMessage: string | undefined;
        try {
            response = await mina.playerSetLoop(deviceId, loopType);
            const outerCode = readNumber(response?.code);
            const innerCode = readNumber(response?.data?.code);
            ok =
                (typeof outerCode !== "number" || outerCode === 0) &&
                (typeof innerCode !== "number" || innerCode === 0);
        } catch (error) {
            errorMessage = this.errorMessage(error);
        }

        await this.appendDebugTrace(
            ok ? "audio_loop_type_set" : "audio_loop_type_set_failed",
            {
                deviceId,
                loopType,
                reason,
                responseCode: readNumber(response?.code),
                responseInnerCode: readNumber(response?.data?.code),
                errorMessage,
                ...(details || {}),
            }
        );
        return ok;
    }

    private async finishExternalAudioLoopGuard(
        mina: MiNAClient,
        deviceId: string,
        token: string,
        reason: string,
        snapshot?: SpeakerPlaybackSnapshot | null,
        details?: Record<string, any>
    ) {
        const guard = this.readExternalAudioLoopGuard(deviceId, token);
        if (!guard) {
            return;
        }
        this.clearExternalAudioLoopGuardDeadlineTimer(guard);
        this.externalAudioLoopGuards.delete(deviceId);

        const currentLoopType = readNumber(snapshot?.loopType);
        const restoreLoopType = readNumber(guard.restoreLoopType);
        const shouldRestoreLoopType =
            typeof restoreLoopType === "number" &&
            restoreLoopType !== EXTERNAL_AUDIO_NON_LOOP_TYPE &&
            (typeof currentLoopType !== "number" ||
                currentLoopType === EXTERNAL_AUDIO_NON_LOOP_TYPE);
        const restorePromise = shouldRestoreLoopType
            ? this.setSpeakerLoopType(
                mina,
                deviceId,
                restoreLoopType,
                `restore:${reason}`,
                {
                    expectedAudioId: guard.expectedAudioId,
                    startedWithUrl: guard.startedWithUrl,
                }
            ).catch(() => undefined)
            : undefined;

        await this.appendDebugTrace("audio_loop_guard_finished", {
            deviceId,
            token,
            reason,
            expectedAudioId: guard.expectedAudioId,
            restoreLoopType: guard.restoreLoopType,
            currentLoopType,
            startedWithUrl: guard.startedWithUrl,
            title: guard.title,
            ...(details || {}),
        });

        if (restorePromise) {
            void restorePromise;
        }
    }

    private scheduleExternalAudioLoopGuardDeadline(
        mina: MiNAClient,
        device: DeviceContext,
        token: string,
        reason: string
    ) {
        const guard = this.readExternalAudioLoopGuard(device.minaDeviceId, token);
        const deadlineAtMs = readNumber(guard?.deadlineAtMs);
        if (!guard || typeof deadlineAtMs !== "number") {
            return;
        }

        this.clearExternalAudioLoopGuardDeadlineTimer(guard);
        const delayMs = Math.max(0, deadlineAtMs - Date.now());
        guard.deadlineTimer = setTimeout(() => {
            void this.runExternalAudioLoopGuardDeadline(mina, device, token, reason);
        }, delayMs);
        guard.deadlineTimer.unref?.();
        this.externalAudioLoopGuards.set(device.minaDeviceId, guard);

        void this.appendDebugTrace("audio_loop_guard_deadline_timer_set", {
            deviceId: device.minaDeviceId,
            token,
            expectedAudioId: guard.expectedAudioId,
            reason,
            deadlineAtMs,
            delayMs,
        });
    }

    private armExternalAudioLoopGuard(
        mina: MiNAClient,
        device: DeviceContext,
        options: {
            expectedAudioId?: string;
            restoreLoopType?: number;
            startedWithUrl: string;
            title?: string;
            deadlineAtMs?: number;
        }
    ) {
        const token = randomBytes(8).toString("hex");
        const guard: ExternalAudioLoopGuard = {
            token,
            deviceId: device.minaDeviceId,
            expectedAudioId: readString(options.expectedAudioId),
            restoreLoopType: readNumber(options.restoreLoopType),
            startedWithUrl: options.startedWithUrl,
            title: readString(options.title),
            armedAtMs: Date.now(),
            deadlineAtMs: readNumber(options.deadlineAtMs),
        };
        this.externalAudioLoopGuards.set(device.minaDeviceId, guard);
        void this.appendDebugTrace("audio_loop_guard_armed", {
            deviceId: device.minaDeviceId,
            token,
            expectedAudioId: guard.expectedAudioId,
            restoreLoopType: guard.restoreLoopType,
            startedWithUrl: guard.startedWithUrl,
            title: guard.title,
            deadlineAtMs: guard.deadlineAtMs,
        });
        this.scheduleExternalAudioLoopGuardDeadline(mina, device, token, "armed");
        void this.runExternalAudioLoopGuard(mina, device, token).catch((error) => {
            if (!this.readExternalAudioLoopGuard(device.minaDeviceId, token)) {
                return;
            }
            void this.appendDebugTrace("audio_loop_guard_error", {
                deviceId: device.minaDeviceId,
                token,
                errorMessage: this.errorMessage(error),
            });
        });
    }

    private async runExternalAudioLoopGuardDeadline(
        mina: MiNAClient,
        device: DeviceContext,
        token: string,
        source: string
    ) {
        const deviceId = device.minaDeviceId;
        const guard = this.beginExternalAudioLoopGuardDeadlineHandling(deviceId, token);
        if (!guard) {
            return;
        }

        try {
            const deadlineAtMs = readNumber(guard.deadlineAtMs);
            const cachedSnapshotAgeMs =
                typeof guard.lastSnapshotAtMs === "number"
                    ? Date.now() - guard.lastSnapshotAtMs
                    : undefined;
            const useCachedSnapshot =
                typeof cachedSnapshotAgeMs === "number" &&
                cachedSnapshotAgeMs <= EXTERNAL_AUDIO_LOOP_GUARD_SNAPSHOT_FRESH_MS;
            let statusProbeMs: number | undefined;
            let statusProbeTimedOut = false;
            const snapshot = useCachedSnapshot
                ? guard.lastSnapshot || null
                : await (async () => {
                    const statusProbeStartedAtMs = Date.now();
                    const statusResponsePromise = mina
                        .playerGetStatus(deviceId)
                        .catch(() => undefined);
                    const timeoutMarker = Symbol("deadline-status-timeout");
                    const statusResponse = await Promise.race<
                        any | typeof timeoutMarker
                    >([
                        statusResponsePromise,
                        sleep(EXTERNAL_AUDIO_LOOP_GUARD_DEADLINE_STATUS_TIMEOUT_MS).then(
                            () => timeoutMarker
                        ),
                    ]);
                    if (statusResponse === timeoutMarker) {
                        statusProbeTimedOut = true;
                        return null;
                    }
                    statusProbeMs = Date.now() - statusProbeStartedAtMs;
                    this.updateSpeakerAudioLatencyEstimate(
                        deviceId,
                        "statusProbeEstimateMs",
                        statusProbeMs
                    );
                    return this.readSpeakerPlaybackSnapshot(statusResponse);
                })();
            if (!this.readExternalAudioLoopGuard(deviceId, token)) {
                return;
            }

            if (
                guard.expectedAudioId &&
                snapshot &&
                !this.speakerSnapshotHasAudioId(snapshot, guard.expectedAudioId)
            ) {
                await this.finishExternalAudioLoopGuard(
                    mina,
                    deviceId,
                    token,
                    `${source}-replaced`,
                    snapshot,
                    {
                        deadlineAtMs,
                        observedAudioId: snapshot.audioId,
                    }
                );
                return;
            }

            const boundaryPosition = readNumber(snapshot?.position);
            const boundaryDuration = readNumber(snapshot?.duration);
            const pausedAtCompletionBoundary =
                snapshot?.status === 2 &&
                typeof boundaryPosition === "number" &&
                boundaryPosition <= EXTERNAL_AUDIO_LOOP_GUARD_RESTART_POSITION_MS;
            if (pausedAtCompletionBoundary) {
                const silencedCompletion =
                    await this.forceStopExternalAudioCompletionBoundary(
                        mina,
                        deviceId,
                        guard.expectedAudioId,
                        snapshot
                    );
                await this.finishExternalAudioLoopGuard(
                    mina,
                    deviceId,
                    token,
                    `${source}-completed-stop`,
                    silencedCompletion.snapshot || snapshot,
                    {
                        deadlineAtMs,
                        finalPosition: boundaryPosition,
                        duration: boundaryDuration,
                        silenced: silencedCompletion.silenced,
                        fallbackPauseAccepted:
                            silencedCompletion.fallbackPauseAccepted,
                        verifyOk: silencedCompletion.verifyOk,
                    }
                );
                return;
            }

            if (snapshot && this.isSpeakerPlaybackPausedOrStopped(snapshot)) {
                await this.finishExternalAudioLoopGuard(
                    mina,
                    deviceId,
                    token,
                    `${source}-completed`,
                    snapshot,
                    {
                        deadlineAtMs,
                    }
                );
                return;
            }

            const silenced = await this.stopSpeaker({
                preserveLoopGuard: true,
                fast: true,
                expectedAudioId: guard.expectedAudioId,
            }).catch(() => false);
            if (silenced) {
                await this.clearConsoleAudioPlaybackState().catch(() => undefined);
            }
            if (!this.readExternalAudioLoopGuard(deviceId, token)) {
                return;
            }

            await this.finishExternalAudioLoopGuard(
                mina,
                deviceId,
                token,
                silenced ? `${source}-stop` : `${source}-expired`,
                snapshot,
                {
                    deadlineAtMs,
                    silenced,
                    usedCachedSnapshot: useCachedSnapshot,
                    cachedSnapshotAgeMs,
                    statusProbeMs,
                    statusProbeTimedOut,
                }
            );
        } catch (error) {
            const current = this.readExternalAudioLoopGuard(deviceId, token);
            if (current) {
                current.deadlineHandling = false;
                this.externalAudioLoopGuards.set(deviceId, current);
            }
            await this.appendDebugTrace("audio_loop_guard_deadline_error", {
                deviceId,
                token,
                source,
                errorMessage: this.errorMessage(error),
            });
        }
    }

    private async forceStopExternalAudioCompletionBoundary(
        mina: MiNAClient,
        deviceId: string,
        expectedAudioId?: string,
        snapshot?: SpeakerPlaybackSnapshot | null
    ) {
        const silenced = await this.stopSpeaker({
            preserveLoopGuard: true,
            fast: true,
            expectedAudioId,
        }).catch(() => false);

        let fallbackPauseAccepted = false;
        if (!silenced) {
            try {
                const result = await mina.playerPause(deviceId);
                const parsedCode = Number((result as any)?.code);
                fallbackPauseAccepted = !Number.isFinite(parsedCode) || parsedCode === 0;
            } catch {
                fallbackPauseAccepted = false;
            }
        }

        const verifyResult = await this.verifySpeakerCommandState(
            mina,
            deviceId,
            (current) =>
                this.isSpeakerPlaybackPausedOrStopped(current) ||
                Boolean(
                    expectedAudioId &&
                        current &&
                        !this.speakerSnapshotHasAudioId(current, expectedAudioId)
                ),
            SPEAKER_COMMAND_FAST_VERIFY_DELAYS_MS
        ).catch(() => ({
            ok: false,
            snapshot: snapshot || null,
        }));

        if (silenced || fallbackPauseAccepted || verifyResult.ok) {
            await this.clearConsoleAudioPlaybackState().catch(() => undefined);
        }

        await this.appendDebugTrace("audio_loop_guard_completion_pause", {
            deviceId,
            expectedAudioId,
            silenced,
            fallbackPauseAccepted,
            verifyOk: verifyResult.ok,
            snapshot: verifyResult.snapshot || snapshot || null,
        });

        return {
            silenced,
            fallbackPauseAccepted,
            verifyOk: verifyResult.ok,
            snapshot: verifyResult.snapshot || snapshot || null,
        };
    }

    private async runExternalAudioLoopGuard(
        mina: MiNAClient,
        device: DeviceContext,
        token: string
    ) {
        const deviceId = device.minaDeviceId;
        let previousSnapshot: SpeakerPlaybackSnapshot | null = null;
        let nearEndObserved = false;
        let seenPlaying = false;

        while (this.readExternalAudioLoopGuard(deviceId, token)) {
            const guard = this.readExternalAudioLoopGuard(deviceId, token);
            if (!guard) {
                return;
            }
            if (guard.deadlineHandling) {
                await sleep(40);
                continue;
            }

            let deadlineAtMs = readNumber(guard.deadlineAtMs);
            const stablePlaybackObserved =
                seenPlaying ||
                this.isSpeakerPlaybackActivelyPlaying(previousSnapshot) ||
                this.isSpeakerPlaybackActivelyPlaying(guard.lastSnapshot || null);
            if (
                typeof deadlineAtMs !== "number" &&
                guard.startedWithUrl &&
                stablePlaybackObserved
            ) {
                const hostedRelayEntry = await this.ensureHostedAudioRelayEntry(
                    guard.startedWithUrl
                );
                const relayUsage = this.readAudioRelayUsageForUrl(guard.startedWithUrl);
                const relayHitDeadlineAtMs =
                    this.computeRelayHitAnchoredExternalAudioDeadlineAtMs(
                        deviceId,
                        hostedRelayEntry,
                        readNumber(relayUsage?.lastHitAtMs)
                    );
                if (typeof relayHitDeadlineAtMs === "number") {
                    guard.deadlineAtMs = relayHitDeadlineAtMs;
                    this.externalAudioLoopGuards.set(deviceId, guard);
                    deadlineAtMs = relayHitDeadlineAtMs;
                    await this.appendDebugTrace("audio_loop_guard_deadline_set", {
                        deviceId,
                        token,
                        expectedAudioId: guard.expectedAudioId,
                        hostedRelayDurationMs: readNumber(hostedRelayEntry?.durationMs),
                        tailPaddingMs: readNumber(hostedRelayEntry?.tailPaddingMs),
                        relayHitAtMs: readNumber(relayUsage?.lastHitAtMs),
                        deadlineAtMs: relayHitDeadlineAtMs,
                        source: "relay-hit-after-stable-playback",
                    });
                    this.scheduleExternalAudioLoopGuardDeadline(
                        mina,
                        device,
                        token,
                        "relay-hit-after-stable-playback"
                    );
                }
            }
            const nowMs = Date.now();
            const previousDuration = readNumber(previousSnapshot?.duration);
            const previousPosition = readNumber(previousSnapshot?.position);
            const nearEndPolling =
                nearEndObserved ||
                (typeof previousDuration === "number" &&
                    previousDuration > 0 &&
                    typeof previousPosition === "number" &&
                    previousPosition >=
                        Math.max(
                            0,
                            previousDuration - EXTERNAL_AUDIO_LOOP_GUARD_NEAR_END_MS
                        ));
            const nextPollMs = nearEndPolling
                ? EXTERNAL_AUDIO_LOOP_GUARD_NEAR_END_POLL_MS
                : EXTERNAL_AUDIO_LOOP_GUARD_POLL_MS;
            const sleepMs =
                typeof deadlineAtMs === "number"
                    ? clamp(
                        Math.min(nextPollMs, Math.max(0, deadlineAtMs - nowMs)),
                        0,
                        nextPollMs
                    )
                    : nextPollMs;
            if (sleepMs > 0) {
                await sleep(sleepMs);
            }

            if (
                typeof deadlineAtMs === "number" &&
                (seenPlaying || guard.startedWithUrl) &&
                !guard.deadlineHandling &&
                !guard.deadlineTimer &&
                Date.now() >= deadlineAtMs
            ) {
                await this.runExternalAudioLoopGuardDeadline(
                    mina,
                    device,
                    token,
                    "deadline-poll"
                );
                return;
            }

            const snapshot = await this.readSpeakerPlaybackSnapshotWithTiming(mina, deviceId);
            if (!snapshot) {
                continue;
            }
            this.rememberExternalAudioLoopGuardSnapshot(deviceId, token, snapshot);

            if (guard.expectedAudioId && !this.speakerSnapshotHasAudioId(snapshot, guard.expectedAudioId)) {
                await this.finishExternalAudioLoopGuard(
                    mina,
                    deviceId,
                    token,
                    "replaced",
                    snapshot,
                    {
                        observedAudioId: snapshot.audioId,
                    }
                );
                return;
            }

            if (this.isSpeakerPlaybackActivelyPlaying(snapshot)) {
                seenPlaying = true;
            }

            const duration = readNumber(snapshot.duration);
            const position = readNumber(snapshot.position);
            const restartWindowDuration =
                readNumber(previousSnapshot?.duration) ?? duration;
            const restartWindowPosition = readNumber(previousSnapshot?.position);

            if (
                typeof deadlineAtMs !== "number" &&
                seenPlaying &&
                typeof duration === "number" &&
                duration > 0
            ) {
                const hostedRelayEntry = guard.startedWithUrl
                    ? await this.ensureHostedAudioRelayEntry(guard.startedWithUrl)
                    : undefined;
                const hostedRelayDurationMs = readNumber(hostedRelayEntry?.durationMs);
                const { deadlineLeadMs, tailPaddingMs } =
                    this.computeExternalAudioLoopGuardLeadMs(deviceId, hostedRelayEntry);
                const dynamicDeadlineAtMs =
                    typeof hostedRelayDurationMs === "number" &&
                    hostedRelayDurationMs > 0
                        ? Date.now() +
                            Math.max(
                                0,
                                hostedRelayDurationMs -
                                    Math.max(0, position || 0) -
                                    deadlineLeadMs
                            )
                        : Date.now() +
                            Math.max(
                                0,
                                duration - Math.max(0, position || 0)
                            ) +
                            EXTERNAL_AUDIO_LOOP_GUARD_DEADLINE_GRACE_MS;
                guard.deadlineAtMs = dynamicDeadlineAtMs;
                this.externalAudioLoopGuards.set(deviceId, guard);
                await this.appendDebugTrace("audio_loop_guard_deadline_set", {
                    deviceId,
                    token,
                    expectedAudioId: guard.expectedAudioId,
                    hostedRelayDurationMs,
                    deadlineLeadMs,
                    tailPaddingMs,
                    duration,
                    position,
                    deadlineAtMs: dynamicDeadlineAtMs,
                });
                this.scheduleExternalAudioLoopGuardDeadline(
                    mina,
                    device,
                    token,
                    "dynamic-deadline"
                );
            }

            if (
                typeof duration === "number" &&
                typeof position === "number" &&
                duration > 0 &&
                position >= Math.max(0, duration - EXTERNAL_AUDIO_LOOP_GUARD_NEAR_END_MS)
            ) {
                nearEndObserved = true;
            }

            const restarted =
                typeof duration === "number" &&
                duration > 0 &&
                typeof position === "number" &&
                position <= EXTERNAL_AUDIO_LOOP_GUARD_RESTART_POSITION_MS &&
                typeof restartWindowPosition === "number" &&
                typeof restartWindowDuration === "number" &&
                restartWindowDuration > 0 &&
                restartWindowPosition >=
                    Math.max(
                        0,
                        restartWindowDuration - EXTERNAL_AUDIO_LOOP_GUARD_NEAR_END_MS
                    );

            if (restarted) {
                const silenced = await this.stopSpeaker({
                    preserveLoopGuard: true,
                    fast: true,
                    expectedAudioId: guard.expectedAudioId,
                }).catch(() => false);
                if (silenced) {
                    await this.clearConsoleAudioPlaybackState().catch(() => undefined);
                } else {
                    await mina.playerPause(deviceId).catch(() => undefined);
                }
                const pausedSnapshot = await this.readSpeakerPlaybackSnapshotWithTiming(
                    mina,
                    deviceId
                );
                await this.finishExternalAudioLoopGuard(
                    mina,
                    deviceId,
                    token,
                    "loop-restarted",
                    pausedSnapshot || snapshot,
                    {
                        silenced,
                        previousPosition: restartWindowPosition,
                        currentPosition: position,
                        duration,
                    }
                );
                return;
            }

            if (
                seenPlaying &&
                ((snapshot.status === 0) ||
                    (snapshot.status === 2 &&
                        nearEndObserved &&
                        typeof position === "number" &&
                        position <= EXTERNAL_AUDIO_LOOP_GUARD_RESTART_POSITION_MS))
            ) {
                if (
                    snapshot.status === 2 &&
                    nearEndObserved &&
                    typeof position === "number" &&
                    position <= EXTERNAL_AUDIO_LOOP_GUARD_RESTART_POSITION_MS
                ) {
                    const silencedCompletion =
                        await this.forceStopExternalAudioCompletionBoundary(
                            mina,
                            deviceId,
                            guard.expectedAudioId,
                            snapshot
                        );
                    await this.finishExternalAudioLoopGuard(
                        mina,
                        deviceId,
                        token,
                        "completed-stop",
                        silencedCompletion.snapshot || snapshot,
                        {
                            nearEndObserved,
                            finalPosition: position,
                            duration,
                            silenced: silencedCompletion.silenced,
                            fallbackPauseAccepted:
                                silencedCompletion.fallbackPauseAccepted,
                            verifyOk: silencedCompletion.verifyOk,
                        }
                    );
                    return;
                }
                await this.finishExternalAudioLoopGuard(
                    mina,
                    deviceId,
                    token,
                    "completed",
                    snapshot,
                    {
                        nearEndObserved,
                        finalPosition: position,
                        duration,
                    }
                );
                return;
            }

            previousSnapshot = snapshot;
        }
    }

    private buildAudioPlaybackCapabilityKey(device: DeviceContext, url: string) {
        let scheme = "unknown";
        try {
            scheme = new URL(url).protocol.replace(/:$/, "") || "unknown";
        } catch {
            // Ignore parse failures and fall back to unknown scheme.
        }
        const extension = readAudioSourceExtension(url) || ".unknown";
        return `${device.minaDeviceId}:${scheme}:${mediaUrlHostKey(url)}:${extension}`;
    }

    private readAudioPlaybackCapability(
        device: DeviceContext,
        url: string
    ): AudioPlaybackCapabilityEntry | undefined {
        const key = this.buildAudioPlaybackCapabilityKey(device, url);
        const entry = this.audioPlaybackCapability.get(key);
        if (!entry) {
            return undefined;
        }
        if (
            typeof entry.skipSpeakerUntilMs === "number" &&
            entry.skipSpeakerUntilMs <= Date.now() &&
            !entry.preferredStrategy
        ) {
            this.audioPlaybackCapability.delete(key);
            return undefined;
        }
        return entry;
    }

    private rememberAudioPlaybackSuccess(
        device: DeviceContext,
        url: string,
        strategy: AudioPlaybackStrategy
    ) {
        const nowMs = Date.now();
        this.audioPlaybackCapability.set(this.buildAudioPlaybackCapabilityKey(device, url), {
            preferredStrategy: strategy,
            lastSuccessAtMs: nowMs,
        });
    }

    private rememberAudioPlaybackFailure(device: DeviceContext, url: string) {
        const nowMs = Date.now();
        const previous = this.readAudioPlaybackCapability(device, url);
        this.audioPlaybackCapability.set(this.buildAudioPlaybackCapabilityKey(device, url), {
            preferredStrategy: previous?.preferredStrategy,
            lastSuccessAtMs: previous?.lastSuccessAtMs,
            lastFailureAtMs: nowMs,
            skipSpeakerUntilMs: nowMs + AUDIO_PLAYBACK_SKIP_TTL_MS,
        });
    }

    private orderAudioPlaybackStrategies(
        preferredStrategy: AudioPlaybackStrategy | undefined,
        options?: {
            preferRelay?: boolean;
            preferMusic?: boolean;
            preferMp3Relay?: boolean;
            allowMp3Relay?: boolean;
        }
    ) {
        const originalStrategies: AudioPlaybackStrategy[] = options?.preferMusic
            ? ["original-music", "original-direct"]
            : ["original-direct", "original-music"];
        const relayStrategies: AudioPlaybackStrategy[] = options?.preferMusic
            ? ["relay-music", "relay-direct"]
            : ["relay-direct", "relay-music"];
        const relayWithTranscode: AudioPlaybackStrategy[] = options?.allowMp3Relay
            ? options?.preferMp3Relay
                ? options?.preferMusic
                    ? ["relay-music-mp3", "relay-direct-mp3", ...relayStrategies]
                    : ["relay-direct-mp3", "relay-music-mp3", ...relayStrategies]
                : options?.preferMusic
                    ? [...relayStrategies, "relay-music-mp3", "relay-direct-mp3"]
                    : [...relayStrategies, "relay-direct-mp3", "relay-music-mp3"]
            : relayStrategies;
        const strategies: AudioPlaybackStrategy[] =
            options?.preferRelay || options?.preferMp3Relay
            ? [...relayWithTranscode, ...originalStrategies]
            : [...originalStrategies, ...relayWithTranscode];
        const filteredStrategies = options?.allowMp3Relay
            ? strategies
            : strategies.filter(
                (item) =>
                    item !== "relay-music-mp3" &&
                    item !== "relay-direct-mp3"
            );
        if (!preferredStrategy) {
            return filteredStrategies;
        }
        if (
            (preferredStrategy === "relay-music-mp3" ||
                preferredStrategy === "relay-direct-mp3") &&
            !options?.allowMp3Relay
        ) {
            return filteredStrategies;
        }
        return [
            preferredStrategy,
            ...filteredStrategies.filter((item) => item !== preferredStrategy),
        ];
    }

    private normalizeAudioRelayExtension(url: string) {
        return readAudioSourceExtension(url) || ".mp3";
    }

    private pruneAudioRelayEntries(nowMs = Date.now()) {
        for (const [id, entry] of this.audioRelayEntries.entries()) {
            if (entry.expiresAtMs <= nowMs) {
                if (entry.filePath) {
                    unlink(entry.filePath).catch(() => undefined);
                }
                this.audioRelayEntries.delete(id);
            }
        }
        const overflow = this.audioRelayEntries.size - MAX_AUDIO_RELAY_ENTRIES;
        if (overflow <= 0) {
            return;
        }
        const sorted = Array.from(this.audioRelayEntries.values())
            .sort((a, b) => a.createdAtMs - b.createdAtMs)
            .slice(0, overflow);
        for (const entry of sorted) {
            if (entry.filePath) {
                unlink(entry.filePath).catch(() => undefined);
            }
            this.audioRelayEntries.delete(entry.id);
        }
    }

    private async getAudioRelayStorageDir() {
        const storageDir =
            this.config?.storageDir ||
            (await this.loadConfig(false).catch(() => undefined))?.storageDir ||
            resolvePluginStorageDir({
                api: this.api,
                serviceStateDir: this.serviceStateDir,
            });
        const relayDir = path.join(storageDir, "audio-relay");
        await mkdir(relayDir, { recursive: true });
        return relayDir;
    }

    private async persistBufferedAudioRelay(
        relayId: string,
        extension: string,
        buffer: Buffer
    ) {
        const relayDir = await this.getAudioRelayStorageDir();
        const filePath = path.join(relayDir, `${relayId}${extension}`);
        await writeFile(filePath, buffer);
        return filePath;
    }

    private async restorePersistedAudioRelayEntry(relayId: string) {
        const relayDir = await this.getAudioRelayStorageDir().catch(() => undefined);
        if (!relayDir) {
            return undefined;
        }
        const names = await readdir(relayDir).catch(() => []);
        const fileName = names.find(
            (name) => path.basename(name, path.extname(name)) === relayId
        );
        if (!fileName) {
            return undefined;
        }

        const filePath = path.join(relayDir, fileName);
        const stats = await stat(filePath).catch(() => undefined);
        if (!stats?.isFile()) {
            return undefined;
        }

        const expiresAtMs = stats.mtimeMs + AUDIO_RELAY_TTL_MS;
        if (expiresAtMs <= Date.now()) {
            unlink(filePath).catch(() => undefined);
            return undefined;
        }

        return {
            id: relayId,
            extension: path.extname(fileName).toLowerCase() || ".mp3",
            filePath,
            createdAtMs: stats.mtimeMs,
            expiresAtMs,
            hitCount: 0,
            durationMs: await this.probeLocalAudioDurationMs(filePath),
            tailPaddingMs: this.getAudioRelayTailPaddingMs(),
        } satisfies AudioRelayEntry;
    }

    private async buildAudioRelayCandidateUrls(
        sourceUrl: string,
        options?: { transcodeToMp3?: boolean }
    ) {
        const relayId = randomBytes(12).toString("hex");
        const localSourceUrl = await this.resolveLocalAudioSourceUrl(sourceUrl);
        const extension = options?.transcodeToMp3
            ? ".mp3"
            : this.normalizeAudioRelayExtension(sourceUrl);
        const nowMs = Date.now();
        this.audioRelayEntries.set(relayId, {
            id: relayId,
            sourceUrl,
            localSourceUrl:
                localSourceUrl && localSourceUrl !== sourceUrl
                    ? localSourceUrl
                    : undefined,
            extension,
            transcodeToMp3: options?.transcodeToMp3 === true,
            createdAtMs: nowMs,
            expiresAtMs: nowMs + AUDIO_RELAY_TTL_MS,
            hitCount: 0,
        });
        this.pruneAudioRelayEntries(nowMs);

        const candidates: string[] = [];
        for (const baseUrl of await this.computeAudioRelayBaseUrls()) {
            const normalizedBase = normalizeBaseUrl(baseUrl);
            if (!normalizedBase) {
                continue;
            }
            try {
                const parsed = new URL(normalizedBase);
                if (
                    !this.config?.publicBaseUrl &&
                    parsed.protocol === "https:" &&
                    looksLikeIpHostname(parsed.hostname)
                ) {
                    parsed.protocol = "http:";
                    candidates.push(
                        `${parsed.toString().replace(/\/+$/, "")}/audio-relay/${relayId}${extension}`
                    );
                }
                candidates.push(
                    `${normalizedBase.replace(/\/+$/, "")}/audio-relay/${relayId}${extension}`
                );
            } catch {
                continue;
            }
        }
        return uniqueStrings(candidates);
    }

    private async buildBufferedAudioRelayCandidateUrls(
        buffer: Buffer,
        options?: {
            extension?: string;
            contentType?: string;
            sourceLabel?: string;
            tailPaddingMs?: number;
        }
    ) {
        if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
            throw new Error("音频标准化失败：没有生成可播放的音频数据。");
        }
        if (buffer.length > AUDIO_RELAY_MAX_BYTES) {
            throw new Error("音频标准化失败：生成后的音频体积过大。");
        }

        const relayId = randomBytes(12).toString("hex");
        const extension = readString(options?.extension) || ".mp3";
        const nowMs = Date.now();
        const filePath = await this.persistBufferedAudioRelay(relayId, extension, buffer);
        const durationMs = await this.probeLocalAudioDurationMs(filePath);
        this.audioRelayEntries.set(relayId, {
            id: relayId,
            extension,
            buffer,
            filePath,
            contentType: readString(options?.contentType) || contentTypeForAudioExtension(extension),
            sourceLabel: readString(options?.sourceLabel),
            createdAtMs: nowMs,
            expiresAtMs: nowMs + AUDIO_RELAY_TTL_MS,
            hitCount: 0,
            durationMs,
            tailPaddingMs: readNumber(options?.tailPaddingMs),
        });
        this.pruneAudioRelayEntries(nowMs);

        const candidates: string[] = [];
        for (const baseUrl of await this.computeAudioRelayBaseUrls()) {
            const normalizedBase = normalizeBaseUrl(baseUrl);
            if (!normalizedBase) {
                continue;
            }
            try {
                const parsed = new URL(normalizedBase);
                if (
                    !this.config?.publicBaseUrl &&
                    parsed.protocol === "https:" &&
                    looksLikeIpHostname(parsed.hostname)
                ) {
                    parsed.protocol = "http:";
                    candidates.push(
                        `${parsed.toString().replace(/\/+$/, "")}/audio-relay/${relayId}${extension}`
                    );
                }
                candidates.push(
                    `${normalizedBase.replace(/\/+$/, "")}/audio-relay/${relayId}${extension}`
                );
            } catch {
                continue;
            }
        }
        return uniqueStrings(candidates);
    }

    private async buildSilentCalibrationAudioBuffer(durationMs: number) {
        const ffmpegAvailable = await this.probeFfmpegAvailability();
        if (!ffmpegAvailable) {
            throw new Error("本机缺少 ffmpeg，无法生成静音校准音频。");
        }

        const safeDurationMs = Math.max(200, Math.round(durationMs));
        const process = spawn(
            "ffmpeg",
            [
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "anullsrc=channel_layout=mono:sample_rate=24000",
                "-t",
                (safeDurationMs / 1000).toFixed(3),
                "-ar",
                "24000",
                "-ac",
                "1",
                "-f",
                "mp3",
                "-codec:a",
                "libmp3lame",
                "-b:a",
                "48k",
                "pipe:1",
            ],
            {
                stdio: ["ignore", "pipe", "pipe"],
            }
        );

        const chunks: Buffer[] = [];
        let totalBytes = 0;
        let stderr = "";
        const timeout = setTimeout(() => {
            if (!process.killed) {
                process.kill("SIGKILL");
            }
        }, AUDIO_STANDARDIZE_TIMEOUT_MS);

        return await new Promise<Buffer>((resolve, reject) => {
            const fail = (message: string) => {
                clearTimeout(timeout);
                if (!process.killed) {
                    process.kill("SIGKILL");
                }
                reject(new Error(message));
            };

            process.on("error", (error) => {
                fail(`静音校准音频生成失败: ${this.errorMessage(error)}`);
            });

            process.stderr.on("data", (chunk) => {
                stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
                if (stderr.length > 2000) {
                    stderr = stderr.slice(-2000);
                }
            });

            process.stdout.on("data", (chunk) => {
                const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                totalBytes += nextChunk.length;
                if (totalBytes > AUDIO_RELAY_MAX_BYTES) {
                    fail("静音校准音频生成失败：输出体积过大。");
                    return;
                }
                chunks.push(nextChunk);
            });

            process.on("close", (code, signal) => {
                clearTimeout(timeout);
                if (signal === "SIGKILL") {
                    reject(new Error("静音校准音频生成失败：ffmpeg 超时或被中止。"));
                    return;
                }
                if (code !== 0) {
                    reject(
                        new Error(
                            [
                                "静音校准音频生成失败",
                                `ffmpeg exited with code ${code ?? -1}`,
                                stderr ? stderr.replace(/\s+/g, " ").trim() : undefined,
                            ]
                                .filter(Boolean)
                                .join(": ")
                        )
                    );
                    return;
                }
                const buffer = Buffer.concat(chunks);
                if (buffer.length === 0) {
                    reject(new Error("静音校准音频生成失败：ffmpeg 没有输出任何音频数据。"));
                    return;
                }
                resolve(buffer);
            });
        });
    }

    private async buildSilentCalibrationRelayUrl(roundNumber: number, sampleDurationMs: number) {
        const tailPaddingMs = this.getAudioRelayTailPaddingMs();
        const totalDurationMs = sampleDurationMs + tailPaddingMs;
        const buffer = await this.buildSilentCalibrationAudioBuffer(totalDurationMs);
        const candidates = await this.buildBufferedAudioRelayCandidateUrls(buffer, {
            extension: ".mp3",
            contentType: "audio/mpeg",
            sourceLabel: `audio-calibration-round-${roundNumber}`,
            tailPaddingMs,
        });
        const relayUrl = candidates[0];
        if (!relayUrl) {
            throw new Error("静音校准音频已生成，但没有得到可供音箱访问的 relay URL。");
        }
        return relayUrl;
    }

    private isNewerConversationRecord(
        record: any,
        baselineTimestamp: number,
        baselineRequestId?: string
    ) {
        const recordTimestamp = Number(record?.time || 0);
        const recordRequestId = readString(record?.requestId) || "";
        if (recordTimestamp > baselineTimestamp) {
            return true;
        }
        if (
            recordTimestamp === baselineTimestamp &&
            recordRequestId &&
            baselineRequestId &&
            recordRequestId !== baselineRequestId
        ) {
            return true;
        }
        return false;
    }

    private async waitForConversationInterceptCalibrationRecord(
        mina: MiNAClient,
        device: DeviceContext,
        command: string,
        startedAtMs: number,
        baselineTimestamp: number,
        baselineRequestId?: string,
        anchorAtMs?: number
    ) {
        const deadlineAtMs =
            startedAtMs + CONVERSATION_INTERCEPT_CALIBRATION_TIMEOUT_MS;
        const expectedComparable =
            comparableConversationText(command) ||
            comparableDirectiveText(command) ||
            command;
        while (Date.now() < deadlineAtMs) {
            const latest = await this.performConversationFetch(mina, device).catch(
                () => null
            );
            if (latest && this.isNewerConversationRecord(latest, baselineTimestamp, baselineRequestId)) {
                const normalizedQuery =
                    normalizeEventText(readString(latest?.query), 200) ||
                    readString(latest?.query) ||
                    "";
                const comparable =
                    comparableConversationText(normalizedQuery) ||
                    comparableDirectiveText(normalizedQuery) ||
                    normalizedQuery;
                if (comparable && comparable === expectedComparable) {
                    const anchorMs =
                        typeof anchorAtMs === "number" && Number.isFinite(anchorAtMs)
                            ? anchorAtMs
                            : startedAtMs;
                    return {
                        record: latest,
                        elapsedMs: Math.max(0, Date.now() - anchorMs),
                    };
                }
            }
            await sleep(CONVERSATION_INTERCEPT_CALIBRATION_POLL_MS);
        }
        throw new Error("等待云端会话回写超时。");
    }

    private async waitForConversationInterceptCalibrationPlaybackStart(
        mina: MiNAClient,
        deviceId: string,
        startedAtMs: number,
        baselineSnapshot?: SpeakerPlaybackSnapshot | null,
        command?: string,
        timeoutMs = CONVERSATION_INTERCEPT_CALIBRATION_TIMEOUT_MS,
        cancelState?: { cancelled?: boolean },
        anchorAtMs?: number
    ) {
        const safeTimeoutMs = clamp(
            Math.round(
                Number(timeoutMs) || CONVERSATION_INTERCEPT_CALIBRATION_TIMEOUT_MS
            ),
            400,
            CONVERSATION_INTERCEPT_CALIBRATION_TIMEOUT_MS
        );
        const deadlineAtMs = startedAtMs + safeTimeoutMs;
        let lastSnapshot = baselineSnapshot || null;
        const samples: Record<string, any>[] = [];
        const elapsedAnchorMs =
            typeof anchorAtMs === "number" && Number.isFinite(anchorAtMs)
                ? anchorAtMs
                : startedAtMs;
        while (Date.now() < deadlineAtMs) {
            if (cancelState?.cancelled) {
                return null;
            }
            const snapshot = await this.readSpeakerPlaybackSnapshotWithTiming(
                mina,
                deviceId
            ).catch(() => null);
            const reason =
                this.detectConversationInterceptCalibrationPlaybackReason(
                    baselineSnapshot || null,
                    lastSnapshot,
                    snapshot
                );
            if (samples.length < CONVERSATION_INTERCEPT_CALIBRATION_DEBUG_SAMPLE_LIMIT) {
                samples.push({
                    elapsedMs: Math.max(0, Date.now() - elapsedAnchorMs),
                    reason: reason || "",
                    snapshot: this.summarizeSpeakerPlaybackSnapshot(snapshot),
                });
            }
            if (reason) {
                await this.appendDebugTrace(
                    "conversation_intercept_calibration_playback_detected",
                    {
                        deviceId,
                        command,
                        reason,
                        elapsedMs: Math.max(0, Date.now() - elapsedAnchorMs),
                        baselineSnapshot: this.summarizeSpeakerPlaybackSnapshot(
                            baselineSnapshot || null
                        ),
                        snapshot: this.summarizeSpeakerPlaybackSnapshot(snapshot),
                        samples,
                    }
                );
                return {
                    snapshot,
                    elapsedMs: Math.max(0, Date.now() - elapsedAnchorMs),
                    reason,
                };
            }
            lastSnapshot = snapshot;
            await sleep(CONVERSATION_INTERCEPT_CALIBRATION_POLL_MS);
        }
        if (cancelState?.cancelled) {
            return null;
        }
        await this.appendDebugTrace(
            "conversation_intercept_calibration_playback_timeout",
            {
                deviceId,
                command,
                baselineSnapshot: this.summarizeSpeakerPlaybackSnapshot(
                    baselineSnapshot || null
                ),
                lastSnapshot: this.summarizeSpeakerPlaybackSnapshot(lastSnapshot),
                samples,
            }
        );
        throw new Error("等待原生回复起播超时。");
    }

    private estimateConversationInterceptPlaybackWaitMs(deviceId?: string) {
        const speakerProfile = this.readSpeakerAudioLatencyProfile(deviceId);
        const playbackDetectEstimateMs =
            readNumber(speakerProfile?.playbackDetectEstimateMs) || 0;
        const statusProbeEstimateMs =
            readNumber(speakerProfile?.statusProbeEstimateMs) || 0;
        return clamp(
            Math.round(
                Math.max(
                    1800,
                    playbackDetectEstimateMs > 0
                        ? playbackDetectEstimateMs * 1.6
                        : 0,
                    statusProbeEstimateMs > 0
                        ? statusProbeEstimateMs * 1.35
                        : 0
                )
            ),
            1800,
            5000
        );
    }

    private estimateFallbackConversationInterceptLeadMs(deviceId?: string) {
        const speakerProfile = this.readSpeakerAudioLatencyProfile(deviceId);
        const playbackDetectEstimateMs =
            readNumber(speakerProfile?.playbackDetectEstimateMs) || 0;
        const statusProbeEstimateMs =
            readNumber(speakerProfile?.statusProbeEstimateMs) || 0;
        return clamp(
            Math.round(
                Math.max(
                    280,
                    playbackDetectEstimateMs > 0
                        ? playbackDetectEstimateMs * 0.28
                        : 0,
                    statusProbeEstimateMs > 0
                        ? statusProbeEstimateMs * 0.2
                        : 0
                )
            ),
            250,
            1200
        );
    }

    private estimateConversationInterceptCalibrationPostVisibleObserveMs(
        deviceId?: string
    ) {
        const speakerProfile = this.readSpeakerAudioLatencyProfile(deviceId);
        const interceptProfile = this.readConversationInterceptLatencyProfile(deviceId);
        const interceptLeadEstimateMs =
            readNumber(interceptProfile?.interceptLeadEstimateMs) || 0;
        const fallbackLeadMs =
            this.estimateFallbackConversationInterceptLeadMs(deviceId);
        const playbackDetectEstimateMs =
            readNumber(speakerProfile?.playbackDetectEstimateMs) || 0;
        const statusProbeEstimateMs =
            readNumber(speakerProfile?.statusProbeEstimateMs) || 0;
        const pauseCommandEstimateMs =
            readNumber(speakerProfile?.pauseCommandEstimateMs) || 0;
        return clamp(
            Math.round(
                Math.max(
                    CONVERSATION_INTERCEPT_CALIBRATION_POST_VISIBLE_OBSERVE_MIN_MS,
                    interceptLeadEstimateMs > 0 ? interceptLeadEstimateMs + 60 : 0,
                    fallbackLeadMs > 0 ? fallbackLeadMs + 40 : 0,
                    playbackDetectEstimateMs > 0
                        ? playbackDetectEstimateMs * 0.24
                        : 0,
                    statusProbeEstimateMs > 0 ? statusProbeEstimateMs * 0.18 : 0,
                    pauseCommandEstimateMs > 0
                        ? pauseCommandEstimateMs * 0.45
                        : 0
                )
            ),
            CONVERSATION_INTERCEPT_CALIBRATION_POST_VISIBLE_OBSERVE_MIN_MS,
            CONVERSATION_INTERCEPT_CALIBRATION_POST_VISIBLE_OBSERVE_MAX_MS
        );
    }

    private async runConversationInterceptCalibration() {
        const config = await this.loadConfig(false);
        const { device, mina, miio } = await this.ensureActionContext();
        const startedAt = new Date().toISOString();
        const rounds = CONVERSATION_INTERCEPT_CALIBRATION_QUERIES.slice();
        let successCount = 0;
        let failureCount = 0;
        let fallbackRounds = 0;
        let lastError: string | undefined;

        this.conversationInterceptCalibrationRunning = true;
        this.activeConversationCalibrationDeviceId = device.minaDeviceId;
        this.activeConversationCalibrationSamples = {};
        try {
            await this.stopSpeaker({ fast: true }).catch(() => false);
            await this.clearConsoleAudioPlaybackState().catch(() => undefined);

            for (let index = 0; index < rounds.length; index += 1) {
                const command = rounds[index] || rounds[0] || "现在几点";
                try {
                    await this.stopSpeaker({ fast: true }).catch(() => false);
                    await sleep(160);
                    const baseline =
                        (await this.fetchLatestConversationFor(mina, device).catch(
                            () => null
                        )) || null;
                    const baselinePlaybackSnapshot =
                        (await this.readSpeakerPlaybackSnapshotWithTiming(
                            mina,
                            device.minaDeviceId
                        ).catch(() => null)) || null;
                    const baselineTimestamp = Number(baseline?.time || 0);
                    const baselineRequestId = readString(baseline?.requestId) || "";
                    const startedAtMs = Date.now();
                    const playbackWaitMs =
                        this.estimateConversationInterceptPlaybackWaitMs(
                            device.minaDeviceId
                        );
                    const ok = await this.executeDirective(command, false);
                    if (!ok) {
                        throw new Error("测试问句没有成功发给小爱。");
                    }
                    const commandAcceptedAtMs = Date.now();

                    const playbackCancelState = { cancelled: false };
                    const calibrationPauseGuardTask =
                        this.shouldRunConversationInterceptPauseGuard(
                            device.minaDeviceId
                        )
                            ? this.runConversationInterceptCalibrationPauseGuard(
                                {
                                    device,
                                    mina,
                                    miio,
                                },
                                commandAcceptedAtMs,
                                playbackCancelState
                            ).catch((error) => {
                                void this.appendDebugTrace(
                                    "conversation_intercept_calibration_pause_guard_error",
                                    {
                                        deviceId: device.minaDeviceId,
                                        command,
                                        message: this.errorMessage(error),
                                    }
                                );
                            })
                            : Promise.resolve();
                    const playbackResultPromise =
                        this.waitForConversationInterceptCalibrationPlaybackStart(
                            mina,
                            device.minaDeviceId,
                            startedAtMs,
                            baselinePlaybackSnapshot,
                            command,
                            playbackWaitMs,
                            playbackCancelState,
                            commandAcceptedAtMs
                        ).catch(() => null);
                    const conversationResult =
                        await this.waitForConversationInterceptCalibrationRecord(
                            mina,
                            device,
                            command,
                            startedAtMs,
                            baselineTimestamp,
                            baselineRequestId,
                            commandAcceptedAtMs
                        );
                    const conversationVisibleMs = Math.max(
                        1,
                        conversationResult.elapsedMs
                    );
                    const normalizedConversation =
                        this.normalizeConversationRecord(conversationResult.record);
                    const playbackObservationTimeout = Symbol(
                        "conversation-intercept-calibration-observation-timeout"
                    );
                    const playbackObservationBudgetMs =
                        this.estimateConversationInterceptCalibrationPostVisibleObserveMs(
                            device.minaDeviceId
                        );
                    const playbackResult =
                        normalizedConversation.answers.length > 0
                            ? await Promise.race<
                                  Awaited<typeof playbackResultPromise> | symbol
                              >([
                                  playbackResultPromise,
                                  sleep(playbackObservationBudgetMs).then(
                                      () => playbackObservationTimeout
                                  ),
                              ])
                            : await playbackResultPromise;
                    if (playbackResult === playbackObservationTimeout) {
                        playbackCancelState.cancelled = true;
                    }
                    let observedPlaybackResult: Awaited<
                        typeof playbackResultPromise
                    > = null;
                    if (playbackResult && typeof playbackResult === "object") {
                        observedPlaybackResult = playbackResult;
                    }
                    let nativePlaybackStartMs = 0;
                    let interceptLeadMs = 0;
                    let usedFallbackLead = false;
                    let appliedFallbackFloor = false;
                    let playbackDetectionReason = "";
                    const fallbackLeadMs =
                        this.estimateFallbackConversationInterceptLeadMs(
                            device.minaDeviceId
                        );
                    if (observedPlaybackResult) {
                        nativePlaybackStartMs = Math.max(
                            1,
                            observedPlaybackResult.elapsedMs
                        );
                        playbackDetectionReason =
                            readString(observedPlaybackResult.reason) || "";
                        const detectedLeadMs = Math.max(
                            1,
                            nativePlaybackStartMs - conversationVisibleMs
                        );
                        interceptLeadMs = Math.max(
                            detectedLeadMs,
                            fallbackLeadMs
                        );
                        appliedFallbackFloor = interceptLeadMs > detectedLeadMs;
                        nativePlaybackStartMs = Math.max(
                            nativePlaybackStartMs,
                            conversationVisibleMs + interceptLeadMs
                        );
                    } else if (normalizedConversation.answers.length > 0) {
                        nativePlaybackStartMs = Math.max(
                            conversationVisibleMs + fallbackLeadMs,
                            conversationVisibleMs + 1
                        );
                        interceptLeadMs = Math.max(1, fallbackLeadMs);
                        usedFallbackLead = true;
                        fallbackRounds += 1;
                        await this.appendDebugTrace(
                            "conversation_intercept_calibration_fallback",
                            {
                                deviceId: device.minaDeviceId,
                                command,
                                conversationVisibleMs,
                                fallbackLeadMs,
                                playbackWaitMs,
                                playbackObservationBudgetMs,
                                answers: normalizedConversation.answers.slice(0, 2),
                            }
                        );
                    } else {
                        throw new Error("等待原生回复起播超时。");
                    }
                    playbackCancelState.cancelled = true;
                    await calibrationPauseGuardTask;
                    await this.stopSpeaker({ fast: true }).catch(() => false);
                    await this.clearConsoleAudioPlaybackState().catch(
                        () => undefined
                    );
                    this.updateConversationInterceptLatencyEstimate(
                        device.minaDeviceId,
                        "conversationVisibleEstimateMs",
                        conversationVisibleMs
                    );
                    this.updateConversationInterceptLatencyEstimate(
                        device.minaDeviceId,
                        "nativePlaybackStartEstimateMs",
                        nativePlaybackStartMs
                    );
                    this.updateConversationInterceptLatencyEstimate(
                        device.minaDeviceId,
                        "interceptLeadEstimateMs",
                        interceptLeadMs
                    );
                    await this.appendDebugTrace(
                        "conversation_intercept_calibration_round",
                        {
                            deviceId: device.minaDeviceId,
                            command,
                            commandDispatchMs: Math.max(
                                0,
                                commandAcceptedAtMs - startedAtMs
                            ),
                            conversationVisibleMs,
                            nativePlaybackStartMs,
                            interceptLeadMs,
                            usedFallbackLead,
                            appliedFallbackFloor,
                            playbackDetectionReason,
                            fallbackLeadMs,
                            playbackObservationBudgetMs,
                            pollIntervalMs: config.pollIntervalMs,
                        }
                    );
                    successCount += 1;
                } catch (error) {
                    failureCount += 1;
                    lastError =
                        this.errorMessage(error) || "对话拦截校准失败。";
                } finally {
                    await this.stopSpeaker({ fast: true }).catch(() => false);
                    await this.clearConsoleAudioPlaybackState().catch(() => undefined);
                    await sleep(CONVERSATION_INTERCEPT_CALIBRATION_SETTLE_MS);
                }
            }

            const nextPollIntervalMs = this.recommendConversationPollIntervalMs(
                device.minaDeviceId,
                config.pollIntervalMs
            );
            let finalPollIntervalMs = normalizePollIntervalMs(
                config.pollIntervalMs,
                DEFAULT_POLL_INTERVAL_MS
            );
            if (successCount > 0 && nextPollIntervalMs !== finalPollIntervalMs) {
                const updated = await this.updatePollIntervalMs(nextPollIntervalMs);
                finalPollIntervalMs = updated.pollIntervalMs;
            }
            if (successCount > 0) {
                this.applyConversationInterceptCalibrationSamples(device.minaDeviceId);
            }

            const summary: PersistedConversationInterceptCalibrationSummary = {
                deviceId: device.minaDeviceId,
                deviceName: device.name,
                rounds: rounds.length,
                successCount,
                failureCount,
                fallbackRounds,
                strategy: this.classifyConversationInterceptCalibrationStrategy({
                    successCount,
                    fallbackRounds,
                }),
                pollIntervalMs: finalPollIntervalMs,
                recommendedPollIntervalMs: nextPollIntervalMs,
                startedAt,
                completedAt: new Date().toISOString(),
                lastError,
                latencyProfile:
                    this.serializeConversationInterceptLatencyProfileForPersistence(
                        this.readConversationInterceptLatencyProfile(
                            device.minaDeviceId
                        )
                    ),
            };
            this.lastConversationInterceptCalibration = summary;
            await this.persistResolvedProfile(
                this.config || config,
                this.device || device,
                false
            );

            this.recordConsoleEvent(
                "console.conversation-intercept-calibration",
                successCount > 0
                    ? "控制台对话拦截校准完成"
                    : "控制台对话拦截校准失败",
                [
                    `设备：${device.name || device.minaDeviceId}`,
                    `成功 ${successCount}/${rounds.length} 轮`,
                    `轮询间隔 ${finalPollIntervalMs}ms`,
                    nextPollIntervalMs !== finalPollIntervalMs
                        ? `建议值 ${nextPollIntervalMs}ms`
                        : "",
                    lastError ? `最后错误：${lastError}` : "",
                ]
                    .filter(Boolean)
                    .join(" · "),
                successCount > 0 ? "success" : "error"
            );

            if (successCount <= 0) {
                throw new Error(lastError || "对话拦截校准未能成功跑通任何一轮。");
            }
            return summary;
        } finally {
            this.conversationInterceptCalibrationRunning = false;
            this.activeConversationCalibrationDeviceId = undefined;
            this.activeConversationCalibrationSamples = undefined;
        }
    }

    private async runSpeakerAudioCalibration() {
        const config = await this.loadConfig(false);
        const { device } = await this.ensureActionContext();
        const tailPaddingMs = this.getAudioRelayTailPaddingMs(config);
        const rounds = AUDIO_CALIBRATION_SAMPLE_DURATIONS_MS.slice();
        const startedAt = new Date().toISOString();
        let successCount = 0;
        let failureCount = 0;
        let lastError: string | undefined;

        this.audioCalibrationRunning = true;
        this.activeSpeakerAudioCalibrationDeviceId = device.minaDeviceId;
        this.activeSpeakerAudioCalibrationSamples = {};
        try {
            await this.stopSpeaker({ fast: true }).catch(() => false);
            await this.clearConsoleAudioPlaybackState().catch(() => undefined);
            await sleep(200);

            for (let index = 0; index < rounds.length; index += 1) {
                const sampleDurationMs = rounds[index] || tailPaddingMs;
                try {
                    const relayUrl = await this.buildSilentCalibrationRelayUrl(
                        index + 1,
                        sampleDurationMs
                    );
                    await this.playAudioUrl(relayUrl, {
                        title: `静音校准 ${index + 1}/${rounds.length}`,
                        interrupt: true,
                        ignoreRecentFailure: true,
                        consoleEventKind: "console.audio-calibration",
                        consoleEventTitle: "控制台静音校准",
                    });
                    const stopped =
                        (await this.stopSpeaker({
                            fast: true,
                            preserveLoopGuard: false,
                        }).catch(() => false)) ||
                        (await this.stopSpeaker({
                            preserveLoopGuard: false,
                        }).catch(() => false));
                    if (!stopped) {
                        throw new Error("校准样本播放后未能及时停止音箱播放状态。");
                    }
                    successCount += 1;
                } catch (error) {
                    failureCount += 1;
                    lastError = this.errorMessage(error) || "静音校准失败。";
                } finally {
                    await this.clearConsoleAudioPlaybackState().catch(() => undefined);
                    await sleep(AUDIO_CALIBRATION_ROUND_SETTLE_MS);
                }
            }
            if (successCount > 0) {
                this.applySpeakerAudioCalibrationSamples(device.minaDeviceId);
            }

            const summary: PersistedAudioCalibrationSummary = {
                deviceId: device.minaDeviceId,
                deviceName: device.name,
                rounds: rounds.length,
                successCount,
                failureCount,
                tailPaddingMs,
                startedAt,
                completedAt: new Date().toISOString(),
                lastError,
                latencyProfile: this.serializeSpeakerAudioLatencyProfileForPersistence(
                    this.readSpeakerAudioLatencyProfile(device.minaDeviceId)
                ),
            };
            this.lastAudioCalibration = summary;
            await this.persistResolvedProfile(config, this.device || device, false);

            this.recordConsoleEvent(
                "console.audio-calibration",
                successCount > 0 ? "控制台静音校准完成" : "控制台静音校准失败",
                [
                    `设备：${device.name || device.minaDeviceId}`,
                    `成功 ${successCount}/${rounds.length} 轮`,
                    `空余延迟 ${tailPaddingMs}ms`,
                    lastError ? `最后错误：${lastError}` : "",
                ]
                    .filter(Boolean)
                    .join(" · "),
                successCount > 0 ? "success" : "error"
            );

            if (successCount <= 0) {
                throw new Error(lastError || "静音校准未能成功跑通任何一轮。");
            }
            return summary;
        } finally {
            this.audioCalibrationRunning = false;
            this.activeSpeakerAudioCalibrationDeviceId = undefined;
            this.activeSpeakerAudioCalibrationSamples = undefined;
        }
    }

    private isHostedAudioRelayUrl(url: string) {
        try {
            const parsed = new URL(url);
            return /(?:^|\/)audio-relay\/[^/]+$/i.test(parsed.pathname);
        } catch {
            return false;
        }
    }

    private parseHostedAudioRelayId(url: string) {
        try {
            const parsed = new URL(url);
            const relayName = parsed.pathname.split("/").pop() || "";
            const relayId = relayName.replace(/\.[a-z0-9]+$/i, "").trim();
            return relayId || undefined;
        } catch {
            return undefined;
        }
    }

    private readHostedAudioRelayEntry(url: string) {
        const relayId = this.parseHostedAudioRelayId(url);
        if (!relayId) {
            return undefined;
        }
        return this.audioRelayEntries.get(relayId);
    }

    private async ensureHostedAudioRelayEntry(url?: string) {
        if (!url) {
            return undefined;
        }
        const relayId = this.parseHostedAudioRelayId(url);
        if (!relayId) {
            return undefined;
        }
        const existing = this.audioRelayEntries.get(relayId);
        if (existing) {
            return existing;
        }
        const restored = await this.restorePersistedAudioRelayEntry(relayId);
        if (restored) {
            this.audioRelayEntries.set(relayId, restored);
            return restored;
        }
        return undefined;
    }

    private collectSpeakerAudioCalibrationSample(
        deviceId: string,
        key: SpeakerAudioLatencyKey,
        observedMs?: number
    ) {
        if (
            !this.audioCalibrationRunning ||
            this.activeSpeakerAudioCalibrationDeviceId !== deviceId
        ) {
            return;
        }
        appendTimingSample(
            this.activeSpeakerAudioCalibrationSamples,
            key,
            observedMs,
            10_000
        );
    }

    private applySpeakerAudioCalibrationSamples(deviceId: string) {
        if (
            !deviceId ||
            this.activeSpeakerAudioCalibrationDeviceId !== deviceId ||
            !this.activeSpeakerAudioCalibrationSamples
        ) {
            return undefined;
        }
        const current = this.speakerAudioLatencyProfiles.get(deviceId) || {
            updatedAtMs: 0,
        };
        const nextProfile: SpeakerAudioLatencyProfile = {
            ...current,
            updatedAtMs: Date.now(),
        };
        const nextStatusProbe = buildRobustTimingEstimate(
            this.activeSpeakerAudioCalibrationSamples.statusProbeEstimateMs,
            {
                cap: 10_000,
                percentile: 0.62,
                headroom: 1.1,
            }
        );
        if (typeof nextStatusProbe === "number") {
            nextProfile.statusProbeEstimateMs = nextStatusProbe;
        }
        const nextPauseCommand = buildRobustTimingEstimate(
            this.activeSpeakerAudioCalibrationSamples.pauseCommandEstimateMs,
            {
                cap: 10_000,
                percentile: 0.58,
                headroom: 1.08,
            }
        );
        if (typeof nextPauseCommand === "number") {
            nextProfile.pauseCommandEstimateMs = nextPauseCommand;
        }
        const nextPauseSettle = buildRobustTimingEstimate(
            this.activeSpeakerAudioCalibrationSamples.pauseSettleEstimateMs,
            {
                cap: 10_000,
                percentile: 0.6,
                headroom: 1.08,
            }
        );
        if (typeof nextPauseSettle === "number") {
            nextProfile.pauseSettleEstimateMs = nextPauseSettle;
        }
        const nextStopSettle = buildRobustTimingEstimate(
            this.activeSpeakerAudioCalibrationSamples.stopSettleEstimateMs,
            {
                cap: 10_000,
                percentile: 0.6,
                headroom: 1.08,
            }
        );
        if (typeof nextStopSettle === "number") {
            nextProfile.stopSettleEstimateMs = nextStopSettle;
        }
        const nextPlaybackDetect = buildRobustTimingEstimate(
            this.activeSpeakerAudioCalibrationSamples.playbackDetectEstimateMs,
            {
                cap: 10_000,
                percentile: 0.58,
                headroom: 1.05,
            }
        );
        if (typeof nextPlaybackDetect === "number") {
            nextProfile.playbackDetectEstimateMs = nextPlaybackDetect;
        }
        this.speakerAudioLatencyProfiles.set(deviceId, nextProfile);
        return nextProfile;
    }

    private collectConversationInterceptCalibrationSample(
        deviceId: string,
        key: ConversationInterceptLatencyKey,
        observedMs?: number
    ) {
        if (
            !this.conversationInterceptCalibrationRunning ||
            this.activeConversationCalibrationDeviceId !== deviceId
        ) {
            return;
        }
        appendTimingSample(
            this.activeConversationCalibrationSamples,
            key,
            observedMs,
            20_000
        );
    }

    private applyConversationInterceptCalibrationSamples(deviceId: string) {
        if (
            !deviceId ||
            this.activeConversationCalibrationDeviceId !== deviceId ||
            !this.activeConversationCalibrationSamples
        ) {
            return undefined;
        }
        const current = this.conversationInterceptLatencyProfiles.get(deviceId) || {
            updatedAtMs: 0,
        };
        const nextProfile: ConversationInterceptLatencyProfile = {
            ...current,
            updatedAtMs: Date.now(),
        };
        const nextConversationVisible = buildRobustTimingEstimate(
            this.activeConversationCalibrationSamples.conversationVisibleEstimateMs,
            {
                cap: 20_000,
                percentile: 0.6,
                headroom: 1.05,
            }
        );
        if (typeof nextConversationVisible === "number") {
            nextProfile.conversationVisibleEstimateMs = nextConversationVisible;
        }
        const nextNativePlaybackStart = buildRobustTimingEstimate(
            this.activeConversationCalibrationSamples.nativePlaybackStartEstimateMs,
            {
                cap: 20_000,
                percentile: 0.58,
                headroom: 1.04,
            }
        );
        if (typeof nextNativePlaybackStart === "number") {
            nextProfile.nativePlaybackStartEstimateMs = nextNativePlaybackStart;
        }
        const nextInterceptLead = buildRobustTimingEstimate(
            this.activeConversationCalibrationSamples.interceptLeadEstimateMs,
            {
                cap: 20_000,
                percentile: 0.38,
                headroom: 1,
            }
        );
        if (typeof nextInterceptLead === "number") {
            nextProfile.interceptLeadEstimateMs = clamp(nextInterceptLead, 120, 20_000);
        }
        if (
            typeof nextProfile.conversationVisibleEstimateMs === "number" &&
            typeof nextProfile.interceptLeadEstimateMs === "number"
        ) {
            nextProfile.nativePlaybackStartEstimateMs = Math.max(
                readNumber(nextProfile.nativePlaybackStartEstimateMs) || 0,
                nextProfile.conversationVisibleEstimateMs +
                    nextProfile.interceptLeadEstimateMs
            );
        }
        this.conversationInterceptLatencyProfiles.set(deviceId, nextProfile);
        return nextProfile;
    }

    private updateSpeakerAudioLatencyEstimate(
        deviceId: string,
        key: SpeakerAudioLatencyKey,
        observedMs?: number
    ) {
        const nextObservedMs = readNumber(observedMs);
        if (
            !deviceId ||
            typeof nextObservedMs !== "number" ||
            !Number.isFinite(nextObservedMs) ||
            nextObservedMs <= 0
        ) {
            return undefined;
        }
        const boundedObservedMs = clamp(Math.round(nextObservedMs), 1, 10_000);
        this.collectSpeakerAudioCalibrationSample(
            deviceId,
            key,
            boundedObservedMs
        );
        const current = this.speakerAudioLatencyProfiles.get(deviceId) || {
            updatedAtMs: 0,
        };
        const previousEstimate = readNumber(current[key]);
        const nextEstimate =
            typeof previousEstimate === "number" && Number.isFinite(previousEstimate)
                ? boundedObservedMs >= previousEstimate
                    ? clamp(
                        Math.round(
                            previousEstimate * 0.72 +
                                Math.min(
                                    boundedObservedMs,
                                    Math.max(
                                        previousEstimate * 1.7,
                                        previousEstimate + 220
                                    )
                                ) *
                                    0.28
                        ),
                        1,
                        10_000
                    )
                    : clamp(
                        Math.round(
                            previousEstimate * 0.35 + boundedObservedMs * 0.65
                        ),
                        1,
                        10_000
                    )
                : boundedObservedMs;
        const nextProfile: SpeakerAudioLatencyProfile = {
            ...current,
            [key]: nextEstimate,
            updatedAtMs: Date.now(),
        };
        this.speakerAudioLatencyProfiles.set(deviceId, nextProfile);
        return nextEstimate;
    }

    private readSpeakerAudioLatencyProfile(deviceId?: string) {
        const normalizedDeviceId = readString(deviceId);
        if (!normalizedDeviceId) {
            return undefined;
        }
        return this.speakerAudioLatencyProfiles.get(normalizedDeviceId);
    }

    private updateConversationInterceptLatencyEstimate(
        deviceId: string,
        key: ConversationInterceptLatencyKey,
        observedMs?: number
    ) {
        const nextObservedMs = readNumber(observedMs);
        if (
            !deviceId ||
            typeof nextObservedMs !== "number" ||
            !Number.isFinite(nextObservedMs) ||
            nextObservedMs <= 0
        ) {
            return undefined;
        }
        const boundedObservedMs = clamp(Math.round(nextObservedMs), 1, 20_000);
        this.collectConversationInterceptCalibrationSample(
            deviceId,
            key,
            boundedObservedMs
        );
        const current = this.conversationInterceptLatencyProfiles.get(deviceId) || {
            updatedAtMs: 0,
        };
        const previousEstimate = readNumber(current[key]);
        let nextEstimate = boundedObservedMs;
        if (typeof previousEstimate === "number" && Number.isFinite(previousEstimate)) {
            if (key === "interceptLeadEstimateMs") {
                nextEstimate =
                    boundedObservedMs >= previousEstimate
                        ? clamp(
                            Math.round(
                                previousEstimate * 0.82 +
                                    Math.min(
                                        boundedObservedMs,
                                        Math.max(
                                            previousEstimate * 1.12,
                                            previousEstimate + 60
                                        )
                                    ) *
                                        0.18
                            ),
                            1,
                            20_000
                        )
                        : clamp(
                            Math.round(
                                previousEstimate * 0.32 +
                                    boundedObservedMs * 0.68
                            ),
                            1,
                            20_000
                        );
            } else {
                nextEstimate =
                    boundedObservedMs >= previousEstimate
                        ? clamp(
                            Math.round(
                                previousEstimate * 0.74 +
                                    Math.min(
                                        boundedObservedMs,
                                        Math.max(
                                            previousEstimate * 1.6,
                                            previousEstimate + 260
                                        )
                                    ) *
                                        0.26
                            ),
                            1,
                            20_000
                        )
                        : clamp(
                            Math.round(
                                previousEstimate * 0.42 +
                                    boundedObservedMs * 0.58
                            ),
                            1,
                            20_000
                        );
            }
        }
        const nextProfile: ConversationInterceptLatencyProfile = {
            ...current,
            [key]: nextEstimate,
            updatedAtMs: Date.now(),
        };
        this.conversationInterceptLatencyProfiles.set(deviceId, nextProfile);
        return nextEstimate;
    }

    private readConversationInterceptLatencyProfile(deviceId?: string) {
        const normalizedDeviceId = readString(deviceId);
        if (!normalizedDeviceId) {
            return undefined;
        }
        return this.conversationInterceptLatencyProfiles.get(normalizedDeviceId);
    }

    private readConversationInterceptRuntimeState(deviceId?: string) {
        const normalizedDeviceId = readString(deviceId);
        if (!normalizedDeviceId) {
            return undefined;
        }
        return this.conversationInterceptRuntimeStates.get(normalizedDeviceId);
    }

    private updateConversationInterceptRuntimeState(
        deviceId: string,
        updater: (
            current: ConversationInterceptRuntimeState
        ) => ConversationInterceptRuntimeState
    ) {
        if (!deviceId) {
            return undefined;
        }
        const current =
            this.conversationInterceptRuntimeStates.get(deviceId) || {
                updatedAtMs: 0,
                lateRecordScore: 0,
                playbackReboundScore: 0,
            };
        const next = updater(current);
        const normalized: ConversationInterceptRuntimeState = {
            updatedAtMs: Date.now(),
            lateRecordScore: clamp(
                Math.round(readNumber(next.lateRecordScore) || 0),
                0,
                8
            ),
            playbackReboundScore: clamp(
                Math.round(readNumber(next.playbackReboundScore) || 0),
                0,
                8
            ),
            lastPlaybackDetectedElapsedMs: (() => {
                const elapsedMs = readNumber(next.lastPlaybackDetectedElapsedMs);
                return typeof elapsedMs === "number" && Number.isFinite(elapsedMs) && elapsedMs > 0
                    ? clamp(Math.round(elapsedMs), 1, 20_000)
                    : undefined;
            })(),
        };
        this.conversationInterceptRuntimeStates.set(deviceId, normalized);
        return normalized;
    }

    private noteConversationInterceptLateRecord(
        deviceId?: string,
        answersPresent = false
    ) {
        const normalizedDeviceId = readString(deviceId);
        if (!normalizedDeviceId) {
            return undefined;
        }
        return this.updateConversationInterceptRuntimeState(
            normalizedDeviceId,
            (current) => ({
                ...current,
                lateRecordScore:
                    current.lateRecordScore + (answersPresent ? 2 : -1),
            })
        );
    }

    private noteConversationInterceptPlaybackRebound(
        deviceId?: string,
        detected = false,
        elapsedMs?: number
    ) {
        const normalizedDeviceId = readString(deviceId);
        if (!normalizedDeviceId) {
            return undefined;
        }
        return this.updateConversationInterceptRuntimeState(
            normalizedDeviceId,
            (current) => ({
                ...current,
                playbackReboundScore:
                    current.playbackReboundScore + (detected ? 2 : -1),
                lastPlaybackDetectedElapsedMs: detected
                    ? readNumber(elapsedMs) || current.lastPlaybackDetectedElapsedMs
                    : current.lastPlaybackDetectedElapsedMs,
            })
        );
    }

    private shouldRunConversationInterceptPauseGuard(deviceId?: string) {
        const normalizedDeviceId = readString(deviceId);
        const summary = this.lastConversationInterceptCalibration;
        if (
            !normalizedDeviceId ||
            !summary ||
            readString(summary.deviceId) !== normalizedDeviceId
        ) {
            return false;
        }
        const strategy =
            summary.strategy ||
            this.classifyConversationInterceptCalibrationStrategy(summary);
        return strategy === "fallback-only" || strategy === "mixed";
    }

    private buildConversationInterceptGuardPlan(
        deviceId?: string,
        hint?: ConversationInterceptHint
    ): ConversationInterceptGuardPlan {
        const normalizedDeviceId = readString(deviceId);
        const summary =
            normalizedDeviceId &&
            this.lastConversationInterceptCalibration &&
            readString(this.lastConversationInterceptCalibration.deviceId) ===
                normalizedDeviceId
                ? this.lastConversationInterceptCalibration
                : undefined;
        const strategy =
            summary?.strategy ||
            this.classifyConversationInterceptCalibrationStrategy(summary);
        const speakerProfile = this.readSpeakerAudioLatencyProfile(deviceId);
        const interceptProfile = this.readConversationInterceptLatencyProfile(deviceId);
        const runtimeState = this.readConversationInterceptRuntimeState(deviceId);
        const answersPresent = Boolean(hint?.answersPresent);
        const lateRecordScore = readNumber(runtimeState?.lateRecordScore) || 0;
        const playbackReboundScore =
            readNumber(runtimeState?.playbackReboundScore) || 0;
        const interceptLeadMs =
            readNumber(interceptProfile?.interceptLeadEstimateMs) ||
            this.estimateFallbackConversationInterceptLeadMs(deviceId);
        const manualOffsetMs = normalizeConversationInterceptManualOffsetMs(
            interceptProfile?.manualOffsetMs
        );
        const conversationVisibleEstimateMs =
            readNumber(interceptProfile?.conversationVisibleEstimateMs) || 0;
        const nativePlaybackStartEstimateMs =
            readNumber(interceptProfile?.nativePlaybackStartEstimateMs) || 0;
        const pauseCommandEstimateMs =
            readNumber(speakerProfile?.pauseCommandEstimateMs) || 0;
        const stopSettleEstimateMs =
            readNumber(speakerProfile?.stopSettleEstimateMs) || 0;
        const pauseSettleEstimateMs =
            readNumber(speakerProfile?.pauseSettleEstimateMs) || 0;
        const statusProbeEstimateMs =
            readNumber(speakerProfile?.statusProbeEstimateMs) || 0;
        const lastPlaybackDetectedElapsedMs =
            readNumber(runtimeState?.lastPlaybackDetectedElapsedMs) || 0;

        let urgency = 0;
        if (strategy === "fallback-only") {
            urgency += 2;
        } else if (strategy === "mixed") {
            urgency += 1;
        }
        if (answersPresent) {
            urgency += 3;
        }
        urgency += Math.min(3, lateRecordScore * 0.45);
        urgency += Math.min(3, playbackReboundScore * 0.55);
        if (
            interceptLeadMs > 0 &&
            pauseCommandEstimateMs > 0 &&
            pauseCommandEstimateMs >= interceptLeadMs * 0.9
        ) {
            urgency += 1;
        }
        if (
            interceptLeadMs > 0 &&
            statusProbeEstimateMs > 0 &&
            statusProbeEstimateMs >= interceptLeadMs * 2.4
        ) {
            urgency += 1;
        }
        if (
            lastPlaybackDetectedElapsedMs > 0 &&
            lastPlaybackDetectedElapsedMs <= 1000
        ) {
            urgency += 1;
        }

        const aggressive = urgency >= 3;
        const predictedSpeechOnsetMs = Math.max(
            interceptLeadMs > 0 ? interceptLeadMs : 0,
            nativePlaybackStartEstimateMs > 0 && conversationVisibleEstimateMs > 0
                ? Math.max(
                    0,
                    nativePlaybackStartEstimateMs - conversationVisibleEstimateMs
                )
                : 0,
            lastPlaybackDetectedElapsedMs > 0
                ? lastPlaybackDetectedElapsedMs
                : 0,
            answersPresent ? 0 : 220
        );
        const primaryLeadReserveMs = Math.max(
            aggressive ? 120 : 90,
            pauseCommandEstimateMs > 0
                ? Math.round(pauseCommandEstimateMs * 0.85)
                : 0,
            stopSettleEstimateMs > 0
                ? Math.round(stopSettleEstimateMs * 0.18)
                : 0,
            statusProbeEstimateMs > 0
                ? Math.round(statusProbeEstimateMs * 0.1)
                : 0
        );
        let primarySilenceDelayMs = clamp(
            Math.round(Math.max(0, predictedSpeechOnsetMs - primaryLeadReserveMs)),
            0,
            CONVERSATION_INTERCEPT_FALLBACK_GUARD_MAX_DELAY_MS
        );
        if (answersPresent) {
            primarySilenceDelayMs = 0;
        } else if (
            strategy === "fallback-only" &&
            interceptLeadMs > 0 &&
            pauseCommandEstimateMs > 0 &&
            interceptLeadMs <= pauseCommandEstimateMs * 1.15
        ) {
            primarySilenceDelayMs = 0;
        } else if (
            lastPlaybackDetectedElapsedMs > 0 &&
            lastPlaybackDetectedElapsedMs < primarySilenceDelayMs
        ) {
            primarySilenceDelayMs = clamp(
                Math.round(Math.max(0, lastPlaybackDetectedElapsedMs - 110)),
                0,
                CONVERSATION_INTERCEPT_FALLBACK_GUARD_MAX_DELAY_MS
            );
        } else if (lateRecordScore >= 2 || playbackReboundScore >= 2) {
            primarySilenceDelayMs = Math.min(primarySilenceDelayMs, aggressive ? 80 : 140);
        }
        primarySilenceDelayMs = clamp(
            primarySilenceDelayMs + manualOffsetMs,
            0,
            CONVERSATION_INTERCEPT_FALLBACK_GUARD_MAX_DELAY_MS
        );
        const suppressTransitionPrompt = false;
        const guardDelaysMs =
            this.computeConversationInterceptFallbackGuardDelaysMs(deviceId, {
                aggressive,
                answersPresent,
                lateRecordScore,
                playbackReboundScore,
                primarySilenceDelayMs,
                manualOffsetMs,
            });
        const lateRecordFollowUpDelayMs = clamp(
            Math.round(
                CONVERSATION_INTERCEPT_LATE_RECORD_BURST_DELAY_MS +
                    manualOffsetMs * 0.35
            ),
            0,
            420
        );
        const runtimeMonitorDurationMs = clamp(
            Math.round(
                Math.max(
                    CONVERSATION_INTERCEPT_RUNTIME_MONITOR_MIN_MS,
                    answersPresent ? 2000 : 0,
                    aggressive ? 1700 : 0,
                    interceptLeadMs > 0 ? interceptLeadMs + 1100 : 0,
                    pauseSettleEstimateMs > 0
                        ? pauseSettleEstimateMs * 0.55
                        : 0,
                    statusProbeEstimateMs > 0
                        ? statusProbeEstimateMs * 1.5
                        : 0,
                    lastPlaybackDetectedElapsedMs > 0
                        ? lastPlaybackDetectedElapsedMs + 900
                        : 0
                )
            ),
            CONVERSATION_INTERCEPT_RUNTIME_MONITOR_MIN_MS,
            CONVERSATION_INTERCEPT_RUNTIME_MONITOR_MAX_MS
        );
        const transitionGraceMs = clamp(
            Math.round(
                Math.max(
                    CONVERSATION_INTERCEPT_TRANSITION_GRACE_MIN_MS,
                    aggressive ? 520 : 0,
                    answersPresent ? 900 : 0,
                    pauseSettleEstimateMs > 0
                        ? pauseSettleEstimateMs * 0.2
                        : 0,
                    statusProbeEstimateMs > 0
                        ? statusProbeEstimateMs * 0.15
                        : 0
                )
            ),
            CONVERSATION_INTERCEPT_TRANSITION_GRACE_MIN_MS,
            CONVERSATION_INTERCEPT_TRANSITION_GRACE_MAX_MS
        );

        return {
            aggressive,
            silenceMode: "fast-stop",
            manualOffsetMs,
            estimatedSpeechOnsetMs: predictedSpeechOnsetMs,
            primaryLeadReserveMs,
            primarySilenceDelayMs,
            suppressTransitionPrompt,
            guardDelaysMs,
            lateRecordFollowUpDelayMs,
            runtimeMonitorPollMs: aggressive
                ? CONVERSATION_INTERCEPT_RUNTIME_MONITOR_AGGRESSIVE_POLL_MS
                : CONVERSATION_INTERCEPT_RUNTIME_MONITOR_POLL_MS,
            runtimeMonitorDurationMs,
            transitionGraceMs,
        };
    }

    private computeConversationInterceptFallbackGuardDelaysMs(
        deviceId?: string,
        options?: {
            aggressive?: boolean;
            answersPresent?: boolean;
            lateRecordScore?: number;
            playbackReboundScore?: number;
            primarySilenceDelayMs?: number;
            manualOffsetMs?: number;
        }
    ) {
        const interceptProfile = this.readConversationInterceptLatencyProfile(deviceId);
        const speakerProfile = this.readSpeakerAudioLatencyProfile(deviceId);
        const interceptLeadMs =
            readNumber(interceptProfile?.interceptLeadEstimateMs) || 0;
        const statusProbeEstimateMs =
            readNumber(speakerProfile?.statusProbeEstimateMs) || 0;
        const pauseCommandEstimateMs =
            readNumber(speakerProfile?.pauseCommandEstimateMs) || 0;
        const pauseSettleEstimateMs =
            readNumber(speakerProfile?.pauseSettleEstimateMs) || 0;
        const primarySilenceDelayMs = clamp(
            Math.round(readNumber(options?.primarySilenceDelayMs) || 0),
            0,
            CONVERSATION_INTERCEPT_FALLBACK_GUARD_MAX_DELAY_MS
        );
        const manualOffsetMs = normalizeConversationInterceptManualOffsetMs(
            options?.manualOffsetMs
        );
        const urgencyBoost = Math.max(
            0,
            Math.round(
                (readNumber(options?.lateRecordScore) || 0) +
                    (readNumber(options?.playbackReboundScore) || 0)
            )
        );
        const delays = new Set<number>();
        if (options?.answersPresent && primarySilenceDelayMs <= 0) {
            delays.add(
                clamp(
                    Math.round(
                        Math.max(
                            240,
                            pauseCommandEstimateMs > 0
                                ? pauseCommandEstimateMs * 0.52
                                : 0,
                            statusProbeEstimateMs > 0
                                ? statusProbeEstimateMs * 0.26
                                : 0,
                            220 + urgencyBoost * 10
                        )
                    ),
                    220,
                    320
                )
            );
            delays.add(
                clamp(
                    Math.round(
                        Math.max(
                            520,
                            pauseSettleEstimateMs > 0
                                ? pauseSettleEstimateMs * 0.34
                                : 0,
                            statusProbeEstimateMs > 0
                                ? statusProbeEstimateMs * 0.62
                                : 0,
                            520 + urgencyBoost * 14
                        )
                    ),
                    420,
                    760
                )
            );
            return Array.from(delays)
                .map((value) =>
                    clamp(
                        value + manualOffsetMs,
                        0,
                        CONVERSATION_INTERCEPT_FALLBACK_GUARD_MAX_DELAY_MS
                    )
                )
                .filter((value) => Number.isFinite(value) && value >= 0)
                .sort((left, right) => left - right);
        }
        const firstGuardMaxDelayMs = Math.max(
            620,
            Math.min(
                CONVERSATION_INTERCEPT_FALLBACK_GUARD_MAX_DELAY_MS,
                primarySilenceDelayMs > 0
                    ? primarySilenceDelayMs + 320
                    : 620
            )
        );
        const firstGuardDelayMs = clamp(
            Math.round(
                Math.max(
                    primarySilenceDelayMs + 180,
                    interceptLeadMs > 0
                        ? interceptLeadMs +
                            Math.max(120, Math.round(pauseCommandEstimateMs * 0.32))
                        : 0,
                    statusProbeEstimateMs > 0 ? statusProbeEstimateMs * 0.5 : 0,
                    options?.answersPresent ? 260 : 0,
                    options?.aggressive ? 320 : 260,
                    240 + urgencyBoost * 14
                )
            ),
            primarySilenceDelayMs > 0 ? primarySilenceDelayMs + 120 : 220,
            firstGuardMaxDelayMs
        );
        delays.add(firstGuardDelayMs);
        const secondGuardMaxDelayMs = Math.max(
            900,
            Math.min(
                CONVERSATION_INTERCEPT_FALLBACK_GUARD_MAX_DELAY_MS,
                primarySilenceDelayMs > 0
                    ? primarySilenceDelayMs + 620
                    : CONVERSATION_INTERCEPT_FALLBACK_GUARD_MAX_DELAY_MS
            )
        );
        const secondGuardDelayMs = clamp(
            Math.round(
                Math.max(
                    firstGuardDelayMs + 220,
                    primarySilenceDelayMs +
                        Math.max(
                            420,
                            pauseSettleEstimateMs > 0
                                ? Math.round(pauseSettleEstimateMs * 0.4)
                                : 0
                        ),
                    interceptLeadMs > 0 ? interceptLeadMs + 360 : 0,
                    statusProbeEstimateMs > 0 ? statusProbeEstimateMs * 0.9 : 0,
                    520 + urgencyBoost * 18
                )
            ),
            primarySilenceDelayMs > 0 ? primarySilenceDelayMs + 320 : 420,
            secondGuardMaxDelayMs
        );
        delays.add(secondGuardDelayMs);
        return Array.from(delays)
            .map((value) =>
                clamp(
                    value + manualOffsetMs,
                    0,
                    CONVERSATION_INTERCEPT_FALLBACK_GUARD_MAX_DELAY_MS
                )
            )
            .filter((value) => Number.isFinite(value) && value >= 0)
            .sort((left, right) => left - right);
    }

    private claimConversationSupplementalIntervention(
        state?: ConversationInterceptSupplementalGuardState,
        nowMs = Date.now()
    ) {
        if (!state) {
            return {
                ok: true,
            };
        }
        if (state.attemptsUsed >= CONVERSATION_INTERCEPT_MAX_SUPPLEMENTAL_ATTEMPTS) {
            return {
                ok: false,
                reason: "budget_exhausted",
            };
        }
        if (
            state.lastAttemptAtMs > 0 &&
            nowMs - state.lastAttemptAtMs <
                CONVERSATION_INTERCEPT_SUPPLEMENTAL_MIN_SPACING_MS
        ) {
            return {
                ok: false,
                reason: "spacing_guard",
            };
        }
        state.attemptsUsed += 1;
        state.lastAttemptAtMs = nowMs;
        return {
            ok: true,
        };
    }

    private async runConversationInterceptFallbackPauseGuard(
        interceptStartedAtMs?: number,
        actionContextPromise?: Promise<ActionContext>,
        plan?: ConversationInterceptGuardPlan,
        guardState?: ConversationInterceptSupplementalGuardState
    ) {
        const { device, mina, miio } = actionContextPromise
            ? await actionContextPromise
            : await this.ensureActionContext();
        const delaysMs =
            Array.isArray(plan?.guardDelaysMs) && plan.guardDelaysMs.length > 0
                ? plan.guardDelaysMs
                : this.computeConversationInterceptFallbackGuardDelaysMs(
                    device.minaDeviceId
                );
        const startedAtMs =
            typeof interceptStartedAtMs === "number" &&
            Number.isFinite(interceptStartedAtMs)
                ? interceptStartedAtMs
                : Date.now();
        const attempts: Array<Record<string, any>> = [];

        for (const targetDelayMs of delaysMs) {
            const waitMs = startedAtMs + targetDelayMs - Date.now();
            if (waitMs > 0) {
                await sleep(waitMs);
            }
            if (!this.waitingForResponse) {
                attempts.push({
                    delayMs: targetDelayMs,
                    skipped: "waiting_for_response_cleared",
                });
                break;
            }
            const claim = this.claimConversationSupplementalIntervention(guardState);
            if (!claim.ok) {
                attempts.push({
                    delayMs: targetDelayMs,
                    skipped: claim.reason,
                });
                if (claim.reason === "budget_exhausted") {
                    break;
                }
                continue;
            }

            let ok = false;
            let errorMessage = "";
            let action = "pause";
            try {
                await this.sendPauseCommand(device, mina, miio, {
                    singleAttempt: true,
                });
                ok = true;
            } catch (error) {
                errorMessage = this.errorMessage(error);
            }
            attempts.push({
                delayMs: targetDelayMs,
                action,
                ok,
                error: errorMessage || undefined,
            });
        }

        await this.appendDebugTrace("conversation_intercept_fallback_pause_guard", {
            deviceId: device.minaDeviceId,
            startedAtMs,
            delaysMs,
            primarySilenceDelayMs: readNumber(plan?.primarySilenceDelayMs) || 0,
            aggressive: plan?.aggressive === true,
            attempts,
        });
    }

    private async runConversationInterceptLateRecordFollowUpBurst(
        interceptStartedAtMs: number,
        actionContextPromise?: Promise<ActionContext>,
        plan?: ConversationInterceptGuardPlan,
        guardState?: ConversationInterceptSupplementalGuardState
    ) {
        if (!plan?.aggressive || (readNumber(plan.primarySilenceDelayMs) || 0) > 0) {
            return;
        }
        const { device, mina, miio } = actionContextPromise
            ? await actionContextPromise
            : await this.ensureActionContext();
        const targetDelayMs = clamp(
            Math.round(readNumber(plan.lateRecordFollowUpDelayMs) || 0),
            0,
            420
        );
        const waitMs = interceptStartedAtMs + targetDelayMs - Date.now();
        if (waitMs > 0) {
            await sleep(waitMs);
        }
        if (!this.waitingForResponse) {
            await this.appendDebugTrace("conversation_intercept_late_record_followup_burst", {
                deviceId: device.minaDeviceId,
                startedAtMs: interceptStartedAtMs,
                delayMs: targetDelayMs,
                skipped: "waiting_for_response_cleared",
            });
            return;
        }
        const claim = this.claimConversationSupplementalIntervention(guardState);
        if (!claim.ok) {
            await this.appendDebugTrace("conversation_intercept_late_record_followup_burst", {
                deviceId: device.minaDeviceId,
                startedAtMs: interceptStartedAtMs,
                delayMs: targetDelayMs,
                skipped: claim.reason,
            });
            return;
        }
        let accepted = false;
        let acceptedCount = 0;
        let attemptedCount = 0;
        let errorMessage = "";
        try {
            const burst = await this.dispatchSpeakerInterruptBurst(device, mina, miio);
            accepted = burst.accepted;
            acceptedCount = burst.acceptedCount;
            attemptedCount = burst.attemptedCount;
        } catch (error) {
            errorMessage = this.errorMessage(error);
        }
        await this.appendDebugTrace("conversation_intercept_late_record_followup_burst", {
            deviceId: device.minaDeviceId,
            startedAtMs: interceptStartedAtMs,
            delayMs: targetDelayMs,
            accepted,
            acceptedCount: acceptedCount || undefined,
            attemptedCount: attemptedCount || undefined,
            error: errorMessage || undefined,
        });
    }

    private async runConversationInterceptRuntimeMonitor(
        interceptStartedAtMs: number,
        plan: ConversationInterceptGuardPlan,
        actionContextPromise?: Promise<ActionContext>,
        guardState?: ConversationInterceptSupplementalGuardState
    ) {
        const { device, mina, miio } = actionContextPromise
            ? await actionContextPromise
            : await this.ensureActionContext();
        const deadlineAtMs =
            interceptStartedAtMs + plan.runtimeMonitorDurationMs;
        const samples: Record<string, any>[] = [];
        let baselineSnapshot =
            (await this.readSpeakerPlaybackSnapshotWithTiming(
                mina,
                device.minaDeviceId
            ).catch(() => null)) || null;
        let previousSnapshot = baselineSnapshot;
        let detectedPlayback = false;
        let interventionCount = 0;
        let lastInterventionAtMs = 0;

        while (Date.now() < deadlineAtMs) {
            if (!this.waitingForResponse) {
                samples.push({
                    elapsedMs: Math.max(0, Date.now() - interceptStartedAtMs),
                    skipped: "waiting_for_response_cleared",
                });
                break;
            }
            if (samples.length > 0) {
                await sleep(plan.runtimeMonitorPollMs);
            }
            if (!this.waitingForResponse) {
                samples.push({
                    elapsedMs: Math.max(0, Date.now() - interceptStartedAtMs),
                    skipped: "waiting_for_response_cleared",
                });
                break;
            }

            const snapshot =
                (await this.readSpeakerPlaybackSnapshotWithTiming(
                    mina,
                    device.minaDeviceId
                ).catch(() => null)) || null;
            const elapsedMs = Math.max(0, Date.now() - interceptStartedAtMs);
            const reason =
                this.detectConversationInterceptCalibrationPlaybackReason(
                    baselineSnapshot,
                    previousSnapshot,
                    snapshot
                );
            const active = this.isSpeakerPlaybackActivelyPlaying(snapshot);

            if (samples.length < CONVERSATION_INTERCEPT_CALIBRATION_DEBUG_SAMPLE_LIMIT) {
                samples.push({
                    elapsedMs,
                    active,
                    reason: reason || "",
                    snapshot: this.summarizeSpeakerPlaybackSnapshot(snapshot),
                });
            }

            previousSnapshot = snapshot;
            if (!active && !reason) {
                continue;
            }

            detectedPlayback = true;
            this.noteConversationInterceptPlaybackRebound(
                device.minaDeviceId,
                true,
                elapsedMs
            );
            if (!this.waitingForResponse) {
                break;
            }
            if (
                interventionCount >= CONVERSATION_INTERCEPT_RUNTIME_MAX_INTERVENTIONS ||
                Date.now() - lastInterventionAtMs < 120
            ) {
                continue;
            }
            const claim = this.claimConversationSupplementalIntervention(guardState);
            if (!claim.ok) {
                if (samples.length < CONVERSATION_INTERCEPT_CALIBRATION_DEBUG_SAMPLE_LIMIT) {
                    samples.push({
                        elapsedMs: Math.max(0, Date.now() - interceptStartedAtMs),
                        interventionSkipped: claim.reason,
                    });
                }
                if (claim.reason === "budget_exhausted") {
                    break;
                }
                continue;
            }

            let fastStopped = false;
            let pauseAccepted = false;
            let errorMessage = "";
            try {
                fastStopped = await this.stopSpeaker({
                    fast: true,
                    preserveLoopGuard: false,
                });
                if (!fastStopped && this.waitingForResponse) {
                    await this.sendPauseCommand(device, mina, miio, {
                        singleAttempt: true,
                    });
                    pauseAccepted = true;
                }
            } catch (error) {
                errorMessage = this.errorMessage(error);
            }
            interventionCount += 1;
            lastInterventionAtMs = Date.now();
            baselineSnapshot = snapshot;
            if (samples.length < CONVERSATION_INTERCEPT_CALIBRATION_DEBUG_SAMPLE_LIMIT) {
                samples.push({
                    elapsedMs: Math.max(0, Date.now() - interceptStartedAtMs),
                    intervention: true,
                    fastStopped,
                    pauseAccepted,
                    error: errorMessage || undefined,
                });
            }
        }

        if (!detectedPlayback) {
            this.noteConversationInterceptPlaybackRebound(
                device.minaDeviceId,
                false
            );
        }

        await this.appendDebugTrace("conversation_intercept_runtime_monitor", {
            deviceId: device.minaDeviceId,
            startedAtMs: interceptStartedAtMs,
            aggressive: plan.aggressive,
            manualOffsetMs: plan.manualOffsetMs,
            estimatedSpeechOnsetMs: plan.estimatedSpeechOnsetMs,
            primaryLeadReserveMs: plan.primaryLeadReserveMs,
            primarySilenceDelayMs: plan.primarySilenceDelayMs,
            runtimeMonitorPollMs: plan.runtimeMonitorPollMs,
            runtimeMonitorDurationMs: plan.runtimeMonitorDurationMs,
            detectedPlayback,
            interventionCount,
            samples,
        });
    }

    private async maybeSendConversationTransitionPrompt(
        interceptStartedAtMs: number,
        plan: ConversationInterceptGuardPlan,
        actionContextPromise?: Promise<ActionContext>
    ) {
        if (plan.suppressTransitionPrompt) {
            await this.appendDebugTrace("conversation_transition_prompt_skipped", {
                reason: "suppressed_by_plan",
                aggressive: plan.aggressive,
                transitionGraceMs: plan.transitionGraceMs,
            });
            return;
        }

        const waitMs = interceptStartedAtMs + plan.transitionGraceMs - Date.now();
        if (waitMs > 0) {
            await sleep(waitMs);
        }
        if (!this.waitingForResponse) {
            return;
        }

        const { device, mina } = actionContextPromise
            ? await actionContextPromise
            : await this.ensureActionContext();
        const settled = await this.verifySpeakerCommandState(
            mina,
            device.minaDeviceId,
            (snapshot) => this.isSpeakerPlaybackPausedOrStopped(snapshot),
            plan.aggressive
                ? [0, ...SPEAKER_COMMAND_FAST_VERIFY_DELAYS_MS, 220]
                : [0, ...SPEAKER_COMMAND_FAST_VERIFY_DELAYS_MS]
        );
        if (!this.waitingForResponse) {
            return;
        }
        if (!settled.ok) {
            await this.appendDebugTrace("conversation_transition_prompt_skipped", {
                reason: "speaker_not_quiet",
                aggressive: plan.aggressive,
                transitionGraceMs: plan.transitionGraceMs,
                snapshot: this.summarizeSpeakerPlaybackSnapshot(settled.snapshot),
            });
            return;
        }

        await this.sendTransitionPrompt();
    }

    private evaluateLateRecordForwarding(
        deviceId?: string,
        hint?: ConversationInterceptHint,
        plan?: ConversationInterceptGuardPlan
    ) {
        const normalizedDeviceId = readString(deviceId);
        const answersPresent = Boolean(hint?.answersPresent);
        const recordAgeMs = readNumber(hint?.recordAgeMs) || 0;
        if (!answersPresent || recordAgeMs <= 0) {
            return {
                skip: false,
                cutoffMs: 0,
                deferUntilSilenced: false,
            };
        }
        const summary =
            normalizedDeviceId &&
            this.lastConversationInterceptCalibration &&
            readString(this.lastConversationInterceptCalibration.deviceId) ===
                normalizedDeviceId
                ? this.lastConversationInterceptCalibration
                : undefined;
        const strategy =
            summary?.strategy ||
            this.classifyConversationInterceptCalibrationStrategy(summary);
        const speakerProfile = this.readSpeakerAudioLatencyProfile(deviceId);
        const runtimeState = this.readConversationInterceptRuntimeState(deviceId);
        const pauseCommandEstimateMs =
            readNumber(speakerProfile?.pauseCommandEstimateMs) || 0;
        const stopSettleEstimateMs =
            readNumber(speakerProfile?.stopSettleEstimateMs) || 0;
        const statusProbeEstimateMs =
            readNumber(speakerProfile?.statusProbeEstimateMs) || 0;
        const lateRecordScore = readNumber(runtimeState?.lateRecordScore) || 0;
        const playbackReboundScore =
            readNumber(runtimeState?.playbackReboundScore) || 0;
        let cutoffMs = clamp(
            Math.round(
                Math.max(
                    520,
                    (readNumber(plan?.estimatedSpeechOnsetMs) || 0) +
                        Math.max(
                            180,
                            pauseCommandEstimateMs > 0
                                ? pauseCommandEstimateMs * 0.72
                                : 0,
                            stopSettleEstimateMs > 0
                                ? stopSettleEstimateMs * 0.28
                                : 0,
                            statusProbeEstimateMs > 0
                                ? statusProbeEstimateMs * 0.18
                                : 0
                        )
                )
            ),
            520,
            2_400
        );
        if (lateRecordScore >= 2 || playbackReboundScore >= 2) {
            cutoffMs = Math.max(420, cutoffMs - 120);
        }
        const deferUntilSilenced =
            strategy === "fallback-only" || recordAgeMs >= cutoffMs;
        if (!deferUntilSilenced) {
            return {
                skip: false,
                cutoffMs,
                deferUntilSilenced: false,
            };
        }
        return {
            skip: false,
            cutoffMs,
            deferUntilSilenced: true,
            reason:
                strategy === "fallback-only"
                    ? "当前设备/网络画像通常只能拿到晚记录，本轮会先立即强拦截，确认静音后马上转发 OpenClaw 播报"
                    : `检测到会话记录已晚到 ${recordAgeMs}ms，本轮会先立即强拦截，确认静音后马上转发 OpenClaw 播报`,
        };
    }

    private shouldIgnoreStartupStaleConversationRecord(
        recordAgeMs: number,
        answersPresent: boolean
    ) {
        if (!answersPresent || recordAgeMs <= CONVERSATION_STARTUP_STALE_RECORD_IGNORE_MS) {
            return false;
        }
        if (this.pollingStartedAt <= 0) {
            return false;
        }
        return Date.now() - this.pollingStartedAt <= STARTUP_POLL_GRACE_MS;
    }

    private async confirmLateRecordForwardAllowed(
        actionContextPromise?: Promise<ActionContext>,
        plan?: ConversationInterceptGuardPlan
    ) {
        const startedAtMs = Date.now();
        const { device, mina } = actionContextPromise
            ? await actionContextPromise
            : await this.ensureActionContext();
        const settled = await this.verifySpeakerCommandState(
            mina,
            device.minaDeviceId,
            (snapshot) => this.isSpeakerPlaybackPausedOrStopped(snapshot),
            CONVERSATION_INTERCEPT_LATE_RECORD_FORWARD_GATE_DELAYS_MS
        );
        await this.appendDebugTrace("conversation_intercept_late_record_forward_gate", {
            deviceId: device.minaDeviceId,
            ok: settled.ok,
            elapsedMs: Math.max(0, Date.now() - startedAtMs),
            manualOffsetMs: readNumber(plan?.manualOffsetMs) || 0,
            snapshot: this.summarizeSpeakerPlaybackSnapshot(settled.snapshot),
        });
        return settled.ok;
    }

    private async runConversationInterceptCalibrationPauseGuard(
        actionContext: ActionContext,
        interceptStartedAtMs?: number,
        cancelState?: { cancelled?: boolean }
    ) {
        const { device, mina, miio } = actionContext;
        const delaysMs =
            this.computeConversationInterceptFallbackGuardDelaysMs(
                device.minaDeviceId
            );
        const startedAtMs =
            typeof interceptStartedAtMs === "number" &&
            Number.isFinite(interceptStartedAtMs)
                ? interceptStartedAtMs
                : Date.now();
        const attempts: Array<Record<string, any>> = [];

        for (const targetDelayMs of delaysMs) {
            const waitMs = startedAtMs + targetDelayMs - Date.now();
            if (waitMs > 0) {
                await sleep(waitMs);
            }
            if (cancelState?.cancelled) {
                attempts.push({
                    delayMs: targetDelayMs,
                    skipped: "cancelled",
                });
                break;
            }

            let ok = false;
            let errorMessage = "";
            let action = "pause";
            try {
                await this.sendPauseCommand(device, mina, miio, {
                    singleAttempt: true,
                });
                ok = true;
            } catch (error) {
                errorMessage = this.errorMessage(error);
            }
            attempts.push({
                delayMs: targetDelayMs,
                action,
                ok,
                error: errorMessage || undefined,
            });
        }

        await this.appendDebugTrace(
            "conversation_intercept_calibration_pause_guard",
            {
                deviceId: device.minaDeviceId,
                startedAtMs,
                delaysMs,
                attempts,
            }
        );
    }

    private recommendConversationPollIntervalMs(
        deviceId?: string,
        currentPollIntervalMs?: number
    ) {
        const currentPoll = normalizePollIntervalMs(
            currentPollIntervalMs,
            DEFAULT_POLL_INTERVAL_MS
        );
        const interceptProfile = this.readConversationInterceptLatencyProfile(deviceId);
        const interceptLeadMs = readNumber(interceptProfile?.interceptLeadEstimateMs) || 0;
        const speakerProfile = this.readSpeakerAudioLatencyProfile(deviceId);
        const pauseSettleEstimateMs =
            readNumber(speakerProfile?.pauseSettleEstimateMs) ||
            readNumber(speakerProfile?.stopSettleEstimateMs) ||
            0;
        const statusProbeEstimateMs =
            readNumber(speakerProfile?.statusProbeEstimateMs) || 0;
        if (interceptLeadMs <= 0) {
            return currentPoll;
        }
        const commandSafetyMs = Math.max(
            120,
            Math.round(statusProbeEstimateMs * 0.45),
            Math.round(pauseSettleEstimateMs * 0.25)
        );
        const remainingBudgetMs = Math.max(
            0,
            interceptLeadMs - commandSafetyMs
        );
        const suggested = clamp(
            Math.round(Math.max(MIN_POLL_INTERVAL_MS, remainingBudgetMs * 0.6)),
            MIN_POLL_INTERVAL_MS,
            currentPoll
        );
        return Math.min(currentPoll, suggested);
    }

    private computeDynamicExternalAudioLoopGuardBaseLeadMs(deviceId?: string) {
        const profile = this.readSpeakerAudioLatencyProfile(deviceId);
        const statusProbeEstimateMs = readNumber(profile?.statusProbeEstimateMs) || 0;
        const pauseSettleEstimateMs = readNumber(profile?.pauseSettleEstimateMs) || 0;
        const stopSettleEstimateMs = readNumber(profile?.stopSettleEstimateMs) || 0;
        const playbackDetectEstimateMs = readNumber(profile?.playbackDetectEstimateMs) || 0;
        const commandSettleEstimateMs = Math.max(
            pauseSettleEstimateMs,
            stopSettleEstimateMs
        );
        const leadMs = Math.max(
            EXTERNAL_AUDIO_LOOP_GUARD_DEADLINE_LEAD_MS,
            commandSettleEstimateMs + statusProbeEstimateMs + 120,
            Math.round(playbackDetectEstimateMs * 0.6) + statusProbeEstimateMs + 120
        );
        return clamp(leadMs, EXTERNAL_AUDIO_LOOP_GUARD_DEADLINE_LEAD_MS, 1800);
    }

    private async readSpeakerPlaybackSnapshotWithTiming(
        mina: MiNAClient,
        deviceId: string
    ) {
        const startedAtMs = Date.now();
        const snapshot = this.readSpeakerPlaybackSnapshot(
            await mina.playerGetStatus(deviceId).catch(() => undefined)
        );
        this.updateSpeakerAudioLatencyEstimate(
            deviceId,
            "statusProbeEstimateMs",
            Date.now() - startedAtMs
        );
        return snapshot;
    }

    private computeExternalAudioLoopGuardLeadMs(
        deviceId?: string,
        entry?: AudioRelayEntry
    ) {
        const dynamicBaseLeadMs = this.computeDynamicExternalAudioLoopGuardBaseLeadMs(deviceId);
        const tailPaddingMs = readNumber(entry?.tailPaddingMs);
        if (typeof tailPaddingMs === "number" && tailPaddingMs > 0) {
            return {
                tailPaddingMs,
                deadlineLeadMs: Math.max(
                    dynamicBaseLeadMs,
                    Math.max(
                        0,
                        tailPaddingMs - EXTERNAL_AUDIO_LOOP_GUARD_TAIL_PADDING_RESERVE_MS
                    )
                ),
            };
        }
        return {
            tailPaddingMs: undefined,
            deadlineLeadMs: dynamicBaseLeadMs,
        };
    }

    private computeRelayHitAnchoredExternalAudioDeadlineAtMs(
        deviceId?: string,
        entry?: AudioRelayEntry,
        relayHitAtMs?: number
    ) {
        const anchoredAtMs = readNumber(relayHitAtMs);
        const durationMs = readNumber(entry?.durationMs);
        if (
            typeof anchoredAtMs !== "number" ||
            typeof durationMs !== "number" ||
            durationMs <= 0
        ) {
            return undefined;
        }

        const { deadlineLeadMs } = this.computeExternalAudioLoopGuardLeadMs(deviceId, entry);
        return anchoredAtMs + Math.max(0, durationMs - deadlineLeadMs);
    }

    private isHostedBufferedRelayEntry(entry: AudioRelayEntry | undefined) {
        if (!entry || entry.sourceUrl) {
            return false;
        }
        return Buffer.isBuffer(entry.buffer) || Boolean(entry.filePath) || Boolean(entry.sourceLabel);
    }

    private shouldPreferRelayAudioUrl(url: string) {
        if (shouldPreferRelayForMediaUrl(url)) {
            return true;
        }
        const extension = readAudioSourceExtension(url);
        if (extension && !isLikelyDirectPlayableAudioExtension(extension)) {
            return true;
        }
        try {
            const parsed = new URL(url);
            if (parsed.protocol === "https:" && looksLikeIpHostname(parsed.hostname)) {
                return true;
            }
            return false;
        } catch {
            return false;
        }
    }

    private shouldPreferStructuredMusic(url: string) {
        if (this.isHostedAudioRelayUrl(url)) {
            return true;
        }
        return false;
    }

    private shouldPreferMp3Relay(url: string) {
        const extension = readAudioSourceExtension(url);
        if (!extension) {
            return false;
        }
        if (MP3_TRANSCODE_PREFERRED_EXTENSIONS.has(extension)) {
            return true;
        }
        if (!MP3_TRANSCODE_OPTIONAL_EXTENSIONS.has(extension)) {
            return false;
        }
        return true;
    }

    private async collectLocalAudioSourceCandidates(sourceUrl: string) {
        const normalizedSourceUrl = normalizeRemoteMediaUrl(sourceUrl);
        if (!normalizedSourceUrl) {
            return [];
        }

        let parsed: URL;
        try {
            parsed = new URL(normalizedSourceUrl);
        } catch {
            return [normalizedSourceUrl];
        }

        const hostname = parsed.hostname.trim().toLowerCase();
        if (!hostname || isLoopbackHostname(hostname) || isPrivateHostname(hostname)) {
            return [normalizedSourceUrl];
        }

        const config = this.config || (await this.loadConfig(false).catch(() => undefined));
        const knownSelfHosts = new Set<string>();
        const addKnownHost = (value: string | undefined) => {
            const normalized = normalizeBaseUrl(value);
            if (!normalized) {
                return;
            }
            try {
                knownSelfHosts.add(new URL(normalized).hostname.trim().toLowerCase());
            } catch {
                // Ignore malformed base URLs here and keep collecting others.
            }
        };

        addKnownHost(config?.audioPublicBaseUrl);
        addKnownHost(config?.publicBaseUrl);
        for (const gatewayBase of await discoverGatewayBaseUrls(this.api).catch(() => [])) {
            addKnownHost(gatewayBase);
        }
        for (const localLanAddress of readLocalLanIpv4Addresses()) {
            knownSelfHosts.add(localLanAddress.trim().toLowerCase());
        }

        if (!knownSelfHosts.has(hostname)) {
            return [normalizedSourceUrl];
        }

        const candidates: string[] = [];
        const addCandidate = (value: string | undefined) => {
            const normalized = normalizeRemoteMediaUrl(value);
            if (normalized) {
                candidates.push(normalized);
            }
        };
        const addLoopbackCandidate = (
            loopbackHostname: string,
            options?: { protocol?: "http:" | "https:"; clearPort?: boolean }
        ) => {
            try {
                const candidate = new URL(parsed.toString());
                candidate.hostname = loopbackHostname;
                if (options?.protocol) {
                    candidate.protocol = options.protocol;
                }
                if (options?.clearPort) {
                    candidate.port = "";
                }
                addCandidate(candidate.toString());
            } catch {
                // Ignore invalid loopback rewrites and keep collecting others.
            }
        };

        if (parsed.protocol === "https:") {
            const clearPort = !parsed.port || parsed.port === "443";
            addLoopbackCandidate("127.0.0.1", {
                protocol: "http:",
                clearPort,
            });
            addLoopbackCandidate("localhost", {
                protocol: "http:",
                clearPort,
            });
        } else {
            addLoopbackCandidate("127.0.0.1");
            addLoopbackCandidate("localhost");
        }

        addCandidate(normalizedSourceUrl);
        return uniqueStrings(candidates);
    }

    private async resolveLocalAudioSourceUrl(sourceUrl: string) {
        const candidates = await this.collectLocalAudioSourceCandidates(sourceUrl);
        return candidates[0] || sourceUrl;
    }

    private async probeFfmpegAvailability() {
        const nowMs = Date.now();
        if (
            typeof this.ffmpegAvailable === "boolean" &&
            nowMs < this.ffmpegAvailabilityExpiresAt
        ) {
            return this.ffmpegAvailable;
        }
        if (this.ffmpegAvailabilityProbe) {
            return this.ffmpegAvailabilityProbe;
        }
        this.ffmpegAvailabilityProbe = new Promise<boolean>((resolve) => {
            execFile("ffmpeg", ["-version"], (error) => {
                const available = !error;
                this.ffmpegAvailable = available;
                this.ffmpegAvailabilityExpiresAt = Date.now() + FFPROBE_CACHE_TTL_MS;
                this.ffmpegAvailabilityProbe = undefined;
                resolve(available);
            });
        });
        return this.ffmpegAvailabilityProbe;
    }

    private ffmpegInputFormatForAudioExtension(extension?: string) {
        const normalized = readString(extension)?.trim().toLowerCase();
        switch (normalized) {
            case ".mp3":
                return "mp3";
            case ".wav":
                return "wav";
            case ".ogg":
            case ".opus":
            case ".oga":
                return "ogg";
            case ".m4a":
            case ".mp4":
                return "mp4";
            case ".aac":
                return "aac";
            case ".flac":
                return "flac";
            default:
                return undefined;
        }
    }

    private async transcodeRemoteAudioToMp3BufferOnce(
        sourceUrl: string,
        tailPaddingMs = this.getAudioRelayTailPaddingMs()
    ) {
        const ffmpegAvailable = await this.probeFfmpegAvailability();
        if (!ffmpegAvailable) {
            throw new Error("本机缺少 ffmpeg，无法先在本地标准化音频。");
        }

        const process = spawn(
            "ffmpeg",
            [
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                sourceUrl,
                "-vn",
                "-sn",
                "-dn",
                "-af",
                `apad=pad_dur=${(tailPaddingMs / 1000).toFixed(3)}`,
                "-f",
                "mp3",
                "-codec:a",
                "libmp3lame",
                "-b:a",
                "128k",
                "pipe:1",
            ],
            {
                stdio: ["ignore", "pipe", "pipe"],
            }
        );

        const chunks: Buffer[] = [];
        let totalBytes = 0;
        let stderr = "";
        const timeout = setTimeout(() => {
            if (!process.killed) {
                process.kill("SIGKILL");
            }
        }, AUDIO_STANDARDIZE_TIMEOUT_MS);

        return await new Promise<Buffer>((resolve, reject) => {
            const fail = (message: string) => {
                clearTimeout(timeout);
                if (!process.killed) {
                    process.kill("SIGKILL");
                }
                reject(new Error(message));
            };

            process.on("error", (error) => {
                fail(`本地标准化音频失败: ${this.errorMessage(error)}`);
            });

            process.stderr.on("data", (chunk) => {
                stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
                if (stderr.length > 2000) {
                    stderr = stderr.slice(-2000);
                }
            });

            process.stdout.on("data", (chunk) => {
                const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                totalBytes += nextChunk.length;
                if (totalBytes > AUDIO_RELAY_MAX_BYTES) {
                    fail("本地标准化音频失败：转码后的音频体积过大。");
                    return;
                }
                chunks.push(nextChunk);
            });

            process.on("close", (code, signal) => {
                clearTimeout(timeout);
                if (signal === "SIGKILL") {
                    reject(new Error("本地标准化音频失败：ffmpeg 超时或被中止。"));
                    return;
                }
                if (code !== 0) {
                    reject(
                        new Error(
                            [
                                "本地标准化音频失败",
                                `ffmpeg exited with code ${code ?? -1}`,
                                stderr ? stderr.replace(/\s+/g, " ").trim() : undefined,
                            ]
                                .filter(Boolean)
                                .join(": ")
                        )
                    );
                    return;
                }
                const buffer = Buffer.concat(chunks);
                if (buffer.length === 0) {
                    reject(new Error("本地标准化音频失败：ffmpeg 没有输出任何音频数据。"));
                    return;
                }
                resolve(buffer);
            });
        });
    }

    private async transcodeRemoteAudioToMp3Buffer(
        sourceUrl: string,
        tailPaddingMs = this.getAudioRelayTailPaddingMs()
    ) {
        const candidates = await this.collectLocalAudioSourceCandidates(sourceUrl);
        const failures: string[] = [];

        for (const candidateUrl of candidates) {
            try {
                const buffer = await this.transcodeRemoteAudioToMp3BufferOnce(
                    candidateUrl,
                    tailPaddingMs
                );
                if (candidateUrl !== sourceUrl) {
                    void this.appendDebugTrace("audio_source_rewritten_for_local_fetch", {
                        sourceUrl,
                        candidateUrl,
                    });
                }
                return buffer;
            } catch (error) {
                failures.push(`${candidateUrl}: ${this.errorMessage(error)}`);
            }
        }

        throw new Error(
            failures.length > 0
                ? failures.join(" | ")
                : "本地标准化音频失败：没有可用的本地抓取地址。"
        );
    }

    private async transcodeBufferedAudioToMp3Buffer(
        sourceBuffer: Buffer,
        sourceExtension?: string,
        tailPaddingMs = this.getAudioRelayTailPaddingMs()
    ) {
        const ffmpegAvailable = await this.probeFfmpegAvailability();
        if (!ffmpegAvailable) {
            throw new Error("本机缺少 ffmpeg，无法先在本地标准化音频。");
        }
        if (!Buffer.isBuffer(sourceBuffer) || sourceBuffer.length === 0) {
            throw new Error("本地标准化音频失败：输入音频数据为空。");
        }

        const args = [
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
        ];
        const inputFormat = this.ffmpegInputFormatForAudioExtension(sourceExtension);
        if (inputFormat) {
            args.push("-f", inputFormat);
        }
        args.push(
            "-i",
            "pipe:0",
            "-vn",
            "-sn",
            "-dn",
            "-af",
            `apad=pad_dur=${(tailPaddingMs / 1000).toFixed(3)}`,
            "-f",
            "mp3",
            "-codec:a",
            "libmp3lame",
            "-b:a",
            "128k",
            "pipe:1"
        );

        const process = spawn("ffmpeg", args, {
            stdio: ["pipe", "pipe", "pipe"],
        });

        const chunks: Buffer[] = [];
        let totalBytes = 0;
        let stderr = "";
        const timeout = setTimeout(() => {
            if (!process.killed) {
                process.kill("SIGKILL");
            }
        }, AUDIO_STANDARDIZE_TIMEOUT_MS);

        return await new Promise<Buffer>((resolve, reject) => {
            const fail = (message: string) => {
                clearTimeout(timeout);
                if (!process.killed) {
                    process.kill("SIGKILL");
                }
                reject(new Error(message));
            };

            process.on("error", (error) => {
                fail(`本地标准化音频失败: ${this.errorMessage(error)}`);
            });

            process.stderr.on("data", (chunk) => {
                stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
                if (stderr.length > 2000) {
                    stderr = stderr.slice(-2000);
                }
            });

            process.stdout.on("data", (chunk) => {
                const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                totalBytes += nextChunk.length;
                if (totalBytes > AUDIO_RELAY_MAX_BYTES) {
                    fail("本地标准化音频失败：转码后的音频体积过大。");
                    return;
                }
                chunks.push(nextChunk);
            });

            process.on("close", (code, signal) => {
                clearTimeout(timeout);
                if (signal === "SIGKILL") {
                    reject(new Error("本地标准化音频失败：ffmpeg 超时或被中止。"));
                    return;
                }
                if (code !== 0) {
                    reject(
                        new Error(
                            [
                                "本地标准化音频失败",
                                `ffmpeg exited with code ${code ?? -1}`,
                                stderr ? stderr.replace(/\s+/g, " ").trim() : undefined,
                            ]
                                .filter(Boolean)
                                .join(": ")
                        )
                    );
                    return;
                }
                const buffer = Buffer.concat(chunks);
                if (buffer.length === 0) {
                    reject(new Error("本地标准化音频失败：ffmpeg 没有输出任何音频数据。"));
                    return;
                }
                resolve(buffer);
            });

            process.stdin.on("error", () => undefined);
            process.stdin.end(sourceBuffer);
        });
    }

    private async probeLocalAudioDurationMs(filePath?: string) {
        const targetPath = readString(filePath);
        if (!targetPath) {
            return undefined;
        }

        return await new Promise<number | undefined>((resolve) => {
            execFile(
                "ffprobe",
                [
                    "-v",
                    "error",
                    "-show_entries",
                    "format=duration",
                    "-of",
                    "default=noprint_wrappers=1:nokey=1",
                    targetPath,
                ],
                {
                    encoding: "utf8",
                    timeout: 8000,
                },
                (error, stdout) => {
                    if (error) {
                        resolve(undefined);
                        return;
                    }
                    const seconds = Number(String(stdout || "").trim());
                    if (!Number.isFinite(seconds) || seconds <= 0) {
                        resolve(undefined);
                        return;
                    }
                    resolve(Math.max(1, Math.round(seconds * 1000)));
                }
            );
        }).catch(() => undefined);
    }

    private readOpenclawRuntimeTtsBuffer(result: any) {
        if (Buffer.isBuffer(result?.audioBuffer)) {
            return result.audioBuffer;
        }
        if (result?.audioBuffer instanceof Uint8Array) {
            return Buffer.from(result.audioBuffer);
        }
        if (Buffer.isBuffer(result)) {
            return result;
        }
        if (result instanceof Uint8Array) {
            return Buffer.from(result);
        }
        return undefined;
    }

    private buildTtsBridgeCacheKey(text: string) {
        return createHash("sha1")
            .update(
                `${TTS_BRIDGE_CACHE_FORMAT_VERSION}\0${text.trim()}\0${this.getAudioRelayTailPaddingMs()}`,
                "utf8"
            )
            .digest("hex");
    }

    private async getTtsBridgeCacheDir() {
        const config = await this.loadConfig(false);
        const cacheDir = path.join(config.storageDir, "tts-cache");
        await mkdir(cacheDir, { recursive: true });
        return cacheDir;
    }

    private async pruneTtsBridgeCacheFiles(nowMs = Date.now()) {
        const cacheDir = await this.getTtsBridgeCacheDir().catch(() => undefined);
        if (!cacheDir) {
            return;
        }

        const retained: Array<{ filePath: string; mtimeMs: number }> = [];
        for (const name of await readdir(cacheDir).catch(() => [])) {
            const filePath = path.join(cacheDir, name);
            const stats = await stat(filePath).catch(() => undefined);
            if (!stats?.isFile()) {
                continue;
            }
            if (stats.mtimeMs + TTS_BRIDGE_CACHE_TTL_MS <= nowMs) {
                unlink(filePath).catch(() => undefined);
                continue;
            }
            retained.push({
                filePath,
                mtimeMs: stats.mtimeMs,
            });
        }

        const overflow = retained.length - MAX_TTS_BRIDGE_CACHE_FILES;
        if (overflow <= 0) {
            return;
        }

        for (const entry of retained
            .sort((left, right) => left.mtimeMs - right.mtimeMs)
            .slice(0, overflow)) {
            unlink(entry.filePath).catch(() => undefined);
        }
    }

    private async readTtsBridgeCachedAsset(cacheKey: string) {
        const cacheDir = await this.getTtsBridgeCacheDir().catch(() => undefined);
        if (!cacheDir) {
            return undefined;
        }

        const names = await readdir(cacheDir).catch(() => []);
        const fileName = names.find(
            (name) => path.basename(name, path.extname(name)) === cacheKey
        );
        if (!fileName) {
            return undefined;
        }

        const filePath = path.join(cacheDir, fileName);
        const stats = await stat(filePath).catch(() => undefined);
        if (!stats?.isFile()) {
            return undefined;
        }

        if (stats.mtimeMs + TTS_BRIDGE_CACHE_TTL_MS <= Date.now()) {
            unlink(filePath).catch(() => undefined);
            return undefined;
        }

        try {
            const audioBuffer = await readFile(filePath);
            if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
                unlink(filePath).catch(() => undefined);
                return undefined;
            }

            const touchAt = new Date();
            utimes(filePath, touchAt, touchAt).catch(() => undefined);

            return {
                audioBuffer,
                audioExtension:
                    this.normalizeOpenclawRuntimeAudioExtension(path.extname(fileName)) ||
                    ".mp3",
                cacheHit: true,
            } satisfies GeneratedAudioAsset;
        } catch {
            return undefined;
        }
    }

    private async persistTtsBridgeCachedAsset(
        cacheKey: string,
        extension: string,
        audioBuffer: Buffer
    ) {
        const cacheDir = await this.getTtsBridgeCacheDir();
        const normalizedExtension =
            this.normalizeOpenclawRuntimeAudioExtension(extension) || ".mp3";
        const fileName = `${cacheKey}${normalizedExtension}`;
        const filePath = path.join(cacheDir, fileName);
        const names = await readdir(cacheDir).catch(() => []);

        await Promise.all(
            names
                .filter(
                    (name) =>
                        path.basename(name, path.extname(name)) === cacheKey && name !== fileName
                )
                .map((name) => unlink(path.join(cacheDir, name)).catch(() => undefined))
        );

        await writeFile(filePath, audioBuffer);
        return filePath;
    }

    private isOpenclawRuntimeTtsSuccessResult(result: any) {
        return (
            Buffer.isBuffer(result) ||
            result instanceof Uint8Array ||
            result?.success === true
        );
    }

    private normalizeOpenclawRuntimeAudioExtension(value: string | undefined) {
        const rawValue = readString(value);
        const normalized = rawValue ? rawValue.trim().toLowerCase() : "";
        if (!normalized) {
            return undefined;
        }
        if (normalized.startsWith(".")) {
            return normalized;
        }
        switch (normalized) {
            case "mp3":
            case "mpeg":
            case "audio/mpeg":
                return ".mp3";
            case "wav":
            case "wave":
            case "audio/wav":
            case "audio/wave":
            case "audio/x-wav":
                return ".wav";
            case "ogg":
            case "opus":
            case "audio/ogg":
                return ".ogg";
            case "m4a":
            case "mp4":
            case "audio/mp4":
                return ".m4a";
            case "aac":
            case "audio/aac":
                return ".aac";
            case "flac":
            case "audio/flac":
                return ".flac";
            default:
                return /^[a-z0-9]+$/i.test(normalized) ? `.${normalized}` : undefined;
        }
    }

    private resolveOpenclawRuntimeTtsExtension(result: any, audioPath?: string) {
        return (
            this.normalizeOpenclawRuntimeAudioExtension(readString(result?.fileExtension)) ||
            this.normalizeOpenclawRuntimeAudioExtension(readString(result?.outputFormat)) ||
            this.normalizeOpenclawRuntimeAudioExtension(
                audioPath ? path.extname(audioPath).toLowerCase() : undefined
            ) ||
            ".mp3"
        );
    }

    private formatOpenclawRuntimeTtsFailure(result: any, fallbackMessage: string) {
        const error = readString(result?.error);
        const provider = readString(result?.provider);
        const attemptsSummary = Array.isArray(result?.attempts)
            ? result.attempts
                  .map((attempt: any) => {
                      const attemptProvider = readString(attempt?.provider);
                      const attemptReason = readString(attempt?.reasonCode);
                      const attemptError = readString(attempt?.error);
                      const attemptParts = [
                          attemptProvider,
                          attemptReason,
                          attemptError,
                      ].filter(Boolean);
                      return attemptParts.length > 0 ? attemptParts.join("/") : undefined;
                  })
                  .filter(Boolean)
                  .join("; ")
            : "";
        const reasonCodes = Array.isArray(result?.attempts)
            ? result.attempts
                  .map((attempt: any) => readString(attempt?.reasonCode))
                  .filter(Boolean)
            : [];

        const message =
            error ||
            (reasonCodes.includes("not_configured") ||
            reasonCodes.includes("no_provider_registered")
                ? "OpenClaw runtime TTS 尚未配置可用的语音提供方。"
                : "");

        return [
            message || fallbackMessage,
            provider ? `provider=${provider}` : undefined,
            attemptsSummary ? `attempts=${attemptsSummary}` : undefined,
        ]
            .filter(Boolean)
            .join(" | ");
    }

    private async readOpenclawRuntimeTtsFile(audioPath: string) {
        try {
            const buffer = await readFile(audioPath);
            if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
                throw new Error("OpenClaw runtime 生成的音频文件为空。");
            }
            return buffer;
        } catch (error) {
            throw new Error(
                `无法读取 OpenClaw runtime TTS 输出文件 (${audioPath}): ${this.errorMessage(error)}`
            );
        } finally {
            unlink(audioPath).catch(() => undefined);
        }
    }

    private async resolveOpenclawRuntimeTtsAudio(result: any, failureMessage: string) {
        let audioBuffer = this.readOpenclawRuntimeTtsBuffer(result);
        const audioPath = readString(result?.audioPath);

        if ((!audioBuffer || audioBuffer.length === 0) && audioPath) {
            audioBuffer = await this.readOpenclawRuntimeTtsFile(audioPath);
        }
        if (!audioBuffer || audioBuffer.length === 0) {
            throw new Error(
                this.formatOpenclawRuntimeTtsFailure(result, failureMessage)
            );
        }

        return {
            audioBuffer,
            audioExtension: this.resolveOpenclawRuntimeTtsExtension(result, audioPath),
        };
    }

    private async prepareSpeakerAudioSource(
        sourceUrl: string,
        options?: { title?: string }
    ): Promise<PreparedSpeakerAudioSource> {
        if (this.isHostedAudioRelayUrl(sourceUrl)) {
            const hostedRelayEntry = await this.ensureHostedAudioRelayEntry(sourceUrl);
            if (!hostedRelayEntry || hostedRelayEntry.expiresAtMs <= Date.now()) {
                await this.appendDebugTrace("audio_relay_unavailable", {
                    sourceUrl,
                    title: options?.title,
                    relayId: this.parseHostedAudioRelayId(sourceUrl),
                });
                throw new Error("音频 relay 已过期或不存在，请重新生成后再播放。");
            }
            return {
                playbackUrl: sourceUrl,
                standardized: false,
            };
        }

        const tailPaddingMs = this.getAudioRelayTailPaddingMs();
        try {
            const standardizedBuffer = await this.transcodeRemoteAudioToMp3Buffer(
                sourceUrl,
                tailPaddingMs
            );
            const relayUrls = await this.buildBufferedAudioRelayCandidateUrls(
                standardizedBuffer,
                {
                    extension: ".mp3",
                    contentType: "audio/mpeg",
                    sourceLabel: this.normalizeAudioReplyTitle(options?.title) || sourceUrl,
                    tailPaddingMs,
                }
            );
            if (relayUrls.length === 0) {
                throw new Error("没有可用的本地音频 relay 地址。");
            }
            return {
                playbackUrl: relayUrls[0],
                standardized: true,
            };
        } catch (error) {
            const message = this.errorMessage(error);
            await this.appendDebugTrace("audio_standardize_failed", {
                sourceUrl,
                title: options?.title,
                reason: message,
            });
            return {
                playbackUrl: sourceUrl,
                standardized: false,
                standardizationError: message,
            };
        }
    }

    private async generateOpenclawTtsAsset(text: string): Promise<GeneratedAudioAsset> {
        const ttsRuntime = this.api?.runtime?.tts as
            | {
                  textToSpeech?: (params: {
                      text: string;
                      cfg: any;
                  }) => Promise<any>;
                  synthesizeSpeech?: (params: {
                      text: string;
                      cfg: any;
                  }) => Promise<any>;
              }
            | undefined;
        const ttsMethods = [
            {
                name: "synthesizeSpeech",
                fn: ttsRuntime?.synthesizeSpeech,
            },
            {
                name: "textToSpeech",
                fn: ttsRuntime?.textToSpeech,
            },
        ].filter(
            (
                item
            ): item is {
                name: "synthesizeSpeech" | "textToSpeech";
                fn: (params: { text: string; cfg: any }) => Promise<any>;
            } => typeof item.fn === "function"
        );

        if (ttsMethods.length === 0) {
            throw new Error("当前 OpenClaw runtime 没有暴露官方 TTS 能力。");
        }

        let audioBuffer: Buffer | undefined;
        let audioExtension = ".mp3";
        const failures: string[] = [];

        for (const method of ttsMethods) {
            try {
                const result = await method.fn.call(ttsRuntime, {
                    text,
                    cfg: this.api?.config,
                });
                if (!this.isOpenclawRuntimeTtsSuccessResult(result)) {
                    throw new Error(
                        this.formatOpenclawRuntimeTtsFailure(
                            result,
                            `OpenClaw runtime TTS (${method.name}) 合成失败。`
                        )
                    );
                }
                const resolved = await this.resolveOpenclawRuntimeTtsAudio(
                    result,
                    `OpenClaw runtime TTS (${method.name}) 没有返回可播放的音频数据。`
                );
                audioBuffer = resolved.audioBuffer;
                audioExtension = resolved.audioExtension;
                try {
                    audioBuffer = await this.transcodeBufferedAudioToMp3Buffer(
                        resolved.audioBuffer,
                        resolved.audioExtension
                    );
                    audioExtension = ".mp3";
                } catch (error) {
                    failures.push(
                        `${method.name}: 尾部静音标准化失败: ${this.errorMessage(error)}`
                    );
                }
                break;
            } catch (error) {
                failures.push(`${method.name}: ${this.errorMessage(error)}`);
            }
        }

        if (!audioBuffer || audioBuffer.length === 0) {
            throw new Error(
                [
                    "OpenClaw runtime TTS 合成失败。",
                    failures.length > 0 ? failures.join(" | ") : undefined,
                ]
                    .filter(Boolean)
                    .join(" | ")
            );
        }

        return {
            audioBuffer,
            audioExtension,
            cacheHit: false,
        };
    }

    private async getOrCreateOpenclawTtsAsset(text: string) {
        const normalizedText = text.trim();
        const cacheKey = this.buildTtsBridgeCacheKey(normalizedText);
        const cached = await this.readTtsBridgeCachedAsset(cacheKey);
        if (cached) {
            void this.appendDebugTrace("tts_bridge_cache_hit", {
                cacheKey,
                extension: cached.audioExtension,
                bytes: cached.audioBuffer.length,
            });
            return cached;
        }

        let inflight = this.ttsBridgeInflightAssets.get(cacheKey);
        if (!inflight) {
            inflight = (async () => {
                await this.pruneTtsBridgeCacheFiles();

                const cachedAfterPrune = await this.readTtsBridgeCachedAsset(cacheKey);
                if (cachedAfterPrune) {
                    return cachedAfterPrune;
                }

                const generated = await this.generateOpenclawTtsAsset(normalizedText);
                await this.persistTtsBridgeCachedAsset(
                    cacheKey,
                    generated.audioExtension,
                    generated.audioBuffer
                );
                await this.pruneTtsBridgeCacheFiles();
                void this.appendDebugTrace("tts_bridge_cache_store", {
                    cacheKey,
                    extension: generated.audioExtension,
                    bytes: generated.audioBuffer.length,
                });
                return generated;
            })().finally(() => {
                this.ttsBridgeInflightAssets.delete(cacheKey);
            });
            this.ttsBridgeInflightAssets.set(cacheKey, inflight);
        }

        return inflight;
    }

    private async synthesizeOpenclawTtsToRelayUrl(
        text: string,
        options?: { title?: string }
    ) {
        const reachableBases = await this.computeSpeakerReachableAudioRelayBaseUrls();
        if (reachableBases.length === 0) {
            throw new Error(
                "当前没有可供音箱访问的音频入口。请配置 audioPublicBaseUrl，或让 OpenClaw 网关通过局域网地址可被音箱直接访问。"
            );
        }
        const generated = await this.getOrCreateOpenclawTtsAsset(text);
        const relayUrls = await this.buildBufferedAudioRelayCandidateUrls(generated.audioBuffer, {
            extension: generated.audioExtension,
            contentType: contentTypeForAudioExtension(generated.audioExtension),
            sourceLabel: this.normalizeAudioReplyTitle(options?.title) || text,
            tailPaddingMs: this.getAudioRelayTailPaddingMs(),
        });
        if (relayUrls.length === 0) {
            throw new Error("TTS 桥接失败：没有可用的本地音频 relay 地址。");
        }
        return relayUrls[0];
    }

    private async finalizeSpokenToolReply(
        text: string,
        options?: {
            consoleEventKind?: string;
            consoleEventTitle?: string;
            notificationLabel?: string;
        }
    ) {
        await this.playText(text);
        this.lastOpenclawSpeech = {
            text,
            timeMs: Date.now(),
        };
        this.lastOpenclawSpeakTime = Date.now() / 1000;
        this.armDialogWindow(this.lastOpenclawSpeakTime);
        this.recordVoiceContextTurn("assistant", text);
        this.recordConsoleEvent(
            options?.consoleEventKind || "tool.speak",
            options?.consoleEventTitle || "OpenClaw 让小爱播报",
            text,
            "success"
        );
        void this.sendOpenclawNotification(
            text,
            options?.notificationLabel || "播报回传",
            {
                bestEffort: true,
            }
        ).catch((error) => {
            console.warn(
                `[XiaoAI Cloud] ${options?.notificationLabel || "播报回传"}失败: ${this.errorMessage(error)}`
            );
        });
    }

    private generateExternalAudioId() {
        const digits = Array.from(randomBytes(12))
            .map((value) => String(value % 10))
            .join("")
            .replace(/^0+/, "1");
        return digits.padEnd(19, "7").slice(0, 19);
    }

    private buildExternalAudioMusicRequest(
        url: string,
        title?: string
    ): ExternalAudioMusicRequest {
        const expectedAudioId = this.generateExternalAudioId();
        const item: Record<string, any> = {
            item_id: {
                audio_id: expectedAudioId,
                cp: {
                    album_id: "-1",
                    episode_index: 0,
                    id: EXTERNAL_AUDIO_CP_ID,
                    name: EXTERNAL_AUDIO_ORIGIN,
                },
            },
            stream: {
                url,
            },
        };
        const normalizedTitle = this.normalizeAudioReplyTitle(title);
        if (normalizedTitle) {
            item.text = normalizedTitle;
        }
        return {
            expectedAudioId,
            data: {
                startaudioid: expectedAudioId,
                music: JSON.stringify({
                    payload: {
                        audio_type: "MUSIC",
                        audio_items: [item],
                        list_params: {
                            listId: "-1",
                            loadmore_offset: 0,
                            origin: EXTERNAL_AUDIO_ORIGIN,
                            type: "MUSIC",
                        },
                    },
                    play_behavior: "REPLACE_ALL",
                }),
            },
        };
    }

    private readAudioRelayUsageForUrl(url: string) {
        try {
            const parsed = new URL(url);
            const relayName = parsed.pathname.split("/").pop() || "";
            const relayId = relayName.replace(/\.[a-z0-9]+$/i, "").trim();
            if (!relayId) {
                return null;
            }
            const entry = this.audioRelayEntries.get(relayId);
            if (!entry) {
                return null;
            }
            return {
                relayId,
                hitCount: entry.hitCount,
                lastHitAtMs: entry.lastHitAtMs,
            };
        } catch {
            return null;
        }
    }

    private async handleAudioRelayMp3TranscodeRoute(
        request: any,
        response: any,
        entry: AudioRelayEntry,
        requestMethod: string
    ) {
        const upstreamSourceUrl = entry.localSourceUrl || entry.sourceUrl;
        if (!upstreamSourceUrl) {
            sendText(response, 404, "Audio relay source is missing");
            return true;
        }
        const ffmpegAvailable = await this.probeFfmpegAvailability();
        if (!ffmpegAvailable) {
            sendText(response, 503, "Audio relay mp3 transcode is unavailable: ffmpeg not found");
            return true;
        }

        response.statusCode = 200;
        applySecurityHeaders(response);
        response.setHeader("Content-Type", "audio/mpeg");
        response.setHeader("Accept-Ranges", "none");
        response.setHeader("Vary", "Accept");

        if (requestMethod === "HEAD") {
            response.end();
            return true;
        }

        const process = spawn(
            "ffmpeg",
            [
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                upstreamSourceUrl,
                "-vn",
                "-sn",
                "-dn",
                "-f",
                "mp3",
                "-codec:a",
                "libmp3lame",
                "-b:a",
                "128k",
                "pipe:1",
            ],
            {
                stdio: ["ignore", "pipe", "pipe"],
            }
        );

        let stderr = "";
        let totalBytes = 0;
        let wroteBytes = false;

        process.stderr.on("data", (chunk) => {
            stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
            if (stderr.length > 2000) {
                stderr = stderr.slice(-2000);
            }
        });

        request.on("close", () => {
            if (!process.killed) {
                process.kill("SIGKILL");
            }
        });

        return await new Promise<boolean>((resolve) => {
            const fail = (statusCode: number, message: string) => {
                if (!response.headersSent) {
                    sendText(response, statusCode, message);
                } else if (!response.writableEnded) {
                    response.destroy(new Error(message));
                }
                if (!process.killed) {
                    process.kill("SIGKILL");
                }
                resolve(true);
            };

            process.on("error", (error) => {
                fail(502, `Failed to transcode upstream audio: ${this.errorMessage(error)}`);
            });

            process.stdout.on("data", (chunk) => {
                const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                wroteBytes = true;
                totalBytes += nextChunk.length;
                if (totalBytes > AUDIO_RELAY_MAX_BYTES) {
                    fail(413, "Audio relay mp3 transcode exceeded max size");
                    return;
                }
                response.write(nextChunk);
            });

            process.stdout.on("end", () => {
                if (!response.writableEnded) {
                    response.end();
                }
            });

            process.on("close", (code) => {
                if (response.writableEnded || response.destroyed) {
                    resolve(true);
                    return;
                }
                if (code === 0 && wroteBytes) {
                    response.end();
                    resolve(true);
                    return;
                }
                fail(
                    502,
                    [
                        "Failed to transcode upstream audio",
                        `ffmpeg exited with code ${code ?? -1}`,
                        stderr ? stderr.replace(/\s+/g, " ").trim() : undefined,
                    ]
                        .filter(Boolean)
                        .join(": ")
                );
            });
        });
    }

    private async handleBufferedAudioRelayRoute(
        request: any,
        response: any,
        entry: AudioRelayEntry,
        requestMethod: string
    ) {
        const buffer =
            Buffer.isBuffer(entry.buffer) && entry.buffer.length > 0
                ? entry.buffer
                : entry.filePath
                ? await readFile(entry.filePath).catch(() => undefined)
                : undefined;
        if (!buffer || buffer.length === 0) {
            sendText(response, 404, "Buffered audio relay payload is missing");
            return true;
        }
        entry.buffer = buffer;

        applySecurityHeaders(response);
        response.setHeader(
            "Content-Type",
            entry.contentType || contentTypeForAudioExtension(entry.extension)
        );
        response.setHeader("Accept-Ranges", "bytes");
        response.setHeader("Vary", "Range, Accept");

        const rangeHeader = readRequestHeader(request, "range");
        if (rangeHeader) {
            const matched = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
            if (!matched) {
                sendText(response, 416, "Invalid range");
                return true;
            }
            const total = buffer.length;
            let start = matched[1] ? Number(matched[1]) : 0;
            let end = matched[2] ? Number(matched[2]) : total - 1;
            if (!matched[1] && matched[2]) {
                const suffixLength = Number(matched[2]);
                start = Math.max(0, total - suffixLength);
                end = total - 1;
            }
            if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
                sendText(response, 416, "Invalid range");
                return true;
            }
            const boundedEnd = Math.min(end, total - 1);
            if (start >= total) {
                response.statusCode = 416;
                response.setHeader("Content-Range", `bytes */${total}`);
                response.end();
                return true;
            }

            const chunk = buffer.subarray(start, boundedEnd + 1);
            response.statusCode = 206;
            response.setHeader("Content-Length", String(chunk.length));
            response.setHeader("Content-Range", `bytes ${start}-${boundedEnd}/${total}`);
            if (requestMethod === "HEAD") {
                response.end();
                return true;
            }
            response.end(chunk);
            return true;
        }

        response.statusCode = 200;
        response.setHeader("Content-Length", String(buffer.length));
        if (requestMethod === "HEAD") {
            response.end();
            return true;
        }
        response.end(buffer);
        return true;
    }

    private async handleAudioRelayHttpRoute(
        request: any,
        response: any,
        matchedPath: string
    ) {
        const requestMethod = (request.method || "GET").toUpperCase();
        if (requestMethod !== "GET" && requestMethod !== "HEAD") {
            sendText(response, 405, "Method not allowed");
            return true;
        }

        const relayName = matchedPath.replace(/^\/audio-relay\/?/, "").trim();
        const relayId = relayName.replace(/\.[a-z0-9]+$/i, "").trim();
        if (!relayId) {
            sendText(response, 404, "Not found");
            return true;
        }

        this.pruneAudioRelayEntries();
        let entry = this.audioRelayEntries.get(relayId);
        if (!entry) {
            const restored = await this.restorePersistedAudioRelayEntry(relayId);
            if (restored) {
                this.audioRelayEntries.set(relayId, restored);
                entry = restored;
            }
        }
        if (!entry || entry.expiresAtMs <= Date.now()) {
            if (entry?.filePath) {
                unlink(entry.filePath).catch(() => undefined);
            }
            this.audioRelayEntries.delete(relayId);
            sendText(response, 404, "Audio relay expired");
            return true;
        }

        entry.hitCount += 1;
        entry.lastHitAtMs = Date.now();
        entry.lastHitAddress =
            readString(readRequestHeader(request, "x-forwarded-for")) ||
            readString(request?.socket?.remoteAddress) ||
            undefined;
        if (entry.hitCount === 1) {
            void this.appendDebugTrace("audio_relay_hit", {
                relayId,
                sourceUrl: entry.sourceUrl || entry.sourceLabel,
                remoteAddress: entry.lastHitAddress,
                buffered: Buffer.isBuffer(entry.buffer) || Boolean(entry.filePath),
                transcodeToMp3: entry.transcodeToMp3 === true,
            });
        }

        if (Buffer.isBuffer(entry.buffer) || Boolean(entry.filePath)) {
            return this.handleBufferedAudioRelayRoute(
                request,
                response,
                entry,
                requestMethod
            );
        }

        if (entry.transcodeToMp3) {
            return this.handleAudioRelayMp3TranscodeRoute(
                request,
                response,
                entry,
                requestMethod
            );
        }
        const upstreamSourceUrl = entry.localSourceUrl || entry.sourceUrl;
        if (!upstreamSourceUrl) {
            sendText(response, 404, "Audio relay source is missing");
            return true;
        }

        let upstream: Response;
        try {
            const requestHeaders: Record<string, string> = {
                Accept: readRequestHeader(request, "accept") || "audio/*,*/*;q=0.8",
            };
            const rangeHeader = readRequestHeader(request, "range");
            const ifRangeHeader = readRequestHeader(request, "if-range");
            if (rangeHeader) {
                requestHeaders.Range = rangeHeader;
            }
            if (ifRangeHeader) {
                requestHeaders["If-Range"] = ifRangeHeader;
            }
            upstream = await fetch(upstreamSourceUrl, {
                method: requestMethod,
                redirect: "follow",
                headers: requestHeaders,
            });
        } catch (error) {
            sendText(response, 502, `Failed to fetch upstream audio: ${this.errorMessage(error)}`);
            return true;
        }

        if (!upstream.ok || (requestMethod === "GET" && !upstream.body)) {
            sendText(
                response,
                upstream.status || 502,
                `Failed to fetch upstream audio: HTTP ${upstream.status || 502}`
            );
            return true;
        }

        response.statusCode = upstream.status || 200;
        applySecurityHeaders(response);
        const contentType = readString(upstream.headers.get("content-type") || undefined);
        response.setHeader(
            "Content-Type",
            contentType && contentType.toLowerCase().includes("audio/")
                ? contentType
                : contentTypeForAudioExtension(entry.extension)
        );
        const contentRange = readString(upstream.headers.get("content-range") || undefined);
        if (contentRange) {
            response.setHeader("Content-Range", contentRange);
        }
        response.setHeader(
            "Accept-Ranges",
            readString(upstream.headers.get("accept-ranges") || undefined) || "bytes"
        );
        response.setHeader("Vary", "Range, Accept");
        const etag = readString(upstream.headers.get("etag") || undefined);
        if (etag) {
            response.setHeader("ETag", etag);
        }
        const lastModified = readString(upstream.headers.get("last-modified") || undefined);
        if (lastModified) {
            response.setHeader("Last-Modified", lastModified);
        }
        const contentLength = readNumber(upstream.headers.get("content-length") || undefined);
        if (typeof contentLength === "number" && contentLength > 0) {
            if (contentLength > AUDIO_RELAY_MAX_BYTES) {
                sendText(response, 413, "Audio file is too large");
                return true;
            }
            response.setHeader("Content-Length", String(contentLength));
        }

        if (requestMethod === "HEAD") {
            response.end();
            return true;
        }

        let totalBytes = 0;
        try {
            for await (const chunk of upstream.body as any) {
                const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                totalBytes += nextChunk.length;
                if (totalBytes > AUDIO_RELAY_MAX_BYTES) {
                    response.destroy(new Error("Audio relay exceeded max size"));
                    return true;
                }
                response.write(nextChunk);
            }
            response.end();
        } catch (error) {
            if (!response.writableEnded) {
                response.destroy(error instanceof Error ? error : undefined);
            }
        }
        return true;
    }

    private async playAudioUrl(
        url: string,
        options?: {
            title?: string;
            interrupt?: boolean;
            ignoreRecentFailure?: boolean;
            armDialogWindow?: boolean;
            consoleEventKind?: string;
            consoleEventTitle?: string;
        }
    ) {
        const requestedUrl = normalizeRemoteMediaUrl(url);
        if (!requestedUrl) {
            throw new Error("只支持可直接访问的 http/https 音频 URL。");
        }

        const { device, mina } = await this.ensureActionContext();
        const initialBeforePlayback = await this.readSpeakerPlaybackSnapshotWithTiming(
            mina,
            device.minaDeviceId
        );
        const shouldInterruptCurrentPlayback =
            options?.interrupt !== false &&
            Boolean(
                initialBeforePlayback &&
                    !this.isSpeakerPlaybackPausedOrStopped(initialBeforePlayback)
            );
        const cachedCapability = this.readAudioPlaybackCapability(device, requestedUrl);
        const nowMs = Date.now();
        if (
            options?.ignoreRecentFailure !== true &&
            typeof cachedCapability?.skipSpeakerUntilMs === "number" &&
            cachedCapability.skipSpeakerUntilMs > nowMs
        ) {
            const remainingSeconds = Math.max(
                1,
                Math.ceil((cachedCapability.skipSpeakerUntilMs - nowMs) / 1000)
            );
            await this.appendDebugTrace("audio_playback_skip_recent_failure", {
                host: mediaUrlHostKey(requestedUrl),
                skipRemainingSeconds: remainingSeconds,
                preferredStrategy: cachedCapability.preferredStrategy,
            });
            throw new Error(
                `同一音频源刚刚验证过音箱侧仍然播不起来，已直接切到浏览器兜底（约 ${remainingSeconds} 秒内不再重复重试）。`
            );
        }

        if (shouldInterruptCurrentPlayback) {
            await this.pauseSpeaker().catch(() => false);
        }

        const inheritedLoopRestoreType = this.readExternalAudioLoopGuard(
            device.minaDeviceId
        )?.restoreLoopType;
        const beforePlayback = shouldInterruptCurrentPlayback
            ? (await this.readSpeakerPlaybackSnapshotWithTiming(
                mina,
                device.minaDeviceId
            )) || initialBeforePlayback
            : initialBeforePlayback;
        const beforePlaybackLoopType = readNumber(beforePlayback?.loopType);
        let externalAudioLoopTypeForced = false;
        if (
            typeof beforePlaybackLoopType === "number" &&
            beforePlaybackLoopType !== EXTERNAL_AUDIO_NON_LOOP_TYPE
        ) {
            externalAudioLoopTypeForced = await this.setSpeakerLoopType(
                mina,
                device.minaDeviceId,
                EXTERNAL_AUDIO_NON_LOOP_TYPE,
                "pre-playback",
                {
                    requestedUrl,
                    title: options?.title,
                    previousLoopType: beforePlaybackLoopType,
                }
            ).catch(() => false);
        }
        const preparedSource = await this.prepareSpeakerAudioSource(requestedUrl, {
            title: options?.title,
        });
        const speakerUrl = preparedSource.playbackUrl;
        const allowRelayStrategies = !this.isHostedAudioRelayUrl(speakerUrl);
        let relayCandidateUrls: string[] | undefined;
        let relayTranscodeCandidateUrls: string[] | undefined;
        const preferRelay =
            allowRelayStrategies &&
            this.shouldPreferRelayAudioUrl(requestedUrl);
        const preferMusic = this.shouldPreferStructuredMusic(speakerUrl);
        const canTranscodeToMp3 =
            allowRelayStrategies && (await this.probeFfmpegAvailability());
        const preferMp3Relay = canTranscodeToMp3 && this.shouldPreferMp3Relay(requestedUrl);
        const strategies = this.orderAudioPlaybackStrategies(cachedCapability?.preferredStrategy, {
            preferRelay,
            preferMusic,
            allowMp3Relay: canTranscodeToMp3,
            preferMp3Relay,
        }).filter((strategy) => allowRelayStrategies || !strategy.startsWith("relay"));

        let startedWithUrl: string | undefined;
        let usedStrategy: AudioPlaybackStrategy | undefined;
        let verifyResult: SpeakerPlaybackVerifyResult | undefined;
        let loopGuardAudioId: string | undefined;
        let playbackAcceptedAtMs: number | undefined;
        let playbackObservedAtMs: number | undefined;
        const attemptDiagnostics: Record<string, any>[] = [];

        strategyLoop:
        for (const strategy of strategies) {
            const candidateUrls =
                strategy === "relay-music-mp3" || strategy === "relay-direct-mp3"
                    ? relayTranscodeCandidateUrls ||
                        (relayTranscodeCandidateUrls = await this.buildAudioRelayCandidateUrls(
                            requestedUrl,
                            { transcodeToMp3: true }
                        ))
                    : strategy.startsWith("relay")
                    ? relayCandidateUrls ||
                        (relayCandidateUrls = await this.buildAudioRelayCandidateUrls(requestedUrl))
                    : [speakerUrl];

            for (const candidateUrl of candidateUrls) {
                const relayUsageBefore = this.isHostedAudioRelayUrl(candidateUrl)
                    ? this.readAudioRelayUsageForUrl(candidateUrl)
                    : strategy.startsWith("relay")
                    ? this.readAudioRelayUsageForUrl(candidateUrl)
                    : null;
                const candidateHostedRelayEntry = relayUsageBefore
                    ? this.readHostedAudioRelayEntry(candidateUrl)
                    : undefined;
                const allowRelayHitStart = this.isHostedBufferedRelayEntry(
                    candidateHostedRelayEntry
                );

                if (strategy.endsWith("direct")) {
                    const direct = await mina.playerPlayUrl(device.minaDeviceId, candidateUrl, 1);
                    const directAcceptedAtMs = Date.now();
                    const directCode = Number((direct as any)?.code);
                    const directOk = Number.isFinite(directCode) ? directCode === 0 : true;
                    const attempt: Record<string, any> = {
                        strategy,
                        candidateUrl,
                        directCode,
                        relayHitCountBefore: relayUsageBefore?.hitCount,
                    };
                    if (!directOk) {
                        attempt.error = "cloud_rejected";
                        attemptDiagnostics.push(attempt);
                        continue;
                    }
                    const directVerify = await this.verifySpeakerPlaybackStarted(
                        mina,
                        device.minaDeviceId,
                        beforePlayback,
                        {
                            relayUrl: relayUsageBefore ? candidateUrl : undefined,
                            relayHitCount: relayUsageBefore?.hitCount,
                            allowRelayHitStart,
                        }
                    );
                    attempt.started = directVerify.started;
                    attempt.startedByRelayHit = directVerify.startedByRelayHit;
                    attempt.relayHitObserved = directVerify.relayHitObserved;
                    attempt.relayHitCount = directVerify.relayHitCount;
                    attempt.snapshot = directVerify.snapshot;
                    attemptDiagnostics.push(attempt);
                    if (directVerify.started) {
                        startedWithUrl = candidateUrl;
                        usedStrategy = strategy;
                        verifyResult = directVerify;
                        playbackAcceptedAtMs = directAcceptedAtMs;
                        playbackObservedAtMs = Date.now();
                        loopGuardAudioId = directVerify.startedByRelayHit
                            ? undefined
                            : readString(directVerify.snapshot?.audioId);
                        break strategyLoop;
                    }
                    continue;
                }

                const musicRequest = this.buildExternalAudioMusicRequest(
                    candidateUrl,
                    options?.title
                );
                const fallback = await mina.playerPlayMusic(
                    device.minaDeviceId,
                    musicRequest.data
                );
                const fallbackAcceptedAtMs = Date.now();
                const fallbackCode = Number((fallback as any)?.code);
                const fallbackOk = Number.isFinite(fallbackCode) ? fallbackCode === 0 : true;
                const attempt: Record<string, any> = {
                    strategy,
                    candidateUrl,
                    fallbackCode,
                    expectedAudioId: musicRequest.expectedAudioId,
                    relayHitCountBefore: relayUsageBefore?.hitCount,
                    transcodeToMp3: strategy === "relay-music-mp3",
                };
                if (!fallbackOk) {
                    attempt.error = "cloud_rejected";
                    attemptDiagnostics.push(attempt);
                    continue;
                }
                const fallbackVerify = await this.verifySpeakerPlaybackStarted(
                    mina,
                    device.minaDeviceId,
                    beforePlayback,
                    {
                        expectedAudioId: musicRequest.expectedAudioId,
                        relayUrl: relayUsageBefore ? candidateUrl : undefined,
                        relayHitCount: relayUsageBefore?.hitCount,
                        allowRelayHitStart,
                    }
                );
                attempt.started = fallbackVerify.started;
                attempt.startedByRelayHit = fallbackVerify.startedByRelayHit;
                attempt.relayHitObserved = fallbackVerify.relayHitObserved;
                attempt.relayHitCount = fallbackVerify.relayHitCount;
                attempt.snapshot = fallbackVerify.snapshot;
                attemptDiagnostics.push(attempt);
                if (fallbackVerify.started) {
                    startedWithUrl = candidateUrl;
                    usedStrategy = strategy;
                    verifyResult = fallbackVerify;
                    playbackAcceptedAtMs = fallbackAcceptedAtMs;
                    playbackObservedAtMs = Date.now();
                    loopGuardAudioId = musicRequest.expectedAudioId;
                    break strategyLoop;
                }
            }
        }

        if (!startedWithUrl) {
            if (
                externalAudioLoopTypeForced &&
                typeof beforePlaybackLoopType === "number" &&
                beforePlaybackLoopType !== EXTERNAL_AUDIO_NON_LOOP_TYPE
            ) {
                await this.setSpeakerLoopType(
                    mina,
                    device.minaDeviceId,
                    beforePlaybackLoopType,
                    "pre-playback-rollback",
                    {
                        requestedUrl,
                        title: options?.title,
                    }
                ).catch(() => undefined);
            }
            this.rememberAudioPlaybackFailure(device, requestedUrl);
            await this.appendDebugTrace("audio_playback_failed", {
                host: mediaUrlHostKey(requestedUrl),
                requestedUrl,
                speakerUrl,
                localStandardized: preparedSource.standardized,
                standardizationError: preparedSource.standardizationError,
                strategies,
                relayCandidateCount: relayCandidateUrls?.length || 0,
                relayTranscodeCandidateCount: relayTranscodeCandidateUrls?.length || 0,
                preferRelay,
                preferMusic,
                canTranscodeToMp3,
                preferMp3Relay,
                attempts: attemptDiagnostics,
            });
            throw new Error(
                "音频播放请求虽然已被小米云端接受，但音箱没有真正开始播放。当前这台小爱似乎不接受这条外部音频链接。"
            );
        }

        const detail = this.describeAudioReply(requestedUrl, options?.title);
        if (usedStrategy) {
            if (
                typeof playbackAcceptedAtMs === "number" &&
                typeof playbackObservedAtMs === "number" &&
                playbackObservedAtMs >= playbackAcceptedAtMs
            ) {
                this.updateSpeakerAudioLatencyEstimate(
                    device.minaDeviceId,
                    "playbackDetectEstimateMs",
                    playbackObservedAtMs - playbackAcceptedAtMs
                );
            }
            const restoreLoopType =
                typeof inheritedLoopRestoreType === "number"
                    ? inheritedLoopRestoreType
                    : readNumber(beforePlayback?.loopType);
            const shouldArmLoopGuard = !(
                usedStrategy.endsWith("direct") && verifyResult?.startedByRelayHit
            );
            const resolvedLoopGuardAudioId =
                readString(loopGuardAudioId) || readString(verifyResult?.snapshot?.audioId);
            let effectivePlaybackSnapshot = verifyResult?.snapshot || null;
            const initialPlaybackSnapshot = effectivePlaybackSnapshot;
            const hostedRelayEntry = startedWithUrl
                ? await this.ensureHostedAudioRelayEntry(startedWithUrl)
                : undefined;
            const hostedRelayUsage = startedWithUrl
                ? this.readAudioRelayUsageForUrl(startedWithUrl)
                : undefined;
            const relayDurationMs = readNumber(hostedRelayEntry?.durationMs);
            const { deadlineLeadMs, tailPaddingMs } =
                this.computeExternalAudioLoopGuardLeadMs(
                    device.minaDeviceId,
                    hostedRelayEntry
                );
            const initialSnapshotDuration = readNumber(initialPlaybackSnapshot?.duration);
            const initialSnapshotPosition = Math.max(
                0,
                readNumber(initialPlaybackSnapshot?.position) || 0
            );
            const initialSnapshotActivelyPlaying =
                this.isSpeakerPlaybackActivelyPlaying(initialPlaybackSnapshot);
            const relayHitDeadlineAtMs =
                initialSnapshotActivelyPlaying
                    ? this.computeRelayHitAnchoredExternalAudioDeadlineAtMs(
                        device.minaDeviceId,
                        hostedRelayEntry,
                        readNumber(hostedRelayUsage?.lastHitAtMs)
                    )
                    : undefined;
            const observedPlaybackDeadlineAtMs =
                !initialSnapshotActivelyPlaying
                    ? undefined
                    : typeof relayDurationMs === "number" &&
                        relayDurationMs > 0 &&
                        typeof playbackObservedAtMs === "number"
                        ? playbackObservedAtMs +
                            Math.max(
                                0,
                                relayDurationMs -
                                    initialSnapshotPosition -
                                    deadlineLeadMs
                            )
                        : typeof initialSnapshotDuration === "number" &&
                            initialSnapshotDuration > 0
                            ? Date.now() +
                                Math.max(
                                    0,
                                    initialSnapshotDuration - initialSnapshotPosition
                                ) +
                                EXTERNAL_AUDIO_LOOP_GUARD_DEADLINE_GRACE_MS
                            : undefined;
            const deadlineAtMs =
                typeof relayHitDeadlineAtMs === "number" &&
                typeof observedPlaybackDeadlineAtMs === "number"
                    ? typeof tailPaddingMs === "number" && tailPaddingMs > 0
                        ? Math.min(
                            relayHitDeadlineAtMs,
                            observedPlaybackDeadlineAtMs
                        )
                        : Math.max(
                            relayHitDeadlineAtMs,
                            observedPlaybackDeadlineAtMs
                        )
                    : typeof relayHitDeadlineAtMs === "number"
                        ? relayHitDeadlineAtMs
                        : observedPlaybackDeadlineAtMs;
            this.lastOpenclawSpeech = {
                text: detail,
                timeMs: Date.now(),
            };
            if (options?.armDialogWindow) {
                this.lastOpenclawSpeakTime = Date.now() / 1000;
                this.armDialogWindow(this.lastOpenclawSpeakTime);
            }
            this.recordConsoleEvent(
                options?.consoleEventKind || "tool.audio",
                options?.consoleEventTitle || "OpenClaw 让小爱播放音频",
                detail,
                "success",
                { audioUrl: startedWithUrl }
            );
            this.takeExternalAudioLoopGuard(device.minaDeviceId);
            if (startedWithUrl && shouldArmLoopGuard) {
                this.armExternalAudioLoopGuard(mina, device, {
                    expectedAudioId: resolvedLoopGuardAudioId,
                    restoreLoopType,
                    startedWithUrl,
                    title: options?.title,
                    deadlineAtMs,
                });
            }
            const observedLoopType = readNumber(effectivePlaybackSnapshot?.loopType);
            const postStartLoopEnforcementQueued =
                shouldArmLoopGuard &&
                observedLoopType !== EXTERNAL_AUDIO_NON_LOOP_TYPE;
            const snapshotDuration = readNumber(effectivePlaybackSnapshot?.duration);
            const snapshotPosition = Math.max(
                0,
                readNumber(effectivePlaybackSnapshot?.position) || 0
            );
            const snapshotActivelyPlaying =
                readNumber(effectivePlaybackSnapshot?.status) === 1 ||
                snapshotPosition > 0;
            this.rememberAudioPlaybackSuccess(device, requestedUrl, usedStrategy);
            void this.appendDebugTrace("audio_playback_started", {
                host: mediaUrlHostKey(requestedUrl),
                strategy: usedStrategy,
                requestedUrl,
                startedWithUrl,
                localStandardized: preparedSource.standardized,
                standardizationError: preparedSource.standardizationError,
                loopGuardAudioId: resolvedLoopGuardAudioId,
                loopGuardArmed: shouldArmLoopGuard,
                restoreLoopType,
                deadlineAtMs,
                deadlineLeadMs,
                relayDurationMs,
                relayHitAtMs: readNumber(hostedRelayUsage?.lastHitAtMs),
                relayHitDeadlineAtMs,
                tailPaddingMs,
                playbackAcceptedAtMs,
                playbackObservedAtMs,
                snapshotActivelyPlaying,
                preferRelay,
                preferMusic,
                canTranscodeToMp3,
                preferMp3Relay,
                postStartLoopEnforcementQueued,
                startedByRelayHit: verifyResult?.startedByRelayHit,
                relayHitObserved: verifyResult?.relayHitObserved,
                relayHitCount: verifyResult?.relayHitCount,
                latencyProfile: this.readSpeakerAudioLatencyProfile(
                    device.minaDeviceId
                ),
                snapshot: effectivePlaybackSnapshot,
                attempts: attemptDiagnostics,
            });
            if (postStartLoopEnforcementQueued) {
                void (async () => {
                    const enforcedNonLoopType = await this.setSpeakerLoopType(
                        mina,
                        device.minaDeviceId,
                        EXTERNAL_AUDIO_NON_LOOP_TYPE,
                        "post-playback-start",
                        {
                            requestedUrl,
                            title: options?.title,
                            expectedAudioId: resolvedLoopGuardAudioId,
                            previousLoopType: observedLoopType,
                        }
                    ).catch(() => false);
                    if (!enforcedNonLoopType) {
                        return;
                    }
                    const loopTypeSettled = await this.verifySpeakerCommandState(
                        mina,
                        device.minaDeviceId,
                        (current) =>
                            readNumber(current?.loopType) === EXTERNAL_AUDIO_NON_LOOP_TYPE ||
                            Boolean(
                                resolvedLoopGuardAudioId &&
                                    current &&
                                    !this.speakerSnapshotHasAudioId(
                                        current,
                                        resolvedLoopGuardAudioId
                                    )
                            ),
                        SPEAKER_COMMAND_FAST_VERIFY_DELAYS_MS
                    ).catch(() => ({
                        ok: false,
                        snapshot: effectivePlaybackSnapshot,
                    }));
                    await this.appendDebugTrace("audio_loop_type_post_start_settled", {
                        deviceId: device.minaDeviceId,
                        requestedUrl,
                        title: options?.title,
                        expectedAudioId: resolvedLoopGuardAudioId,
                        ok: loopTypeSettled.ok,
                        snapshot: loopTypeSettled.snapshot || effectivePlaybackSnapshot,
                    });
                })().catch((error) => {
                    void this.appendDebugTrace("audio_loop_type_post_start_error", {
                        deviceId: device.minaDeviceId,
                        requestedUrl,
                        title: options?.title,
                        expectedAudioId: resolvedLoopGuardAudioId,
                        errorMessage: this.errorMessage(error),
                    });
                });
            }
        }
        return {
            ok: true,
            detail,
            url: startedWithUrl,
        };
    }

    private getPendingVolumeSnapshot(sequence?: number): VolumeSnapshot | null {
        const pending = this.pendingVolumeState;
        if (!pending) {
            return null;
        }
        if (Date.now() > pending.expiresAt) {
            this.pendingVolumeState = undefined;
            return null;
        }
        if (typeof sequence === "number" && pending.sequence !== sequence) {
            return null;
        }
        return {
            percent: pending.snapshot.percent,
            raw: pending.snapshot.raw,
            source: "cache",
            muted: pending.snapshot.muted === true,
            deviceMuted: pending.snapshot.deviceMuted === true,
            unmuteBlocked: pending.snapshot.unmuteBlocked === true,
            muteSupported: pending.snapshot.muteSupported !== false,
            pending: true,
        };
    }

    private rememberVolumeSnapshot(snapshot: VolumeSnapshot) {
        const percent = clamp(Math.round(snapshot.percent), 0, 100);
        const raw = Number.isFinite(snapshot.raw) ? snapshot.raw : percent;
        const muted = snapshot.muted === true;
        this.lastKnownVolumeSnapshot = {
            percent,
            raw,
            muted,
            deviceMuted: snapshot.deviceMuted === true,
            unmuteBlocked: snapshot.unmuteBlocked === true,
            muteSupported: snapshot.muteSupported !== false,
            source: snapshot.source,
        };
        if (percent > 0) {
            this.lastNonZeroVolume = percent;
        }
    }

    private buildCachedVolumeSnapshot(options?: {
        percent?: number;
        raw?: number;
        muted?: boolean;
        deviceMuted?: boolean;
        unmuteBlocked?: boolean;
        muteSupported?: boolean;
        pending?: boolean;
    }): VolumeSnapshot {
        const base = this.lastKnownVolumeSnapshot;
        const percent = clamp(Math.round(Number(options?.percent ?? base?.percent ?? 0)), 0, 100);
        const explicitRaw = Number(options?.raw);
        const baseRaw = Number(base?.raw);
        const raw = Number.isFinite(explicitRaw)
            ? explicitRaw
            : Number.isFinite(baseRaw)
              ? baseRaw
              : percent;
        return {
            percent,
            raw,
            muted:
                typeof options?.muted === "boolean"
                    ? options.muted
                    : base?.muted === true,
            deviceMuted:
                typeof options?.deviceMuted === "boolean"
                    ? options.deviceMuted
                    : base?.deviceMuted === true,
            unmuteBlocked:
                typeof options?.unmuteBlocked === "boolean"
                    ? options.unmuteBlocked
                    : base?.unmuteBlocked === true,
            muteSupported:
                typeof options?.muteSupported === "boolean"
                    ? options.muteSupported
                    : base?.muteSupported !== false,
            source: "cache",
            pending: options?.pending === true,
        };
    }

    private rememberPendingVolume(
        snapshot: {
            percent: number;
            raw: number;
            muted?: boolean;
            deviceMuted?: boolean;
            unmuteBlocked?: boolean;
            muteSupported?: boolean;
        },
        sequence: number
    ) {
        this.pendingVolumeState = {
            sequence,
            snapshot: {
                percent: clamp(Math.round(snapshot.percent), 0, 100),
                raw: Number.isFinite(snapshot.raw) ? snapshot.raw : snapshot.percent,
                muted: snapshot.muted === true,
                deviceMuted: snapshot.deviceMuted === true,
                unmuteBlocked: snapshot.unmuteBlocked === true,
                muteSupported: snapshot.muteSupported !== false,
            },
            setAt: Date.now(),
            expiresAt: Date.now() + VOLUME_CACHE_GRACE_MS,
        };
        this.rememberVolumeSnapshot({
            percent: snapshot.percent,
            raw: snapshot.raw,
            muted: snapshot.muted,
            deviceMuted: snapshot.deviceMuted,
            unmuteBlocked: snapshot.unmuteBlocked,
            muteSupported: snapshot.muteSupported,
            source: "cache",
        });
    }

    private async syncSpeakerMuteState(
        device: DeviceContext,
        miio: MiIOClient,
        muted: boolean,
        options?: {
            forceAction?: boolean;
            propertyValue?: boolean | number;
        }
    ): Promise<SpeakerMuteSyncResult> {
        const muteAction = muted ? device.speakerFeatures.muteOn : device.speakerFeatures.muteOff;
        const muteFeature = device.speakerFeatures.mute;
        if (!options?.forceAction && muteFeature) {
            const propertyValue =
                typeof options?.propertyValue === "number" ? options.propertyValue : muted;
            const result = await miio.miotSetProps([
                {
                    did: device.miDid,
                    siid: muteFeature.siid,
                    piid: muteFeature.piid,
                    value: propertyValue,
                },
            ]);
            if (result[0]?.code === 0) {
                return {
                    ok: true,
                    mode:
                        typeof options?.propertyValue === "number"
                            ? "property.numeric"
                            : "property",
                    code: result[0]?.code,
                    siid: muteFeature.siid,
                    piid: muteFeature.piid,
                };
            }
            if (!muteAction) {
                return {
                    ok: false,
                    mode:
                        typeof options?.propertyValue === "number"
                            ? "property.numeric"
                            : "property",
                    code: result[0]?.code,
                    siid: muteFeature.siid,
                    piid: muteFeature.piid,
                };
            }
        }

        if (!muteAction) {
            return {
                ok: true,
                mode: "none",
            };
        }

        const result = await miio.miotAction(device.miDid, muteAction.siid, muteAction.aiid, []);
        const parsedCode = Number((result as any)?.code);
        return {
            ok: Number.isFinite(parsedCode) ? parsedCode === 0 : true,
            mode: muted ? "action.mute_on" : "action.mute_off",
            code: (result as any)?.code,
            siid: muteAction.siid,
            aiid: muteAction.aiid,
        };
    }

    private async syncAndVerifySpeakerMuteState(
        device: DeviceContext,
        miio: MiIOClient,
        muted: boolean
    ) {
        const firstSync = await this.syncSpeakerMuteState(device, miio, muted);
        if (!firstSync.ok) {
            return {
                sync: firstSync,
                matched: false,
                observed: undefined as boolean | undefined,
            };
        }

        let effectiveSync = firstSync;
        let verification = await this.verifySpeakerMuteReadback(device, miio, muted);
        const hasActionFallback = Boolean(
            muted ? device.speakerFeatures.muteOn : device.speakerFeatures.muteOff
        );

        if (!verification.matched && firstSync.mode === "property") {
            const numericSync = await this.syncSpeakerMuteState(device, miio, muted, {
                propertyValue: muted ? 1 : 0,
            });
            if (numericSync.ok) {
                await this.appendDebugTrace("speaker_mute_numeric_fallback", {
                    muted,
                    code: numericSync.code,
                    mode: numericSync.mode,
                    siid: numericSync.siid,
                    piid: numericSync.piid,
                    deviceId: device.minaDeviceId,
                });
                const numericVerification = await this.verifySpeakerMuteReadback(
                    device,
                    miio,
                    muted
                );
                if (numericVerification.matched) {
                    effectiveSync = numericSync;
                    verification = numericVerification;
                }
            }
        }

        if (!verification.matched && hasActionFallback) {
            const actionSync = await this.syncSpeakerMuteState(device, miio, muted, {
                forceAction: true,
            });
            if (actionSync.ok) {
                await this.appendDebugTrace("speaker_mute_action_fallback", {
                    muted,
                    code: actionSync.code,
                    mode: actionSync.mode,
                    siid: actionSync.siid,
                    aiid: actionSync.aiid,
                    deviceId: device.minaDeviceId,
                });
                const actionVerification = await this.verifySpeakerMuteReadback(
                    device,
                    miio,
                    muted
                );
                if (actionVerification.matched) {
                    effectiveSync = actionSync;
                    verification = actionVerification;
                }
            } else {
                await this.appendDebugTrace("speaker_mute_action_sync_failed", {
                    muted,
                    code: actionSync.code,
                    mode: actionSync.mode,
                    siid: actionSync.siid,
                    aiid: actionSync.aiid,
                    deviceId: device.minaDeviceId,
                });
            }
        }

        return {
            sync: effectiveSync,
            matched: verification.matched,
            observed: verification.observed,
        };
    }

    private async readDeviceSpeakerMuteProperty(
        device: DeviceContext,
        miio: MiIOClient
    ): Promise<boolean | undefined> {
        const muteFeature = device.speakerFeatures.mute;
        if (!muteFeature) {
            return undefined;
        }
        const result = await miio
            .miotGetProps([
                {
                    did: device.miDid,
                    siid: muteFeature.siid,
                    piid: muteFeature.piid,
                },
            ])
            .catch(() => undefined);
        return readBoolean(result?.[0]?.value);
    }

    private async verifySpeakerMuteReadback(
        device: DeviceContext,
        miio: MiIOClient,
        expectedMuted: boolean
    ) {
        let observed: boolean | undefined;
        for (const delayMs of SPEAKER_MUTE_READBACK_VERIFY_DELAYS_MS) {
            if (delayMs > 0) {
                await sleep(delayMs);
            }
            observed = await this.readDeviceSpeakerMuteProperty(device, miio).catch(
                () => undefined
            );
            if (typeof observed === "boolean" && observed === expectedMuted) {
                return {
                    matched: true,
                    observed,
                };
            }
        }
        return {
            matched: false,
            observed,
        };
    }

    private resolveSoftMuteRestoreVolume(
        storedState: PersistedSpeakerMuteState,
        baseSnapshot?: VolumeSnapshot | null
    ) {
        const storedRestore = readNumber(storedState.restoreVolumePercent);
        if (typeof storedRestore === "number" && storedRestore > 0) {
            return clamp(Math.round(storedRestore), 1, 100);
        }
        const snapshotPercent = readNumber(baseSnapshot?.percent);
        if (typeof snapshotPercent === "number" && snapshotPercent > 0) {
            return clamp(Math.round(snapshotPercent), 1, 100);
        }
        if (this.lastNonZeroVolume > 0) {
            return clamp(Math.round(this.lastNonZeroVolume), 1, 100);
        }
        return 15;
    }

    private async readActualVolumeReadbackFromDevice(): Promise<
        | {
            percent: number;
            raw: number;
            source: "miot" | "mina";
            deviceMuted?: boolean;
        }
        | null
    > {
        const { device, miio, mina } = await this.ensureActionContext();
        const muteFeature = device.speakerFeatures.mute;

        if (device.speakerFeatures.volume) {
            const prop = device.speakerFeatures.volume;
            const requestProps = [{ did: device.miDid, siid: prop.siid, piid: prop.piid }];
            if (muteFeature) {
                requestProps.push({
                    did: device.miDid,
                    siid: muteFeature.siid,
                    piid: muteFeature.piid,
                });
            }
            const results = await miio.miotGetProps(requestProps);
            const value = results[0]?.value;
            if (typeof value === "number") {
                return {
                    percent: normalizeSpeakerVolumePercent(value, prop.min, prop.max),
                    raw: value,
                    source: "miot",
                    deviceMuted: muteFeature ? readBoolean(results[1]?.value) : undefined,
                };
            }
        }

        const fallback = await mina.playerGetStatus(device.minaDeviceId);
        const info = fallback?.data?.info;
        const payload =
            typeof info === "string"
                ? readJsonObject<Record<string, any>>(info, "小爱播放状态 info")
                : info;
        const volume = payload?.volume;
        if (typeof volume !== "number") {
            return null;
        }

        let deviceMuted: boolean | undefined;
        if (muteFeature) {
            const muteResult = await miio
                .miotGetProps([
                    {
                        did: device.miDid,
                        siid: muteFeature.siid,
                        piid: muteFeature.piid,
                    },
                ])
                .catch(() => undefined);
            deviceMuted = readBoolean(muteResult?.[0]?.value);
        }

        return {
            percent: clamp(Math.round(volume), 0, 100),
            raw: volume,
            source: "mina",
            deviceMuted,
        };
    }

    private async waitForActualSpeakerVolumeAtMost(
        maxPercent = SOFT_VOLUME_MUTE_READBACK_MAX_PERCENT
    ) {
        let lastSnapshot:
            | {
                percent: number;
                raw: number;
                source: "miot" | "mina";
                deviceMuted?: boolean;
            }
            | null = null;
        for (const delayMs of [0, ...SPEAKER_MUTE_READBACK_VERIFY_DELAYS_MS]) {
            if (delayMs > 0) {
                await sleep(delayMs);
            }
            const snapshot = await this.readActualVolumeReadbackFromDevice().catch(
                () => null
            );
            if (!snapshot) {
                continue;
            }
            lastSnapshot = snapshot;
            if (snapshot.percent <= maxPercent) {
                return {
                    ok: true,
                    snapshot,
                };
            }
        }
        return {
            ok: false,
            snapshot: lastSnapshot,
        };
    }

    private async readVolumeSnapshotFromDevice(): Promise<VolumeSnapshot | null> {
        const { device, miio, mina } = await this.ensureActionContext();
        const storedMuteState = await this.getStoredSpeakerMuteState(device).catch(
            () => ({} as PersistedSpeakerMuteState)
        );
        const effectiveStoredMuteState = this.mergePendingSoftMuteState(
            storedMuteState,
            this.getPendingVolumeSnapshot()
        );
        const actual = await this.readActualVolumeReadbackFromDevice();
        if (!actual) {
            return null;
        }
        const softMuteState =
            effectiveStoredMuteState.mode === "soft-volume"
                ? await this.resolveSoftVolumeObservedState(
                    device,
                    effectiveStoredMuteState,
                    actual.percent,
                    actual.deviceMuted
                )
                : null;
        return this.buildObservedVolumeSnapshot(
            device,
            effectiveStoredMuteState,
            actual.percent,
            actual.raw,
            actual.source,
            actual.deviceMuted,
            softMuteState
        );
    }

    private clearPendingVolume(sequence?: number) {
        const pending = this.pendingVolumeState;
        if (!pending) {
            return;
        }
        if (typeof sequence === "number" && pending.sequence !== sequence) {
            return;
        }
        this.pendingVolumeState = undefined;
    }

    private async runSpeakerControlMutation<T>(
        kind: "volume" | "mute",
        target: number | boolean,
        task: () => Promise<T>
    ): Promise<T> {
        const previous = this.speakerControlMutationQueue.catch(() => undefined);
        let release!: () => void;
        this.speakerControlMutationQueue = new Promise<void>((resolve) => {
            release = resolve;
        });
        await this.appendDebugTrace("console_speaker_control_queue_wait", {
            kind,
            target,
        }).catch(() => undefined);
        await previous;
        try {
            await this.appendDebugTrace("console_speaker_control_queue_start", {
                kind,
                target,
            }).catch(() => undefined);
            const result = await task();
            await this.appendDebugTrace("console_speaker_control_queue_success", {
                kind,
                target,
            }).catch(() => undefined);
            return result;
        } catch (error) {
            await this.appendDebugTrace("console_speaker_control_queue_error", {
                kind,
                target,
                error: this.errorMessage(error),
            }).catch(() => undefined);
            throw error;
        } finally {
            release();
        }
    }

    private formatConsoleVolumeState(snapshot?: VolumeSnapshot | null) {
        if (!snapshot) {
            return null;
        }
        const muteSupported = snapshot.muteSupported !== false;
        return {
            percent: clamp(Math.round(snapshot.percent), 0, 100),
            muted: muteSupported ? snapshot.muted === true : false,
            deviceMuted: muteSupported ? snapshot.deviceMuted === true : false,
            unmuteBlocked: muteSupported ? snapshot.unmuteBlocked === true : false,
            muteSupported,
            pending: snapshot.pending === true,
        };
    }

    private snapshotMatchesSpeakerControlTarget(
        snapshot: VolumeSnapshot,
        target?: {
            percent?: number;
            muted?: boolean;
        }
    ) {
        if (!target) {
            return true;
        }
        if (
            typeof target.percent === "number" &&
            snapshot.percent !== clamp(Math.round(target.percent), 0, 100)
        ) {
            return false;
        }
        if (
            typeof target.muted === "boolean" &&
            (snapshot.muted === true) !== target.muted
        ) {
            return false;
        }
        return true;
    }

    private async readConsoleVolumeMutationResult(fallback?: {
        percent?: number;
        muted?: boolean;
    }) {
        const actualSnapshot = await this.readVolumeSnapshotFromDevice().catch(() => null);
        if (actualSnapshot) {
            this.rememberVolumeSnapshot(actualSnapshot);
            return this.formatConsoleVolumeState({
                ...actualSnapshot,
                pending: !this.snapshotMatchesSpeakerControlTarget(
                    actualSnapshot,
                    fallback
                ),
            });
        }
        const snapshot =
            this.getPendingVolumeSnapshot() ||
            this.buildCachedVolumeSnapshot({
                percent: fallback?.percent,
                muted: fallback?.muted,
                pending: true,
            });
        return this.formatConsoleVolumeState(snapshot);
    }

    private async executeDirective(command: string, silent = false) {
        const { device, miio } = await this.ensureActionContext();
        const action = device.speakerFeatures.executeTextDirective;
        if (!action) {
            const messageRouterPost = device.speakerFeatures.messageRouterPost;
            if (messageRouterPost) {
                const result = await miio.miotAction(
                    device.miDid,
                    messageRouterPost.siid,
                    messageRouterPost.aiid,
                    [command]
                );
                const parsedCode = Number((result as any)?.code);
                const ok = Number.isFinite(parsedCode) ? parsedCode === 0 : true;
                if (ok) {
                    this.rememberSelfTriggeredQuery(command, "execute");
                } else {
                    await this.appendDebugTrace("speaker_message_router_post_failed_code", {
                        code: (result as any)?.code,
                        siid: messageRouterPost.siid,
                        aiid: messageRouterPost.aiid,
                        mode: "execute",
                    });
                }
                return ok;
            }
            throw new Error("当前音箱规格中未找到 execute_text_directive 或 message_router.post 动作。");
        }

        const args = typeof action.silentPiid === "number" ? [command, silent] : [command];
        const result = await miio.miotAction(device.miDid, action.siid, action.aiid, args);
        const parsedCode = Number((result as any)?.code);
        const ok = Number.isFinite(parsedCode) ? parsedCode === 0 : true;
        if (ok) {
            this.rememberSelfTriggeredQuery(command, "execute");
        } else {
            await this.appendDebugTrace("execute_directive_failed_code", {
                command: normalizeEventText(command, 240) || command,
                code: (result as any)?.code,
            });
        }
        return ok;
    }

    private async wakeUpSpeaker() {
        const { device, miio } = await this.ensureActionContext();
        const action = device.speakerFeatures.wakeUp;
        if (!action) {
            throw new Error("当前音箱规格中未找到 wake_up 动作。");
        }
        const result = await miio.miotAction(
            device.miDid,
            action.siid,
            action.aiid,
            action.ins && action.ins > 0 ? [""] : []
        );
        if (result.code === 0) {
            this.armDialogWindow();
            if (this.remoteWakeArmsDialogWindow()) {
                this.lastOpenclawSpeakTime = Date.now() / 1000;
            }
            this.waitingForResponse = false;
            return true;
        }
        await this.appendDebugTrace("speaker_wake_up_failed_code", {
            code: result.code,
            siid: action.siid,
            aiid: action.aiid,
            hasInputArg: action.ins && action.ins > 0,
        });
        return false;
    }

    private async sendPauseCommand(
        device: DeviceContext,
        mina: MiNAClient,
        miio: MiIOClient,
        options?: { singleAttempt?: boolean }
    ) {
        const pauseAction = device.speakerFeatures.pause;
        const runPauseAttempt = () => {
            const attempts: Promise<true>[] = [];

            attempts.push(
                mina.playerPause(device.minaDeviceId).then((result) => {
                    if (result?.code === 0) {
                        return true as const;
                    }
                    throw new Error("mina pause rejected");
                })
            );

            if (pauseAction) {
                attempts.push(
                    miio
                        .miotAction(device.miDid, pauseAction.siid, pauseAction.aiid, [])
                        .then((result) => {
                            if (result.code === 0) {
                                return true as const;
                            }
                            throw new Error("miot pause rejected");
                        })
                );
            }

            return Promise.any(attempts);
        };

        const delaysMs = options?.singleAttempt ? [0] : PAUSE_RETRY_DELAYS_MS;
        let lastError: unknown;
        for (const delayMs of delaysMs) {
            if (delayMs > 0) {
                await sleep(delayMs);
            }
            const pauseAttemptStartedAtMs = Date.now();
            try {
                const result = await runPauseAttempt();
                this.updateSpeakerAudioLatencyEstimate(
                    device.minaDeviceId,
                    "pauseCommandEstimateMs",
                    Date.now() - pauseAttemptStartedAtMs
                );
                return result;
            } catch (error) {
                lastError = error;
            }
        }
        throw lastError ?? new Error("speaker pause rejected");
    }

    private async pauseSpeaker() {
        const { device, mina, miio } = await this.ensureActionContext();
        try {
            let lastPauseAttemptStartedAtMs = Date.now();
            await this.sendPauseCommand(device, mina, miio);
            let settled = await this.verifySpeakerCommandState(
                mina,
                device.minaDeviceId,
                (snapshot) => this.isSpeakerPlaybackPausedOrStopped(snapshot)
            );
            if (settled.ok) {
                this.updateSpeakerAudioLatencyEstimate(
                    device.minaDeviceId,
                    "pauseSettleEstimateMs",
                    Date.now() - lastPauseAttemptStartedAtMs
                );
                return true;
            }

            lastPauseAttemptStartedAtMs = Date.now();
            await this.sendPauseCommand(device, mina, miio);
            settled = await this.verifySpeakerCommandState(
                mina,
                device.minaDeviceId,
                (snapshot) => this.isSpeakerPlaybackPausedOrStopped(snapshot)
            );
            if (settled.ok) {
                this.updateSpeakerAudioLatencyEstimate(
                    device.minaDeviceId,
                    "pauseSettleEstimateMs",
                    Date.now() - lastPauseAttemptStartedAtMs
                );
                return true;
            }

            await this.appendDebugTrace("speaker_pause_not_settled", {
                deviceId: device.minaDeviceId,
                snapshot: settled.snapshot,
            });
            return false;
        } catch {
            return false;
        }
    }

    private async resumeSpeaker() {
        const { device, mina, miio } = await this.ensureActionContext();
        const playAction = device.speakerFeatures.play;
        if (playAction) {
            try {
                const result = await miio.miotAction(
                    device.miDid,
                    playAction.siid,
                    playAction.aiid,
                    []
                );
                if (result.code === 0) {
                    return true;
                }
            } catch {
                // Fall through to the Mina resume path below.
            }
        }
        try {
            const result = await mina.playerPlay(device.minaDeviceId);
            const parsedCode = Number((result as any)?.code);
            return Number.isFinite(parsedCode) ? parsedCode === 0 : true;
        } catch {
            return false;
        }
    }

    private async sendStopCommand(
        device: DeviceContext,
        mina: MiNAClient,
        miio: MiIOClient
    ) {
        const stopAction = device.speakerFeatures.stop;
        const attempts: Promise<true>[] = [];

        attempts.push(
            mina.playerStop(device.minaDeviceId).then((result) => {
                const parsedCode = Number((result as any)?.code);
                if (!Number.isFinite(parsedCode) || parsedCode === 0) {
                    return true as const;
                }
                throw new Error("mina stop rejected");
            })
        );

        if (stopAction) {
            attempts.push(
                miio
                    .miotAction(device.miDid, stopAction.siid, stopAction.aiid, [])
                    .then((result) => {
                        if (result.code === 0) {
                            return true as const;
                        }
                        throw new Error("miot stop rejected");
                    })
            );
        }

        return Promise.any(attempts);
    }

    private async trySpeakerInterruptBurst(
        device: DeviceContext,
        mina: MiNAClient,
        miio: MiIOClient,
        options?: {
            expectedAudioId?: string;
            preserveLoopGuard?: boolean;
            fast?: boolean;
        }
    ) {
        const expectedAudioId = readString(options?.expectedAudioId);
        const burstStartedAtMs = Date.now();
        const attempts: Promise<unknown>[] = [];

        attempts.push(mina.playerPause(device.minaDeviceId).catch(() => undefined));
        attempts.push(mina.playerStop(device.minaDeviceId).catch(() => undefined));

        if (device.speakerFeatures.pause) {
            attempts.push(
                miio
                    .miotAction(
                        device.miDid,
                        device.speakerFeatures.pause.siid,
                        device.speakerFeatures.pause.aiid,
                        []
                    )
                    .catch(() => undefined)
            );
        }
        if (device.speakerFeatures.stop) {
            attempts.push(
                miio
                    .miotAction(
                        device.miDid,
                        device.speakerFeatures.stop.siid,
                        device.speakerFeatures.stop.aiid,
                        []
                    )
                    .catch(() => undefined)
            );
        }

        const settled = await this.verifySpeakerCommandState(
            mina,
            device.minaDeviceId,
            (snapshot) =>
                this.isSpeakerPlaybackPausedOrStopped(snapshot) ||
                Boolean(
                    expectedAudioId &&
                        snapshot &&
                        !this.speakerSnapshotHasAudioId(snapshot, expectedAudioId)
                ),
            SPEAKER_INTERRUPT_BURST_VERIFY_DELAYS_MS
        );
        await Promise.allSettled(attempts);
        if (!settled.ok) {
            await this.appendDebugTrace("speaker_interrupt_burst_unconfirmed", {
                deviceId: device.minaDeviceId,
                expectedAudioId,
                snapshot: settled.snapshot,
            });
            return false;
        }

        this.updateSpeakerAudioLatencyEstimate(
            device.minaDeviceId,
            "stopSettleEstimateMs",
            Date.now() - burstStartedAtMs
        );
        await this.finalizeSpeakerStopSuccess(mina, device.minaDeviceId, options);
        return true;
    }

    private async dispatchSpeakerInterruptBurst(
        device: DeviceContext,
        mina: MiNAClient,
        miio: MiIOClient
    ) {
        const commands: Promise<unknown>[] = [
            mina.playerPause(device.minaDeviceId),
            mina.playerStop(device.minaDeviceId),
        ];

        if (device.speakerFeatures.pause) {
            commands.push(
                miio.miotAction(
                    device.miDid,
                    device.speakerFeatures.pause.siid,
                    device.speakerFeatures.pause.aiid,
                    []
                )
            );
        }
        if (device.speakerFeatures.stop) {
            commands.push(
                miio.miotAction(
                    device.miDid,
                    device.speakerFeatures.stop.siid,
                    device.speakerFeatures.stop.aiid,
                    []
                )
            );
        }

        const results = await Promise.allSettled(commands);
        const acceptedCount = results.filter(
            (item) => item.status === "fulfilled"
        ).length;
        return {
            accepted: acceptedCount > 0,
            acceptedCount,
            attemptedCount: results.length,
        };
    }

    private async stopSpeaker(options?: {
        preserveLoopGuard?: boolean;
        fast?: boolean;
        expectedAudioId?: string;
    }) {
        const { device, mina, miio } = await this.ensureActionContext();
        try {
            if (options?.fast) {
                const burstStopped = await this.trySpeakerInterruptBurst(
                    device,
                    mina,
                    miio,
                    options
                ).catch(() => false);
                if (burstStopped) {
                    return true;
                }

                const fastPauseStartedAtMs = Date.now();
                let pauseAccepted = false;
                let pauseError: string | undefined;
                try {
                    await this.sendPauseCommand(device, mina, miio, {
                        singleAttempt: true,
                    });
                    pauseAccepted = true;
                } catch (error) {
                    pauseError = this.errorMessage(error);
                }

                if (pauseAccepted) {
                    void this.verifySpeakerCommandState(
                        mina,
                        device.minaDeviceId,
                        (snapshot) =>
                            this.isSpeakerPlaybackPausedOrStopped(snapshot) ||
                            Boolean(
                                readString(options.expectedAudioId) &&
                                    snapshot &&
                                    !this.speakerSnapshotHasAudioId(
                                        snapshot,
                                        readString(options.expectedAudioId)
                                    )
                            ),
                        SPEAKER_COMMAND_FAST_VERIFY_DELAYS_MS
                    )
                        .then((fastPauseSettled) => {
                            if (!fastPauseSettled.ok) {
                                return;
                            }
                            this.updateSpeakerAudioLatencyEstimate(
                                device.minaDeviceId,
                                "pauseSettleEstimateMs",
                                Date.now() - fastPauseStartedAtMs
                            );
                        })
                        .catch(() => undefined);
                    await this.finalizeSpeakerStopSuccess(
                        mina,
                        device.minaDeviceId,
                        options
                    );
                    return true;
                }

                const expectedAudioId = readString(options.expectedAudioId);
                const fastSettled = await this.verifySpeakerCommandState(
                    mina,
                    device.minaDeviceId,
                    (snapshot) =>
                        this.isSpeakerPlaybackPausedOrStopped(snapshot) ||
                        Boolean(
                            expectedAudioId &&
                                snapshot &&
                                !this.speakerSnapshotHasAudioId(snapshot, expectedAudioId)
                        ),
                    SPEAKER_COMMAND_FAST_VERIFY_DELAYS_MS
                );
                if (fastSettled.ok) {
                    this.updateSpeakerAudioLatencyEstimate(
                        device.minaDeviceId,
                        "pauseSettleEstimateMs",
                        Date.now() - fastPauseStartedAtMs
                    );
                    await this.finalizeSpeakerStopSuccess(mina, device.minaDeviceId, options);
                    return true;
                }
                await this.appendDebugTrace("speaker_fast_pause_unconfirmed", {
                    deviceId: device.minaDeviceId,
                    expectedAudioId,
                    pauseError,
                    snapshot: fastSettled.snapshot,
                });
            }

            let firstStopError: string | undefined;
            let stopAttemptStartedAtMs = Date.now();
            await this.sendStopCommand(device, mina, miio).catch((error) => {
                firstStopError = this.errorMessage(error);
            });
            let settled = await this.verifySpeakerCommandState(
                mina,
                device.minaDeviceId,
                (snapshot) => this.isSpeakerPlaybackStopped(snapshot)
            );
            if (!settled.ok) {
                stopAttemptStartedAtMs = Date.now();
                await this.sendPauseCommand(device, mina, miio).catch(() => undefined);
                await this.sendStopCommand(device, mina, miio).catch(() => undefined);
                settled = await this.verifySpeakerCommandState(
                    mina,
                    device.minaDeviceId,
                    (snapshot) => this.isSpeakerPlaybackPausedOrStopped(snapshot)
                );
            }
            if (!settled.ok) {
                await this.appendDebugTrace("speaker_stop_not_settled", {
                    deviceId: device.minaDeviceId,
                    firstStopError,
                    snapshot: settled.snapshot,
                });
                return false;
            }
            this.updateSpeakerAudioLatencyEstimate(
                device.minaDeviceId,
                "stopSettleEstimateMs",
                Date.now() - stopAttemptStartedAtMs
            );
            await this.finalizeSpeakerStopSuccess(mina, device.minaDeviceId, options);
            return true;
        } catch {
            return false;
        }
    }

    private async getVolumeSnapshot(): Promise<VolumeSnapshot | null> {
        const pendingSnapshot = this.getPendingVolumeSnapshot();
        if (pendingSnapshot) {
            await this.appendDebugTrace("volume_snapshot_pending_cache_hit", {
                percent: pendingSnapshot.percent,
                raw: pendingSnapshot.raw,
                muted: pendingSnapshot.muted === true,
            }).catch(() => undefined);
        }
        try {
            const snapshot = await this.readVolumeSnapshotFromDevice();
            if (!snapshot) {
                return pendingSnapshot || null;
            }
            this.rememberVolumeSnapshot(snapshot);
            return snapshot;
        } catch (error) {
            if (pendingSnapshot) {
                return pendingSnapshot;
            }
            if (this.lastKnownVolumeSnapshot) {
                await this.appendDebugTrace("volume_snapshot_fallback_to_cache", {
                    error: this.errorMessage(error),
                    lastKnownPercent: this.lastKnownVolumeSnapshot.percent,
                    lastKnownRaw: this.lastKnownVolumeSnapshot.raw,
                    lastKnownMuted: this.lastKnownVolumeSnapshot.muted === true,
                });
                return this.buildCachedVolumeSnapshot();
            }
            throw error;
        }
    }

    private async clearResidualConsoleAudioBeforeUnmute(
        mina: MiNAClient,
        device: DeviceContext
    ) {
        const consoleState = await this.loadConsoleState(false).catch(() => undefined);
        const clearedAtMs = Date.parse(readString(consoleState?.audioPlaybackClearedAt) || "");
        if (!Number.isFinite(clearedAtMs)) {
            return;
        }

        const latestClearedAudioEvent = this.findLatestSpeakerAudioEvent(consoleState?.events, {
            beforeMs: clearedAtMs,
        });
        if (!latestClearedAudioEvent) {
            return;
        }

        const snapshot = this.readSpeakerPlaybackSnapshot(
            await mina.playerGetStatus(device.minaDeviceId).catch(() => undefined)
        );
        if (!this.hasSpeakerPlaybackContext(snapshot)) {
            return;
        }

        await this.appendDebugTrace("volume_restore_residual_audio_detected", {
            deviceId: device.minaDeviceId,
            clearedAt: new Date(clearedAtMs).toISOString(),
            latestAudioEventAt: readString(latestClearedAudioEvent.time),
            latestAudioUrl: normalizeRemoteMediaUrl(readString(latestClearedAudioEvent.audioUrl)),
            snapshot,
        });

        const stopped = await this.stopSpeaker().catch(() => false);
        if (stopped) {
            await this.clearConsoleAudioPlaybackState();
            return;
        }

        await this.appendDebugTrace("volume_restore_residual_audio_clear_failed", {
            deviceId: device.minaDeviceId,
            clearedAt: new Date(clearedAtMs).toISOString(),
            latestAudioEventAt: readString(latestClearedAudioEvent.time),
            latestAudioUrl: normalizeRemoteMediaUrl(readString(latestClearedAudioEvent.audioUrl)),
        });
    }

    private async setVolumePercent(
        percent: number,
        options?: {
            source?: "user" | "soft-mute";
            muted?: boolean;
        }
    ) {
        const { device, miio, mina } = await this.ensureActionContext();
        const pct = clamp(Math.round(percent), 0, 100);
        const sequence = ++this.volumeMutationSequence;
        const cachedSnapshot = this.getPendingVolumeSnapshot() || this.lastKnownVolumeSnapshot;
        const storedMuteState = await this.getStoredSpeakerMuteState(device).catch(
            () => ({} as PersistedSpeakerMuteState)
        );
        const softVolumeModeActive = storedMuteState.mode === "soft-volume";
        const keepSoftMuteEnabled =
            softVolumeModeActive &&
            storedMuteState.enabled === true &&
            options?.source !== "soft-mute";
        const devicePercent = keepSoftMuteEnabled ? 0 : pct;
        let muted = cachedSnapshot?.muted === true;
        if (softVolumeModeActive) {
            muted =
                options?.source === "soft-mute"
                    ? options?.muted === true
                    : storedMuteState.enabled === true;
        } else if (typeof options?.muted === "boolean") {
            muted = options.muted;
        }

        if (device.speakerFeatures.volume) {
            const prop = device.speakerFeatures.volume;
            const max = prop.max || 100;
            const min = prop.min || 0;
            const step = prop.step || 1;
            let value = min + ((max - min) * devicePercent) / 100;
            value = Math.round(value / step) * step;
            value = clamp(value, min, max);

            const volumeResult = await miio.miotSetProps([
                {
                    did: device.miDid,
                    siid: prop.siid,
                    piid: prop.piid,
                    value,
                },
            ]);
            const volumeWrite = volumeResult[0];
            const ok = volumeWrite?.code === 0;
            if (ok) {
                if (
                    storedMuteState.mode === "soft-volume" &&
                    options?.source !== "soft-mute"
                ) {
                    await this.persistSpeakerMuteState(device, {
                        mode: "soft-volume",
                        enabled: storedMuteState.enabled === true,
                        restoreVolumePercent: pct,
                        ignoreDeviceMuteReadback: true,
                    });
                }
                this.rememberPendingVolume(
                    {
                        percent: pct,
                        raw: keepSoftMuteEnabled ? 0 : value,
                        muted,
                        muteSupported: this.isSpeakerMuteControlSupportedFor(
                            device,
                            storedMuteState
                        ),
                    },
                    sequence
                );
            }
            return ok;
        }

        const fallback = await mina.playerSetVolume(device.minaDeviceId, pct);
        const ok = fallback?.code === 0;
        if (ok) {
            if (
                storedMuteState.mode === "soft-volume" &&
                options?.source !== "soft-mute"
            ) {
                await this.persistSpeakerMuteState(device, {
                    mode: "soft-volume",
                    enabled: storedMuteState.enabled === true,
                    restoreVolumePercent: pct,
                    ignoreDeviceMuteReadback: true,
                });
            }
            this.rememberPendingVolume(
                {
                    percent: pct,
                    raw: keepSoftMuteEnabled ? 0 : pct,
                    muted,
                    muteSupported: this.isSpeakerMuteControlSupportedFor(
                        device,
                        storedMuteState
                    ),
                },
                sequence
            );
        }
        return ok;
    }

    private async setSpeakerMutedViaSoftVolumeFallback(
        device: DeviceContext,
        muted: boolean,
        storedMuteState: PersistedSpeakerMuteState,
        baseSnapshot?: VolumeSnapshot | null
    ) {
        if (!device.speakerFeatures.volume) {
            return false;
        }

        const restoreVolumePercent = this.resolveSoftMuteRestoreVolume(
            storedMuteState,
            baseSnapshot
        );
        const targetPercent = muted ? 0 : restoreVolumePercent;
        const ok = await this.setVolumePercent(targetPercent, {
            source: "soft-mute",
            muted,
        });
        if (!ok) {
            return false;
        }

        await this.persistSpeakerMuteState(device, {
            mode: "soft-volume",
            enabled: muted,
            restoreVolumePercent,
            ignoreDeviceMuteReadback: true,
        });
        this.rememberPendingVolume(
            {
                percent: muted ? restoreVolumePercent : targetPercent,
                raw: targetPercent,
                muted,
                muteSupported: this.isSpeakerMuteControlSupportedFor(
                    device,
                    storedMuteState
                ),
            },
            this.volumeMutationSequence
        );
        return true;
    }

    private async stabilizeSoftVolumeUnmuteState(
        device: DeviceContext,
        miio: MiIOClient,
        restoreVolumePercent: number
    ) {
        for (const delayMs of SOFT_VOLUME_UNMUTE_SETTLE_PROBE_DELAYS_MS) {
            await sleep(delayMs);
            const snapshot = await this.readVolumeSnapshotFromDevice().catch(() => null);
            const healthy = Boolean(snapshot && snapshot.muted !== true && snapshot.percent > 0);
            await this.appendDebugTrace("speaker_soft_volume_unmute_probe", {
                delayMs,
                restoreVolumePercent,
                snapshotPercent: snapshot?.percent,
                snapshotMuted: snapshot?.muted === true,
                snapshotSource: snapshot?.source,
                healthy,
            });
            if (healthy) {
                return;
            }

            const storedMuteState = await this.getStoredSpeakerMuteState(device).catch(
                () => ({} as PersistedSpeakerMuteState)
            );
            if (
                storedMuteState.mode === "soft-volume" &&
                storedMuteState.ignoreDeviceMuteReadback === false
            ) {
                await this.syncAndVerifySpeakerMuteState(device, miio, false).catch(
                    () => undefined
                );
            }
            await sleep(260);
            await this.setVolumePercent(restoreVolumePercent, {
                source: "soft-mute",
                muted: false,
            }).catch(() => false);
            await this.persistSpeakerMuteState(device, {
                mode: "soft-volume",
                enabled: false,
                restoreVolumePercent,
                ignoreDeviceMuteReadback: true,
            });
        }
    }

    private async setSpeakerMuted(muted: boolean) {
        const { device, miio, mina } = await this.ensureActionContext();
        const storedMuteState = await this.getStoredSpeakerMuteState(device).catch(
            () => ({} as PersistedSpeakerMuteState)
        );
        const baseSnapshot =
            (await this.readVolumeSnapshotFromDevice().catch(() => null)) ||
            this.getPendingVolumeSnapshot() ||
            this.lastKnownVolumeSnapshot;
        if (!muted) {
            await this.clearResidualConsoleAudioBeforeUnmute(mina, device).catch(() => undefined);
            if (device.speakerFeatures.mute) {
                const softVolumeUnmuteSync = await this.syncAndVerifySpeakerMuteState(
                    device,
                    miio,
                    false
                ).catch(() => undefined);
                if (softVolumeUnmuteSync?.sync.ok) {
                    await this.appendDebugTrace("speaker_soft_volume_device_unmute", {
                        mode: softVolumeUnmuteSync.sync.mode,
                        siid: softVolumeUnmuteSync.sync.siid,
                        piid: softVolumeUnmuteSync.sync.piid,
                        aiid: softVolumeUnmuteSync.sync.aiid,
                        matched: softVolumeUnmuteSync.matched,
                        observed: softVolumeUnmuteSync.observed,
                        deviceId: device.minaDeviceId,
                    });
                    await this.updateSpeakerMuteReliability(device, {
                        deviceMuteUnreliable: !softVolumeUnmuteSync.matched,
                    }).catch(() => undefined);
                }
            }
        }

        if (!device.speakerFeatures.volume) {
            if (device.speakerFeatures.mute) {
                const muteSync = await this.syncAndVerifySpeakerMuteState(device, miio, muted);
                if (muteSync.sync.ok) {
                    if (muteSync.matched) {
                        const sequence = ++this.volumeMutationSequence;
                        await this.persistSpeakerMuteState(device, {
                            mode: "device",
                            enabled: muted,
                            restoreVolumePercent: this.resolveSoftMuteRestoreVolume(
                                storedMuteState,
                                baseSnapshot
                            ),
                            ignoreDeviceMuteReadback: false,
                            deviceMuteUnreliable: false,
                        });
                        const optimisticSnapshot = this.buildCachedVolumeSnapshot({
                            percent: baseSnapshot?.percent,
                            raw: baseSnapshot?.raw,
                            muted,
                            muteSupported: this.isSpeakerMuteControlSupportedFor(
                                device,
                                storedMuteState
                            ),
                            pending: true,
                        });
                        this.rememberPendingVolume(
                            {
                                percent: optimisticSnapshot.percent,
                                raw: optimisticSnapshot.raw,
                                muted,
                                muteSupported: optimisticSnapshot.muteSupported,
                            },
                            sequence
                        );
                        return true;
                    }

                    await this.appendDebugTrace("speaker_mute_readback_unreliable", {
                        muted,
                        observed: muteSync.observed,
                        mode: muteSync.sync.mode,
                        siid: muteSync.sync.siid,
                        piid: muteSync.sync.piid,
                        aiid: muteSync.sync.aiid,
                        deviceId: device.minaDeviceId,
                    });
                    await this.updateSpeakerMuteReliability(device, {
                        deviceMuteUnreliable: true,
                    }).catch(() => undefined);
                } else {
                    await this.appendDebugTrace("speaker_mute_sync_failed", {
                        muted,
                        code: muteSync.sync.code,
                        mode: muteSync.sync.mode,
                        siid: muteSync.sync.siid,
                        piid: muteSync.sync.piid,
                        aiid: muteSync.sync.aiid,
                    });
                }
            }
            return false;
        }

        const fallbackOk = await this.setSpeakerMutedViaSoftVolumeFallback(
            device,
            muted,
            storedMuteState,
            baseSnapshot
        );
        if (!fallbackOk) {
            return false;
        }

        const restoreVolumePercent = this.resolveSoftMuteRestoreVolume(
            storedMuteState,
            baseSnapshot
        );
        if (!muted) {
            await this.stabilizeSoftVolumeUnmuteState(
                device,
                miio,
                restoreVolumePercent
            );
        }
        await this.appendDebugTrace("speaker_mute_fallback_soft_volume", {
            muted,
            deviceId: device.minaDeviceId,
            restoreVolumePercent,
        });

        const verifiedSnapshot = await this.readVolumeSnapshotFromDevice().catch(() => null);
        if (verifiedSnapshot) {
            this.rememberVolumeSnapshot(verifiedSnapshot);
            await this.appendDebugTrace("speaker_mute_soft_volume_verified", {
                requestedMuted: muted,
                observedMuted: verifiedSnapshot.muted === true,
                observedPercent: verifiedSnapshot.percent,
                observedRaw: verifiedSnapshot.raw,
                observedSource: verifiedSnapshot.source,
                deviceId: device.minaDeviceId,
            });
            if (muted && verifiedSnapshot.muted !== true) {
                await this.updateSpeakerMuteReliability(device, {
                    softMuteUnreliable: true,
                }).catch(() => undefined);
                return false;
            }
            if (!muted && verifiedSnapshot.muted === true) {
                await this.updateSpeakerMuteReliability(device, {
                    softMuteUnreliable: true,
                }).catch(() => undefined);
                await this.appendDebugTrace("speaker_unmute_still_blocked_by_device", {
                    requestedMuted: muted,
                    observedPercent: verifiedSnapshot.percent,
                    observedRaw: verifiedSnapshot.raw,
                    observedSource: verifiedSnapshot.source,
                    deviceId: device.minaDeviceId,
                });
                return false;
            }
            await this.updateSpeakerMuteReliability(device, {
                softMuteUnreliable: false,
            }).catch(() => undefined);
        }

        return true;
    }

    private async silenceSpeaker(options?: {
        aggressive?: boolean;
        reason?: string;
    }) {
        const mode = options?.aggressive ? "fast-stop" : "pause";
        console.log(
            `-> [拦截] 发送 ${mode} 指令${options?.reason ? ` | ${options.reason}` : ""}`
        );
        const startedAt = Date.now();
        const interrupted = options?.aggressive
            ? await this.stopSpeaker({
                fast: true,
                preserveLoopGuard: false,
            }).catch(() => false)
            : await this.pauseSpeaker().catch(() => false);
        console.log(
            `-> [拦截] ${mode} ${interrupted ? "成功" : "失败"} | ${Date.now() - startedAt}ms`
        );
        return interrupted;
    }

    private async sendTransitionPrompt() {
        const phrases = normalizeTransitionPhrasesInput(this.config?.transitionPhrases, {
            fallbackToDefault: true,
        });
        const phrase =
            phrases[Math.floor(Math.random() * phrases.length)] ||
            DEFAULT_TRANSITION_PHRASES[0];
        console.log(`-> [占位] 播报: "${phrase}"`);
        await this.playText(phrase);
    }

    private summarizeCliOutput(text: string, maxChars = 180) {
        const normalized = text.replace(/\s+/g, " ").trim();
        if (!normalized || /^[{\[]/.test(normalized)) {
            return "";
        }
        if (normalized.length <= maxChars) {
            return normalized;
        }
        return `${normalized.slice(0, maxChars - 3)}...`;
    }

    private isOpenclawChannelUnavailableError(message: string) {
        const lower = message.toLowerCase();
        return (
            lower.includes("channel is unavailable") ||
            lower.includes("outbound not configured for channel") ||
            lower.includes("unknown channel")
        );
    }

    private clearActiveVoiceAgentRun(runId?: string) {
        if (!runId) {
            this.activeVoiceAgentRuns = [];
        } else {
            this.activeVoiceAgentRuns = this.activeVoiceAgentRuns.filter(
                (item) => item.id !== runId
            );
        }
        this.pendingAgentPromptCount = this.activeVoiceAgentRuns.length;
    }

    private markActiveVoiceAgentSpoken(
        text: string,
        sessionKey = this.openclawVoiceSessionKey
    ) {
        const activeRun =
            this.activeVoiceAgentRuns.find(
                (item) => !item.firstSpeakObserved && item.sessionKey === sessionKey
            ) ||
            this.activeVoiceAgentRuns.find((item) => !item.firstSpeakObserved);
        if (!activeRun || activeRun.firstSpeakObserved) {
            return;
        }

        activeRun.firstSpeakObserved = true;
        const elapsedMs = Date.now() - activeRun.startedAtMs;
        console.log(
            `-> [性能] 首次播报工具触发 | ${elapsedMs}ms | 会话: ${activeRun.sessionKey || "unknown"}`
        );
        void this.appendDebugTrace("voice_first_speak", {
            sessionKey: activeRun.sessionKey,
            elapsedMs,
            text: normalizeEventText(text, 120),
        });
    }

    private normalizeOpenclawReplyPayloads(value: any): OpenclawReplyPayload[] {
        if (!Array.isArray(value)) {
            return [];
        }
        const normalized: OpenclawReplyPayload[] = [];
        for (const item of value) {
            if (!item || typeof item !== "object") {
                continue;
            }
            const text = readString((item as any).text);
            const mediaUrl = normalizeRemoteMediaUrl(readString((item as any).mediaUrl));
            const mediaUrls = Array.isArray((item as any).mediaUrls)
                ? (item as any).mediaUrls
                    .map((entry: any) => normalizeRemoteMediaUrl(readString(entry)))
                    .filter((entry: string | undefined): entry is string => Boolean(entry))
                : [];
            if (!text && !mediaUrl && mediaUrls.length === 0) {
                continue;
            }
            normalized.push({
                text: text || undefined,
                mediaUrl: mediaUrl || null,
                mediaUrls,
            });
        }
        return normalized;
    }

    private async handleOpenclawFinalPayloads(
        activeRun: ActiveVoiceAgentRun,
        payloads: OpenclawReplyPayload[]
    ) {
        if (payloads.length === 0 || activeRun.firstSpeakObserved) {
            return;
        }

        const textReplies = payloads
            .map((payload) => readString(payload.text))
            .filter((item): item is string => Boolean(item));
        const mediaReplies = payloads.flatMap((payload) => {
            const urls = [
                normalizeRemoteMediaUrl(readString(payload.mediaUrl || undefined)),
                ...(Array.isArray(payload.mediaUrls) ? payload.mediaUrls : []),
            ].filter((item): item is string => Boolean(item));
            if (urls.length === 0) {
                return [];
            }
            return [
                {
                    url: urls[0],
                    title: readString(payload.text),
                },
            ];
        });

        if (mediaReplies.length > 0) {
            const first = mediaReplies[0];
            const firstDetail = this.describeAudioReply(first.url, first.title);
            const firstContextTitle =
                this.normalizeAudioReplyTitle(first.title) ||
                this.normalizeAudioReplyTitle(firstDetail) ||
                firstDetail;
            this.markActiveVoiceAgentSpoken(
                firstContextTitle,
                activeRun.sessionKey
            );
            this.waitingForResponse = false;
            let played: Awaited<ReturnType<XiaoaiCloudPlugin["playAudioUrl"]>> | null = null;
            let playbackError = "";
            try {
                played = await this.playAudioUrl(first.url, {
                    title: first.title,
                    interrupt: false,
                    armDialogWindow: true,
                    consoleEventKind: "tool.audio",
                    consoleEventTitle: "OpenClaw 音频回复",
                });
            } catch (error) {
                playbackError = this.errorMessage(error);
                this.recordConsoleEvent(
                    "tool.audio",
                    "OpenClaw 音频回复改为浏览器兜底",
                    firstDetail,
                    "warn",
                    { audioUrl: first.url }
                );
                await this.appendDebugTrace("voice_audio_payload_browser_fallback", {
                    sessionKey: activeRun.sessionKey,
                    url: first.url,
                    title: first.title,
                    reason: playbackError,
                    payloadCount: mediaReplies.length,
                });
            }
            if (firstContextTitle) {
                this.recordVoiceContextTurn(
                    "assistant",
                    firstContextTitle,
                    activeRun.sessionKey
                );
                void this.sendOpenclawNotification(firstContextTitle, "音频回传", {
                    bestEffort: true,
                }).catch(() => undefined);
            }
            if (played) {
                await this.appendDebugTrace("voice_audio_payload_played", {
                    sessionKey: activeRun.sessionKey,
                    url: played.url,
                    title: first.title,
                    payloadCount: mediaReplies.length,
                });
            }
            return;
        }

        if (textReplies.length > 0) {
            const joined = textReplies.join("\n").trim();
            if (!joined) {
                return;
            }
            this.markActiveVoiceAgentSpoken(joined, activeRun.sessionKey);
            this.waitingForResponse = false;
            await this.playText(joined);
            this.lastOpenclawSpeech = {
                text: joined,
                timeMs: Date.now(),
            };
            this.lastOpenclawSpeakTime = Date.now() / 1000;
            this.armDialogWindow(this.lastOpenclawSpeakTime);
            this.recordVoiceContextTurn("assistant", joined, activeRun.sessionKey);
            this.recordConsoleEvent("tool.reply", "OpenClaw 文字回复", joined, "success");
            void this.sendOpenclawNotification(joined, "播报回传", {
                bestEffort: true,
            }).catch(() => undefined);
        }
    }

    private async runOpenclawCli(
        args: string[],
        label: string,
        timeoutMs = 60000
    ) {
        const result = await this.api.runtime.system.runCommandWithTimeout(args, {
            timeoutMs,
        });
        const stdout = readString(result.stdout) || "";
        const stderr = readString(result.stderr) || "";

        if (result.code !== 0) {
            throw new Error(
                stderr.trim() || stdout.trim() || `OpenClaw CLI 退出码 ${result.code}`
            );
        }

        const stdoutSummary = this.summarizeCliOutput(stdout);
        if (stdoutSummary && stdoutSummary !== "completed") {
            console.log(`-> [${label}] CLI 输出: ${stdoutSummary}`);
        }

        const stderrSummary = this.summarizeCliOutput(stderr);
        if (stderrSummary) {
            console.warn(`-> [${label}] CLI 警告: ${stderrSummary}`);
        }

        console.log(`-> [${label}] 已发送到 OpenClaw`);
        return result;
    }

    private resolveOpenclawGatewayWsUrl(globalConfig?: Record<string, any>) {
        const runtimeUrl =
            normalizeWebsocketUrl(readString(this.api?.runtime?.gateway?.url)) ||
            normalizeWebsocketUrl(readString(this.api?.gateway?.url));
        if (runtimeUrl) {
            return runtimeUrl;
        }

        const gatewayConfig = globalConfig?.gateway;
        const configuredUrl =
            normalizeWebsocketUrl(readString(gatewayConfig?.url)) ||
            normalizeWebsocketUrl(readString(gatewayConfig?.publicUrl)) ||
            normalizeWebsocketUrl(readString(gatewayConfig?.externalUrl));
        if (configuredUrl) {
            return configuredUrl;
        }

        const port = clamp(
            Math.round(
                readNumber(gatewayConfig?.port) ||
                    readNumber(gatewayConfig?.publicPort) ||
                    18798
            ),
            1,
            65535
        );
        return `ws://127.0.0.1:${port}`;
    }

    private isOpenclawGatewayReconnectableError(message: string) {
        const lower = message.toLowerCase();
        return (
            lower.includes("gateway not connected") ||
            lower.includes("websocket was closed") ||
            lower.includes("not connected") ||
            lower.includes("closed before the connection was established") ||
            lower.includes("connect challenge timeout")
        );
    }

    private async stopOpenclawGatewayClient() {
        const client = this.openclawGatewayClient;
        this.openclawGatewayClient = undefined;
        this.openclawGatewayClientReady = undefined;
        if (!client) {
            return;
        }
        await client.stopAndWait({ timeoutMs: 5_000 }).catch(() => undefined);
    }

    private async ensureOpenclawGatewayClient(config: PluginConfig) {
        if (this.openclawGatewayClientReady) {
            return this.openclawGatewayClientReady;
        }

        const readyPromise = (async () => {
            const authState = await this.readOpenclawGatewayAuthState();
            const globalConfig = authState.globalConfig;

            const GatewayClient = await loadGatewayClientCtor({
                openclawCliPath: config.openclawCliPath,
            });

            let resolveHello!: (client: GatewayClientLike) => void;
            let rejectHello!: (error: Error) => void;
            let settled = false;
            const helloPromise = new Promise<GatewayClientLike>((resolve, reject) => {
                resolveHello = resolve;
                rejectHello = reject;
            });
            const settleHello = (error?: unknown) => {
                if (settled) {
                    return;
                }
                settled = true;
                if (error) {
                    rejectHello(error instanceof Error ? error : new Error(String(error)));
                    return;
                }
                resolveHello(client);
            };

            const client = new GatewayClient({
                url: this.resolveOpenclawGatewayWsUrl(globalConfig),
                token: authState.token,
                password: authState.password,
                clientName: "gateway-client",
                clientDisplayName: "xiaoai-cloud-plugin",
                clientVersion: "1.0.0",
                mode: "backend",
                role: "operator",
                scopes: ["operator.read", "operator.write"],
                requestTimeoutMs: Math.max(
                    OPENCLAW_AGENT_SUBMIT_TIMEOUT_MS,
                    OPENCLAW_AGENT_WAIT_TIMEOUT_MS
                ),
                onHelloOk: () => {
                    settleHello();
                },
                onConnectError: (error) => {
                    settleHello(error);
                },
                onClose: (code, reason) => {
                    if (!settled) {
                        settleHello(
                            new Error(
                                `OpenClaw Gateway 连接关闭 (${code}${reason ? `: ${reason}` : ""})`
                            )
                        );
                    }
                    if (this.openclawGatewayClient === client) {
                        this.openclawGatewayClient = undefined;
                        this.openclawGatewayClientReady = undefined;
                    }
                },
            });

            this.openclawGatewayClient = client;
            client.start();

            return Promise.race([
                helloPromise,
                new Promise<GatewayClientLike>((_, reject) => {
                    setTimeout(() => {
                        reject(new Error("连接 OpenClaw Gateway 超时。"));
                    }, 10_000);
                }),
            ]);
        })().catch((error) => {
            this.openclawGatewayClient = undefined;
            this.openclawGatewayClientReady = undefined;
            throw error;
        });

        this.openclawGatewayClientReady = readyPromise;
        return readyPromise;
    }

    private async runOpenclawGatewayCall<T>(
        config: PluginConfig,
        method: string,
        params: Record<string, any>,
        label: string,
        options?: {
            timeoutMs?: number;
            expectFinal?: boolean;
        }
    ) {
        const timeoutMs = clamp(
            Math.round(options?.timeoutMs ?? OPENCLAW_AGENT_SUBMIT_TIMEOUT_MS),
            1000,
            OPENCLAW_AGENT_WAIT_TIMEOUT_MS + 60_000
        );
        const execute = async (allowRetry: boolean): Promise<T> => {
            const client = await this.ensureOpenclawGatewayClient(config);
            try {
                const result = await client.request<T>(method, params, {
                    timeoutMs,
                    expectFinal: options?.expectFinal,
                });
                console.log(`-> [${label}] 已发送到 OpenClaw`);
                return result;
            } catch (error) {
                const message = this.errorMessage(error);
                if (allowRetry && this.isOpenclawGatewayReconnectableError(message)) {
                    await this.stopOpenclawGatewayClient();
                    return execute(false);
                }
                throw error;
            }
        };

        return execute(true);
    }

    private async sendOpenclawNotification(
        text: string,
        label = "OpenClaw",
        options?: { bestEffort?: boolean }
    ) {
        const config = await this.loadConfig(false);
        if (config.openclawNotificationsDisabled) {
            return false;
        }
        if (!config.openclawTo) {
            throw new Error("缺少 openclawTo 配置，无法把登录入口或语音转发给 OpenClaw。");
        }

        if (options?.bestEffort && this.notificationChannelUnavailableUntil > Date.now()) {
            return false;
        }

        try {
            await this.runOpenclawCli(
                [
                    config.openclawCliPath,
                    "message",
                    "send",
                    "--channel",
                    config.openclawChannel,
                    "--target",
                    config.openclawTo,
                    "--message",
                    text
                ],
                label
            );
            this.notificationChannelUnavailableUntil = 0;
            this.notificationChannelUnavailableMessage = "";
            return true;
        } catch (error) {
            const message = this.errorMessage(error);
            if (options?.bestEffort && this.isOpenclawChannelUnavailableError(message)) {
                const shouldLog =
                    this.notificationChannelUnavailableUntil <= Date.now() ||
                    this.notificationChannelUnavailableMessage !== message;
                this.notificationChannelUnavailableUntil = Date.now() + 60_000;
                this.notificationChannelUnavailableMessage = message;
                if (shouldLog) {
                    console.warn(`[XiaoAI Cloud] ${label} 已跳过: ${message}`);
                }
                return false;
            }
            throw error;
        }
    }

    private async waitForVoiceAgentRun(
        config: PluginConfig,
        activeRun: ActiveVoiceAgentRun
    ) {
        try {
            const result = await this.runOpenclawGatewayCall<{
                status?: string;
                startedAt?: number;
                endedAt?: number;
                error?: unknown;
            }>(
                config,
                "agent.wait",
                {
                    runId: activeRun.id,
                    timeoutMs: OPENCLAW_AGENT_WAIT_TIMEOUT_MS,
                },
                `${activeRun.label}/等待结束`,
                {
                    timeoutMs: OPENCLAW_AGENT_WAIT_TIMEOUT_MS + 10_000,
                }
            );
            const status = readString(result?.status) || "ok";
            const elapsedMs =
                typeof result?.endedAt === "number" && typeof result?.startedAt === "number"
                    ? Math.max(0, result.endedAt - result.startedAt)
                    : Date.now() - activeRun.startedAtMs;

            if (status === "ok") {
                console.log(
                    `-> [${activeRun.label}] Run 已结束 | ${elapsedMs}ms | 会话: ${activeRun.sessionKey || "default"}`
                );
            } else if (status === "timeout") {
                console.warn(
                    `-> [${activeRun.label}] Run 等待超时 | 会话: ${activeRun.sessionKey || "default"}`
                );
            } else {
                console.warn(
                    `-> [${activeRun.label}] Run 异常结束 | 会话: ${activeRun.sessionKey || "default"} | ${this.errorMessage(result?.error)}`
                );
            }
            if (!activeRun.firstSpeakObserved && activeRun.sessionKey === this.openclawVoiceSessionKey) {
                this.waitingForResponse = false;
            }
        } catch (error) {
            console.warn(
                `-> [${activeRun.label}] Run 收尾失败: ${this.errorMessage(error)}`
            );
            if (!activeRun.firstSpeakObserved && activeRun.sessionKey === this.openclawVoiceSessionKey) {
                this.waitingForResponse = false;
            }
        } finally {
            this.clearActiveVoiceAgentRun(activeRun.id);
        }
    }

    private buildOpenclawResponsesInput(text: string, config: PluginConfig) {
        const trimmed = text.trim();
        if (!config.openclawThinkingOff) {
            return trimmed;
        }
        if (/^\/(?:t|think|thinking)\b/i.test(trimmed)) {
            return trimmed;
        }
        return trimmed ? `/thinking off\n${trimmed}` : "/thinking off";
    }

    private extractOpenclawResponsesOutputText(value: any): string | undefined {
        const direct = readString(value?.output_text);
        if (direct) {
            return direct;
        }

        const fragments: string[] = [];
        const appendText = (input: any) => {
            const text = pickFirstString(
                readString(input?.text),
                readString(input?.content),
                readString(input?.value)
            );
            if (text) {
                fragments.push(text);
            }
        };

        const outputItems = Array.isArray(value?.output) ? value.output : [];
        for (const item of outputItems) {
            const itemType = readString(item?.type);
            if (itemType === "message") {
                const contentItems = Array.isArray(item?.content) ? item.content : [];
                for (const contentItem of contentItems) {
                    const contentType = readString(contentItem?.type);
                    if (contentType === "output_text" || contentType === "text") {
                        appendText(contentItem);
                    }
                }
                continue;
            }
            if (itemType === "output_text" || itemType === "text") {
                appendText(item);
            }
        }

        const joined = fragments.join("\n").trim();
        return joined || undefined;
    }

    private normalizeOpenclawResponsesReplyPayloads(value: any): OpenclawReplyPayload[] {
        const text = this.extractOpenclawResponsesOutputText(value);
        return text ? [{ text }] : [];
    }

    private async computeOpenclawGatewayHttpBaseUrls(
        globalConfig?: Record<string, any>
    ) {
        const urls = await discoverGatewayBaseUrls(this.api);
        const fallback = websocketUrlToHttp(
            this.resolveOpenclawGatewayWsUrl(globalConfig)
        );
        return uniqueStrings([
            ...urls,
            fallback || "",
        ]);
    }

    private async deliverAgentPromptViaResponsesApi(
        config: PluginConfig,
        text: string,
        label: string,
        activeRun: ActiveVoiceAgentRun
    ) {
        const authState = await this.readOpenclawGatewayAuthState();
        if (!this.readOpenclawResponsesEndpointEnabled(authState.globalConfig)) {
            throw new Error(
                "OpenClaw Responses HTTP 端点尚未启用，请先打开“强制走非流式请求”并等待网关重启完成。"
            );
        }

        const baseUrls = await this.computeOpenclawGatewayHttpBaseUrls(authState.globalConfig);
        if (baseUrls.length === 0) {
            throw new Error("没有找到可用的 OpenClaw Gateway HTTP 地址，无法走官方非流式接口。");
        }

        const agentId = readString(config.openclawAgent) || "main";
        const requestBody = {
            model: agentId.startsWith("openclaw:") ? agentId : `openclaw:${agentId}`,
            input: this.buildOpenclawResponsesInput(text, config),
            stream: false,
            ...(activeRun.sessionKey ? { user: activeRun.sessionKey } : {}),
        };
        let lastError: Error | undefined;

        for (const baseUrl of baseUrls) {
            const endpointUrl = `${baseUrl.replace(/\/+$/, "")}/v1/responses`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => {
                controller.abort();
            }, OPENCLAW_AGENT_WAIT_TIMEOUT_MS + 10_000);
            try {
                const response = await fetch(endpointUrl, {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${authState.bearerSecret}`,
                        "Content-Type": "application/json",
                        "x-openclaw-agent-id": agentId,
                        ...(activeRun.sessionKey
                            ? { "x-openclaw-session-key": activeRun.sessionKey }
                            : {}),
                    },
                    body: JSON.stringify(requestBody),
                    signal: controller.signal,
                });
                const rawBody = await response.text().catch(() => "");
                let parsedBody: any;
                if (rawBody) {
                    try {
                        parsedBody = JSON.parse(rawBody);
                    } catch {
                        parsedBody = undefined;
                    }
                }
                if (!response.ok) {
                    const detail =
                        pickFirstString(
                            readString(parsedBody?.error?.message),
                            readString(parsedBody?.message),
                            rawBody
                        ) || `HTTP ${response.status}`;
                    if (response.status === 404) {
                        throw new Error(
                            "OpenClaw Responses HTTP 端点未启用，请等待网关重启完成后再试。"
                        );
                    }
                    throw new Error(`HTTP ${response.status}: ${detail}`);
                }

                const result =
                    parsedBody ??
                    (rawBody
                        ? readJsonObject<Record<string, any>>(rawBody, "OpenClaw 非流式接口")
                        : {});
                console.log(`-> [${label}] 已走 OpenClaw 官方非流式 /v1/responses`);
                return this.normalizeOpenclawResponsesReplyPayloads(result);
            } catch (error) {
                lastError = new Error(
                    `${endpointUrl} 调用失败: ${this.errorMessage(error)}`
                );
            } finally {
                clearTimeout(timeoutId);
            }
        }

        throw lastError || new Error("OpenClaw 官方非流式接口调用失败。");
    }

    private async deliverAgentPrompt(
        text: string,
        label = "OpenClaw",
        options?: { sessionKey?: string }
    ) {
        const config = await this.loadConfig(false);
        const startedAtMs = Date.now();
        const sessionKey = readString(options?.sessionKey);
        const queuedAhead = sessionKey
            ? this.activeVoiceAgentRuns.filter((item) => item.sessionKey === sessionKey).length
            : this.activeVoiceAgentRuns.length;
        if (queuedAhead > 0) {
            console.log(
                `-> [${label}] 已交给 OpenClaw 官方会话队列，当前会话前方还有 ${queuedAhead} 条`
            );
        }

        const params: Record<string, any> = {
            message: text,
            timeout: Math.ceil(OPENCLAW_AGENT_WAIT_TIMEOUT_MS / 1000),
            idempotencyKey: randomBytes(12).toString("hex"),
        };
        const activeRun: ActiveVoiceAgentRun = {
            id: params.idempotencyKey,
            label,
            sessionKey,
            startedAtMs,
            firstSpeakObserved: false,
        };
        this.activeVoiceAgentRuns.push(activeRun);
        this.pendingAgentPromptCount = this.activeVoiceAgentRuns.length;

        if (config.openclawAgent) {
            params.agentId = config.openclawAgent;
        }
        if (sessionKey) {
            params.sessionKey = sessionKey;
        }
        if (config.openclawThinkingOff) {
            params.thinking = "off";
        }
        try {
            const payloads = config.openclawForceNonStreaming
                ? await this.deliverAgentPromptViaResponsesApi(
                    config,
                    text,
                    label,
                    activeRun
                )
                : await (async () => {
                    const result = await this.runOpenclawGatewayCall<OpenclawAgentFinalResult>(
                        config,
                        "agent",
                        params,
                        label,
                        {
                            timeoutMs: OPENCLAW_AGENT_WAIT_TIMEOUT_MS + 10_000,
                            expectFinal: true,
                        }
                    );
                    const runId = readString(result?.runId);
                    if (runId) {
                        activeRun.id = runId;
                    }

                    const elapsedMs = Date.now() - startedAtMs;
                    const status = readString(result?.status) || "ok";
                    if (status === "ok") {
                        console.log(
                            `-> [${label}] Run 已结束 | ${elapsedMs}ms | 会话: ${activeRun.sessionKey || "default"}`
                        );
                    } else {
                        console.warn(
                            `-> [${label}] Run 结束状态: ${status} | ${elapsedMs}ms | 会话: ${activeRun.sessionKey || "default"}`
                        );
                    }
                    return this.normalizeOpenclawReplyPayloads(result?.result?.payloads);
                })();

            if (config.openclawForceNonStreaming) {
                const elapsedMs = Date.now() - startedAtMs;
                console.log(
                    `-> [${label}] 非流式请求已结束 | ${elapsedMs}ms | 会话: ${activeRun.sessionKey || "default"}`
                );
            }
            await this.handleOpenclawFinalPayloads(activeRun, payloads);
            if (!activeRun.firstSpeakObserved && activeRun.sessionKey === this.openclawVoiceSessionKey) {
                this.waitingForResponse = false;
            }
        } catch (error) {
            if (!activeRun.firstSpeakObserved && activeRun.sessionKey === this.openclawVoiceSessionKey) {
                this.waitingForResponse = false;
            }
            throw error;
        } finally {
            this.clearActiveVoiceAgentRun(activeRun.id);
        }
    }

    private forwardToOpenclaw(text: string, options?: { renewVoiceSession?: boolean }) {
        const sessionKey = this.resolveOpenclawVoiceSessionKey(Boolean(options?.renewVoiceSession));
        const sessionNotice = this.buildVoiceSessionNotice(options);
        const contextPrompt = this.buildVoiceContextPrompt(sessionKey);
        const prompt = [sessionNotice, contextPrompt, text].filter(Boolean).join("\n\n");

        console.log(`-> [传给大脑] 原始文本: ${text} | 会话: ${sessionKey}`);
        this.recordVoiceContextTurn("user", text, sessionKey);
        void this.deliverAgentPrompt(prompt, "传给大脑", {
            sessionKey,
        }).catch((error) => {
            this.waitingForResponse = false;
            console.error(`[OpenClaw异常] CLI 执行失败: ${this.errorMessage(error)}`);
        });
    }

    private async interceptAndForward(
        text: string,
        options?: {
            renewVoiceSession?: boolean;
            interceptHint?: ConversationInterceptHint;
        }
    ) {
        const interceptStartedAtMs = Date.now();
        this.waitingForResponse = true;
        this.armFastPolling();
        const deviceId = this.device?.minaDeviceId;
        const interceptHint = options?.interceptHint;
        if (deviceId) {
            this.noteConversationInterceptLateRecord(
                deviceId,
                Boolean(interceptHint?.answersPresent)
            );
        }
        const guardPlan = this.buildConversationInterceptGuardPlan(
            deviceId,
            interceptHint
        );
        void this.appendDebugTrace("conversation_intercept_guard_plan", {
            deviceId,
            answersPresent: Boolean(interceptHint?.answersPresent),
            answerCount: readNumber(interceptHint?.answerCount) || 0,
            recordAgeMs: readNumber(interceptHint?.recordAgeMs) || undefined,
            aggressive: guardPlan.aggressive,
            silenceMode: guardPlan.silenceMode,
            manualOffsetMs: guardPlan.manualOffsetMs,
            estimatedSpeechOnsetMs: guardPlan.estimatedSpeechOnsetMs,
            primaryLeadReserveMs: guardPlan.primaryLeadReserveMs,
            primarySilenceDelayMs: guardPlan.primarySilenceDelayMs,
            guardDelaysMs: guardPlan.guardDelaysMs,
            lateRecordFollowUpDelayMs: guardPlan.lateRecordFollowUpDelayMs,
            runtimeMonitorPollMs: guardPlan.runtimeMonitorPollMs,
            runtimeMonitorDurationMs: guardPlan.runtimeMonitorDurationMs,
        }).catch(() => undefined);
        const shouldRunFallbackPauseGuard = Boolean(
            deviceId &&
                (this.shouldRunConversationInterceptPauseGuard(deviceId) ||
                    guardPlan.aggressive ||
                    interceptHint?.answersPresent)
        );
        const lateRecordForwarding = this.evaluateLateRecordForwarding(
            deviceId,
            interceptHint,
            guardPlan
        );
        const supplementalGuardState: ConversationInterceptSupplementalGuardState = {
            attemptsUsed: 0,
            lastAttemptAtMs: 0,
        };
        const actionContextPromise =
            shouldRunFallbackPauseGuard ? this.ensureActionContext() : undefined;

        const silenceTask = (async () => {
            const waitMs =
                interceptStartedAtMs + guardPlan.primarySilenceDelayMs - Date.now();
            if (waitMs > 0) {
                await sleep(waitMs);
            }
            if (!this.waitingForResponse) {
                return false;
            }
            return this.silenceSpeaker({
                aggressive: guardPlan.silenceMode === "fast-stop",
                reason: lateRecordForwarding.skip
                    ? lateRecordForwarding.reason
                    : interceptHint?.answersPresent
                        ? "检测到会话记录已带答案，立即强拦截并准备转发 OpenClaw"
                    : guardPlan.primarySilenceDelayMs > 0
                        ? `按预计原生起播窗口延后 ${guardPlan.primarySilenceDelayMs}ms 拦截`
                        : guardPlan.aggressive
                            ? "当前设备进入动态激进拦截"
                            : undefined,
            }).catch((error) => {
                console.error(`[XiaoAI Cloud] 暂停打断失败: ${this.errorMessage(error)}`);
                return false;
            });
        })();
        const fallbackPauseGuardTask =
            shouldRunFallbackPauseGuard && this.waitingForResponse
                ? this.runConversationInterceptFallbackPauseGuard(
                    interceptStartedAtMs,
                    actionContextPromise,
                    guardPlan,
                    supplementalGuardState
                ).catch((error) => {
                    console.warn(
                        `[XiaoAI Cloud] fallback 拦截补偿失败: ${this.errorMessage(error)}`
                    );
                })
                : Promise.resolve();
        const lateRecordFollowUpTask =
            shouldRunFallbackPauseGuard &&
            this.waitingForResponse &&
            interceptHint?.answersPresent
                ? this.runConversationInterceptLateRecordFollowUpBurst(
                    interceptStartedAtMs,
                    actionContextPromise,
                    guardPlan,
                    supplementalGuardState
                ).catch((error) => {
                    console.warn(
                        `[XiaoAI Cloud] 晚记录快速补拦截失败: ${this.errorMessage(error)}`
                    );
                })
                : Promise.resolve();
        const runtimeMonitorTask =
            shouldRunFallbackPauseGuard && this.waitingForResponse
                ? this.runConversationInterceptRuntimeMonitor(
                    interceptStartedAtMs,
                    guardPlan,
                    actionContextPromise,
                    supplementalGuardState
                ).catch((error) => {
                    console.warn(
                        `[XiaoAI Cloud] 运行时拦截监测失败: ${this.errorMessage(error)}`
                    );
                })
                : Promise.resolve();
        const shouldGateLateRecordForward = Boolean(
            interceptHint?.answersPresent &&
                lateRecordForwarding.deferUntilSilenced !== true
        );
        const lateRecordForwardGateTask = shouldGateLateRecordForward
            ? this.confirmLateRecordForwardAllowed(
                actionContextPromise,
                guardPlan
            ).catch((error) => {
                console.warn(
                    `[XiaoAI Cloud] 晚记录转发门控失败: ${this.errorMessage(error)}`
                );
                return false;
            })
            : Promise.resolve(false);
        void this.appendDebugTrace("conversation_intercept_forward_policy", {
            deviceId,
            answersPresent: Boolean(interceptHint?.answersPresent),
            answerCount: readNumber(interceptHint?.answerCount) || 0,
            recordAgeMs: readNumber(interceptHint?.recordAgeMs) || undefined,
            manualOffsetMs: guardPlan.manualOffsetMs,
            skip: lateRecordForwarding.skip,
            deferUntilSilenced:
                lateRecordForwarding.deferUntilSilenced === true || undefined,
            reason: lateRecordForwarding.reason || undefined,
            cutoffMs: lateRecordForwarding.cutoffMs || undefined,
            gated: shouldGateLateRecordForward,
        }).catch(() => undefined);
        let forwardIssued = false;
        const issueForwardOnce = (trigger: string) => {
            if (forwardIssued || !this.waitingForResponse) {
                return false;
            }
            this.forwardToOpenclaw(text, options);
            forwardIssued = true;
            void this.appendDebugTrace("conversation_intercept_forward_issued", {
                deviceId,
                trigger,
                answersPresent: Boolean(interceptHint?.answersPresent),
                answerCount: readNumber(interceptHint?.answerCount) || 0,
                recordAgeMs: readNumber(interceptHint?.recordAgeMs) || undefined,
                manualOffsetMs: guardPlan.manualOffsetMs,
                deferUntilSilenced:
                    lateRecordForwarding.deferUntilSilenced === true || undefined,
            }).catch(() => undefined);
            return true;
        };
        const lateRecordForwardGateRunner = shouldGateLateRecordForward
            ? lateRecordForwardGateTask.then((lateRecordForwardAllowed) => {
                if (lateRecordForwardAllowed) {
                    issueForwardOnce("late_record_gate_open");
                }
                return lateRecordForwardAllowed;
            })
            : Promise.resolve(false);
        if (!interceptHint?.answersPresent) {
            issueForwardOnce("immediate");
        }
        await silenceTask;
        if (!forwardIssued) {
            issueForwardOnce(
                interceptHint?.answersPresent
                    ? lateRecordForwarding.deferUntilSilenced
                        ? "speaker_silenced_immediate_forward"
                        : "late_record_gate_closed_immediate_forward"
                    : "post_silence_fallback"
            );
        }
        if (!forwardIssued) {
            this.waitingForResponse = false;
            return;
        }
        await Promise.all([
            lateRecordForwardGateRunner,
            lateRecordFollowUpTask,
            fallbackPauseGuardTask,
            runtimeMonitorTask,
        ]);
        if (!this.waitingForResponse) {
            return;
        }
        await this.maybeSendConversationTransitionPrompt(
            interceptStartedAtMs,
            guardPlan,
            actionContextPromise
        ).catch((error) => {
            console.error(`[XiaoAI Cloud] 过渡播报失败: ${this.errorMessage(error)}`);
        });
    }

    private registerPluginTools() {
        this.api.registerTool({
            name: "xiaoai_speak",
            description: "通过本地小爱音箱播报语音内容。参数 text 是你要大声说出的中文文本。",
            parameters: schemaObject({
                text: schemaString({ description: "要播报给用户的中文文本" }),
            }),
            execute: async (_id: string, params: { text: string }) => {
                console.log(`<- [播报指令/云端] ${params.text}`);
                this.markActiveVoiceAgentSpoken(params.text);
                this.waitingForResponse = false;
                await this.finalizeSpokenToolReply(params.text, {
                    consoleEventKind: "tool.speak",
                    consoleEventTitle: "OpenClaw 让小爱播报",
                    notificationLabel: "播报回传",
                });
                return { content: [{ type: "text", text: `[SYSTEM]播报完成: ${params.text}` }] };
            },
        });

        this.api.registerTool({
            name: "xiaoai_play_audio",
            description:
                "通过小爱音箱播放一个可直接访问的音频 URL。插件会先在本地尽量标准化为统一 MP3 音频，再交给小爱播放。",
            parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                    url: schemaString({ description: "要播放的 http/https 音频 URL" }),
                    title: schemaString({
                        description: "可选。给这段音频起一个短标题，方便日志和控制台显示。",
                    }),
                },
                required: ["url"],
            },
            execute: async (
                _id: string,
                params: { url: string; title: string }
            ) => {
                const url = normalizeRemoteMediaUrl(params.url);
                if (!url) {
                    return {
                        content: [{
                            type: "text",
                            text: "[SYSTEM]音频播放失败：只支持可直接访问的 http/https 音频 URL。",
                        }],
                    };
                }
                console.log(`<- [音频播放/云端] ${url}`);
                this.waitingForResponse = false;
                const played = await this.playAudioUrl(url, {
                    title: readString(params.title),
                    interrupt: false,
                    armDialogWindow: true,
                    consoleEventKind: "tool.audio",
                    consoleEventTitle: "OpenClaw 让小爱播放音频",
                });
                return {
                    content: [{
                        type: "text",
                        text: `[SYSTEM]音频已开始播放: ${played.detail}`,
                    }],
                };
            },
        });

        this.api.registerTool({
            name: "xiaoai_tts_bridge",
            description:
                "使用 OpenClaw 官方 runtime.tts 把文本先合成为音频，再通过小爱音箱播放。适合想走统一 TTS 音频链路，而不是直接文本播报的场景。",
            parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                    text: schemaString({ description: "要合成并播放的文本内容" }),
                    title: schemaString({
                        description: "可选。给这段 TTS 音频起一个短标题，方便日志和控制台显示。",
                    }),
                },
                required: ["text"],
            },
            execute: async (
                _id: string,
                params: { text: string; title?: string }
            ) => {
                const text = readString(params.text);
                if (!text) {
                    return {
                        content: [{
                            type: "text",
                            text: "[SYSTEM]TTS 桥接失败：text 不能为空。",
                        }],
                    };
                }
                console.log(`<- [TTS桥接/云端] ${text}`);
                this.markActiveVoiceAgentSpoken(text);
                this.waitingForResponse = false;
                try {
                    const playbackUrl = await this.synthesizeOpenclawTtsToRelayUrl(text, {
                        title: params.title || text,
                    });
                    const played = await this.playAudioUrl(playbackUrl, {
                        title: readString(params.title) || text,
                        interrupt: false,
                        armDialogWindow: true,
                        consoleEventKind: "tool.tts-audio",
                        consoleEventTitle: "OpenClaw TTS 桥接播放",
                    });
                    return {
                        content: [{
                            type: "text",
                            text: `[SYSTEM]TTS 音频已开始播放: ${played.detail}`,
                        }],
                    };
                } catch (error) {
                    const reason = this.errorMessage(error);
                    await this.appendDebugTrace("tts_bridge_fallback_to_speak", {
                        text,
                        title: readString(params.title) || text,
                        reason,
                    });
                    this.recordConsoleEvent(
                        "tool.tts-audio",
                        "OpenClaw TTS 桥接改为文本播报",
                        reason,
                        "warn"
                    );
                    await this.finalizeSpokenToolReply(text, {
                        consoleEventKind: "tool.speak",
                        consoleEventTitle: "OpenClaw TTS 桥接改为文本播报",
                        notificationLabel: "播报回传",
                    });
                    return {
                        content: [{
                            type: "text",
                            text: `[SYSTEM]TTS 音频链路不可用，已自动改为文本播报: ${text}`,
                        }],
                    };
                }
            },
        });

        this.api.registerTool({
            name: "xiaoai_set_volume",
            description: "设置小爱音箱播放音量(0-100)。只改音量数值，不会自动切换播放静音。",
            parameters: schemaObject({
                volume: schemaNumber({ description: "音量百分比(0-100)" }),
            }),
            execute: async (_id: string, params: { volume: number }) => {
                const pct = clamp(Math.round(params.volume), 0, 100);
                console.log(`<- [音量控制/云端] 设置: ${pct}%`);
                const ok = await this.runSpeakerControlMutation("volume", pct, () =>
                    this.setVolumePercent(pct)
                );
                const label = `播放音量已设为 ${pct}%`;
                this.recordConsoleEvent(
                    "tool.volume",
                    "调整音量",
                    label,
                    ok ? "success" : "error"
                );
                return {
                    content: [{ type: "text", text: ok ? `[SYSTEM]${label}` : "[SYSTEM]音量设置失败" }],
                };
            },
        });

        this.api.registerTool({
            name: "xiaoai_set_playback_mute",
            description:
                "切换小爱音箱的播放静音开关。它影响音频播放链路，不等同于对话播报音量。",
            parameters: schemaObject({
                muted: schemaBoolean({ description: "true 为打开播放静音，false 为关闭播放静音" }),
            }),
            execute: async (_id: string, params: { muted: boolean }) => {
                const muted = Boolean(params.muted);
                const storedMuteState = await this.getStoredSpeakerMuteState(this.device).catch(
                    () => ({} as PersistedSpeakerMuteState)
                );
                if (!this.isSpeakerMuteControlSupportedFor(this.device, storedMuteState)) {
                    const errorLabel =
                        "当前设备不支持可靠的播放静音控制。设备静音链路和软静音链路都已验证为不可靠，已禁用该开关";
                    this.recordConsoleEvent(
                        "tool.mute",
                        "切换播放静音",
                        errorLabel,
                        "error"
                    );
                    return {
                        content: [{
                            type: "text",
                            text: `[SYSTEM]${errorLabel}`,
                        }],
                    };
                }
                console.log(`<- [播放静音/云端] 设置: ${muted ? "开启" : "关闭"}`);
                const ok = await this.runSpeakerControlMutation("mute", muted, () =>
                    this.setSpeakerMuted(muted)
                );
                const label = muted ? "已打开播放静音" : "已关闭播放静音";
                const errorLabel = muted
                    ? "播放静音设置失败"
                    : "关闭播放静音未生效，设备真实回读仍显示为已开启，需在音箱侧手动解除一次";
                this.recordConsoleEvent(
                    "tool.mute",
                    "切换播放静音",
                    ok ? label : errorLabel,
                    ok ? "success" : "error"
                );
                return {
                    content: [{
                        type: "text",
                        text: ok ? `[SYSTEM]${label}` : `[SYSTEM]${errorLabel}`,
                    }],
                };
            },
        });

        this.api.registerTool({
            name: "xiaoai_get_volume",
            description: "获取小爱音箱当前播放音量、播放静音状态和设备状态。",
            parameters: schemaObject({}),
            execute: async () => {
                console.log("<- [状态查询/云端] 获取音量");
                const snapshot = await this.getVolumeSnapshot();
                if (!snapshot) {
                    return {
                        content: [{ type: "text", text: "[SYSTEM]设备在线，但暂时无法读取音量。" }],
                    };
                }
                if (snapshot.percent > 0) {
                    this.lastNonZeroVolume = snapshot.percent;
                }
                const isMuted = snapshot.muted === true;
                return {
                    content: [{
                        type: "text",
                        text:
                            `[SYSTEM]查询成功。\n当前播放音量: ${snapshot.percent}%${snapshot.pending ? "（设备状态同步中）" : ""}\n` +
                            `播放静音: ${isMuted ? "已开启" : "已关闭"}\n` +
                            `上次记忆非零音量: ${this.lastNonZeroVolume}%`,
                    }],
                };
            },
        });

        this.api.registerTool({
            name: "xiaoai_new_session",
            description:
                "重置小爱语音入口的上下文，并让下一次通过小爱进入的 OpenClaw 对话切换到新的会话。",
            parameters: schemaObject({}),
            execute: async () => {
                const previousSessionKey = this.openclawVoiceSessionKey;
                const nextSessionKey = this.resolveOpenclawVoiceSessionKey(true);
                console.log(
                    `<- [新会话/云端] ${previousSessionKey || "未建立"} -> ${nextSessionKey}`
                );
                this.recordConsoleEvent(
                    "tool.new_session",
                    "开启新会话",
                    previousSessionKey && previousSessionKey !== nextSessionKey
                        ? `${previousSessionKey} -> ${nextSessionKey}`
                        : nextSessionKey,
                    "success"
                );
                return {
                    content: [{
                        type: "text",
                        text:
                            "[SYSTEM]已为小爱语音入口开启新的 OpenClaw 会话。后续通过小爱说话时，会从新的上下文开始。",
                    }],
                };
            },
        });

        this.api.registerTool({
            name: "xiaoai_wake_up",
            description: "远程唤醒小爱音箱，效果等同于说唤醒词。",
            parameters: schemaObject({}),
            execute: async () => {
                console.log("<- [唤醒/云端] 远程唤醒小爱");
                const ok = await this.wakeUpSpeaker();
                this.recordConsoleEvent(
                    "tool.wake",
                    "远程唤醒",
                    ok ? "已发送唤醒指令。" : "唤醒失败。",
                    ok ? "success" : "error"
                );
                return {
                    content: [{
                        type: "text",
                        text: ok
                            ? "[SYSTEM]唤醒指令已发送。"
                            : "[SYSTEM]唤醒失败。",
                    }],
                };
            },
        });

        this.api.registerTool({
            name: "xiaoai_execute",
            description: "向小爱音箱发送一条执行指令，由小爱本地系统执行。",
            parameters: schemaObject({
                command: schemaString({ description: "要让小爱执行的中文指令" }),
            }),
            execute: async (_id: string, params: { command: string }) => {
                console.log(`<- [转发小爱/云端] 执行指令: ${params.command}`);
                this.waitingForResponse = false;
                const ok = await this.executeDirective(params.command, false);
                this.recordConsoleEvent(
                    "tool.execute",
                    "发给小爱执行",
                    params.command,
                    ok ? "success" : "error"
                );
                return {
                    content: [{
                        type: "text",
                        text: ok
                            ? `[SYSTEM]指令已发送给小爱执行: ${params.command}`
                            : `[SYSTEM]指令发送失败: ${params.command}`,
                    }],
                };
            },
        });

        this.api.registerTool({
            name: "xiaoai_set_mode",
            description:
                "切换插件工作模式。\n" +
                "- wake：用户说唤醒词后才接管，对话窗口内免唤醒。\n" +
                "- proxy：完全接管所有语音。\n" +
                "- silent：完全不接管，只保留主动播报。",
            parameters: schemaObject({
                mode: schemaUnion([
                    schemaLiteral("wake"),
                    schemaLiteral("proxy"),
                    schemaLiteral("silent"),
                ]),
            }),
            execute: async (_id: string, params: { mode: InterceptMode }) => {
                const oldMode = this.currentMode;
                const modeNames: Record<InterceptMode, string> = {
                    wake: "唤醒模式",
                    proxy: "代理模式",
                    silent: "静默模式",
                };
                if (params.mode === oldMode) {
                    return {
                        content: [{
                            type: "text",
                            text: `[SYSTEM]当前已经是「${modeNames[oldMode]}」`,
                        }],
                    };
                }

                this.applyInterceptMode(params.mode);

                console.log(`<- [模式切换/云端] ${modeNames[oldMode]} → ${modeNames[this.currentMode]}`);
                this.recordConsoleEvent(
                    "tool.mode",
                    "切换工作模式",
                    `${modeNames[oldMode]} -> ${modeNames[this.currentMode]}`,
                    "success"
                );
                return {
                    content: [{
                        type: "text",
                        text: `[SYSTEM]模式已从「${modeNames[oldMode]}」切换到「${modeNames[this.currentMode]}」`,
                    }],
                };
            },
        });

        this.api.registerTool({
            name: "xiaoai_set_wake_word",
            description:
                "修改插件当前使用的唤醒词规则。pattern 可以直接写固定短语，也可以写正则源码；如果只是普通文字，插件会自动按字面匹配。",
            parameters: schemaObject({
                pattern: schemaString({
                    description: "新的唤醒词短语或正则源码，例如“小爱同学”或“小[虾瞎侠下夏霞]”",
                }),
            }),
            execute: async (_id: string, params: { pattern: string }) => {
                const result = await this.updateWakeWordPattern(params.pattern);
                console.log(
                    `<- [唤醒词/云端] ${result.previousPattern} → ${result.pattern}`
                );
                this.recordConsoleEvent(
                    "tool.wake_word",
                    "修改唤醒词",
                    `${result.previousPattern} -> ${result.pattern}`,
                    "success"
                );
                return {
                    content: [{
                        type: "text",
                        text: result.changed
                            ? `[SYSTEM]唤醒词已更新为: ${result.pattern}`
                            : `[SYSTEM]当前唤醒词保持不变: ${result.pattern}`,
                    }],
                };
            },
        });

        this.api.registerTool({
            name: "xiaoai_get_status",
            description: "获取当前插件完整状态，包括设备、模式、登录入口与会话监听状态。",
            parameters: schemaObject({}),
            execute: async () => {
                await this.ensureReady().catch((error) => {
                    this.lastError = this.errorMessage(error);
                    return undefined;
                });
                const config = await this.loadConfig(false).catch(() => this.config);
                const openclawAgentState = config
                    ? await this.queryOpenclawAgentModelState(config).catch(() => undefined)
                    : undefined;
                const session = this.getLoginSessionSnapshot();
                const helperStatus = await this.getMicoapiHelperStatus(config);
                const consoleUrl = await this.getConsoleEntryUrl().catch(() => undefined);
                const modeNames: Record<InterceptMode, string> = {
                    wake: "唤醒模式",
                    proxy: "代理模式",
                    silent: "静默模式",
                };
                const deviceLabel = this.device
                    ? `${this.device.name} (${this.device.hardware}/${this.device.model})`
                    : "未初始化";
                const elapsed =
                    this.lastOpenclawSpeakTime > 0
                        ? `${((Date.now() / 1000) - this.lastOpenclawSpeakTime).toFixed(0)}秒前`
                        : "从未播报";
                const lastConversation =
                    this.lastConversationTimestamp > 0
                        ? new Date(this.lastConversationTimestamp).toISOString()
                        : "暂无";
                const loginState = this.device
                    ? "已就绪"
                    : session
                        ? `待处理 (${session.status})`
                        : this.initPromise
                            ? "初始化中"
                            : "未就绪";

                return {
                    content: [{
                        type: "text",
                        text:
                            `[SYSTEM]插件状态:\n` +
                            `当前模式: ${modeNames[this.currentMode]} (${this.currentMode})\n` +
                            `初始化状态: ${loginState}\n` +
                            `账号: ${maskAccountLabel(config?.account) || "未保存"}\n` +
                            `云端区域: ${config?.serverCountry || "?"}\n` +
                            `OpenClaw 路由: ${(openclawAgentState?.agentId || config?.openclawAgent || "main")} -> ${config?.openclawChannel || "?"}/${config?.openclawNotificationsDisabled ? "已关闭通知" : config?.openclawTo || "未配置"}\n` +
                            `打开思考: ${config?.openclawThinkingOff ? "关闭" : "打开"}\n` +
                            `强制非流式: ${config?.openclawForceNonStreaming ? "开启" : "关闭"}\n` +
                            `xiaoai agent 上下文窗口: ${openclawAgentState?.contextTokens || "跟随 OpenClaw 默认"} tokens\n` +
                            `micoapi 辅助: ${this.formatMicoapiHelperStatus(helperStatus)}\n` +
                            `调试日志: ${(config?.debugLogEnabled ?? DEFAULT_DEBUG_LOG_ENABLED) ? "开启" : "关闭"} (${config?.debugLogPath || "?"})\n` +
                            `唤醒词规则: ${this.wakeWordPatternSource || config?.wakeWordPattern || DEFAULT_WAKE_WORD_PATTERN}\n` +
                            `对话窗口: ${this.continuousDialogWindow}秒\n` +
                            `轮询间隔: ${config?.pollIntervalMs ?? "?"}ms\n` +
                            `目标设备: ${deviceLabel}\n` +
                            `语音会话: ${this.openclawVoiceSessionKey || "未建立（首次对话时自动创建）"}\n` +
                            `上次播报: ${elapsed}\n` +
                            `最近识别记录: ${lastConversation}\n` +
                            `等待回答: ${this.waitingForResponse ? "是" : "否"}\n` +
                            `进行中语音 run: ${this.pendingAgentPromptCount} 条\n` +
                            `音量缓存: ${this.lastNonZeroVolume}%\n` +
                            `最近错误: ${this.lastError || "无"}` +
                            (consoleUrl ? `\n控制台: ${consoleUrl}` : "") +
                            (session
                                ? `\n登录入口: ${session.primaryUrl}\n过期时间: ${session.expiresAt}`
                                : ""),
                    }],
                };
            },
        });

        this.api.registerTool({
            name: "xiaoai_login_begin",
            description: "生成新的小米登录入口，并通过 OpenClaw 再次发给用户。",
            parameters: schemaObject({}),
            execute: async () => {
                const session = await this.ensureLoginSession(true);
                await this.announceLoginSession(session, "用户手动触发登录入口", true);
                return {
                    content: [{
                        type: "text",
                        text:
                            `[SYSTEM]新的登录入口已生成并转发给用户。\n` +
                            `登录地址: ${session.primaryUrl}`,
                    }],
                };
            },
        });

        this.api.registerTool({
            name: "xiaoai_login_status",
            description: "查看当前登录会话状态。如果还没有登录会话，会自动生成一个。",
            parameters: schemaObject({}),
            execute: async () => {
                const config = await this.loadConfig(false).catch(() => this.config);
                const session =
                    this.getLoginSessionSnapshot() ||
                    (this.device ? null : await this.ensureLoginSession(false));
                const helperStatus = await this.getMicoapiHelperStatus(config);

                if (!session) {
                    return {
                        content: [{
                            type: "text",
                            text:
                                `[SYSTEM]当前没有活跃登录会话，插件已经就绪。\n` +
                                `micoapi 辅助: ${this.formatMicoapiHelperStatus(helperStatus)}\n` +
                                `调试日志: ${config?.debugLogPath || "?"}`,
                        }],
                    };
                }

                return {
                    content: [{
                        type: "text",
                        text:
                            `[SYSTEM]当前登录会话状态: ${session.status}\n` +
                            `登录地址: ${session.primaryUrl}\n` +
                            `创建时间: ${session.createdAt}\n` +
                            `过期时间: ${session.expiresAt}\n` +
                            `micoapi 辅助: ${this.formatMicoapiHelperStatus(helperStatus)}\n` +
                            `调试日志: ${config?.debugLogPath || "?"}` +
                            (session.message ? `\n状态说明: ${session.message}` : "") +
                            (session.error ? `\n错误信息: ${session.error}` : ""),
                    }],
                };
            },
        });

        this.api.registerTool({
            name: "xiaoai_console_open",
            description: "生成并转发小爱控制台后台链接，便于查看对话记录、事件流和直接向小爱发消息。",
            parameters: schemaObject({}),
            execute: async () => {
                const consoleUrl = await this.getConsoleEntryUrl();
                try {
                    await this.sendOpenclawNotification(
                        [
                            "这是小爱直连插件的后台控制台入口。",
                            `控制台地址：${consoleUrl}`,
                            "",
                            "这个链接里自带后台访问口令，建议只发到自己的私聊，不要转发到群聊。",
                        ].join("\n"),
                        "控制台通知"
                    );
                } catch (error) {
                    console.error(
                        `[XiaoAI Cloud] 发送控制台通知失败: ${this.errorMessage(error)}`
                    );
                }
                return {
                    content: [{
                        type: "text",
                        text: `[SYSTEM]控制台链接已生成。${consoleUrl}`,
                    }],
                };
            },
        });

        this.api.registerTool({
            name: "xiaoai_run_calibration",
            description:
                "运行小爱插件的延迟校准。mode=all 会顺序完成音频时序校准和对话拦截校准；请求单项时，如果当前设备另一项仍未校准，也会自动补跑。对话校准会发送无副作用测试问句，测试期间音箱可能真实出声。",
            parameters: schemaObject({
                mode: schemaString({
                    description: "校准类型。all=顺序完成音频和对话校准；audio=音频时序校准；conversation=对话拦截校准。",
                    enum: ["all", "audio", "conversation"],
                }),
            }),
            execute: async (_id: string, params: { mode: string }) => {
                const mode =
                    params.mode === "conversation"
                        ? "conversation"
                        : params.mode === "audio"
                            ? "audio"
                            : "all";
                try {
                    const calibration = await this.runRequestedCalibration(mode);
                    if (calibration.busyMessage) {
                        return {
                            content: [{
                                type: "text",
                                text: `[SYSTEM]${calibration.busyMessage}`,
                            }],
                        };
                    }
                    const outcome = this.buildCalibrationOutcomeMessage(calibration);
                    const detailBlocks: string[] = [];
                    if (calibration.audio) {
                        detailBlocks.push(
                            this.buildAudioCalibrationCompletionText(
                                calibration.audio,
                                calibration.autoIncludedAudio
                                    ? "音频时序校准（自动补跑）"
                                    : "音频时序校准"
                            )
                        );
                    }
                    if (calibration.conversation) {
                        detailBlocks.push(
                            this.buildConversationCalibrationCompletionText(
                                calibration.conversation,
                                calibration.autoIncludedConversation
                                    ? "对话拦截校准（自动补跑）"
                                    : "对话拦截校准"
                            )
                        );
                    }
                    return {
                        content: [{
                            type: "text",
                            text: [
                                `[SYSTEM]${outcome.message}`,
                                ...detailBlocks,
                            ]
                                .filter(Boolean)
                                .join("\n\n"),
                        }],
                    };
                } catch (error) {
                    return {
                        content: [{
                            type: "text",
                            text: `[SYSTEM]校准失败: ${this.errorMessage(error)}`,
                        }],
                    };
                }
            },
        });

        this.api.registerTool({
            name: "xiaoai_set_dialog_window",
            description: "设置唤醒模式下的免唤醒对话窗口时长（秒）。",
            parameters: schemaObject({
                seconds: schemaNumber({ description: "对话窗口时长，单位秒，建议5-120" }),
            }),
            execute: async (_id: string, params: { seconds: number }) => {
                const result = await this.updateDialogWindowSeconds(params.seconds);
                console.log(`<- [配置/云端] 对话窗口: ${result.previousSeconds}s → ${result.seconds}s`);
                return {
                    content: [{
                        type: "text",
                        text: `[SYSTEM]对话窗口已从 ${result.previousSeconds}秒 调整为 ${result.seconds}秒`,
                    }],
                };
            },
        });

        this.api.registerTool({
            name: "xiaoai_update_settings",
            description:
                "批量修改小爱插件的高级设置。适合调整通知渠道、OpenClaw 模型、xiaoai agent 上下文窗口、thinking、非流式、workspace 提示文件、过渡播报词和调试日志等控制台配置。",
            parameters: schemaObject(
                {
                    channel: schemaString({
                        description: "插件通知渠道，例如 qqbot、telegram。只影响登录通知和控制台链接回推，不影响小爱对话仍走 xiaoai agent。",
                    }),
                    target: schemaString({
                        description: "通知目标；留空时会尝试按当前渠道自动推断唯一目标。",
                    }),
                    disableNotification: schemaBoolean({
                        description: "是否关闭插件通知渠道。true 为关闭；关闭后不影响小爱对话转发。",
                    }),
                    model: schemaString({
                        description: "xiaoai 专属 agent 要切换到的 OpenClaw 模型，例如 openai/gpt-5.4。",
                    }),
                    audioTailPaddingMs: schemaNumber({
                        description:
                            "音频播放链路的尾部留白空余延迟，单位毫秒。会影响 relay/TTS 音频补白和二次播放拦截时机。",
                    }),
                    thinkingEnabled: schemaBoolean({
                        description: "是否打开 thinking。true 为打开，false 为关闭。",
                    }),
                    forceNonStreamingEnabled: schemaBoolean({
                        description: "是否开启强制非流式请求。",
                    }),
                    dialogWindowSeconds: schemaNumber({
                        description: "唤醒模式下的免唤醒对话窗口时长，单位秒。",
                    }),
                    pollIntervalMs: schemaNumber({
                        description:
                            "会话轮询间隔，单位毫秒。数值越小越积极，越大越省请求；控制台的对话拦截校准也会自动调整它。",
                    }),
                    debugLogEnabled: schemaBoolean({
                        description: "是否开启小米网络调试日志。",
                    }),
                    contextTokens: schemaNumber({
                        description:
                            "xiaoai 专属 agent 的上下文窗口大小，会写入该 agent 的 contextTokens，仅影响这个 agent。",
                    }),
                    voiceSystemPrompt: schemaString({
                        description: "写入 xiaoai agent workspace 的 AGENTS.md 内容；传空字符串可恢复默认。",
                    }),
                    workspaceFile: schemaString({
                        description:
                            "要修改的 xiaoai agent workspace 文件，可填 agents、identity、tools、heartbeat、boot、memory，或对应的 .md 文件名。",
                    }),
                    workspaceFileContent: schemaString({
                        description:
                            "写入 workspaceFile 指向文件的内容；传空字符串会恢复该文件默认内容并保持启用。",
                    }),
                    disableWorkspaceFile: schemaBoolean({
                        description:
                            "是否禁用 workspaceFile 指向的文件。true 为禁用；false 为恢复默认内容并重新启用。AGENTS.md 不支持禁用。",
                    }),
                    transitionPhrasesText: schemaString({
                        description: "过渡播报词文本，一行一个；传空字符串可恢复默认。",
                    }),
                },
                { required: [] }
            ),
            execute: async (
                _id: string,
                params: {
                    channel?: string;
                    target?: string;
                    disableNotification?: boolean;
                    model?: string;
                    audioTailPaddingMs?: number;
                    thinkingEnabled?: boolean;
                    forceNonStreamingEnabled?: boolean;
                    dialogWindowSeconds?: number;
                    pollIntervalMs?: number;
                    debugLogEnabled?: boolean;
                    contextTokens?: number;
                    voiceSystemPrompt?: string;
                    workspaceFile?: string;
                    workspaceFileContent?: string;
                    disableWorkspaceFile?: boolean;
                    transitionPhrasesText?: string;
                }
            ) => {
                const summary: string[] = [];
                let gatewayRestarting = false;
                const hasWorkspaceFileUpdate =
                    Object.prototype.hasOwnProperty.call(
                        params,
                        "workspaceFileContent"
                    ) || typeof params.disableWorkspaceFile === "boolean";
                const workspaceFileRef = readString(params.workspaceFile);
                const workspaceFileDefinition = workspaceFileRef
                    ? findOpenclawWorkspaceFileDefinition(workspaceFileRef)
                    : undefined;

                const hasRouteUpdate =
                    typeof params.disableNotification === "boolean" ||
                    typeof params.channel === "string" ||
                    typeof params.target === "string";
                if (hasRouteUpdate) {
                    const result = await this.updateOpenclawNotificationRoute({
                        channel: params.channel,
                        target: params.target,
                        disableNotification: params.disableNotification,
                    });
                    summary.push(
                        result.enabled
                            ? `通知渠道已改为 ${result.channel}/${result.target}`
                            : "插件通知已关闭"
                    );
                }

                if (typeof params.dialogWindowSeconds === "number") {
                    const result = await this.updateDialogWindowSeconds(
                        params.dialogWindowSeconds
                    );
                    summary.push(`对话窗口 ${result.seconds} 秒`);
                }

                if (typeof params.pollIntervalMs === "number") {
                    const result = await this.updatePollIntervalMs(params.pollIntervalMs);
                    summary.push(`轮询间隔 ${result.pollIntervalMs} ms`);
                }

                if (typeof params.audioTailPaddingMs === "number") {
                    const result = await this.updateAudioTailPaddingMs(
                        params.audioTailPaddingMs
                    );
                    summary.push(`空余延迟 ${result.tailPaddingMs} ms`);
                }

                if (typeof params.thinkingEnabled === "boolean") {
                    const result = await this.updateOpenclawThinkingOff(
                        !params.thinkingEnabled
                    );
                    summary.push(result.enabled ? "thinking 已关闭" : "thinking 已打开");
                }

                if (typeof params.forceNonStreamingEnabled === "boolean") {
                    const result = await this.updateOpenclawForceNonStreaming(
                        params.forceNonStreamingEnabled
                    );
                    gatewayRestarting = gatewayRestarting || result.restarting;
                    summary.push(
                        result.enabled ? "已开启强制非流式" : "已关闭强制非流式"
                    );
                }

                const model = readString(params.model);
                if (model) {
                    const result = await this.updateOpenclawAgentModel(model);
                    gatewayRestarting = gatewayRestarting || result.restarting;
                    summary.push(`模型已切到 ${result.model}`);
                }

                if (typeof params.debugLogEnabled === "boolean") {
                    const result = await this.updateDebugLogEnabled(
                        params.debugLogEnabled
                    );
                    summary.push(
                        result.enabled ? "已开启调试日志" : "已关闭调试日志"
                    );
                }

                if (typeof params.contextTokens === "number") {
                    const result = await this.updateOpenclawAgentContextTokens(
                        params.contextTokens
                    );
                    gatewayRestarting = gatewayRestarting || result.restarting;
                    summary.push(
                        `${result.agentId} 上下文窗口 ${result.contextTokens} tokens`
                    );
                }

                if (
                    Object.prototype.hasOwnProperty.call(params, "voiceSystemPrompt") &&
                    !(hasWorkspaceFileUpdate && workspaceFileDefinition?.id === "agents")
                ) {
                    const result = await this.updateOpenclawVoiceSystemPrompt(
                        params.voiceSystemPrompt
                    );
                    summary.push(
                        result.customized
                            ? `已更新 ${OPENCLAW_AGENT_PROMPT_FILENAME}`
                            : `已恢复默认 ${OPENCLAW_AGENT_PROMPT_FILENAME}`
                    );
                }

                if (hasWorkspaceFileUpdate) {
                    if (!workspaceFileRef) {
                        throw new Error(
                            "修改 workspace 文件时必须同时提供 workspaceFile。"
                        );
                    }
                    const result = await this.updateOpenclawWorkspaceFile(
                        workspaceFileRef,
                        {
                            content: params.workspaceFileContent,
                            enabled:
                                typeof params.disableWorkspaceFile === "boolean"
                                    ? !params.disableWorkspaceFile
                                    : true,
                        }
                    );
                    summary.push(
                        result.disabled
                            ? `已禁用 ${result.file.filename}`
                            : result.file.customized
                                ? `已更新 ${result.file.filename}`
                                : `已恢复默认 ${result.file.filename}`
                    );
                }

                if (
                    Object.prototype.hasOwnProperty.call(
                        params,
                        "transitionPhrasesText"
                    )
                ) {
                    const result = await this.updateTransitionPhrases(
                        params.transitionPhrasesText
                    );
                    summary.push(
                        result.customized
                            ? `已更新 ${result.phrases.length} 条过渡播报词`
                            : "已恢复默认过渡播报词"
                    );
                }

                if (!summary.length) {
                    return {
                        content: [{
                            type: "text",
                            text:
                                "[SYSTEM]没有收到可修改的高级设置。可用字段包括 channel、target、disableNotification、model、contextTokens、audioTailPaddingMs、thinkingEnabled、forceNonStreamingEnabled、dialogWindowSeconds、pollIntervalMs、debugLogEnabled、voiceSystemPrompt、workspaceFile、workspaceFileContent、disableWorkspaceFile、transitionPhrasesText。",
                        }],
                    };
                }

                const detail = summary.map((item) => `- ${item}`).join("\n");
                this.recordConsoleEvent(
                    "tool.settings",
                    "批量修改高级设置",
                    summary.join("；"),
                    "success"
                );
                return {
                    content: [{
                        type: "text",
                        text:
                            "[SYSTEM]已更新以下设置：\n" +
                            detail +
                            (gatewayRestarting
                                ? "\nOpenClaw 网关正在自动重启，稍后会恢复。"
                                : ""),
                    }],
                };
            },
        });
    }
}

export function createXiaoaiCloudPlugin(api: any) {
    return new XiaoaiCloudPlugin(api);
}
