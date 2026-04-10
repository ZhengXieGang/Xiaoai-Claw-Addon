import { statSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

export function htmlEscape(value: string) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const UI_ASSET_ROOT_CANDIDATES = [
    path.resolve(MODULE_DIR, "../assets"),
    path.resolve(MODULE_DIR, "../../assets"),
];

function resolveUiAssetFile(relativePath: string) {
    for (const assetRoot of UI_ASSET_ROOT_CANDIDATES) {
        const candidate = path.resolve(assetRoot, relativePath);
        try {
            statSync(candidate);
            return candidate;
        } catch {
            // Try the next candidate.
        }
    }
    return path.resolve(UI_ASSET_ROOT_CANDIDATES[0], relativePath);
}

const UI_ASSET_FINGERPRINT_FILES = [
    resolveUiAssetFile("ui/xiaoai-console.css"),
    resolveUiAssetFile("ui/xiaoai-console.js"),
    resolveUiAssetFile("ui/favicon.svg"),
    resolveUiAssetFile("fonts/manrope/wght.css"),
    resolveUiAssetFile("fonts/noto-sans-sc/wght.css"),
    resolveUiAssetFile("fonts/manrope/files/manrope-latin-wght-normal.woff2"),
    resolveUiAssetFile("fonts/noto-sans-sc/files/noto-sans-sc-latin-wght-normal.woff2"),
];

function resolveUiAssetVersion() {
    try {
        return UI_ASSET_FINGERPRINT_FILES.map((assetPath) => {
            const stat = statSync(assetPath);
            return `${path.basename(assetPath)}-${stat.size.toString(16)}-${Math.floor(
                stat.mtimeMs
            ).toString(16)}`;
        }).join(".");
    } catch {
        return "dev";
    }
}

export function uiAssetVersionQuery() {
    return `?v=${encodeURIComponent(resolveUiAssetVersion())}`;
}

export function normalizeAssetBasePath(value?: string) {
    const trimmed = (value || "/assets").trim();
    if (!trimmed || trimmed === "/") {
        return "/assets";
    }
    if (/^[a-z]+:\/\//i.test(trimmed) || trimmed.startsWith("//")) {
        return trimmed.replace(/\/+$/, "");
    }
    const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    return withLeadingSlash.replace(/\/+$/, "");
}

export function renderThemeBootScript() {
    return `<script>
  (function() {
    var key = "xiaoai_console_theme";
    var mode = "auto";
    try {
      mode = localStorage.getItem(key) || "auto";
    } catch (_) {}
    if (mode !== "auto" && mode !== "light" && mode !== "dark") {
      mode = "auto";
    }
    var prefersDark = false;
    try {
      prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    } catch (_) {}
    var resolved = mode === "auto" ? (prefersDark ? "dark" : "light") : mode;
    document.documentElement.dataset.themeMode = mode;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
  })();
</script>`;
}

export function renderThemeSwitch() {
    return `<div class="theme-switch" data-theme-switch>
      <div class="theme-menu">
        <button type="button" class="theme-btn" data-theme-choice="auto" aria-pressed="false">自动</button>
        <button type="button" class="theme-btn" data-theme-choice="light" aria-pressed="false">浅色</button>
        <button type="button" class="theme-btn" data-theme-choice="dark" aria-pressed="false">深色</button>
      </div>
    </div>`;
}

export function renderSharedHead(title: string, assetBasePath: string) {
    const escapedTitle = htmlEscape(title);
    const basePath = htmlEscape(normalizeAssetBasePath(assetBasePath));
    const assetVersion = uiAssetVersionQuery();
    return `<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" content="#ff6a00">
  <title>${escapedTitle}</title>
  <link rel="icon" href="${basePath}/ui/favicon.svg${assetVersion}" type="image/svg+xml">
  <link rel="shortcut icon" href="${basePath}/ui/favicon.svg${assetVersion}" type="image/svg+xml">
  <link rel="preload" href="${basePath}/ui/xiaoai-console.css${assetVersion}" as="style">
  <link rel="stylesheet" href="${basePath}/fonts/noto-sans-sc/wght.css${assetVersion}">
  <link rel="stylesheet" href="${basePath}/fonts/manrope/wght.css${assetVersion}">
  <link rel="stylesheet" href="${basePath}/ui/xiaoai-console.css${assetVersion}">
  ${renderThemeBootScript()}
</head>`;
}

export function renderConsoleAccessPage(options?: {
    title?: string;
    hint?: string;
    assetBasePath?: string;
}) {
    const title = options?.title || "XiaoAI Cloud Console";
    const hint =
        options?.hint ||
        "这个后台受访问口令保护。请使用插件生成的完整后台链接打开，或者把访问口令粘贴到下面。";
    const assetBasePath = normalizeAssetBasePath(options?.assetBasePath);
    const assetVersion = uiAssetVersionQuery();

    return `<!doctype html>
<html lang="zh-CN">
${renderSharedHead(title, assetBasePath)}
<body data-page="access">
  <div class="page-shell page-shell-access">
    <main class="console-shell access-shell">
      <section class="surface access-card access-card-minimal">
        <form class="access-form access-form-minimal" method="get" autocomplete="on">
          <div class="access-copy access-copy-minimal">
            <h1>控制台配对</h1>
            <p class="hero-sub access-hint">${htmlEscape(hint)}</p>
          </div>
          <label class="field-shell token-shell">
            <span class="field-label">访问口令</span>
            <input
              id="accessTokenInput"
              class="text-field"
              type="password"
              name="access_token"
              autocomplete="current-password"
              placeholder="粘贴控制台访问口令"
              required
            />
          </label>
          <p class="helper-text access-inline-note">
            把 OpenClaw 发来的控制台 token 粘贴到这里即可。配对成功后会自动写入浏览器，后续一般不用重复输入。
          </p>
          <button class="primary-btn access-submit" type="submit">配对</button>
        </form>
      </section>
    </main>
  </div>

  <script type="module" src="${htmlEscape(assetBasePath)}/ui/xiaoai-console.js${assetVersion}"></script>
</body>
</html>`;
}

export function renderConsolePage(options?: {
    assetBasePath?: string;
}) {
    const assetBasePath = normalizeAssetBasePath(options?.assetBasePath);
    const assetVersion = uiAssetVersionQuery();
    return `<!doctype html>
<html lang="zh-CN">
${renderSharedHead("XiaoAI Cloud Console", assetBasePath)}
<body data-page="console">
  <div class="page-shell">
    <main class="console-shell console-shell-tabs">
      <header class="surface console-topbar">
        <nav class="console-tabs" aria-label="控制台功能切换">
          <button class="console-tab is-active" type="button" data-console-tab="overview">概览</button>
          <button class="console-tab" type="button" data-console-tab="chat">对话</button>
          <button class="console-tab" type="button" data-console-tab="control">控制</button>
          <button class="console-tab" type="button" data-console-tab="events">事件</button>
        </nav>
      </header>

      <section class="tab-stage">
        <section class="tab-panel is-active" data-tab-panel="overview">
          <div class="panel-screen-scroll overview-screen-scroll">
            <div class="overview-grid">
              <section class="surface overview-card overview-device-card">
                <div class="card-head">
                  <div class="card-copy">
                    <span class="micro-label">当前设备</span>
                    <div class="card-value card-device-name" id="statDevice">未绑定设备</div>
                    <div class="card-meta" id="statDeviceMeta">等待读取设备信息</div>
                  </div>
                  <span class="state-badge" id="deviceStateBadge">连接中</span>
                </div>

                <div class="device-status-row">
                  <div class="status-stack">
                    <span class="micro-label">状态</span>
                    <div class="status-line" id="deviceStatusText">连接中</div>
                  </div>
                  <button class="soft-btn compact-btn" type="button" id="toggleDeviceListBtn">切换设备</button>
                </div>

                <div class="device-list-shell" id="deviceListShell" hidden>
                  <div class="device-list" id="deviceList"></div>
                </div>
              </section>

              <section class="surface overview-card overview-account-card">
                <div class="card-head overview-account-head">
                  <span class="micro-label">账号与区域</span>
                </div>
                <div class="overview-account-summary">
                  <div class="card-value" id="statAccount">未保存账号</div>
                  <div class="card-meta" id="statRegion">区域：-</div>
                </div>
                <div class="overview-account-actions">
                  <button class="soft-btn compact-btn" type="button" id="accountActionBtn">退出登录</button>
                </div>
              </section>

              <section class="surface overview-card overview-mode-card">
                <div class="card-copy">
                  <span class="micro-label">工作模式</span>
                  <div class="card-value" id="statMode">-</div>
                  <div class="card-meta" id="statModeDetail">等待读取模式</div>
                </div>
              </section>

              <section class="surface overview-card overview-volume-card">
                <div class="card-head overview-volume-head">
                  <div class="card-copy">
                    <span class="micro-label">音量</span>
                    <div class="card-value metric volume-metric-editable">
                      <span
                        id="statVolume"
                        contenteditable="plaintext-only"
                        spellcheck="false"
                        tabindex="0"
                        role="spinbutton"
                        aria-label="播放音量"
                        aria-valuemin="0"
                        aria-valuemax="100"
                        aria-valuenow="0"
                      >-</span>
                      <span class="metric-unit" aria-hidden="true">%</span>
                    </div>
                    <div class="card-meta" id="statVolumeDetail">等待读取音量</div>
                  </div>
                </div>
                <div class="volume-inputs">
                  <input
                    id="volumeSlider"
                    class="range-field"
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    value="0"
                    aria-label="播放音量"
                  />
                  <div class="volume-mute-row">
                    <div class="card-meta volume-mute-hint">
                      播放静音只影响音频播放，不影响小爱播报。
                    </div>
                    <button
                      class="soft-btn compact-btn toggle-pill-btn"
                      id="volumeMuteToggle"
                      type="button"
                      aria-pressed="false"
                    >
                      <strong id="volumeMuteLabel">已关闭</strong>
                    </button>
                  </div>
                </div>
              </section>

              <section class="surface overview-card overview-audio-card">
                <div class="card-copy">
                  <span class="micro-label">音频播放（测试）</span>
                  <div class="card-meta">手动输入音频文件 URL 让小爱播放。</div>
                </div>

                <div class="overview-audio-form">
                  <label class="composer-field">
                    <input
                      class="text-field chat-audio-url-input"
                      id="audioUrlInput"
                      type="url"
                      inputmode="url"
                      placeholder="粘贴可直接访问的音频文件 URL"
                    />
                  </label>
                  <button class="primary-btn overview-audio-send-btn" id="audioSendBtn" type="button">播放</button>
                </div>

                <div class="browser-audio-panel" id="browserAudioDock" aria-live="polite">
                  <div class="browser-audio-head">
                    <div class="browser-audio-copy">
                      <div class="browser-audio-title" id="browserAudioTitle">暂未播放音频</div>
                      <div class="card-meta" id="browserAudioStatus">输入音频文件 URL 后可直接让音箱播放。</div>
                    </div>
                    <div class="browser-audio-actions">
                      <button class="soft-btn compact-btn" id="currentAudioStartBtn" type="button" disabled>播放</button>
                      <button class="soft-btn compact-btn" id="currentAudioPauseBtn" type="button" disabled>暂停</button>
                      <button class="soft-btn compact-btn browser-audio-close" id="currentAudioStopBtn" type="button" disabled>停止</button>
                    </div>
                  </div>
                  <div class="audio-player-shell audio-player-shell-speaker" id="speakerAudioShell" hidden>
                    <div class="audio-player-row audio-player-row-readonly">
                      <div class="audio-player-progress" id="speakerAudioProgress" aria-hidden="true">
                        <span class="audio-player-progress-fill" id="speakerAudioProgressFill"></span>
                      </div>
                      <div class="audio-player-time" id="speakerAudioTime">00:00 / --:--</div>
                    </div>
                  </div>
                  <div class="audio-player-shell audio-player-shell-browser" id="browserAudioPlayerShell" data-audio-player-root="browser">
                    <audio class="audio-player-media" id="browserAudioPlayer" preload="none"></audio>
                    <div class="audio-player-row audio-player-row-compact">
                      <button class="soft-btn compact-btn audio-player-toggle" id="browserAudioToggleBtn" data-audio-toggle type="button">播放</button>
                      <div class="audio-player-progress" id="browserAudioSeek" data-audio-progress aria-hidden="true">
                        <span class="audio-player-progress-fill" data-audio-progress-fill></span>
                      </div>
                      <div class="audio-player-time" id="browserAudioTime" data-audio-time>00:00 / --:--</div>
                    </div>
                  </div>
                </div>
              </section>

              <section class="surface overview-card overview-log-card">
                <div class="card-copy">
                  <span class="micro-label">日志</span>
                  <div class="card-value card-value-sm" id="statLogTitle">调试日志</div>
                  <div class="card-meta card-meta-break" id="statLog">等待读取日志路径</div>
                  <div class="card-meta" id="statHelper">等待读取运行环境</div>
                </div>
              </section>

              <section class="surface overview-card overview-theme-card">
                <div class="card-copy">
                  <span class="micro-label">外观</span>
                </div>
                ${renderThemeSwitch()}
              </section>
            </div>
          </div>
        </section>

        <section class="tab-panel" data-tab-panel="chat" hidden>
          <section class="chat-stage" id="chatStage">
            <div class="conversation-scroll chat-scroll" id="conversationScroll">
              <div class="conversation-list chat-list" id="conversationList"></div>
            </div>

            <div class="surface chat-composer-shell" id="composerShell">
              <div class="segmented-control chat-mode-switch" id="composerMode">
                  <button class="segment-btn is-active" type="button" data-compose-mode="chat">问小爱</button>
                  <button class="segment-btn" type="button" data-compose-mode="speak">直接播报</button>
              </div>

              <div class="chat-composer-row" id="textComposerRow">
                <label class="composer-field">
                  <textarea
                    class="text-area chat-textarea"
                    id="composerInput"
                    rows="1"
                    placeholder="输入一条消息"
                  ></textarea>
                </label>
                <button class="primary-btn chat-send-btn" id="sendBtn" type="button">发送</button>
              </div>
            </div>
          </section>
        </section>

        <section class="tab-panel" data-tab-panel="control" hidden>
          <div class="panel-screen-scroll control-screen-scroll">
            <div class="control-stack">
              <section class="surface control-card control-card-mode">
                <div class="card-copy">
                  <span class="micro-label">工作模式</span>
                  <div class="card-meta">切换当前接管策略。</div>
                </div>

                <div class="mode-grid" id="modeGrid">
                  <button class="mode-btn" type="button" data-mode-choice="wake">
                    <strong>唤醒模式</strong>
                    <span>正常监听和接管</span>
                  </button>
                  <button class="mode-btn" type="button" data-mode-choice="proxy">
                    <strong>代理模式</strong>
                    <span>默认接管全部对话</span>
                  </button>
                  <button class="mode-btn" type="button" data-mode-choice="silent">
                    <strong>静默模式</strong>
                    <span>暂停接管对话</span>
                  </button>
                </div>
              </section>

              <section class="surface control-card control-card-wakeword">
                <div class="card-head wakeword-card-head">
                  <div class="card-copy">
                    <span class="micro-label">唤醒词</span>
                    <div class="card-meta">支持固定短语和正则源码。直接输入普通文字时，会按字面匹配，请先测试小爱是否能准确识别。</div>
                  </div>
                  <button class="soft-btn compact-btn" id="wakeWordSaveBtn" type="button">保存唤醒词</button>
                </div>

                <label class="field-shell wakeword-field-shell">
                  <input
                    id="wakeWordInput"
                    class="text-field wakeword-input"
                    type="text"
                    placeholder="例如：小虾同学 或 小[虾下夏霞]，"
                    autocomplete="off"
                    spellcheck="false"
                  />
                </label>
              </section>

              <section class="surface control-card control-card-model">
                <div class="card-copy">
                  <span class="micro-label">模型选择</span>
                  <div class="card-meta">更改 OpenClaw 配置里小爱 agent 的默认模型；保存后会自动重启网关。</div>
                </div>

                <label class="field-shell">
                  <div class="picker-shell">
                    <div class="picker-root" id="openclawModelPicker">
                      <select
                        id="openclawModelSelect"
                        class="picker-native"
                        autocomplete="off"
                      >
                        <option value="">正在读取可用模型…</option>
                      </select>
                      <button
                        class="picker-trigger"
                        id="openclawModelPickerTrigger"
                        type="button"
                        aria-haspopup="listbox"
                        aria-expanded="false"
                        aria-controls="openclawModelPickerPanel"
                      >
                        <span class="picker-trigger-text" id="openclawModelPickerText">正在读取可用模型…</span>
                        <span class="picker-chevron" aria-hidden="true"></span>
                      </button>
                      <div class="picker-panel" id="openclawModelPickerPanel" role="listbox" hidden></div>
                    </div>
                  </div>
                </label>
                <div class="card-meta" id="openclawModelDetail">当前正在读取 xiaoai agent 模型信息…</div>
              </section>

              <section class="surface control-card control-card-calibration">
                <div class="card-head wake-action-head calibration-card-head">
                  <div class="card-copy">
                    <span class="micro-label">延迟校准</span>
                    <div class="card-meta" id="calibrationDescription">轮询间隔和空余延迟可修改，校准时不要和音箱说话。</div>
                  </div>
                  <div class="route-card-actions calibration-card-actions">
                    <div class="picker-root calibration-mode-picker" id="calibrationModePicker">
                      <select
                        id="calibrationModeSelect"
                        class="picker-native"
                      >
                        <option value="audio">音频时序校准</option>
                        <option value="conversation">对话拦截校准</option>
                      </select>
                      <button
                        class="picker-trigger"
                        id="calibrationModePickerTrigger"
                        type="button"
                        aria-haspopup="listbox"
                        aria-expanded="false"
                        aria-controls="calibrationModePickerPanel"
                      >
                        <span class="picker-trigger-text" id="calibrationModePickerText">音频时序校准</span>
                        <span class="picker-chevron" aria-hidden="true"></span>
                      </button>
                      <div class="picker-panel" id="calibrationModePickerPanel" role="listbox" hidden></div>
                    </div>
                    <button class="soft-btn compact-btn" id="calibrationRunBtn" type="button">一键校准</button>
                  </div>
                </div>

                <div class="control-metric-grid calibration-metrics-grid" id="calibrationMetrics"></div>
                <div class="card-meta card-meta-break" id="calibrationDetail">当前还没有校准结果。</div>
              </section>

              <section class="surface control-card control-card-route">
                <div class="card-head route-card-head">
                  <div class="card-copy">
                    <span class="micro-label">插件通知渠道</span>
                    <div class="card-meta">这里只影响登录通知、控制台链接和主动回推，不影响“小爱对话固定走 xiaoai agent”这条主链路。</div>
                  </div>
                  <div class="route-card-actions">
                    <button class="soft-btn compact-btn" id="openclawRouteSaveBtn" type="button">保存</button>
                    <button class="soft-btn compact-btn" id="openclawRouteDisableBtn" type="button">关闭通知</button>
                  </div>
                </div>

                <div class="route-field-grid">
                  <label class="field-shell">
                    <span class="field-label">通知渠道</span>
                    <div class="picker-shell">
                      <div class="picker-root" id="openclawRouteChannelPicker">
                        <select
                          id="openclawRouteChannelSelect"
                          class="picker-native"
                          autocomplete="off"
                        >
                          <option value="">正在读取渠道…</option>
                        </select>
                        <button
                          class="picker-trigger"
                          id="openclawRouteChannelPickerTrigger"
                          type="button"
                          aria-haspopup="listbox"
                          aria-expanded="false"
                          aria-controls="openclawRouteChannelPickerPanel"
                        >
                          <span class="picker-trigger-text" id="openclawRouteChannelPickerText">正在读取渠道…</span>
                          <span class="picker-chevron" aria-hidden="true"></span>
                        </button>
                        <div class="picker-panel" id="openclawRouteChannelPickerPanel" role="listbox" hidden></div>
                      </div>
                    </div>
                  </label>

                  <label class="field-shell">
                    <span class="field-label">通知目标</span>
                    <div class="picker-shell">
                      <div class="picker-root" id="openclawRouteTargetPicker">
                        <div class="picker-input-frame">
                          <input
                            id="openclawRouteTargetInput"
                            class="picker-input"
                            type="text"
                            placeholder="例如：qqbot:c2c:openid 或 telegram chat id"
                            autocomplete="off"
                            spellcheck="false"
                          />
                          <button
                            class="picker-input-toggle"
                            id="openclawRouteTargetPickerToggle"
                            type="button"
                            aria-haspopup="listbox"
                            aria-expanded="false"
                            aria-controls="openclawRouteTargetPickerPanel"
                          >
                            <span class="picker-chevron" aria-hidden="true"></span>
                          </button>
                        </div>
                        <div
                          class="picker-panel picker-panel-inline"
                          id="openclawRouteTargetPickerPanel"
                          role="listbox"
                          hidden
                        ></div>
                      </div>
                    </div>
                  </label>
                </div>
                <div class="card-meta card-meta-break" id="openclawRouteDetail">当前正在读取插件通知渠道…</div>
              </section>

              <section class="surface control-card control-card-workspace">
                <div class="card-head route-card-head">
                  <div class="card-copy">
                    <span class="micro-label">Workspace 提示文件</span>
                    <div class="card-meta">统一编辑 xiaoai agent workspace 的 <code>AGENTS.md</code>、<code>IDENTITY.md</code>、<code>TOOLS.md</code>、<code>HEARTBEAT.md</code>、<code>BOOT.md</code>、<code>MEMORY.md</code>。留空保存会恢复默认内容；普通文件禁用后会清空内容并跳过注入，<code>BOOT.md</code> 会直接移除，<code>AGENTS.md</code> 作为核心提示文件不支持禁用。</div>
                  </div>
                  <div class="route-card-actions">
                    <button class="soft-btn compact-btn" id="voiceSystemPromptSaveBtn" type="button">保存</button>
                    <button class="soft-btn compact-btn" id="workspaceFileDisableBtn" type="button">禁用文件</button>
                  </div>
                </div>

                <label class="field-shell">
                  <span class="field-label">选择文件</span>
                  <div class="picker-shell">
                    <div class="picker-root" id="workspaceFilePicker">
                      <select
                        id="workspaceFileSelect"
                        class="picker-native"
                      >
                        <option value="agents">系统提示词（AGENTS.md）</option>
                      </select>
                      <button
                        class="picker-trigger"
                        id="workspaceFilePickerTrigger"
                        type="button"
                        aria-haspopup="listbox"
                        aria-expanded="false"
                        aria-controls="workspaceFilePickerPanel"
                      >
                        <span class="picker-trigger-text" id="workspaceFilePickerText">系统提示词（AGENTS.md）</span>
                        <span class="picker-chevron" aria-hidden="true"></span>
                      </button>
                      <div class="picker-panel" id="workspaceFilePickerPanel" role="listbox" hidden></div>
                    </div>
                  </div>
                </label>

                <label class="field-shell">
                  <textarea
                    id="voiceSystemPromptInput"
                    class="text-area voice-system-prompt-input"
                    placeholder="输入要写入 xiaoai agent workspace 文件的内容"
                    spellcheck="false"
                  ></textarea>
                </label>
                <div class="card-meta card-meta-break" id="workspaceFileDetail">当前正在读取 xiaoai agent workspace 文件状态…</div>
              </section>

              <section class="surface control-card control-card-debug-log">
                <div class="card-head toggle-card-head">
                  <div class="card-copy">
                    <span class="micro-label">打开日志</span>
                    <div class="card-meta">默认开启。关闭后会停止写入小米网络调试日志；日志文件会自动裁剪。</div>
                  </div>
                  <button
                    class="soft-btn compact-btn toggle-pill-btn is-active"
                    id="debugLogToggle"
                    type="button"
                    aria-pressed="true"
                  >
                    <strong id="debugLogLabel">已开启</strong>
                  </button>
                </div>
              </section>

              <section class="surface control-card control-card-thinking">
                <div class="card-head toggle-card-head">
                  <div class="card-copy">
                    <span class="micro-label">打开思考</span>
                    <div class="card-meta">默认关闭。关闭时会给语音转发默认附加 <code>--thinking off</code>，一般更快；打开后更适合复杂问题，需要模型支持。</div>
                  </div>
                  <button
                    class="soft-btn compact-btn toggle-pill-btn"
                    id="thinkingOffToggle"
                    type="button"
                    aria-pressed="false"
                  >
                    <strong id="thinkingOffLabel">已关闭</strong>
                  </button>
                </div>
              </section>

              <section class="surface control-card control-card-context">
                <div class="card-head context-memory-head">
                  <div class="card-copy">
                    <span class="micro-label">上下文窗口</span>
                    <div class="card-meta">直接写入 xiaoai 专属 agent 的 <code>contextTokens</code>，只影响这个 agent。OpenClaw 会自己管理会话历史。离开输入框后会自动保存。</div>
                  </div>
                  <div class="context-inline-grid">
                    <label class="context-inline-field metric">
                      <input
                        id="openclawContextTokensInput"
                        type="text"
                        inputmode="numeric"
                        pattern="[0-9]*"
                        value="32000"
                        autocomplete="off"
                        spellcheck="false"
                      />
                      <span>tokens</span>
                    </label>
                  </div>
                </div>
              </section>

              <section class="surface control-card control-card-dialog-window">
                <div class="card-head">
                  <div class="card-copy">
                    <span class="micro-label">唤醒窗口</span>
                    <div class="card-meta">唤醒模式下，OpenClaw 主动播报后继续接管后续对话的持续时间。离开输入框自动保存。</div>
                  </div>
                  <label class="dialog-window-inline-field metric">
                    <input
                      id="dialogWindowInput"
                      type="text"
                      inputmode="numeric"
                      pattern="[0-9]*"
                      value="30"
                      autocomplete="off"
                      spellcheck="false"
                    />
                    <span>秒</span>
                  </label>
                </div>
              </section>

              <section class="surface control-card control-card-transition">
                <div class="card-head voice-prompt-card-head">
                  <div class="card-copy">
                    <span class="micro-label">过渡播报词</span>
                    <div class="card-meta">拦截到小爱准备说的话后，随机播报这里的一句占位词。一行一个，留空可恢复默认。</div>
                  </div>
                  <button class="soft-btn compact-btn" id="transitionPhrasesSaveBtn" type="button">保存</button>
                </div>

                <label class="field-shell">
                  <textarea
                    id="transitionPhrasesInput"
                    class="text-area voice-system-prompt-input"
                    placeholder="一行一个过渡播报词"
                    spellcheck="false"
                  ></textarea>
                </label>
              </section>

              <section class="surface control-card control-card-non-streaming">
                <div class="card-head toggle-card-head">
                  <div class="card-copy">
                    <span class="micro-label">强制走非流式请求</span>
                    <div class="card-meta">默认关闭。开启后会改走 OpenClaw 官方 <code>/v1/responses</code> 非流式接口，适合规避上游 Anthropic 兼容流式事件顺序异常；首次开启时会自动启用对应端点并重启网关。</div>
                  </div>
                  <button
                    class="soft-btn compact-btn toggle-pill-btn"
                    id="forceNonStreamingToggle"
                    type="button"
                    aria-pressed="false"
                  >
                    <strong id="forceNonStreamingLabel">已关闭</strong>
                  </button>
                </div>
              </section>

              <section class="surface control-card control-card-remote-wake">
                <div class="card-head wake-action-head">
                  <div class="card-copy">
                    <span class="micro-label">远程唤醒</span>
                    <div class="card-meta">向当前音箱发送一次唤醒动作。</div>
                  </div>
                  <button class="soft-btn compact-btn" id="wakeBtn" type="button">远程唤醒</button>
                </div>
              </section>
            </div>
          </div>
        </section>

        <section class="tab-panel" data-tab-panel="events" hidden>
          <div class="panel-screen-scroll events-screen-scroll" id="eventScroll">
            <div class="events-list events-list-plain" id="eventList"></div>
          </div>
        </section>
      </section>
    </main>
  </div>

  <section class="login-workspace-shell" id="loginWorkspace" hidden aria-hidden="true">
    <div class="login-workspace-backdrop" id="loginWorkspaceBackdrop"></div>
    <div class="surface login-workspace-panel">
      <div class="login-workspace-head">
        <div class="login-workspace-actions">
          <button class="soft-btn compact-btn" id="loginWorkspaceCloseBtn" type="button">返回控制台</button>
        </div>
      </div>

      <div class="login-workspace-frame-shell" id="loginWorkspaceFrameShell">
        <iframe
          id="loginWorkspaceFrame"
          class="login-workspace-frame"
          title="Xiaomi account login"
          loading="eager"
          scrolling="no"
          referrerpolicy="no-referrer"
        ></iframe>
      </div>
    </div>
  </section>

  <div class="toast" id="toast"></div>

  <script type="module" src="${htmlEscape(assetBasePath)}/ui/xiaoai-console.js${assetVersion}"></script>
</body>
</html>`;
}
