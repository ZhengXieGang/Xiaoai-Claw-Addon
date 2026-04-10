import { randomBytes } from "crypto";
import path from "path";
import { readFile } from "fs/promises";
import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { networkInterfaces } from "os";
import { fileURLToPath } from "url";
import {
    htmlEscape,
    renderSharedHead,
    renderThemeSwitch,
    uiAssetVersionQuery,
} from "./console-page.js";

export interface LoginSessionSeed {
    account?: string;
    serverCountry?: string;
    hardware?: string;
    speakerName?: string;
    miDid?: string;
    minaDeviceId?: string;
    tokenStorePath: string;
}

export interface LoginSubmission extends LoginSessionSeed {
    account: string;
    serverCountry: string;
    password?: string;
}

export interface LoginSuccessPayload {
    message: string;
}

export interface LoginVerificationChallenge {
    verifyUrl: string;
    methods?: Array<"phone" | "email">;
}

export interface LoginDeviceCandidate {
    speakerName: string;
    hardware?: string;
    miDid?: string;
    minaDeviceId?: string;
    model?: string;
}

export interface LoginDiscoveryPayload {
    message: string;
    devices: LoginDeviceCandidate[];
}

export interface LoginVerificationPayload {
    message: string;
    verification: LoginVerificationChallenge;
}

export interface VerificationTicketSubmission {
    ticket: string;
}

export interface VerificationCodeRequestSubmission {
    preferredMethod?: "phone" | "email";
}

export interface VerificationPageOpenPayload {
    message: string;
    openUrl: string;
    verification?: LoginVerificationChallenge;
}

export interface LoginPortalSessionSnapshot {
    id: string;
    status: "pending" | "processing" | "success" | "error";
    createdAt: string;
    expiresAt: string;
    primaryUrl: string;
    allUrls: string[];
    message?: string;
    error?: string;
    seed: LoginSessionSeed;
    devices?: LoginDeviceCandidate[];
    verification?: LoginVerificationChallenge;
}

interface PublicLoginPortalSessionSnapshot {
    id: string;
    status: "pending" | "processing" | "success" | "error";
    createdAt: string;
    expiresAt: string;
    primaryUrl: string;
    allUrls: string[];
    message?: string;
    error?: string;
    seed: Omit<LoginSessionSeed, "tokenStorePath">;
    devices?: LoginDeviceCandidate[];
    verification?: LoginVerificationChallenge;
}

interface InternalSession extends LoginPortalSessionSnapshot {
    activeAction?: string;
}

const PENDING_SESSION_TTL_MS = 30 * 60 * 1000;
const SUCCESS_SESSION_TTL_MS = 10 * 60 * 1000;
const PORTAL_JSON_BODY_LIMIT_BYTES = 64 * 1024;
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT_DIR = path.resolve(MODULE_DIR, "..", "..");
const STATIC_ASSETS_DIR = path.join(PLUGIN_ROOT_DIR, "assets");

class PortalHttpError extends Error {
    readonly statusCode: number;

    constructor(statusCode: number, message: string) {
        super(message);
        this.name = "PortalHttpError";
        this.statusCode = statusCode;
    }
}

function randomId(size: number) {
    return randomBytes(size).toString("hex");
}

function normalizeHttpPath(value: string) {
    const trimmed = value.trim();
    if (!trimmed || trimmed === "/") {
        return "/";
    }
    const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    return withLeadingSlash.replace(/\/+$/, "") || "/";
}

function getCandidateHosts(listenHost: string): string[] {
    const urls = new Set<string>();
    if (listenHost === "0.0.0.0" || listenHost === "::") {
        urls.add("127.0.0.1");
        const interfaces = networkInterfaces();
        for (const values of Object.values(interfaces)) {
            for (const item of values || []) {
                if (item.family === "IPv4" && !item.internal) {
                    urls.add(item.address);
                }
            }
        }
    } else {
        urls.add(listenHost);
    }
    return Array.from(urls);
}

async function readJsonBody(request: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of request) {
        const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += nextChunk.length;
        if (totalBytes > PORTAL_JSON_BODY_LIMIT_BYTES) {
            throw new PortalHttpError(413, "请求体过大，请精简后重试。");
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
        throw new PortalHttpError(400, "请求体不是合法的 JSON。");
    }
}

function applySecurityHeaders(response: ServerResponse) {
    response.setHeader("Cache-Control", "no-store, max-age=0");
    response.setHeader("Pragma", "no-cache");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
        "Permissions-Policy",
        "camera=(), microphone=(), geolocation=()"
    );
    response.setHeader("X-Robots-Tag", "noindex, nofollow");
}

function sendJson(response: ServerResponse, statusCode: number, payload: any) {
    response.statusCode = statusCode;
    applySecurityHeaders(response);
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(payload));
}

function sendHtml(response: ServerResponse, html: string, statusCode = 200) {
    response.statusCode = statusCode;
    applySecurityHeaders(response);
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(html);
}

function notFound(response: ServerResponse) {
    response.statusCode = 404;
    applySecurityHeaders(response);
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.end("Not found");
}

function formatDateTimeLabel(value: string) {
    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) {
        return value;
    }
    return new Date(timestamp).toLocaleString("zh-CN", {
        hour12: false,
    });
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

function portalAssetBaseUrl(primaryUrl: string) {
    const assetUrl = new URL(primaryUrl, "http://localhost");
    const trimmedPath =
        assetUrl.pathname.replace(/\/auth\/[a-f0-9]+\/?$/i, "") || "/";
    return (
        trimmedPath === "/" ? "/assets" : `${trimmedPath.replace(/\/+$/, "")}/assets`
    ).replace(/\/+$/, "");
}

function portalRequestBaseUrl(primaryUrl: string) {
    const requestUrl = new URL(primaryUrl, "http://localhost");
    requestUrl.search = "";
    requestUrl.hash = "";
    return requestUrl.pathname.replace(/\/+$/, "");
}

function sessionMetaPills(seed: Omit<LoginSessionSeed, "tokenStorePath">) {
    return [
        seed.serverCountry ? `地区 ${seed.serverCountry}` : "地区 cn",
        seed.speakerName ? `预选设备 ${seed.speakerName}` : "",
        seed.hardware ? `硬件 ${seed.hardware}` : "",
        seed.minaDeviceId ? "已携带设备上下文" : "登录后再选设备",
    ].filter(Boolean);
}

function renderExpiredPage(assetBasePath: string) {
    const assetVersion = uiAssetVersionQuery();
    return `<!doctype html>
<html lang="zh-CN">
${renderSharedHead("XiaoAI Cloud Login Expired", assetBasePath)}
<body data-page="portal-expired">
  <div class="page-shell">
    <main class="console-shell portal-shell">
      <header class="appbar surface appbar-compact">
        <div class="brand-cluster">
          <div class="brand-mark" aria-hidden="true"></div>
          <div class="brand-copy">
            <strong>登录</strong>
          </div>
        </div>
        ${renderThemeSwitch()}
      </header>

      <section class="surface portal-expired-card">
        <span class="section-kicker">Session Expired</span>
        <h1>登录入口已失效</h1>
        <p class="hero-sub">这个临时链接已经过期或已被回收。为了避免公网长期暴露，登录会话会自动失效。</p>
        <div class="meta-pile">
          <div class="meta-pill">临时入口默认自动回收</div>
          <div class="meta-pill">建议重新从 OpenClaw 获取</div>
        </div>
        <div class="access-note-grid">
          <div class="detail-card access-detail-card">
            <strong>为什么会过期</strong>
            <span>这是一次性临时授权入口，过期是正常行为，避免旧链接长期暴露在聊天记录或浏览器历史里。</span>
          </div>
          <div class="detail-card access-detail-card">
            <strong>怎么继续</strong>
            <span>回到 OpenClaw，让助手重新触发一次 <code>xiaoai_login_begin</code>，新的入口会重新发到你的私聊里。</span>
          </div>
        </div>
        <div class="notice-card">
          <strong>下一步</strong>
          <p>回到 OpenClaw 对话里重新触发一次登录入口。可以让助手调用 <code>xiaoai_login_begin</code>，或者直接说“重新发一下小爱登录链接”。</p>
        </div>
      </section>
    </main>
  </div>
  <script type="module" src="${htmlEscape(assetBasePath)}/ui/xiaoai-console.js${assetVersion}"></script>
</body>
</html>`;
}

function sendExpiredJson(response: ServerResponse) {
    sendJson(response, 410, {
        error:
            "登录会话已过期，请回到 OpenClaw 对话里重新触发 xiaoai_login_begin 获取新的链接。",
    });
}

function sendExpiredHtml(response: ServerResponse, assetBasePath: string) {
    sendHtml(response, renderExpiredPage(assetBasePath), 410);
}

function readOptionalString(body: any, key: string, fallback?: string) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) {
        return fallback;
    }
    const value = body[key];
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
}

function mergeSeed(sessionSeed: LoginSessionSeed, body: any): LoginSessionSeed {
    return {
        account: readOptionalString(body, "account", sessionSeed.account),
        serverCountry: readOptionalString(body, "serverCountry", sessionSeed.serverCountry),
        hardware: readOptionalString(body, "hardware"),
        speakerName: readOptionalString(body, "speakerName"),
        miDid: readOptionalString(body, "miDid"),
        minaDeviceId: readOptionalString(body, "minaDeviceId"),
        // tokenStorePath is server-side session state and must not be overridden by portal POST bodies.
        tokenStorePath: sessionSeed.tokenStorePath,
    };
}

function renderLoginPage(
    session: PublicLoginPortalSessionSnapshot,
    options?: {
        embedded?: boolean;
        requestUrl?: string;
    }
) {
    const seed = session.seed;
    const requestBaseUrl = (() => {
        try {
            return portalRequestBaseUrl(options?.requestUrl || session.primaryUrl);
        } catch {
            return portalRequestBaseUrl(session.primaryUrl);
        }
    })();
    const assetBasePath = portalAssetBaseUrl(requestBaseUrl);
    const assetVersion = uiAssetVersionQuery();
    const embedded = Boolean(options?.embedded);
    const initialStatus =
        session.error ||
        session.message ||
        (session.status === "success" ? "登录成功" : "等待登录");
    const initialStatusKind =
        session.status === "error"
            ? "err"
            : session.status === "success"
              ? "ok"
              : "";
    return `<!doctype html>
<html lang="zh-CN">
${renderSharedHead("XiaoAI Cloud Login", assetBasePath)}
<body data-page="${embedded ? "portal-embedded" : "portal"}">
  <div class="page-shell">
    <main class="console-shell portal-shell${embedded ? " portal-shell-embedded" : ""}">
      <section class="surface portal-simple-shell${embedded ? " portal-simple-shell-embedded" : ""}">
        <div class="portal-simple-head">
          <span class="micro-label">账号登录</span>
          <h1>登录小米账号</h1>
        </div>

        <div
          id="statusBox"
          class="status status-banner${initialStatusKind ? ` ${initialStatusKind}` : ""}"
          title="${htmlEscape(initialStatus)}"
        >${htmlEscape(initialStatus)}</div>

        <form id="authForm" class="portal-simple-form" autocomplete="off">
          <div class="portal-simple-grid">
            <label class="field-shell">
              <span class="field-label">小米账号</span>
              <input
                class="text-field"
                name="account"
                autocomplete="username"
                value="${htmlEscape(seed.account || "")}"
                placeholder="手机号、邮箱或小米账号"
              >
            </label>

            <label class="field-shell">
              <span class="field-label">地区</span>
              <div class="select-shell">
                <select class="text-field select-field" name="serverCountry">
                  ${["cn", "de", "i2", "ru", "sg", "us"]
                      .map(
                          (item) =>
                              `<option value="${item}"${(seed.serverCountry || "cn") === item ? " selected" : ""}>${item.toUpperCase()}</option>`
                      )
                      .join("")}
                </select>
              </div>
            </label>
          </div>

          <label class="field-shell">
            <span class="field-label">密码</span>
            <input
              class="text-field"
              type="password"
              name="password"
              autocomplete="current-password"
              placeholder="输入小米账号密码"
            >
          </label>

          <label class="field-shell portal-ticket-shell" id="ticketFieldShell" hidden>
            <span class="field-label">验证码</span>
            <input
              class="text-field"
              type="text"
              name="ticket"
              autocomplete="one-time-code"
              inputmode="numeric"
              placeholder="收到验证码后回到这里填写"
            >
          </label>

          <div class="portal-simple-actions">
            <button class="soft-btn" type="button" id="openVerifyBtn" hidden>打开验证页面</button>
            <button class="primary-btn" type="submit" id="submitLoginBtn">登录</button>
          </div>
        </form>
      </section>
    </main>
  </div>
  <script type="module" src="${htmlEscape(assetBasePath)}/ui/xiaoai-console.js${assetVersion}"></script>
  <script>
    const embeddedMode = ${embedded ? "true" : "false"};
    const statusUrl = ${JSON.stringify(`${requestBaseUrl}/status`)};
    const passwordLoginUrl = ${JSON.stringify(`${requestBaseUrl}/login/password`)};
    const verifyTicketUrl = ${JSON.stringify(`${requestBaseUrl}/verify/ticket`)};
    const openVerifyPageApiUrl = ${JSON.stringify(`${requestBaseUrl}/verify/page`)};
    const statusBox = document.getElementById("statusBox");
    const authForm = document.getElementById("authForm");
    const openVerifyBtn = document.getElementById("openVerifyBtn");
    const submitLoginBtn = document.getElementById("submitLoginBtn");
    const ticketFieldShell = document.getElementById("ticketFieldShell");
    const accountInput = authForm.elements.namedItem("account");
    const serverCountryInput = authForm.elements.namedItem("serverCountry");
    const passwordInput = authForm.elements.namedItem("password");
    const ticketInput = authForm.elements.namedItem("ticket");

    let verification = ${JSON.stringify(session.verification || null)};
    let verificationKey = "";
    let loginInFlight = false;
    let openVerifyPageInFlight = false;
    let verifyInFlight = false;
    let sessionCompleted = ${session.status === "success" ? "true" : "false"};

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function verificationMethodLabel(methods) {
      const labels = (Array.isArray(methods) ? methods : [])
        .map((item) =>
          item === "phone"
            ? "短信验证码"
            : item === "email"
              ? "邮箱验证码"
              : String(item || "").trim()
        )
        .filter(Boolean);
      return labels[0] || "";
    }

    function currentVerificationKey(value) {
      if (!value) {
        return "";
      }
      const methods = Array.isArray(value.methods) ? value.methods.join(",") : "";
      return String(value.verifyUrl || "") + "|" + methods;
    }

    function looksLikeVerificationFlow(raw) {
      return /(验证码|安全验证|二次验证|验证页面|验证链接|identity_session|identity session|verification|verify|短信验证|邮箱验证)/i.test(raw);
    }

    function looksLikePasswordFailure(raw) {
      return /(账号或密码错误|密码错误|密码不正确|密码有误|invalid password|incorrect password|wrong password)/i.test(raw);
    }

    function looksLikeAccountFailure(raw) {
      return /(账号错误|账号不存在|账号无效|账号不正确|invalid account|unknown account|user not found)/i.test(raw);
    }

    function summarizeStatus(kind, text) {
      const raw = String(text || "").replace(/\\s+/g, " ").trim();
      if (!raw) {
        return kind === "ok" ? "登录成功" : "等待登录";
      }
      if (/验证码/.test(raw) && /(错|误|无效|失败|过期)/.test(raw)) {
        return "验证码错误";
      }
      if (looksLikeVerificationFlow(raw)) {
        if (/(identity_session|identity session|会话)/i.test(raw) && /(没有|缺少|失效|过期|重新)/.test(raw)) {
          return "请重新打开验证页面";
        }
        if (/(短信|邮箱|邮件|验证码).{0,8}已发送/.test(raw) || /已发送.{0,8}(短信|邮箱|邮件|验证码)/.test(raw)) {
          const method = verificationMethodLabel(verification && verification.methods);
          return method ? method + "已发送" : "验证码已发送";
        }
        if (/(打开|前往|跳转).{0,8}(验证页面|验证链接)/.test(raw) || /官方.{0,8}(验证页面|验证链接)/.test(raw)) {
          return "请打开验证页面";
        }
        if (verification) {
          const method = verificationMethodLabel(verification.methods);
          return method ? "请输入" + method : "请输入验证码";
        }
      }
      if (looksLikePasswordFailure(raw)) {
        return "密码错误";
      }
      if (looksLikeAccountFailure(raw)) {
        return "账号错误";
      }
      if (/登录成功|账号已登录/.test(raw)) {
        return "登录成功";
      }
      if (/处理中|正在|稍候/.test(raw)) {
        return "正在处理…";
      }
      if (verification) {
        const method = verificationMethodLabel(verification.methods);
        return method ? "请输入" + method : "请输入验证码";
      }
      if (kind === "err") {
        return raw.slice(0, 32);
      }
      return raw.slice(0, 32) || "等待登录";
    }

    function setStatus(kind, text) {
      statusBox.className = "status status-banner" + (kind ? " " + kind : "");
      const raw = String(text || "").trim();
      const concise = summarizeStatus(kind, raw);
      statusBox.textContent = concise;
      statusBox.title = raw || concise;
      queueEmbeddedLayoutReport();
      if (embeddedMode && window.parent && window.parent !== window) {
        try {
          window.parent.postMessage({
            source: "xiaoai-cloud-portal",
            type: "status",
            payload: { kind, text: concise }
          }, window.location.origin);
        } catch (_) {}
      }
    }

    function measureEmbeddedHeight() {
      const doc = document.documentElement;
      const body = document.body;
      return Math.max(
        doc ? doc.scrollHeight : 0,
        doc ? doc.offsetHeight : 0,
        body ? body.scrollHeight : 0,
        body ? body.offsetHeight : 0
      );
    }

    function reportEmbeddedLayout() {
      if (!embeddedMode || !window.parent || window.parent === window) {
        return;
      }
      try {
        window.parent.postMessage({
          source: "xiaoai-cloud-portal",
          type: "layout",
          payload: {
            height: measureEmbeddedHeight()
          }
        }, window.location.origin);
      } catch (_) {}
    }

    function queueEmbeddedLayoutReport() {
      if (!embeddedMode) {
        return;
      }
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(reportEmbeddedLayout);
      });
    }

    function updateActionButtons() {
      const busy = loginInFlight || openVerifyPageInFlight || verifyInFlight;
      submitLoginBtn.disabled = busy || sessionCompleted;
      submitLoginBtn.textContent = sessionCompleted ? "已完成" : "登录";
      if (openVerifyBtn) {
        const canOpenVerify = Boolean(verification && verification.verifyUrl && !sessionCompleted);
        openVerifyBtn.hidden = !canOpenVerify;
        openVerifyBtn.disabled = busy || !canOpenVerify;
        openVerifyBtn.textContent = "打开验证页面";
      }
      queueEmbeddedLayoutReport();
    }

    function renderVerification(nextVerification) {
      verification = nextVerification || null;
      const nextKey = currentVerificationKey(verification);
      if (!verification) {
        verificationKey = "";
        ticketInput.value = "";
        if (ticketFieldShell) {
          ticketFieldShell.hidden = true;
        }
      } else if (nextKey !== verificationKey) {
        verificationKey = nextKey;
        if (ticketFieldShell) {
          ticketFieldShell.hidden = false;
        }
      } else if (ticketFieldShell) {
        ticketFieldShell.hidden = false;
      }
      queueEmbeddedLayoutReport();
      updateActionButtons();
    }

    async function fetchStatus() {
      const res = await fetch(statusUrl);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "状态查询失败");
      }
      renderVerification(data.verification || null);
      sessionCompleted = data.status === "success";
      if (data.status === "success") {
        setStatus("ok", data.message || "登录成功");
      } else if (data.status === "error") {
        setStatus("err", data.error || "登录失败");
      } else if (data.status === "processing") {
        setStatus("", data.message || "正在处理登录…");
      } else {
        setStatus("", data.message || "等待登录");
      }
      if (embeddedMode && window.parent && window.parent !== window) {
        try {
          window.parent.postMessage({
            source: "xiaoai-cloud-portal",
            type: "session",
            payload: {
              status: data.status,
              message: data.message || data.error || ""
            }
          }, window.location.origin);
        } catch (_) {}
      }
      updateActionButtons();
      return data;
    }

    async function postJson(url, payload) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "请求失败");
      }
      return data;
    }

    async function loginByPassword() {
      if (loginInFlight || openVerifyPageInFlight || verifyInFlight || sessionCompleted) {
        return;
      }
      const account = String(accountInput.value || "").trim();
      const password = String(passwordInput.value || "");
      if (!account) {
        setStatus("err", "请先填写小米账号。");
        return;
      }
      if (!password.trim()) {
        setStatus("err", "请先填写小米账号密码。");
        return;
      }
      renderVerification(null);
      loginInFlight = true;
      updateActionButtons();
      setStatus("", "正在登录，请稍候…");
      try {
        await postJson(passwordLoginUrl, {
          account,
          password,
          serverCountry: String(serverCountryInput.value || "cn")
        });
        await fetchStatus();
      } catch (error) {
        setStatus("err", error.message || String(error));
      } finally {
        loginInFlight = false;
        updateActionButtons();
      }
    }

    async function verifyByTicket() {
      if (verifyInFlight || loginInFlight || openVerifyPageInFlight || sessionCompleted) {
        return;
      }
      const ticket = String(ticketInput.value || "").trim();
      if (!ticket) {
        setStatus("err", "请先填入短信或邮箱收到的验证码。");
        return;
      }
      verifyInFlight = true;
      updateActionButtons();
      setStatus("", "正在校验验证码并继续登录，请稍候…");
      try {
        await postJson(verifyTicketUrl, { ticket });
        await fetchStatus();
      } catch (error) {
        setStatus("err", error.message || String(error));
      } finally {
        verifyInFlight = false;
        updateActionButtons();
      }
    }

    async function openVerifyPage() {
      if (!verification || !verification.verifyUrl || openVerifyPageInFlight || loginInFlight || verifyInFlight || sessionCompleted) {
        return;
      }
      openVerifyPageInFlight = true;
      updateActionButtons();
      setStatus("", "正在打开官方验证页面，请稍候…");
      try {
        const data = await postJson(openVerifyPageApiUrl, {});
        const openUrl = String(data && (data.openUrl || (data.verification && data.verification.verifyUrl) || "") || "").trim();
        if (!openUrl) {
          throw new Error("当前没有可用的官方验证页面。");
        }
        const openedWindow = window.open(openUrl, "_blank", "noopener");
        if (!openedWindow) {
          throw new Error("浏览器拦截了验证页面，请允许弹窗后重试。");
        }
        setStatus("", "请在官方页面获取验证码，回到这里填写后再点登录。");
      } catch (error) {
        setStatus("err", error.message || String(error));
      } finally {
        openVerifyPageInFlight = false;
        updateActionButtons();
      }
    }

    authForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (verification) {
        if (!String(ticketInput.value || "").trim()) {
          setStatus(
            "err",
            verification.verifyUrl
              ? "请先点上面的打开验证页面，获取验证码并填写后再点登录。"
              : "请先填入验证码，再点登录。"
          );
          return;
        }
        await verifyByTicket();
        return;
      }
      await loginByPassword();
    });

    if (openVerifyBtn) {
      openVerifyBtn.addEventListener("click", openVerifyPage);
    }

    renderVerification(verification);
    updateActionButtons();
    queueEmbeddedLayoutReport();
    if (embeddedMode && typeof ResizeObserver === "function") {
      const embeddedResizeObserver = new ResizeObserver(() => {
        queueEmbeddedLayoutReport();
      });
      embeddedResizeObserver.observe(document.body);
    }
    window.addEventListener("resize", queueEmbeddedLayoutReport);
    fetchStatus().catch(() => {});
    setInterval(() => {
      fetchStatus().catch(() => {});
    }, 3000);
  </script>
</body>
</html>`;
}

export class LoginPortal {
    private readonly sessions = new Map<string, InternalSession>();
    private server?: Server;
    private standaloneAvailable = false;

    constructor(private readonly options: {
        listenHost: string;
        port: number;
        publicBaseUrl?: string;
        routeBasePath?: string;
        gatewayBaseUrls?: string[];
        standaloneOptional?: boolean;
        onPasswordDiscover: (
            sessionId: string,
            payload: LoginSubmission
        ) => Promise<LoginDiscoveryPayload | LoginVerificationPayload>;
        onPasswordLogin: (
            sessionId: string,
            payload: LoginSubmission
        ) => Promise<LoginSuccessPayload | LoginVerificationPayload>;
        onVerifyTicket: (
            sessionId: string,
            payload: VerificationTicketSubmission
        ) => Promise<LoginDiscoveryPayload | LoginSuccessPayload | LoginVerificationPayload>;
        onPrepareVerificationPage: (
            sessionId: string,
            payload: VerificationCodeRequestSubmission
        ) => Promise<VerificationPageOpenPayload>;
        onTrace?: (event: string, details: Record<string, any>) => void | Promise<void>;
    }) {}

    async start() {
        if (this.server) {
            return;
        }
        const server = createServer((request, response) => {
            this.handleRequest(request, response).catch((error) => {
                sendJson(
                    response,
                    error instanceof PortalHttpError ? error.statusCode : 500,
                    { error: error instanceof Error ? error.message : String(error) }
                );
            });
        });
        this.server = server;
        await new Promise<void>((resolve, reject) => {
            const handleError = (error: Error) => {
                server.off("error", handleError);
                this.server = undefined;
                if (this.options.standaloneOptional) {
                    resolve();
                    return;
                }
                reject(error);
            };

            server.once("error", handleError);
            server.listen(this.options.port, this.options.listenHost, () => {
                server.off("error", handleError);
                this.standaloneAvailable = true;
                resolve();
            });
        });
    }

    async stop() {
        const server = this.server;
        if (!server) {
            return;
        }
        this.server = undefined;
        await new Promise<void>((resolve, reject) => {
            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            });
        });
        this.standaloneAvailable = false;
    }

    private touchSession(session: InternalSession, ttlMs = PENDING_SESSION_TTL_MS) {
        session.expiresAt = new Date(Date.now() + ttlMs).toISOString();
    }

    private tryRespondWithExistingActionState(
        response: ServerResponse,
        session: InternalSession,
        action: string
    ) {
        if (session.status === "processing" && session.activeAction === action) {
            sendJson(response, 202, this.toPublicSnapshot(session));
            return true;
        }

        if (
            session.status === "success" &&
            (action === "login/password" || action === "verify/ticket")
        ) {
            sendJson(response, 200, this.toPublicSnapshot(session));
            return true;
        }

        return false;
    }

    private isSessionExpired(session: InternalSession) {
        const expiresAt = Date.parse(session.expiresAt);
        return Number.isFinite(expiresAt) && expiresAt <= Date.now();
    }

    private pruneExpiredSessions(skipId?: string) {
        for (const [id, session] of this.sessions.entries()) {
            if (skipId && id === skipId) {
                continue;
            }
            if (this.isSessionExpired(session)) {
                this.sessions.delete(id);
            }
        }
    }

    private getActiveSession(id: string): InternalSession | "expired" | null {
        this.pruneExpiredSessions(id);
        const session = this.sessions.get(id);
        if (!session) {
            return null;
        }
        if (this.isSessionExpired(session)) {
            this.sessions.delete(id);
            return "expired";
        }
        return session;
    }

    async createSession(seed: LoginSessionSeed): Promise<LoginPortalSessionSnapshot> {
        await this.start();
        this.pruneExpiredSessions();
        const id = randomId(12);
        const baseUrls = this.computeBaseUrls();
        const primaryUrl = `${baseUrls[0]}/auth/${id}`;

        const session: InternalSession = {
            id,
            status: "pending",
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + PENDING_SESSION_TTL_MS).toISOString(),
            primaryUrl,
            allUrls: baseUrls.map((item) => `${item}/auth/${id}`),
            seed,
        };
        this.sessions.set(id, session);
        await this.trace("portal_session_created", {
            sessionId: id,
            primaryUrl,
            allUrls: session.allUrls,
            expiresAt: session.expiresAt,
            seed: this.toTraceSeed(seed),
        });
        return this.toSnapshot(session);
    }

    getSessionSnapshot(id: string): LoginPortalSessionSnapshot | null {
        const session = this.getActiveSession(id);
        if (session === "expired") {
            return null;
        }
        return session ? this.toSnapshot(session) : null;
    }

    async handleHttpRoute(
        request: IncomingMessage,
        response: ServerResponse
    ): Promise<boolean> {
        const requestUrl = new URL(
            request.url || "/",
            `http://${request.headers.host || "localhost"}`
        );
        const matchedPath = this.matchPathname(requestUrl.pathname);
        if (!matchedPath) {
            return false;
        }

        await this.handleRequest(request, response, matchedPath);
        return true;
    }

    private toSnapshot(session: InternalSession): LoginPortalSessionSnapshot {
        return {
            id: session.id,
            status: session.status,
            createdAt: session.createdAt,
            expiresAt: session.expiresAt,
            primaryUrl: session.primaryUrl,
            allUrls: session.allUrls,
            message: session.message,
            error: session.error,
            seed: session.seed,
            devices: session.devices,
            verification: session.verification,
        };
    }

    private toPublicSnapshot(
        session: InternalSession
    ): PublicLoginPortalSessionSnapshot {
        const { tokenStorePath: _tokenStorePath, ...publicSeed } = session.seed;
        return {
            id: session.id,
            status: session.status,
            createdAt: session.createdAt,
            expiresAt: session.expiresAt,
            primaryUrl: session.primaryUrl,
            allUrls: session.allUrls,
            message: session.message,
            error: session.error,
            seed: publicSeed,
            devices: session.devices,
            verification: session.verification,
        };
    }

    private computeBaseUrls() {
        const urls = new Set<string>();
        const base = this.options.publicBaseUrl?.trim();
        if (base) {
            urls.add(base.replace(/\/+$/, ""));
        }

        const routeBasePath = this.options.routeBasePath
            ? normalizeHttpPath(this.options.routeBasePath)
            : undefined;
        if (routeBasePath) {
            for (const gatewayBase of this.options.gatewayBaseUrls || []) {
                const trimmed = gatewayBase.trim();
                if (trimmed) {
                    urls.add(`${trimmed.replace(/\/+$/, "")}${routeBasePath}`);
                }
            }
        }

        if (this.server || this.standaloneAvailable || urls.size === 0) {
            const hosts = getCandidateHosts(this.options.listenHost);
            for (const host of hosts) {
                urls.add(`http://${host}:${this.options.port}`);
            }
        }

        return Array.from(urls);
    }

    private async trace(event: string, details: Record<string, any>) {
        try {
            await this.options.onTrace?.(event, details);
        } catch {
            // Ignore portal trace failures to avoid blocking auth flow.
        }
    }

    private toTraceSeed(seed: LoginSessionSeed) {
        return {
            hasAccount: Boolean(seed.account),
            serverCountry: seed.serverCountry,
            hardware: seed.hardware,
            speakerName: seed.speakerName,
            miDid: seed.miDid,
            minaDeviceId: seed.minaDeviceId,
            hasTokenStorePath: Boolean(seed.tokenStorePath),
        };
    }

    private requestMeta(
        request: IncomingMessage,
        matchedPath: string,
        sessionId: string,
        action: string
    ) {
        return {
            sessionId,
            action,
            method: request.method || "GET",
            path: matchedPath,
            remoteAddress: request.socket.remoteAddress,
            userAgent: request.headers["user-agent"],
        };
    }

    private summarizeActionBody(action: string, body: any) {
        const common = {
            hasAccount: Boolean(readOptionalString(body, "account")),
            serverCountry: readOptionalString(body, "serverCountry"),
            hardware: readOptionalString(body, "hardware"),
            speakerName: readOptionalString(body, "speakerName"),
            miDid: readOptionalString(body, "miDid"),
            minaDeviceId: readOptionalString(body, "minaDeviceId"),
        };

        if (action === "discover/password" || action === "login/password") {
            return {
                ...common,
                hasPassword: Boolean(body?.password),
            };
        }
        if (action === "verify/ticket") {
            const ticket =
                typeof body?.ticket === "string" ? body.ticket.trim() : "";
            return {
                ticketLength: ticket.length || undefined,
            };
        }
        if (action === "verify/page") {
            return {
                preferredMethod:
                    body?.preferredMethod === "phone" || body?.preferredMethod === "email"
                        ? body.preferredMethod
                        : undefined,
            };
        }
        return common;
    }

    private matchPathname(pathname: string) {
        const routeBasePath = this.options.routeBasePath
            ? normalizeHttpPath(this.options.routeBasePath)
            : undefined;
        if (!routeBasePath || routeBasePath === "/") {
            return pathname;
        }
        if (pathname === routeBasePath) {
            return "/";
        }
        if (pathname.startsWith(`${routeBasePath}/`)) {
            return pathname.slice(routeBasePath.length) || "/";
        }
        return pathname;
    }

    private async handleRequest(
        request: IncomingMessage,
        response: ServerResponse,
        pathnameOverride?: string
    ) {
        const requestUrl = new URL(
            request.url || "/",
            `http://${request.headers.host || "localhost"}`
        );
        const matchedPath = pathnameOverride || this.matchPathname(requestUrl.pathname);
        const isHeadRequest = request.method === "HEAD";
        const isReadOnlyRequest = request.method === "GET" || isHeadRequest;

        if (isReadOnlyRequest && (matchedPath === "/assets" || matchedPath.startsWith("/assets/"))) {
            let decodedPath = matchedPath;
            try {
                decodedPath = decodeURIComponent(matchedPath);
            } catch {
                sendJson(response, 400, { error: "Invalid asset path" });
                return;
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
                sendJson(response, 403, { error: "Forbidden" });
                return;
            }

            try {
                const payload = await readFile(assetPath);
                response.statusCode = 200;
                applySecurityHeaders(response);
                response.setHeader("Content-Type", contentTypeForAsset(assetPath));
                response.end(isHeadRequest ? undefined : payload);
            } catch (error: any) {
                if (error && error.code === "ENOENT") {
                    sendJson(response, 404, { error: "Not found" });
                } else {
                    sendJson(response, 500, { error: "Failed to load asset" });
                }
            }
            return;
        }

        const matches = matchedPath.match(
            /^\/auth\/([a-f0-9]+)(?:\/(status|discover\/password|verify\/ticket|verify\/page|login\/password))?$/
        );
        if (!matches) {
            notFound(response);
            return;
        }

        const session = this.getActiveSession(matches[1]);
        if (session === "expired") {
            await this.trace("portal_session_expired", {
                ...this.requestMeta(request, matchedPath, matches[1], matches[2] || "page"),
            });
            if (isReadOnlyRequest && !matches[2]) {
                if (isHeadRequest) {
                    response.statusCode = 410;
                    applySecurityHeaders(response);
                    response.setHeader("Content-Type", "text/html; charset=utf-8");
                    response.end();
                } else {
                    sendExpiredHtml(response, portalAssetBaseUrl(requestUrl.toString()));
                }
            } else {
                sendExpiredJson(response);
            }
            return;
        }
        if (!session) {
            notFound(response);
            return;
        }

        const action = matches[2] || "";
        if (isReadOnlyRequest && action === "") {
            this.touchSession(session);
            await this.trace("portal_page_open", {
                ...this.requestMeta(request, matchedPath, session.id, "page"),
                status: session.status,
            });
            if (isHeadRequest) {
                response.statusCode = 200;
                applySecurityHeaders(response);
                response.setHeader("Content-Type", "text/html; charset=utf-8");
                response.end();
            } else {
                sendHtml(
                    response,
                    renderLoginPage(this.toPublicSnapshot(session), {
                        embedded: requestUrl.searchParams.get("embedded") === "1",
                        requestUrl: requestUrl.toString(),
                    })
                );
            }
            return;
        }
        if (isReadOnlyRequest && action === "status") {
            this.touchSession(session);
            if (isHeadRequest) {
                response.statusCode = 200;
                applySecurityHeaders(response);
                response.setHeader("Content-Type", "application/json; charset=utf-8");
                response.end();
            } else {
                sendJson(response, 200, this.toPublicSnapshot(session));
            }
            return;
        }

        if (request.method === "POST" && action === "discover/password") {
            const body = await readJsonBody(request);
            this.touchSession(session);
            session.status = "processing";
            session.message = "正在发现设备…";
            session.error = undefined;
            session.verification = undefined;
            await this.trace("portal_action_start", {
                ...this.requestMeta(request, matchedPath, session.id, action),
                payload: this.summarizeActionBody(action, body),
            });
            try {
                const nextSeed = mergeSeed(session.seed, body);
                const result = await this.options.onPasswordDiscover(session.id, {
                    ...nextSeed,
                    account: String(body.account || "").trim(),
                    password: String(body.password || ""),
                    serverCountry: String(body.serverCountry || nextSeed.serverCountry || "cn"),
                });
                session.seed = {
                    ...nextSeed,
                    account: String(body.account || "").trim() || undefined,
                    serverCountry: String(body.serverCountry || nextSeed.serverCountry || "cn"),
                };
                session.devices = "devices" in result ? result.devices : undefined;
                session.verification = "verification" in result ? result.verification : undefined;
                session.status = "pending";
                session.message = result.message;
                this.touchSession(session);
                await this.trace("portal_action_success", {
                    ...this.requestMeta(request, matchedPath, session.id, action),
                    status: session.status,
                    message: session.message,
                    deviceCount: Array.isArray(session.devices)
                        ? session.devices.length
                        : undefined,
                    verificationRequired: Boolean(session.verification),
                });
                sendJson(response, 200, this.toPublicSnapshot(session));
            } catch (error) {
                session.status = "error";
                session.error = error instanceof Error ? error.message : String(error);
                this.touchSession(session);
                await this.trace("portal_action_error", {
                    ...this.requestMeta(request, matchedPath, session.id, action),
                    error: session.error,
                });
                sendJson(response, 400, { error: session.error });
            }
            return;
        }

        if (request.method === "POST" && action === "verify/ticket") {
            if (this.tryRespondWithExistingActionState(response, session, action)) {
                return;
            }
            const body = await readJsonBody(request);
            this.touchSession(session);
            session.status = "processing";
            session.activeAction = action;
            session.message = "正在校验验证码并继续登录…";
            session.error = undefined;
            await this.trace("portal_action_start", {
                ...this.requestMeta(request, matchedPath, session.id, action),
                payload: this.summarizeActionBody(action, body),
            });
            try {
                const result = await this.options.onVerifyTicket(session.id, {
                    ticket: String(body.ticket || "").trim(),
                });
                session.devices = "devices" in result ? result.devices : session.devices;
                session.verification = "verification" in result ? result.verification : undefined;
                session.status = "devices" in result || "verification" in result ? "pending" : "success";
                session.message = result.message;
                this.touchSession(
                    session,
                    session.status === "success"
                        ? SUCCESS_SESSION_TTL_MS
                        : PENDING_SESSION_TTL_MS
                );
                session.activeAction = undefined;
                await this.trace("portal_action_success", {
                    ...this.requestMeta(request, matchedPath, session.id, action),
                    status: session.status,
                    message: session.message,
                    deviceCount: Array.isArray(session.devices)
                        ? session.devices.length
                        : undefined,
                    verificationRequired: Boolean(session.verification),
                });
                sendJson(response, 200, this.toPublicSnapshot(session));
            } catch (error) {
                session.status = "error";
                session.activeAction = undefined;
                session.error = error instanceof Error ? error.message : String(error);
                this.touchSession(session);
                await this.trace("portal_action_error", {
                    ...this.requestMeta(request, matchedPath, session.id, action),
                    error: session.error,
                });
                sendJson(response, 400, { error: session.error });
            }
            return;
        }

        if (request.method === "POST" && action === "verify/page") {
            if (this.tryRespondWithExistingActionState(response, session, action)) {
                return;
            }
            const body = await readJsonBody(request);
            this.touchSession(session);
            session.status = "processing";
            session.activeAction = action;
            session.message = "正在准备官方验证页面…";
            session.error = undefined;
            await this.trace("portal_action_start", {
                ...this.requestMeta(request, matchedPath, session.id, action),
                payload: this.summarizeActionBody(action, body),
            });
            try {
                const result = await this.options.onPrepareVerificationPage(session.id, {
                    preferredMethod:
                        body?.preferredMethod === "phone" || body?.preferredMethod === "email"
                            ? body.preferredMethod
                            : undefined,
                });
                session.verification = result.verification || session.verification;
                session.status = "pending";
                session.message = result.message;
                this.touchSession(session);
                session.activeAction = undefined;
                await this.trace("portal_action_success", {
                    ...this.requestMeta(request, matchedPath, session.id, action),
                    status: session.status,
                    message: session.message,
                    verificationRequired: Boolean(session.verification),
                });
                sendJson(response, 200, {
                    ...this.toPublicSnapshot(session),
                    openUrl: result.openUrl,
                });
            } catch (error) {
                session.status = "error";
                session.activeAction = undefined;
                session.error = error instanceof Error ? error.message : String(error);
                this.touchSession(session);
                await this.trace("portal_action_error", {
                    ...this.requestMeta(request, matchedPath, session.id, action),
                    error: session.error,
                });
                sendJson(response, 400, { error: session.error });
            }
            return;
        }

        if (request.method === "POST" && action === "login/password") {
            if (this.tryRespondWithExistingActionState(response, session, action)) {
                return;
            }
            const body = await readJsonBody(request);
            this.touchSession(session);
            session.status = "processing";
            session.activeAction = action;
            session.message = "正在登录…";
            session.error = undefined;
            session.verification = undefined;
            await this.trace("portal_action_start", {
                ...this.requestMeta(request, matchedPath, session.id, action),
                payload: this.summarizeActionBody(action, body),
            });
            try {
                const nextSeed = mergeSeed(session.seed, body);
                const result = await this.options.onPasswordLogin(session.id, {
                    ...nextSeed,
                    account: String(body.account || "").trim(),
                    password: String(body.password || ""),
                    serverCountry: String(body.serverCountry || nextSeed.serverCountry || "cn"),
                });
                session.seed = {
                    ...nextSeed,
                    account: String(body.account || "").trim() || undefined,
                    serverCountry: String(body.serverCountry || nextSeed.serverCountry || "cn"),
                };
                session.verification = "verification" in result ? result.verification : undefined;
                session.status = "verification" in result ? "pending" : "success";
                session.message = result.message;
                this.touchSession(
                    session,
                    session.status === "success"
                        ? SUCCESS_SESSION_TTL_MS
                        : PENDING_SESSION_TTL_MS
                );
                session.activeAction = undefined;
                await this.trace("portal_action_success", {
                    ...this.requestMeta(request, matchedPath, session.id, action),
                    status: session.status,
                    message: session.message,
                    verificationRequired: Boolean(session.verification),
                });
                sendJson(response, 200, this.toPublicSnapshot(session));
            } catch (error) {
                session.status = "error";
                session.activeAction = undefined;
                session.error = error instanceof Error ? error.message : String(error);
                this.touchSession(session);
                await this.trace("portal_action_error", {
                    ...this.requestMeta(request, matchedPath, session.id, action),
                    error: session.error,
                });
                sendJson(response, 400, { error: session.error });
            }
            return;
        }

        notFound(response);
    }
}
