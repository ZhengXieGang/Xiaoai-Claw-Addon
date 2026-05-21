import { createHash, createHmac, randomBytes } from "crypto";
import { execFile } from "child_process";
import { appendFile, mkdir, readFile, stat, writeFile } from "fs/promises";
import { request as httpsRequest } from "https";
import path from "path";
import { defaultPluginStorageDir } from "./openclaw-paths.js";

export type XiaomiSid = "micoapi" | "xiaomiio";
export type XiaomiVerificationMethod = "phone" | "email";

type XiaomiTokenEntry = [string, string];

export interface XiaomiTokenStore {
    deviceId: string;
    userId?: string;
    cUserId?: string;
    passToken?: string;
    micoapi?: XiaomiTokenEntry;
    xiaomiio?: XiaomiTokenEntry;
}

export interface XiaomiVerificationState {
    tokenStore: XiaomiTokenStore;
    accountCookies: Record<string, string>;
    verifyUrl: string;
    verifyMethods: XiaomiVerificationMethod[];
    identitySession?: string;
}

interface XiaomiVerificationDetails {
    methods: XiaomiVerificationMethod[];
    identitySession?: string;
}

interface XiaomiResponseLike {
    status: number;
    ok: boolean;
    url: string;
    text(): Promise<string>;
}

interface XiaomiRequestOptions {
    timeoutMs?: number;
    maxAttempts?: number;
}

interface XiaomiNestedErrorDetail {
    name?: string;
    code?: string;
    message?: string;
    address?: string;
    family?: number;
}

const DEBUG_LOG_MAX_BYTES = 768 * 1024;
const DEBUG_LOG_KEEP_BYTES = 384 * 1024;
const DEBUG_LOG_PRUNE_INTERVAL_MS = 60_000;
const XIAOMI_FETCH_TIMEOUT_MS = 12_000;
const XIAOMI_MIN_FETCH_TIMEOUT_MS = 300;
const XIAOMI_GOAWAY_RETRY_DELAYS_MS = [550, 1100, 1800];
const MINA_HTTP1_FALLBACK_WINDOW_MS = 30 * 60 * 1000;
const MINA_CONVERSATION_TRACE_SAMPLE_MS = 5_000;

interface PythonCommandCandidate {
    command: string;
    argsPrefix: string[];
    source: "configured" | "builtin";
}

export interface XiaomiPythonRuntimeStatus {
    ready: boolean;
    kind: "ready" | "missing_python" | "missing_requests" | "probe_failed";
    command?: string;
    argsPrefix?: string[];
    pythonVersion?: string;
    requestsVersion?: string;
    detail: string;
}

export class XiaomiVerificationRequiredError extends Error {
    readonly verifyUrl: string;
    readonly methods: XiaomiVerificationMethod[];
    readonly state: XiaomiVerificationState;
    readonly sid: XiaomiSid;

    constructor(options: {
        sid: XiaomiSid;
        verifyUrl: string;
        methods: XiaomiVerificationMethod[];
        state: XiaomiVerificationState;
        message?: string;
    }) {
        super(
            options.message ||
                [
                    `小米账号登录需要先完成一次安全验证，当前无法直接用账号密码自动拿到 ${options.sid} 登录态。`,
                    "请先按提示完成验证，再回到当前页面继续。",
                ].join("\n")
        );
        this.name = "XiaomiVerificationRequiredError";
        this.verifyUrl = options.verifyUrl;
        this.methods = options.methods;
        this.state = options.state;
        this.sid = options.sid;
    }
}

export interface MinaDeviceInfo {
    deviceID?: string;
    hardware?: string;
    miotDID?: string | number;
    alias?: string;
    name?: string;
    [key: string]: any;
}

export interface MiioDeviceInfo {
    did: string;
    name?: string;
    model?: string;
    token?: string;
    [key: string]: any;
}

export interface MiotSpecProperty {
    iid: number;
    type: string;
    description?: string;
    format?: string;
    access?: string[];
    ["value-range"]?: number[];
}

export interface MiotSpecAction {
    iid: number;
    type: string;
    description?: string;
    in?: number[];
}

export interface MiotSpecService {
    iid: number;
    type: string;
    description?: string;
    properties?: MiotSpecProperty[];
    actions?: MiotSpecAction[];
}

export interface MiotDeviceSpec {
    type?: string;
    services?: MiotSpecService[];
}

export interface SpeakerFeatureMap {
    volume?: { siid: number; piid: number; min?: number; max?: number; step?: number };
    mute?: { siid: number; piid: number };
    muteOn?: { siid: number; aiid: number };
    muteOff?: { siid: number; aiid: number };
    play?: { siid: number; aiid: number };
    playText?: { siid: number; aiid: number };
    messageRouterPost?: { siid: number; aiid: number };
    executeTextDirective?: { siid: number; aiid: number; silentPiid?: number };
    wakeUp?: { siid: number; aiid: number; ins?: number };
    pause?: { siid: number; aiid: number };
    stop?: { siid: number; aiid: number };
}

const ACCOUNT_BASE_URL = "https://account.xiaomi.com/pass";
const ACCOUNT_ORIGIN = new URL(ACCOUNT_BASE_URL).origin;
const MINA_BASE_URL = "https://api2.mina.mi.com";
const MINA_CONVERSATION_URL = "https://userprofile.mina.mi.com/device_profile/v2/conversation";
const MIOT_SPEC_INSTANCES_URL = "http://miot-spec.org/miot-spec-v2/instances?status=all";
const MIOT_SPEC_INSTANCE_URL = "http://miot-spec.org/miot-spec-v2/instance?type=";

const ACCOUNT_SDK_VERSION = "3.8.6";
const MIIO_USER_AGENT =
    "iOS-14.4-6.0.103-iPhone12,3--D7744744F7AF32F0544445285880DD63E47D9BE9-8816080-84A3F44E137B71AE-iPhone";

const RANDOM_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const TRACE_TEXT_LIMIT = 1200;
const SENSITIVE_KEY_PATTERN =
    /(pass(word|token)?|token|ticket|security|nonce|sign|auth|cookie|capt|hash|secret|serviceToken|PassportDeviceId)/i;
const PRIVATE_IDENTITY_KEY_PATTERN =
    /^(account|username|userId|cUserId|deviceId|identity_session|identitySession)$/i;
const PYTHON_STS_SCRIPT = `
import json
import sys
import warnings

warnings.filterwarnings("ignore")

url = sys.argv[1]
ua = sys.argv[2]

try:
    import requests
except Exception as exc:
    print(json.dumps({
        "ok": False,
        "kind": "import_error",
        "error": repr(exc),
    }))
    sys.exit(2)

try:
    response = requests.get(
        url,
        headers={
            "User-Agent": ua,
            "Accept": "*/*",
            "Accept-Encoding": "gzip, deflate",
            "Connection": "keep-alive",
        },
        allow_redirects=False,
        verify=False,
        timeout=20,
    )
    print(json.dumps({
        "ok": True,
        "status": response.status_code,
        "serviceToken": response.cookies.get("serviceToken"),
        "setCookie": response.headers.get("Set-Cookie", ""),
        "text": response.text[:500],
    }))
except Exception as exc:
    print(json.dumps({
        "ok": False,
        "kind": "request_error",
        "error": repr(exc),
    }))
    sys.exit(3)
`.trim();
const PYTHON_REQUESTS_PROBE_SCRIPT = `
import json
import sys

payload = {
    "ok": True,
    "pythonVersion": sys.version.split()[0],
}

try:
    import requests
    payload["requestsVersion"] = getattr(requests, "__version__", "unknown")
except Exception as exc:
    print(json.dumps({
        "ok": False,
        "kind": "import_error",
        "pythonVersion": sys.version.split()[0],
        "error": repr(exc),
    }))
    sys.exit(2)

print(json.dumps(payload))
`.trim();
const PYTHON_MICOAPI_LOGIN_SCRIPT = `
import base64
import hashlib
import json
import sys
import urllib.parse
import warnings

warnings.filterwarnings("ignore")

device_id = sys.argv[1]
user_id = sys.argv[2]
pass_token = sys.argv[3]
ua = sys.argv[4]

try:
    import requests
except Exception as exc:
    print(json.dumps({
        "ok": False,
        "kind": "import_error",
        "error": repr(exc),
    }))
    sys.exit(2)

def strip_json_prefix(text: str) -> str:
    return text[11:] if text.startswith("&&&START&&&") else text

try:
    session = requests.Session()
    response = session.get(
        "https://account.xiaomi.com/pass/serviceLogin?sid=micoapi&_json=true",
        headers={"User-Agent": ua},
        cookies={
            "sdkVersion": "3.9",
            "deviceId": device_id,
            "userId": user_id,
            "passToken": pass_token,
        },
        verify=False,
        timeout=20,
    )
    auth = json.loads(strip_json_prefix(response.text))
    if auth.get("code") != 0:
        print(json.dumps({
            "ok": False,
            "kind": "step1_failed",
            "status": response.status_code,
            "auth": auth,
        }))
        sys.exit(3)

    nsec = "nonce=" + str(auth["nonce"]) + "&" + auth["ssecurity"]
    client_sign = base64.b64encode(hashlib.sha1(nsec.encode()).digest()).decode()
    location = auth["location"]
    location += ("&" if "?" in location else "?") + "clientSign=" + urllib.parse.quote(client_sign)

    sts = session.get(
        location,
        headers={
            "User-Agent": ua,
            "Accept": "*/*",
            "Accept-Encoding": "gzip, deflate",
            "Connection": "keep-alive",
        },
        allow_redirects=False,
        verify=False,
        timeout=20,
    )
    print(json.dumps({
        "ok": True,
        "status": sts.status_code,
        "serviceToken": sts.cookies.get("serviceToken"),
        "setCookie": sts.headers.get("Set-Cookie", ""),
        "text": sts.text[:500],
        "ssecurity": auth.get("ssecurity"),
        "userId": auth.get("userId"),
        "cUserId": auth.get("cUserId"),
        "passToken": auth.get("passToken"),
    }))
except Exception as exc:
    print(json.dumps({
        "ok": False,
        "kind": "request_error",
        "error": repr(exc),
    }))
    sys.exit(4)
`.trim();

function randomString(length: number): string {
    const bytes = randomBytes(length);
    let output = "";
    for (const byte of bytes) {
        output += RANDOM_CHARS[byte % RANDOM_CHARS.length];
    }
    return output;
}

function hashSummary(value: string): string {
    return `sha1:${sha1HexShort(value)} len:${value.length}`;
}

function buildAccountUserAgent(deviceId: string): string {
    return `Android-7.1.1-1.0.0-ONEPLUS A3010-136-${deviceId} APP/xiaomi.smarthome APPV/62830`;
}

function truncateText(text: string, limit = TRACE_TEXT_LIMIT): string {
    if (text.length <= limit) {
        return text;
    }
    return `${text.slice(0, limit)}... [truncated ${text.length - limit} chars]`;
}

function currentLocaleCookie(): string {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
    return locale.replace(/-/g, "_");
}

function currentTimezoneCookie(date = new Date()): string {
    const totalMinutes = -date.getTimezoneOffset();
    const sign = totalMinutes >= 0 ? "+" : "-";
    const absolute = Math.abs(totalMinutes);
    const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
    const minutes = String(absolute % 60).padStart(2, "0");
    return `GMT${sign}${hours}:${minutes}`;
}

function currentDstOffsetMillis(date = new Date()): number {
    const year = date.getFullYear();
    const januaryOffset = new Date(year, 0, 1).getTimezoneOffset();
    const julyOffset = new Date(year, 6, 1).getTimezoneOffset();
    const standardOffset = Math.max(januaryOffset, julyOffset);
    return Math.max(0, standardOffset - date.getTimezoneOffset()) * 60 * 1000;
}

function looksSensitiveKey(key: string | undefined): boolean {
    return Boolean(key && SENSITIVE_KEY_PATTERN.test(key));
}

function looksPrivateIdentityKey(key: string | undefined): boolean {
    return Boolean(key && PRIVATE_IDENTITY_KEY_PATTERN.test(key));
}

function summarizeSecret(value: string): string {
    return `[redacted ${hashSummary(value)}]`;
}

function sanitizeScalar(value: any, key?: string): any {
    if (typeof value !== "string") {
        return value;
    }
    if (looksSensitiveKey(key) || looksPrivateIdentityKey(key)) {
        return summarizeSecret(value);
    }
    return truncateText(value, 240);
}

function sanitizeUrl(value: string): string {
    try {
        const url = new URL(value);
        for (const [key, current] of url.searchParams.entries()) {
            if (looksSensitiveKey(key)) {
                url.searchParams.set(key, summarizeSecret(current));
            } else {
                url.searchParams.set(key, truncateText(current, 120));
            }
        }
        return url.toString();
    } catch {
        return value.replace(
            /([?&](?:pass(?:word|token)?|token|ticket|security|nonce|sign|auth|cookie|capt|hash|secret|serviceToken|PassportDeviceId)=)([^&]+)/gi,
            (_, prefix, current) => `${prefix}${summarizeSecret(String(current))}`
        );
    }
}

function safeUrlHostname(value: string): string | undefined {
    try {
        return new URL(value).hostname.toLowerCase();
    } catch {
        return undefined;
    }
}

function isMinaNetworkHost(hostname: string | undefined) {
    if (!hostname) {
        return false;
    }
    return hostname === "userprofile.mina.mi.com" || hostname.endsWith(".mina.mi.com");
}

function shouldPreferIpv4ForHttp1Host(hostname: string | undefined) {
    return hostname === "userprofile.mina.mi.com";
}

function sanitizeText(text: string): string {
    const trimmed = truncateText(text, TRACE_TEXT_LIMIT);
    try {
        return JSON.stringify(sanitizeData(parseJson(trimmed)));
    } catch {
        return trimmed
            .replace(
                /("?(?:pass(?:word|token)?|token|ticket|security|nonce|sign|auth|cookie|capt|hash|secret|serviceToken|PassportDeviceId)"?\s*[:=]\s*"?)([^",;&\s}]+)/gi,
                (_, prefix, current) => `${prefix}${summarizeSecret(String(current))}`
            )
            .replace(
                /([?&](?:pass(?:word|token)?|token|ticket|security|nonce|sign|auth|cookie|capt|hash|secret|serviceToken|PassportDeviceId)=)([^&]+)/gi,
                (_, prefix, current) => `${prefix}${summarizeSecret(String(current))}`
            );
    }
}

function sanitizeData(value: any, key?: string): any {
    if (value === null || value === undefined) {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => sanitizeData(item));
    }
    if (typeof value === "object") {
        const next: Record<string, any> = {};
        for (const [entryKey, entryValue] of Object.entries(value)) {
            if (entryKey.toLowerCase().includes("url") && typeof entryValue === "string") {
                next[entryKey] = sanitizeUrl(entryValue);
            } else {
                next[entryKey] = sanitizeData(entryValue, entryKey);
            }
        }
        return next;
    }
    return sanitizeScalar(value, key);
}

function sanitizeCookieRecord(cookies: Record<string, string>): Record<string, string> {
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(cookies)) {
        next[key] =
            looksSensitiveKey(key) || looksPrivateIdentityKey(key)
                ? summarizeSecret(value)
                : truncateText(value, 120);
    }
    return next;
}

function md5Upper(value: string): string {
    return createHash("md5").update(value).digest("hex").toUpperCase();
}

function sha1Base64(value: string): string {
    return createHash("sha1").update(value).digest("base64");
}

function sha1HexShort(value: string): string {
    return createHash("sha1").update(value).digest("hex").slice(0, 10);
}

function sha256Base64(parts: Array<string | Buffer>): string {
    const hash = createHash("sha256");
    for (const part of parts) {
        if (typeof part === "string") {
            hash.update(part);
        } else {
            hash.update(part);
        }
    }
    return hash.digest("base64");
}

function buildCookieHeader(cookies: Record<string, string | number | boolean | undefined>): string {
    return Object.entries(cookies)
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .map(([key, value]) => `${key}=${String(value)}`)
        .join("; ");
}

function headersToRecord(headers: Headers): Record<string, string> {
    const record: Record<string, string> = {};
    for (const [key, value] of headers.entries()) {
        record[key] = value;
    }
    return record;
}

function stripJsonPrefix(text: string): string {
    return text.startsWith("&&&START&&&") ? text.slice("&&&START&&&".length) : text;
}

function appendQuery(url: string, params: Record<string, any>): string {
    const next = new URL(url);
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) {
            continue;
        }
        next.searchParams.set(key, String(value));
    }
    return next.toString();
}

function formEncode(data: Record<string, any>): URLSearchParams {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(data)) {
        if (value === undefined || value === null) {
            continue;
        }
        body.set(key, typeof value === "string" ? value : String(value));
    }
    return body;
}

function parseJson<T = any>(text: string): T {
    return JSON.parse(stripJsonPrefix(text)) as T;
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildTimeoutSignal(timeoutMs = XIAOMI_FETCH_TIMEOUT_MS) {
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
        return AbortSignal.timeout(timeoutMs);
    }
    return undefined;
}

function execFileText(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        execFile(command, args, { encoding: "utf8", maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                const details = errorDetails(error);
                reject(
                    new Error(
                        [
                            `command=${command}`,
                            details.message,
                            stderr ? truncateText(stderr, 400) : undefined,
                        ]
                            .filter(Boolean)
                            .join(" | ")
                    )
                );
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}

function resolveAccountUrl(value: string | undefined): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return undefined;
    }
    try {
        return new URL(trimmed, ACCOUNT_ORIGIN).toString();
    } catch {
        return undefined;
    }
}

function looksLikeVerificationPath(value: string | undefined): boolean {
    const resolved = resolveAccountUrl(value);
    if (!resolved) {
        return false;
    }
    return (
        resolved.includes("/pass2/redirect") ||
        resolved.includes("/fe/service/notification") ||
        resolved.includes("/identity/") ||
        resolved.includes("/fe/service/identity/")
    );
}

function findVerificationUrlInText(text: string): string | undefined {
    const match = text.match(/https?:\/\/account\.xiaomi\.com\/fe\/service\/identity\/authStart[^\s"'<>)]*/i);
    if (match?.[0]) {
        return resolveAccountUrl(match[0]);
    }
    const relativeMatch = text.match(/\/fe\/service\/identity\/authStart[^\s"'<>)]*/i);
    if (relativeMatch?.[0]) {
        return resolveAccountUrl(relativeMatch[0]);
    }
    return undefined;
}

function findVerificationPageUrlInText(text: string): string | undefined {
    const absoluteMatch = text.match(
        /https?:\/\/account\.xiaomi\.com\/fe\/service\/identity\/(?:verifyPhone|verifyEmail|authStart)[^\s"'<>)]*/i
    );
    if (absoluteMatch?.[0]) {
        return resolveAccountUrl(absoluteMatch[0]);
    }
    const relativeMatch = text.match(
        /\/fe\/service\/identity\/(?:verifyPhone|verifyEmail|authStart)[^\s"'<>)]*/i
    );
    if (relativeMatch?.[0]) {
        return resolveAccountUrl(relativeMatch[0]);
    }
    return undefined;
}

function inferVerificationMethodsFromUrl(
    verifyUrl: string | undefined
): XiaomiVerificationMethod[] {
    if (typeof verifyUrl !== "string") {
        return [];
    }
    const normalized = verifyUrl.toLowerCase();
    if (normalized.includes("/fe/service/identity/verifyphone")) {
        return ["phone"];
    }
    if (normalized.includes("/fe/service/identity/verifyemail")) {
        return ["email"];
    }
    return [];
}

function mergeVerificationMethods(
    ...groups: Array<ReadonlyArray<XiaomiVerificationMethod> | undefined>
): XiaomiVerificationMethod[] {
    const merged = new Set<XiaomiVerificationMethod>();
    for (const group of groups) {
        for (const item of group || []) {
            if (item === "phone" || item === "email") {
                merged.add(item);
            }
        }
    }
    return Array.from(merged);
}

function deriveVerificationPageUrl(
    verifyUrl: string,
    method: XiaomiVerificationMethod
): string {
    const targetUrl = new URL(verifyUrl, ACCOUNT_ORIGIN);
    if (targetUrl.pathname.includes("/fe/service/identity/authStart")) {
        targetUrl.pathname = targetUrl.pathname.replace(
            "/fe/service/identity/authStart",
            `/fe/service/identity/${method === "phone" ? "verifyPhone" : "verifyEmail"}`
        );
    }
    return targetUrl.toString();
}

function extractSetCookieLines(headers: Headers): string[] {
    const extendedHeaders = headers as Headers & {
        getSetCookie?: () => string[];
        raw?: () => Record<string, string[]>;
    };

    if (typeof extendedHeaders.getSetCookie === "function") {
        return extendedHeaders.getSetCookie();
    }

    if (typeof extendedHeaders.raw === "function") {
        const raw = extendedHeaders.raw();
        return raw["set-cookie"] || [];
    }

    const rawHeader = headers.get("set-cookie");
    if (!rawHeader) {
        return [];
    }

    return rawHeader.split(/,(?=[^;,=\s]+=[^;,]+)/g);
}

function mergeCookies(target: Record<string, string>, cookieLines: string[]) {
    for (const line of cookieLines) {
        const firstPart = line.split(";")[0];
        const separatorIndex = firstPart.indexOf("=");
        if (separatorIndex <= 0) {
            continue;
        }
        const key = firstPart.slice(0, separatorIndex).trim();
        const value = firstPart.slice(separatorIndex + 1).trim();
        if (key) {
            target[key] = value;
        }
    }
}

function normalizeName(name: string | undefined): string {
    return (name || "").trim().toLowerCase();
}

function firstNonEmptyText(...values: Array<any>): string | undefined {
    for (const value of values) {
        if (typeof value === "string" && value.trim()) {
            return value.trim();
        }
        if (typeof value === "number" && Number.isFinite(value)) {
            return String(value);
        }
        if (typeof value === "bigint") {
            return value.toString();
        }
    }
    return undefined;
}

function urnName(type: string | undefined): string {
    if (!type) {
        return "";
    }
    const parts = type.split(":");
    return parts[3] || "";
}

function normalizeMiotSpecName(value: string | undefined): string {
    if (!value) {
        return "";
    }
    return value
        .trim()
        .replace(/[^a-zA-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .toLowerCase();
}

function resolveMiotSpecName(type: string | undefined, description?: string): string {
    return (
        normalizeMiotSpecName(urnName(type)) ||
        normalizeMiotSpecName(description)
    );
}

function miotSpecNameIn(candidate: string, aliases: string[]) {
    return aliases.includes(candidate);
}

function needsSsecurityForSid(sid: XiaomiSid): boolean {
    return sid === "xiaomiio";
}

function parseVersionFromUrn(type: string): number {
    const parts = type.split(":");
    const maybeVersion = parts[parts.length - 1];
    const version = Number(maybeVersion);
    return Number.isFinite(version) ? version : 0;
}

function isAuthErrorPayload(payload: any): boolean {
    if (!payload || typeof payload !== "object") {
        return false;
    }
    const code = payload.code;
    const message = String(payload.message || "").toLowerCase();
    return code === 3 || code === 401 || message.includes("auth") || message.includes("token") || message.includes("login failed");
}

function summarizeNestedError(error: unknown): XiaomiNestedErrorDetail | undefined {
    const asAny = error as any;
    const name = firstNonEmptyText(asAny?.name);
    const code = firstNonEmptyText(asAny?.code);
    const message = firstNonEmptyText(asAny?.message);
    const address = firstNonEmptyText(asAny?.address);
    const family =
        typeof asAny?.family === "number" && Number.isFinite(asAny.family)
            ? asAny.family
            : undefined;

    if (!name && !code && !message && !address && family === undefined) {
        return undefined;
    }

    return {
        name,
        code,
        message,
        address,
        family,
    };
}

function collectNestedErrors(error: unknown, seen = new Set<any>()) {
    const asAny = error as any;
    if (!asAny || typeof asAny !== "object" || seen.has(asAny)) {
        return [] as XiaomiNestedErrorDetail[];
    }
    seen.add(asAny);

    const results: XiaomiNestedErrorDetail[] = [];
    const nestedErrors = Array.isArray(asAny?.errors) ? asAny.errors : [];
    for (const nestedError of nestedErrors) {
        const summary = summarizeNestedError(nestedError);
        if (summary) {
            results.push(summary);
        }
        results.push(...collectNestedErrors(nestedError, seen));
    }
    return results;
}

function errorDetails(error: unknown) {
    const asAny = error as any;
    const cause = asAny?.cause;
    const nestedErrors = collectNestedErrors(error);
    return {
        name: asAny?.name,
        code: asAny?.code,
        message: asAny?.message || String(error),
        causeName: cause?.name,
        causeCode: cause?.code,
        causeMessage: cause?.message,
        errors: nestedErrors.length ? nestedErrors : undefined,
    };
}

function isHttp2GoawayError(error: unknown) {
    const details = errorDetails(error);
    const text = `${details.message || ""} ${details.causeMessage || ""}`.toLowerCase();
    return (
        details.causeCode === "UND_ERR_SOCKET" &&
        text.includes("goaway")
    );
}

function formatNetworkError(error: unknown, target: string) {
    const details = errorDetails(error);
    const nestedErrors = details.errors?.map((item) =>
        [
            item.code,
            item.name && item.name !== item.code ? item.name : undefined,
            item.family !== undefined ? `family=${item.family}` : undefined,
            item.address ? `address=${item.address}` : undefined,
            item.message,
        ]
            .filter(Boolean)
            .join(" ")
    );
    const parts = [
        `访问 ${target} 失败`,
        details.message,
        details.code ? `code=${details.code}` : undefined,
        details.causeCode ? `cause=${details.causeCode}` : undefined,
        details.causeMessage && details.causeMessage !== details.message
            ? details.causeMessage
            : undefined,
        nestedErrors?.length ? `errors=${nestedErrors.join(" ; ")}` : undefined,
    ].filter(Boolean);
    return parts.join(" | ");
}

function defaultTokenBaseDir(baseStateDir?: string): string {
    return defaultPluginStorageDir(baseStateDir);
}

export function defaultTokenStorePath(
    account: string,
    serverCountry: string,
    baseStateDir?: string
): string {
    const digest = createHash("sha1")
        .update(`${account}:${serverCountry}`)
        .digest("hex")
        .slice(0, 16);
    return path.join(defaultTokenBaseDir(baseStateDir), `${digest}.json`);
}

export class XiaomiAccountClient {
    private readonly username: string;
    private readonly password?: string;
    private readonly tokenStorePath?: string;
    private readonly debugLogPath?: string;
    private readonly pythonCommand?: string;
    private readonly accountCookies: Record<string, string>;
    private token: XiaomiTokenStore | null;
    private loadTokenStorePromise?: Promise<void>;
    private verificationUrl?: string;
    private verificationMethods: XiaomiVerificationMethod[] = [];
    private identitySession?: string;
    private traceSequence = 0;
    private pythonRuntimeStatus?: XiaomiPythonRuntimeStatus;
    private debugLogEnabled: boolean;
    private lastDebugLogPruneAt = 0;
    private minaHttp1FallbackUntil = 0;
    private lastMinaConversationTraceAt = 0;

    constructor(options: {
        username: string;
        password?: string;
        tokenStorePath?: string;
        debugLogPath?: string;
        debugLogEnabled?: boolean;
        pythonCommand?: string;
    }) {
        this.username = options.username;
        this.password = options.password;
        this.tokenStorePath = options.tokenStorePath;
        this.debugLogPath = options.debugLogPath;
        this.debugLogEnabled = options.debugLogEnabled !== false;
        this.pythonCommand = options.pythonCommand;
        this.token = null;
        this.accountCookies = {};
    }

    getDebugLogPath(): string | undefined {
        return this.debugLogPath;
    }

    setDebugLogEnabled(enabled: boolean) {
        this.debugLogEnabled = Boolean(enabled);
    }

    private isMinaHttp1FallbackActive(nowMs = Date.now()) {
        return this.minaHttp1FallbackUntil > nowMs;
    }

    private isHighFrequencyMinaConversationRequest(
        sid: XiaomiSid,
        url: string
    ) {
        return sid === "micoapi" && url.startsWith(MINA_CONVERSATION_URL);
    }

    private shouldTraceMinaConversationRequest(
        sid: XiaomiSid,
        url: string
    ) {
        if (!this.isHighFrequencyMinaConversationRequest(sid, url)) {
            return true;
        }
        const nowMs = Date.now();
        if (nowMs - this.lastMinaConversationTraceAt < MINA_CONVERSATION_TRACE_SAMPLE_MS) {
            return false;
        }
        this.lastMinaConversationTraceAt = nowMs;
        return true;
    }

    private async requestViaHttp1(options: {
        url: string;
        method: "GET" | "POST";
        headers: Headers;
        body?: URLSearchParams;
        timeoutMs?: number;
    }): Promise<XiaomiResponseLike> {
        const target = new URL(options.url);
        const headerRecord = headersToRecord(options.headers);
        const bodyText = options.body?.toString();
        const preferIpv4 = shouldPreferIpv4ForHttp1Host(target.hostname.toLowerCase());
        const timeoutMs = Number.isFinite(Number(options.timeoutMs))
            ? Math.max(XIAOMI_MIN_FETCH_TIMEOUT_MS, Math.round(Number(options.timeoutMs)))
            : XIAOMI_FETCH_TIMEOUT_MS;

        if (bodyText && !headerRecord["content-length"]) {
            headerRecord["content-length"] = String(Buffer.byteLength(bodyText));
        }

        return new Promise((resolve, reject) => {
            let settled = false;
            let request: ReturnType<typeof httpsRequest> | undefined;
            const finishResolve = (value: XiaomiResponseLike) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(deadlineTimer);
                resolve(value);
            };
            const finishReject = (error: unknown) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(deadlineTimer);
                reject(error);
            };
            const buildTimeoutError = () => {
                const timeoutError = new Error(
                    `request timeout after ${timeoutMs}ms`
                ) as NodeJS.ErrnoException;
                timeoutError.code = "ETIMEDOUT";
                return timeoutError;
            };
            const deadlineTimer = setTimeout(() => {
                const timeoutError = buildTimeoutError();
                finishReject(timeoutError);
                request?.destroy(timeoutError);
            }, timeoutMs);

            request = httpsRequest(
                {
                    protocol: target.protocol,
                    hostname: target.hostname,
                    port: target.port ? Number(target.port) : undefined,
                    path: `${target.pathname}${target.search}`,
                    method: options.method,
                    headers: headerRecord,
                    family: preferIpv4 ? 4 : undefined,
                },
                (response) => {
                    const chunks: Buffer[] = [];
                    response.on("data", (chunk) => {
                        if (settled) {
                            return;
                        }
                        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                    });
                    response.on("error", (error) => {
                        finishReject(error);
                    });
                    response.on("end", () => {
                        if (settled) {
                            return;
                        }
                        const textPayload = Buffer.concat(chunks).toString("utf8");
                        const status = Number(response.statusCode || 0);
                        finishResolve({
                            status,
                            ok: status >= 200 && status < 300,
                            url: options.url,
                            text: async () => textPayload,
                        });
                    });
                }
            );
            request.setTimeout(timeoutMs);
            request.on("timeout", () => {
                const timeoutError = buildTimeoutError();
                finishReject(timeoutError);
                request.destroy(timeoutError);
            });
            request.on("error", (error) => {
                finishReject(error);
            });
            if (bodyText) {
                request.write(bodyText);
            }
            request.end();
        });
    }

    private async armMinaHttp1Fallback(
        context: {
            url: string;
            host?: string;
            attempt?: number;
            error?: unknown;
        }
    ) {
        const nowMs = Date.now();
        const wasActive = this.isMinaHttp1FallbackActive(nowMs);
        this.minaHttp1FallbackUntil = Math.max(
            this.minaHttp1FallbackUntil,
            nowMs + MINA_HTTP1_FALLBACK_WINDOW_MS
        );
        await this.trace("transport_mina_http1_fallback", {
            ...context,
            wasActive,
            fallbackUntil: new Date(this.minaHttp1FallbackUntil).toISOString(),
            error: context.error ? errorDetails(context.error) : undefined,
        });
    }

    async maintainDebugLog(force = false) {
        if (!this.debugLogPath) {
            return;
        }

        const now = Date.now();
        if (!force && now - this.lastDebugLogPruneAt < DEBUG_LOG_PRUNE_INTERVAL_MS) {
            return;
        }
        this.lastDebugLogPruneAt = now;

        try {
            const info = await stat(this.debugLogPath);
            if (info.size <= DEBUG_LOG_MAX_BYTES) {
                return;
            }

            const content = await readFile(this.debugLogPath, "utf8");
            const tail = content.slice(-DEBUG_LOG_KEEP_BYTES);
            const trimmedTail = tail.includes("\n")
                ? tail.slice(tail.indexOf("\n") + 1)
                : tail;
            const line = JSON.stringify({
                ts: new Date().toISOString(),
                seq: ++this.traceSequence,
                event: "trace_pruned",
                details: {
                    previousBytes: info.size,
                    keptBytes: DEBUG_LOG_KEEP_BYTES,
                },
            });
            const nextContent = `${line}\n${trimmedTail.trimStart()}`;
            await writeFile(
                this.debugLogPath,
                nextContent.endsWith("\n") ? nextContent : `${nextContent}\n`,
                "utf8"
            );
        } catch {
            // Ignore cleanup failures to avoid breaking runtime behavior.
        }
    }

    async resetDebugLog(context: Record<string, any>) {
        if (!this.debugLogPath || !this.debugLogEnabled) {
            return;
        }
        await mkdir(path.dirname(this.debugLogPath), { recursive: true });
        this.traceSequence = 0;
        const line = JSON.stringify({
            ts: new Date().toISOString(),
            seq: ++this.traceSequence,
            event: "trace_reset",
            details: sanitizeData(context),
        });
        await writeFile(this.debugLogPath, `${line}\n`, "utf8");
    }

    private async trace(event: string, details: Record<string, any>) {
        if (!this.debugLogPath || !this.debugLogEnabled) {
            return;
        }
        try {
            await this.maintainDebugLog();
            await mkdir(path.dirname(this.debugLogPath), { recursive: true });
            const line = JSON.stringify({
                ts: new Date().toISOString(),
                seq: ++this.traceSequence,
                event,
                details: sanitizeData(details),
            });
            await appendFile(this.debugLogPath, `${line}\n`, "utf8");
        } catch {
            // Ignore trace write failures to avoid breaking login flow.
        }
    }

    async traceEvent(event: string, details: Record<string, any>) {
        await this.trace(event, details);
    }

    async loadTokenStore() {
        if (this.token) {
            return;
        }
        if (this.loadTokenStorePromise) {
            await this.loadTokenStorePromise;
            return;
        }

        this.loadTokenStorePromise = (async () => {
            if (this.token) {
                return;
            }

            if (!this.tokenStorePath) {
                this.token = { deviceId: randomString(16).toUpperCase() };
                await this.trace("token_store_bootstrap", {
                    tokenStorePath: null,
                    deviceId: this.token.deviceId,
                });
                return;
            }

            try {
                const content = await readFile(this.tokenStorePath, "utf8");
                const parsed = JSON.parse(content) as XiaomiTokenStore;
                if (parsed && parsed.deviceId) {
                    this.token = {
                        deviceId: parsed.deviceId,
                        userId: parsed.userId,
                        cUserId: parsed.cUserId,
                        passToken: parsed.passToken,
                        micoapi: parsed.micoapi
                            ? [parsed.micoapi[0], parsed.micoapi[1]]
                            : undefined,
                        xiaomiio: parsed.xiaomiio
                            ? [parsed.xiaomiio[0], parsed.xiaomiio[1]]
                            : undefined,
                    };
                    await this.trace("token_store_loaded", {
                        tokenStorePath: this.tokenStorePath,
                        token: {
                            deviceId: this.token.deviceId,
                            userId: this.token.userId,
                            cUserId: this.token.cUserId,
                            passToken: this.token.passToken,
                            micoapi: this.token.micoapi
                                ? {
                                    ssecurity: this.token.micoapi[0],
                                    serviceToken: this.token.micoapi[1],
                                }
                                : undefined,
                            xiaomiio: this.token.xiaomiio
                                ? {
                                    ssecurity: this.token.xiaomiio[0],
                                    serviceToken: this.token.xiaomiio[1],
                                }
                                : undefined,
                        },
                    });
                    return;
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
                    await this.trace("token_store_load_failed", {
                        tokenStorePath: this.tokenStorePath,
                        message: error instanceof Error ? error.message : String(error),
                    });
                }
            }

            this.token = { deviceId: randomString(16).toUpperCase() };
            await this.trace("token_store_bootstrap", {
                tokenStorePath: this.tokenStorePath,
                deviceId: this.token.deviceId,
            });
        })();

        try {
            await this.loadTokenStorePromise;
        } finally {
            this.loadTokenStorePromise = undefined;
        }
    }

    async saveTokenStore() {
        if (!this.tokenStorePath || !this.token) {
            return;
        }
        await mkdir(path.dirname(this.tokenStorePath), { recursive: true });
        await writeFile(
            this.tokenStorePath,
            JSON.stringify(
                {
                    deviceId: this.token.deviceId,
                    userId: this.token.userId,
                    cUserId: this.token.cUserId,
                    passToken: this.token.passToken,
                    micoapi: this.token.micoapi,
                    xiaomiio: this.token.xiaomiio,
                },
                null,
                2
            ),
            {
                encoding: "utf8",
                mode: 0o600,
            }
        );
        await this.trace("token_store_saved", {
            tokenStorePath: this.tokenStorePath,
            token: {
                deviceId: this.token.deviceId,
                userId: this.token.userId,
                cUserId: this.token.cUserId,
                passToken: this.token.passToken,
                micoapi: this.token.micoapi
                    ? { ssecurity: this.token.micoapi[0], serviceToken: this.token.micoapi[1] }
                    : undefined,
                xiaomiio: this.token.xiaomiio
                    ? { ssecurity: this.token.xiaomiio[0], serviceToken: this.token.xiaomiio[1] }
                    : undefined,
            },
        });
    }

    setTokenStore(tokenStore: XiaomiTokenStore) {
        this.token = {
            deviceId: tokenStore.deviceId,
            userId: tokenStore.userId,
            cUserId: tokenStore.cUserId,
            passToken: tokenStore.passToken,
            micoapi: tokenStore.micoapi ? [tokenStore.micoapi[0], tokenStore.micoapi[1]] : undefined,
            xiaomiio: tokenStore.xiaomiio ? [tokenStore.xiaomiio[0], tokenStore.xiaomiio[1]] : undefined
        };
    }

    async invalidateSid(sid: XiaomiSid) {
        await this.loadTokenStore();
        if (!this.token) {
            return;
        }
        await this.trace("invalidate_sid", {
            sid,
            existed: Boolean(this.token[sid]),
        });
        delete this.token[sid];
        await this.saveTokenStore();
    }

    async clearStoredPassToken() {
        await this.loadTokenStore();
        if (!this.token) {
            return;
        }
        await this.trace("clear_pass_token", {
            hadPassToken: Boolean(this.token.passToken),
            hadCookiePassToken: Boolean(this.accountCookies.passToken),
        });
        delete this.token.passToken;
        delete this.token.cUserId;
        delete this.accountCookies.passToken;
        delete this.accountCookies.userId;
        delete this.accountCookies.cUserId;
        await this.saveTokenStore();
    }

    getDeviceId(): string {
        if (!this.token?.deviceId) {
            throw new Error("Xiaomi token store has not been initialized.");
        }
        return this.token.deviceId;
    }

    getUserId(): string | undefined {
        return this.token?.userId;
    }

    getSidToken(sid: XiaomiSid): XiaomiTokenEntry | undefined {
        return this.token?.[sid];
    }

    getVerificationState(): XiaomiVerificationState | null {
        if (!this.token || !this.verificationUrl) {
            return null;
        }
        return {
            tokenStore: {
                deviceId: this.token.deviceId,
                userId: this.token.userId,
                cUserId: this.token.cUserId,
                passToken: this.token.passToken,
                micoapi: this.token.micoapi
                    ? [this.token.micoapi[0], this.token.micoapi[1]]
                    : undefined,
                xiaomiio: this.token.xiaomiio
                    ? [this.token.xiaomiio[0], this.token.xiaomiio[1]]
                    : undefined,
            },
            accountCookies: { ...this.accountCookies },
            verifyUrl: this.verificationUrl,
            verifyMethods: [...this.verificationMethods],
            identitySession: this.identitySession,
        };
    }

    setVerificationState(state: XiaomiVerificationState) {
        this.setTokenStore(state.tokenStore);
        for (const key of Object.keys(this.accountCookies)) {
            delete this.accountCookies[key];
        }
        Object.assign(this.accountCookies, state.accountCookies);
        this.verificationUrl = state.verifyUrl;
        this.verificationMethods = [...state.verifyMethods];
        this.identitySession =
            state.identitySession || state.accountCookies.identity_session;
    }

    async ensureSid(sid: XiaomiSid) {
        await this.loadTokenStore();
        if (this.token?.[sid]) {
            return;
        }
        await this.login(sid);
    }

    private buildPythonCandidates(
        preferred?: Pick<PythonCommandCandidate, "command" | "argsPrefix">
    ): PythonCommandCandidate[] {
        const candidates: PythonCommandCandidate[] = [];
        const seen = new Set<string>();
        const pushCandidate = (
            command: string | undefined,
            argsPrefix: string[],
            source: PythonCommandCandidate["source"]
        ) => {
            const trimmed = command?.trim();
            if (!trimmed) {
                return;
            }
            const key = `${trimmed}\u0000${argsPrefix.join("\u0000")}`;
            if (seen.has(key)) {
                return;
            }
            seen.add(key);
            candidates.push({
                command: trimmed,
                argsPrefix: [...argsPrefix],
                source,
            });
        };

        if (preferred?.command) {
            pushCandidate(preferred.command, preferred.argsPrefix || [], "configured");
        }

        if (this.pythonCommand) {
            const configuredBase = path.basename(this.pythonCommand).toLowerCase();
            pushCandidate(
                this.pythonCommand,
                configuredBase === "py" || configuredBase === "py.exe" ? ["-3"] : [],
                "configured"
            );
        }

        pushCandidate("python3", [], "builtin");
        pushCandidate("python", [], "builtin");
        pushCandidate("py", ["-3"], "builtin");

        return candidates;
    }

    private cachePythonRuntimeStatus(status: XiaomiPythonRuntimeStatus) {
        this.pythonRuntimeStatus = {
            ...status,
            argsPrefix: status.argsPrefix ? [...status.argsPrefix] : undefined,
        };
        return this.pythonRuntimeStatus;
    }

    async getMicoapiPythonRuntimeStatus(force = false): Promise<XiaomiPythonRuntimeStatus> {
        if (!force && this.pythonRuntimeStatus) {
            return this.pythonRuntimeStatus;
        }

        let importErrorStatus: XiaomiPythonRuntimeStatus | undefined;
        let probeFailureStatus: XiaomiPythonRuntimeStatus | undefined;
        let sawNonEnoentError = false;

        for (const candidate of this.buildPythonCandidates()) {
            await this.trace("python_runtime_probe_start", {
                command: candidate.command,
                argsPrefix: candidate.argsPrefix,
                source: candidate.source,
            });
            try {
                const { stdout, stderr } = await execFileText(candidate.command, [
                    ...candidate.argsPrefix,
                    "-c",
                    PYTHON_REQUESTS_PROBE_SCRIPT,
                ]);
                const payload = parseJson<any>((stdout || "").trim());
                await this.trace("python_runtime_probe_result", {
                    command: candidate.command,
                    argsPrefix: candidate.argsPrefix,
                    source: candidate.source,
                    payload,
                    stderr: stderr || "",
                });

                if (payload?.ok) {
                    return this.cachePythonRuntimeStatus({
                        ready: true,
                        kind: "ready",
                        command: candidate.command,
                        argsPrefix: candidate.argsPrefix,
                        pythonVersion: firstNonEmptyText(payload?.pythonVersion),
                        requestsVersion: firstNonEmptyText(payload?.requestsVersion),
                        detail: [
                            `已找到可用 Python: ${candidate.command}`,
                            firstNonEmptyText(payload?.pythonVersion)
                                ? `Python ${payload.pythonVersion}`
                                : undefined,
                            firstNonEmptyText(payload?.requestsVersion)
                                ? `requests ${payload.requestsVersion}`
                                : undefined,
                        ]
                            .filter(Boolean)
                            .join(" | "),
                    });
                }

                const errorText =
                    firstNonEmptyText(payload?.error) || truncateText(JSON.stringify(payload), 200);
                if (payload?.kind === "import_error") {
                    importErrorStatus = {
                        ready: false,
                        kind: "missing_requests",
                        command: candidate.command,
                        argsPrefix: candidate.argsPrefix,
                        pythonVersion: firstNonEmptyText(payload?.pythonVersion),
                        detail: `已找到 ${candidate.command}，但缺少 Python requests 库: ${errorText}`,
                    };
                } else {
                    sawNonEnoentError = true;
                    probeFailureStatus = {
                        ready: false,
                        kind: "probe_failed",
                        command: candidate.command,
                        argsPrefix: candidate.argsPrefix,
                        pythonVersion: firstNonEmptyText(payload?.pythonVersion),
                        detail: `执行 ${candidate.command} 探测失败: ${errorText}`,
                    };
                }
            } catch (error) {
                const details = errorDetails(error);
                await this.trace("python_runtime_probe_error", {
                    command: candidate.command,
                    argsPrefix: candidate.argsPrefix,
                    source: candidate.source,
                    error: details,
                });

                const combined = [
                    details.message,
                    details.causeCode,
                    details.causeMessage,
                ]
                    .filter(Boolean)
                    .join(" | ");
                const isEnoent = combined.includes("ENOENT");
                if (!isEnoent) {
                    sawNonEnoentError = true;
                    probeFailureStatus = {
                        ready: false,
                        kind: "probe_failed",
                        command: candidate.command,
                        argsPrefix: candidate.argsPrefix,
                        detail: `执行 ${candidate.command} 失败: ${truncateText(combined, 240)}`,
                    };
                }
            }
        }

        if (importErrorStatus) {
            return this.cachePythonRuntimeStatus(importErrorStatus);
        }
        if (probeFailureStatus && sawNonEnoentError) {
            return this.cachePythonRuntimeStatus(probeFailureStatus);
        }

        const attempted = this.buildPythonCandidates().map((candidate) => candidate.command).join(", ");
        return this.cachePythonRuntimeStatus({
            ready: false,
            kind: "missing_python",
            detail: `未找到可用的 Python 解释器，已尝试: ${attempted || "python3, python, py"}`,
        });
    }

    private buildMicoapiRuntimeHelp(status: XiaomiPythonRuntimeStatus): string {
        const debugLogLine = this.debugLogPath ? `调试日志：${this.debugLogPath}` : undefined;
        if (status.kind === "missing_requests") {
            const command = status.command || this.pythonCommand || "python3";
            return [
                "当前环境里的 Python 可以运行，但缺少 requests 库，无法稳定完成 micoapi 登录。",
                `请先安装依赖，例如执行：${command} -m pip install requests`,
                "如果系统不方便用 pip，也可以安装系统包 python3-requests。",
                "补好依赖后重新打开登录页，再按账号密码流程登录一次即可。",
                debugLogLine,
            ]
                .filter(Boolean)
                .join("\n");
        }

        if (status.kind === "missing_python") {
            return [
                "当前环境缺少可用的 Python 解释器，无法稳定完成 micoapi 登录。",
                "请先安装 python3，或者在插件配置里设置 pythonCommand 指向实际解释器路径。",
                "补好环境后重新打开登录页，再按账号密码流程登录一次即可。",
                debugLogLine,
            ]
                .filter(Boolean)
                .join("\n");
        }

        return [
            "micoapi 登录辅助运行失败，当前环境暂时无法稳定获取 serviceToken。",
            status.detail,
            "请先查看调试日志里的 python_runtime_probe 和 python_micoapi_login 记录定位问题。",
            "排查完成后重新打开登录页，再按账号密码流程重新登录。",
            debugLogLine,
        ]
            .filter(Boolean)
            .join("\n");
    }

    private async accountRequestRaw(
        url: string,
        options: {
            method?: "GET" | "POST";
            query?: Record<string, any>;
            body?: Record<string, any>;
            cookies?: Record<string, string>;
        }
    ): Promise<{ response: Response; text: string }> {
        await this.loadTokenStore();
        if (!this.token) {
            throw new Error("Xiaomi account store is not ready.");
        }

        const targetUrl = appendQuery(url, options.query || {});
        const requestHost = safeUrlHostname(targetUrl);
        const sendAccountCookies = requestHost === "account.xiaomi.com";
        const headers = new Headers({
            "User-Agent": buildAccountUserAgent(this.token.deviceId)
        });

        const mergedCookies: Record<string, string> = sendAccountCookies
            ? {
                  sdkVersion: ACCOUNT_SDK_VERSION,
                  deviceId: this.token.deviceId,
                  ...this.accountCookies,
                  ...(options.cookies || {})
              }
            : {
                  ...(options.cookies || {})
              };

        if (sendAccountCookies && this.token.passToken) {
            mergedCookies.userId = this.token.userId || "";
            mergedCookies.cUserId = this.token.cUserId || "";
            mergedCookies.passToken = this.token.passToken;
        }

        if (Object.keys(mergedCookies).length > 0) {
            headers.set("Cookie", buildCookieHeader(mergedCookies));
        }
        const method = options.method || (options.body ? "POST" : "GET");
        let lastError: unknown;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            await this.trace("account_request_start", {
                method,
                attempt,
                url: targetUrl,
                requestHost,
                sendAccountCookies,
                body: options.body,
                cookieKeys: Object.keys(mergedCookies),
                cookies: sanitizeCookieRecord(mergedCookies),
            });
            try {
                const response = await fetch(targetUrl, {
                    method,
                    headers,
                    body: options.body ? formEncode(options.body) : undefined,
                    redirect: "manual",
                    signal: buildTimeoutSignal()
                });

                const setCookieLines = extractSetCookieLines(response.headers);
                mergeCookies(this.accountCookies, setCookieLines);
                const text = await response.text();
                await this.trace("account_request_end", {
                    method,
                    attempt,
                    url: targetUrl,
                    status: response.status,
                    responseUrl: response.url,
                    location: response.headers.get("location"),
                    setCookies: sanitizeCookieRecord(
                        setCookieLines.reduce<Record<string, string>>((accumulator, line) => {
                            const firstPart = line.split(";")[0];
                            const separatorIndex = firstPart.indexOf("=");
                            if (separatorIndex > 0) {
                                accumulator[firstPart.slice(0, separatorIndex).trim()] = firstPart
                                    .slice(separatorIndex + 1)
                                    .trim();
                            }
                            return accumulator;
                        }, {})
                    ),
                    body: sanitizeText(text),
                });
                return { response, text };
            } catch (error) {
                lastError = error;
                await this.trace("account_request_error", {
                    method,
                    attempt,
                    url: targetUrl,
                    error: errorDetails(error),
                });
                if (attempt < 3) {
                    await sleep(200 * attempt);
                    continue;
                }
            }
        }
        throw new Error(formatNetworkError(lastError, targetUrl));
    }

    private async accountRequestJson(
        url: string,
        options: {
            method?: "GET" | "POST";
            query?: Record<string, any>;
            body?: Record<string, any>;
            cookies?: Record<string, string>;
        }
    ): Promise<any> {
        const { text } = await this.accountRequestRaw(url, options);
        return parseJson(text);
    }

    private clearVerificationState() {
        this.verificationUrl = undefined;
        this.verificationMethods = [];
        this.identitySession = undefined;
        delete this.accountCookies.identity_session;
    }

    private applyAuthSnapshot(auth: any) {
        if (!auth || typeof auth !== "object" || !this.token) {
            return;
        }

        const userId = firstNonEmptyText(
            auth.userId,
            this.accountCookies.userId,
            this.token.userId
        );
        if (userId) {
            this.token.userId = String(userId);
        }

        const cUserId = firstNonEmptyText(
            auth.cUserId,
            this.accountCookies.cUserId,
            this.token.cUserId
        );
        if (cUserId) {
            this.token.cUserId = String(cUserId);
        }

        const passToken = firstNonEmptyText(
            auth.passToken,
            this.accountCookies.passToken,
            this.token.passToken
        );
        if (passToken) {
            this.token.passToken = String(passToken);
        }
    }

    private hasStep2Credentials(auth: any, sid: XiaomiSid): boolean {
        if (!firstNonEmptyText(auth?.location)) {
            return false;
        }
        if (!needsSsecurityForSid(sid)) {
            return true;
        }
        return Boolean(firstNonEmptyText(auth?.ssecurity));
    }

    private withClientSignIfNeeded(sid: XiaomiSid, auth: any, location: string): string {
        const nonce = firstNonEmptyText(auth?.nonce);
        const ssecurity = firstNonEmptyText(auth?.ssecurity);
        if (
            sid !== "xiaomiio" &&
            nonce &&
            ssecurity &&
            !location.includes("clientSign=")
        ) {
            const separator = location.includes("?") ? "&" : "?";
            return `${location}${separator}clientSign=${encodeURIComponent(
                sha1Base64(`nonce=${nonce}&${ssecurity}`)
            )}`;
        }
        return location;
    }

    private async accountLoginStep1(sid: XiaomiSid): Promise<any> {
        const auth = await this.accountRequestJson(`${ACCOUNT_BASE_URL}/serviceLogin`, {
            method: "GET",
            query: {
                sid,
                _json: "true"
            }
        });

        if (auth?.code === 0) {
            this.applyAuthSnapshot(auth);
        }

        return auth;
    }

    private async accountLoginStep2(sid: XiaomiSid, auth: any): Promise<any> {
        if (!this.password) {
            throw new Error(
                `Xiaomi sid ${sid} requires password login, but no password was configured.`
            );
        }

        const nextAuth = await this.accountRequestJson(
            `${ACCOUNT_BASE_URL}/serviceLoginAuth2`,
            {
                method: "POST",
                query: {
                    _json: "true"
                },
                body: {
                    user: this.username,
                    hash: md5Upper(this.password),
                    callback: auth?.callback || "",
                    sid: auth?.sid || sid,
                    qs: auth?.qs || "",
                    _sign: auth?._sign || ""
                }
            }
        );

        if (nextAuth?.code !== 0 || !this.hasStep2Credentials(nextAuth, sid)) {
            throw await this.buildLoginFailure(nextAuth, sid);
        }

        this.applyAuthSnapshot(nextAuth);

        let location = this.withClientSignIfNeeded(sid, nextAuth, String(nextAuth.location));

        return {
            ...nextAuth,
            location
        };
    }

    private async tryPythonServiceTokenRequest(url: string): Promise<string | null> {
        if (!this.token) {
            return null;
        }

        const runtimeStatus = await this.getMicoapiPythonRuntimeStatus();
        const preferred =
            runtimeStatus.ready && runtimeStatus.command
                ? {
                      command: runtimeStatus.command,
                      argsPrefix: runtimeStatus.argsPrefix || [],
                  }
                : undefined;

        for (const candidate of this.buildPythonCandidates(preferred)) {
            await this.trace("python_sts_helper_start", {
                command: candidate.command,
                argsPrefix: candidate.argsPrefix,
                url,
            });
            try {
                const { stdout, stderr } = await execFileText(candidate.command, [
                    ...candidate.argsPrefix,
                    "-c",
                    PYTHON_STS_SCRIPT,
                    url,
                    buildAccountUserAgent(this.token.deviceId),
                ]);
                const payload = parseJson<any>((stdout || "").trim());
                await this.trace("python_sts_helper_result", {
                    command: candidate.command,
                    argsPrefix: candidate.argsPrefix,
                    payload,
                    stderr: stderr || "",
                });
                const serviceToken = firstNonEmptyText(payload?.serviceToken);
                if (payload?.ok && payload?.status === 200 && serviceToken) {
                    return serviceToken;
                }
            } catch (error) {
                await this.trace("python_sts_helper_error", {
                    command: candidate.command,
                    url,
                    error: errorDetails(error),
                });
            }
        }

        return null;
    }

    private async tryPythonMicoapiLogin(): Promise<{
        serviceToken: string;
        ssecurity?: string;
        userId?: string;
        cUserId?: string;
        passToken?: string;
    } | null> {
        if (!this.token?.deviceId || !this.token.userId || !this.token.passToken) {
            return null;
        }

        const runtimeStatus = await this.getMicoapiPythonRuntimeStatus();
        if (!runtimeStatus.ready) {
            await this.trace("python_micoapi_login_skipped", {
                reason: runtimeStatus.kind,
                detail: runtimeStatus.detail,
            });
            return null;
        }

        const userAgent = buildAccountUserAgent(this.token.deviceId);
        const preferred =
            runtimeStatus.command
                ? {
                      command: runtimeStatus.command,
                      argsPrefix: runtimeStatus.argsPrefix || [],
                  }
                : undefined;

        for (const candidate of this.buildPythonCandidates(preferred)) {
            await this.trace("python_micoapi_login_start", {
                command: candidate.command,
                argsPrefix: candidate.argsPrefix,
                deviceId: this.token.deviceId,
                userId: this.token.userId,
            });
            try {
                const { stdout, stderr } = await execFileText(candidate.command, [
                    ...candidate.argsPrefix,
                    "-c",
                    PYTHON_MICOAPI_LOGIN_SCRIPT,
                    this.token.deviceId,
                    this.token.userId,
                    this.token.passToken,
                    userAgent,
                ]);
                const payload = parseJson<any>((stdout || "").trim());
                await this.trace("python_micoapi_login_result", {
                    command: candidate.command,
                    argsPrefix: candidate.argsPrefix,
                    payload,
                    stderr: stderr || "",
                });
                const serviceToken = firstNonEmptyText(payload?.serviceToken);
                if (payload?.ok && payload?.status === 200 && serviceToken) {
                    return {
                        serviceToken,
                        ssecurity: firstNonEmptyText(payload?.ssecurity),
                        userId: firstNonEmptyText(payload?.userId),
                        cUserId: firstNonEmptyText(payload?.cUserId),
                        passToken: firstNonEmptyText(payload?.passToken),
                    };
                }
            } catch (error) {
                await this.trace("python_micoapi_login_error", {
                    command: candidate.command,
                    error: errorDetails(error),
                });
            }
        }

        await this.trace("python_micoapi_login_no_token", {
            detail: runtimeStatus.detail,
            command: runtimeStatus.command || null,
        });
        return null;
    }

    private async accountLoginStep3(location: string): Promise<string> {
        let currentUrl = resolveAccountUrl(location);
        if (!currentUrl) {
            throw new Error(`Invalid Xiaomi login redirect location: ${location}`);
        }

        delete this.accountCookies.serviceToken;

        for (let index = 0; index < 12; index += 1) {
            if (safeUrlHostname(currentUrl) === "api2.mina.mi.com") {
                const pythonServiceToken = await this.tryPythonServiceTokenRequest(currentUrl);
                if (pythonServiceToken) {
                    return pythonServiceToken;
                }
            }

            const { response, text } = await this.accountRequestRaw(currentUrl, {
                method: "GET"
            });
            const responseCookies: Record<string, string> = {};
            mergeCookies(responseCookies, extractSetCookieLines(response.headers));
            const serviceToken = firstNonEmptyText(
                responseCookies.serviceToken,
                this.accountCookies.serviceToken
            );
            if (serviceToken) {
                return serviceToken;
            }

            const nextLocation = response.headers.get("location");
            if (!nextLocation) {
                throw new Error(
                    `Xiaomi login redirect did not provide serviceToken: ${text}`
                );
            }
            currentUrl = new URL(nextLocation, currentUrl).toString();
        }

        throw new Error("Failed to retrieve Xiaomi serviceToken after redirects.");
    }

    private async getVerificationDetails(
        verifyUrl: string
    ): Promise<XiaomiVerificationDetails> {
        const inferredMethods = inferVerificationMethodsFromUrl(verifyUrl);
        if (!verifyUrl.includes("/fe/service/identity/authStart")) {
            return {
                methods: inferredMethods,
                identitySession:
                    this.identitySession || this.accountCookies.identity_session,
            };
        }

        const identityListUrl = verifyUrl.replace(
            "/fe/service/identity/authStart",
            "/identity/list"
        );
        const { text } = await this.accountRequestRaw(identityListUrl, {
            method: "GET",
        });
        const identitySession =
            this.accountCookies.identity_session || this.identitySession;
        if (identitySession) {
            this.identitySession = identitySession;
        }

        let payload: any;
        try {
            payload = parseJson(text);
        } catch {
            return {
                methods: [],
                identitySession,
            };
        }

        const flags = Array.isArray(payload?.options) && payload.options.length
            ? payload.options
            : [payload?.flag ?? 4];

        const methods = new Set<XiaomiVerificationMethod>();
        for (const flag of flags) {
            if (Number(flag) === 4) {
                methods.add("phone");
            } else if (Number(flag) === 8) {
                methods.add("email");
            }
        }
        return {
            methods: mergeVerificationMethods(Array.from(methods), inferredMethods),
            identitySession,
        };
    }

    private async resolveVerificationUrlFromLocation(
        location: string
    ): Promise<{
        verifyUrl?: string;
        methods: XiaomiVerificationMethod[];
        identitySession?: string;
    }> {
        const resolvedLocation = resolveAccountUrl(location);
        if (!resolvedLocation) {
            return { methods: [] };
        }

        let currentUrl = resolvedLocation;
        const visited = new Set<string>();
        for (let index = 0; index < 12; index += 1) {
            if (visited.has(currentUrl)) {
                break;
            }
            visited.add(currentUrl);
            const { response, text } = await this.accountRequestRaw(currentUrl, {
                method: "GET",
            });

            const responseUrl = resolveAccountUrl(response.url);
            if (
                responseUrl &&
                /\/fe\/service\/identity\/(?:authStart|verifyPhone|verifyEmail)/i.test(
                    responseUrl
                )
            ) {
                const details = await this.getVerificationDetails(responseUrl);
                return {
                    verifyUrl: responseUrl,
                    methods: mergeVerificationMethods(
                        details.methods,
                        inferVerificationMethodsFromUrl(responseUrl)
                    ),
                    identitySession: details.identitySession,
                };
            }

            const embeddedVerifyUrl =
                findVerificationUrlInText(text) || findVerificationPageUrlInText(text);
            if (embeddedVerifyUrl) {
                const details = await this.getVerificationDetails(embeddedVerifyUrl);
                return {
                    verifyUrl: embeddedVerifyUrl,
                    methods: mergeVerificationMethods(
                        details.methods,
                        inferVerificationMethodsFromUrl(embeddedVerifyUrl)
                    ),
                    identitySession: details.identitySession,
                };
            }

            const embeddedFollowupUrl = resolveAccountUrl(
                (() => {
                    const absoluteMatch = text.match(
                        /https?:\/\/account\.xiaomi\.com\/(?:pass2\/redirect|fe\/service\/notification)[^\s"'<>)]*/i
                    );
                    if (absoluteMatch?.[0]) {
                        return absoluteMatch[0];
                    }
                    const relativeMatch = text.match(
                        /\/(?:pass2\/redirect|fe\/service\/notification)[^\s"'<>)]*/i
                    );
                    return relativeMatch?.[0];
                })()
            );
            if (
                embeddedFollowupUrl &&
                !visited.has(embeddedFollowupUrl) &&
                embeddedFollowupUrl !== currentUrl
            ) {
                currentUrl = embeddedFollowupUrl;
                continue;
            }

            const nextLocation = response.headers.get("location");
            if (!nextLocation) {
                break;
            }
            currentUrl = new URL(nextLocation, currentUrl).toString();
        }

        return { methods: [] };
    }

    private async refreshVerificationChallenge(verifyUrl: string): Promise<{
        verifyUrl: string;
        methods: XiaomiVerificationMethod[];
        identitySession?: string;
    }> {
        let effectiveVerifyUrl = resolveAccountUrl(verifyUrl) || verifyUrl;
        let methods = mergeVerificationMethods(
            this.verificationMethods,
            inferVerificationMethodsFromUrl(effectiveVerifyUrl)
        );
        let identitySession = this.identitySession || this.accountCookies.identity_session;

        const details = await this.getVerificationDetails(effectiveVerifyUrl);
        methods = mergeVerificationMethods(methods, details.methods);
        identitySession = details.identitySession || identitySession;

        if (
            !effectiveVerifyUrl.includes("/fe/service/identity/authStart") ||
            methods.length === 0 ||
            !identitySession
        ) {
            const discovered = await this.resolveVerificationUrlFromLocation(
                effectiveVerifyUrl
            );
            if (discovered.verifyUrl) {
                effectiveVerifyUrl = discovered.verifyUrl;
            }
            methods = mergeVerificationMethods(
                methods,
                discovered.methods,
                inferVerificationMethodsFromUrl(effectiveVerifyUrl)
            );
            identitySession = discovered.identitySession || identitySession;

            if (methods.length === 0 || !identitySession) {
                const refreshed = await this.getVerificationDetails(effectiveVerifyUrl);
                methods = mergeVerificationMethods(
                    methods,
                    refreshed.methods,
                    inferVerificationMethodsFromUrl(effectiveVerifyUrl)
                );
                identitySession = refreshed.identitySession || identitySession;
            }
        }

        this.verificationUrl = effectiveVerifyUrl;
        this.verificationMethods = methods;
        this.identitySession = identitySession || undefined;
        return {
            verifyUrl: effectiveVerifyUrl,
            methods,
            identitySession: identitySession || undefined,
        };
    }

    private async followAccountRedirects(location: string): Promise<void> {
        let currentUrl = resolveAccountUrl(location);
        if (!currentUrl) {
            return;
        }

        for (let index = 0; index < 12; index += 1) {
            const { response } = await this.accountRequestRaw(currentUrl, {
                method: "GET",
            });
            const nextLocation = response.headers.get("location");
            if (!nextLocation) {
                return;
            }
            currentUrl = new URL(nextLocation, currentUrl).toString();
        }
    }

    private async buildLoginFailure(auth: any, sid: XiaomiSid): Promise<Error> {
        await this.trace("login_failure_detected", {
            sid,
            auth,
        });
        console.warn(
            `[XiaoAI Cloud] Xiaomi login step failed for ${sid}: ${JSON.stringify({
                code: auth?.code,
                desc: auth?.desc,
                message: auth?.message,
                notificationUrl: auth?.notificationUrl,
                captchaUrl: auth?.captchaUrl,
                hasLocation: Boolean(auth?.location),
                hasNonce: Boolean(auth?.nonce),
                hasSsecurity: Boolean(auth?.ssecurity),
            })}`
        );

        let verifyUrl =
            resolveAccountUrl(auth.notificationUrl) ||
            (looksLikeVerificationPath(auth.desc)
                ? resolveAccountUrl(auth.desc)
                : undefined) ||
            (looksLikeVerificationPath(auth.message)
                ? resolveAccountUrl(auth.message)
                : undefined);
        let methods: XiaomiVerificationMethod[] = [];
        let identitySession: string | undefined;

        if (verifyUrl) {
            const details = await this.refreshVerificationChallenge(verifyUrl);
            verifyUrl = details.verifyUrl;
            methods = details.methods;
            identitySession = details.identitySession;
        } else if (auth.location) {
            const discovered = await this.resolveVerificationUrlFromLocation(
                String(auth.location)
            );
            verifyUrl = discovered.verifyUrl;
            methods = discovered.methods;
            identitySession = discovered.identitySession;
            if (verifyUrl) {
                const refreshed = await this.refreshVerificationChallenge(verifyUrl);
                verifyUrl = refreshed.verifyUrl;
                methods = refreshed.methods;
                identitySession = refreshed.identitySession;
            }
        }

        if (verifyUrl) {
            this.verificationUrl = verifyUrl;
            this.verificationMethods = methods;
            this.identitySession =
                identitySession || this.accountCookies.identity_session;
            await this.trace("login_verification_required", {
                sid,
                verifyUrl,
                methods,
                identitySession: this.identitySession || null,
            });
            console.info(
                `[XiaoAI Cloud] Xiaomi verification challenge for ${sid}: methods=${
                    methods.join(",") || "unknown"
                }, identitySession=${this.identitySession ? "ready" : "missing"}`
            );
            const state = this.getVerificationState();
            if (state) {
                return new XiaomiVerificationRequiredError({
                    sid,
                    verifyUrl,
                    methods,
                    state,
                    message: [
                        `小米账号登录需要先完成一次${methods.includes("phone") ? "短信" : methods.includes("email") ? "邮箱" : ""}安全验证。`,
                        "请先点登录页上的“发送验证码”按钮获取验证码。",
                        "回到当前登录页填写验证码后，再点“登录”继续。",
                    ]
                        .filter(Boolean)
                        .join("\n"),
                });
            }
        }

        const captchaUrl = resolveAccountUrl(auth.captchaUrl);
        if (captchaUrl) {
            return new Error(
                [
                    "这次小米账号登录触发了验证码校验，账号密码登录暂时无法直接继续。",
                    "请先处理验证码或稍后再试，然后重新发起账号密码登录。",
                    `验证码地址：${captchaUrl}`,
                ].join("\n")
            );
        }

        const extra =
            auth.notificationUrl ||
            auth.captchaUrl ||
            auth.location ||
            auth.desc ||
            auth.message ||
            JSON.stringify(auth);
        return new Error(`Xiaomi login failed for sid ${sid}: ${extra}`);
    }

    private async verifyTicket(sid: XiaomiSid, ticket: string): Promise<any> {
        const activeVerifyUrl = this.verificationUrl;
        if (!activeVerifyUrl) {
            throw new Error("当前没有可继续的二次验证会话，请重新发起一次登录。");
        }

        const trimmedTicket = ticket.trim();
        if (!trimmedTicket) {
            throw new Error("请输入短信或邮箱收到的验证码。");
        }

        const details = await this.refreshVerificationChallenge(activeVerifyUrl);
        const verifyUrl = details.verifyUrl;
        const methods =
            details.methods.length > 0 ? details.methods : ["phone", "email"];
        const identitySession =
            details.identitySession || this.accountCookies.identity_session;

        if (!identitySession) {
            console.warn(
                `[XiaoAI Cloud] Xiaomi verification for ${sid} is missing identity_session.`
            );
            throw new Error(
                "当前二次验证会话没有拿到 identity_session，请重新发送验证码后再提交。"
            );
        }

        console.info(
            `[XiaoAI Cloud] Continuing Xiaomi verification for ${sid}: methods=${
                methods.join(",") || "fallback"
            }, identitySession=ready`
        );
        await this.trace("verification_ticket_start", {
            sid,
            verifyUrl,
            methods,
            identitySession,
            ticket,
        });

        let lastErrorMessage: string | undefined;

        for (const method of methods) {
            const api =
                method === "phone"
                    ? `${ACCOUNT_ORIGIN}/identity/auth/verifyPhone`
                    : `${ACCOUNT_ORIGIN}/identity/auth/verifyEmail`;
            const flag = method === "phone" ? 4 : 8;
            const payload = await this.accountRequestJson(api, {
                method: "POST",
                query: {
                    _dc: Date.now(),
                },
                body: {
                    _flag: flag,
                    ticket: trimmedTicket,
                    trust: "true",
                    _json: "true",
                },
                cookies: {
                    identity_session: identitySession,
                },
            });
            if (payload?.code === 0) {
                await this.trace("verification_ticket_success", {
                    sid,
                    method,
                    payload,
                });
                console.info(
                    `[XiaoAI Cloud] Xiaomi verification for ${sid} completed via ${method}; redirect=${
                        payload.location ? "yes" : "no"
                    }`
                );
                delete this.accountCookies.identity_session;
                this.identitySession = undefined;
                return payload;
            }

            lastErrorMessage =
                firstNonEmptyText(
                    payload?.description,
                    payload?.desc,
                    payload?.message,
                    payload?.msg
                ) || lastErrorMessage;
            console.warn(
                `[XiaoAI Cloud] Xiaomi verification attempt for ${sid} via ${method} failed: ${
                    firstNonEmptyText(
                        payload?.description,
                        payload?.desc,
                        payload?.message,
                        payload?.msg
                    ) || `code=${String(payload?.code ?? "unknown")}`
                }`
            );
            await this.trace("verification_ticket_attempt_failed", {
                sid,
                method,
                payload,
            });
        }

        throw new Error(
            lastErrorMessage
                ? `验证码校验失败：${lastErrorMessage}`
                : "验证码校验失败，请确认你填的是刚收到的最新验证码，而且不要在小米验证页里直接完成验证。"
        );
    }

    private async runLoginRequest(
        sid: XiaomiSid,
        options?: {
            verifyTicket?: string;
        }
    ) {
        await this.loadTokenStore();
        if (!this.token) {
            throw new Error("Xiaomi token store is not ready.");
        }
        await this.trace("login_request_start", {
            sid,
            verifyTicket: options?.verifyTicket || null,
            tokenStorePath: this.tokenStorePath || null,
            tokenState: {
                deviceId: this.token.deviceId,
                userId: this.token.userId,
                cUserId: this.token.cUserId,
                hasPassToken: Boolean(this.token.passToken || this.accountCookies.passToken),
                hasMicoapi: Boolean(this.token.micoapi),
                hasXiaomiio: Boolean(this.token.xiaomiio),
            },
        });

        if (options?.verifyTicket) {
            const verificationResult = await this.verifyTicket(sid, options.verifyTicket);
            const verificationLocation = firstNonEmptyText(verificationResult?.location);
            if (verificationLocation) {
                await this.followAccountRedirects(verificationLocation);
            }
        }

        let auth = await this.accountLoginStep1(sid);
        let location = "";
        if (this.hasStep2Credentials(auth, sid)) {
            location = this.withClientSignIfNeeded(
                sid,
                auth,
                firstNonEmptyText(auth?.location) || ""
            );
            await this.trace("login_step1_short_circuit", {
                sid,
                reason: options?.verifyTicket ? "post_verification_session" : "existing_account_session",
                hasSsecurity: Boolean(firstNonEmptyText(auth?.ssecurity)),
                hasPassToken: Boolean(
                    firstNonEmptyText(
                        auth?.passToken,
                        this.accountCookies.passToken,
                        this.token.passToken
                    )
                ),
            });
        }
        if (!location) {
            auth = await this.accountLoginStep2(sid, auth);
            location = firstNonEmptyText(auth?.location) || "";
        }

        if (!location) {
            throw await this.buildLoginFailure(auth, sid);
        }

        this.applyAuthSnapshot(auth);
        const pythonRuntimeStatus =
            sid === "micoapi" ? await this.getMicoapiPythonRuntimeStatus() : undefined;
        if (sid === "micoapi") {
            const pythonMicoapi = await this.tryPythonMicoapiLogin();
            if (pythonMicoapi?.serviceToken) {
                if (pythonMicoapi.userId) {
                    this.token.userId = pythonMicoapi.userId;
                }
                if (pythonMicoapi.cUserId) {
                    this.token.cUserId = pythonMicoapi.cUserId;
                }
                if (pythonMicoapi.passToken) {
                    this.token.passToken = pythonMicoapi.passToken;
                }
                const pythonSsecurity =
                    firstNonEmptyText(pythonMicoapi.ssecurity, auth?.ssecurity) || "";
                if (!pythonSsecurity) {
                    throw new Error("Python micoapi login succeeded but did not provide ssecurity.");
                }
                this.token[sid] = [pythonSsecurity, pythonMicoapi.serviceToken];
                await this.trace("login_request_success", {
                    sid,
                    source: "python_micoapi_helper",
                    ssecurity: pythonSsecurity,
                    serviceToken: pythonMicoapi.serviceToken,
                });
                console.info(
                    `[XiaoAI Cloud] Xiaomi sid ${sid} token refreshed via python helper: serviceToken=${sha1HexShort(
                        pythonMicoapi.serviceToken
                    )}`
                );
                this.clearVerificationState();
                await this.saveTokenStore();
                return;
            }
        }
        let serviceToken: string;
        try {
            serviceToken = await this.accountLoginStep3(location);
        } catch (error) {
            const message = errorDetails(error).message || String(error);
            if (sid === "micoapi" && pythonRuntimeStatus && !pythonRuntimeStatus.ready) {
                throw new Error(
                    `${message}\n${this.buildMicoapiRuntimeHelp(pythonRuntimeStatus)}`
                );
            }
            if (sid === "micoapi" && pythonRuntimeStatus?.ready) {
                throw new Error(
                    [
                        message,
                        "Python micoapi 登录辅助已经可用，但当前这次请求仍未拿到 serviceToken。",
                        "请查看调试日志里的 python_micoapi_login_result、python_micoapi_login_no_token 和 account_request_end 记录继续定位。",
                        this.debugLogPath ? `调试日志：${this.debugLogPath}` : undefined,
                    ]
                        .filter(Boolean)
                        .join("\n")
                );
            }
            throw error;
        }
        const ssecurity = needsSsecurityForSid(sid)
            ? firstNonEmptyText(auth?.ssecurity)
            : "";
        if (needsSsecurityForSid(sid) && !ssecurity) {
            throw new Error(`Xiaomi login for sid ${sid} did not provide ssecurity.`);
        }
        this.token[sid] = [ssecurity || "", serviceToken];
        await this.trace("login_request_success", {
            sid,
            ssecurity: ssecurity || "",
            serviceToken,
        });
        console.info(
            `[XiaoAI Cloud] Xiaomi sid ${sid} token refreshed: serviceToken=${sha1HexShort(serviceToken)}`
        );
        this.clearVerificationState();
        await this.saveTokenStore();
    }

    async completeVerification(sid: XiaomiSid, ticket: string) {
        const trimmedTicket = ticket.trim();
        if (!trimmedTicket) {
            throw new Error("请输入短信或邮箱收到的验证码。");
        }
        await this.trace("complete_verification_called", {
            sid,
            ticket: trimmedTicket,
        });

        if (this.token) {
            delete this.token[sid];
        }

        await this.runLoginRequest(sid, {
            verifyTicket: trimmedTicket,
        });
    }

    async prepareVerificationPage(preferredMethod?: XiaomiVerificationMethod) {
        const activeVerifyUrl = this.verificationUrl;
        if (!activeVerifyUrl) {
            throw new Error("当前没有可继续的二次验证会话，请重新发起一次登录。");
        }

        const details = await this.refreshVerificationChallenge(activeVerifyUrl);
        const verifyUrl = details.verifyUrl;
        const methods: XiaomiVerificationMethod[] =
            details.methods.length > 0 ? details.methods : ["phone", "email"];
        const chosenMethod: XiaomiVerificationMethod =
            (preferredMethod && methods.includes(preferredMethod)
                ? preferredMethod
                : methods[0]) || "phone";
        const identitySession =
            details.identitySession || this.accountCookies.identity_session;

        if (!identitySession) {
            throw new Error(
                "当前二次验证会话没有拿到 identity_session，请重新登录后再试。"
            );
        }

        this.identitySession = identitySession;
        let openUrl = deriveVerificationPageUrl(verifyUrl, chosenMethod);
        try {
            const { response, text } = await this.accountRequestRaw(openUrl, {
                method: "GET",
                cookies: {
                    identity_session: identitySession,
                },
            });
            const responseUrl = resolveAccountUrl(response.url);
            openUrl =
                findVerificationPageUrlInText(text) ||
                (responseUrl &&
                /\/fe\/service\/identity\/(?:verifyPhone|verifyEmail|authStart)/i.test(
                    responseUrl
                )
                    ? responseUrl
                    : undefined) ||
                openUrl;
        } catch {
            // 如果预热失败，仍然退回到推导出的官方页面地址。
        }

        await this.trace("verification_page_prepared", {
            verifyUrl,
            openUrl,
            chosenMethod,
            methods,
            identitySession,
        });

        return {
            openUrl,
            method: chosenMethod,
            message:
                chosenMethod === "phone"
                    ? "官方短信验证页面已打开，请在那里获取验证码后回到这里填写。"
                    : "官方邮箱验证页面已打开，请在那里获取验证码后回到这里填写。",
        };
    }

    async requestVerificationCode(preferredMethod?: XiaomiVerificationMethod) {
        const activeVerifyUrl = this.verificationUrl;
        if (!activeVerifyUrl) {
            throw new Error("当前没有待处理的二次验证会话，请重新点一次登录。");
        }

        const details = await this.refreshVerificationChallenge(activeVerifyUrl);
        const verifyUrl = details.verifyUrl;
        const availableMethods = details.methods.length
            ? [...details.methods]
            : this.verificationMethods.length
                ? [...this.verificationMethods]
                : ["phone", "email"];
        const identitySession =
            details.identitySession || this.accountCookies.identity_session;

        if (identitySession) {
            this.identitySession = identitySession;
        }
        if (!identitySession) {
            throw new Error(
                "当前二次验证会话没有拿到 identity_session，请重新登录后再试。"
            );
        }

        try {
            await this.accountRequestRaw(verifyUrl, {
                method: "GET",
                cookies: {
                    identity_session: identitySession,
                },
            });
        } catch {
            // 这里只做会话预热，不把预热失败当成最终失败。
        }

        const orderedMethods = [
            ...(preferredMethod && availableMethods.includes(preferredMethod)
                ? [preferredMethod]
                : []),
            ...availableMethods.filter((item) => item !== preferredMethod),
        ];
        const methodsToTry = Array.from(
            new Set(
                orderedMethods.length
                    ? orderedMethods
                    : ["phone", "email"]
            )
        );

        let lastErrorMessage: string | undefined;
        for (const method of methodsToTry) {
            const requestAttempts =
                method === "phone"
                    ? [
                          {
                              url: `${ACCOUNT_ORIGIN}/identity/auth/sendPhoneTicket`,
                              body: {},
                          },
                          {
                              url: `${ACCOUNT_ORIGIN}/identity/auth/sendPhoneTicket`,
                              body: { _json: "true" },
                          },
                          {
                              url: `${ACCOUNT_ORIGIN}/identity/auth/sendPhoneTicket`,
                              body: { trust: "true", _json: "true" },
                          },
                      ]
                    : [
                          {
                              url: `${ACCOUNT_ORIGIN}/identity/auth/sendEmailTicket`,
                              body: {},
                          },
                          {
                              url: `${ACCOUNT_ORIGIN}/identity/auth/sendEmailTicket`,
                              body: { _json: "true" },
                          },
                          {
                              url: `${ACCOUNT_ORIGIN}/identity/auth/sendEmailTicket`,
                              body: { _flag: 8, _json: "true" },
                          },
                          {
                              url: `${ACCOUNT_ORIGIN}/identity/auth/sendEmailTicket`,
                              body: { trust: "true", _flag: 8, _json: "true" },
                          },
                      ];

            for (const attempt of requestAttempts) {
                const payload = await this.accountRequestJson(attempt.url, {
                    method: "POST",
                    query: {
                        _dc: Date.now(),
                    },
                    body: attempt.body,
                    cookies: {
                        identity_session: identitySession,
                    },
                });

                if (
                    payload?.code === 0 ||
                    payload?.result === "ok" ||
                    payload?.result === "success"
                ) {
                    await this.trace("verification_ticket_requested", {
                        verifyUrl,
                        method,
                        payload,
                    });
                    return {
                        method,
                        message:
                            method === "phone"
                                ? "短信验证码已发送，请查看手机并回到这里填写。"
                                : "邮箱验证码已发送，请查看邮箱并回到这里填写。",
                    };
                }

                const reason =
                    firstNonEmptyText(
                        payload?.description,
                        payload?.desc,
                        payload?.message,
                        payload?.msg,
                        payload?.reason
                    ) ||
                    `code=${String(payload?.code ?? "unknown")}`;
                lastErrorMessage = reason;
                await this.trace("verification_ticket_request_failed", {
                    verifyUrl,
                    method,
                    payload,
                });

                if (payload?.type === "manMachine" || payload?.code === 87001) {
                    break;
                }
            }
        }

        throw new Error(
            lastErrorMessage
                ? `请求验证码失败：${lastErrorMessage}`
                : "请求验证码失败，请稍后重试。"
        );
    }

    async login(sid: XiaomiSid) {
        await this.loadTokenStore();
        if (!this.token) {
            throw new Error("Xiaomi token store is not ready.");
        }
        await this.trace("login_called", {
            sid,
            alreadyHasSid: Boolean(this.token[sid]),
        });

        if (this.token[sid]) {
            return;
        }

        if (!this.password && !this.token.passToken && !this.accountCookies.passToken) {
            const hasAnySid = Boolean(this.token.micoapi || this.token.xiaomiio);
            await this.trace("login_missing_account_session", {
                sid,
                tokenStorePath: this.tokenStorePath || null,
                tokenState: {
                    deviceId: this.token.deviceId,
                    userId: this.token.userId,
                    cUserId: this.token.cUserId,
                    hasMicoapi: Boolean(this.token.micoapi),
                    hasXiaomiio: Boolean(this.token.xiaomiio),
                },
            });
            if (hasAnySid) {
                throw new Error(
                    [
                        `当前缺少继续获取 ${sid} 登录态所需的小米账号会话。`,
                        "这是旧版本残留的半登录状态：只保存了部分 sid token，没有保存 passToken。",
                        "请重新走一次登录流程。",
                    ].join(" ")
                );
            }
            throw new Error(
                [
                    `当前还没有可用于获取 ${sid} 登录态的小米账号会话。`,
                ].join(" ")
            );
        }

        await this.runLoginRequest(sid);
    }

    async miRequest<T = any>(options: {
        sid: XiaomiSid;
        url: string;
        method?: "GET" | "POST";
        data?: Record<string, any> | ((token: XiaomiTokenStore, cookies: Record<string, string>) => Record<string, any> | undefined);
        headers?: Record<string, string>;
        cookies?: Record<string, string>;
        rawText?: boolean;
        allowRelogin?: boolean;
        timeoutMs?: number;
        maxAttempts?: number;
    }): Promise<T> {
        const allowRelogin = options.allowRelogin !== false;
        const timeoutMs = Number.isFinite(Number(options.timeoutMs))
            ? Math.max(XIAOMI_MIN_FETCH_TIMEOUT_MS, Math.round(Number(options.timeoutMs)))
            : XIAOMI_FETCH_TIMEOUT_MS;
        const maxAttempts = Number.isFinite(Number(options.maxAttempts))
            ? Math.min(3, Math.max(1, Math.round(Number(options.maxAttempts))))
            : 3;
        await this.ensureSid(options.sid);
        if (!this.token?.userId || !this.token[options.sid]) {
            throw new Error(`Xiaomi sid ${options.sid} is not authenticated.`);
        }

        const sidToken = this.token[options.sid] as XiaomiTokenEntry;
        const dstOffset = currentDstOffsetMillis();
        const requestCookies: Record<string, string> = {
            userId: this.token.userId,
            yetAnotherServiceToken: sidToken[1],
            serviceToken: sidToken[1],
            locale: currentLocaleCookie(),
            timezone: currentTimezoneCookie(),
            is_daylight: dstOffset > 0 ? "1" : "0",
            dst_offset: String(dstOffset),
            channel: "MI_APP_STORE",
            ...(options.cookies || {})
        };

        const data = typeof options.data === "function" ? options.data(this.token, requestCookies) : options.data;
        const method = options.method || (data ? "POST" : "GET");
        const headers = new Headers(options.headers || {});
        const hasExplicitProtocolHint = headers.has("X-XIAOMI-PROTOCAL-FLAG-CLI");
        if (!headers.has("User-Agent")) {
            headers.set("User-Agent", buildAccountUserAgent(this.token.deviceId));
        }
        if (!hasExplicitProtocolHint) {
            headers.set("X-XIAOMI-PROTOCAL-FLAG-CLI", "PROTOCAL-HTTP2");
        }
        if (!headers.has("Content-Type")) {
            headers.set("Content-Type", "application/x-www-form-urlencoded");
        }
        headers.set("Cookie", buildCookieHeader(requestCookies));

        let url = options.url;
        let body: URLSearchParams | undefined;

        if (method === "GET" && data) {
            url = appendQuery(url, data);
        } else if (data) {
            body = formEncode(data);
            if (!headers.has("Content-Type")) {
                headers.set("Content-Type", "application/x-www-form-urlencoded");
            }
        }
        const requestHost = safeUrlHostname(url);
        const minaHost = isMinaNetworkHost(requestHost);
        const forceHttp1ForConversationHost =
            requestHost === "userprofile.mina.mi.com";
        const minaHttp1FallbackEligibleHost = forceHttp1ForConversationHost;
        const traceMinaConversationRequest = this.shouldTraceMinaConversationRequest(
            options.sid,
            url
        );

        if (traceMinaConversationRequest) {
            await this.trace("mi_request_start", {
                sid: options.sid,
                method,
                url,
                requestHost,
                minaHost,
                forceHttp1ForConversationHost,
                minaHttp1FallbackActive:
                    forceHttp1ForConversationHost ||
                    (minaHttp1FallbackEligibleHost && this.isMinaHttp1FallbackActive()),
                timeoutMs,
                maxAttempts,
                data,
                cookies: requestCookies,
                headers: Object.fromEntries(headers.entries()),
            });
        }
        let response: XiaomiResponseLike | undefined;
        let fetchError: unknown;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            const fallbackActive =
                forceHttp1ForConversationHost ||
                (minaHttp1FallbackEligibleHost && this.isMinaHttp1FallbackActive());
            const currentProtocolHint =
                headers.get("X-XIAOMI-PROTOCAL-FLAG-CLI") || "PROTOCAL-HTTP2";
            if (fallbackActive) {
                if (!hasExplicitProtocolHint || /http2/i.test(currentProtocolHint)) {
                    headers.set("X-XIAOMI-PROTOCAL-FLAG-CLI", "PROTOCAL-HTTP1");
                }
            } else if (!hasExplicitProtocolHint) {
                headers.set("X-XIAOMI-PROTOCAL-FLAG-CLI", "PROTOCAL-HTTP2");
            }

            try {
                if (fallbackActive) {
                    response = await this.requestViaHttp1({
                        url,
                        method,
                        headers,
                        body,
                        timeoutMs,
                    });
                } else {
                    response = await fetch(url, {
                        method,
                        headers,
                        body,
                        signal: buildTimeoutSignal(timeoutMs),
                    });
                }
                fetchError = undefined;
                break;
            } catch (error) {
                fetchError = error;
                const goawayError = isHttp2GoawayError(error);
                if (goawayError && minaHttp1FallbackEligibleHost) {
                    await this.armMinaHttp1Fallback({
                        url,
                        host: requestHost,
                        attempt,
                        error,
                    });
                }
                const retryDelayMs =
                    goawayError
                        ? XIAOMI_GOAWAY_RETRY_DELAYS_MS[
                              Math.min(attempt - 1, XIAOMI_GOAWAY_RETRY_DELAYS_MS.length - 1)
                          ]
                        : 200 * attempt;
                await this.trace("mi_request_fetch_error", {
                    sid: options.sid,
                    method,
                    url,
                    attempt,
                    error: errorDetails(error),
                    goawayError,
                    retryDelayMs,
                    requestHost,
                    minaHost,
                    forceHttp1ForConversationHost,
                    minaHttp1FallbackActive:
                        forceHttp1ForConversationHost ||
                        (minaHttp1FallbackEligibleHost &&
                            this.isMinaHttp1FallbackActive()),
                    timeoutMs,
                    maxAttempts,
                    protocolHint:
                        headers.get("X-XIAOMI-PROTOCAL-FLAG-CLI") || undefined,
                });
                if (attempt < maxAttempts) {
                    await sleep(retryDelayMs);
                    continue;
                }
            }
        }
        if (fetchError || !response) {
            throw new Error(formatNetworkError(fetchError, url));
        }

        const text = await response.text();
        if (traceMinaConversationRequest) {
            await this.trace("mi_request_end", {
                sid: options.sid,
                method,
                url,
                status: response.status,
                responseUrl: response.url,
                body: sanitizeText(text),
            });
        }
        if (!response.ok && (response.status === 401 || response.status === 403)) {
            if (allowRelogin) {
                await this.trace("mi_request_relogin", {
                    sid: options.sid,
                    url,
                    status: response.status,
                });
                await this.invalidateSid(options.sid);
                await this.login(options.sid);
                return this.miRequest<T>({ ...options, allowRelogin: false });
            }
            throw new Error(`Xiaomi request failed for ${url}: HTTP ${response.status} ${text}`);
        }
        if (options.rawText) {
            return text as T;
        }

        let payload: any;
        try {
            payload = parseJson(text);
        } catch {
            await this.trace("mi_request_non_json", {
                sid: options.sid,
                method,
                url,
                status: response.status,
                body: sanitizeText(text),
            });
            throw new Error(`Xiaomi request returned non-JSON response for ${url}: ${text}`);
        }

        if (!response.ok || isAuthErrorPayload(payload)) {
            if (allowRelogin) {
                await this.trace("mi_request_auth_retry", {
                    sid: options.sid,
                    url,
                    status: response.status,
                    payload,
                });
                await this.invalidateSid(options.sid);
                await this.login(options.sid);
                return this.miRequest<T>({ ...options, allowRelogin: false });
            }
            throw new Error(`Xiaomi request failed for ${url}: ${JSON.stringify(payload)}`);
        }

        return payload as T;
    }
}

export class MiNAClient {
    constructor(private readonly account: XiaomiAccountClient) {}

    private async request<T = any>(
        uri: string,
        data?: Record<string, any>,
        method?: "GET" | "POST",
        cookies?: Record<string, string>,
        options?: XiaomiRequestOptions
    ): Promise<T> {
        const requestId = `app_ios_${randomString(30)}`;
        const actualMethod = method || (data ? "POST" : "GET");
        const requestUrl = `${MINA_BASE_URL}${uri}`;
        const actualData = data ? { ...data, requestId } : undefined;
        const finalUrl = actualMethod === "GET" ? appendQuery(requestUrl, { requestId }) : requestUrl;

        return this.account.miRequest<T>({
            sid: "micoapi",
            url: finalUrl,
            method: actualMethod,
            data: actualMethod === "POST" ? actualData : undefined,
            cookies,
            timeoutMs: options?.timeoutMs,
            maxAttempts: options?.maxAttempts,
        });
    }

    async deviceList(master = 0): Promise<MinaDeviceInfo[]> {
        const response = await this.request<{ data?: MinaDeviceInfo[] }>(`/admin/v2/device_list?master=${master}`, undefined, "GET");
        return response.data || [];
    }

    async ubusRequest(
        deviceId: string,
        method: string,
        pathName: string,
        message: Record<string, any>,
        options?: XiaomiRequestOptions
    ) {
        return this.request("/remote/ubus", {
            deviceId,
            path: pathName,
            method,
            message: JSON.stringify(message)
        }, "POST", undefined, options);
    }

    async textToSpeech(deviceId: string, text: string) {
        return this.ubusRequest(deviceId, "text_to_speech", "mibrain", { text });
    }

    async playerSetVolume(deviceId: string, volume: number, options?: XiaomiRequestOptions) {
        return this.ubusRequest(deviceId, "player_set_volume", "mediaplayer", {
            volume,
            media: "app_ios"
        }, options);
    }

    async playerSetLoop(deviceId: string, type = 1) {
        return this.ubusRequest(deviceId, "player_set_loop", "mediaplayer", {
            media: "common",
            type
        });
    }

    async playerPause(
        deviceId: string,
        options?: { media?: string } & XiaomiRequestOptions
    ) {
        return this.ubusRequest(deviceId, "player_play_operation", "mediaplayer", {
            action: "pause",
            media: options?.media || "app_ios"
        }, options);
    }

    async playerPlay(
        deviceId: string,
        options?: { media?: string } & XiaomiRequestOptions
    ) {
        return this.ubusRequest(deviceId, "player_play_operation", "mediaplayer", {
            action: "play",
            media: options?.media || "app_ios"
        }, options);
    }

    async playerStop(
        deviceId: string,
        options?: { media?: string } & XiaomiRequestOptions
    ) {
        return this.ubusRequest(deviceId, "player_play_operation", "mediaplayer", {
            action: "stop",
            media: options?.media || "app_ios"
        }, options);
    }

    async playerPlayUrl(
        deviceId: string,
        url: string,
        type = 1,
        options?: { media?: string } & XiaomiRequestOptions
    ) {
        return this.ubusRequest(deviceId, "player_play_url", "mediaplayer", {
            url,
            type,
            media: options?.media || "app_ios"
        }, options);
    }

    async playerPlayMusic(deviceId: string, data: Record<string, any>) {
        return this.ubusRequest(deviceId, "player_play_music", "mediaplayer", data);
    }

    async searchMusic(query: string, count = 6) {
        return this.request("/music/search", {
            query,
            queryType: 1,
            offset: 0,
            count,
            timestamp: Math.floor(Date.now() * 1000),
        }, "GET");
    }

    async playerGetStatus(
        deviceId: string,
        options?: { media?: string | null } & XiaomiRequestOptions
    ) {
        const message: Record<string, any> = {};
        const media = typeof options?.media === "string" ? options.media.trim() : "";
        if (media) {
            message.media = media;
        }
        return this.request(
            "/remote/ubus",
            {
                deviceId,
                path: "mediaplayer",
                method: "player_get_play_status",
                message: JSON.stringify(message),
            },
            "POST",
            undefined,
            {
                timeoutMs: options?.timeoutMs,
                maxAttempts: options?.maxAttempts,
            }
        );
    }

    async fetchConversation(
        hardware: string,
        deviceId: string,
        limit = 3,
        options?: XiaomiRequestOptions
    ): Promise<any> {
        return this.account.miRequest({
            sid: "micoapi",
            url: MINA_CONVERSATION_URL,
            method: "GET",
            data: {
                source: "dialogu",
                hardware,
                timestamp: String(Date.now()),
                limit
            },
            cookies: {
                deviceId
            },
            timeoutMs: options?.timeoutMs,
            maxAttempts: options?.maxAttempts,
        });
    }
}

export class MiIOClient {
    private readonly baseUrl: string;

    constructor(
        private readonly account: XiaomiAccountClient,
        private readonly region: string
    ) {
        this.baseUrl = `https://${this.region === "cn" ? "" : `${this.region}.`}api.io.mi.com/app`;
    }

    private signNonce(ssecurity: string, nonce: string): string {
        return sha256Base64([
            Buffer.from(ssecurity, "base64"),
            Buffer.from(nonce, "base64")
        ]);
    }

    private signData(uri: string, payload: Record<string, any>, ssecurity: string): Record<string, string> {
        const json = JSON.stringify(payload);
        const minutesBuffer = Buffer.alloc(4);
        minutesBuffer.writeUInt32BE(Math.floor(Date.now() / 60000), 0);
        const nonce = Buffer.concat([randomBytes(8), minutesBuffer]).toString("base64");
        const signedNonce = this.signNonce(ssecurity, nonce);
        const message = `${uri}&${signedNonce}&${nonce}&data=${json}`;
        const signature = createHmac("sha256", Buffer.from(signedNonce, "base64"))
            .update(message)
            .digest("base64");

        return {
            _nonce: nonce,
            data: json,
            signature
        };
    }

    async miioRequest<T = any>(
        uri: string,
        data: Record<string, any>,
        options?: XiaomiRequestOptions
    ): Promise<T> {
        return this.account.miRequest<T>({
            sid: "xiaomiio",
            url: `${this.baseUrl}${uri}`,
            method: "POST",
            data: (token, cookies) => {
                const sidToken = token.xiaomiio;
                if (!sidToken) {
                    throw new Error("xiaomiio sid token is missing.");
                }
                cookies.PassportDeviceId = token.deviceId;
                return this.signData(uri, data, sidToken[0]);
            },
            headers: {
                "User-Agent": MIIO_USER_AGENT,
                "x-xiaomi-protocal-flag-cli": "PROTOCAL-HTTP2"
            },
            timeoutMs: options?.timeoutMs,
            maxAttempts: options?.maxAttempts,
        });
    }

    async deviceListFull(): Promise<MiioDeviceInfo[]> {
        const response = await this.miioRequest<{ result?: { list?: MiioDeviceInfo[] } }>("/home/device_list", {
            getVirtualModel: false,
            getHuamiDevices: 1
        });
        return response.result?.list || [];
    }

    async miotGetProps(
        params: Array<{ did: string; siid: number; piid: number }>,
        options?: XiaomiRequestOptions
    ) {
        const response = await this.miioRequest<{ result?: any[] }>("/miotspec/prop/get", {
            params
        }, options);
        return response.result || [];
    }

    async miotSetProps(
        params: Array<{ did: string; siid: number; piid: number; value: any }>,
        options?: XiaomiRequestOptions
    ) {
        const response = await this.miioRequest<{ result?: any[] }>("/miotspec/prop/set", {
            params
        }, options);
        return response.result || [];
    }

    async miotAction(
        did: string,
        siid: number,
        aiid: number,
        args: any[] = [],
        options?: XiaomiRequestOptions
    ) {
        const response = await this.miioRequest<{ result?: { code?: number } }>("/miotspec/action", {
            params: {
                did,
                siid,
                aiid,
                in: args
            }
        }, options);
        return response.result || {};
    }
}

export class MiotSpecClient {
    private instancesPromise?: Promise<Array<{ model: string; type: string }>>;
    private specCache = new Map<string, MiotDeviceSpec>();

    async getTypeForModel(model: string): Promise<string | null> {
        if (!this.instancesPromise) {
            this.instancesPromise = (async () => {
                const response = await fetch(MIOT_SPEC_INSTANCES_URL, {
                    signal: buildTimeoutSignal()
                });
                const data = await response.json() as { instances?: Array<{ model: string; type: string }> };
                return data.instances || [];
            })();
        }

        const instances = await this.instancesPromise;
        const candidates = instances
            .filter((item) => item.model === model)
            .sort((left, right) => parseVersionFromUrn(right.type) - parseVersionFromUrn(left.type));

        return candidates[0]?.type || null;
    }

    async getSpecForModel(model: string): Promise<MiotDeviceSpec | null> {
        if (this.specCache.has(model)) {
            return this.specCache.get(model) || null;
        }

        const type = await this.getTypeForModel(model);
        if (!type) {
            return null;
        }

        const response = await fetch(`${MIOT_SPEC_INSTANCE_URL}${encodeURIComponent(type)}`, {
            signal: buildTimeoutSignal()
        });
        const spec = await response.json() as MiotDeviceSpec;
        this.specCache.set(model, spec);
        return spec;
    }
}

export function pickSpeakerFeatures(spec: MiotDeviceSpec | null): SpeakerFeatureMap {
    const fallback: SpeakerFeatureMap = {
        volume: { siid: 2, piid: 1, min: 0, max: 100, step: 1 },
        mute: { siid: 2, piid: 2 },
        play: { siid: 3, aiid: 2 },
        pause: { siid: 3, aiid: 3 },
        stop: { siid: 3, aiid: 4 },
        wakeUp: { siid: 5, aiid: 1 },
        playText: { siid: 5, aiid: 3 },
        executeTextDirective: { siid: 5, aiid: 4, silentPiid: 2 }
    };

    if (!spec?.services?.length) {
        return fallback;
    }

    const picked: SpeakerFeatureMap = {};
    const SPEAKER_SERVICE_NAMES = ["speaker"];
    const PLAY_CONTROL_SERVICE_NAMES = ["play_control", "play", "player", "playback_control"];
    const INTELLIGENT_SPEAKER_SERVICE_NAMES = ["intelligent_speaker"];
    const MESSAGE_ROUTER_SERVICE_NAMES = ["message_router"];
    const VOLUME_PROPERTY_NAMES = ["volume", "speaker_volume"];
    const MUTE_PROPERTY_NAMES = ["mute", "speaker_mute"];
    const MUTE_ON_ACTION_NAMES = ["mute_on"];
    const MUTE_OFF_ACTION_NAMES = ["mute_off"];
    const SILENT_EXECUTION_PROPERTY_NAMES = ["silent_execution"];
    const PLAY_ACTION_NAMES = ["play"];
    const PAUSE_ACTION_NAMES = ["pause"];
    const STOP_ACTION_NAMES = ["stop"];
    const WAKE_UP_ACTION_NAMES = ["wake_up"];
    const PLAY_TEXT_ACTION_NAMES = ["play_text", "text_to_speech", "tts"];
    const EXECUTE_TEXT_DIRECTIVE_ACTION_NAMES = [
        "execute_text_directive",
        "execute_directive",
    ];
    const MESSAGE_ROUTER_POST_ACTION_NAMES = ["post"];

    for (const service of spec.services) {
        const serviceName = resolveMiotSpecName(service.type, service.description);
        if (miotSpecNameIn(serviceName, SPEAKER_SERVICE_NAMES)) {
            for (const property of service.properties || []) {
                const propertyName = resolveMiotSpecName(
                    property.type,
                    property.description
                );
                if (miotSpecNameIn(propertyName, VOLUME_PROPERTY_NAMES)) {
                    const range = property["value-range"] || [];
                    picked.volume = {
                        siid: service.iid,
                        piid: property.iid,
                        min: range[0],
                        max: range[1],
                        step: range[2]
                    };
                } else if (miotSpecNameIn(propertyName, MUTE_PROPERTY_NAMES)) {
                    picked.mute = { siid: service.iid, piid: property.iid };
                }
            }
            for (const action of service.actions || []) {
                const actionName = resolveMiotSpecName(action.type, action.description);
                if (miotSpecNameIn(actionName, MUTE_ON_ACTION_NAMES)) {
                    picked.muteOn = { siid: service.iid, aiid: action.iid };
                } else if (miotSpecNameIn(actionName, MUTE_OFF_ACTION_NAMES)) {
                    picked.muteOff = { siid: service.iid, aiid: action.iid };
                }
            }
        } else if (miotSpecNameIn(serviceName, PLAY_CONTROL_SERVICE_NAMES)) {
            for (const action of service.actions || []) {
                const actionName = resolveMiotSpecName(action.type, action.description);
                if (miotSpecNameIn(actionName, PLAY_ACTION_NAMES)) {
                    picked.play = { siid: service.iid, aiid: action.iid };
                } else if (miotSpecNameIn(actionName, PAUSE_ACTION_NAMES)) {
                    picked.pause = { siid: service.iid, aiid: action.iid };
                } else if (miotSpecNameIn(actionName, STOP_ACTION_NAMES)) {
                    picked.stop = { siid: service.iid, aiid: action.iid };
                } else if (miotSpecNameIn(actionName, MUTE_ON_ACTION_NAMES)) {
                    picked.muteOn = { siid: service.iid, aiid: action.iid };
                } else if (miotSpecNameIn(actionName, MUTE_OFF_ACTION_NAMES)) {
                    picked.muteOff = { siid: service.iid, aiid: action.iid };
                }
            }
        } else if (miotSpecNameIn(serviceName, INTELLIGENT_SPEAKER_SERVICE_NAMES)) {
            let silentPiid: number | undefined;
            for (const property of service.properties || []) {
                const propertyName = resolveMiotSpecName(
                    property.type,
                    property.description
                );
                if (miotSpecNameIn(propertyName, SILENT_EXECUTION_PROPERTY_NAMES)) {
                    silentPiid = property.iid;
                }
            }
            for (const action of service.actions || []) {
                const actionName = resolveMiotSpecName(action.type, action.description);
                if (miotSpecNameIn(actionName, WAKE_UP_ACTION_NAMES)) {
                    picked.wakeUp = {
                        siid: service.iid,
                        aiid: action.iid,
                        ins: Array.isArray(action.in) ? action.in.length : 0,
                    };
                } else if (miotSpecNameIn(actionName, PLAY_TEXT_ACTION_NAMES)) {
                    picked.playText = { siid: service.iid, aiid: action.iid };
                } else if (
                    miotSpecNameIn(actionName, EXECUTE_TEXT_DIRECTIVE_ACTION_NAMES)
                ) {
                    picked.executeTextDirective = { siid: service.iid, aiid: action.iid, silentPiid };
                }
            }
        } else if (miotSpecNameIn(serviceName, MESSAGE_ROUTER_SERVICE_NAMES)) {
            for (const action of service.actions || []) {
                const actionName = resolveMiotSpecName(action.type, action.description);
                if (miotSpecNameIn(actionName, MESSAGE_ROUTER_POST_ACTION_NAMES)) {
                    picked.messageRouterPost = { siid: service.iid, aiid: action.iid };
                }
            }
        }
    }

    for (const service of spec.services) {
        const serviceName = resolveMiotSpecName(service.type, service.description);
        for (const property of service.properties || []) {
            const propertyName = resolveMiotSpecName(
                property.type,
                property.description
            );
            if (!picked.volume && miotSpecNameIn(propertyName, VOLUME_PROPERTY_NAMES)) {
                const range = property["value-range"] || [];
                picked.volume = {
                    siid: service.iid,
                    piid: property.iid,
                    min: range[0],
                    max: range[1],
                    step: range[2],
                };
            } else if (!picked.mute && miotSpecNameIn(propertyName, MUTE_PROPERTY_NAMES)) {
                picked.mute = { siid: service.iid, piid: property.iid };
            }
        }

        for (const action of service.actions || []) {
            const actionName = resolveMiotSpecName(action.type, action.description);
            if (!picked.play && miotSpecNameIn(actionName, PLAY_ACTION_NAMES)) {
                picked.play = { siid: service.iid, aiid: action.iid };
            } else if (!picked.pause && miotSpecNameIn(actionName, PAUSE_ACTION_NAMES)) {
                picked.pause = { siid: service.iid, aiid: action.iid };
            } else if (!picked.stop && miotSpecNameIn(actionName, STOP_ACTION_NAMES)) {
                picked.stop = { siid: service.iid, aiid: action.iid };
            } else if (!picked.muteOn && miotSpecNameIn(actionName, MUTE_ON_ACTION_NAMES)) {
                picked.muteOn = { siid: service.iid, aiid: action.iid };
            } else if (!picked.muteOff && miotSpecNameIn(actionName, MUTE_OFF_ACTION_NAMES)) {
                picked.muteOff = { siid: service.iid, aiid: action.iid };
            } else if (!picked.wakeUp && miotSpecNameIn(actionName, WAKE_UP_ACTION_NAMES)) {
                picked.wakeUp = {
                    siid: service.iid,
                    aiid: action.iid,
                    ins: Array.isArray(action.in) ? action.in.length : 0,
                };
            } else if (
                !picked.playText &&
                miotSpecNameIn(actionName, PLAY_TEXT_ACTION_NAMES)
            ) {
                picked.playText = { siid: service.iid, aiid: action.iid };
            } else if (
                !picked.executeTextDirective &&
                miotSpecNameIn(actionName, EXECUTE_TEXT_DIRECTIVE_ACTION_NAMES)
            ) {
                let silentPiid: number | undefined;
                for (const property of service.properties || []) {
                    const propertyName = resolveMiotSpecName(
                        property.type,
                        property.description
                    );
                    if (miotSpecNameIn(propertyName, SILENT_EXECUTION_PROPERTY_NAMES)) {
                        silentPiid = property.iid;
                        break;
                    }
                }
                picked.executeTextDirective = {
                    siid: service.iid,
                    aiid: action.iid,
                    silentPiid,
                };
            } else if (
                !picked.messageRouterPost &&
                miotSpecNameIn(serviceName, MESSAGE_ROUTER_SERVICE_NAMES) &&
                miotSpecNameIn(actionName, MESSAGE_ROUTER_POST_ACTION_NAMES)
            ) {
                picked.messageRouterPost = { siid: service.iid, aiid: action.iid };
            }
        }
    }

    return Object.keys(picked).length > 0 ? picked : fallback;
}

export function selectMinaDevice(devices: MinaDeviceInfo[], options: {
    miDid?: string;
    minaDeviceId?: string;
    hardware?: string;
    speakerName?: string;
}): MinaDeviceInfo | null {
    const normalizedSpeakerName = normalizeName(options.speakerName);
    const normalizedHardware = normalizeName(options.hardware);

    let candidates = devices.filter((device) => device.deviceID);

    if (options.minaDeviceId) {
        candidates = candidates.filter((device) => String(device.deviceID) === String(options.minaDeviceId));
    }

    if (options.miDid) {
        candidates = candidates.filter((device) => String(device.miotDID || "") === String(options.miDid));
    }

    if (normalizedHardware) {
        const matches = candidates.filter((device) => normalizeName(device.hardware) === normalizedHardware);
        if (matches.length > 0) {
            candidates = matches;
        }
    }

    if (normalizedSpeakerName) {
        const exact = candidates.filter((device) =>
            [device.alias, device.name]
                .map((value) => normalizeName(typeof value === "string" ? value : undefined))
                .includes(normalizedSpeakerName)
        );
        if (exact.length > 0) {
            candidates = exact;
        } else {
            const contains = candidates.filter((device) =>
                [device.alias, device.name]
                    .map((value) => normalizeName(typeof value === "string" ? value : undefined))
                    .some((value) => value.includes(normalizedSpeakerName))
            );
            if (contains.length > 0) {
                candidates = contains;
            }
        }
    }

    if (candidates.length === 1) {
        return candidates[0];
    }

    return null;
}

export function selectMiioDevice(devices: MiioDeviceInfo[], options: {
    miDid?: string;
    speakerName?: string;
    model?: string;
    hardware?: string;
}): MiioDeviceInfo | null {
    let candidates = devices.slice();

    if (options.miDid) {
        const didMatches = candidates.filter((device) => String(device.did) === String(options.miDid));
        if (didMatches.length === 1) {
            return didMatches[0];
        }
        if (didMatches.length > 1) {
            candidates = didMatches;
        }
    }

    if (options.model) {
        const modelMatches = candidates.filter((device) => device.model === options.model);
        if (modelMatches.length === 1) {
            return modelMatches[0];
        }
        if (modelMatches.length > 1) {
            candidates = modelMatches;
        }
    }

    if (options.hardware) {
        const hardwareSuffix = options.hardware.toLowerCase();
        const hardwareMatches = candidates.filter((device) => (device.model || "").toLowerCase().endsWith(hardwareSuffix));
        if (hardwareMatches.length === 1) {
            return hardwareMatches[0];
        }
        if (hardwareMatches.length > 1) {
            candidates = hardwareMatches;
        }
    }

    if (options.speakerName) {
        const target = normalizeName(options.speakerName);
        const exact = candidates.filter((device) => normalizeName(device.name) === target);
        if (exact.length === 1) {
            return exact[0];
        }
        if (exact.length > 1) {
            candidates = exact;
        } else {
            const contains = candidates.filter((device) => normalizeName(device.name).includes(target));
            if (contains.length === 1) {
                return contains[0];
            }
            if (contains.length > 1) {
                candidates = contains;
            }
        }
    }

    return candidates.length === 1 ? candidates[0] : null;
}
