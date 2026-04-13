const THEME_STORAGE_KEY = "xiaoai_console_theme";
const CONSOLE_TAB_STORAGE_KEY = "xiaoai_console_tab";
const CONSOLE_ACCESS_TOKEN_STORAGE_KEY = "xiaoai_console_access_token";
const TAB_ORDER = ["overview", "chat", "control", "events"];
const DEFAULT_DIALOG_WINDOW_SECONDS = 30;
const MIN_DIALOG_WINDOW_SECONDS = 5;
const MAX_DIALOG_WINDOW_SECONDS = 300;
const DEFAULT_CONVERSATION_POLL_INTERVAL_MS = 320;
const MIN_CONVERSATION_POLL_INTERVAL_MS = 80;
const MIN_RECOMMENDED_CONVERSATION_POLL_INTERVAL_MS = 120;
const MAX_CONVERSATION_POLL_INTERVAL_MS = 10000;
const DEFAULT_CONVERSATION_INTERCEPT_MANUAL_OFFSET_MS = 0;
const MIN_CONVERSATION_INTERCEPT_MANUAL_OFFSET_MS = -900;
const MAX_CONVERSATION_INTERCEPT_MANUAL_OFFSET_MS = 900;
const CONVERSATION_INTERCEPT_MANUAL_OFFSET_STEP_MS = 25;
const DEFAULT_AUDIO_TAIL_PADDING_MS = 1500;
const MAX_AUDIO_TAIL_PADDING_MS = 10000;
const DEFAULT_OPENCLAW_CONTEXT_TOKENS = 32000;
const MIN_OPENCLAW_CONTEXT_TOKENS = 1;
const MAX_OPENCLAW_CONTEXT_TOKENS = 2000000;
const MAX_OPENCLAW_VOICE_SYSTEM_PROMPT_CHARS = 6000;
const MAX_TRANSITION_PHRASES = 12;
const MAX_TRANSITION_PHRASE_CHARS = 40;
const SPEAKER_PAUSE_MEMORY_TTL_MS = 20 * 1000;
const CONTROL_MASONRY_BREAKPOINT_PX = 961;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sleep(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function byId(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildLowPollIntervalWarning(pollIntervalMs) {
  const safeMs = Math.round(Number(pollIntervalMs) || 0);
  if (
    !Number.isFinite(safeMs) ||
    safeMs >= MIN_RECOMMENDED_CONVERSATION_POLL_INTERVAL_MS
  ) {
    return "";
  }
  return `低于 ${MIN_RECOMMENDED_CONVERSATION_POLL_INTERVAL_MS}ms 不建议，容易放大小米侧超时并触发自动退避。`;
}

function getStoredThemeMode() {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY) || "auto";
    return stored === "light" || stored === "dark" || stored === "auto"
      ? stored
      : "auto";
  } catch (_) {
    return "auto";
  }
}

function resolveTheme(mode) {
  if (mode === "light" || mode === "dark") {
    return mode;
  }
  return window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyThemeMode(mode, persist) {
  const safeMode =
    mode === "light" || mode === "dark" || mode === "auto" ? mode : "auto";
  const resolved = resolveTheme(safeMode);
  document.documentElement.dataset.themeMode = safeMode;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, safeMode);
    } catch (_) {}
  }
  syncThemeSwitches();
}

function syncThemeSwitches() {
  const current = document.documentElement.dataset.themeMode || "auto";
  document.querySelectorAll("[data-theme-choice]").forEach((button) => {
    const active = button.dataset.themeChoice === current;
    button.dataset.active = active ? "true" : "false";
    button.setAttribute("aria-pressed", String(active));
  });
}

function initThemeSwitches() {
  document.querySelectorAll("[data-theme-switch]").forEach((root) => {
    root.querySelectorAll("[data-theme-choice]").forEach((button) => {
      button.addEventListener("click", () => {
        applyThemeMode(button.dataset.themeChoice || "auto", true);
      });
    });
  });
  syncThemeSwitches();
}

function initThemeSystem() {
  applyThemeMode(getStoredThemeMode(), false);
  if (window.matchMedia) {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      if ((document.documentElement.dataset.themeMode || "auto") === "auto") {
        applyThemeMode("auto", false);
      }
    };
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", handleChange);
    } else if (typeof media.addListener === "function") {
      media.addListener(handleChange);
    }
  }
}

function readPersistedConsoleAccessToken() {
  try {
    const stored = localStorage.getItem(CONSOLE_ACCESS_TOKEN_STORAGE_KEY);
    if (stored && stored.trim()) {
      return stored.trim();
    }
  } catch (_) {}

  try {
    const stored = window.sessionStorage.getItem(CONSOLE_ACCESS_TOKEN_STORAGE_KEY);
    if (stored && stored.trim()) {
      return stored.trim();
    }
  } catch (_) {}

  return "";
}

function persistConsoleAccessToken(token) {
  const normalized = typeof token === "string" ? token.trim() : "";
  if (!normalized) {
    return;
  }

  try {
    localStorage.setItem(CONSOLE_ACCESS_TOKEN_STORAGE_KEY, normalized);
  } catch (_) {}

  try {
    window.sessionStorage.setItem(CONSOLE_ACCESS_TOKEN_STORAGE_KEY, normalized);
  } catch (_) {}
}

function stripConsoleAccessTokenFromUrl(locationUrl) {
  let changed = false;
  if (locationUrl.searchParams.has("access_token")) {
    locationUrl.searchParams.delete("access_token");
    changed = true;
  }

  if (locationUrl.hash) {
    const hashParams = new URLSearchParams(locationUrl.hash.replace(/^#/, ""));
    if (hashParams.has("access_token")) {
      hashParams.delete("access_token");
      locationUrl.hash = hashParams.toString() ? `#${hashParams.toString()}` : "";
      changed = true;
    }
  }

  if (!changed) {
    return;
  }

  try {
    window.history.replaceState(
      window.history.state,
      document.title,
      `${locationUrl.pathname}${locationUrl.search}${locationUrl.hash}`
    );
  } catch (_) {}
}

function initAccessPage() {
  const accessTokenInput = byId("accessTokenInput");
  const accessForm = accessTokenInput ? accessTokenInput.form : null;

  if (!accessTokenInput) {
    return;
  }

  const locationUrl = new URL(window.location.href);
  const hashParams = new URLSearchParams(locationUrl.hash.replace(/^#/, ""));
  const queryAccessToken = locationUrl.searchParams.get("access_token") || "";
  const hashAccessToken = hashParams.get("access_token") || "";
  const storedAccessToken = readPersistedConsoleAccessToken() || "";
  const accessToken = queryAccessToken || hashAccessToken || storedAccessToken || "";
  const accessTokenSource = queryAccessToken
    ? "query"
    : hashAccessToken
      ? "hash"
      : storedAccessToken
        ? "storage"
        : "";

  if (accessToken) {
    accessTokenInput.value = accessToken;
    persistConsoleAccessToken(accessToken);
  }

  if (accessForm) {
    accessForm.addEventListener("submit", () => {
      persistConsoleAccessToken(accessTokenInput.value || "");
    });
  }

  if (accessToken && accessForm) {
    let shouldAutoSubmit = true;
    if (accessTokenSource === "query" || accessTokenSource === "hash") {
      const autoSubmitKey = `xiaoai_console_access_autosubmit:${locationUrl.pathname}:${accessToken}`;
      try {
        shouldAutoSubmit = window.sessionStorage.getItem(autoSubmitKey) !== "1";
        if (shouldAutoSubmit) {
          window.sessionStorage.setItem(autoSubmitKey, "1");
        }
      } catch (_) {}
    }

    if (shouldAutoSubmit) {
      window.setTimeout(() => {
        if (typeof accessForm.requestSubmit === "function") {
          accessForm.requestSubmit();
        } else {
          accessForm.submit();
        }
      }, 60);
      return;
    }
  }

  window.setTimeout(() => {
    accessTokenInput.focus();
  }, 80);
}

function initConsolePage() {
  const locationUrl = new URL(window.location.href);
  const consoleAccessToken =
    locationUrl.searchParams.get("access_token") ||
    readPersistedConsoleAccessToken() ||
    "";

  if (consoleAccessToken) {
    persistConsoleAccessToken(consoleAccessToken);
  }

  stripConsoleAccessTokenFromUrl(locationUrl);

  const API = {
    bootstrap: new URL("./api/bootstrap", window.location.href),
    conversations: new URL("./api/conversations", window.location.href),
    events: new URL("./api/events", window.location.href),
    chatSend: new URL("./api/chat/send", window.location.href),
    speak: new URL("./api/speaker/speak", window.location.href),
    audioPlay: new URL("./api/speaker/play-audio", window.location.href),
    audioPause: new URL("./api/speaker/pause", window.location.href),
    audioResume: new URL("./api/speaker/resume", window.location.href),
    audioStop: new URL("./api/speaker/stop", window.location.href),
    wake: new URL("./api/device/wake-up", window.location.href),
    volume: new URL("./api/device/volume", window.location.href),
    mute: new URL("./api/device/mute", window.location.href),
    dialogWindow: new URL("./api/device/dialog-window", window.location.href),
    thinking: new URL("./api/openclaw/thinking", window.location.href),
    nonStreaming: new URL("./api/openclaw/non-streaming", window.location.href),
    audioCalibration: new URL("./api/device/audio-calibration", window.location.href),
    conversationInterceptCalibration: new URL(
      "./api/device/conversation-intercept-calibration",
      window.location.href
    ),
    pollInterval: new URL("./api/device/poll-interval", window.location.href),
    conversationInterceptOffset: new URL(
      "./api/device/conversation-intercept-offset",
      window.location.href
    ),
    audioTailPadding: new URL("./api/device/audio-tail-padding", window.location.href),
    openclawModel: new URL("./api/openclaw/model", window.location.href),
    openclawRoute: new URL("./api/openclaw/route", window.location.href),
    voiceSystemPrompt: new URL("./api/openclaw/voice-system-prompt", window.location.href),
    workspaceFile: new URL("./api/openclaw/workspace-file", window.location.href),
    transitionPhrases: new URL("./api/device/transition-phrases", window.location.href),
    debugLog: new URL("./api/debug-log", window.location.href),
    contextTokens: new URL("./api/openclaw/context-tokens", window.location.href),
    mode: new URL("./api/device/mode", window.location.href),
    wakeWord: new URL("./api/device/wake-word", window.location.href),
    deviceList: new URL("./api/device/list", window.location.href),
    deviceSelect: new URL("./api/device/select", window.location.href),
    accountLogout: new URL("./api/account/logout", window.location.href),
  };

  const state = {
    composeMode: "chat",
    activeTab: "overview",
    bootstrap: null,
    refreshTimer: null,
    hasConversationRender: false,
    currentVolumeValue: 0,
    confirmedVolumeValue: 0,
    hasVolumeSnapshot: false,
    muted: false,
    confirmedMuted: false,
    deviceMuted: false,
    confirmedDeviceMuted: false,
    unmuteBlocked: false,
    confirmedUnmuteBlocked: false,
    muteSupported: true,
    confirmedMuteSupported: true,
    volumeInputTimer: null,
    volumeTextEditing: false,
    speakerControlInFlight: null,
    speakerControlQueued: null,
    speakerStatePending: false,
    speakerStatePendingTimer: null,
    currentDialogWindowValue: DEFAULT_DIALOG_WINDOW_SECONDS,
    dialogWindowDirty: false,
    dialogWindowSaving: false,
    controlScrollRevision: 0,
    currentOpenclawContextTokensValue: DEFAULT_OPENCLAW_CONTEXT_TOKENS,
    openclawContextTokensDirty: false,
    openclawContextTokensSaving: false,
    currentVoiceSystemPromptValue: "",
    openclawWorkspaceFiles: [],
    selectedWorkspaceFileId: "agents",
    workspaceFileDrafts: {},
    workspaceFileDirty: {},
    workspaceFileSaving: false,
    currentTransitionPhrasesValue: "",
    transitionPhrasesDirty: false,
    transitionPhrasesSaving: false,
    deviceListVisible: false,
    deviceListLoaded: false,
    deviceListLoading: false,
    deviceItems: [],
    lastChatScrollTop: 0,
    wakeWordDirty: false,
    loginWorkspaceOpen: false,
    loginWorkspaceUrl: "",
    pendingDeviceSelectionAfterLogin: false,
    bootstrapInitialized: false,
    animateEventsNextRender: false,
    eventItems: [],
    eventItemsLoaded: false,
    eventRenderSignature: "",
    thinkingEnabled: false,
    thinkingSaving: false,
    forceNonStreamingEnabled: false,
    forceNonStreamingSaving: false,
    audioCalibrationRunning: false,
    conversationInterceptCalibrationRunning: false,
    selectedCalibrationMode: "audio",
    currentPollIntervalMs: DEFAULT_CONVERSATION_POLL_INTERVAL_MS,
    confirmedPollIntervalMs: DEFAULT_CONVERSATION_POLL_INTERVAL_MS,
    pollIntervalEditing: false,
    pollIntervalDirty: false,
    pollIntervalSaving: false,
    currentConversationInterceptManualOffsetMs:
      DEFAULT_CONVERSATION_INTERCEPT_MANUAL_OFFSET_MS,
    confirmedConversationInterceptManualOffsetMs:
      DEFAULT_CONVERSATION_INTERCEPT_MANUAL_OFFSET_MS,
    conversationInterceptManualOffsetSaving: false,
    currentAudioTailPaddingMs: DEFAULT_AUDIO_TAIL_PADDING_MS,
    confirmedAudioTailPaddingMs: DEFAULT_AUDIO_TAIL_PADDING_MS,
    audioTailPaddingEditing: false,
    audioTailPaddingDirty: false,
    audioTailPaddingSaving: false,
    openclawAgentId: "xiaoai",
    openclawModel: "",
    openclawModels: [],
    openclawModelLoading: false,
    openclawModelSaving: false,
    openclawRouteChannel: "",
    openclawRouteTarget: "",
    openclawRouteChannels: [],
    openclawRouteEnabled: false,
    openclawRouteDirty: false,
    openclawRouteSaving: false,
    debugLogEnabled: true,
    debugLogSaving: false,
    browserAudioReady: false,
    latestAudioEventId: "",
    currentBrowserAudioUrl: "",
    currentAudioSource: "idle",
    currentAudioStartBusy: false,
    currentAudioPauseBusy: false,
    currentAudioStopBusy: false,
    speakerPauseMemory: null,
    rawSpeakerAudioPlayback: null,
    speakerProgressTimer: null,
    speakerProgressBaseAtMs: 0,
    speakerProgressBasePositionSeconds: 0,
    speakerProgressDurationSeconds: 0,
  };

  const els = {
    controlStack: document.querySelector(".control-stack"),
    controlColumns: Array.from(document.querySelectorAll(".control-column")),
    controlCards: Array.from(document.querySelectorAll(".control-card")),
    controlScreenScroll: document.querySelector(".control-screen-scroll"),
    statDevice: byId("statDevice"),
    statDeviceMeta: byId("statDeviceMeta"),
    deviceStatusText: byId("deviceStatusText"),
    deviceStateBadge: byId("deviceStateBadge"),
    statAccount: byId("statAccount"),
    statRegion: byId("statRegion"),
    statMode: byId("statMode"),
    statModeDetail: byId("statModeDetail"),
    statVolume: byId("statVolume"),
    statVolumeDetail: byId("statVolumeDetail"),
    statLogTitle: byId("statLogTitle"),
    statLog: byId("statLog"),
    statHelper: byId("statHelper"),
    accountActionBtn: byId("accountActionBtn"),
    loginWorkspace: byId("loginWorkspace"),
    loginWorkspaceBackdrop: byId("loginWorkspaceBackdrop"),
    loginWorkspaceFrameShell: byId("loginWorkspaceFrameShell"),
    loginWorkspaceFrame: byId("loginWorkspaceFrame"),
    loginWorkspaceHint: byId("loginWorkspaceHint"),
    loginWorkspaceExternal: byId("loginWorkspaceExternal"),
    loginWorkspaceCloseBtn: byId("loginWorkspaceCloseBtn"),
    toggleDeviceListBtn: byId("toggleDeviceListBtn"),
    deviceListShell: byId("deviceListShell"),
    deviceList: byId("deviceList"),
    conversationScroll: byId("conversationScroll"),
    conversationList: byId("conversationList"),
    eventScroll: byId("eventScroll"),
    eventList: byId("eventList"),
    chatStage: byId("chatStage"),
    composerShell: byId("composerShell"),
    textComposerRow: byId("textComposerRow"),
    composerInput: byId("composerInput"),
    audioUrlInput: byId("audioUrlInput"),
    sendBtn: byId("sendBtn"),
    audioSendBtn: byId("audioSendBtn"),
    wakeBtn: byId("wakeBtn"),
    wakeWordInput: byId("wakeWordInput"),
    wakeWordSaveBtn: byId("wakeWordSaveBtn"),
    workspaceFileSelect: byId("workspaceFileSelect"),
    workspaceFilePicker: byId("workspaceFilePicker"),
    workspaceFilePickerTrigger: byId("workspaceFilePickerTrigger"),
    workspaceFilePickerText: byId("workspaceFilePickerText"),
    workspaceFilePickerPanel: byId("workspaceFilePickerPanel"),
    workspaceFileDisableBtn: byId("workspaceFileDisableBtn"),
    workspaceFileDetail: byId("workspaceFileDetail"),
    voiceSystemPromptInput: byId("voiceSystemPromptInput"),
    voiceSystemPromptSaveBtn: byId("voiceSystemPromptSaveBtn"),
    transitionPhrasesInput: byId("transitionPhrasesInput"),
    transitionPhrasesSaveBtn: byId("transitionPhrasesSaveBtn"),
    thinkingOffToggle: byId("thinkingOffToggle"),
    thinkingOffLabel: byId("thinkingOffLabel"),
    forceNonStreamingToggle: byId("forceNonStreamingToggle"),
    forceNonStreamingLabel: byId("forceNonStreamingLabel"),
    calibrationModeSelect: byId("calibrationModeSelect"),
    calibrationModePicker: byId("calibrationModePicker"),
    calibrationModePickerTrigger: byId("calibrationModePickerTrigger"),
    calibrationModePickerText: byId("calibrationModePickerText"),
    calibrationModePickerPanel: byId("calibrationModePickerPanel"),
    calibrationRunBtn: byId("calibrationRunBtn"),
    calibrationMetrics: byId("calibrationMetrics"),
    calibrationDetail: byId("calibrationDetail"),
    calibrationDescription: byId("calibrationDescription"),
    pollIntervalValue: byId("pollIntervalValue"),
    pollIntervalNote: byId("pollIntervalNote"),
    conversationVisibleValue: byId("conversationVisibleValue"),
    nativePlaybackStartValue: byId("nativePlaybackStartValue"),
    interceptLeadValue: byId("interceptLeadValue"),
    conversationInterceptOffsetSlider: byId("conversationInterceptOffsetSlider"),
    conversationInterceptOffsetValue: byId("conversationInterceptOffsetValue"),
    conversationInterceptOffsetNote: byId("conversationInterceptOffsetNote"),
    audioTailPaddingValue: byId("audioTailPaddingValue"),
    audioTailPaddingNote: byId("audioTailPaddingNote"),
    audioCalibrationPlaybackDetectValue: byId("audioCalibrationPlaybackDetectValue"),
    audioCalibrationStopSettleValue: byId("audioCalibrationStopSettleValue"),
    audioCalibrationStatusProbeValue: byId("audioCalibrationStatusProbeValue"),
    openclawModelSelect: byId("openclawModelSelect"),
    openclawModelPicker: byId("openclawModelPicker"),
    openclawModelPickerTrigger: byId("openclawModelPickerTrigger"),
    openclawModelPickerText: byId("openclawModelPickerText"),
    openclawModelPickerPanel: byId("openclawModelPickerPanel"),
    openclawModelDetail: byId("openclawModelDetail"),
    openclawRouteChannelSelect: byId("openclawRouteChannelSelect"),
    openclawRouteChannelPicker: byId("openclawRouteChannelPicker"),
    openclawRouteChannelPickerTrigger: byId("openclawRouteChannelPickerTrigger"),
    openclawRouteChannelPickerText: byId("openclawRouteChannelPickerText"),
    openclawRouteChannelPickerPanel: byId("openclawRouteChannelPickerPanel"),
    openclawRouteTargetInput: byId("openclawRouteTargetInput"),
    openclawRouteTargetPicker: byId("openclawRouteTargetPicker"),
    openclawRouteTargetPickerToggle: byId("openclawRouteTargetPickerToggle"),
    openclawRouteTargetPickerPanel: byId("openclawRouteTargetPickerPanel"),
    openclawRouteDetail: byId("openclawRouteDetail"),
    openclawRouteSaveBtn: byId("openclawRouteSaveBtn"),
    openclawRouteDisableBtn: byId("openclawRouteDisableBtn"),
    debugLogToggle: byId("debugLogToggle"),
    debugLogLabel: byId("debugLogLabel"),
    volumeSlider: byId("volumeSlider"),
    volumeMuteToggle: byId("volumeMuteToggle"),
    volumeMuteLabel: byId("volumeMuteLabel"),
    dialogWindowInput: byId("dialogWindowInput"),
    openclawContextTokensInput: byId("openclawContextTokensInput"),
    browserAudioDock: byId("browserAudioDock"),
    browserAudioPlayerShell: byId("browserAudioPlayerShell"),
    speakerAudioShell: byId("speakerAudioShell"),
    speakerAudioProgress: byId("speakerAudioProgress"),
    speakerAudioProgressFill: byId("speakerAudioProgressFill"),
    speakerAudioTime: byId("speakerAudioTime"),
    browserAudioTitle: byId("browserAudioTitle"),
    browserAudioStatus: byId("browserAudioStatus"),
    browserAudioPlayer: byId("browserAudioPlayer"),
    browserAudioToggleBtn: byId("browserAudioToggleBtn"),
    browserAudioTime: byId("browserAudioTime"),
    currentAudioStartBtn: byId("currentAudioStartBtn"),
    currentAudioPauseBtn: byId("currentAudioPauseBtn"),
    currentAudioStopBtn: byId("currentAudioStopBtn"),
    toast: byId("toast"),
    tabButtons: Array.from(document.querySelectorAll("[data-console-tab]")),
    tabPanels: Array.from(document.querySelectorAll("[data-tab-panel]")),
    composeButtons: Array.from(
      document.querySelectorAll("[data-compose-mode]")
    ),
    modeButtons: Array.from(document.querySelectorAll("[data-mode-choice]")),
  };

  const CONTROL_CARD_CLASS_ORDER = [
    "control-card-mode",
    "control-card-wakeword",
    "control-card-model",
    "control-card-route",
    "control-card-workspace",
    "control-card-debug-log",
    "control-card-thinking",
    "control-card-context",
    "control-card-dialog-window",
    "control-card-transition",
    "control-card-non-streaming",
    "control-card-calibration",
    "control-card-remote-wake",
  ];

  const selectPickerConfigs = [
    {
      select: els.openclawModelSelect,
      root: els.openclawModelPicker,
      trigger: els.openclawModelPickerTrigger,
      text: els.openclawModelPickerText,
      panel: els.openclawModelPickerPanel,
      emptyText: "未读取到可用模型",
    },
    {
      select: els.openclawRouteChannelSelect,
      root: els.openclawRouteChannelPicker,
      trigger: els.openclawRouteChannelPickerTrigger,
      text: els.openclawRouteChannelPickerText,
      panel: els.openclawRouteChannelPickerPanel,
      emptyText: "未检测到已配置渠道",
    },
    {
      select: els.workspaceFileSelect,
      root: els.workspaceFilePicker,
      trigger: els.workspaceFilePickerTrigger,
      text: els.workspaceFilePickerText,
      panel: els.workspaceFilePickerPanel,
      emptyText: "当前没有可编辑文件",
    },
    {
      select: els.calibrationModeSelect,
      root: els.calibrationModePicker,
      trigger: els.calibrationModePickerTrigger,
      text: els.calibrationModePickerText,
      panel: els.calibrationModePickerPanel,
      emptyText: "请选择校准模式",
    },
  ];

  let activePickerRoot = null;
  let controlMasonryFrame = 0;
  let controlMasonryForceReassign = false;
  let controlLayoutMode = "single";
  const controlCardAssignments = new WeakMap();

  function restoreControlScrollTop(scrollTop) {
    if (!els.controlScreenScroll || !Number.isFinite(scrollTop)) {
      return;
    }
    els.controlScreenScroll.scrollTop = Math.max(0, scrollTop);
  }

  function getOrderedControlCards() {
    if (!els.controlStack) {
      return [];
    }
    return Array.from(els.controlStack.querySelectorAll(".control-card")).sort(
      (left, right) => {
        const leftOrder = Number(left.dataset.controlOrder || "0");
        const rightOrder = Number(right.dataset.controlOrder || "0");
        return leftOrder - rightOrder;
      }
    );
  }

  function ensureControlColumns() {
    if (!els.controlStack) {
      return [];
    }
    if (els.controlColumns.length >= 2) {
      return els.controlColumns;
    }
    const columns = [0, 1].map((index) => {
      const column = document.createElement("div");
      column.className = "control-column";
      column.dataset.controlColumn = String(index);
      return column;
    });
    columns.forEach((column) => {
      els.controlStack.appendChild(column);
    });
    els.controlColumns = columns;
    return columns;
  }

  function assignControlCardsToColumns(cards) {
    const gap = 12;
    const heights = [0, 0];
    cards.forEach((card) => {
      const height = Math.ceil(
        card.getBoundingClientRect().height || card.offsetHeight || 0
      );
      const targetIndex = heights[0] <= heights[1] ? 0 : 1;
      controlCardAssignments.set(card, targetIndex);
      heights[targetIndex] += height + gap;
    });
  }

  function applyControlMasonryLayout(forceReassign) {
    if (!els.controlStack) {
      return;
    }
    const columns = ensureControlColumns();
    if (columns.length < 2) {
      return;
    }
    const cards = getOrderedControlCards();
    const desktop = window.innerWidth >= CONTROL_MASONRY_BREAKPOINT_PX;

    if (!desktop) {
      columns[0].hidden = false;
      columns[1].hidden = true;
      cards.forEach((card) => {
        columns[0].appendChild(card);
      });
      controlLayoutMode = "single";
      return;
    }

    columns[0].hidden = false;
    columns[1].hidden = false;
    const needsReassign =
      forceReassign ||
      controlLayoutMode !== "double" ||
      cards.some((card) => typeof controlCardAssignments.get(card) !== "number");
    if (needsReassign) {
      assignControlCardsToColumns(cards);
    }
    cards.forEach((card) => {
      const targetIndex = controlCardAssignments.get(card) === 1 ? 1 : 0;
      columns[targetIndex].appendChild(card);
    });
    controlLayoutMode = "double";
  }

  function scheduleControlMasonryLayout(forceReassign) {
    controlMasonryForceReassign =
      controlMasonryForceReassign || Boolean(forceReassign);
    if (controlMasonryFrame) {
      return;
    }
    controlMasonryFrame = window.requestAnimationFrame(() => {
      controlMasonryFrame = 0;
      const shouldReassign = controlMasonryForceReassign;
      controlMasonryForceReassign = false;
      applyControlMasonryLayout(shouldReassign);
    });
  }

  function initControlMasonry() {
    getOrderedControlCards().forEach((card, index) => {
      if (!card.dataset.controlOrder) {
        card.dataset.controlOrder = String(index);
      }
    });
    ensureControlColumns();
    scheduleControlMasonryLayout(true);
  }

  function getSelectedCalibrationMode() {
    return state.selectedCalibrationMode === "conversation"
      ? "conversation"
      : "audio";
  }

  function syncCalibrationModePicker() {
    if (!els.calibrationModeSelect) {
      return;
    }
    const mode = getSelectedCalibrationMode();
    if (els.calibrationModeSelect.value !== mode) {
      els.calibrationModeSelect.value = mode;
    }
    const config = selectPickerConfigs.find(
      (item) => item.select === els.calibrationModeSelect
    );
    if (config) {
      syncSelectPicker(config);
    }
  }

  function syncCalibrationModeAvailability(forceDisabled) {
    if (!els.calibrationModeSelect) {
      return;
    }
    els.calibrationModeSelect.disabled =
      Boolean(forceDisabled) ||
      state.audioCalibrationRunning ||
      state.conversationInterceptCalibrationRunning ||
      state.audioTailPaddingSaving ||
      state.pollIntervalSaving ||
      state.conversationInterceptManualOffsetSaving;
    syncCalibrationModePicker();
  }

  function resetCalibrationMetricRefs() {
    els.pollIntervalValue = null;
    els.pollIntervalNote = null;
    els.conversationVisibleValue = null;
    els.nativePlaybackStartValue = null;
    els.interceptLeadValue = null;
    els.conversationInterceptOffsetSlider = null;
    els.conversationInterceptOffsetValue = null;
    els.conversationInterceptOffsetNote = null;
    els.audioTailPaddingValue = null;
    els.audioTailPaddingNote = null;
    els.audioCalibrationPlaybackDetectValue = null;
    els.audioCalibrationStopSettleValue = null;
    els.audioCalibrationStatusProbeValue = null;
  }

  function setPickerOpen(root, open) {
    if (!root) {
      return;
    }
    const panel = root.querySelector(".picker-panel");
    const toggle = root.querySelector("[aria-controls]");
    root.dataset.pickerOpen = open ? "true" : "false";
    if (panel) {
      panel.hidden = !open;
    }
    if (toggle) {
      toggle.setAttribute("aria-expanded", String(open));
    }
    if (!open && activePickerRoot === root) {
      activePickerRoot = null;
    } else if (open) {
      activePickerRoot = root;
    }
  }

  function closeAllPickers(exceptRoot) {
    selectPickerConfigs.forEach((config) => {
      if (config.root && config.root !== exceptRoot) {
        setPickerOpen(config.root, false);
      }
    });
    if (
      els.openclawRouteTargetPicker &&
      els.openclawRouteTargetPicker !== exceptRoot
    ) {
      setPickerOpen(els.openclawRouteTargetPicker, false);
    }
  }

  function createPickerOption(label, note, active, onSelect) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = `picker-option${active ? " is-active" : ""}`;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(active));
    option.innerHTML = note
      ? `<span class="picker-option-label">${escapeHtml(label)}</span><span class="picker-option-note">${escapeHtml(note)}</span>`
      : `<span class="picker-option-label">${escapeHtml(label)}</span>`;
    option.addEventListener("click", onSelect);
    return option;
  }

  function createPickerEmpty(text) {
    const empty = document.createElement("div");
    empty.className = "picker-empty";
    empty.textContent = text;
    return empty;
  }

  function syncSelectPicker(config) {
    if (
      !config ||
      !config.select ||
      !config.root ||
      !config.trigger ||
      !config.text ||
      !config.panel
    ) {
      return;
    }

    const options = Array.from(config.select.options || []);
    const selected =
      options.find((option) => option.selected) || options[0] || null;
    config.text.textContent =
      (selected && String(selected.textContent || "").trim()) || config.emptyText;
    config.trigger.disabled = config.select.disabled;
    config.panel.replaceChildren();

    if (!options.length) {
      config.panel.appendChild(createPickerEmpty(config.emptyText));
    } else {
      options.forEach((option) => {
        const label = String(option.textContent || "").trim() || config.emptyText;
        config.panel.appendChild(
          createPickerOption(
            label,
            "",
            Boolean(selected && option.value === selected.value),
            () => {
              if (config.select.disabled) {
                return;
              }
              if (config.select.value !== option.value) {
                config.select.value = option.value;
                config.select.dispatchEvent(new Event("change", { bubbles: true }));
              }
              syncSelectPicker(config);
              setPickerOpen(config.root, false);
              config.trigger.focus();
            }
          )
        );
      });
    }

    if (config.trigger.disabled) {
      setPickerOpen(config.root, false);
    }
  }

  function getOpenclawRouteTargetSuggestions() {
    const currentChannel = state.openclawRouteChannels.find(
      (item) => item.id === state.openclawRouteChannel
    );
    return currentChannel ? currentChannel.targets : [];
  }

  function syncRouteTargetPicker() {
    if (
      !els.openclawRouteTargetPicker ||
      !els.openclawRouteTargetInput ||
      !els.openclawRouteTargetPickerToggle ||
      !els.openclawRouteTargetPickerPanel
    ) {
      return;
    }

    const suggestions = getOpenclawRouteTargetSuggestions();
    const currentValue = String(els.openclawRouteTargetInput.value || "").trim();
    els.openclawRouteTargetPickerPanel.replaceChildren();
    els.openclawRouteTargetPickerToggle.disabled =
      els.openclawRouteTargetInput.disabled;

    if (!suggestions.length) {
      els.openclawRouteTargetPickerPanel.appendChild(
        createPickerEmpty("当前渠道暂无候选目标，可直接手动填写。")
      );
    } else {
      suggestions.forEach((target) => {
        els.openclawRouteTargetPickerPanel.appendChild(
          createPickerOption(target, "", currentValue === target, () => {
            if (!els.openclawRouteTargetInput || els.openclawRouteTargetInput.disabled) {
              return;
            }
            els.openclawRouteTargetInput.value = target;
            els.openclawRouteTargetInput.dispatchEvent(
              new Event("input", { bubbles: true })
            );
            syncRouteTargetPicker();
            setPickerOpen(els.openclawRouteTargetPicker, false);
            els.openclawRouteTargetInput.focus();
          })
        );
      });
    }

    if (els.openclawRouteTargetPickerToggle.disabled) {
      setPickerOpen(els.openclawRouteTargetPicker, false);
    }
  }

  function syncCustomPickers() {
    selectPickerConfigs.forEach((config) => {
      syncSelectPicker(config);
    });
    syncRouteTargetPicker();
  }

  function bindSelectPicker(config) {
    if (!config || !config.root || !config.trigger || !config.select) {
      return;
    }

    const togglePicker = () => {
      if (config.trigger.disabled) {
        return;
      }
      const nextOpen = config.root.dataset.pickerOpen !== "true";
      closeAllPickers(nextOpen ? config.root : null);
      setPickerOpen(config.root, nextOpen);
    };

    config.trigger.addEventListener("click", () => {
      togglePicker();
    });
    config.trigger.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setPickerOpen(config.root, false);
        return;
      }
      if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
        event.preventDefault();
        togglePicker();
      }
    });
    config.select.addEventListener("change", () => {
      syncSelectPicker(config);
    });
  }

  function initCustomPickers() {
    selectPickerConfigs.forEach((config) => {
      bindSelectPicker(config);
    });

    if (els.openclawRouteTargetPicker && els.openclawRouteTargetPickerToggle) {
      els.openclawRouteTargetPickerToggle.addEventListener("click", () => {
        const nextOpen =
          els.openclawRouteTargetPicker.dataset.pickerOpen !== "true";
        closeAllPickers(nextOpen ? els.openclawRouteTargetPicker : null);
        setPickerOpen(els.openclawRouteTargetPicker, nextOpen);
      });
    }

    if (els.openclawRouteTargetInput && els.openclawRouteTargetPicker) {
      els.openclawRouteTargetInput.addEventListener("focus", () => {
        if (!getOpenclawRouteTargetSuggestions().length) {
          return;
        }
        closeAllPickers(els.openclawRouteTargetPicker);
        setPickerOpen(els.openclawRouteTargetPicker, true);
      });
      els.openclawRouteTargetInput.addEventListener("input", () => {
        syncRouteTargetPicker();
      });
      els.openclawRouteTargetInput.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          setPickerOpen(els.openclawRouteTargetPicker, false);
          return;
        }
        if (event.key === "ArrowDown" && getOpenclawRouteTargetSuggestions().length) {
          event.preventDefault();
          closeAllPickers(els.openclawRouteTargetPicker);
          setPickerOpen(els.openclawRouteTargetPicker, true);
        }
      });
    }

    document.addEventListener("click", (event) => {
      const target = event.target;
      if (
        activePickerRoot &&
        target instanceof Node &&
        !activePickerRoot.contains(target)
      ) {
        closeAllPickers();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeAllPickers();
      }
    });
    syncCustomPickers();
  }

  function showToast(message, tone) {
    if (!els.toast) {
      return;
    }
    els.toast.textContent = message;
    els.toast.dataset.tone =
      tone === "error" ? "error" : tone === "warn" ? "warn" : "success";
    els.toast.classList.add("show");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => {
      els.toast.classList.remove("show");
    }, 2600);
  }

  function normalizeAudioEventUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) {
      return "";
    }
    try {
      const url = new URL(raw, window.location.href);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return "";
      }
      return url.toString();
    } catch (_) {
      return "";
    }
  }

  function formatAudioTime(value) {
    const totalSeconds = Math.max(0, Math.floor(Number(value) || 0));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  function buildEventRenderSignature(items) {
    if (!Array.isArray(items) || items.length === 0) {
      return "__empty__";
    }
    return items
      .map((item, index) =>
        [
          index,
          item && item.id ? item.id : "",
          item && item.time ? item.time : "",
          item && item.kind ? item.kind : "",
          item && item.level ? item.level : "",
          item && item.title ? item.title : "",
          item && item.detail ? item.detail : "",
          normalizeAudioEventUrl(item && item.audioUrl),
        ].join("\u001f")
      )
      .join("\u001e");
  }

  function isEventAudioPreviewPlaying() {
    if (!els.eventList) {
      return false;
    }
    return Array.from(
      els.eventList.querySelectorAll('[data-audio-player-root="event"]')
    ).some((root) => {
      const parts = readAudioPlayerParts(root);
      return Boolean(parts && !parts.audio.paused && !parts.audio.ended);
    });
  }

  function flushPendingEventRender() {
    if (!els.eventList || state.activeTab !== "events" || !state.eventItemsLoaded) {
      return;
    }
    if (isEventAudioPreviewPlaying()) {
      return;
    }
    const nextSignature = buildEventRenderSignature(state.eventItems);
    if (nextSignature === state.eventRenderSignature) {
      return;
    }
    renderEvents(state.eventItems, { signature: nextSignature });
  }

  function readSpeakerAudioParts() {
    if (
      !els.speakerAudioShell ||
      !els.speakerAudioProgress ||
      !els.speakerAudioProgressFill ||
      !els.speakerAudioTime
    ) {
      return null;
    }
    return {
      shell: els.speakerAudioShell,
      progress: els.speakerAudioProgress,
      progressFill: els.speakerAudioProgressFill,
      time: els.speakerAudioTime,
    };
  }

  function getCurrentAudioTitle() {
    const raw =
      els.browserAudioTitle && els.browserAudioTitle.textContent
        ? els.browserAudioTitle.textContent.trim()
        : "";
    return normalizeAudioReplyTitle(raw) || "音频回复";
  }

  function normalizeAudioReplyTitle(value) {
    let normalized = String(value || "").trim();
    while (normalized) {
      const next = normalized.replace(/^\s*音频回复[:：]\s*/u, "").trim();
      if (next === normalized) {
        break;
      }
      normalized = next;
    }
    return (
      normalized || ""
    );
  }

  function getSpeakerAudioPlayback() {
    return state.bootstrap && state.bootstrap.audioPlayback
      ? state.bootstrap.audioPlayback
      : null;
  }

  function getRawSpeakerAudioPlayback() {
    return state.rawSpeakerAudioPlayback ? state.rawSpeakerAudioPlayback : null;
  }

  function canResumeSpeakerPlayback(playback) {
    const rawPlayback = getRawSpeakerAudioPlayback();
    return Boolean(
      playback &&
        playback.status === "paused" &&
        rawPlayback &&
        rawPlayback.status === "paused"
    );
  }

  function clearSpeakerPauseMemory() {
    state.speakerPauseMemory = null;
  }

  function getSpeakerPauseMemory() {
    const memory = state.speakerPauseMemory;
    if (!memory) {
      return null;
    }
    if (Date.now() >= (Number(memory.expiresAtMs) || 0)) {
      clearSpeakerPauseMemory();
      return null;
    }
    return {
      ...memory,
    };
  }

  function rememberSpeakerPausePlayback(playback, deviceId) {
    if (!playback) {
      return null;
    }
    const normalizedUrl = normalizeAudioEventUrl(playback.audioUrl);
    const normalizedTitle = normalizeAudioReplyTitle(playback.title) || "最近一次音频";
    const next = {
      deviceId: String(deviceId || ""),
      title: normalizedTitle,
      audioUrl: normalizedUrl || "",
      status: "paused",
      positionSeconds: Math.max(0, Number(playback.positionSeconds) || 0),
      durationSeconds: Math.max(0, Number(playback.durationSeconds) || 0),
      expiresAtMs: Date.now() + SPEAKER_PAUSE_MEMORY_TTL_MS,
    };
    state.speakerPauseMemory = next;
    return {
      ...next,
    };
  }

  function resolveSpeakerPlayback(playback, device) {
    const currentDeviceId =
      device && typeof device.minaDeviceId === "string"
        ? device.minaDeviceId.trim()
        : "";
    const remembered = getSpeakerPauseMemory();
    const normalizedPlaybackUrl = normalizeAudioEventUrl(playback && playback.audioUrl);

    if (
      remembered &&
      currentDeviceId &&
      remembered.deviceId &&
      remembered.deviceId !== currentDeviceId
    ) {
      clearSpeakerPauseMemory();
      return playback;
    }

    if (playback && playback.status === "playing") {
      clearSpeakerPauseMemory();
      return playback;
    }

    if (playback && playback.status === "paused") {
      rememberSpeakerPausePlayback(playback, currentDeviceId);
      return playback;
    }

    if (
      remembered &&
      normalizedPlaybackUrl &&
      remembered.audioUrl &&
      remembered.audioUrl !== normalizedPlaybackUrl
    ) {
      clearSpeakerPauseMemory();
      return playback;
    }

    if (
      remembered &&
      (!playback || playback.status === "idle")
    ) {
      return {
        ...(playback || {}),
        ...remembered,
        status: "paused",
        title:
          normalizeAudioReplyTitle(remembered.title || (playback && playback.title)) ||
          "最近一次音频",
        audioUrl: remembered.audioUrl || normalizedPlaybackUrl,
        positionSeconds: Math.max(
          0,
          Number(remembered.positionSeconds) ||
            Number(playback && playback.positionSeconds) ||
            0
        ),
        durationSeconds: Math.max(
          0,
          Number(remembered.durationSeconds) ||
            Number(playback && playback.durationSeconds) ||
            0
        ),
      };
    }

    return playback;
  }

  function getSpeakerStartLabel(playback) {
    return playback && playback.status === "playing" ? "暂停" : "播放";
  }

  function getBrowserStartLabel() {
    return els.browserAudioPlayer && !els.browserAudioPlayer.paused
      ? "暂停"
      : "播放";
  }

  function setCurrentAudioMeta(options) {
    const source = options && options.source ? options.source : "idle";
    const title =
      options && typeof options.title === "string" && options.title.trim()
        ? options.title.trim()
        : "暂未播放音频";
    const statusText =
      options && typeof options.statusText === "string" && options.statusText.trim()
        ? options.statusText.trim()
        : "输入 URL 后可直接让音箱播放；如果失败，控制台会直接提示错误。";
    state.currentAudioSource = source;
    if (source !== "speaker") {
      stopSpeakerProgressTimer();
    }

    if (els.browserAudioTitle) {
      els.browserAudioTitle.textContent = title;
    }
    if (els.browserAudioStatus) {
      els.browserAudioStatus.textContent = statusText;
    }
    if (els.browserAudioPlayerShell) {
      els.browserAudioPlayerShell.hidden = source !== "browser";
    }
    if (els.speakerAudioShell) {
      els.speakerAudioShell.hidden = source !== "speaker";
    }
    if (els.currentAudioStartBtn) {
      const canStart =
        Boolean(options && options.canStart) && !state.currentAudioStartBusy;
      const showStart =
        source !== "idle" &&
        (state.currentAudioStartBusy ||
          (!state.currentAudioPauseBusy && canStart));
      els.currentAudioStartBtn.disabled = !canStart;
      els.currentAudioStartBtn.hidden = !showStart;
      els.currentAudioStartBtn.textContent = state.currentAudioStartBusy
        ? "播放中"
        : options && typeof options.startLabel === "string" && options.startLabel.trim()
          ? options.startLabel.trim()
          : "播放";
    }
    if (els.currentAudioPauseBtn) {
      const canPause =
        Boolean(options && options.canPause) && !state.currentAudioPauseBusy;
      const showPause =
        source !== "idle" &&
        (state.currentAudioPauseBusy ||
          (!state.currentAudioStartBusy && canPause));
      els.currentAudioPauseBtn.disabled = !canPause;
      els.currentAudioPauseBtn.hidden = !showPause;
      els.currentAudioPauseBtn.textContent = state.currentAudioPauseBusy
        ? "暂停中"
        : "暂停";
    }
    if (els.currentAudioStopBtn) {
      const canStop =
        source !== "idle" &&
        !state.currentAudioStartBusy &&
        !state.currentAudioPauseBusy &&
        !state.currentAudioStopBusy;
      els.currentAudioStopBtn.hidden = source === "idle";
      els.currentAudioStopBtn.disabled = !canStop;
      els.currentAudioStopBtn.textContent = state.currentAudioStopBusy
        ? "停止中"
        : "停止";
    }
  }

  function syncSpeakerAudioUi(positionSeconds, durationSeconds, status) {
    const parts = readSpeakerAudioParts();
    if (!parts) {
      return;
    }
    const duration =
      Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0;
    const current = clamp(
      Number(positionSeconds) || 0,
      0,
      duration || Math.max(Number(positionSeconds) || 0, 0)
    );
    const percent = duration > 0 ? (current / duration) * 100 : 0;
    parts.progress.dataset.enabled = duration > 0 ? "true" : "false";
    parts.progressFill.style.width = `${clamp(percent, 0, 100)}%`;
    parts.time.textContent = `${formatAudioTime(current)} / ${
      duration > 0 ? formatAudioTime(duration) : "--:--"
    }`;
    parts.shell.dataset.audioState = status || "idle";
  }

  function stopSpeakerProgressTimer() {
    if (state.speakerProgressTimer) {
      window.clearTimeout(state.speakerProgressTimer);
      state.speakerProgressTimer = null;
    }
  }

  function getProjectedSpeakerPositionSeconds() {
    const base = Math.max(0, Number(state.speakerProgressBasePositionSeconds) || 0);
    const duration =
      Number.isFinite(state.speakerProgressDurationSeconds) &&
      state.speakerProgressDurationSeconds > 0
        ? state.speakerProgressDurationSeconds
        : 0;
    const elapsedSeconds = Math.max(
      0,
      Math.floor((Date.now() - state.speakerProgressBaseAtMs) / 1000)
    );
    const projected = base + elapsedSeconds;
    return duration > 0 ? Math.min(duration, projected) : projected;
  }

  function tickSpeakerProgressUi() {
    const playback = getSpeakerAudioPlayback();
    if (
      !playback ||
      state.currentAudioSource !== "speaker" ||
      playback.status !== "playing"
    ) {
      stopSpeakerProgressTimer();
      return;
    }

    const duration =
      Number.isFinite(state.speakerProgressDurationSeconds) &&
      state.speakerProgressDurationSeconds > 0
        ? state.speakerProgressDurationSeconds
        : 0;
    const nextPosition = getProjectedSpeakerPositionSeconds();
    syncSpeakerAudioUi(nextPosition, duration, "playing");
    if (state.bootstrap && state.bootstrap.audioPlayback) {
      state.bootstrap.audioPlayback = {
        ...state.bootstrap.audioPlayback,
        positionSeconds: nextPosition,
      };
    }

    if (duration > 0 && nextPosition >= duration) {
      stopSpeakerProgressTimer();
      return;
    }
  }

  function syncSpeakerProgressRuntime(playback) {
    stopSpeakerProgressTimer();
    if (
      !playback ||
      state.currentAudioSource !== "speaker" ||
      playback.status !== "playing"
    ) {
      state.speakerProgressBaseAtMs = 0;
      state.speakerProgressBasePositionSeconds = Math.max(
        0,
        Number(playback && playback.positionSeconds) || 0
      );
      state.speakerProgressDurationSeconds =
        Number.isFinite(playback && playback.durationSeconds) &&
        Number(playback.durationSeconds) > 0
          ? Number(playback.durationSeconds)
          : 0;
      return;
    }

    state.speakerProgressBaseAtMs = Date.now();
    state.speakerProgressBasePositionSeconds = Math.max(
      0,
      Number(playback.positionSeconds) || 0
    );
    state.speakerProgressDurationSeconds =
      Number.isFinite(playback.durationSeconds) && Number(playback.durationSeconds) > 0
        ? Number(playback.durationSeconds)
        : 0;
    tickSpeakerProgressUi();
    state.speakerProgressTimer = window.setInterval(() => {
      tickSpeakerProgressUi();
    }, 1000);
  }

  function renderIdleCurrentAudio() {
    syncSpeakerProgressRuntime(null);
    syncSpeakerAudioUi(0, 0, "idle");
    setCurrentAudioMeta({
      source: "idle",
      title: "暂未播放音频",
      statusText:
        "输入 URL 后可直接让音箱播放；如果失败，控制台会直接提示错误。",
      canStart: false,
      startLabel: "播放",
      canPause: false,
    });
  }

  function renderSpeakerCurrentAudio(playback) {
    const title =
      playback && typeof playback.title === "string" && playback.title.trim()
        ? normalizeAudioReplyTitle(playback.title) || playback.title.trim()
        : "最近一次音频";
    const status = playback && playback.status ? playback.status : "idle";
    const resumablePause = canResumeSpeakerPlayback(playback);
    const statusText =
      status === "playing"
        ? "音箱正在播放这段音频。"
        : status === "paused"
          ? resumablePause
            ? "音箱当前已暂停在这里。"
            : "这段音频的暂停状态已经过期，再点播放会从头开始。"
          : "音箱当前没有继续播放这段音频。";
    syncSpeakerAudioUi(
      playback && playback.positionSeconds,
      playback && playback.durationSeconds,
      status
    );
    setCurrentAudioMeta({
      source: "speaker",
      title,
      statusText,
      canStart: Boolean(playback && normalizeAudioEventUrl(playback.audioUrl)),
      startLabel: getSpeakerStartLabel(playback),
      canPause: status === "playing",
    });
    syncSpeakerProgressRuntime(playback);
  }

  function syncBrowserCurrentAudioMeta() {
    if (!els.browserAudioPlayer || state.currentAudioSource !== "browser") {
      return;
    }
    const hasSrc = Boolean(els.browserAudioPlayer.getAttribute("src"));
    if (!hasSrc) {
      renderIdleCurrentAudio();
      return;
    }
    if (
      els.browserAudioPlayerShell &&
      els.browserAudioPlayerShell.dataset.audioUnavailable === "true"
    ) {
      setCurrentAudioMeta({
      source: "browser",
      title: getCurrentAudioTitle(),
      statusText: "这段音频现在已经不可用了，可能已过期或被清理。",
      canStart: false,
      startLabel: "播放",
      canPause: false,
    });
      return;
    }
    const ended =
      Number.isFinite(els.browserAudioPlayer.duration) &&
      els.browserAudioPlayer.duration > 0 &&
      els.browserAudioPlayer.currentTime >=
        Math.max(0, els.browserAudioPlayer.duration - 0.25);
    setCurrentAudioMeta({
      source: "browser",
      title: getCurrentAudioTitle(),
      statusText: ended
        ? "浏览器预览已经播完了。"
        : els.browserAudioPlayer.paused
          ? "浏览器预览已暂停。"
          : "浏览器正在播放这段音频。",
      canStart: hasSrc,
      startLabel: getBrowserStartLabel(),
      canPause: !els.browserAudioPlayer.paused && !ended,
    });
  }

  function describeAudioPlayError(error, audio) {
    const name =
      error && typeof error.name === "string" ? error.name.trim() : "";
    const message =
      error && typeof error.message === "string" ? error.message.trim() : "";
    if (name === "NotAllowedError") {
      return "浏览器拦住了自动播放，可以点播放继续。";
    }
    if (
      (audio && audio.error) ||
      name === "NotSupportedError" ||
      /media|source|network|decode|supported|404|403/i.test(message)
    ) {
      return "这段音频现在已经不可用了，可能已过期或被清理。";
    }
    return "音频暂时无法播放，可能链接已失效或已被清理。";
  }

  function markAudioPlayerUnavailable(root) {
    const parts = readAudioPlayerParts(root);
    if (!parts) {
      return;
    }
    root.dataset.audioUnavailable = "true";
    parts.progress.dataset.enabled = "false";
    parts.progressFill.style.width = "0%";
    parts.time.textContent = "资源不可用";
    parts.toggle.textContent = "失效";
    root.dataset.audioState = "error";
  }

  function readAudioPlayerParts(root) {
    if (!root) {
      return null;
    }
    const audio = root.querySelector("audio");
    const toggle = root.querySelector("[data-audio-toggle]");
    const progress = root.querySelector("[data-audio-progress]");
    const progressFill = root.querySelector("[data-audio-progress-fill]");
    const time = root.querySelector("[data-audio-time]");
    if (!audio || !toggle || !progress || !progressFill || !time) {
      return null;
    }
    return {
      audio,
      toggle,
      progress,
      progressFill,
      time,
    };
  }

  function pauseManagedAudioPlayers(exceptAudio) {
    document.querySelectorAll(".audio-player-media").forEach((node) => {
      if (node !== exceptAudio) {
        try {
          node.pause();
        } catch (_) {}
      }
    });
  }

  function syncAudioPlayerUi(root) {
    const parts = readAudioPlayerParts(root);
    if (!parts) {
      return;
    }

    if (root.dataset.audioUnavailable === "true") {
      markAudioPlayerUnavailable(root);
      return;
    }

    const duration =
      Number.isFinite(parts.audio.duration) && parts.audio.duration > 0
        ? parts.audio.duration
        : 0;
    const current = clamp(
      Number(parts.audio.currentTime) || 0,
      0,
      duration || Math.max(Number(parts.audio.currentTime) || 0, 0)
    );
    const ended = duration > 0 && current >= Math.max(0, duration - 0.25);
    const progressPercent = duration > 0 ? (current / duration) * 100 : 0;

    parts.progress.dataset.enabled = duration > 0 ? "true" : "false";
    parts.progressFill.style.width = `${clamp(progressPercent, 0, 100)}%`;
    parts.time.textContent = `${formatAudioTime(current)} / ${
      duration > 0 ? formatAudioTime(duration) : "--:--"
    }`;

    if (!parts.audio.getAttribute("src")) {
      parts.toggle.textContent = "播放";
      root.dataset.audioState = "idle";
      return;
    }

    if (!parts.audio.paused) {
      parts.toggle.textContent = "暂停";
      root.dataset.audioState = "playing";
      return;
    }

    parts.toggle.textContent = ended ? "重播" : current > 0 ? "继续" : "播放";
    root.dataset.audioState = ended ? "ended" : current > 0 ? "paused" : "idle";
  }

  function bindAudioPlayer(root) {
    const parts = readAudioPlayerParts(root);
    if (!parts || root.dataset.audioPlayerBound === "true") {
      return;
    }

    root.dataset.audioPlayerBound = "true";

    parts.toggle.addEventListener("click", async () => {
      if (!parts.audio.getAttribute("src")) {
        return;
      }
      if (!parts.audio.paused) {
        parts.audio.pause();
        syncAudioPlayerUi(root);
        return;
      }
      if (
        Number.isFinite(parts.audio.duration) &&
        parts.audio.duration > 0 &&
        parts.audio.currentTime >= Math.max(0, parts.audio.duration - 0.25)
      ) {
        parts.audio.currentTime = 0;
      }
      pauseManagedAudioPlayers(parts.audio);
      try {
        await parts.audio.play();
      } catch (error) {
        const message = describeAudioPlayError(error, parts.audio);
        showToast(message, "error");
        if (!(error && error.name === "NotAllowedError")) {
          markAudioPlayerUnavailable(root);
          if (root === els.browserAudioPlayerShell) {
            setCurrentAudioMeta({
              source: "browser",
              title: getCurrentAudioTitle(),
              statusText: "这段音频现在已经不可用了，可能已过期或被清理。",
              canStart: false,
              startLabel: getBrowserStartLabel(),
              canPause: false,
            });
          }
          return;
        }
      }
      syncAudioPlayerUi(root);
      if (root === els.browserAudioPlayerShell) {
        syncBrowserCurrentAudioMeta();
      }
    });

    [
      "loadedmetadata",
      "durationchange",
      "timeupdate",
      "play",
      "pause",
      "ended",
      "emptied",
    ].forEach((eventName) => {
      parts.audio.addEventListener(eventName, () => {
        syncAudioPlayerUi(root);
        if (root === els.browserAudioPlayerShell) {
          syncBrowserCurrentAudioMeta();
        }
        if (
          root.dataset.audioPlayerRoot === "event" &&
          (eventName === "pause" || eventName === "ended" || eventName === "emptied")
        ) {
          window.requestAnimationFrame(() => {
            flushPendingEventRender();
          });
        }
      });
    });

    parts.audio.addEventListener("error", () => {
      markAudioPlayerUnavailable(root);
      if (root === els.browserAudioPlayerShell) {
        setCurrentAudioMeta({
          source: "browser",
          title: getCurrentAudioTitle(),
          statusText: "这段音频现在已经不可用了，可能已过期或被清理。",
          canStart: false,
          startLabel: getBrowserStartLabel(),
          canPause: false,
        });
      }
      if (root.dataset.audioPlayerRoot === "event") {
        window.requestAnimationFrame(() => {
          flushPendingEventRender();
        });
      }
    });

    syncAudioPlayerUi(root);
  }

  function hydrateAudioPlayers(scope) {
    (scope || document)
      .querySelectorAll("[data-audio-player-root]")
      .forEach((root) => bindAudioPlayer(root));
  }

  function closeBrowserAudioDock(options) {
    if (els.browserAudioPlayer) {
      els.browserAudioPlayer.pause();
      els.browserAudioPlayer.removeAttribute("src");
      els.browserAudioPlayer.load();
    }
    if (els.browserAudioPlayerShell) {
      delete els.browserAudioPlayerShell.dataset.audioUnavailable;
    }
    state.currentBrowserAudioUrl = "";
    if (els.browserAudioPlayerShell) {
      syncAudioPlayerUi(els.browserAudioPlayerShell);
    }
    if (options && options.restoreSpeaker && state.bootstrap && state.bootstrap.audioPlayback) {
      renderSpeakerCurrentAudio(state.bootstrap.audioPlayback);
      return;
    }
    renderIdleCurrentAudio();
  }

  async function playBrowserAudio(url, title, options) {
    const playableUrl = normalizeAudioEventUrl(url);
    if (!playableUrl || !els.browserAudioPlayer || !els.browserAudioPlayerShell) {
      return false;
    }
    const nextTitle = normalizeAudioReplyTitle(title) || "音频回复";
    setCurrentAudioMeta({
      source: "browser",
      title: nextTitle,
      statusText:
        options && options.autoplay === false
          ? "浏览器已经接到这段音频，点播放即可开始。"
          : "浏览器正在准备播放这段音频。",
      canStart: true,
      startLabel: "播放",
      canPause: false,
    });
    if (state.currentBrowserAudioUrl !== playableUrl) {
      els.browserAudioPlayer.src = playableUrl;
      els.browserAudioPlayer.load();
      state.currentBrowserAudioUrl = playableUrl;
    }
    delete els.browserAudioPlayerShell.dataset.audioUnavailable;
    els.browserAudioPlayer.currentTime = 0;
    hydrateAudioPlayers(document);
    syncAudioPlayerUi(els.browserAudioPlayerShell);
    if (options && options.autoplay === false) {
      return true;
    }
    try {
      pauseManagedAudioPlayers(els.browserAudioPlayer);
      await els.browserAudioPlayer.play();
      syncAudioPlayerUi(els.browserAudioPlayerShell);
      syncBrowserCurrentAudioMeta();
      return true;
    } catch (error) {
      showToast(describeAudioPlayError(error, els.browserAudioPlayer), "error");
      syncAudioPlayerUi(els.browserAudioPlayerShell);
      syncBrowserCurrentAudioMeta();
      return false;
    }
  }

  function shouldAutoPreviewEventAudio(item) {
    if (!item) {
      return false;
    }
    const title = String(item.title || "").trim();
    const detail = String(item.detail || "").trim();
    const kind = String(item.kind || "").trim();
    return [title, detail, kind].some((value) => value.includes("浏览器兜底"));
  }

  function maybeHandleLatestEventAudio(items) {
    const events = Array.isArray(items) ? items : [];
    const latest = events.find(
      (item) =>
        shouldAutoPreviewEventAudio(item) &&
        normalizeAudioEventUrl(item && item.audioUrl)
    );
    if (!latest) {
      state.browserAudioReady = true;
      return;
    }
    if (!state.browserAudioReady) {
      state.browserAudioReady = true;
      state.latestAudioEventId = String(latest.id || "");
      return;
    }
    const latestId = String(latest.id || "");
    if (!latestId || latestId === state.latestAudioEventId) {
      return;
    }
    state.latestAudioEventId = latestId;
    if (
      normalizeAudioEventUrl(latest.audioUrl) &&
      normalizeAudioEventUrl(latest.audioUrl) === state.currentBrowserAudioUrl
    ) {
      return;
    }
    void playBrowserAudio(
      latest.audioUrl,
      normalizeAudioReplyTitle(latest.detail || latest.title) || "音频回复"
    );
  }

  async function pauseCurrentAudio() {
    if (state.currentAudioPauseBusy || !els.currentAudioPauseBtn) {
      return;
    }

    if (state.currentAudioSource === "browser") {
      if (els.browserAudioPlayer) {
        els.browserAudioPlayer.pause();
        syncAudioPlayerUi(els.browserAudioPlayerShell);
        syncBrowserCurrentAudioMeta();
      }
      return;
    }

    if (state.currentAudioSource !== "speaker") {
      return;
    }

    const playbackBeforePause = getSpeakerAudioPlayback();
    const pausedPlayback = playbackBeforePause
      ? {
          ...playbackBeforePause,
          status: "paused",
        }
      : null;

    state.currentAudioPauseBusy = true;
    setCurrentAudioMeta({
      source: "speaker",
      title: getCurrentAudioTitle(),
      statusText: "正在向音箱发送暂停指令…",
      canStart: false,
      startLabel: "播放",
      canPause: false,
    });

    try {
      const payload = await postJson(API.audioPause, {});
      const rememberedPlayback = rememberSpeakerPausePlayback(
        pausedPlayback || (state.bootstrap && state.bootstrap.audioPlayback),
        state.bootstrap && state.bootstrap.device
          ? state.bootstrap.device.minaDeviceId
          : ""
      );
      state.rawSpeakerAudioPlayback = pausedPlayback
        ? {
            ...pausedPlayback,
            status: "paused",
          }
        : rememberedPlayback
          ? {
              ...rememberedPlayback,
              status: "paused",
            }
          : getRawSpeakerAudioPlayback();
      if (state.bootstrap && rememberedPlayback) {
        state.bootstrap.audioPlayback = rememberedPlayback;
        renderSpeakerCurrentAudio(rememberedPlayback);
      }
      showToast(payload.message || "已发送暂停指令。", "success");
      await refreshBootstrap(true);
    } catch (error) {
      clearSpeakerPauseMemory();
      showToast(error.message || String(error), "error");
      if (state.bootstrap && state.bootstrap.audioPlayback) {
        renderSpeakerCurrentAudio(state.bootstrap.audioPlayback);
      } else {
        renderIdleCurrentAudio();
      }
    } finally {
      state.currentAudioPauseBusy = false;
      if (state.currentAudioSource === "speaker") {
        if (state.bootstrap && state.bootstrap.audioPlayback) {
          renderSpeakerCurrentAudio(state.bootstrap.audioPlayback);
        } else {
          renderIdleCurrentAudio();
        }
      } else {
        syncBrowserCurrentAudioMeta();
      }
    }
  }

  async function startCurrentAudio() {
    if (state.currentAudioStartBusy || !els.currentAudioStartBtn) {
      return;
    }

    if (state.currentAudioSource === "browser") {
      if (!els.browserAudioPlayer || !els.browserAudioPlayer.getAttribute("src")) {
        return;
      }
      state.currentAudioStartBusy = true;
      setCurrentAudioMeta({
        source: "browser",
        title: getCurrentAudioTitle(),
        statusText: "正在开始浏览器预览…",
        canStart: false,
        startLabel: getBrowserStartLabel(),
        canPause: false,
      });
      try {
        if (
          Number.isFinite(els.browserAudioPlayer.duration) &&
          els.browserAudioPlayer.duration > 0 &&
          els.browserAudioPlayer.currentTime >=
            Math.max(0, els.browserAudioPlayer.duration - 0.25)
        ) {
          els.browserAudioPlayer.currentTime = 0;
        }
        pauseManagedAudioPlayers(els.browserAudioPlayer);
        await els.browserAudioPlayer.play();
      } catch (error) {
        showToast(describeAudioPlayError(error, els.browserAudioPlayer), "error");
        if (!(error && error.name === "NotAllowedError")) {
          markAudioPlayerUnavailable(els.browserAudioPlayerShell);
        }
      } finally {
        state.currentAudioStartBusy = false;
        syncAudioPlayerUi(els.browserAudioPlayerShell);
        syncBrowserCurrentAudioMeta();
      }
      return;
    }

    if (state.currentAudioSource !== "speaker") {
      return;
    }

    const playback = getSpeakerAudioPlayback();
    if (canResumeSpeakerPlayback(playback)) {
      state.currentAudioStartBusy = true;
      setCurrentAudioMeta({
        source: "speaker",
        title: getCurrentAudioTitle(),
        statusText: "正在向音箱发送播放指令…",
        canStart: false,
        startLabel: "播放",
        canPause: false,
      });
      try {
        const payload = await postJson(API.audioResume, {});
        clearSpeakerPauseMemory();
        state.rawSpeakerAudioPlayback = {
          ...(getRawSpeakerAudioPlayback() || playback || {}),
          status: "playing",
        };
        if (state.bootstrap && state.bootstrap.audioPlayback) {
          state.bootstrap.audioPlayback = {
            ...state.bootstrap.audioPlayback,
            status: "playing",
          };
          renderSpeakerCurrentAudio(state.bootstrap.audioPlayback);
        }
        showToast(payload.message || "已发送继续播放指令。", "success");
        await refreshBootstrap(true);
      } catch (error) {
        showToast(error.message || String(error), "error");
        if (getSpeakerAudioPlayback()) {
          renderSpeakerCurrentAudio(getSpeakerAudioPlayback());
        } else {
          renderIdleCurrentAudio();
        }
      } finally {
        state.currentAudioStartBusy = false;
        if (getSpeakerAudioPlayback()) {
          renderSpeakerCurrentAudio(getSpeakerAudioPlayback());
        } else {
          renderIdleCurrentAudio();
        }
      }
      return;
    }

    const audioUrl = normalizeAudioEventUrl(playback && playback.audioUrl);
    if (!audioUrl) {
      showToast("当前这段音频没有可重新播放的链接。", "error");
      return;
    }

    state.currentAudioStartBusy = true;
    setCurrentAudioMeta({
      source: "speaker",
      title: getCurrentAudioTitle(),
      statusText: "正在向音箱重新发送播放指令…",
      canStart: false,
      startLabel: getSpeakerStartLabel(playback),
      canPause: false,
    });

    try {
      const payload = await postJson(API.audioPlay, {
        url: audioUrl,
        title:
          normalizeAudioReplyTitle(playback && playback.title) || getCurrentAudioTitle(),
        interrupt: true,
        forceRetry: true,
      });
      clearSpeakerPauseMemory();
      if (payload && (payload.ok === false || payload.playback === "browser-fallback")) {
        throw new Error(payload.message || "音箱没有真正开始播放这段音频。");
      }
      const nextPlayback = {
        ...(playback || {}),
        title:
          (payload && payload.title) ||
          normalizeAudioReplyTitle(payload && payload.detail) ||
          getCurrentAudioTitle(),
        status: "playing",
        audioUrl: (payload && payload.url) || audioUrl,
        positionSeconds: 0,
      };
      state.rawSpeakerAudioPlayback = {
        ...nextPlayback,
      };
      if (state.bootstrap) {
        state.bootstrap.audioPlayback = nextPlayback;
      }
      renderSpeakerCurrentAudio(nextPlayback);
      showToast(
        (payload && payload.message) || "已开始播放。",
        payload && payload.ok === false ? "error" : "success"
      );
      await refreshBootstrap(true);
    } catch (error) {
      showToast(error.message || String(error), "error");
      if (state.currentAudioSource === "browser") {
        syncBrowserCurrentAudioMeta();
      } else if (getSpeakerAudioPlayback()) {
        renderSpeakerCurrentAudio(getSpeakerAudioPlayback());
      } else {
        renderIdleCurrentAudio();
      }
    } finally {
      state.currentAudioStartBusy = false;
      if (state.currentAudioSource === "browser") {
        syncBrowserCurrentAudioMeta();
      } else if (getSpeakerAudioPlayback()) {
        renderSpeakerCurrentAudio(getSpeakerAudioPlayback());
      } else {
        renderIdleCurrentAudio();
      }
    }
  }

  async function stopCurrentAudio() {
    if (state.currentAudioStopBusy || !els.currentAudioStopBtn) {
      return;
    }

    if (state.currentAudioSource === "browser") {
      state.currentAudioStopBusy = true;
      setCurrentAudioMeta({
        source: "browser",
        title: getCurrentAudioTitle(),
        statusText: "正在清空浏览器音频…",
        canStart: false,
        startLabel: "播放",
        canPause: false,
      });
      try {
        closeBrowserAudioDock({ restoreSpeaker: false });
        showToast("已停止浏览器音频，并清空当前播放内容。", "success");
      } finally {
        state.currentAudioStopBusy = false;
        renderIdleCurrentAudio();
      }
      return;
    }

    if (state.currentAudioSource !== "speaker") {
      return;
    }

    state.currentAudioStopBusy = true;
    setCurrentAudioMeta({
      source: "speaker",
      title: getCurrentAudioTitle(),
      statusText: "正在向音箱发送停止指令…",
      canStart: false,
      startLabel: "播放",
      canPause: false,
    });

    try {
      const payload = await postJson(API.audioStop, {});
      clearSpeakerPauseMemory();
      state.rawSpeakerAudioPlayback = null;
      if (state.bootstrap) {
        state.bootstrap.audioPlayback = null;
      }
      renderIdleCurrentAudio();
      showToast(payload.message || "已停止当前音频。", "success");
      await refreshBootstrap(true);
    } catch (error) {
      showToast(error.message || String(error), "error");
      if (getSpeakerAudioPlayback()) {
        renderSpeakerCurrentAudio(getSpeakerAudioPlayback());
      } else {
        renderIdleCurrentAudio();
      }
    } finally {
      state.currentAudioStopBusy = false;
      if (getSpeakerAudioPlayback()) {
        renderSpeakerCurrentAudio(getSpeakerAudioPlayback());
      } else {
        renderIdleCurrentAudio();
      }
    }
  }

  function setLoginWorkspaceVisibility(visible) {
    state.loginWorkspaceOpen = Boolean(visible);
    if (els.loginWorkspace) {
      els.loginWorkspace.hidden = !state.loginWorkspaceOpen;
      els.loginWorkspace.setAttribute(
        "aria-hidden",
        String(!state.loginWorkspaceOpen)
      );
    }
    document.body.classList.toggle(
      "login-workspace-open",
      state.loginWorkspaceOpen
    );
  }

  function normalizeLoginWorkspaceUrl(rawUrl) {
    if (!rawUrl) {
      return "";
    }
    try {
      const url = new URL(rawUrl, window.location.href);
      const currentUrl = new URL(window.location.href);
      if (url.origin !== currentUrl.origin) {
        url.protocol = currentUrl.protocol;
        url.host = currentUrl.host;
      }
      url.searchParams.set("embedded", "1");
      return url.toString();
    } catch (_) {
      return "";
    }
  }

  function normalizeLoginWorkspaceHint(text) {
    const next = String(text || "").trim();
    if (!next || next.length > 48 || next.includes("\n")) {
      return "完成登录后会自动回到控制台。";
    }
    return next;
  }

  function closeLoginWorkspace() {
    if (els.loginWorkspaceFrame) {
      els.loginWorkspaceFrame.src = "about:blank";
    }
    setLoginWorkspaceVisibility(false);
  }

  function createLoginWorkspaceFrameUrl(loginUrl) {
    try {
      const url = new URL(loginUrl, window.location.href);
      url.searchParams.set("_ui", String(Date.now()));
      return url.toString();
    } catch (_) {
      return loginUrl;
    }
  }

  function maskAccountLabel(rawValue) {
    const raw = String(rawValue || "").trim();
    if (!raw) {
      return "未保存账号";
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
      return `${raw.slice(0, 1)}${"*".repeat(
        Math.max(1, raw.length - 2)
      )}${raw.slice(-1)}`;
    }
    return `${raw.slice(0, 3)}${"*".repeat(Math.max(1, raw.length - 5))}${raw.slice(
      -2
    )}`;
  }

  function syncLoginWorkspaceFrameHeight(nextHeight) {
    const frameShell = els.loginWorkspaceFrameShell;
    if (!frameShell) {
      return;
    }

    let desiredHeight = Number(nextHeight) || 0;
    if (!desiredHeight && els.loginWorkspaceFrame) {
      try {
        const frameDocument = els.loginWorkspaceFrame.contentWindow?.document;
        const docEl = frameDocument?.documentElement;
        const body = frameDocument?.body;
        desiredHeight = Math.max(
          docEl ? docEl.scrollHeight : 0,
          docEl ? docEl.offsetHeight : 0,
          body ? body.scrollHeight : 0,
          body ? body.offsetHeight : 0
        );
      } catch (_) {}
    }

    const panel = frameShell.closest(".login-workspace-panel");
    const panelRect = panel ? panel.getBoundingClientRect() : null;
    const shellRect = frameShell.getBoundingClientRect();
    const compactViewport = window.innerWidth <= 720;
    const reservedHeight =
      panelRect && shellRect
        ? Math.max(0, panelRect.height - shellRect.height)
        : compactViewport
          ? 52
          : 68;
    const minHeight = compactViewport ? 220 : 280;
    const maxHeight = Math.max(
      minHeight,
      Math.floor(window.innerHeight - (compactViewport ? 20 : 28) - reservedHeight)
    );
    const fallbackHeight = compactViewport ? 276 : 360;
    const safeHeight = clamp(
      Math.ceil(desiredHeight || fallbackHeight),
      minHeight,
      maxHeight
    );
    frameShell.style.height = `${safeHeight}px`;
    frameShell.style.minHeight = `${safeHeight}px`;
  }

  function openLoginWorkspace(rawUrl, hint) {
    const loginUrl = normalizeLoginWorkspaceUrl(rawUrl);
    if (!loginUrl) {
      return false;
    }
    const frameUrl = createLoginWorkspaceFrameUrl(loginUrl);
    state.loginWorkspaceUrl = loginUrl;
    if (els.loginWorkspaceFrame) {
      els.loginWorkspaceFrame.src = frameUrl;
    }
    if (els.loginWorkspaceExternal) {
      els.loginWorkspaceExternal.href = loginUrl;
    }
    if (els.loginWorkspaceHint) {
      els.loginWorkspaceHint.textContent =
        normalizeLoginWorkspaceHint(hint);
    }
    setLoginWorkspaceVisibility(true);
    syncLoginWorkspaceFrameHeight();
    return true;
  }

  async function apiFetch(url, options) {
    let response;
    try {
      response = await fetch(url, {
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          ...(consoleAccessToken
            ? { "x-xiaoai-console-token": consoleAccessToken }
            : {}),
          ...(options && options.headers ? options.headers : {}),
        },
        ...options,
      });
    } catch (error) {
      const message =
        error && typeof error.message === "string" && error.message.trim()
          ? error.message.trim()
          : "fetch failed";
      throw new Error(`请求失败，控制台后端可能正在重启：${message}`);
    }

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch (_) {
      payload = { error: text || "Unknown response" };
    }

    if (!response.ok) {
      const fallback = text || "请求失败";
      const message =
        payload && payload.error
          ? typeof payload.error === "string"
            ? payload.error
            : payload.error.message || fallback
          : fallback;
      throw Object.assign(new Error(message), {
        payload,
        status: response.status,
      });
    }

    return payload;
  }

  function postJson(url, body) {
    return apiFetch(url, {
      method: "POST",
      body: JSON.stringify(body || {}),
    });
  }

  function normalizeTab(value) {
    return TAB_ORDER.includes(value) ? value : "overview";
  }

  function getStoredConsoleTab() {
    try {
      return normalizeTab(localStorage.getItem(CONSOLE_TAB_STORAGE_KEY) || "overview");
    } catch (_) {
      return "overview";
    }
  }

  function setActiveTab(value, persist) {
    const nextTab = normalizeTab(value);
    const previousTab = state.activeTab;
    state.activeTab = nextTab;

    if (nextTab === "events" && previousTab !== "events" && els.eventList) {
      els.eventList.dataset.renderState = "preparing";
    }

    els.tabButtons.forEach((button) => {
      const active = button.dataset.consoleTab === nextTab;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
      button.setAttribute("tabindex", active ? "0" : "-1");
    });

    els.tabPanels.forEach((panel) => {
      const active = panel.dataset.tabPanel === nextTab;
      panel.classList.toggle("is-active", active);
      panel.hidden = !active;
    });

    if (persist) {
      try {
        localStorage.setItem(CONSOLE_TAB_STORAGE_KEY, nextTab);
      } catch (_) {}
    }

    if (nextTab === "chat") {
      syncComposerMetrics();
      showComposer();
      scheduleConversationBottomStick(true);
      refreshConversations(true);
    }
    if (nextTab === "events") {
      state.animateEventsNextRender = previousTab !== "events";
      if (state.eventItemsLoaded) {
        renderEvents(state.eventItems);
      } else if (els.eventList) {
        els.eventList.innerHTML =
          '<div class="empty-state">正在读取事件流，稍后就会出现在这里。</div>';
        els.eventList.dataset.renderState = "ready";
      }
      refreshEvents(true);
    }
    if (nextTab === "overview" || nextTab === "control") {
      refreshBootstrap(true);
    }
    if (nextTab === "control") {
      refreshOpenclawModelState(true);
      window.requestAnimationFrame(() => {
        scheduleControlMasonryLayout();
      });
    }
  }

  function setBadgeTone(element, tone) {
    if (!element) {
      return;
    }
    element.dataset.tone = tone || "neutral";
  }

  function formatFullDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return String(value || "");
    }
    return date.toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }

  function formatTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return String(value || "");
    }
    return date.toLocaleTimeString("zh-CN", {
      hour12: false,
    });
  }

  function formatDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return String(value || "");
    }
    return date.toLocaleString("zh-CN", {
      hour12: false,
    });
  }

  function formatLatencyEstimate(value) {
    const safe = Number(value);
    if (!Number.isFinite(safe) || safe <= 0) {
      return "未采样";
    }
    return `${Math.round(safe)} ms`;
  }

  function normalizeConversationInterceptManualOffsetMs(value) {
    const safe = Number(value);
    if (!Number.isFinite(safe)) {
      return DEFAULT_CONVERSATION_INTERCEPT_MANUAL_OFFSET_MS;
    }
    return clamp(
      Math.round(safe / CONVERSATION_INTERCEPT_MANUAL_OFFSET_STEP_MS) *
        CONVERSATION_INTERCEPT_MANUAL_OFFSET_STEP_MS,
      MIN_CONVERSATION_INTERCEPT_MANUAL_OFFSET_MS,
      MAX_CONVERSATION_INTERCEPT_MANUAL_OFFSET_MS
    );
  }

  function formatConversationInterceptManualOffset(value) {
    const safe = normalizeConversationInterceptManualOffsetMs(value);
    if (safe === 0) {
      return "0 ms";
    }
    return `${safe > 0 ? "+" : ""}${safe} ms`;
  }

  function dateKey(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return String(value || "");
    }
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function isNearBottom(element) {
    if (!element) {
      return true;
    }
    return element.scrollHeight - element.scrollTop - element.clientHeight < 96;
  }

  function scrollConversationToBottom(force) {
    const scroller = els.conversationScroll;
    if (!scroller) {
      return;
    }
    if (!force && !isNearBottom(scroller)) {
      return;
    }
    scroller.scrollTop = scroller.scrollHeight;
  }

  function scheduleConversationBottomStick(force) {
    if (!els.conversationScroll) {
      return;
    }
    window.requestAnimationFrame(() => {
      scrollConversationToBottom(force);
      window.requestAnimationFrame(() => scrollConversationToBottom(force));
    });
    window.setTimeout(() => scrollConversationToBottom(force), 120);
  }

  function showComposer() {
    if (els.chatStage) {
      els.chatStage.classList.remove("is-composer-hidden");
    }
  }

  function hideComposer() {
    if (els.chatStage) {
      els.chatStage.classList.add("is-composer-hidden");
    }
  }

  function autoResizeComposer() {
    if (!els.composerInput) {
      return;
    }
    els.composerInput.style.height = "0px";
    const nextHeight = clamp(els.composerInput.scrollHeight, 38, 112);
    els.composerInput.style.height = `${nextHeight}px`;
    syncComposerMetrics();
  }

  function syncComposerMetrics() {
    if (!els.chatStage || !els.composerShell) {
      return;
    }
    const composerHeight = Math.max(
      88,
      Math.ceil(els.composerShell.getBoundingClientRect().height || 0)
    );
    els.chatStage.style.setProperty(
      "--chat-composer-height",
      `${composerHeight}px`
    );
  }

  function normalizeIntegerText(value, max) {
    const digits = String(value == null ? "" : value).replace(/[^\d]/g, "");
    if (!digits) {
      return "";
    }
    return String(clamp(Number(digits) || 0, 0, max));
  }

  function normalizeDecimalText(value, options) {
    const max =
      options && typeof options.max === "number" ? Math.max(0, options.max) : Infinity;
    const scale =
      options && typeof options.scale === "number"
        ? Math.max(0, Math.floor(options.scale))
        : 1;
    const raw = String(value == null ? "" : value)
      .replace(/,/g, ".")
      .replace(/[^\d.]/g, "");
    if (!raw) {
      return "";
    }
    const hasTrailingDot = raw.endsWith(".");
    const parts = raw.split(".");
    const integerPart = (parts.shift() || "").replace(/^0+(?=\d)/, "") || "0";
    const fractionPart = parts.join("").slice(0, scale);
    const normalized =
      scale > 0 && (fractionPart || hasTrailingDot)
        ? `${integerPart}.${fractionPart}`
        : integerPart;
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed)) {
      return "";
    }
    const clampedValue = clamp(parsed, 0, max);
    if (clampedValue !== parsed) {
      return scale > 0
        ? String(clampedValue.toFixed(scale))
            .replace(/\.0+$/, "")
            .replace(/(\.\d*?)0+$/, "$1")
        : String(Math.round(clampedValue));
    }
    if (scale > 0 && hasTrailingDot && !fractionPart) {
      return `${integerPart}.`;
    }
    return normalized;
  }

  function getFiniteNumber(value, fallback) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  function getBootstrapDeviceId(data) {
    return data &&
      data.device &&
      typeof data.device.minaDeviceId === "string" &&
      data.device.minaDeviceId.trim()
      ? data.device.minaDeviceId.trim()
      : "";
  }

  function normalizeCalibrationPrompt(value) {
    if (!value || typeof value !== "object") {
      return null;
    }
    const stateValue =
      value.state === "missing" || value.state === "recalibrate"
        ? value.state
        : "";
    const title =
      typeof value.title === "string" && value.title.trim() ? value.title.trim() : "";
    const detail =
      typeof value.detail === "string" && value.detail.trim()
        ? value.detail.trim()
        : "";
    if (!stateValue || !title) {
      return null;
    }
    return {
      state: stateValue,
      title,
      detail,
    };
  }

  function formatConversationCalibrationStrategy(strategy) {
    if (strategy === "observable") {
      return "可观测";
    }
    if (strategy === "mixed") {
      return "混合";
    }
    if (strategy === "fallback-only") {
      return "保守补偿";
    }
    return "";
  }

  function collectCalibrationPrompts(data) {
    const prompts = [];
    const audioPrompt = normalizeCalibrationPrompt(
      data && data.audioCalibration ? data.audioCalibration.prompt : null
    );
    const conversationPrompt = normalizeCalibrationPrompt(
      data && data.conversationInterceptCalibration
        ? data.conversationInterceptCalibration.prompt
        : null
    );
    if (audioPrompt) {
      prompts.push(audioPrompt);
    }
    if (conversationPrompt) {
      prompts.push(conversationPrompt);
    }
    return prompts;
  }

  function showCalibrationPromptToastForDevice(data) {
    const prompts = collectCalibrationPrompts(data);
    if (!prompts.length) {
      return;
    }
    showToast(
      prompts
        .map((item) => item.title)
        .filter(Boolean)
        .join("\n"),
      "warn"
    );
  }

  function formatAudioTailPaddingSeconds(value) {
    const safeMs = clamp(
      Math.round(Number(value) || 0),
      0,
      MAX_AUDIO_TAIL_PADDING_MS
    );
    return String(Number((safeMs / 1000).toFixed(1)));
  }

  function normalizeVoiceSystemPromptInput(value) {
    return String(value == null ? "" : value)
      .replace(/\r\n?/g, "\n")
      .slice(0, MAX_OPENCLAW_VOICE_SYSTEM_PROMPT_CHARS);
  }

  function normalizeTransitionPhrasesList(value) {
    const candidates = Array.isArray(value)
      ? value
      : typeof value === "string"
        ? value.replace(/\r\n?/g, "\n").split("\n")
        : [];
    const normalized = [];
    const seen = new Set();
    candidates.forEach((item) => {
      const phrase = String(item == null ? "" : item)
        .replace(/\r\n?/g, "\n")
        .trim()
        .slice(0, MAX_TRANSITION_PHRASE_CHARS);
      if (!phrase || seen.has(phrase)) {
        return;
      }
      seen.add(phrase);
      normalized.push(phrase);
    });
    return normalized.slice(0, MAX_TRANSITION_PHRASES);
  }

  function normalizeTransitionPhrasesInput(value) {
    return normalizeTransitionPhrasesList(value).join("\n");
  }

  function clearSpeakerStatePendingTimer() {
    if (state.speakerStatePendingTimer) {
      window.clearTimeout(state.speakerStatePendingTimer);
      state.speakerStatePendingTimer = null;
    }
  }

  function setSpeakerStatePending(pending) {
    state.speakerStatePending = Boolean(pending);
    if (!state.speakerStatePending) {
      clearSpeakerStatePendingTimer();
    }
  }

  function normalizeSpeakerControlCommand(command) {
    if (!command || typeof command !== "object") {
      return null;
    }
    if (command.kind === "mute") {
      return {
        kind: "mute",
        value: Boolean(command.value),
      };
    }
    if (command.kind === "volume") {
      return {
        kind: "volume",
        value: clamp(Math.round(Number(command.value) || 0), 0, 100),
      };
    }
    return null;
  }

  function sameSpeakerControlCommand(left, right) {
    return Boolean(
      left &&
        right &&
        left.kind === right.kind &&
        left.value === right.value
    );
  }

  function sanitizeVolumeMetricText(value) {
    return normalizeIntegerText(value, 100);
  }

  function sanitizeAudioTailPaddingText(value) {
    return normalizeDecimalText(value, {
      max: MAX_AUDIO_TAIL_PADDING_MS / 1000,
      scale: 1,
    });
  }

  function sanitizePollIntervalText(value) {
    return normalizeIntegerText(value, MAX_CONVERSATION_POLL_INTERVAL_MS);
  }

  function syncVolumeMetricText(value, options) {
    if (!els.statVolume) {
      return;
    }
    const text = String(value == null ? "" : value);
    const force = Boolean(options && options.force);
    if (!force && state.volumeTextEditing && document.activeElement === els.statVolume) {
      return;
    }
    if (els.statVolume.textContent !== text) {
      els.statVolume.textContent = text;
    }
  }

  function syncAudioTailPaddingMetricText(value, options) {
    if (!els.audioTailPaddingValue) {
      return;
    }
    const text = formatAudioTailPaddingSeconds(value);
    const force = Boolean(options && options.force);
    if (
      !force &&
      state.audioTailPaddingEditing &&
      document.activeElement === els.audioTailPaddingValue
    ) {
      return;
    }
    if (els.audioTailPaddingValue.textContent !== text) {
      els.audioTailPaddingValue.textContent = text;
    }
  }

  function syncPollIntervalMetricText(value, options) {
    if (!els.pollIntervalValue) {
      return;
    }
    const text = String(value == null ? "" : value);
    const force = Boolean(options && options.force);
    if (!force && state.pollIntervalEditing && document.activeElement === els.pollIntervalValue) {
      return;
    }
    if (els.pollIntervalValue.textContent !== text) {
      els.pollIntervalValue.textContent = text;
    }
  }

  function syncConversationInterceptManualOffsetDisplay(value) {
    const safe = normalizeConversationInterceptManualOffsetMs(value);
    if (els.conversationInterceptOffsetSlider) {
      els.conversationInterceptOffsetSlider.value = String(safe);
    }
    if (els.conversationInterceptOffsetValue) {
      els.conversationInterceptOffsetValue.textContent =
        formatConversationInterceptManualOffset(safe);
    }
  }

  function updateVolumeDisplay(value, options) {
    const safe = clamp(Number(value) || 0, 0, 100);
    state.currentVolumeValue = safe;
    if (els.statVolume) {
      els.statVolume.setAttribute("aria-valuenow", String(safe));
    }
    if (els.volumeSlider) {
      els.volumeSlider.value = String(safe);
    }
    syncVolumeMetricText(safe, { force: Boolean(options && options.forceText) });
    return safe;
  }

  function updateAudioTailPaddingDisplay(value, options) {
    const safe = clamp(
      Math.round(Number(value) || 0),
      0,
      MAX_AUDIO_TAIL_PADDING_MS
    );
    state.currentAudioTailPaddingMs = safe;
    if (!state.audioTailPaddingEditing || Boolean(options && options.forceText)) {
      state.confirmedAudioTailPaddingMs = safe;
    }
    syncAudioTailPaddingMetricText(safe, {
      force: Boolean(options && options.forceText),
    });
    return safe;
  }

  function updatePollIntervalDisplay(value, options) {
    const safe = clamp(
      Math.round(Number(value) || 0),
      MIN_CONVERSATION_POLL_INTERVAL_MS,
      MAX_CONVERSATION_POLL_INTERVAL_MS
    );
    state.currentPollIntervalMs = safe;
    if (!state.pollIntervalEditing || Boolean(options && options.forceText)) {
      state.confirmedPollIntervalMs = safe;
    }
    syncPollIntervalMetricText(safe, {
      force: Boolean(options && options.forceText),
    });
    return safe;
  }

  function updateConversationInterceptManualOffsetDisplay(value, options) {
    const safe = normalizeConversationInterceptManualOffsetMs(value);
    state.currentConversationInterceptManualOffsetMs = safe;
    if (Boolean(options && options.forceValue)) {
      state.confirmedConversationInterceptManualOffsetMs = safe;
    }
    syncConversationInterceptManualOffsetDisplay(safe);
    return safe;
  }

  function hasPendingLocalVolumeDraft() {
    return Boolean(state.volumeTextEditing || state.volumeInputTimer);
  }

  function updateDialogWindowDisplay(value, options) {
    const safe = clamp(Number(value) || 0, MIN_DIALOG_WINDOW_SECONDS, MAX_DIALOG_WINDOW_SECONDS);
    const forceInput = Boolean(options && options.forceInput);
    state.currentDialogWindowValue = safe;
    if (
      els.dialogWindowInput &&
      (forceInput ||
        document.activeElement !== els.dialogWindowInput ||
        !state.dialogWindowDirty)
    ) {
      els.dialogWindowInput.value = String(safe);
    }
    return safe;
  }

  function updateOpenclawContextTokensDisplay(value, options) {
    const safeTokens = clamp(
      Number(value) || DEFAULT_OPENCLAW_CONTEXT_TOKENS,
      MIN_OPENCLAW_CONTEXT_TOKENS,
      MAX_OPENCLAW_CONTEXT_TOKENS
    );
    const forceInput = Boolean(options && options.forceInput);
    const keepUserInput =
      !forceInput &&
      (state.openclawContextTokensDirty || state.openclawContextTokensSaving);
    state.currentOpenclawContextTokensValue = safeTokens;
    if (els.openclawContextTokensInput && !keepUserInput) {
      els.openclawContextTokensInput.value = String(safeTokens);
    }
    return safeTokens;
  }

  function normalizeWorkspaceFileItem(item) {
    if (!item || typeof item !== "object") {
      return null;
    }
    const id = String(item.id || "").trim().toLowerCase();
    const filename = String(item.filename || "").trim();
    if (!id || !filename) {
      return null;
    }
    const defaultContent = normalizeVoiceSystemPromptInput(item.defaultContent || "");
    const content = normalizeVoiceSystemPromptInput(
      item.enabled ? item.content || "" : defaultContent
    );
    return {
      id,
      filename,
      label: String(item.label || filename).trim() || filename,
      description: String(item.description || "").trim(),
      enabled: item.enabled !== false,
      customized: Boolean(item.customized),
      defaultEnabled: item.defaultEnabled !== false,
      disableAllowed: item.disableAllowed !== false,
      defaultContent,
      content,
    };
  }

  function getWorkspaceFileBaseValue(file) {
    if (!file) {
      return "";
    }
    return file.enabled ? file.content : file.defaultContent;
  }

  function getSelectedWorkspaceFile() {
    const files = Array.isArray(state.openclawWorkspaceFiles)
      ? state.openclawWorkspaceFiles
      : [];
    const selected =
      files.find((item) => item.id === state.selectedWorkspaceFileId) || files[0] || null;
    if (selected && state.selectedWorkspaceFileId !== selected.id) {
      state.selectedWorkspaceFileId = selected.id;
    }
    return selected;
  }

  function getWorkspaceFileEditorValue(file) {
    if (!file) {
      return "";
    }
    if (Object.prototype.hasOwnProperty.call(state.workspaceFileDrafts, file.id)) {
      return state.workspaceFileDrafts[file.id];
    }
    return getWorkspaceFileBaseValue(file);
  }

  function renderWorkspaceFileEditor() {
    const files = Array.isArray(state.openclawWorkspaceFiles)
      ? state.openclawWorkspaceFiles
      : [];
    if (els.workspaceFileSelect) {
      els.workspaceFileSelect.replaceChildren();
      files.forEach((item) => {
        const option = document.createElement("option");
        option.value = item.id;
        option.textContent = `${item.label}（${item.filename}）`;
        els.workspaceFileSelect.appendChild(option);
      });
    }

    const selected = getSelectedWorkspaceFile();
    if (els.workspaceFileSelect) {
      els.workspaceFileSelect.value = selected ? selected.id : "";
      els.workspaceFileSelect.disabled = state.workspaceFileSaving || !selected;
    }

    if (!selected) {
      if (els.voiceSystemPromptInput) {
        els.voiceSystemPromptInput.value = "";
        els.voiceSystemPromptInput.disabled = true;
      }
      if (els.voiceSystemPromptSaveBtn) {
        els.voiceSystemPromptSaveBtn.disabled = true;
      }
      if (els.workspaceFileDisableBtn) {
        els.workspaceFileDisableBtn.disabled = true;
        els.workspaceFileDisableBtn.textContent = "禁用文件";
      }
      if (els.workspaceFileDetail) {
        els.workspaceFileDetail.textContent = "当前没有可编辑的 xiaoai agent workspace 文件。";
      }
      syncCustomPickers();
      scheduleControlMasonryLayout();
      return;
    }

    const editorValue = getWorkspaceFileEditorValue(selected);
    state.currentVoiceSystemPromptValue = editorValue;
    if (els.voiceSystemPromptInput) {
      els.voiceSystemPromptInput.disabled = state.workspaceFileSaving;
      if (document.activeElement !== els.voiceSystemPromptInput || !state.workspaceFileDirty[selected.id]) {
        els.voiceSystemPromptInput.value = editorValue;
      }
      els.voiceSystemPromptInput.placeholder = `输入要写入 xiaoai agent workspace / ${selected.filename} 的内容`;
    }
    if (els.voiceSystemPromptSaveBtn) {
      els.voiceSystemPromptSaveBtn.disabled = state.workspaceFileSaving;
      els.voiceSystemPromptSaveBtn.textContent = state.workspaceFileSaving ? "保存中" : "保存";
    }
    if (els.workspaceFileDisableBtn) {
      els.workspaceFileDisableBtn.disabled =
        state.workspaceFileSaving || !selected.disableAllowed;
      els.workspaceFileDisableBtn.textContent = selected.disableAllowed
        ? "禁用文件"
        : "不可禁用";
      els.workspaceFileDisableBtn.title = selected.disableAllowed
        ? ""
        : `${selected.filename} 是核心提示文件，建议保留。`;
    }
    if (els.workspaceFileDetail) {
      const detailParts = [
        `当前文件：${selected.filename}`,
        selected.enabled ? "状态：已启用" : "状态：已禁用",
        selected.enabled
          ? selected.customized
            ? "内容：自定义"
            : "内容：默认"
          : selected.id === "boot"
            ? "禁用后文件会被移除，保存任意内容可重新启用"
            : "禁用后会清空内容并跳过注入，保存任意内容可重新启用",
        selected.description || "",
      ].filter(Boolean);
      els.workspaceFileDetail.textContent = detailParts.join(" · ");
    }
    syncCustomPickers();
    scheduleControlMasonryLayout();
  }

  function updateWorkspaceFilesDisplay(data) {
    const nextState = data && typeof data === "object" ? data : {};
    const normalizedFiles = Array.isArray(nextState.files)
      ? nextState.files.map((item) => normalizeWorkspaceFileItem(item)).filter(Boolean)
      : [];
    if (!normalizedFiles.length) {
      const fallbackPrompt = normalizeVoiceSystemPromptInput(
        state.currentVoiceSystemPromptValue || ""
      );
      normalizedFiles.push({
        id: "agents",
        filename: "AGENTS.md",
        label: "系统提示词",
        description: "这里会直接写入专属 workspace 的 AGENTS.md。",
        enabled: true,
        customized: Boolean(fallbackPrompt),
        defaultEnabled: true,
        disableAllowed: false,
        defaultContent: fallbackPrompt,
        content: fallbackPrompt,
      });
    }
    state.openclawWorkspaceFiles = normalizedFiles;
    const activeIds = new Set(normalizedFiles.map((item) => item.id));
    Object.keys(state.workspaceFileDrafts).forEach((id) => {
      if (!activeIds.has(id)) {
        delete state.workspaceFileDrafts[id];
      }
    });
    Object.keys(state.workspaceFileDirty).forEach((id) => {
      if (!activeIds.has(id)) {
        delete state.workspaceFileDirty[id];
      }
    });
    normalizedFiles.forEach((item) => {
      if (!state.workspaceFileDirty[item.id]) {
        state.workspaceFileDrafts[item.id] = getWorkspaceFileBaseValue(item);
      }
    });
    renderWorkspaceFileEditor();
  }

  function updateTransitionPhrasesDisplay(value, options) {
    const normalized = normalizeTransitionPhrasesInput(value);
    const forceInput = Boolean(options && options.forceInput);
    const keepUserInput =
      !forceInput &&
      (state.transitionPhrasesDirty || state.transitionPhrasesSaving);
    state.currentTransitionPhrasesValue = normalized;
    if (els.transitionPhrasesInput && !keepUserInput) {
      els.transitionPhrasesInput.value = normalized;
    }
    return normalized;
  }

  function renderThinkingToggle(enabled) {
    const nextEnabled = Boolean(enabled);
    state.thinkingEnabled = nextEnabled;
    if (els.thinkingOffToggle) {
      els.thinkingOffToggle.classList.toggle("is-active", nextEnabled);
      els.thinkingOffToggle.setAttribute("aria-pressed", String(nextEnabled));
    }
    if (els.thinkingOffLabel) {
      els.thinkingOffLabel.textContent = nextEnabled ? "已打开" : "已关闭";
    }
  }

  function renderForceNonStreamingToggle(enabled) {
    const nextEnabled = Boolean(enabled);
    state.forceNonStreamingEnabled = nextEnabled;
    if (els.forceNonStreamingToggle) {
      els.forceNonStreamingToggle.classList.toggle("is-active", nextEnabled);
      els.forceNonStreamingToggle.setAttribute(
        "aria-pressed",
        String(nextEnabled)
      );
    }
    if (els.forceNonStreamingLabel) {
      els.forceNonStreamingLabel.textContent = nextEnabled ? "已开启" : "已关闭";
    }
  }

  function formatOpenclawModelContextWindow(value) {
    const safe = Number(value);
    if (!Number.isFinite(safe) || safe <= 0) {
      return "";
    }
    return safe.toLocaleString("zh-CN");
  }

  function formatOpenclawModelInputs(inputs) {
    const normalized = Array.isArray(inputs)
      ? inputs
          .map((item) => String(item || "").trim().toLowerCase())
          .filter(Boolean)
      : [];
    if (!normalized.length) {
      return "";
    }
    return normalized
      .map((item) => {
        if (item === "image") {
          return "图片";
        }
        if (item === "text") {
          return "文本";
        }
        return item;
      })
      .join(" / ");
  }

  function normalizeOpenclawModelItem(value) {
    if (!value || typeof value !== "object") {
      return null;
    }
    const ref = String(value.ref || "").trim();
    const name = String(value.name || ref || "").trim();
    const provider = String(value.provider || "").trim();
    if (!ref || !name || !provider) {
      return null;
    }
    const contextWindow = Number(value.contextWindow);
    return {
      ref,
      name,
      provider,
      contextWindow:
        Number.isFinite(contextWindow) && contextWindow > 0
          ? contextWindow
          : undefined,
      reasoning: Boolean(value.reasoning),
      input: Array.isArray(value.input)
        ? value.input
            .map((item) => String(item || "").trim())
            .filter(Boolean)
        : [],
    };
  }

  function renderOpenclawModelControl(agentId, currentModel, models) {
    state.openclawModelLoading = false;
    state.openclawAgentId =
      typeof agentId === "string" && agentId.trim() ? agentId.trim() : "xiaoai";
    state.openclawModel =
      typeof currentModel === "string" && currentModel.trim()
        ? currentModel.trim()
        : "";
    state.openclawModels = Array.isArray(models)
      ? models.map((item) => normalizeOpenclawModelItem(item)).filter(Boolean)
      : [];

    const currentOption = state.openclawModels.find(
      (item) => item.ref === state.openclawModel
    );

    if (els.openclawModelSelect) {
      const select = els.openclawModelSelect;
      select.replaceChildren();

      if (!state.openclawModels.length) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "未读取到可用模型";
        select.appendChild(option);
      } else {
        if (!state.openclawModel) {
          const placeholder = document.createElement("option");
          placeholder.value = "";
          placeholder.textContent = "请选择模型";
          select.appendChild(placeholder);
        } else if (!currentOption) {
          const missingOption = document.createElement("option");
          missingOption.value = state.openclawModel;
          missingOption.textContent = `${state.openclawModel}（当前模型，未在列表中）`;
          select.appendChild(missingOption);
        }

        state.openclawModels.forEach((item) => {
          const option = document.createElement("option");
          option.value = item.ref;
          option.textContent =
            item.name && item.name !== item.ref
              ? `${item.name} (${item.ref})`
              : item.ref;
          select.appendChild(option);
        });
      }

      select.value = state.openclawModel || "";
      if (!state.openclawModel && select.options.length > 0) {
        select.selectedIndex = 0;
      }
      select.disabled =
        state.openclawModelLoading ||
        state.openclawModelSaving ||
        !state.openclawModels.length;
    }

    if (els.openclawModelDetail) {
      if (currentOption) {
        const detailParts = [
          `专属 agent：${state.openclawAgentId}`,
          `提供商：${currentOption.provider}`,
          currentOption.contextWindow
            ? `上下文：${formatOpenclawModelContextWindow(
                currentOption.contextWindow
              )}`
            : "",
          currentOption.input.length
            ? `输入：${formatOpenclawModelInputs(currentOption.input)}`
            : "",
          currentOption.reasoning ? "推理：开启" : "推理：关闭",
        ].filter(Boolean);
        els.openclawModelDetail.textContent = detailParts.join(" · ");
      } else if (state.openclawModel) {
        els.openclawModelDetail.textContent = `专属 agent：${state.openclawAgentId} · 当前模型：${state.openclawModel}`;
      } else if (state.openclawModels.length) {
        els.openclawModelDetail.textContent = `专属 agent：${state.openclawAgentId} · 请选择一个模型，保存后会自动重启网关。`;
      } else {
        els.openclawModelDetail.textContent = `专属 agent：${state.openclawAgentId} · 当前配置里还没有读取到可用模型。`;
      }
    }
    syncCustomPickers();
    scheduleControlMasonryLayout();
  }

  function renderOpenclawModelLoading(message) {
    state.openclawModelLoading = true;
    if (els.openclawModelSelect) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "正在读取模型配置…";
      els.openclawModelSelect.replaceChildren(option);
      els.openclawModelSelect.disabled = true;
    }
    if (els.openclawModelDetail) {
      els.openclawModelDetail.textContent =
        message || "正在直接读取 OpenClaw 配置中的模型信息…";
    }
    syncCustomPickers();
    scheduleControlMasonryLayout();
  }

  function renderOpenclawModelLoadFailure(message) {
    state.openclawModelLoading = false;
    if (els.openclawModelSelect) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "读取失败，请重试";
      els.openclawModelSelect.replaceChildren(option);
      els.openclawModelSelect.disabled = true;
    }
    if (els.openclawModelDetail) {
      els.openclawModelDetail.textContent =
        message || "读取 OpenClaw 模型配置失败，请稍后重试。";
    }
    syncCustomPickers();
    scheduleControlMasonryLayout();
  }

  async function refreshOpenclawModelState(silent, options) {
    renderOpenclawModelLoading("正在直接读取 OpenClaw 配置中的模型信息…");
    try {
      const payload = await apiFetch(API.openclawModel);
      renderOpenclawModelControl(
        payload && payload.agentId,
        payload && payload.model,
        payload && payload.models
      );
      return true;
    } catch (error) {
      if (options && options.preserveOnError) {
        renderOpenclawModelControl(
          state.openclawAgentId,
          state.openclawModel,
          state.openclawModels
        );
      } else {
        renderOpenclawModelLoadFailure(
          error && error.message
            ? `模型信息读取失败：${error.message}`
            : "读取 OpenClaw 模型配置失败，请稍后重试。"
        );
      }
      if (!silent) {
        showToast(error.message || String(error), "error");
      }
      return false;
    }
  }

  function normalizeOpenclawRouteChannelItem(value) {
    const id =
      value && typeof value.id === "string" && value.id.trim()
        ? value.id.trim()
        : "";
    if (!id) {
      return null;
    }
    return {
      id,
      label:
        value && typeof value.label === "string" && value.label.trim()
          ? value.label.trim()
          : id,
      configured: !(value && value.configured === false),
      targets: Array.isArray(value && value.targets)
        ? value.targets
            .map((item) => String(item || "").trim())
            .filter(Boolean)
        : [],
    };
  }

  function resolveOpenclawRouteDefaultTarget(channelOption, target) {
    const explicitTarget =
      typeof target === "string" && target.trim() ? target.trim() : "";
    if (explicitTarget) {
      return explicitTarget;
    }
    if (channelOption && channelOption.targets.length === 1) {
      return channelOption.targets[0];
    }
    return "";
  }

  function renderOpenclawRouteControl(route) {
    const nextRoute = route && typeof route === "object" ? route : {};
    const serverChannel =
      typeof nextRoute.channel === "string" && nextRoute.channel.trim()
        ? nextRoute.channel.trim()
        : "";
    const serverTarget =
      typeof nextRoute.target === "string" && nextRoute.target.trim()
        ? nextRoute.target.trim()
        : "";
    const normalizedChannels = Array.isArray(nextRoute.channels)
      ? nextRoute.channels
          .map((item) => normalizeOpenclawRouteChannelItem(item))
          .filter(Boolean)
      : [];
    if (
      serverChannel &&
      !normalizedChannels.some((item) => item.id === serverChannel)
    ) {
      normalizedChannels.unshift({
        id: serverChannel,
        label: serverChannel,
        configured: false,
        targets: [],
      });
    }

    state.openclawRouteChannels = normalizedChannels;
    state.openclawRouteEnabled = Boolean(nextRoute.enabled) && Boolean(serverTarget);

    const routeFocused =
      document.activeElement === els.openclawRouteChannelSelect ||
      document.activeElement === els.openclawRouteTargetInput;
    if (!state.openclawRouteDirty || !routeFocused) {
      state.openclawRouteChannel =
        serverChannel || (normalizedChannels[0] && normalizedChannels[0].id) || "";
      state.openclawRouteDirty = false;
    } else if (!state.openclawRouteChannel && serverChannel) {
      state.openclawRouteChannel = serverChannel;
    }

    const currentChannel =
      state.openclawRouteChannel ||
      serverChannel ||
      (normalizedChannels[0] && normalizedChannels[0].id) ||
      "";
    const currentChannelOption =
      normalizedChannels.find((item) => item.id === currentChannel) || null;
    const resolvedServerTarget = resolveOpenclawRouteDefaultTarget(
      currentChannelOption,
      serverTarget
    );
    if (!state.openclawRouteDirty || !routeFocused) {
      state.openclawRouteTarget = resolvedServerTarget;
    }

    if (els.openclawRouteChannelSelect) {
      const select = els.openclawRouteChannelSelect;
      select.replaceChildren();
      if (!normalizedChannels.length) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "未检测到已配置渠道";
        select.appendChild(option);
      } else {
        normalizedChannels.forEach((item) => {
          const option = document.createElement("option");
          option.value = item.id;
          option.textContent = item.configured
            ? item.id
            : `${item.id}（未在当前配置中检测到）`;
          select.appendChild(option);
        });
      }
      select.value = currentChannel;
      if (!currentChannel && select.options.length > 0) {
        select.selectedIndex = 0;
      }
      select.disabled = state.openclawRouteSaving;
    }

    if (els.openclawRouteTargetInput) {
      if (!state.openclawRouteDirty || document.activeElement !== els.openclawRouteTargetInput) {
        els.openclawRouteTargetInput.value =
          state.openclawRouteTarget || resolvedServerTarget;
      }
      els.openclawRouteTargetInput.disabled = state.openclawRouteSaving;
      const placeholderTargets = currentChannelOption ? currentChannelOption.targets : [];
      els.openclawRouteTargetInput.placeholder = placeholderTargets.length
        ? `例如：${placeholderTargets[0]}`
        : "填写当前渠道对应的目标";
    }

    if (els.openclawRouteSaveBtn) {
      els.openclawRouteSaveBtn.disabled =
        state.openclawRouteSaving || !normalizedChannels.length;
    }
    if (els.openclawRouteDisableBtn) {
      els.openclawRouteDisableBtn.disabled = state.openclawRouteSaving;
    }

    if (els.openclawRouteDetail) {
      const detailParts = [
        `专属 agent：${
          typeof nextRoute.agentId === "string" && nextRoute.agentId.trim()
            ? nextRoute.agentId.trim()
            : state.openclawAgentId || "xiaoai"
        }`,
        state.openclawRouteEnabled
          ? `当前通知：${serverChannel || currentChannel} / ${serverTarget}`
          : "当前通知：已关闭",
        currentChannelOption && currentChannelOption.targets.length > 1
          ? `检测到 ${currentChannelOption.targets.length} 个候选目标`
          : currentChannelOption && currentChannelOption.targets.length === 1
            ? "当前渠道可自动推断唯一目标"
            : "",
      ].filter(Boolean);
      els.openclawRouteDetail.textContent = detailParts.join(" · ");
    }
    syncCustomPickers();
    scheduleControlMasonryLayout();
  }

  function syncPollIntervalAvailability(disabled) {
    if (!els.pollIntervalValue) {
      return;
    }
    const effectiveDisabled =
      Boolean(disabled) ||
      state.conversationInterceptCalibrationRunning ||
      state.pollIntervalSaving;
    els.pollIntervalValue.setAttribute(
      "contenteditable",
      effectiveDisabled ? "false" : "plaintext-only"
    );
    els.pollIntervalValue.setAttribute("aria-disabled", String(effectiveDisabled));
    els.pollIntervalValue.tabIndex = effectiveDisabled ? -1 : 0;
    els.pollIntervalValue.classList.toggle("is-disabled", effectiveDisabled);
  }

  function syncConversationInterceptManualOffsetAvailability(disabled) {
    if (!els.conversationInterceptOffsetSlider) {
      return;
    }
    const effectiveDisabled =
      Boolean(disabled) ||
      state.conversationInterceptCalibrationRunning ||
      state.conversationInterceptManualOffsetSaving;
    els.conversationInterceptOffsetSlider.disabled = effectiveDisabled;
  }

  function bindPollIntervalEditor() {
    if (!els.pollIntervalValue || els.pollIntervalValue.dataset.bound === "true") {
      return;
    }
    els.pollIntervalValue.dataset.bound = "true";
    els.pollIntervalValue.addEventListener("focus", () => {
      state.pollIntervalEditing = true;
      state.pollIntervalDirty = false;
      syncPollIntervalMetricText(state.currentPollIntervalMs, { force: true });
      window.requestAnimationFrame(() => {
        if (!els.pollIntervalValue || document.activeElement !== els.pollIntervalValue) {
          return;
        }
        const selection = window.getSelection();
        if (!selection) {
          return;
        }
        const range = document.createRange();
        range.selectNodeContents(els.pollIntervalValue);
        selection.removeAllRanges();
        selection.addRange(range);
      });
    });
    els.pollIntervalValue.addEventListener("input", () => {
      const raw = sanitizePollIntervalText(els.pollIntervalValue.textContent);
      if ((els.pollIntervalValue.textContent || "") !== raw) {
        els.pollIntervalValue.textContent = raw;
      }
      state.pollIntervalDirty = true;
      if (!raw) {
        return;
      }
      state.currentPollIntervalMs = clamp(
        Math.round(Number(raw) || DEFAULT_CONVERSATION_POLL_INTERVAL_MS),
        MIN_CONVERSATION_POLL_INTERVAL_MS,
        MAX_CONVERSATION_POLL_INTERVAL_MS
      );
    });
    els.pollIntervalValue.addEventListener("blur", () => {
      state.pollIntervalEditing = false;
      const raw = sanitizePollIntervalText(els.pollIntervalValue.textContent);
      if (!raw) {
        state.pollIntervalDirty = false;
        updatePollIntervalDisplay(state.confirmedPollIntervalMs, {
          forceText: true,
        });
        renderConversationInterceptCalibrationControl(
          (state.bootstrap && state.bootstrap.conversationInterceptCalibration) || {}
        );
        return;
      }
      state.currentPollIntervalMs = clamp(
        Math.round(Number(raw) || DEFAULT_CONVERSATION_POLL_INTERVAL_MS),
        MIN_CONVERSATION_POLL_INTERVAL_MS,
        MAX_CONVERSATION_POLL_INTERVAL_MS
      );
      syncPollIntervalMetricText(state.currentPollIntervalMs, { force: true });
      if (state.pollIntervalDirty) {
        void applyPollInterval();
      } else {
        renderConversationInterceptCalibrationControl(
          (state.bootstrap && state.bootstrap.conversationInterceptCalibration) || {}
        );
      }
    });
    els.pollIntervalValue.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        els.pollIntervalValue.blur();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        state.pollIntervalEditing = false;
        state.pollIntervalDirty = false;
        updatePollIntervalDisplay(state.confirmedPollIntervalMs, {
          forceText: true,
        });
        els.pollIntervalValue.blur();
      }
    });
  }

  function bindConversationInterceptOffsetSlider() {
    if (
      !els.conversationInterceptOffsetSlider ||
      els.conversationInterceptOffsetSlider.dataset.bound === "true"
    ) {
      return;
    }
    els.conversationInterceptOffsetSlider.dataset.bound = "true";
    els.conversationInterceptOffsetSlider.addEventListener("input", () => {
      updateConversationInterceptManualOffsetDisplay(
        els.conversationInterceptOffsetSlider.value
      );
      if (els.conversationInterceptOffsetNote) {
        els.conversationInterceptOffsetNote.textContent =
          "向左更早拦截，向右更晚拦截";
      }
    });
    els.conversationInterceptOffsetSlider.addEventListener("change", () => {
      void applyConversationInterceptManualOffset();
    });
  }

  function ensureConversationInterceptCalibrationMetricsShell() {
    if (!els.calibrationMetrics) {
      return;
    }
    if (els.calibrationMetrics.dataset.mode === "conversation") {
      return;
    }
    resetCalibrationMetricRefs();
    els.calibrationMetrics.innerHTML = `
      <div class="control-metric control-metric-editable">
        <span class="control-metric-label">轮询间隔</span>
        <strong class="control-metric-value control-metric-value-editable">
          <span
            class="control-metric-inline-edit"
            id="pollIntervalValue"
            role="spinbutton"
            tabindex="0"
            spellcheck="false"
            aria-label="对话轮询间隔，单位毫秒"
            aria-valuemin="${escapeHtml(String(MIN_CONVERSATION_POLL_INTERVAL_MS))}"
            aria-valuemax="${escapeHtml(String(MAX_CONVERSATION_POLL_INTERVAL_MS))}"
          ></span>
          <span class="control-metric-unit">ms</span>
        </strong>
        <span class="control-metric-note" id="pollIntervalNote">拦截主轮询节奏，回车或失焦保存</span>
      </div>
      <div class="control-metric">
        <span class="control-metric-label">会话回写</span>
        <strong class="control-metric-value" id="conversationVisibleValue">-</strong>
        <span class="control-metric-note">测试问句出现在云端记录</span>
      </div>
      <div class="control-metric">
        <span class="control-metric-label">原生起播</span>
        <strong class="control-metric-value" id="nativePlaybackStartValue">-</strong>
        <span class="control-metric-note">小爱原生回复开始播放</span>
      </div>
      <div class="control-metric">
        <span class="control-metric-label">拦截提前量</span>
        <strong class="control-metric-value" id="interceptLeadValue">-</strong>
        <span class="control-metric-note">看到会话到原生起播之间的余量</span>
      </div>
      <div class="control-metric control-metric-slider calibration-offset-shell">
        <div class="control-metric-slider-head">
          <span class="control-metric-label">体感微调</span>
          <strong class="control-metric-value" id="conversationInterceptOffsetValue">0 ms</strong>
        </div>
        <input
          id="conversationInterceptOffsetSlider"
          class="range-field"
          type="range"
          min="${escapeHtml(String(MIN_CONVERSATION_INTERCEPT_MANUAL_OFFSET_MS))}"
          max="${escapeHtml(String(MAX_CONVERSATION_INTERCEPT_MANUAL_OFFSET_MS))}"
          step="${escapeHtml(String(CONVERSATION_INTERCEPT_MANUAL_OFFSET_STEP_MS))}"
          value="${escapeHtml(String(DEFAULT_CONVERSATION_INTERCEPT_MANUAL_OFFSET_MS))}"
          aria-label="对话拦截体感微调"
        />
        <span class="control-metric-note" id="conversationInterceptOffsetNote">向左更早拦截，向右更晚拦截</span>
      </div>
    `;
    els.calibrationMetrics.dataset.mode = "conversation";
    els.pollIntervalValue = byId("pollIntervalValue");
    els.pollIntervalNote = byId("pollIntervalNote");
    els.conversationVisibleValue = byId("conversationVisibleValue");
    els.nativePlaybackStartValue = byId("nativePlaybackStartValue");
    els.interceptLeadValue = byId("interceptLeadValue");
    els.conversationInterceptOffsetSlider = byId("conversationInterceptOffsetSlider");
    els.conversationInterceptOffsetValue = byId("conversationInterceptOffsetValue");
    els.conversationInterceptOffsetNote = byId("conversationInterceptOffsetNote");
    bindPollIntervalEditor();
    bindConversationInterceptOffsetSlider();
  }

  function renderConversationInterceptCalibrationControl(calibration) {
    ensureConversationInterceptCalibrationMetricsShell();
    syncCalibrationModePicker();
    const nextCalibration =
      calibration && typeof calibration === "object" ? calibration : {};
    const prompt = normalizeCalibrationPrompt(nextCalibration.prompt);
    const currentProfile =
      nextCalibration.currentProfile &&
      typeof nextCalibration.currentProfile === "object"
        ? nextCalibration.currentProfile
        : null;
    const lastRun =
      nextCalibration.lastRun && typeof nextCalibration.lastRun === "object"
        ? nextCalibration.lastRun
        : null;
    const pollIntervalMs = getFiniteNumber(
      nextCalibration.pollIntervalMs,
      state.confirmedPollIntervalMs || DEFAULT_CONVERSATION_POLL_INTERVAL_MS
    );
    const manualOffsetMs = normalizeConversationInterceptManualOffsetMs(
      getFiniteNumber(
        nextCalibration.manualOffsetMs,
        getFiniteNumber(
          currentProfile && currentProfile.manualOffsetMs,
          state.confirmedConversationInterceptManualOffsetMs ||
            DEFAULT_CONVERSATION_INTERCEPT_MANUAL_OFFSET_MS
        )
      )
    );
    const recommendedPollIntervalMs = getFiniteNumber(
      nextCalibration.recommendedPollIntervalMs,
      pollIntervalMs
    );
    state.conversationInterceptCalibrationRunning = Boolean(nextCalibration.running);
    if (!state.pollIntervalEditing || !state.pollIntervalDirty) {
      updatePollIntervalDisplay(pollIntervalMs, {
        forceText: !state.pollIntervalEditing,
      });
    }
    updateConversationInterceptManualOffsetDisplay(manualOffsetMs, {
      forceValue: true,
    });

    if (els.calibrationRunBtn) {
      const anyCalibrationRunning =
        state.audioCalibrationRunning ||
        state.conversationInterceptCalibrationRunning;
      els.calibrationRunBtn.disabled =
        anyCalibrationRunning || !(state.bootstrap && state.bootstrap.ready);
      els.calibrationRunBtn.textContent = anyCalibrationRunning
        ? "校准中"
        : "一键校准";
    }
    if (els.calibrationDescription) {
      els.calibrationDescription.textContent = prompt
        ? prompt.title
        : "轮询间隔可修改，校准时不要和音箱说话。";
      els.calibrationDescription.dataset.tone = prompt ? "warn" : "default";
    }
    if (els.conversationVisibleValue) {
      els.conversationVisibleValue.textContent = formatLatencyEstimate(
        currentProfile && currentProfile.conversationVisibleEstimateMs
      );
    }
    if (els.nativePlaybackStartValue) {
      els.nativePlaybackStartValue.textContent = formatLatencyEstimate(
        currentProfile && currentProfile.nativePlaybackStartEstimateMs
      );
    }
    if (els.interceptLeadValue) {
      els.interceptLeadValue.textContent = formatLatencyEstimate(
        currentProfile && currentProfile.interceptLeadEstimateMs
      );
    }
    if (els.pollIntervalValue) {
      els.pollIntervalValue.setAttribute(
        "aria-valuenow",
        String(state.currentPollIntervalMs || DEFAULT_CONVERSATION_POLL_INTERVAL_MS)
      );
      els.pollIntervalValue.setAttribute("title", "直接修改毫秒值，回车或失焦保存");
    }
    if (els.pollIntervalNote) {
      els.pollIntervalNote.textContent = state.pollIntervalSaving
        ? "正在保存..."
        : recommendedPollIntervalMs < pollIntervalMs
          ? `建议收紧到 ${recommendedPollIntervalMs}ms`
          : "拦截主轮询节奏，回车或失焦保存";
    }
    if (els.conversationInterceptOffsetNote) {
      els.conversationInterceptOffsetNote.textContent =
        state.conversationInterceptManualOffsetSaving
          ? "正在保存..."
          : "向左更早拦截，向右更晚拦截";
    }
    if (els.calibrationDetail) {
      const detailParts = [];
      if (prompt && prompt.detail) {
        detailParts.push(prompt.detail);
      }
      if (currentProfile && currentProfile.updatedAt) {
        detailParts.push(`当前画像更新于 ${formatDateTime(currentProfile.updatedAt)}`);
      }
      if (lastRun) {
        const rounds = getFiniteNumber(lastRun.rounds, 0);
        const successCount = getFiniteNumber(lastRun.successCount, 0);
        const failureCount = getFiniteNumber(lastRun.failureCount, 0);
        const fallbackRounds = getFiniteNumber(lastRun.fallbackRounds, 0);
        const strategyLabel = formatConversationCalibrationStrategy(
          typeof lastRun.strategy === "string" ? lastRun.strategy : ""
        );
        const lastPollIntervalMs = getFiniteNumber(
          lastRun.pollIntervalMs,
          pollIntervalMs
        );
        detailParts.push(
          `最近一次校准成功 ${successCount}/${rounds || successCount + failureCount || 0} 轮`
        );
        if (fallbackRounds > 0) {
          detailParts.push(`其中 ${fallbackRounds} 轮使用保守估算`);
        }
        if (strategyLabel) {
          detailParts.push(`策略：${strategyLabel}`);
        }
        detailParts.push(`轮询间隔 ${lastPollIntervalMs}ms`);
        if (
          getFiniteNumber(lastRun.recommendedPollIntervalMs, lastPollIntervalMs) <
          lastPollIntervalMs
        ) {
          detailParts.push(
            `建议值 ${getFiniteNumber(
              lastRun.recommendedPollIntervalMs,
              lastPollIntervalMs
            )}ms`
          );
        }
        if (lastRun.deviceName || lastRun.deviceId) {
          detailParts.push(`设备：${lastRun.deviceName || lastRun.deviceId}`);
        }
        if (lastRun.completedAt) {
          detailParts.push(`完成于 ${formatDateTime(lastRun.completedAt)}`);
        }
        if (lastRun.lastError) {
          detailParts.push(`最后错误：${lastRun.lastError}`);
        }
      } else if (!prompt) {
        detailParts.push(
          "校准会发测试问句，期间音箱可能出声。"
        );
      }
      els.calibrationDetail.textContent = detailParts.join(" · ");
    }
    syncPollIntervalAvailability(!(state.bootstrap && state.bootstrap.ready));
    syncConversationInterceptManualOffsetAvailability(
      !(state.bootstrap && state.bootstrap.ready)
    );
    syncCalibrationModeAvailability(!(state.bootstrap && state.bootstrap.ready));
    scheduleControlMasonryLayout();
  }

  function syncAudioTailPaddingAvailability(disabled) {
    if (!els.audioTailPaddingValue) {
      return;
    }
    const effectiveDisabled =
      Boolean(disabled) || state.audioCalibrationRunning || state.audioTailPaddingSaving;
    els.audioTailPaddingValue.setAttribute(
      "contenteditable",
      effectiveDisabled ? "false" : "plaintext-only"
    );
    els.audioTailPaddingValue.setAttribute("aria-disabled", String(effectiveDisabled));
    els.audioTailPaddingValue.tabIndex = effectiveDisabled ? -1 : 0;
    els.audioTailPaddingValue.classList.toggle("is-disabled", effectiveDisabled);
  }

  function bindAudioTailPaddingEditor() {
    if (!els.audioTailPaddingValue || els.audioTailPaddingValue.dataset.bound === "true") {
      return;
    }
    els.audioTailPaddingValue.dataset.bound = "true";
    els.audioTailPaddingValue.addEventListener("focus", () => {
      state.audioTailPaddingEditing = true;
      state.audioTailPaddingDirty = false;
      syncAudioTailPaddingMetricText(state.currentAudioTailPaddingMs, { force: true });
      window.requestAnimationFrame(() => {
        if (
          !els.audioTailPaddingValue ||
          document.activeElement !== els.audioTailPaddingValue
        ) {
          return;
        }
        const selection = window.getSelection();
        if (!selection) {
          return;
        }
        const range = document.createRange();
        range.selectNodeContents(els.audioTailPaddingValue);
        selection.removeAllRanges();
        selection.addRange(range);
      });
    });
    els.audioTailPaddingValue.addEventListener("input", () => {
      const raw = sanitizeAudioTailPaddingText(els.audioTailPaddingValue.textContent);
      if ((els.audioTailPaddingValue.textContent || "") !== raw) {
        els.audioTailPaddingValue.textContent = raw;
      }
      state.audioTailPaddingDirty = true;
      if (!raw || raw.endsWith(".")) {
        return;
      }
      state.currentAudioTailPaddingMs = clamp(
        Math.round(Number(raw) * 1000),
        0,
        MAX_AUDIO_TAIL_PADDING_MS
      );
    });
    els.audioTailPaddingValue.addEventListener("blur", () => {
      state.audioTailPaddingEditing = false;
      const raw = sanitizeAudioTailPaddingText(els.audioTailPaddingValue.textContent);
      if (!raw || raw.endsWith(".")) {
        state.audioTailPaddingDirty = false;
        updateAudioTailPaddingDisplay(state.confirmedAudioTailPaddingMs, {
          forceText: true,
        });
        renderAudioCalibrationControl(
          (state.bootstrap && state.bootstrap.audioCalibration) || {}
        );
        return;
      }
      state.currentAudioTailPaddingMs = clamp(
        Math.round(Number(raw) * 1000),
        0,
        MAX_AUDIO_TAIL_PADDING_MS
      );
      syncAudioTailPaddingMetricText(state.currentAudioTailPaddingMs, { force: true });
      if (state.audioTailPaddingDirty) {
        void applyAudioTailPadding();
      } else {
        renderAudioCalibrationControl(
          (state.bootstrap && state.bootstrap.audioCalibration) || {}
        );
      }
    });
    els.audioTailPaddingValue.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        els.audioTailPaddingValue.blur();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        state.audioTailPaddingEditing = false;
        state.audioTailPaddingDirty = false;
        updateAudioTailPaddingDisplay(state.confirmedAudioTailPaddingMs, {
          forceText: true,
        });
        els.audioTailPaddingValue.blur();
      }
    });
  }

  function ensureAudioCalibrationMetricsShell() {
    if (!els.calibrationMetrics) {
      return;
    }
    if (els.calibrationMetrics.dataset.mode === "audio") {
      return;
    }
    resetCalibrationMetricRefs();
    els.calibrationMetrics.innerHTML = `
      <div class="control-metric control-metric-editable">
        <span class="control-metric-label">空余延迟</span>
        <strong class="control-metric-value control-metric-value-editable">
          <span
            class="control-metric-inline-edit"
            id="audioTailPaddingValue"
            role="spinbutton"
            tabindex="0"
            spellcheck="false"
            aria-label="空余延迟，单位秒"
            aria-valuemin="0"
            aria-valuemax="${escapeHtml(String(MAX_AUDIO_TAIL_PADDING_MS / 1000))}"
          ></span>
          <span class="control-metric-unit">s</span>
        </strong>
        <span class="control-metric-note" id="audioTailPaddingNote">尾部保守留白，回车或失焦保存</span>
      </div>
      <div class="control-metric">
        <span class="control-metric-label">起播检测</span>
        <strong class="control-metric-value" id="audioCalibrationPlaybackDetectValue">-</strong>
        <span class="control-metric-note">播放开始识别</span>
      </div>
      <div class="control-metric">
        <span class="control-metric-label">停止收敛</span>
        <strong class="control-metric-value" id="audioCalibrationStopSettleValue">-</strong>
        <span class="control-metric-note">停止命令生效</span>
      </div>
      <div class="control-metric">
        <span class="control-metric-label">状态探测</span>
        <strong class="control-metric-value" id="audioCalibrationStatusProbeValue">-</strong>
        <span class="control-metric-note">状态轮询耗时</span>
      </div>
    `;
    els.calibrationMetrics.dataset.mode = "audio";
    els.audioTailPaddingValue = byId("audioTailPaddingValue");
    els.audioTailPaddingNote = byId("audioTailPaddingNote");
    els.audioCalibrationPlaybackDetectValue = byId(
      "audioCalibrationPlaybackDetectValue"
    );
    els.audioCalibrationStopSettleValue = byId("audioCalibrationStopSettleValue");
    els.audioCalibrationStatusProbeValue = byId("audioCalibrationStatusProbeValue");
    bindAudioTailPaddingEditor();
  }

  function renderAudioCalibrationControl(calibration) {
    ensureAudioCalibrationMetricsShell();
    syncCalibrationModePicker();
    const nextCalibration =
      calibration && typeof calibration === "object" ? calibration : {};
    const prompt = normalizeCalibrationPrompt(nextCalibration.prompt);
    const currentProfile =
      nextCalibration.currentProfile &&
      typeof nextCalibration.currentProfile === "object"
        ? nextCalibration.currentProfile
        : null;
    const lastRun =
      nextCalibration.lastRun && typeof nextCalibration.lastRun === "object"
        ? nextCalibration.lastRun
        : null;
    const tailPaddingMs = getFiniteNumber(
      nextCalibration.tailPaddingMs,
      state.confirmedAudioTailPaddingMs || DEFAULT_AUDIO_TAIL_PADDING_MS
    );
    state.audioCalibrationRunning = Boolean(nextCalibration.running);
    if (!state.audioTailPaddingEditing || !state.audioTailPaddingDirty) {
      updateAudioTailPaddingDisplay(tailPaddingMs, {
        forceText: !state.audioTailPaddingEditing,
      });
    }

    if (els.calibrationRunBtn) {
      const anyCalibrationRunning =
        state.audioCalibrationRunning ||
        state.conversationInterceptCalibrationRunning;
      els.calibrationRunBtn.disabled =
        anyCalibrationRunning || !(state.bootstrap && state.bootstrap.ready);
      els.calibrationRunBtn.textContent = anyCalibrationRunning
        ? "校准中"
        : "一键校准";
    }
    if (els.calibrationDescription) {
      els.calibrationDescription.textContent = prompt
        ? prompt.title
        : "空余延迟可修改，校准时不要和音箱说话。";
      els.calibrationDescription.dataset.tone = prompt ? "warn" : "default";
    }

    if (els.audioCalibrationPlaybackDetectValue) {
      els.audioCalibrationPlaybackDetectValue.textContent = formatLatencyEstimate(
        currentProfile && currentProfile.playbackDetectEstimateMs
      );
    }
    if (els.audioCalibrationStopSettleValue) {
      els.audioCalibrationStopSettleValue.textContent = formatLatencyEstimate(
        currentProfile &&
          (currentProfile.pauseSettleEstimateMs ||
            currentProfile.stopSettleEstimateMs)
      );
    }
    if (els.audioCalibrationStatusProbeValue) {
      els.audioCalibrationStatusProbeValue.textContent = formatLatencyEstimate(
        currentProfile && currentProfile.statusProbeEstimateMs
      );
    }
    if (els.audioTailPaddingValue) {
      els.audioTailPaddingValue.setAttribute(
        "aria-valuenow",
        String((state.currentAudioTailPaddingMs || 0) / 1000)
      );
      els.audioTailPaddingValue.setAttribute("title", "直接修改秒数，回车或失焦保存");
    }
    if (els.audioTailPaddingNote) {
      els.audioTailPaddingNote.textContent = state.audioTailPaddingSaving
        ? "正在保存..."
        : "尾部保守留白，回车或失焦保存";
    }

    if (els.calibrationDetail) {
      const detailParts = [];
      if (prompt && prompt.detail) {
        detailParts.push(prompt.detail);
      }
      if (currentProfile && currentProfile.updatedAt) {
        detailParts.push(`当前画像更新于 ${formatDateTime(currentProfile.updatedAt)}`);
      }
      if (lastRun) {
        const rounds = getFiniteNumber(lastRun.rounds, 0);
        const successCount = getFiniteNumber(lastRun.successCount, 0);
        detailParts.push(
          `上次校准：${formatDateTime(lastRun.completedAt || lastRun.startedAt || "")}`
        );
        detailParts.push(`结果：${successCount}/${rounds || successCount} 成功`);
        if (lastRun.deviceName || lastRun.deviceId) {
          detailParts.push(`设备：${lastRun.deviceName || lastRun.deviceId}`);
        }
        if (lastRun.lastError) {
          detailParts.push(`最后错误：${lastRun.lastError}`);
        }
      }
      if (!detailParts.length) {
        detailParts.push("可随时运行静音校准，结果会写入当前设备的延迟画像。");
      }
      els.calibrationDetail.textContent = detailParts.join(" · ");
    }
    syncAudioTailPaddingAvailability(!(state.bootstrap && state.bootstrap.ready));
    syncCalibrationModeAvailability(!(state.bootstrap && state.bootstrap.ready));
    scheduleControlMasonryLayout();
  }

  function renderCalibrationControl() {
    if (getSelectedCalibrationMode() === "conversation") {
      renderConversationInterceptCalibrationControl(
        (state.bootstrap && state.bootstrap.conversationInterceptCalibration) || {}
      );
      return;
    }
    renderAudioCalibrationControl(
      (state.bootstrap && state.bootstrap.audioCalibration) || {}
    );
  }

  function renderDebugLogToggle(enabled) {
    const nextEnabled = Boolean(enabled);
    state.debugLogEnabled = nextEnabled;
    if (els.debugLogToggle) {
      els.debugLogToggle.classList.toggle("is-active", nextEnabled);
      els.debugLogToggle.setAttribute("aria-pressed", String(nextEnabled));
    }
    if (els.debugLogLabel) {
      els.debugLogLabel.textContent = nextEnabled ? "已开启" : "已关闭";
    }
    scheduleControlMasonryLayout();
  }

  function readVolumeDeviceMuted(volume) {
    return Boolean(volume && volume.deviceMuted);
  }

  function readVolumeUnmuteBlocked(volume) {
    return Boolean(volume && volume.unmuteBlocked);
  }

  function readVolumeMuteSupported(volume) {
    return !(volume && volume.muteSupported === false);
  }

  function syncMuteToggleAvailability(forceDisabled) {
    if (!els.volumeMuteToggle) {
      return;
    }
    const unsupported = !state.muteSupported;
    const blocked =
      !forceDisabled &&
      !unsupported &&
      state.unmuteBlocked &&
      state.muted &&
      !state.speakerControlInFlight &&
      !state.speakerControlQueued;
    els.volumeMuteToggle.disabled = Boolean(forceDisabled || unsupported || blocked);
    els.volumeMuteToggle.title = unsupported
      ? "当前设备不支持可靠的播放静音控制"
      : blocked
        ? "设备真实静音仍处于开启状态，需在音箱侧手动解除一次"
        : "";
  }

  function getSpeakerControlStatusText() {
    if (state.speakerControlQueued) {
      return "已记录新的设置，当前任务完成后继续处理";
    }
    if (state.speakerControlInFlight) {
      return state.speakerControlInFlight.kind === "mute"
        ? "正在切换播放静音"
        : "正在把音量写入音箱";
    }
    if (state.speakerStatePending) {
      return "音箱状态回传中";
    }
    if (!state.muteSupported) {
      return "当前设备不支持可靠的播放静音控制";
    }
    if (state.unmuteBlocked) {
      return "设备真实静音仍处于开启状态，需在音箱侧手动解除一次";
    }
    if (state.deviceMuted) {
      return "设备真实静音已开启";
    }
    return state.muted ? "播放静音已开启" : "设备播放音量";
  }

  function renderMuteToggle(enabled) {
    const nextEnabled = Boolean(enabled);
    state.muted = nextEnabled;
    const pendingMuteCommand =
      state.speakerControlQueued && state.speakerControlQueued.kind === "mute"
        ? state.speakerControlQueued
        : state.speakerControlInFlight && state.speakerControlInFlight.kind === "mute"
          ? state.speakerControlInFlight
          : null;
    const effectiveEnabled = pendingMuteCommand
      ? Boolean(pendingMuteCommand.value)
      : nextEnabled;
    if (els.volumeMuteToggle) {
      els.volumeMuteToggle.classList.toggle("is-active", effectiveEnabled);
      els.volumeMuteToggle.classList.toggle(
        "is-busy",
        Boolean(state.speakerControlInFlight)
      );
      els.volumeMuteToggle.setAttribute("aria-pressed", String(effectiveEnabled));
    }
    syncMuteToggleAvailability(!(state.bootstrap && state.bootstrap.ready));
    if (els.volumeMuteLabel) {
      els.volumeMuteLabel.textContent = state.speakerControlInFlight
        ? "处理中"
        : !state.muteSupported
          ? "不支持"
        : state.unmuteBlocked && effectiveEnabled
          ? "需手动解除"
        : effectiveEnabled
          ? "已开启"
          : "已关闭";
    }
  }

  function renderSpeakerControlState() {
    if (!state.hasVolumeSnapshot) {
      syncVolumeMetricText("-", { force: true });
      if (els.statVolume) {
        els.statVolume.setAttribute("aria-valuenow", "0");
      }
      if (els.volumeSlider) {
        els.volumeSlider.value = "0";
      }
      renderMuteToggle(false);
      if (els.statVolumeDetail) {
        els.statVolumeDetail.textContent = "当前没有拿到音量状态";
      }
      return;
    }
    updateVolumeDisplay(state.currentVolumeValue, {
      forceText: !state.volumeTextEditing,
    });
    renderMuteToggle(state.muted);
    if (els.statVolumeDetail) {
      els.statVolumeDetail.textContent = getSpeakerControlStatusText();
    }
  }

  function setControlAvailability(ready) {
    const disabled = !ready;
    [
      els.composerInput,
      els.audioUrlInput,
      els.sendBtn,
      els.audioSendBtn,
      els.wakeBtn,
      els.volumeSlider,
      els.dialogWindowInput,
      els.openclawContextTokensInput,
    ].forEach((element) => {
      if (element) {
        element.disabled = disabled;
      }
    });
    syncMuteToggleAvailability(disabled);
    els.composeButtons.forEach((button) => {
      button.disabled = disabled;
    });
    els.modeButtons.forEach((button) => {
      button.disabled = disabled;
    });
    if (els.calibrationRunBtn) {
      els.calibrationRunBtn.disabled =
        disabled ||
        state.audioCalibrationRunning ||
        state.conversationInterceptCalibrationRunning;
    }
    syncCalibrationModeAvailability(disabled);
    syncPollIntervalAvailability(disabled);
    syncAudioTailPaddingAvailability(disabled);
    if (els.statVolume) {
      els.statVolume.setAttribute(
        "contenteditable",
        disabled ? "false" : "plaintext-only"
      );
      els.statVolume.setAttribute("aria-disabled", String(disabled));
    }
  }

  function setComposeMode(mode) {
    state.composeMode = mode === "speak" ? "speak" : "chat";
    els.composeButtons.forEach((button) => {
      button.classList.toggle(
        "is-active",
        button.dataset.composeMode === state.composeMode
      );
    });

    if (!els.composerInput || !els.sendBtn) {
      return;
    }

    if (state.composeMode === "chat") {
      els.composerInput.placeholder = "输入一条发给小爱的消息";
      els.sendBtn.textContent = "发送";
    } else {
      els.composerInput.placeholder = "输入一段要直接播报的文字";
      els.sendBtn.textContent = "播报";
    }

    syncComposerMetrics();
  }

  function setModeSelection(mode) {
    els.modeButtons.forEach((button) => {
      button.classList.toggle("is-active", button.dataset.modeChoice === mode);
    });
  }

  function buildReadyStatusText(data) {
    if (!data.ready) {
      return data.loginHint || data.lastError || "当前还没完成登录";
    }
    if (data.lastError && data.lastErrorTransient !== true) {
      return `已连接，但最近一次异常为：${data.lastError}`;
    }
    return "设备已连接，控制台可以直接使用";
  }

  function renderBootstrap(data) {
    const previousBootstrap = state.bootstrap;
    const previousDeviceId = getBootstrapDeviceId(previousBootstrap);
    const wasReady = state.bootstrap ? Boolean(state.bootstrap.ready) : false;
    state.bootstrap = data;
    const device = data.device || {};
    const currentDeviceId = getBootstrapDeviceId(data);
    const volume = data.volume || null;
    const serverVolume =
      volume && typeof volume.percent === "number"
        ? clamp(Number(volume.percent) || 0, 0, 100)
        : 0;
    const ready = Boolean(data.ready);
    const authenticated = Boolean(data.authenticated || ready);
    state.audioCalibrationRunning = Boolean(
      data.audioCalibration && data.audioCalibration.running
    );
    state.conversationInterceptCalibrationRunning = Boolean(
      data.conversationInterceptCalibration &&
        data.conversationInterceptCalibration.running
    );
    state.rawSpeakerAudioPlayback = data.audioPlayback || null;
    const speakerAudioPlayback = resolveSpeakerPlayback(
      state.rawSpeakerAudioPlayback,
      device
    );
    state.bootstrap.audioPlayback = speakerAudioPlayback;

    if (els.statDevice) {
      els.statDevice.textContent = device.name || (authenticated ? "待选择设备" : "未绑定设备");
    }
    if (els.statDeviceMeta) {
      const meta = [device.hardware, device.model].filter(Boolean).join(" / ");
      els.statDeviceMeta.textContent =
        meta || (authenticated ? "账号已登录，请先在下方选择要接管的音箱" : "等待读取设备规格");
    }
    if (els.deviceStatusText) {
      els.deviceStatusText.textContent = buildReadyStatusText(data);
    }
    if (els.deviceStateBadge) {
      els.deviceStateBadge.textContent = ready
        ? "已连接"
        : authenticated
          ? "待选设备"
          : "待登录";
      setBadgeTone(
        els.deviceStateBadge,
        ready ? "ready" : authenticated ? "warn" : "neutral"
      );
    }

    if (els.statAccount) {
      els.statAccount.textContent = maskAccountLabel(data.account);
    }
    if (els.statRegion) {
      const regionValue =
        authenticated || data.account ? data.serverCountry || "-" : "-";
      els.statRegion.textContent = `区域：${regionValue}`;
    }

    if (els.statMode) {
      els.statMode.textContent = data.modeLabel || data.mode || "-";
    }
    if (els.statModeDetail) {
      els.statModeDetail.textContent = ready
        ? data.lastConversationAt
          ? `最近对话：${formatDateTime(data.lastConversationAt)}`
          : "已连接，等待新的对话"
        : "设备未就绪时不会接管新对话";
    }

    state.hasVolumeSnapshot = Boolean(volume);
    const localVolumeDraft = hasPendingLocalVolumeDraft();
    if (volume) {
      state.confirmedVolumeValue = serverVolume;
      state.confirmedMuted = Boolean(volume.muted);
      state.confirmedDeviceMuted = readVolumeDeviceMuted(volume);
      state.confirmedUnmuteBlocked = readVolumeUnmuteBlocked(volume);
      state.confirmedMuteSupported = readVolumeMuteSupported(volume);
      if (!state.speakerControlInFlight && !state.speakerControlQueued) {
        if (!localVolumeDraft) {
          state.currentVolumeValue = serverVolume;
        }
        state.muted = Boolean(volume.muted);
        state.deviceMuted = state.confirmedDeviceMuted;
        state.unmuteBlocked = state.confirmedUnmuteBlocked;
        state.muteSupported = state.confirmedMuteSupported;
      }
      setSpeakerStatePending(Boolean(volume.pending));
    } else if (!state.speakerControlInFlight && !state.speakerControlQueued) {
      if (!localVolumeDraft) {
        state.currentVolumeValue = 0;
      }
      state.confirmedVolumeValue = 0;
      state.muted = false;
      state.confirmedMuted = false;
      state.deviceMuted = false;
      state.confirmedDeviceMuted = false;
      state.unmuteBlocked = false;
      state.confirmedUnmuteBlocked = false;
      state.muteSupported = true;
      state.confirmedMuteSupported = true;
      setSpeakerStatePending(false);
    }
    renderSpeakerControlState();

    if (els.statLogTitle) {
      els.statLogTitle.textContent =
        data.debugLogEnabled === false ? "调试日志（已关闭）" : "调试日志";
    }
    if (els.statLog) {
      els.statLog.textContent = data.debugLogPath || "未提供日志路径";
    }
    if (els.statHelper) {
      els.statHelper.textContent = `micoapi 辅助：${data.helperStatus || "未知"}`;
    }

    if (state.currentAudioSource !== "browser" || !state.currentBrowserAudioUrl) {
      if (speakerAudioPlayback) {
        renderSpeakerCurrentAudio(speakerAudioPlayback);
      } else {
        renderIdleCurrentAudio();
      }
    } else {
      syncBrowserCurrentAudioMeta();
    }

    if (els.accountActionBtn) {
      const action = authenticated ? "logout" : "login";
      els.accountActionBtn.dataset.action = action;
      els.accountActionBtn.textContent = authenticated ? "退出登录" : "登录账号";
      if (data.loginUrl) {
        els.accountActionBtn.dataset.loginUrl = data.loginUrl;
      } else {
        delete els.accountActionBtn.dataset.loginUrl;
      }
    }

    if (els.toggleDeviceListBtn) {
      els.toggleDeviceListBtn.disabled = !authenticated;
      els.toggleDeviceListBtn.textContent = buildDeviceListButtonLabel();
    }
    if (!authenticated && state.deviceListVisible) {
      setDeviceListVisible(false);
    }

    if (els.wakeWordInput) {
      const nextWakeWordPattern = data.wakeWordPattern || "小[虾瞎侠下夏霞]";
      if (document.activeElement !== els.wakeWordInput || !state.wakeWordDirty) {
        els.wakeWordInput.value = nextWakeWordPattern;
        state.wakeWordDirty = false;
      }
    }

    updateDialogWindowDisplay(
      getFiniteNumber(
        data.dialogWindowSeconds,
        state.currentDialogWindowValue || DEFAULT_DIALOG_WINDOW_SECONDS
      )
    );
    updateOpenclawContextTokensDisplay(
      getFiniteNumber(
        data.openclawContextTokens,
        getFiniteNumber(
          data.openclawContextWindow,
          state.currentOpenclawContextTokensValue
        )
      )
    );
    state.currentVoiceSystemPromptValue =
      typeof data.openclawVoiceSystemPrompt === "string"
        ? data.openclawVoiceSystemPrompt
        : state.currentVoiceSystemPromptValue;
    updateWorkspaceFilesDisplay(data.openclawWorkspaceFiles);
    updateTransitionPhrasesDisplay(
      Array.isArray(data.transitionPhrases)
        ? data.transitionPhrases
        : state.currentTransitionPhrasesValue
    );
    renderOpenclawRouteControl(data.openclawRoute);
    renderThinkingToggle(
      Boolean(
        data && Object.prototype.hasOwnProperty.call(data, "thinkingEnabled")
          ? data.thinkingEnabled
          : data.openclawThinkingOff === false
      )
    );
    renderForceNonStreamingToggle(
      Boolean(
        data &&
          Object.prototype.hasOwnProperty.call(data, "openclawForceNonStreaming")
          ? data.openclawForceNonStreaming
          : false
      )
    );
    renderCalibrationControl();
    renderDebugLogToggle(data.debugLogEnabled !== false);
    setModeSelection(data.mode || "wake");
    renderSpeakerControlState();
    setControlAvailability(ready);

    if (state.loginWorkspaceOpen && els.loginWorkspaceHint) {
      els.loginWorkspaceHint.textContent =
        normalizeLoginWorkspaceHint(data.loginHint);
    }

    if (!wasReady && ready && state.loginWorkspaceOpen) {
      closeLoginWorkspace();
      showToast(
        device.name ? `登录完成，已接入 ${device.name}。` : "登录完成。",
        "success"
      );
      void refreshAll(true);
    }

    if (state.pendingDeviceSelectionAfterLogin) {
      if (authenticated && !ready) {
        state.pendingDeviceSelectionAfterLogin = false;
        setActiveTab("overview", true);
        setDeviceListVisible(true);
        if (!state.deviceListLoaded) {
          void loadDeviceList();
        }
      } else if (ready || !authenticated) {
        state.pendingDeviceSelectionAfterLogin = false;
      }
    }

    if (state.deviceListVisible && state.deviceListLoaded) {
      renderDeviceList(state.deviceItems);
    }

    if (
      state.bootstrapInitialized &&
      currentDeviceId &&
      currentDeviceId !== previousDeviceId
    ) {
      showCalibrationPromptToastForDevice(data);
    }
    state.bootstrapInitialized = true;
  }

  function flattenConversationMessages(items) {
    const messages = [];
    (Array.isArray(items) ? items : []).forEach((item) => {
      if (item && item.query) {
        messages.push({
          id: `${item.id || item.requestId || item.time}-user`,
          role: "user",
          text: item.query,
          time: item.time,
        });
      }
      const answers = Array.isArray(item && item.answers) ? item.answers : [];
      answers.forEach((answer, index) => {
        if (!answer) {
          return;
        }
        messages.push({
          id: `${item.id || item.requestId || item.time}-assistant-${index}`,
          role: "assistant",
          text: answer,
          time: item.time,
        });
      });
    });
    return messages;
  }

  function renderConversations(items, options) {
    const shouldStickBottom =
      Boolean(options && options.forceStickBottom) ||
      !state.hasConversationRender ||
      isNearBottom(els.conversationScroll);

    const messages = flattenConversationMessages(items);
    if (!messages.length) {
      els.conversationList.innerHTML =
        '<div class="empty-state empty-state-chat">还没有可展示的历史对话。</div>';
      state.hasConversationRender = true;
      return;
    }

    let previousDay = "";
    els.conversationList.innerHTML = messages
      .map((message) => {
        const day = dateKey(message.time);
        const dayDivider =
          day !== previousDay
            ? `<div class="chat-day-divider"><span>${escapeHtml(
                formatFullDate(message.time)
              )}</span></div>`
            : "";
        previousDay = day;
        return `${dayDivider}<article class="chat-message chat-message-${escapeHtml(
          message.role
        )}">
          <div class="chat-bubble chat-bubble-${escapeHtml(message.role)}">${escapeHtml(
            message.text
          )}</div>
          <div class="chat-time">${escapeHtml(formatTime(message.time))}</div>
        </article>`;
      })
      .join("");

    state.hasConversationRender = true;
    if (shouldStickBottom) {
      scheduleConversationBottomStick(true);
    }
  }

  function renderPendingConversation(text) {
    const pendingHtml = `<article class="chat-message chat-message-user" data-pending-turn="true">
      <div class="chat-bubble chat-bubble-user">${escapeHtml(text)}</div>
      <div class="chat-time">${escapeHtml(formatTime(new Date().toISOString()))}</div>
    </article>
    <article class="chat-message chat-message-assistant is-pending" data-pending-turn="true">
      <div class="chat-bubble chat-bubble-assistant">正在等待小爱的回复…</div>
      <div class="chat-time">${escapeHtml(formatTime(new Date().toISOString()))}</div>
    </article>`;
    const empty = els.conversationList.querySelector(".empty-state");
    if (empty) {
      els.conversationList.innerHTML = "";
    }
    els.conversationList.insertAdjacentHTML("beforeend", pendingHtml);
    state.hasConversationRender = true;
    scheduleConversationBottomStick(true);
  }

  function renderEvents(items, options) {
    const signature =
      options && typeof options.signature === "string"
        ? options.signature
        : buildEventRenderSignature(items);
    if (!Array.isArray(items) || items.length === 0) {
      els.eventList.innerHTML =
        '<div class="empty-state">事件流还是空的，后续的识别、模式切换和异常都会出现在这里。</div>';
      state.animateEventsNextRender = false;
      state.eventRenderSignature = signature;
      els.eventList.dataset.renderState = "ready";
      return;
    }

    const shouldAnimate = state.animateEventsNextRender;
    if (shouldAnimate) {
      els.eventList.dataset.renderState = "preparing";
    }
    els.eventList.innerHTML = items
      .map((item, index) => {
        const level = item.level || "info";
        const animationClass = shouldAnimate ? " event-card-enter-prep" : "";
        const animationStyle = shouldAnimate
          ? ` style="--event-index:${Math.min(index, 9)}"`
          : "";
        const audioUrl = normalizeAudioEventUrl(item && item.audioUrl);
        return `<article class="event-card${animationClass}" data-level="${escapeHtml(
          level
        )}"${animationStyle}>
          <div class="event-top">
            <span class="event-kind ${escapeHtml(level)}">${escapeHtml(
              item.kind || "event"
            )}</span>
            <span class="event-time">${escapeHtml(formatDateTime(item.time))}</span>
          </div>
          <div class="event-title">${escapeHtml(
            item.title || "未命名事件"
          )}</div>
          ${
            item.detail
              ? `<div class="event-detail">${escapeHtml(item.detail)}</div>`
              : ""
          }
          ${
            audioUrl
              ? `<div class="event-audio">
                  <div class="audio-player-shell audio-player-shell-event" data-audio-player-root="event">
                    <audio class="audio-player-media" preload="none" src="${escapeHtml(audioUrl)}"></audio>
                    <div class="audio-player-row audio-player-row-compact">
                      <button class="soft-btn compact-btn audio-player-toggle" data-audio-toggle type="button">播放</button>
                      <div class="audio-player-progress" data-audio-progress aria-hidden="true">
                        <span class="audio-player-progress-fill" data-audio-progress-fill></span>
                      </div>
                      <div class="audio-player-time" data-audio-time>00:00 / --:--</div>
                    </div>
                  </div>
                </div>`
              : ""
          }
        </article>`;
      })
      .join("");
    hydrateAudioPlayers(els.eventList);
    state.eventRenderSignature = signature;
    state.animateEventsNextRender = false;
    if (!shouldAnimate) {
      els.eventList.dataset.renderState = "ready";
      return;
    }

    window.requestAnimationFrame(() => {
      const cards = Array.from(
        els.eventList.querySelectorAll(".event-card-enter-prep")
      );
      cards.forEach((card) => {
        card.classList.remove("event-card-enter-prep");
        card.classList.add("event-card-enter");
      });
      els.eventList.dataset.renderState = "ready";
    });
  }

  function renderDeviceList(items) {
    if (!els.deviceList) {
      return;
    }
    if (!Array.isArray(items) || !items.length) {
      els.deviceList.innerHTML =
        '<div class="empty-state device-empty-state">当前账号下没有可切换的小爱设备。</div>';
      return;
    }

    els.deviceList.innerHTML = items
      .map((item) => {
        const meta = [item.hardware, item.model, item.miDid].filter(Boolean).join(" / ");
        return `<button class="device-item${
          item.selected ? " is-selected" : ""
        }" type="button" data-device-select="${escapeHtml(item.minaDeviceId || "")}">
          <div class="device-item-head">
            <span class="device-item-name">${escapeHtml(
              item.speakerName || item.hardware || item.minaDeviceId || "未命名设备"
            )}</span>
            ${
              item.selected
                ? '<span class="device-item-badge">当前设备</span>'
                : ""
            }
          </div>
          <div class="device-item-meta">${escapeHtml(meta || "缺少设备描述信息")}</div>
        </button>`;
      })
      .join("");
  }

  function buildDeviceListButtonLabel() {
    const bootstrap = state.bootstrap || {};
    const authenticated = Boolean(bootstrap.authenticated || bootstrap.ready);
    const ready = Boolean(bootstrap.ready);
    if (state.deviceListVisible) {
      return "收起列表";
    }
    if (!authenticated) {
      return "登录后选择";
    }
    return ready ? "切换设备" : "选择设备";
  }

  function setDeviceListVisible(visible) {
    state.deviceListVisible = Boolean(visible);
    if (els.deviceListShell) {
      els.deviceListShell.hidden = !state.deviceListVisible;
    }
    if (els.toggleDeviceListBtn) {
      els.toggleDeviceListBtn.textContent = buildDeviceListButtonLabel();
    }
  }

  async function refreshBootstrap(silent) {
    try {
      const preservedControlScrollTop =
        state.activeTab === "control" && els.controlScreenScroll
          ? els.controlScreenScroll.scrollTop
          : null;
      const preservedControlScrollRevision =
        state.activeTab === "control" ? state.controlScrollRevision : null;
      const payload = await apiFetch(API.bootstrap);
      renderBootstrap(payload);
      if (
        preservedControlScrollTop != null &&
        preservedControlScrollRevision === state.controlScrollRevision
      ) {
        window.requestAnimationFrame(() => {
          restoreControlScrollTop(preservedControlScrollTop);
        });
      }
      return true;
    } catch (error) {
      if (!silent) {
        showToast(error.message || String(error), "error");
      }
      return false;
    }
  }

  async function refreshConversations(silent) {
    try {
      const payload = await apiFetch(new URL("?limit=40", API.conversations));
      renderConversations(payload.items || []);
      return true;
    } catch (error) {
      if (!silent) {
        showToast(error.message || String(error), "error");
      }
      return false;
    }
  }

  async function refreshEvents(silent) {
    try {
      const payload = await apiFetch(new URL("?limit=120", API.events));
      const nextItems = Array.isArray(payload.items) ? payload.items : [];
      const nextSignature = buildEventRenderSignature(nextItems);
      state.eventItems = nextItems;
      state.eventItemsLoaded = true;
      maybeHandleLatestEventAudio(state.eventItems);
      if (state.activeTab === "events") {
        if (!isEventAudioPreviewPlaying() && nextSignature !== state.eventRenderSignature) {
          renderEvents(state.eventItems, { signature: nextSignature });
        }
      }
      return true;
    } catch (error) {
      if (els.eventList) {
        els.eventList.dataset.renderState = "ready";
      }
      if (!silent) {
        showToast(error.message || String(error), "error");
      }
      return false;
    }
  }

  async function refreshAll(silent) {
    await Promise.all([
      refreshBootstrap(silent),
      refreshConversations(silent),
      refreshEvents(silent),
    ]);
  }

  async function loadDeviceList() {
    if (state.deviceListLoading || !els.deviceList) {
      return;
    }
    state.deviceListLoading = true;
    els.deviceList.innerHTML =
      '<div class="empty-state device-empty-state">正在读取设备列表…</div>';
    try {
      const payload = await apiFetch(API.deviceList);
      state.deviceItems = Array.isArray(payload.items) ? payload.items : [];
      state.deviceListLoaded = true;
      renderDeviceList(state.deviceItems);
    } catch (error) {
      els.deviceList.innerHTML = `<div class="empty-state device-empty-state">${escapeHtml(
        error.message || String(error)
      )}</div>`;
      showToast(error.message || String(error), "error");
    } finally {
      state.deviceListLoading = false;
    }
  }

  async function toggleDeviceList() {
    const bootstrap = state.bootstrap || {};
    if (!bootstrap.ready && !bootstrap.authenticated) {
      showToast("请先登录账号，再选择设备。", "error");
      return;
    }
    setDeviceListVisible(!state.deviceListVisible);
    if (state.deviceListVisible && !state.deviceListLoaded) {
      await loadDeviceList();
    }
  }

  async function selectDevice(minaDeviceId) {
    if (!minaDeviceId) {
      return;
    }
    try {
      const payload = await postJson(API.deviceSelect, { minaDeviceId });
      showToast(payload.message || "设备已切换。", "success");
      state.deviceListLoaded = false;
      setDeviceListVisible(false);
      await refreshAll(true);
    } catch (error) {
      showToast(error.message || String(error), "error");
    }
  }

  async function handleAccountAction() {
    const action = els.accountActionBtn
      ? els.accountActionBtn.dataset.action || "logout"
      : "logout";

    if (action === "login") {
      const loginUrl =
        (els.accountActionBtn && els.accountActionBtn.dataset.loginUrl) ||
        (state.bootstrap && state.bootstrap.loginUrl);
      if (
        loginUrl &&
        openLoginWorkspace(
          loginUrl,
          (state.bootstrap && state.bootstrap.loginHint) || ""
        )
      ) {
        return;
      }
      await refreshBootstrap(false);
      const nextLoginUrl =
        (els.accountActionBtn && els.accountActionBtn.dataset.loginUrl) ||
        (state.bootstrap && state.bootstrap.loginUrl);
      if (
        nextLoginUrl &&
        openLoginWorkspace(
          nextLoginUrl,
          (state.bootstrap && state.bootstrap.loginHint) || ""
        )
      ) {
        return;
      }
      showToast("当前还没拿到可用的登录入口，请稍后再试。", "error");
      return;
    }

    if (els.accountActionBtn) {
      els.accountActionBtn.disabled = true;
    }
    try {
      const payload = await postJson(API.accountLogout, {});
      showToast(payload.message || "已退出登录。", "success");
      state.deviceItems = [];
      state.deviceListLoaded = false;
      setDeviceListVisible(false);
      await refreshAll(true);
      if (payload && payload.loginUrl && els.accountActionBtn) {
        els.accountActionBtn.dataset.loginUrl = payload.loginUrl;
      }
    } catch (error) {
      showToast(error.message || String(error), "error");
    } finally {
      if (els.accountActionBtn) {
        els.accountActionBtn.disabled = false;
      }
    }
  }

  async function sendCompose() {
    setActiveTab("chat", true);
    showComposer();

    const mode = state.composeMode;
    const text = els.composerInput ? els.composerInput.value.trim() : "";

    if (!text) {
      showToast("先输入一点内容再发送。", "error");
      return;
    }

    const originalLabel = els.sendBtn ? els.sendBtn.textContent : "发送";
    if (els.sendBtn) {
      els.sendBtn.disabled = true;
      els.sendBtn.textContent = mode === "chat" ? "发送中" : "播报中";
    }

    if (mode === "chat") {
      renderPendingConversation(text);
    }

    try {
      if (mode === "chat") {
        const payload = await postJson(API.chatSend, { text });
        showToast(payload.message || "消息已发给小爱。", "success");
      } else {
        const payload = await postJson(API.speak, { text });
        showToast(payload.message || "播报完成。", "success");
      }
      if (els.composerInput) {
        els.composerInput.value = "";
      }
      autoResizeComposer();
      await refreshAll(true);
    } catch (error) {
      if (mode === "chat") {
        await refreshConversations(true);
      }
      showToast(error.message || String(error), "error");
    } finally {
      if (els.sendBtn) {
        els.sendBtn.disabled = false;
        els.sendBtn.textContent = originalLabel;
      }
    }
  }

  async function sendAudioPlay() {
    const audioUrl = els.audioUrlInput ? els.audioUrlInput.value.trim() : "";

    if (!audioUrl) {
      showToast("先输入一个音频 URL。", "error");
      return;
    }

    const originalAudioLabel = els.audioSendBtn
      ? els.audioSendBtn.textContent
      : "播放";
    if (els.audioSendBtn) {
      els.audioSendBtn.disabled = true;
      els.audioSendBtn.textContent = "播放中";
    }

    try {
      const payload = await postJson(API.audioPlay, {
        url: audioUrl,
        interrupt: true,
        forceRetry: true,
      });
      clearSpeakerPauseMemory();
      if (payload && (payload.ok === false || payload.playback === "browser-fallback")) {
        throw new Error(payload.message || "音箱没有真正开始播放这段音频。");
      }
      const nextPlayback = {
        title:
          (payload && payload.title) ||
          normalizeAudioReplyTitle(payload && payload.detail) ||
          "最近一次音频",
        status: "playing",
        audioUrl: (payload && payload.url) || normalizeAudioEventUrl(audioUrl),
        positionSeconds: 0,
        durationSeconds: 0,
      };
      if (state.bootstrap) {
        state.bootstrap.audioPlayback = nextPlayback;
      }
      renderSpeakerCurrentAudio(nextPlayback);
      showToast(
        payload.message || "音频已准备好。",
        payload && payload.ok === false ? "error" : "success"
      );
      if (els.audioUrlInput) {
        els.audioUrlInput.value = "";
      }
      await refreshAll(true);
    } catch (error) {
      showToast(error.message || String(error), "error");
    } finally {
      if (els.audioSendBtn) {
        els.audioSendBtn.disabled = false;
        els.audioSendBtn.textContent = originalAudioLabel;
      }
    }
  }

  async function applyMode(mode) {
    els.modeButtons.forEach((button) => {
      button.disabled = true;
    });
    try {
      const payload = await postJson(API.mode, { mode });
      showToast(payload.message || "模式已更新。", "success");
      await refreshBootstrap(true);
      await refreshEvents(true);
    } catch (error) {
      showToast(error.message || String(error), "error");
    } finally {
      const ready = state.bootstrap ? Boolean(state.bootstrap.ready) : false;
      els.modeButtons.forEach((button) => {
        button.disabled = !ready;
      });
    }
  }

  async function applyWakeWordPattern() {
    const raw = els.wakeWordInput ? els.wakeWordInput.value.trim() : "";
    if (!raw) {
      showToast("请输入唤醒词或正则源码。", "error");
      return;
    }

    if (els.wakeWordSaveBtn) {
      els.wakeWordSaveBtn.disabled = true;
      els.wakeWordSaveBtn.textContent = "保存中";
    }

    try {
      const payload = await postJson(API.wakeWord, { pattern: raw });
      state.wakeWordDirty = false;
      showToast(payload.message || "唤醒词已更新。", "success");
      await refreshBootstrap(true);
      await refreshEvents(true);
    } catch (error) {
      showToast(error.message || String(error), "error");
    } finally {
      if (els.wakeWordSaveBtn) {
        els.wakeWordSaveBtn.disabled = false;
        els.wakeWordSaveBtn.textContent = "保存唤醒词";
      }
    }
  }

  function applySpeakerControlPayload(payload, fallbackCommand) {
    const volume =
      payload &&
      payload.volume &&
      typeof payload.volume.percent === "number"
        ? payload.volume
        : null;
    if (!volume) {
      if (fallbackCommand && fallbackCommand.kind === "volume") {
        state.currentVolumeValue = fallbackCommand.value;
        state.confirmedVolumeValue = fallbackCommand.value;
      }
      if (fallbackCommand && fallbackCommand.kind === "mute") {
        state.muted = Boolean(fallbackCommand.value);
        state.confirmedMuted = Boolean(fallbackCommand.value);
      }
      setSpeakerStatePending(false);
      renderSpeakerControlState();
      return;
    }

    state.hasVolumeSnapshot = true;
    if (state.bootstrap) {
      state.bootstrap.volume = {
        ...(state.bootstrap.volume || {}),
        ...volume,
      };
    }
    state.currentVolumeValue = clamp(Number(volume.percent) || 0, 0, 100);
    state.confirmedVolumeValue = state.currentVolumeValue;
    state.muted = Boolean(volume.muted);
    state.confirmedMuted = state.muted;
    state.deviceMuted = readVolumeDeviceMuted(volume);
    state.confirmedDeviceMuted = state.deviceMuted;
    state.unmuteBlocked = readVolumeUnmuteBlocked(volume);
    state.confirmedUnmuteBlocked = state.unmuteBlocked;
    state.muteSupported = readVolumeMuteSupported(volume);
    state.confirmedMuteSupported = state.muteSupported;
    setSpeakerStatePending(Boolean(volume.pending));
    renderSpeakerControlState();
  }

  function scheduleSpeakerControlVerification(attempt) {
    clearSpeakerStatePendingTimer();
    if (!state.speakerStatePending || state.speakerControlInFlight || state.speakerControlQueued) {
      return;
    }
    const delays = [700, 1500, 2600];
    const index = clamp(Number(attempt) || 0, 0, delays.length - 1);
    state.speakerStatePendingTimer = window.setTimeout(async () => {
      state.speakerStatePendingTimer = null;
      const ok = await refreshBootstrap(true);
      if (
        ok &&
        state.bootstrap &&
        state.bootstrap.volume &&
        state.bootstrap.volume.pending &&
        index < delays.length - 1
      ) {
        scheduleSpeakerControlVerification(index + 1);
      }
    }, delays[index]);
  }

  async function flushSpeakerControlQueue() {
    if (state.speakerControlInFlight || !state.speakerControlQueued) {
      return;
    }

    const command = state.speakerControlQueued;
    state.speakerControlQueued = null;
    state.speakerControlInFlight = command;
    setSpeakerStatePending(true);
    renderSpeakerControlState();

    try {
      const payload =
        command.kind === "mute"
          ? await postJson(API.mute, { muted: Boolean(command.value) })
          : await postJson(API.volume, { volume: command.value });
      applySpeakerControlPayload(payload, command);
      if (!command.silentToast) {
        showToast(
          payload && payload.message
            ? payload.message
            : command.kind === "mute"
              ? Boolean(command.value)
                ? "已打开播放静音。"
                : "已关闭播放静音。"
              : `播放音量已设为 ${command.value}%。`,
          "success"
        );
      }
      if (state.activeTab === "events") {
        await refreshEvents(true);
      }
    } catch (error) {
      const errorPayload =
        error && typeof error === "object" && error.payload ? error.payload : null;
      if (errorPayload && errorPayload.volume) {
        applySpeakerControlPayload(errorPayload, command);
      } else {
        state.currentVolumeValue = state.confirmedVolumeValue;
        state.muted = state.confirmedMuted;
        state.deviceMuted = state.confirmedDeviceMuted;
        state.unmuteBlocked = state.confirmedUnmuteBlocked;
        state.muteSupported = state.confirmedMuteSupported;
        setSpeakerStatePending(false);
        renderSpeakerControlState();
      }
      showToast(error.message || String(error), "error");
    } finally {
      state.speakerControlInFlight = null;
      if (state.speakerControlQueued) {
        renderSpeakerControlState();
        void flushSpeakerControlQueue();
      } else {
        renderSpeakerControlState();
        scheduleSpeakerControlVerification(0);
      }
    }
  }

  function enqueueSpeakerControlCommand(command, options) {
    const normalized = normalizeSpeakerControlCommand(command);
    if (!normalized || !state.hasVolumeSnapshot) {
      renderSpeakerControlState();
      return;
    }

    const nextCommand = {
      ...normalized,
      silentToast: Boolean(options && options.silentToast),
    };
    const currentPending = state.speakerControlQueued || state.speakerControlInFlight;
    const idleAndMatched =
      !currentPending &&
      !state.speakerStatePending &&
      (
        (nextCommand.kind === "volume" &&
          nextCommand.value === state.confirmedVolumeValue) ||
        (nextCommand.kind === "mute" &&
          nextCommand.value === state.confirmedMuted)
      );
    if (idleAndMatched) {
      renderSpeakerControlState();
      return;
    }

    state.speakerControlQueued = sameSpeakerControlCommand(
      state.speakerControlQueued,
      nextCommand
    )
      ? state.speakerControlQueued
      : nextCommand;
    setSpeakerStatePending(true);
    renderSpeakerControlState();
    void flushSpeakerControlQueue();
  }

  function scheduleVolumeCommit(immediate, silentToast) {
    window.clearTimeout(state.volumeInputTimer);
    if (immediate) {
      enqueueSpeakerControlCommand(
        { kind: "volume", value: state.currentVolumeValue },
        { silentToast: Boolean(silentToast) }
      );
      return;
    }
    state.volumeInputTimer = window.setTimeout(() => {
      state.volumeInputTimer = null;
      enqueueSpeakerControlCommand(
        { kind: "volume", value: state.currentVolumeValue },
        { silentToast: Boolean(silentToast) }
      );
    }, 180);
  }

  async function applyDialogWindowSeconds() {
    if (state.dialogWindowSaving) {
      return;
    }
    const raw = els.dialogWindowInput ? els.dialogWindowInput.value.trim() : "";
    if (!raw) {
      updateDialogWindowDisplay(state.currentDialogWindowValue, {
        forceInput: true,
      });
      state.dialogWindowDirty = false;
      showToast("请输入 5 到 300 秒之间的时长。", "error");
      return;
    }
    const seconds = clamp(
      Number(raw) || 0,
      MIN_DIALOG_WINDOW_SECONDS,
      MAX_DIALOG_WINDOW_SECONDS
    );
    if (seconds === state.currentDialogWindowValue && !state.dialogWindowDirty) {
      updateDialogWindowDisplay(seconds, { forceInput: true });
      return;
    }
    state.dialogWindowSaving = true;
    try {
      const payload = await postJson(API.dialogWindow, { seconds });
      state.dialogWindowDirty = false;
      updateDialogWindowDisplay(seconds, { forceInput: true });
      showToast(payload.message || `唤醒窗口已自动保存为 ${seconds} 秒。`, "success");
      await refreshBootstrap(true);
      await refreshEvents(true);
    } catch (error) {
      showToast(error.message || String(error), "error");
    } finally {
      state.dialogWindowSaving = false;
    }
  }

  async function applyOpenclawContextTokens() {
    if (state.openclawContextTokensSaving) {
      return;
    }
    const tokensRaw = els.openclawContextTokensInput
      ? normalizeIntegerText(
          els.openclawContextTokensInput.value,
          MAX_OPENCLAW_CONTEXT_TOKENS
        )
      : "";

    if (els.openclawContextTokensInput) {
      els.openclawContextTokensInput.value = tokensRaw;
    }

    if (!tokensRaw) {
      state.openclawContextTokensDirty = false;
      updateOpenclawContextTokensDisplay(
        state.currentOpenclawContextTokensValue,
        { forceInput: true }
      );
      return;
    }

    const contextTokens = clamp(
      Number(tokensRaw) || DEFAULT_OPENCLAW_CONTEXT_TOKENS,
      MIN_OPENCLAW_CONTEXT_TOKENS,
      MAX_OPENCLAW_CONTEXT_TOKENS
    );

    if (
      contextTokens === state.currentOpenclawContextTokensValue &&
      !state.openclawContextTokensDirty
    ) {
      updateOpenclawContextTokensDisplay(contextTokens, { forceInput: true });
      return;
    }

    state.openclawContextTokensSaving = true;
    try {
      const payload = await postJson(API.contextTokens, { contextTokens });
      state.openclawContextTokensDirty = false;
      const nextTokens = getFiniteNumber(
        payload && payload.contextTokens,
        contextTokens
      );
      updateOpenclawContextTokensDisplay(nextTokens, { forceInput: true });
      showToast(
        payload && payload.message
          ? payload.message
          : `xiaoai agent 上下文窗口已保存为 ${nextTokens} tokens。`,
        "success"
      );
      await refreshBootstrap(true);
      if (state.activeTab === "events") {
        await refreshEvents(true);
      }
    } catch (error) {
      showToast(error.message || String(error), "error");
    } finally {
      state.openclawContextTokensSaving = false;
    }
  }

  async function applyVoiceSystemPrompt() {
    if (state.workspaceFileSaving) {
      return;
    }
    const selected = getSelectedWorkspaceFile();
    if (!selected) {
      showToast("当前没有可编辑的 workspace 文件。", "error");
      return;
    }
    const raw = els.voiceSystemPromptInput
      ? normalizeVoiceSystemPromptInput(els.voiceSystemPromptInput.value)
      : "";
    const trimmed = raw.trim();
    const previous = getWorkspaceFileBaseValue(selected).trim();
    if (
      !state.workspaceFileDirty[selected.id] &&
      trimmed === previous
    ) {
      renderWorkspaceFileEditor();
      return;
    }

    state.workspaceFileSaving = true;
    renderWorkspaceFileEditor();
    try {
      const payload = await postJson(API.workspaceFile, {
        file: selected.filename,
        content: raw,
        enabled: true,
      });
      state.workspaceFileDirty[selected.id] = false;
      state.workspaceFileDrafts[selected.id] =
        payload && payload.file
          ? normalizeVoiceSystemPromptInput(payload.file.content || payload.file.defaultContent || "")
          : raw;
      showToast(
        payload && payload.message
          ? payload.message
          : `xiaoai agent workspace 的 ${selected.filename} 已保存。`,
        "success"
      );
      await refreshBootstrap(true);
      if (state.activeTab === "events") {
        await refreshEvents(true);
      }
    } catch (error) {
      showToast(error.message || String(error), "error");
    } finally {
      state.workspaceFileSaving = false;
      renderWorkspaceFileEditor();
    }
  }

  async function disableSelectedWorkspaceFile() {
    if (state.workspaceFileSaving) {
      return;
    }
    const selected = getSelectedWorkspaceFile();
    if (!selected) {
      showToast("当前没有可禁用的 workspace 文件。", "error");
      return;
    }
    if (!selected.disableAllowed) {
      showToast(`${selected.filename} 是核心提示文件，当前不支持禁用。`, "error");
      return;
    }
    state.workspaceFileSaving = true;
    renderWorkspaceFileEditor();
    try {
      const payload = await postJson(API.workspaceFile, {
        file: selected.filename,
        enabled: false,
      });
      state.workspaceFileDirty[selected.id] = false;
      state.workspaceFileDrafts[selected.id] = normalizeVoiceSystemPromptInput(
        selected.defaultContent || ""
      );
      showToast(
        payload && payload.message
          ? payload.message
          : `已禁用 xiaoai agent workspace 的 ${selected.filename}。`,
        "success"
      );
      await refreshBootstrap(true);
      if (state.activeTab === "events") {
        await refreshEvents(true);
      }
    } catch (error) {
      showToast(error.message || String(error), "error");
    } finally {
      state.workspaceFileSaving = false;
      renderWorkspaceFileEditor();
    }
  }

  async function applyTransitionPhrases() {
    if (state.transitionPhrasesSaving) {
      return;
    }
    const nextPhrases = els.transitionPhrasesInput
      ? normalizeTransitionPhrasesList(els.transitionPhrasesInput.value)
      : [];
    const previousPhrases = normalizeTransitionPhrasesList(
      state.currentTransitionPhrasesValue
    );
    if (
      !state.transitionPhrasesDirty &&
      JSON.stringify(nextPhrases) === JSON.stringify(previousPhrases)
    ) {
      updateTransitionPhrasesDisplay(state.currentTransitionPhrasesValue, {
        forceInput: true,
      });
      return;
    }

    state.transitionPhrasesSaving = true;
    if (els.transitionPhrasesSaveBtn) {
      els.transitionPhrasesSaveBtn.disabled = true;
      els.transitionPhrasesSaveBtn.textContent = "保存中";
    }
    try {
      const payload = await postJson(API.transitionPhrases, {
        phrases: nextPhrases,
      });
      state.transitionPhrasesDirty = false;
      updateTransitionPhrasesDisplay(
        Array.isArray(payload && payload.phrases) ? payload.phrases : nextPhrases,
        { forceInput: true }
      );
      showToast(
        payload && payload.message
          ? payload.message
          : nextPhrases.length
            ? "过渡播报词已保存。"
            : "已恢复默认过渡播报词。",
        "success"
      );
      await refreshBootstrap(true);
      if (state.activeTab === "events") {
        await refreshEvents(true);
      }
    } catch (error) {
      showToast(error.message || String(error), "error");
    } finally {
      state.transitionPhrasesSaving = false;
      if (els.transitionPhrasesSaveBtn) {
        els.transitionPhrasesSaveBtn.disabled = false;
        els.transitionPhrasesSaveBtn.textContent = "保存";
      }
    }
  }

  function commitOpenclawContextTokensFromBlur() {
    window.setTimeout(() => {
      const active = document.activeElement;
      if (active === els.openclawContextTokensInput) {
        return;
      }
      if (state.openclawContextTokensDirty) {
        void applyOpenclawContextTokens();
        return;
      }
      if (els.openclawContextTokensInput && !els.openclawContextTokensInput.value.trim()) {
        updateOpenclawContextTokensDisplay(
          state.currentOpenclawContextTokensValue,
          { forceInput: true }
        );
      }
    }, 0);
  }

  async function waitForGatewayRestartRecovery() {
    const delays = [900, 1800, 3200, 5200];
    for (const delay of delays) {
      await sleep(delay);
      const ready = await refreshBootstrap(true);
      if (ready) {
        if (state.activeTab === "control") {
          await refreshOpenclawModelState(true, { preserveOnError: true });
        }
        if (state.activeTab === "chat") {
          await refreshConversations(true);
        }
        if (state.activeTab === "events") {
          await refreshEvents(true);
        }
        return true;
      }
    }
    return false;
  }

  async function applyOpenclawModel(modelRef) {
    const nextModel = String(modelRef || "").trim();
    if (!nextModel) {
      showToast("请选择一个模型。", "error");
      renderOpenclawModelControl(
        state.openclawAgentId,
        state.openclawModel,
        state.openclawModels
      );
      return;
    }
    if (state.openclawModelSaving) {
      return;
    }
    const previousModel = state.openclawModel;
    state.openclawModelSaving = true;
    renderOpenclawModelControl(
      state.openclawAgentId,
      nextModel,
      state.openclawModels
    );
    try {
      const payload = await postJson(API.openclawModel, {
        model: nextModel,
      });
      const confirmedModel =
        payload && typeof payload.model === "string" && payload.model.trim()
          ? payload.model.trim()
          : nextModel;
      renderOpenclawModelControl(
        payload && payload.agentId ? payload.agentId : state.openclawAgentId,
        confirmedModel,
        state.openclawModels
      );
      showToast(
        payload && payload.message
          ? payload.message
          : `模型已切换为 ${confirmedModel}。`,
        "success"
      );
      if (!payload || payload.restarting !== false) {
        void waitForGatewayRestartRecovery();
      } else {
        await refreshBootstrap(true);
        await refreshOpenclawModelState(true, { preserveOnError: true });
      }
    } catch (error) {
      renderOpenclawModelControl(
        state.openclawAgentId,
        previousModel,
        state.openclawModels
      );
      showToast(error.message || String(error), "error");
    } finally {
      state.openclawModelSaving = false;
      renderOpenclawModelControl(
        state.openclawAgentId,
        state.openclawModel,
        state.openclawModels
      );
    }
  }

  async function applyOpenclawRoute(options) {
    if (state.openclawRouteSaving) {
      return;
    }

    const disableNotification = Boolean(options && options.disableNotification);
    const channel = els.openclawRouteChannelSelect
      ? String(els.openclawRouteChannelSelect.value || "").trim()
      : "";
    const target = els.openclawRouteTargetInput
      ? String(els.openclawRouteTargetInput.value || "").trim()
      : "";

    if (!disableNotification && !channel) {
      showToast("请先选择一个通知渠道。", "error");
      return;
    }

    state.openclawRouteSaving = true;
    if (els.openclawRouteChannelSelect) {
      els.openclawRouteChannelSelect.disabled = true;
    }
    if (els.openclawRouteTargetInput) {
      els.openclawRouteTargetInput.disabled = true;
    }
    if (els.openclawRouteSaveBtn) {
      els.openclawRouteSaveBtn.disabled = true;
    }
    if (els.openclawRouteDisableBtn) {
      els.openclawRouteDisableBtn.disabled = true;
    }

    try {
      const payload = await postJson(
        API.openclawRoute,
        disableNotification
          ? {
              channel,
              disableNotification: true,
            }
          : Object.assign(
              { channel },
              target ? { target } : {}
            )
      );
      state.openclawRouteDirty = false;
      renderOpenclawRouteControl(payload && payload.route);
      showToast(
        payload && payload.message
          ? payload.message
          : disableNotification
            ? "已关闭插件通知。"
            : "插件通知渠道已保存。",
        "success"
      );
      await refreshBootstrap(true);
      if (state.activeTab === "events") {
        await refreshEvents(true);
      }
    } catch (error) {
      showToast(error.message || String(error), "error");
      await refreshBootstrap(true);
    } finally {
      state.openclawRouteSaving = false;
      renderOpenclawRouteControl(state.bootstrap && state.bootstrap.openclawRoute);
    }
  }

  async function applyThinkingEnabled(enabled) {
    if (state.thinkingSaving) {
      return;
    }
    state.thinkingSaving = true;
    if (els.thinkingOffToggle) {
      els.thinkingOffToggle.disabled = true;
    }
    try {
      const payload = await postJson(API.thinking, {
        thinkingEnabled: Boolean(enabled),
      });
      renderThinkingToggle(
        Boolean(
          payload && Object.prototype.hasOwnProperty.call(payload, "thinkingEnabled")
            ? payload.thinkingEnabled
            : enabled
        )
      );
      showToast(
        payload && payload.message
          ? payload.message
          : enabled
            ? "已打开思考。"
            : "已关闭思考。",
        "success"
      );
      await refreshBootstrap(true);
      if (state.activeTab === "events") {
        await refreshEvents(true);
      }
    } catch (error) {
      renderThinkingToggle(state.thinkingEnabled);
      showToast(error.message || String(error), "error");
    } finally {
      state.thinkingSaving = false;
      if (els.thinkingOffToggle) {
        els.thinkingOffToggle.disabled = false;
      }
    }
  }

  async function applyForceNonStreamingEnabled(enabled) {
    if (state.forceNonStreamingSaving) {
      return;
    }
    state.forceNonStreamingSaving = true;
    if (els.forceNonStreamingToggle) {
      els.forceNonStreamingToggle.disabled = true;
    }
    try {
      const payload = await postJson(API.nonStreaming, {
        forceNonStreamingEnabled: Boolean(enabled),
      });
      renderForceNonStreamingToggle(
        Boolean(
          payload && Object.prototype.hasOwnProperty.call(payload, "enabled")
            ? payload.enabled
            : enabled
        )
      );
      showToast(
        payload && payload.message
          ? payload.message
          : enabled
            ? "已开启强制非流式请求。"
            : "已关闭强制非流式请求。",
        "success"
      );
      await refreshBootstrap(true);
      if (payload && payload.restarting) {
        window.setTimeout(() => {
          void refreshBootstrap(true);
        }, 2600);
      }
      if (state.activeTab === "events") {
        await refreshEvents(true);
      }
    } catch (error) {
      renderForceNonStreamingToggle(state.forceNonStreamingEnabled);
      showToast(error.message || String(error), "error");
    } finally {
      state.forceNonStreamingSaving = false;
      if (els.forceNonStreamingToggle) {
        els.forceNonStreamingToggle.disabled = false;
      }
    }
  }

  async function applyDebugLogEnabled(enabled) {
    if (state.debugLogSaving) {
      return;
    }
    state.debugLogSaving = true;
    if (els.debugLogToggle) {
      els.debugLogToggle.disabled = true;
    }
    try {
      const payload = await postJson(API.debugLog, {
        debugLogEnabled: Boolean(enabled),
      });
      renderDebugLogToggle(
        Boolean(
          payload && Object.prototype.hasOwnProperty.call(payload, "enabled")
            ? payload.enabled
            : enabled
        )
      );
      showToast(
        payload && payload.message
          ? payload.message
          : enabled
            ? "已打开调试日志。"
            : "已关闭调试日志。",
        "success"
      );
      await refreshBootstrap(true);
      if (state.activeTab === "events") {
        await refreshEvents(true);
      }
    } catch (error) {
      renderDebugLogToggle(state.debugLogEnabled);
      showToast(error.message || String(error), "error");
    } finally {
      state.debugLogSaving = false;
      if (els.debugLogToggle) {
        els.debugLogToggle.disabled = false;
      }
    }
  }

  async function applyAudioCalibration() {
    if (state.audioCalibrationRunning) {
      return;
    }
    state.audioCalibrationRunning = true;
    renderCalibrationControl();
    try {
      const payload = await postJson(API.audioCalibration, {});
      showToast(
        payload && payload.message
          ? payload.message
          : "静音校准完成。",
        "success"
      );
      await refreshBootstrap(true);
      if (state.activeTab === "events") {
        await refreshEvents(true);
      }
    } catch (error) {
      showToast(error.message || String(error), "error");
      await refreshBootstrap(true);
    } finally {
      state.audioCalibrationRunning = false;
      renderCalibrationControl();
    }
  }

  async function applyConversationInterceptCalibration() {
    if (state.conversationInterceptCalibrationRunning) {
      return;
    }
    state.conversationInterceptCalibrationRunning = true;
    renderCalibrationControl();
    try {
      const payload = await postJson(API.conversationInterceptCalibration, {});
      showToast(
        payload && payload.message
          ? payload.message
          : "对话拦截校准完成。",
        "success"
      );
      await refreshBootstrap(true);
      if (state.activeTab === "events") {
        await refreshEvents(true);
      }
    } catch (error) {
      showToast(error.message || String(error), "error");
      await refreshBootstrap(true);
    } finally {
      state.conversationInterceptCalibrationRunning = false;
      renderCalibrationControl();
    }
  }

  async function applySelectedCalibration() {
    if (getSelectedCalibrationMode() === "conversation") {
      await applyConversationInterceptCalibration();
      return;
    }
    await applyAudioCalibration();
  }

  async function applyPollInterval() {
    if (state.pollIntervalSaving) {
      return;
    }
    const pollIntervalMs = clamp(
      Math.round(Number(state.currentPollIntervalMs) || 0),
      MIN_CONVERSATION_POLL_INTERVAL_MS,
      MAX_CONVERSATION_POLL_INTERVAL_MS
    );
    state.pollIntervalSaving = true;
    renderCalibrationControl();
    try {
      const payload = await postJson(API.pollInterval, { pollIntervalMs });
      const nextPollIntervalMs = getFiniteNumber(
        payload && payload.pollIntervalMs,
        pollIntervalMs
      );
      state.pollIntervalDirty = false;
      updatePollIntervalDisplay(nextPollIntervalMs, { forceText: true });
      if (state.bootstrap) {
        state.bootstrap.conversationInterceptCalibration = Object.assign(
          {},
          state.bootstrap.conversationInterceptCalibration,
          payload && payload.calibration,
          { pollIntervalMs: nextPollIntervalMs }
        );
      }
      const warning =
        payload && payload.warning
          ? String(payload.warning)
          : buildLowPollIntervalWarning(nextPollIntervalMs);
      const toastMessage =
        payload && payload.message
          ? String(payload.message)
          : warning
            ? `轮询间隔已更新为 ${nextPollIntervalMs}ms。${warning}`
            : "轮询间隔已更新。";
      showToast(
        toastMessage,
        warning ? "warn" : "success"
      );
      await refreshBootstrap(true);
    } catch (error) {
      state.pollIntervalDirty = false;
      updatePollIntervalDisplay(state.confirmedPollIntervalMs, {
        forceText: true,
      });
      showToast(error.message || String(error), "error");
      await refreshBootstrap(true);
    } finally {
      state.pollIntervalSaving = false;
      renderCalibrationControl();
    }
  }

  async function applyConversationInterceptManualOffset() {
    if (state.conversationInterceptManualOffsetSaving) {
      return;
    }
    const manualOffsetMs = normalizeConversationInterceptManualOffsetMs(
      state.currentConversationInterceptManualOffsetMs
    );
    state.conversationInterceptManualOffsetSaving = true;
    renderCalibrationControl();
    try {
      const payload = await postJson(API.conversationInterceptOffset, {
        manualOffsetMs,
      });
      const nextManualOffsetMs = normalizeConversationInterceptManualOffsetMs(
        getFiniteNumber(payload && payload.manualOffsetMs, manualOffsetMs)
      );
      updateConversationInterceptManualOffsetDisplay(nextManualOffsetMs, {
        forceValue: true,
      });
      if (state.bootstrap) {
        state.bootstrap.conversationInterceptCalibration = Object.assign(
          {},
          state.bootstrap.conversationInterceptCalibration,
          payload && payload.calibration,
          { manualOffsetMs: nextManualOffsetMs }
        );
      }
      showToast(
        payload && payload.message
          ? String(payload.message)
          : `对话拦截微调已更新为 ${formatConversationInterceptManualOffset(
              nextManualOffsetMs
            )}。`,
        "success"
      );
      await refreshBootstrap(true);
    } catch (error) {
      updateConversationInterceptManualOffsetDisplay(
        state.confirmedConversationInterceptManualOffsetMs,
        { forceValue: true }
      );
      showToast(error.message || String(error), "error");
      await refreshBootstrap(true);
    } finally {
      state.conversationInterceptManualOffsetSaving = false;
      renderCalibrationControl();
    }
  }

  async function applyAudioTailPadding() {
    if (state.audioTailPaddingSaving) {
      return;
    }
    const tailPaddingMs = clamp(
      Math.round(Number(state.currentAudioTailPaddingMs) || 0),
      0,
      MAX_AUDIO_TAIL_PADDING_MS
    );
    state.audioTailPaddingSaving = true;
    renderCalibrationControl();
    try {
      const payload = await postJson(API.audioTailPadding, { tailPaddingMs });
      const nextTailPaddingMs = getFiniteNumber(
        payload && payload.tailPaddingMs,
        tailPaddingMs
      );
      state.audioTailPaddingDirty = false;
      updateAudioTailPaddingDisplay(nextTailPaddingMs, { forceText: true });
      if (state.bootstrap) {
        state.bootstrap.audioCalibration = Object.assign(
          {},
          state.bootstrap.audioCalibration,
          payload && payload.calibration,
          { tailPaddingMs: nextTailPaddingMs }
        );
      }
      showToast(
        payload && payload.message ? payload.message : "空余延迟已更新。",
        "success"
      );
      await refreshBootstrap(true);
    } catch (error) {
      state.audioTailPaddingDirty = false;
      updateAudioTailPaddingDisplay(state.confirmedAudioTailPaddingMs, {
        forceText: true,
      });
      showToast(error.message || String(error), "error");
      await refreshBootstrap(true);
    } finally {
      state.audioTailPaddingSaving = false;
      renderCalibrationControl();
    }
  }

  async function applyMuted(enabled) {
    enqueueSpeakerControlCommand(
      { kind: "mute", value: Boolean(enabled) },
      { silentToast: false }
    );
  }

  async function wakeUp() {
    if (els.wakeBtn) {
      els.wakeBtn.disabled = true;
    }
    try {
      const payload = await postJson(API.wake, {});
      showToast(payload.message || "唤醒指令已发送。", "success");
      await refreshBootstrap(true);
      await refreshEvents(true);
    } catch (error) {
      showToast(error.message || String(error), "error");
    } finally {
      if (els.wakeBtn) {
        els.wakeBtn.disabled = false;
      }
    }
  }

  function installRefreshTimer() {
    window.clearInterval(state.refreshTimer);
    state.refreshTimer = window.setInterval(() => {
      refreshBootstrap(true);
      if (state.activeTab === "chat") {
        refreshConversations(true);
      }
      if (state.activeTab === "chat" || state.activeTab === "events") {
        refreshEvents(true);
      }
    }, 3000);
  }

  function bindChatScroll() {
    if (!els.conversationScroll) {
      return;
    }
    els.conversationScroll.addEventListener("scroll", () => {
      const current = els.conversationScroll.scrollTop;
      const delta = current - state.lastChatScrollTop;
      state.lastChatScrollTop = current;
      if (isNearBottom(els.conversationScroll) || delta > 8) {
        showComposer();
      } else if (delta < -8 && current > 18) {
        hideComposer();
      }
    });
  }

  if (els.controlScreenScroll) {
    els.controlScreenScroll.addEventListener("scroll", () => {
      state.controlScrollRevision += 1;
    });
  }

  els.composeButtons.forEach((button) => {
    button.addEventListener("click", () =>
      setComposeMode(button.dataset.composeMode)
    );
  });

  els.tabButtons.forEach((button) => {
    button.setAttribute("role", "tab");
    button.addEventListener("click", () => {
      setActiveTab(button.dataset.consoleTab, true);
    });
  });

  els.modeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const mode = button.dataset.modeChoice;
      if (!mode) {
        return;
      }
      applyMode(mode);
    });
  });

  if (els.toggleDeviceListBtn) {
    els.toggleDeviceListBtn.addEventListener("click", () => {
      void toggleDeviceList();
    });
  }

  if (els.deviceList) {
    els.deviceList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-device-select]");
      if (!button) {
        return;
      }
      void selectDevice(button.dataset.deviceSelect || "");
    });
  }

  if (els.accountActionBtn) {
    els.accountActionBtn.addEventListener("click", () => {
      void handleAccountAction();
    });
  }

  if (els.currentAudioPauseBtn) {
    els.currentAudioPauseBtn.addEventListener("click", () => {
      void pauseCurrentAudio();
    });
  }

  if (els.currentAudioStartBtn) {
    els.currentAudioStartBtn.addEventListener("click", () => {
      void startCurrentAudio();
    });
  }

  if (els.currentAudioStopBtn) {
    els.currentAudioStopBtn.addEventListener("click", () => {
      void stopCurrentAudio();
    });
  }

  if (els.loginWorkspaceCloseBtn) {
    els.loginWorkspaceCloseBtn.addEventListener("click", () => {
      closeLoginWorkspace();
    });
  }

  if (els.loginWorkspaceBackdrop) {
    els.loginWorkspaceBackdrop.addEventListener("click", () => {
      closeLoginWorkspace();
    });
  }

  if (els.loginWorkspaceFrame) {
    els.loginWorkspaceFrame.addEventListener("load", () => {
      window.setTimeout(() => syncLoginWorkspaceFrameHeight(), 40);
      window.setTimeout(() => syncLoginWorkspaceFrameHeight(), 180);
    });
  }

  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) {
      return;
    }
    const payload = event.data || {};
    if (payload.source !== "xiaoai-cloud-portal") {
      return;
    }
    const detail = payload.payload || {};
    if (payload.type === "layout") {
      syncLoginWorkspaceFrameHeight(detail.height);
      return;
    }
    if (els.loginWorkspaceHint && typeof detail.message === "string" && detail.message) {
      els.loginWorkspaceHint.textContent = normalizeLoginWorkspaceHint(
        detail.message
      );
    } else if (
      els.loginWorkspaceHint &&
      typeof detail.text === "string" &&
      detail.text
    ) {
      els.loginWorkspaceHint.textContent = normalizeLoginWorkspaceHint(
        detail.text
      );
    }
    if (payload.type === "session" && detail.status === "success") {
      state.pendingDeviceSelectionAfterLogin = true;
      closeLoginWorkspace();
      showToast(detail.message || "登录完成。", "success");
      setActiveTab("overview", true);
      void refreshAll(true);
    }
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.loginWorkspaceOpen) {
      closeLoginWorkspace();
    }
  });

  if (els.wakeWordInput) {
    els.wakeWordInput.addEventListener("input", () => {
      state.wakeWordDirty = true;
    });
    els.wakeWordInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void applyWakeWordPattern();
      }
    });
  }

  if (els.wakeWordSaveBtn) {
    els.wakeWordSaveBtn.addEventListener("click", () => {
      void applyWakeWordPattern();
    });
  }

  if (els.voiceSystemPromptInput) {
    els.voiceSystemPromptInput.addEventListener("input", () => {
      const selected = getSelectedWorkspaceFile();
      if (!selected) {
        return;
      }
      state.workspaceFileDirty[selected.id] = true;
      const normalized = normalizeVoiceSystemPromptInput(
        els.voiceSystemPromptInput.value
      );
      if (normalized !== els.voiceSystemPromptInput.value) {
        els.voiceSystemPromptInput.value = normalized;
      }
      state.workspaceFileDrafts[selected.id] = normalized;
    });
    els.voiceSystemPromptInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void applyVoiceSystemPrompt();
      }
    });
  }

  if (els.voiceSystemPromptSaveBtn) {
    els.voiceSystemPromptSaveBtn.addEventListener("click", () => {
      void applyVoiceSystemPrompt();
    });
  }

  if (els.workspaceFileSelect) {
    els.workspaceFileSelect.addEventListener("change", () => {
      state.selectedWorkspaceFileId = String(els.workspaceFileSelect.value || "").trim();
      renderWorkspaceFileEditor();
    });
  }

  if (els.workspaceFileDisableBtn) {
    els.workspaceFileDisableBtn.addEventListener("click", () => {
      void disableSelectedWorkspaceFile();
    });
  }

  if (els.transitionPhrasesInput) {
    els.transitionPhrasesInput.addEventListener("input", () => {
      state.transitionPhrasesDirty = true;
      const normalized = normalizeTransitionPhrasesInput(
        els.transitionPhrasesInput.value
      );
      if (normalized !== els.transitionPhrasesInput.value) {
        els.transitionPhrasesInput.value = normalized;
      }
    });
    els.transitionPhrasesInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void applyTransitionPhrases();
      }
    });
  }

  if (els.transitionPhrasesSaveBtn) {
    els.transitionPhrasesSaveBtn.addEventListener("click", () => {
      void applyTransitionPhrases();
    });
  }

  if (els.thinkingOffToggle) {
    els.thinkingOffToggle.addEventListener("click", () => {
      void applyThinkingEnabled(!state.thinkingEnabled);
    });
  }

  if (els.forceNonStreamingToggle) {
    els.forceNonStreamingToggle.addEventListener("click", () => {
      void applyForceNonStreamingEnabled(!state.forceNonStreamingEnabled);
    });
  }

  if (els.openclawModelSelect) {
    els.openclawModelSelect.addEventListener("change", () => {
      void applyOpenclawModel(els.openclawModelSelect.value);
    });
  }

  if (els.openclawRouteChannelSelect) {
    els.openclawRouteChannelSelect.addEventListener("change", () => {
      state.openclawRouteDirty = true;
      state.openclawRouteChannel = String(
        els.openclawRouteChannelSelect.value || ""
      ).trim();
      const currentChannel = state.openclawRouteChannels.find(
        (item) => item.id === state.openclawRouteChannel
      );
      if (
        els.openclawRouteTargetInput &&
        !String(els.openclawRouteTargetInput.value || "").trim() &&
        currentChannel &&
        currentChannel.targets.length === 1
      ) {
        state.openclawRouteTarget = currentChannel.targets[0];
        els.openclawRouteTargetInput.value = currentChannel.targets[0];
      }
      renderOpenclawRouteControl(state.bootstrap && state.bootstrap.openclawRoute);
    });
  }

  if (els.openclawRouteTargetInput) {
    els.openclawRouteTargetInput.addEventListener("input", () => {
      state.openclawRouteDirty = true;
      state.openclawRouteTarget = String(
        els.openclawRouteTargetInput.value || ""
      ).trim();
    });
    els.openclawRouteTargetInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void applyOpenclawRoute();
      }
    });
  }

  if (els.openclawRouteSaveBtn) {
    els.openclawRouteSaveBtn.addEventListener("click", () => {
      void applyOpenclawRoute();
    });
  }

  if (els.openclawRouteDisableBtn) {
    els.openclawRouteDisableBtn.addEventListener("click", () => {
      void applyOpenclawRoute({ disableNotification: true });
    });
  }

  if (els.debugLogToggle) {
    els.debugLogToggle.addEventListener("click", () => {
      void applyDebugLogEnabled(!state.debugLogEnabled);
    });
  }

  if (els.calibrationModeSelect) {
    els.calibrationModeSelect.addEventListener("change", () => {
      state.selectedCalibrationMode =
        els.calibrationModeSelect.value === "conversation"
          ? "conversation"
          : "audio";
      renderCalibrationControl();
    });
  }

  if (els.calibrationRunBtn) {
    els.calibrationRunBtn.addEventListener("click", () => {
      void applySelectedCalibration();
    });
  }

  if (els.volumeMuteToggle) {
    els.volumeMuteToggle.addEventListener("click", () => {
      if (
        state.speakerControlInFlight &&
        state.speakerControlInFlight.kind === "mute"
      ) {
        return;
      }
      const pendingMuteCommand =
        state.speakerControlQueued && state.speakerControlQueued.kind === "mute"
          ? state.speakerControlQueued
          : null;
      void applyMuted(
        pendingMuteCommand ? !Boolean(pendingMuteCommand.value) : !state.muted
      );
    });
  }

  if (els.statVolume) {
    els.statVolume.addEventListener("focus", () => {
      state.volumeTextEditing = true;
      syncVolumeMetricText(state.currentVolumeValue, { force: true });
      window.requestAnimationFrame(() => {
        if (!els.statVolume || document.activeElement !== els.statVolume) {
          return;
        }
        const selection = window.getSelection();
        if (!selection) {
          return;
        }
        const range = document.createRange();
        range.selectNodeContents(els.statVolume);
        selection.removeAllRanges();
        selection.addRange(range);
      });
    });
    els.statVolume.addEventListener("input", () => {
      const raw = sanitizeVolumeMetricText(els.statVolume.textContent);
      if ((els.statVolume.textContent || "") !== raw) {
        syncVolumeMetricText(raw, { force: true });
      }
      if (!raw) {
        return;
      }
      updateVolumeDisplay(raw, { forceText: false });
      renderSpeakerControlState();
      scheduleVolumeCommit(false, true);
    });
    els.statVolume.addEventListener("blur", () => {
      state.volumeTextEditing = false;
      const raw = sanitizeVolumeMetricText(els.statVolume.textContent);
      if (!raw) {
        updateVolumeDisplay(state.confirmedVolumeValue, { forceText: true });
        renderSpeakerControlState();
        return;
      }
      updateVolumeDisplay(raw, { forceText: true });
      renderSpeakerControlState();
      scheduleVolumeCommit(true, true);
    });
    els.statVolume.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        els.statVolume.blur();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        state.volumeTextEditing = false;
        updateVolumeDisplay(state.confirmedVolumeValue, { forceText: true });
        renderSpeakerControlState();
        els.statVolume.blur();
      }
    });
  }

  if (els.volumeSlider) {
    els.volumeSlider.addEventListener("input", () => {
      updateVolumeDisplay(els.volumeSlider.value || "0", { forceText: true });
      renderSpeakerControlState();
      scheduleVolumeCommit(false, true);
    });
    els.volumeSlider.addEventListener("change", () => {
      updateVolumeDisplay(els.volumeSlider.value || "0", { forceText: true });
      renderSpeakerControlState();
      scheduleVolumeCommit(true, true);
    });
  }

  if (els.dialogWindowInput) {
    els.dialogWindowInput.addEventListener("input", () => {
      const raw = normalizeIntegerText(
        els.dialogWindowInput.value,
        MAX_DIALOG_WINDOW_SECONDS
      );
      state.dialogWindowDirty = true;
      els.dialogWindowInput.value = raw;
      if (!raw) {
        return;
      }
      updateDialogWindowDisplay(
        clamp(Number(raw) || 0, MIN_DIALOG_WINDOW_SECONDS, MAX_DIALOG_WINDOW_SECONDS),
        {
        forceInput: false,
        }
      );
    });
    els.dialogWindowInput.addEventListener("blur", () => {
      if (!els.dialogWindowInput.value.trim()) {
        state.dialogWindowDirty = false;
        updateDialogWindowDisplay(state.currentDialogWindowValue, {
          forceInput: true,
        });
        return;
      }
      if (state.dialogWindowDirty) {
        void applyDialogWindowSeconds();
      }
    });
    els.dialogWindowInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void applyDialogWindowSeconds();
      }
    });
  }

  if (els.openclawContextTokensInput) {
    els.openclawContextTokensInput.addEventListener("input", () => {
      state.openclawContextTokensDirty = true;
      els.openclawContextTokensInput.value = normalizeIntegerText(
        els.openclawContextTokensInput.value,
        MAX_OPENCLAW_CONTEXT_TOKENS
      );
    });
    els.openclawContextTokensInput.addEventListener("blur", () => {
      commitOpenclawContextTokensFromBlur();
    });
    els.openclawContextTokensInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void applyOpenclawContextTokens();
      }
    });
  }

  if (els.composerInput) {
    els.composerInput.addEventListener("input", autoResizeComposer);
    els.composerInput.addEventListener("focus", () => {
      syncComposerMetrics();
      showComposer();
      scheduleConversationBottomStick(true);
    });
    els.composerInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendCompose();
      }
    });
  }

  if (els.sendBtn) {
    els.sendBtn.addEventListener("click", sendCompose);
  }

  if (els.audioUrlInput) {
    els.audioUrlInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        sendAudioPlay();
      }
    });
  }

  if (els.audioSendBtn) {
    els.audioSendBtn.addEventListener("click", sendAudioPlay);
  }

  if (els.wakeBtn) {
    els.wakeBtn.addEventListener("click", wakeUp);
  }

  bindChatScroll();
  initCustomPickers();
  initControlMasonry();
  setComposeMode("chat");
  setDeviceListVisible(false);
  updateVolumeDisplay(0);
  state.hasVolumeSnapshot = false;
  updateDialogWindowDisplay(DEFAULT_DIALOG_WINDOW_SECONDS);
  updateOpenclawContextTokensDisplay(DEFAULT_OPENCLAW_CONTEXT_TOKENS, {
    forceInput: true,
  });
  renderThinkingToggle(false);
  renderDebugLogToggle(true);
  renderCalibrationControl();
  renderSpeakerControlState();
  setControlAvailability(false);
  renderIdleCurrentAudio();
  hydrateAudioPlayers(document);
  autoResizeComposer();
  syncComposerMetrics();
  if (els.composerShell && typeof ResizeObserver === "function") {
    const composerResizeObserver = new ResizeObserver(() => {
      syncComposerMetrics();
    });
    composerResizeObserver.observe(els.composerShell);
  }
  window.addEventListener("resize", syncComposerMetrics);
  window.addEventListener("resize", () => syncLoginWorkspaceFrameHeight());
  window.addEventListener("resize", scheduleControlMasonryLayout);
  setActiveTab(getStoredConsoleTab(), false);
  refreshAll(false);
  installRefreshTimer();
}

function boot() {
  initThemeSystem();
  initThemeSwitches();
  if (document.body.dataset.page === "access") {
    initAccessPage();
    return;
  }
  if (document.body.dataset.page === "console") {
    initConsolePage();
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
