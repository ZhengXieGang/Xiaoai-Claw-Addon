# 维护架构图

本文档给维护者和后续 agent 使用。目标是用函数级 Mermaid 图说明当前实现，不写用户个人网络环境，也不写普通使用教程。

当前代码仍是 OpenClaw 插件形态。跨框架适配时，优先把下面图里的 OpenClaw 专有函数收口到 `HostAdapter`，不要继续在 `src/provider.ts` 里堆宿主分支。

## 1. 顶层运行时边界

```mermaid
flowchart LR
    User[用户] --> Speaker[小爱音箱]
    Speaker <--> XiaomiCloud[小米云 MiNA / MiIO / MIOT]
    XiaomiCloud <--> XiaomiClient["src/xiaomi-client.ts\nXiaomiAccountClient / MiNAClient / MiIOClient / MiotSpecClient"]

    OpenClaw[OpenClaw Gateway] --> Entry["index.ts\npluginEntry.register(api)"]
    Entry --> Factory["createXiaoaiCloudPlugin(api)"]
    Factory --> Provider["src/provider.ts\nXiaoaiCloudPlugin"]

    Provider --> XiaomiClient
    Provider --> Portal["src/auth-portal.ts\nLoginPortal"]
    Provider --> ConsoleTemplate["src/console-page.ts\nrenderConsolePage / renderConsoleAccessPage"]
    Provider --> ConsoleUi["assets/ui/xiaoai-console.js\nbrowser console controller"]
    Provider --> AuthUi["assets/ui/xiaoai-auth-portal.js\nlogin portal controller"]
    Provider --> State["src/state-store.ts\nprofile / console state / events"]
    Provider --> OpenClawRuntime["src/openclaw-gateway-runtime.ts\nloadGatewayClientCtor"]
    Provider --> Agent["OpenClaw xiaoai agent\nagent.wait / responses API"]
    Provider --> Relay["audio relay routes\n/audio-relay/*"]

    Agent --> Tools["xiaoai_* optional tools"]
    Tools --> Provider
    Relay --> Speaker
    ConsoleUi --> User
    AuthUi --> User
```

## 2. 插件启动和停止生命周期

```mermaid
flowchart TB
    A["index.ts\npluginEntry.register(api)"] --> B["createXiaoaiCloudPlugin(api)"]
    B --> C["plugin.registerTools()"]
    C --> D["XiaoaiCloudPlugin.registerTools()"]
    D --> E["registerPluginTools()"]
    D --> F["ensureGatewayRouteRegistered(resolveStaticAuthRoutePath())"]
    D --> G["ensureGatewayRouteRegisteredFromCurrentConfig()"]

    A --> H["api.registerService({ id: xiaoai-cloud-listener })"]
    H --> I["start(ctx)"]
    I --> J["startService(ctx)"]
    J --> K["registerTools()"]
    J --> L["ensureGatewayRouteRegisteredFromCurrentConfig()"]
    J --> M["ensureReady()"]
    M --> N["loadConfig(false)"]
    M --> O["hydrateConsoleState() / hydrateCalibrationProfiles()"]
    M --> P["create XiaomiAccountClient / MiNAClient / MiIOClient / MiotSpecClient"]
    M --> Q["validateCloudConfig()"]
    Q --> R["resolveDeviceContextFor()"]
    Q --> S["fetchLatestConversationFor()"]
    M --> T["persistResolvedProfile()"]
    M --> U["primeConversationCursor()"]
    J --> V["startPolling()"]

    H --> W["stop()"]
    W --> X["stopService()"]
    X --> Y["stopPolling()"]
    X --> Z["stopOpenclawGatewayClient()"]
    X --> AA["clearInterceptWindowState()"]
    X --> AB["clearAllExternalAudioLoopGuards()"]
    X --> AC["loginPortal.stop()"]
    X --> AD["reset runtime fields"]
```

适配提示：

- `index.ts`、`api.registerService`、`api.registerTool` 是 OpenClaw 宿主边界。
- `ensureReady()` 之后的 Xiaomi 客户端初始化属于核心能力，应迁移到 core/app。
- `startPolling()` 是语音入口能力，不应绑定到 OpenClaw。

## 3. HTTP 路由分发

```mermaid
flowchart TB
    A["ensureGatewayRouteRegistered(routePath)"] --> B["api.registerHttpRoute({ match: prefix })"]
    B --> C["handler(request, response)"]
    C --> D["loadConfigForGatewayRoute(routePath)"]
    C --> E["matchGatewayRoutePath(routePath, requestUrl.pathname)"]
    E --> F{"matchedPath"}

    F -->|/console 或 /| G["handleConsoleHttpRoute(..., matchedPath)"]
    F -->|/assets/*| H["handleConsoleHttpRoute asset branch"]
    F -->|/api/*| I["handleConsoleHttpRoute API branch"]
    F -->|/audio-relay/*| J["handleAudioRelayHttpRoute()"]
    F -->|/auth/*| K["ensureLoginPortal()"]
    K --> L["LoginPortal.handleHttpRoute(request, response, matchedPath)"]
    F -->|unknown| M["sendText(404)"]

    G --> N["resolveConsoleAuthorization()"]
    I --> N
    N --> O{"authorized"}
    O -->|false| P["sendJson(401)"]
    O -->|true| Q["dispatch API action"]
```

## 4. 登录门户与二次验证

```mermaid
flowchart TB
    A["xiaoai_login_begin tool"] --> B["ensureLoginSession(forceNew=true)"]
    B --> C["ensureLoginPortal()"]
    C --> D["new LoginPortal({...callbacks})"]
    D --> E["LoginPortal.start()"]
    E --> F["createServer() unless standaloneOptional"]
    B --> G["LoginPortal.createSession(seed, preferredBaseUrls)"]
    G --> H["computeBaseUrls()"]
    G --> I["session.primaryUrl = /auth/:id"]
    B --> J["announceLoginSession()"]
    J --> K["sendOpenclawNotification()"]

    User["用户打开登录页"] --> L["LoginPortal.handleHttpRoute()"]
    L --> M["handleRequest()"]
    M --> N{"GET /auth/:id"}
    N --> O["renderLoginPage()"]
    O --> P["assets/ui/xiaoai-auth-portal.js"]

    P --> Q["authForm submit"]
    Q --> R["loginByPassword()"]
    R --> S["postJson(/login/password)"]
    S --> T["handleRequest POST login/password"]
    T --> U["handlePasswordLogin(sessionId, payload)"]
    U --> V["buildPasswordLoginConfig()"]
    U --> W["new XiaomiAccountClient()"]
    W --> X["loginRequiredSids()"]
    X --> Y["XiaomiAccountClient.login(sid)"]
    Y --> Z{"XiaomiVerificationRequiredError"}
    Z -->|yes| AA["pendingVerifications.set(sessionId, ...)"]
    AA --> AB["createVerificationPayload(error)"]
    AB --> AC["portal shows openVerifyBtn / ticket input"]
    Z -->|no| AD{"hasDeviceSelectionSeed()"}
    AD -->|false| AE["finalizeAccountLoginWithoutDevice()"]
    AD -->|true| AF["validateCloudConfig()"]
    AF --> AG["persistResolvedProfile()"]
    AG --> AH["reinitializeAfterLogin()"]
    AH --> AI["ensureReady() + startPolling()"]

    AC --> AJ["openVerifyPage() or ticket submit"]
    AJ --> AK["POST /verify/page or /verify/ticket"]
    AK --> AL["handlePrepareVerificationPage() / handleVerificationTicket()"]
    AL --> AM["continueVerifiedLogin()"]
    AM --> AN["completeVerification() or login()"]
    AN --> AF
```

关键兜底：

- `renderLoginPage()` 的登录按钮是 `type="submit"`。
- JS 正常时走 `postJson()`。
- JS 失败时走原生 form POST，`handleRequest()` 用 `isHtmlFormRequest()` 判断后 `sendRedirect()` 回登录页。

## 5. 小米客户端分层

```mermaid
flowchart TB
    A["XiaomiAccountClient"] --> B["loadTokenStore() / saveTokenStore()"]
    A --> C["ensureSid(sid)"]
    C --> D["login(sid)"]
    D --> E["runLoginRequest(sid)"]
    E --> F["accountLoginStep1()"]
    E --> G["accountLoginStep2()"]
    E --> H["tryPythonMicoapiLogin()"]
    E --> I["accountLoginStep3(location)"]
    E --> J["buildLoginFailure(auth, sid)"]
    J --> K["XiaomiVerificationRequiredError"]
    A --> L["completeVerification(sid, ticket)"]
    A --> M["prepareVerificationPage()"]
    A --> N["requestVerificationCode()"]
    A --> O["miRequest<T>()"]

    P["MiNAClient"] --> Q["deviceList()"]
    P --> R["ubusRequest()"]
    P --> S["textToSpeech()"]
    P --> T["playerSetVolume()"]
    P --> U["playerPause() / playerPlay() / playerSetLoop()"]
    P --> V["playUrl() / playMusic()"]
    P --> W["conversationRecords()"]

    X["MiIOClient"] --> Y["getProperties() / setProperties()"]
    X --> Z["action()"]

    AA["MiotSpecClient"] --> AB["loadInstances()"]
    AA --> AC["loadInstance(type)"]
    AA --> AD["resolve speaker features"]
```

适配提示：

- `XiaomiAccountClient`、`MiNAClient`、`MiIOClient`、`MiotSpecClient` 是宿主无关核心。
- 这些类不应该依赖 OpenClaw、PicoClaw、ZeroClaw、Hermes。

## 6. 对话轮询与拦截主链路

```mermaid
flowchart TB
    A["startPolling()"] --> B["schedulePollingLoop(delay)"]
    B --> C["pollConversationOnce()"]
    C --> D["ensureReady()"]
    C --> E["fetchLatestConversation()"]
    E --> F["fetchLatestConversationFor(mina, device, { hedged })"]
    F --> G["performConversationFetch()"]
    G --> H["MiNAClient.conversationRecords()"]
    F --> I["selectLatestConversationCandidate(records)"]
    C --> J["normalizeConversationRecord(latest)"]
    C --> K{"duplicate / stale / self-triggered"}
    K -->|ignore| L["return"]
    K -->|accept| M["recordConsoleEvent(conversation.user)"]
    M --> N["handleIncomingQuery(query, hint)"]

    N --> O{"currentMode"}
    O -->|silent| P["skip"]
    O -->|proxy| Q["interceptAndForward(query)"]
    O -->|wake| R["shouldInterceptQuery(query)"]
    R -->|false| S["do not intercept"]
    R -->|true| Q

    Q --> T["waitingForResponse = true"]
    Q --> U["buildConversationInterceptGuardPlan(deviceId, hint)"]
    Q --> V["ensureActionContext()"]
    Q --> W["dispatchSpeakerInterruptBurst() / silenceSpeaker()"]
    Q --> X["forwardToOpenclaw(text, { renewVoiceSession })"]
    Q --> Y["maybeSendConversationTransitionPrompt()"]
    Q --> Z["runConversationInterceptFallbackPauseGuard()"]
    Q --> AA["runConversationInterceptRuntimeMonitor()"]
```

防循环关键函数：

- `rememberSelfTriggeredQuery(text, source)`
- `shouldIgnoreSelfTriggeredQuery(query, queryTimeMs)`
- `pruneRecentSelfTriggeredQueries(nowMs)`
- `recordVoiceContextTurn(role, text, sessionKey)`
- `buildVoiceContextPrompt(sessionKey)`

## 7. OpenClaw agent 投递链路

```mermaid
flowchart TB
    A["forwardToOpenclaw(text, options)"] --> B["resolveOpenclawVoiceSessionKey(forceNew)"]
    A --> C["buildVoiceSessionNotice(options)"]
    A --> D["buildVoiceContextPrompt(sessionKey)"]
    A --> E["deliverAgentPrompt(prompt, label, { sessionKey })"]

    E --> F["loadConfig(false)"]
    E --> G["activeVoiceAgentRuns.push(activeRun)"]
    E --> H{"config.openclawForceNonStreaming"}
    H -->|true| I["deliverAgentPromptViaResponsesApi(config, text, label, activeRun)"]
    I --> J["readOpenclawGatewayAuthState()"]
    I --> K["computeOpenclawGatewayHttpBaseUrls()"]
    I --> L["POST /v1/responses"]
    L --> M["normalizeOpenclawResponsesReplyPayloads(result)"]

    H -->|false| N["runOpenclawGatewayCall(config, 'agent', params, label, options)"]
    N --> O["ensureOpenclawGatewayClient(config)"]
    O --> P["loadGatewayClientCtor()"]
    N --> Q["agent.wait via Gateway client"]
    Q --> R["normalizeOpenclawReplyPayloads(result.payloads)"]

    M --> S["handleOpenclawFinalPayloads(activeRun, payloads)"]
    R --> S
    S --> T{"payload type"}
    T -->|text| U["finalizeSpokenToolReply() / playText()"]
    T -->|mediaUrl/mediaUrls| V["playAudioUrl(url)"]
    T -->|none| W["waitingForResponse = false"]
    E --> X["clearActiveVoiceAgentRun(activeRun.id)"]
```

适配提示：

- 上图整段是 OpenClaw adapter 候选边界。
- 新宿主只需要实现统一的 `invokeAgent()` / `waitAgent()` / `sendUserNotification()`，不应该复制 `x-openclaw-*` 细节。

## 8. 工具注册与工具执行

```mermaid
flowchart TB
    A["registerPluginTools()"] --> B["registerOptionalTool(tool)"]
    B --> C["api.registerTool({ optional: true })"]

    A --> T1["xiaoai_speak.execute()"]
    T1 --> T1A["extractAudioPlaybackInputFromText()"]
    T1A -->|audio input| T1B["playAudioUrl()"]
    T1A -->|plain text| T1C["finalizeSpokenToolReply()"]

    A --> T2["xiaoai_play_audio.execute()"]
    T2 --> T2A["normalizeAudioPlaybackInput()"]
    T2A --> T2B["playAudioUrl()"]

    A --> T3["xiaoai_tts_bridge.execute()"]
    T3 --> T3A["synthesizeOpenclawTtsToRelayUrl()"]
    T3A --> T3B["playAudioUrl()"]
    T3A -->|fallback| T3C["finalizeSpokenToolReply()"]

    A --> T4["xiaoai_set_volume.execute()"]
    T4 --> T4A["runSpeakerControlMutation('volume')"]
    T4A --> T4B["setVolumePercent()"]

    A --> T5["xiaoai_set_playback_mute.execute()"]
    T5 --> T5A["isSpeakerMuteControlSupportedFor()"]
    T5A --> T5B["setSpeakerMuted()"]

    A --> T6["xiaoai_get_volume.execute()"]
    T6 --> T6A["getVolumeSnapshot()"]

    A --> T7["xiaoai_wake_up.execute()"]
    T7 --> T7A["wakeUpSpeaker()"]

    A --> T8["xiaoai_execute.execute()"]
    T8 --> T8A["executeDirective(command)"]

    A --> T9["xiaoai_get_status / login_begin / console_open / update_settings"]
```

跨宿主适配时，工具 schema 应迁移为宿主无关 `HostToolDefinition[]`，再由各宿主 adapter 转换。

## 9. 文本播报链路

```mermaid
flowchart TB
    A["xiaoai_speak or OpenClaw text payload"] --> B["finalizeSpokenToolReply(text, options)"]
    B --> C["markActiveVoiceAgentSpoken(text)"]
    B --> D["playText(text)"]
    D --> E["ensureReady()"]
    D --> F["MiNAClient.textToSpeech(deviceId, text)"]
    F --> G["rememberSelfTriggeredQuery(text, 'speak')"]
    G --> H["recordConsoleEvent(tool.speak / console.speak)"]
    B --> I["sendOpenclawNotification() optional"]
```

## 10. 音频播放、relay 与防循环

```mermaid
flowchart TB
    A["playAudioUrl(sourceUrl, options)"] --> B["resolveDeviceContext()"]
    A --> C["prepareSpeakerAudioSource(sourceUrl, options)"]
    C --> D["resolveSpeakerPlaybackCandidateUrls()"]
    D --> E["normalizeAudioPlaybackSourceUrl()"]
    D --> F["resolveLocalAudioSourceUrl()"]
    F --> G["collectLocalAudioSourceCandidates()"]
    D --> H["preflightRemoteAudioSource()"]
    D --> I["transcodeRemoteAudioToMp3Buffer()"]
    I --> J["registerBufferedAudioRelaySource()"]
    J --> K["persistBufferedAudioRelay()"]
    J --> L["buildBufferedAudioRelayCandidateUrls()"]
    D --> M["registerRemoteAudioRelaySource()"]
    M --> N["buildAudioRelayCandidateUrls()"]
    D --> O["prioritizeAudioPlaybackCandidateUrls()"]

    A --> P["orderAudioPlaybackStrategies(device, url)"]
    P --> Q["relay-direct / relay-music / relay-music-mp3 / direct"]
    Q --> R["MiNAClient.playUrl() or MiNAClient.playMusic()"]
    R --> S["verifySpeakerPlaybackStarted()"]
    S --> T["readSpeakerPlaybackSnapshotWithTiming()"]
    T --> U["readSpeakerPlaybackSnapshot()"]
    S --> V["hasSpeakerPlaybackStarted()"]
    V -->|false| W["try next strategy"]
    V -->|true| X["armExternalAudioLoopGuard()"]
    X --> Y["scheduleExternalAudioLoopGuardDeadline()"]
    Y --> Z["runExternalAudioLoopGuardDeadline()"]
    X --> AA["runExternalAudioLoopGuard()"]
    AA --> AB["finishExternalAudioLoopGuard()"]
    AB --> AC["forceStopExternalAudioCompletionBoundary()"]
    A --> AD["recordConsoleAudioPlaybackState()"]
```

relay HTTP 路由：

```mermaid
flowchart TB
    A["GET /audio-relay/*"] --> B["handleAudioRelayHttpRoute()"]
    B --> C{"route kind"}
    C -->|buffered| D["handleBufferedAudioRelayRoute()"]
    C -->|mp3 transcode| E["handleAudioRelayMp3TranscodeRoute()"]
    D --> F["traceAudioRelayServe()"]
    E --> F
    F --> G["rememberSharedAudioRelayUsage()"]
    G --> H["readSharedAudioRelayUsage()"]
    H --> I["relay hit signal for playback verification"]
```

短音频和外部音频相关函数：

- `computeDynamicExternalAudioLoopGuardBaseLeadMs(deviceId)`
- `computeExternalAudioLoopGuardLeadMs(deviceId, options)`
- `computeRelayHitAnchoredExternalAudioDeadlineAtMs(...)`
- `shouldAcceptRelayHitStart(...)`
- `detectSpeakerPlaybackBootstrapReason(...)`
- `isSpeakerPlaybackStalledQueued(...)`

## 11. 音量、静音和设备控制

```mermaid
flowchart TB
    A["runSpeakerControlMutation(kind, value, fn)"] --> B["speakerControlMutationQueue"]
    B --> C["fn()"]

    C --> D["setVolumePercent(pct)"]
    D --> E["MiIOClient.setProperties(volume)"]
    D --> F["readActualVolumeReadbackFromDevice()"]
    F --> G["rememberVolumeSnapshot()"]

    C --> H["setSpeakerMuted(muted)"]
    H --> I["syncAndVerifySpeakerMuteState()"]
    I --> J["syncSpeakerMuteState()"]
    I --> K["verifySpeakerMuteReadback()"]
    H --> L["setSpeakerMutedViaSoftVolumeFallback()"]
    L --> M["stabilizeSoftVolumeUnmuteState()"]

    C --> N["wakeUpSpeaker()"]
    N --> O["MiIOClient.action(wakeUp)"]

    C --> P["executeDirective(command)"]
    P --> Q["messageRouterPost or executeTextDirective"]

    C --> R["pauseSpeaker() / resumeSpeaker() / stopSpeaker()"]
    R --> S["sendPauseCommand() / sendStopCommand()"]
    S --> T["verifySpeakerCommandState()"]
```

## 12. 控制台后端 API

```mermaid
flowchart TB
    A["handleConsoleHttpRoute(config, request, response, requestUrl, matchedPath)"] --> B["resolveConsoleAuthorization()"]
    B --> C{"authorized"}
    C -->|false| D["sendJson(401)"]
    C -->|true| E["action = matchedPath.replace(/^/api/, '')"]

    E --> F["GET bootstrap"]
    F --> F1["buildConsoleBootstrap()"]
    F1 --> F2["buildConsoleAudioPlayback()"]
    F1 --> F3["buildConsoleAudioCalibrationState()"]
    F1 --> F4["buildConversationInterceptCalibrationState()"]

    E --> G["GET conversations"]
    G --> G1["getConsoleConversationFeed(limit)"]

    E --> H["GET events"]
    H --> H1["getConsoleEvents(limit)"]

    E --> I["POST chat/send"]
    I --> I1["executeDirective(text)"]
    I --> I2["waitForConversationResult()"]

    E --> J["POST speaker/speak"]
    J --> J1["playText(text)"]

    E --> K["POST speaker/play-audio"]
    K --> K1["playAudioUrl(url, options)"]

    E --> L["POST speaker/pause/resume/stop"]
    L --> L1["pauseSpeaker() / resumeSpeaker() / stopSpeaker()"]

    E --> M["POST device/audio-calibration"]
    M --> M1["runRequestedCalibration('audio')"]

    E --> N["POST device/conversation-intercept-calibration"]
    N --> N1["runRequestedCalibration('conversation')"]

    E --> O["POST settings routes"]
    O --> O1["updateMode() / updateWakeWordPattern() / updateDialogWindowSeconds()"]
    O --> O2["updateOpenclawAgentModel() / updateOpenclawWorkspaceFile()"]
    O --> O3["updatePollIntervalMs() / updateAudioTailPaddingMs()"]
```

控制台前端主要入口：

```mermaid
flowchart TB
    A["renderConsolePage()"] --> B["assets/ui/xiaoai-console.js boot()"]
    B --> C["initThemeSystem() / initThemeSwitches()"]
    B --> D{"body data-page"}
    D -->|access| E["initAccessPage()"]
    D -->|console| F["initConsolePage()"]
    F --> G["refreshAll(false)"]
    G --> H["refreshBootstrap()"]
    G --> I["refreshConversations()"]
    G --> J["refreshEvents()"]
    F --> K["bind UI events"]
    K --> L["handleAccountAction()"]
    L --> M["openLoginWorkspace(loginUrl)"]
    K --> N["sendCompose() / sendAudioPlay() / wakeUp()"]
    K --> O["applyMode() / applyWakeWordPattern() / applySettings()"]
```

## 13. 状态持久化

```mermaid
flowchart TB
    A["defaultStateStorePath(baseStateDir)"] --> B["xiaoai-cloud-state.json"]
    C["defaultConsoleStatePath(baseStateDir)"] --> D["xiaoai-console-state.json"]

    E["loadPersistedProfile(filePath)"] --> F["PersistedCloudProfile"]
    F --> G["normalize loaded profile in loadConfig()"]
    H["savePersistedProfile(filePath, profile)"] --> B

    I["loadPersistedConsoleState(filePath)"] --> J["PersistedConsoleState"]
    J --> K["console events / audio playback / mute state / calibration profiles"]
    L["savePersistedConsoleState(filePath, state)"] --> D

    M["XiaomiAccountClient.loadTokenStore()"] --> N["tokenStorePath"]
    O["XiaomiAccountClient.saveTokenStore()"] --> N
```

状态边界：

- 小米 token 属于 secret/state，不能进 prompt、memory 或日志明文。
- 控制台 token 和登录 session 有过期时间。
- 音频 relay 缓存必须可裁剪。

## 14. 跨宿主拆分目标

```mermaid
flowchart TB
    Provider["当前 src/provider.ts\nXiaoaiCloudPlugin"] --> Core["core/*\n小米登录 / 设备 / 轮询 / 设备动作"]
    Provider --> App["app/*\n语音入口 / 会话 / 回复投递 / 控制台服务 / 音频 relay"]
    Provider --> Host["host/*\nOpenClawAdapter / PicoClawAdapter / ZeroClawAdapter / HermesAdapter"]
    Provider --> State["state/*\n状态 / secret / event log / migration"]

    Host --> HA["HostAdapter interface"]
    HA --> H1["registerTools()"]
    HA --> H2["invokeAgent() / waitAgent()"]
    HA --> H3["sendUserNotification()"]
    HA --> H4["exposeHttpRoutes()"]
    HA --> H5["resolveStateDir() / readHostConfig() / writeHostConfig()"]

    Core --> Xiaomi["src/xiaomi-client.ts classes"]
    App --> Portal["LoginPortal"]
    App --> Relay["AudioRelayService"]
    App --> Console["ConsoleService"]
```

拆分规则：

- `OpenClaw` 字样只能出现在 `host/openclaw-*`、安装脚本和兼容文档里。
- `core/*` 不能 import 宿主 SDK。
- `app/*` 只能通过 `HostAdapter` 调宿主。
- `state/*` 只处理路径、读写、迁移、脱敏。

## 15. 维护检查清单

- 改登录页前，检查 `renderLoginPage()`、`assets/ui/xiaoai-auth-portal.js`、`LoginPortal.handleRequest()` 三处是否一致。
- 改控制台前，检查 `renderConsolePage()`、`assets/ui/xiaoai-console.js`、`handleConsoleHttpRoute()` 三处是否一致。
- 改音频播放前，检查 `playAudioUrl()`、relay route、`verifySpeakerPlaybackStarted()`、loop guard 四条链路。
- 改会话转发前，检查 `forwardToOpenclaw()`、`deliverAgentPrompt()`、`handleOpenclawFinalPayloads()`、`recordVoiceContextTurn()`。
- 改安装和发布前，检查 `package.json files`、`openclaw.plugin.json`、`install.sh`、`scripts/configure-openclaw-install.mjs`、GitHub Action。
- 做跨宿主适配前，先读 `CROSS_CLAW_ADAPTATION_PLAN.md`，不要直接让新宿主加载 OpenClaw 插件入口。
