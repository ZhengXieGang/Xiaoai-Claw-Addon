# 跨 Agent 框架适配手册

本文档的目标不是替某一个宿主写死一份移植计划，而是让后续维护者或 agent 读完后，能够自行判断并尝试把本项目适配到新的 agent 框架环境。

当前仓库仍然是 `OpenClaw` 原生插件。跨宿主适配的正确路线是先拆出“宿主无关的小爱核心能力”，再为 OpenClaw、PicoClaw、ZeroClaw、Hermes 或其他宿主分别实现薄适配层。

核验时间：2026-05-21。

## 1. 阅读对象

这份文档面向三类读者：

- 想把本项目移植到其他 agent 框架的后续 agent。
- 想重构 `src/provider.ts` 的维护者。
- 想判断某个新宿主是否值得深度适配的评审者。

读完后应该能回答四个问题：

- 这个宿主能不能只通过工具调用接入小爱能力。
- 这个宿主能不能把小爱音箱变成真实语音入口。
- 这个宿主是否适合做原生插件，还是更适合接 sidecar。
- 如果要开工，应该先改哪些文件、定义哪些接口、补哪些测试。

## 2. 资料来源

本次判断基于下列官方或官方文档站点：

- OpenClaw OpenResponses HTTP API
  `https://openclawcn.com/docs/gateway/openresponses-http-api/`
- PicoClaw Configuration
  `https://docs.picoclaw.io/docs/configuration/`
- PicoClaw Tools
  `https://docs.picoclaw.io/docs/configuration/tools/`
- PicoClaw MCP Servers
  `https://docs.picoclaw.io/docs/configuration/mcp-servers/`
- PicoClaw Hooks
  `https://docs.picoclaw.io/docs/configuration/hooks/`
- PicoClaw Steering
  `https://docs.picoclaw.io/docs/configuration/steering/`
- ZeroClaw Architecture
  `https://zeroclaw-labs-zeroclaw-41.mintlify.app/concepts/architecture`
- ZeroClaw Channels
  `https://zeroclaw-labs-zeroclaw-41.mintlify.app/concepts/channels`
- ZeroClaw Tools
  `https://zeroclaw-labs-zeroclaw-41.mintlify.app/concepts/tools`
- Hermes Docs
  `https://hermes-agent.nousresearch.com/docs/`
- Hermes Programmatic Integration
  `https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration`
- Hermes Plugins
  `https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins`
- Hermes MCP
  `https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp`

这些资料只用于确定适配面和风险边界。真正编码前仍必须重新核验目标宿主的最新版本、实际源码、配置文件格式和启动方式。

## 3. 当前项目事实

当前实现是 OpenClaw 插件，不是通用 agent 插件。

强绑定点包括：

- 入口文件 `index.ts` 使用 OpenClaw 插件 entry 形态。
- `createXiaoaiCloudPlugin(api)` 内部依赖 `api.registerTool`、`api.registerService`、`api.registerHttpRoute`。
- 元数据文件是 `openclaw.plugin.json`。
- `src/openclaw-gateway-runtime.ts` 会动态加载 OpenClaw Gateway SDK。
- 状态、配置、workspace、agent allowlist 都围绕 `OPENCLAW_HOME`、`OPENCLAW_STATE_DIR`、`OPENCLAW_CONFIG_PATH`、`openclaw.json`。
- 通知回推依赖 `openclaw message send`。
- agent 调用依赖 Gateway WebSocket、`agent.wait`、`/v1/responses`、`x-openclaw-agent-id`、`x-openclaw-session-key`、`openclaw:<agentId>`。
- 安装器会创建和修复专属 `xiaoai` agent。

所以新宿主不应该直接加载现有插件包。正确做法是让新宿主调用一个宿主无关的 sidecar 或 host adapter。

## 4. 适配等级

所有宿主都按同一套等级评估，避免“能调一个接口”被误判成“完全适配”。

| 等级 | 名称 | 验收标准 |
| --- | --- | --- |
| L0 | 不能适配 | 宿主没有工具、外部进程、HTTP、MCP 或插件扩展入口，无法稳定调用本项目 |
| L1 | 工具级兼容 | 宿主能调用 `speak`、`play_audio`、`set_volume`、`get_status` 等工具 |
| L2 | 会话级兼容 | 宿主能把外部文本投递到指定 agent/session，并把结果回传给用户 |
| L3 | 入口级兼容 | 小爱音箱轮询结果能作为宿主真实输入，支持拦截、打断、防循环、回播 |
| L4 | 运维级兼容 | 安装、状态目录、日志、权限、升级、卸载、CI 冒烟测试都能自动化 |

“完全适配”至少需要 L3 + L4。大部分新宿主应该先做 L1，验证稳定后再评估 L2/L3。

## 5. 新宿主适配决策树

拿到一个新的 agent 框架后，按下面顺序判断：

1. 是否支持工具注册、MCP server/client、插件系统、外部命令或 HTTP 调用。
   如果都没有，停止适配。
2. 是否支持长期后台任务或能连接外部 sidecar。
   如果没有，只做 L1，不做语音入口。
3. 是否有正式的会话注入 API。
   需要能指定 agent、用户、session key 或 conversation id。
4. 是否有正式的用户通知或消息发送 API。
   登录入口、控制台入口、错误信息都需要可回推。
5. 是否允许暴露 HTTP 路由或反向代理到 sidecar。
   控制台、登录页、音频 relay 都依赖 HTTP。
6. 是否有稳定 state dir、secret store 或配置目录。
   小米 token、控制台口令、校准数据不能散落在源码目录。
7. 是否能等待 agent 结果或接收流式事件。
   如果只能 fire-and-forget，L2/L3 需要降级设计。

只要任一关键项缺失，就不要硬做深度适配。优先做 sidecar + 工具级接入。

## 6. 宿主能力矩阵

| 能力 | OpenClaw | PicoClaw | ZeroClaw | Hermes | 未知新宿主判断方式 |
| --- | --- | --- | --- | --- | --- |
| 工具注册 | `api.registerTool` 已用 | 文档化 tools / MCP | 文档化 Tool trait / registry | 文档化 tools / plugins / MCP | 找 tool schema、MCP 或 plugin API |
| 后台服务 | `api.registerService` 已用 | 需优先 sidecar 核验 | Rust runtime 内可原生实现 | 可用 agent runtime / gateway / plugin 方式评估 | 找 daemon、service、plugin lifecycle |
| HTTP 路由 | `api.registerHttpRoute` 已用 | 不应假设内嵌，优先 sidecar | 需核验 channel/plugin HTTP 支持 | 可通过 gateway/programmatic API 评估 | 找 route、webhook、gateway、reverse proxy |
| 会话注入 | Gateway `agent.wait` / `/v1/responses` | 需核验 steering 是否能承载外部输入 | Channel / RuntimeAdapter 是主要候选 | Programmatic Integration 是主要候选 | 找 send message to session / conversation API |
| 用户通知 | `openclaw message send` | 需核验 CLI/gateway 消息能力 | Channel 输出侧候选 | Messaging gateway 候选 | 找 channel send / bot message API |
| 状态目录 | OpenClaw state dir | 需按配置目录设计 sidecar state | 配置与 runtime state 需核验 | 需核验 deployment state | 找 config dir、data dir、secret store |
| 音频 relay | 插件 HTTP route 已用 | 建议 sidecar HTTP relay | 建议 sidecar HTTP relay | 建议 sidecar HTTP relay | 新宿主默认不要承担音频 relay |

结论：

- OpenClaw 是当前基线，先被拆成第一个 adapter。
- PicoClaw 首选 L1：tools/MCP 接 sidecar，再评估 steering 和 hooks 是否能支撑 L2/L3。
- ZeroClaw 更适合原生 adapter：围绕 Provider、Channel、Tool、Memory、RuntimeAdapter 做能力映射。
- Hermes 可以先走 Programmatic Integration、tools、MCP 或 plugin，再评估 gateway 是否能承载实时语音入口。
- 未知宿主默认不要直接嵌入，先用 sidecar 暴露 HTTP/MCP。

## 7. 目标架构

目标架构分四层。

```text
宿主适配层
  -> OpenClawAdapter
  -> PicoClawAdapter
  -> ZeroClawAdapter
  -> HermesAdapter
  -> GenericMcpAdapter

通用协调层
  -> VoiceEntryOrchestrator
  -> AssistantSessionManager
  -> ReplyDeliveryManager
  -> NotificationRouter
  -> ConsoleService
  -> AudioRelayService

小米核心层
  -> XiaomiAuthService
  -> XiaomiDeviceRegistry
  -> XiaomiConversationPoller
  -> XiaomiSpeakerController
  -> XiaomiAudioPlaybackController
  -> XiaomiCalibrationService

持久化与安全层
  -> StateStore
  -> SecretStore
  -> EventLog
  -> DebugTrace
  -> ConfigMigrator
```

宿主适配层只处理宿主差异。小米核心层不允许 import OpenClaw、PicoClaw、ZeroClaw、Hermes 任何类型。

## 8. HostAdapter 契约

后续重构应该先定义统一接口，再迁移 OpenClaw。

```ts
interface HostAdapter {
  readonly hostId: string;
  getCapabilities(): Promise<HostCapabilityProfile>;
  registerTools(tools: HostToolDefinition[]): Promise<void>;
  startBackgroundService(service: HostBackgroundService): Promise<void>;
  stopBackgroundService(serviceId: string): Promise<void>;
  exposeHttpRoutes?(routes: HostHttpRouteDefinition[]): Promise<void>;
  resolveStateDir(): Promise<string>;
  readHostConfig(): Promise<HostConfigSnapshot>;
  writeHostConfig?(patch: HostConfigPatch): Promise<void>;
  invokeAgent(input: HostAgentInput): Promise<HostAgentResult>;
  waitAgent?(run: HostAgentRunRef): Promise<HostAgentWaitResult>;
  sendUserNotification(message: HostNotification): Promise<void>;
  restartHostRuntime?(reason: string): Promise<void>;
}
```

能力描述必须可运行时探测：

```ts
interface HostCapabilityProfile {
  supportsToolRegistration: boolean;
  supportsMcp: boolean;
  supportsBackgroundService: boolean;
  supportsHttpRoutes: boolean;
  supportsAgentInvoke: boolean;
  supportsAgentWait: boolean;
  supportsStableSessionKey: boolean;
  supportsUserNotification: boolean;
  supportsConfigMutation: boolean;
  supportsRuntimeRestart: boolean;
}
```

规则：

- 核心逻辑只读 capability，不直接判断 host name。
- adapter 内可以写宿主特例。
- capability 不能只靠文档猜，必须有启动时 probe 或安装时 probe。

## 9. Sidecar 优先策略

除 OpenClaw 以外，新宿主都优先考虑 sidecar。

sidecar 至少暴露三类接口：

- HTTP console/auth/audio relay。
- MCP 或 JSON-RPC 工具调用。
- 宿主回调入口，用于接收 agent 结果、通知、会话事件。

优点：

- 避免把小米登录、音频 relay、ffmpeg、校准、状态文件全部塞进不同宿主。
- PicoClaw、Hermes、未知宿主可以先接同一个 MCP/HTTP 服务。
- ZeroClaw 即使做原生 adapter，也能复用同一套核心。

不建议：

- 让每个宿主分别实现一套音频 relay。
- 让每个宿主分别处理小米登录二次验证。
- 让宿主插件直接读写 OpenClaw 配置格式。

## 10. OpenClaw 迁移路线

OpenClaw 是当前基线，不是新增适配目标。第一阶段目标是把它从巨型 `provider.ts` 里剥离为 adapter。

迁移项：

- `registerTools()` / `registerPluginTools()` -> `OpenClawAdapter.registerTools()`
- `ensureGatewayRouteRegistered()` -> `OpenClawAdapter.exposeHttpRoutes()`
- `runOpenclawGatewayCall()` -> `OpenClawAdapter.invokeAgent()` 或 `waitAgent()`
- `deliverAgentPromptViaResponsesApi()` -> `OpenClawAdapter.invokeAgent()`
- `sendOpenclawNotification()` -> `OpenClawAdapter.sendUserNotification()`
- OpenClaw 配置读写和 agent workspace 修改 -> `OpenClawAdapter.readHostConfig()` / `writeHostConfig()`

验收标准：

- 现有 OpenClaw 功能不回退。
- `src/app/*` 和 `src/core/*` 不再 import `openclaw` 命名的模块。
- 所有 OpenClaw 专有错误只在 adapter 内转换为统一错误。

## 11. PicoClaw 适配路线

PicoClaw 文档明确有 config v2、tools、MCP servers、hooks、steering 等扩展点。适配策略应该保守：

### 11.1 L1

优先做 MCP server 或 PicoClaw tools wrapper。

工具集合：

- `xiaoai.speak`
- `xiaoai.play_audio`
- `xiaoai.set_volume`
- `xiaoai.get_volume`
- `xiaoai.wake_up`
- `xiaoai.execute`
- `xiaoai.get_status`
- `xiaoai.open_console`

这些工具全部调用 sidecar，不直接依赖 OpenClaw。

### 11.2 L2/L3

只有在源码级确认下面能力后再做：

- steering 能否稳定把外部输入注入指定对话。
- hooks 能否用于登录入口通知、错误回传、运行时事件。
- PicoClaw 是否支持长期驻留进程或稳定连接 sidecar。
- 是否可以等待 agent 完成并拿到结构化结果。

如果任一能力不稳定，PicoClaw 停在 L1/L2，不做小爱真实语音入口。

## 12. ZeroClaw 适配路线

ZeroClaw 官方文档显示它的核心扩展概念包括 Provider、Channel、Tool、Memory、RuntimeAdapter，并强调 trait/factory 方式的模块化。适配路线应该偏原生。

### 12.1 L1

实现 ZeroClaw Tool wrapper：

- 将 sidecar 工具注册为 ZeroClaw Tool。
- Tool schema 与 `HostToolDefinition` 自动转换。
- 状态目录由 ZeroClaw config/runtime state 或 sidecar state 决定。

### 12.2 L2/L3

优先评估 Channel 或 RuntimeAdapter：

- Channel 负责把小爱语音输入作为外部消息进入 ZeroClaw。
- RuntimeAdapter 或 Provider 负责调用模型并维持 session。
- Memory 只承载摘要和上下文，不保存小米 token。

风险：

- Rust 原生 adapter 会增加构建复杂度。
- 如果 ZeroClaw 的 Channel 输出侧不能主动给用户发消息，则登录入口和控制台入口仍要通过 sidecar 或外部通知渠道解决。

## 13. Hermes 适配路线

Hermes 文档显示它围绕 AIAgent、providers、tools、memory、message bus、gateway、plugins 和 MCP 组织能力。它的首选适配方式不应该是“模拟 OpenClaw 插件”，而是通过 programmatic integration、plugin、MCP 或 gateway 接 sidecar。

### 13.1 L1

优先路线：

- sidecar 暴露 MCP tools。
- Hermes 通过 MCP 或 plugin 注册小爱工具。
- 工具执行后只返回结构化文本结果，不直接操作 Hermes 内部状态。

### 13.2 L2

评估 Programmatic Integration：

- 能否创建或复用 AIAgent。
- 能否把小爱识别文本注入指定 conversation/session。
- 能否拿到最终 agent 输出或事件流。
- 能否通过 gateway 把登录入口和错误消息回发给用户。

### 13.3 L3

只有在 Hermes 能稳定处理外部实时输入、结果回传和会话绑定时，才把小爱音箱作为入口。否则保持 L1 工具集成。

## 14. 未知宿主通用适配算法

新宿主开工前，先创建一份 `docs/adapters/<host>.md`，按这个模板填写：

```text
宿主名称：
官方文档：
版本：
运行语言：
扩展入口：
工具注册：
MCP 支持：
后台服务：
HTTP 路由：
会话注入：
结果等待：
用户通知：
状态目录：
配置写回：
安全模型：
推荐等级：
首选方案：
禁止事项：
最小验收测试：
```

然后按下列顺序实现：

1. 只接 `xiaoai.get_status`。
2. 接 `xiaoai.speak`，但用测试文本和受控环境验证。
3. 接 `xiaoai.play_audio`，必须先用非打扰测试策略或用户明确允许。
4. 接配置和控制台入口。
5. 接 agent/session 注入。
6. 最后才接小爱语音轮询入口。

不能跳过第 1 步直接做 L3。

## 15. 目录重构建议

目标目录：

```text
index.ts
src/
  core/
    xiaomi-auth-service.ts
    xiaomi-device-registry.ts
    xiaomi-conversation-poller.ts
    xiaomi-speaker-controller.ts
    xiaomi-audio-playback-controller.ts
    xiaomi-calibration-service.ts
  app/
    voice-entry-orchestrator.ts
    assistant-session-manager.ts
    reply-delivery-manager.ts
    notification-router.ts
    console-service.ts
    audio-relay-service.ts
  host/
    host-adapter.ts
    openclaw-adapter.ts
    picoclaw-adapter.ts
    zeroclaw-adapter.ts
    hermes-adapter.ts
    generic-mcp-adapter.ts
  state/
    state-store.ts
    secret-store.ts
    event-log.ts
  shared/
    types.ts
    errors.ts
    logging.ts
    timing.ts
    ids.ts
```

拆分顺序：

1. 先迁移纯函数和状态 store。
2. 再迁移小米客户端调用包装。
3. 再迁移音频 relay 和登录 portal。
4. 再定义 HostAdapter。
5. 最后迁移 OpenClaw adapter。

## 16. 必须保留的安全边界

跨宿主适配不能牺牲这些要求：

- 小米 token、控制台口令、校准状态只能落在宿主 state dir 或 sidecar state dir。
- 不写入用户个人网络环境细节到项目文档或默认配置。
- 登录入口必须有过期时间。
- 控制台 access token 不应长期暴露在可见 URL。
- 音频 relay 必须有过期清理和路径越权检查。
- 外部命令必须有超时、stderr 摘要和敏感信息脱敏。
- 防循环逻辑不能因为宿主切换而削弱。

## 17. 测试要求

### 17.1 核心测试

- 唤醒词匹配。
- 对话窗口期。
- 去重。
- 防循环。
- 会话摘要。
- 音频 URL 规范化。
- 设备状态归一化。
- 登录 portal 的 JS/无 JS 兜底。

### 17.2 HostAdapter 契约测试

- 工具 schema 能完整注册。
- `invokeAgent` 能返回统一结果。
- `waitAgent` 超时行为一致。
- 用户通知失败可恢复。
- state dir 可解析。
- HTTP route 不越权。

### 17.3 回放测试

用真实脱敏日志样本回放：

- 小爱识别新语音。
- 插件执行拦截。
- 文本进入宿主 agent。
- 宿主结果回播。
- 音频播放进入 relay。
- 防循环命中。

### 17.4 适配冒烟测试

每个新宿主至少要有：

- L1 工具调用测试。
- 控制台入口测试。
- 登录入口测试。
- 只读状态查询测试。
- 不触发音箱的 dry-run 测试。

## 18. 性能约束

语音入口适配必须满足下限：

- 轮询到新会话目标 `<= 500ms`。
- pause/stop 拦截目标 `<= 300ms`。
- 过渡播报目标 `<= 900ms`。
- 识别文本进入宿主 agent 目标 `<= 600ms`。
- 工具级播报目标 `<= 700ms`。

不允许用固定 sleep 掩盖宿主缺口。延迟必须来自观测数据、动态估算或重试策略。

## 19. 发布策略

未来发布包应分三类：

- `openclaw-plugin`：保留现有用户安装方式。
- `xiaoai-sidecar`：给 PicoClaw、Hermes、未知宿主接入。
- `host-shims`：各宿主的最小注册层。

Release zip 必须继续同时满足：

- `install.sh` 手动安装。
- ClawHub 上传。
- 旧版 OpenClaw 兼容。
- sidecar 独立运行。

## 20. 禁止事项

- 不要让 PicoClaw、ZeroClaw、Hermes 直接兼容 `openclaw.plugin.json`。
- 不要在 `src/provider.ts` 继续堆 `if host === ...`。
- 不要把小米 token 放进宿主 prompt、memory 或 conversation。
- 不要让每个宿主复制一套登录 portal。
- 不要在没有 contract test 的情况下重写音频链路。
- 不要为了追求 L3 破坏现有 OpenClaw 用户。

## 21. 最终建议

执行顺序固定为：

1. 冻结 OpenClaw 当前行为和测试样本。
2. 拆出 core/app/state。
3. 定义 HostAdapter 和契约测试。
4. 把当前 OpenClaw 实现改成 OpenClawAdapter。
5. 做 sidecar + MCP。
6. PicoClaw 先接 L1。
7. Hermes 先接 L1。
8. ZeroClaw 评估原生 Tool/Channel。
9. 所有宿主都等 L1 稳定后再谈 L2/L3。

这条路线不是最快写出 demo 的路线，但它是返工最少、风险最低、最适合继续维护的路线。
