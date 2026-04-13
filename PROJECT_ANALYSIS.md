# openclaw-plugin-xiaoai-cloud 项目分析与实现说明

这份文档不是给普通安装用户看的，而是给真正想弄清楚项目原理、实现边界、性能策略和维护方式的人看的。

如果你只是想安装然后直接用，回到 [README.md](./README.md) 就够了。

`README.md` 故意只保留四件事：

- 是什么
- 能干什么
- 怎么安装
- 怎么用

除此之外的内容，例如：

- 架构
- 状态与配置
- 控制台前后端
- 性能和安全
- 发布和安装细节
- 踩坑复盘与排障

都统一放在这份分析文档里。

如果你关心后续如何把本项目适配到 `ZeroClaw` / `PicoClaw`，请看单独的规划文档：

- [CROSS_CLAW_ADAPTATION_PLAN.md](./CROSS_CLAW_ADAPTATION_PLAN.md)

## 0. 文档边界与 README 拆分原则

这部分专门解释一个原则：

`README.md` 只负责回答普通用户最关心的四个问题：

1. 这是什么
2. 它能做什么
3. 怎么安装
4. 装完以后怎么开始用

凡是超出这四个问题、且不会影响普通用户完成首次安装和首次使用的内容，都不应该继续堆在 `README.md` 里。

这类内容包括但不限于：

- 插件和 OpenClaw runtime 之间如何交互
- 小米云、MiNA、MiIO、MIOT 分别承担什么职责
- 为什么要做专属 `xiaoai` agent
- 为什么安装脚本会自动修复 allowlist、agent 配置、owner 和宿主依赖
- 为什么音频 URL 需要先在本地标准化再转交给小爱
- 为什么插件安装时可能需要走 `--dangerously-force-unsafe-install`
- 为什么 `openclawTo` 允许自动推断但不应该盲猜
- 控制台状态、日志、上下文、事件流分别落在哪些文件里
- 发布包为什么只带必要文件，而不把源码目录里的所有内容都给最终用户

如果把这些内容写进 `README.md`，会有几个直接问题：

- 普通用户第一次打开仓库时信息量过大，很难迅速理解“我到底该怎么装、怎么用”
- 安装步骤会被原理、限制、复盘、兼容性说明冲淡，降低上手效率
- 维护者后续每次调架构、补兼容、修安装器，都得同步修改 README，导致 README 膨胀
- 技术细节和用户说明混在一起后，两个文档都会失焦

所以本仓库把文档明确拆成两层：

- `README.md`
  面向普通用户，只保留最短路径信息。
- `PROJECT_ANALYSIS.md`
  面向维护者、二次开发者和真正想看实现细节的人，集中承接所有技术性内容。

下面这些原本最容易误塞进 `README.md`、但实际上更适合写在技术文档里的内容，这里统一展开说明。

### 0.1 安装脚本实际做了什么

普通用户在 README 里只需要知道运行 `install.sh` 或 `install.cmd` 即可，但从实现角度看，安装脚本实际上做了比“复制插件文件”更多的事情。

它会依次处理：

1. 检查 Node.js 版本是否满足 OpenClaw 官方要求。
2. 判断当前目录是源码树还是 release 压缩包解压目录。
3. 安装插件自身依赖，并在需要时执行本地编译。
4. 把插件安装到当前 OpenClaw 正在使用的 state dir 对应扩展目录。
5. 自动为小爱创建或校正专属 `xiaoai` agent。
6. 自动修复插件 allowlist 和工具 allowlist。
7. 自动补装 OpenClaw 宿主运行时缺失的依赖，例如 Telegram / Slack / Bedrock 相关包。
8. 自动把插件目录 owner 修正到当前安装用户，避免安装后出现权限问题。
9. 在发现旧插件处于“半卸载残留”状态时，先清理残留目录和配置，再继续安装。
10. 在 OpenClaw 新版本存在危险代码拦截时，根据 CLI 官方能力自动决定是否带上 `--dangerously-force-unsafe-install`。

另外还有一个很实际的发布细节：

- `install.sh` 和 `uninstall.sh` 都应该在仓库和 release 包里保留可执行位
- 如果某些解压工具把执行位丢了，用户仍然可以直接运行 `bash ./install.sh` 或 `bash ./uninstall.sh`

这不是功能逻辑问题，但它会直接影响用户是否会误判成“安装脚本坏了”。

这些步骤不适合写进 README 的原因很简单：

- 它们会让普通用户误以为自己需要理解这些内部细节后才能安装
- 但实际上，用户只需要执行安装脚本，脚本本身就应该把这些复杂度吸收掉

### 0.2 为什么 `openclawChannel / openclawTo` 的细节不该写在 README

对普通用户来说，只要插件能把登录入口、语音转发和通知发送给 OpenClaw 就够了。

但从实现上看，通知路由是一个比较容易踩坑的配置点：

- 如果手工漏填，插件过去会在语音转发或登录通知时直接报错
- 如果盲目写死，又会在不同用户的渠道结构下出问题
- 如果随便自动猜测，多账户场景下又可能把消息发错目标

因此现在的处理策略是：

1. 安装时，先泛化探测当前已启用渠道；如果全局配置里只有一个明确渠道和一个唯一目标，就自动回写到插件配置。
2. 运行时，如果用户没配、但全局配置里仍然存在唯一可推断目标，就做安全兜底。
3. 如果存在多个候选目标，就宁可不猜，也不把消息发错。
4. 如果用户在控制台里明确关闭了插件通知，就把这个“关闭状态”持久化，而不是下次启动时又偷偷自动恢复。

这是典型的“实现细节必须写清楚，但不该堆在 README 里”的内容。

### 0.3 为什么音频 URL 标准化逻辑不该写在 README

README 里只需要告诉用户“支持让小爱播放音频 URL”。

但真正的实现远比一句话复杂：

- 不同型号的小爱对第三方音频 URL 的接受程度不同
- 同一个 URL 在浏览器能播，不代表小爱云端能真正开始播
- 有些机型更偏好 music request，而有些机型直接播 URL 更稳
- 有些源格式虽然合法，但设备端兼容性很差

因此插件现在采用的是“尽量本地标准化后再交给小爱”的思路：

- 优先把外部音频在本地转成统一 MP3
- 通过插件自身的 relay 地址重新暴露出去
- 再让小爱请求这个更可控、更标准化的音频源

这能提升兼容性和成功率，但它显然属于实现机制，不是 README 应该展开解释的内容。

### 0.4 为什么 TTS 桥接工具应该写在技术文档

普通用户只需要知道：

- OpenClaw 可以让小爱播报文字
- 也可以走音频播放链路

但对于维护者来说，是否需要单独的 TTS 桥接、为什么不用第三方临时 TTS、为什么改用 OpenClaw 官方 `runtime.tts`，这些都必须说清楚。

当前实现的设计目标是：

- 让 OpenClaw 可以先通过官方 TTS 能力合成音频
- 再由插件负责把音频编码、标准化并交给小爱播放
- 从而把“文字播报”和“音频回复播放”两条链路区分开

这能让后续适配其他 claw 系项目时更容易复用音频层，而不是把所有逻辑都绑死在 `xiaoai_speak` 上。

### 0.5 为什么 release、源码树、技术文档要分开

对普通用户而言，release 压缩包里越少越好，只要能安装就行。

所以从分发视角看：

- 用户真正需要的是预构建产物、安装脚本和插件清单
- 不需要为了“看文档”把大段技术说明或分析文档跟着打进 release

而从仓库视角看：

- `README.md` 仍然必须保留，因为 GitHub 首页需要它
- `PROJECT_ANALYSIS.md` 仍然必须保留，因为维护者需要它
- 但这两者不应该成为 release 包的负担

这也是为什么文档策略必须写进技术文档，而不是在 README 里越写越长。

## 1. 项目定位

这个项目的目标很明确：

把“小爱音箱”变成 OpenClaw 的一个真实语音入口和语音出口。

它不是一个单纯的“小米登录脚本”，也不是一个“网页控制台皮肤”，而是同时解决了下面几类问题：

1. 如何把小爱云端对话记录稳定地拉回来，并实时判断是否应该拦截。
2. 如何尽快打断小爱默认回复，再把用户语音转发给 OpenClaw。
3. 如何让 OpenClaw 的结果重新通过小爱说出来，或者通过小爱执行本地设备指令。
4. 如何把登录、设备选择、状态查看、调试和配置收敛到一个控制台里。
5. 如何降低典型故障的出现概率，例如网络超时、登录未完成、session lock、自触发循环、音频不兼容。

从实现上看，这个插件是一个运行在 OpenClaw Gateway 侧的“中间控制层”。

它一头连接：

- OpenClaw runtime
- OpenClaw Gateway HTTP 路由
- OpenClaw CLI / Agent

另一头连接：

- Xiaomi account session
- MiNA 云端接口
- MiIO / MIOT 设备控制接口

中间再叠加：

- 状态持久化
- 控制台后端 API
- 控制台前端
- 安装与发布自动化

## 2. 一句话架构图

可以把整个系统理解成下面这条链：

```text
用户对小爱说话
  -> 小米云对话记录
  -> 插件轮询拉取最新一条
  -> 判断是否要拦截
  -> 按当前设备的预计起播窗口发送主拦截
  -> 把文本转发给 OpenClaw 专属 agent
  -> OpenClaw 返回文字或 mediaUrl
  -> 插件让小爱播报 / 执行 / 播放音频
  -> 控制台记录整条事件链路
```

同时，控制台又是另一条旁路：

```text
浏览器控制台
  -> 插件 HTTP 路由
  -> 控制台 API
  -> 同一套设备控制 / 配置 / 状态 / 事件能力
```

## 3. 仓库结构

核心文件如下：

```text
index.ts
src/provider.ts
src/xiaomi-client.ts
src/auth-portal.ts
src/console-page.ts
src/state-store.ts
src/openclaw-paths.ts
src/openclaw-gateway-runtime.ts
src/openclaw-agent-wrapper.ts
assets/ui/xiaoai-console.js
assets/ui/xiaoai-console.css
install.sh
install.cmd
scripts/configure-openclaw-install.mjs
```

职责划分：

- `index.ts`
  插件入口，只负责把 provider 注册进 OpenClaw。
- `src/provider.ts`
  整个项目的核心。几乎所有运行时行为都在这里。
- `src/xiaomi-client.ts`
  小米账号、MiNA、MiIO、MIOT 这一侧的客户端实现。
- `src/auth-portal.ts`
  小米账号登录门户和二次验证流程。
- `src/console-page.ts`
  控制台 HTML 渲染模板。
- `assets/ui/xiaoai-console.js`
  控制台前端交互逻辑。
- `assets/ui/xiaoai-console.css`
  控制台样式。
- `src/state-store.ts`
  状态文件和控制台事件文件的读写。
- `src/openclaw-paths.ts`
  OpenClaw state dir / config path / plugin storage dir 的定位逻辑。
- `src/openclaw-gateway-runtime.ts`
  动态加载 OpenClaw 官方 Gateway SDK。
- `src/openclaw-agent-wrapper.ts`
  对 OpenClaw CLI 输出做包装，尽量拿到稳定摘要。
- `install.sh` / `install.cmd`
  用户安装入口。
- `scripts/configure-openclaw-install.mjs`
  安装后自动配置专属 agent、workspace、工具 allowlist。

## 4. 插件入口与生命周期

插件入口非常薄。

`index.ts` 做的事只有两件：

1. 创建 `XiaoaiCloudPlugin`
2. 注册工具和服务

入口代码路径：

- `index.ts`
- `src/provider.ts`

运行生命周期的关键点在 `src/provider.ts`：

- `registerTools()`
  只注册一次工具，避免重复注册。
- `startService()`
  启动时注册工具、尝试注册 HTTP 路由、执行初始化、初始化成功后开始轮询。
- `stopService()`
  停轮询、停 Gateway client、清理 runtime state、清理 login portal、清空会话和上下文缓存。

这意味着它不是“无状态脚本”，而是一个长期驻留的 OpenClaw 服务。

## 5. 配置解析与优先级

配置不是只看一个地方，而是有明确优先级。

入口函数是 `resolvePluginConfig()`，位置在 [src/provider.ts](/home/zhengxg/文档/xiaoaiclaw/openclaw-plugin-xiaoai-cloud/src/provider.ts)。

它会组合这几层来源：

1. OpenClaw 插件配置
2. 环境变量
3. 持久化的 `profile.json`
4. 代码默认值

常见配置项包括：

- 小米账号、密码、云区
- 指定设备的 `speakerName / hardware / miDid / minaDeviceId`
- token store 路径
- 控制台状态文件路径
- 调试日志路径
- `openclawAgent / openclawChannel / openclawTo`
- `openclawThinkingOff`
- `openclawForceNonStreaming`
- `voiceContextMaxTurns / voiceContextMaxChars`
- `wakeWordPattern`
- `dialogWindowSeconds`

这套设计的意义：

- 用户安装后可以先跑起来，再在控制台调整部分参数
- 插件可以把“用户后来在控制台里改过的东西”保存下来
- 进程重启后能自动恢复主要行为

## 6. OpenClaw 路径与状态目录定位

`src/openclaw-paths.ts` 负责定位 OpenClaw 的关键路径：

- active state dir
- OpenClaw config path
- 插件自己的 storage dir

默认情况下，插件数据会落到：

```text
<active-state-dir>/plugins/xiaoai-cloud/
```

也就是说，这个插件没有把状态散落到一堆随机目录，而是尽量跟随当前正在使用的 OpenClaw state dir。

这是后面安装脚本做 owner 修复、状态恢复、调试定位的基础。

## 7. 状态持久化设计

状态持久化集中在 `src/state-store.ts`。

主要有两类文件：

### 7.1 `profile.json`

保存偏“插件配置级”的内容，例如：

- 账号
- 云区
- 设备选择
- 插件通知渠道 / 目标 / 显式关闭状态
- 唤醒词
- 对话窗口
- thinking / non-streaming / debug-log
- 上下文记忆限制

### 7.2 `console.json`

保存偏“控制台状态级”的内容，例如：

- 控制台访问 token
- 控制台事件流
- 音频播放清空时间戳
- `speakerMuteStates`，按设备保存播放静音模式、恢复音量和链路可靠性探测结果

这里有几个实现细节值得注意：

- 写文件前会自动 `mkdir -p`
- 文件权限在非 Windows 下是 `0600`
- 控制台事件最多保留最近 300 条，避免无限增长

这说明项目一开始就考虑了：

- 可恢复性
- 权限边界
- 文件体积控制

## 8. 小米侧客户端分层

`src/xiaomi-client.ts` 不是一个单一客户端，而是分成了几层。

### 8.1 `XiaomiAccountClient`

负责：

- 登录
- token store
- SID 维持
- 二次验证
- 调试日志

它也是“`Xiaomi token store is not ready.`”这类错误的来源层。

### 8.2 `MiNAClient`

负责走小爱云相关接口，例如：

- 获取设备列表
- 读取最新对话
- 播放、暂停、停止
- 音量
- 获取当前播放状态
- 直接播 URL / music request

### 8.3 `MiIOClient`

负责走 MIOT 动作调用，例如：

- pause
- play
- stop
- wake-up
- 音量 / 静音属性写入

### 8.4 `MiotSpecClient`

负责读取设备 spec，并通过 `pickSpeakerFeatures()` 提取出这个机型支持的：

- play
- pause
- stop
- wakeUp
- volume
- mute

这套分层的意义很重要：

- MiNA 负责“小爱云”和播放器控制
- MiIO / MIOT 负责“设备动作”
- 设备能力来自 spec 探测，而不是完全硬编码

这也是项目能尽量兼容不同型号的基础。

## 9. 初始化与就绪流程

真正的初始化发生在 `ensureReady()` 和 `initialize()`。

核心流程：

1. 读取配置
2. 初始化 `XiaomiAccountClient`
3. 维护调试日志状态
4. 初始化 `MiNAClient / MiIOClient / MiotSpecClient`
5. 解析目标设备
6. prime 会话游标，避免启动后第一轮把旧消息当新消息
7. 持久化已解析出的配置与设备
8. 标记 ready，并写入控制台事件

这里有两个设计点很关键：

### 9.1 `initPromise` 去重

`ensureReady()` 会缓存初始化 Promise。

也就是说，如果多个逻辑同时要求“确保插件就绪”，不会并发跑多次初始化，而是复用同一个 Promise。

### 9.2 初始化失败不会直接死掉

如果失败：

- 会判断是不是“登录未完成 / token store 未准备好 / 设备未选好”
- 会自动生成登录入口
- 会给用户推送登录通知
- 会把问题写进控制台事件和调试日志

这就是为什么它能从“错误”平滑落到“引导用户继续完成登录”。

## 10. 登录门户与二次验证

登录相关代码主要在：

- `src/auth-portal.ts`
- `src/provider.ts`

### 10.1 登录入口的生成方式

插件会创建一个临时登录会话，并生成：

- gateway 路由入口
- 必要时的 standalone 入口

然后通过 OpenClaw 通知用户打开这个地址完成登录。

### 10.2 为什么要有 portal

因为单靠配置文件写账号密码，不足以覆盖：

- 首次登录
- 设备发现
- 二次验证
- 登录态恢复

portal 的价值是把这些交互性很强的流程从“命令行运维动作”变成“用户自己在网页里完成”。

### 10.3 二次验证

项目显式支持：

- 验证码输入
- 小米返回 verification challenge
- ticket 继续登录

登录成功后会：

1. 持久化配置和设备
2. 调用 `reinitializeAfterLogin()`
3. 重新恢复轮询
4. 给用户发登录成功通知

## 11. 设备发现与设备选择

设备解析逻辑在 `resolveDeviceContextFor()`。

它会同时参考：

- 配置里显式给的 `miDid / minaDeviceId / hardware / speakerName`
- MiNA 设备列表
- MiIO 设备列表
- MIOT spec

解析完成后，会拿到最终 `DeviceContext`：

- `hardware`
- `model`
- `miDid`
- `minaDeviceId`
- `name`
- `speakerFeatures`

如果账号已经登录但没有明确选中设备，插件不会直接报死错，而是把状态转成：

`账号已登录，请先在概览页选择要接管的音箱。`

这是为了把问题留在用户能操作的控制台里解决，而不是变成后台僵死状态。

## 12. 会话轮询模型

核心轮询逻辑在：

- `startPolling()`
- `pollConversationOnce()`
- `fetchLatestConversation()`

轮询模型不是 websocket push，而是主动轮询小爱对话记录接口。

这个选择的现实原因是：

- 小米侧并没有给这个项目提供稳定的官方推送通道
- 轮询虽然不完美，但可控、可调优、可恢复

轮询时插件会做这些处理：

1. 取最新一条对话
2. 用 `timestamp / requestId / query` 去重
3. 忽略空 query
4. 忽略最近主动执行过的自触发指令
5. 把用户 query 和小爱 answer 写进控制台事件
6. 根据当前模式决定是否拦截

## 13. 三种工作模式

模式只有三个，但非常关键：

### 13.1 `wake`

默认模式。

只有在以下情况才接管：

- 用户说中了唤醒词
- 当前仍在“免唤醒对话窗口”内

### 13.2 `proxy`

完全接管。

所有被轮询到的语音都认为应交给 OpenClaw。

### 13.3 `silent`

不接管，只保留主动播报和主动控制能力。

模式切换会直接影响 `handleIncomingQuery()` 的分支判断。

## 14. 唤醒词与窗口期

这两部分共同决定 `wake` 模式下的接管边界。

### 14.1 唤醒词

不是只支持固定字符串，还支持正则源码。

运行时会编译成 `wakeWordRegex`。

### 14.2 窗口期

当插件成功播报或音频开始播放后，会调用 `armDialogWindow()`。

在窗口期内：

- 后续对话可以不再显式说唤醒词
- 插件会继续把语音当成同一段连续对话来接管

这使得交互更接近真实语音助手，而不是每句都要重新唤醒。

## 15. 拦截主链路

整条拦截链路最关键的函数是：

- `interceptAndForward()`
- `silenceSpeaker()`
- `forwardToOpenclaw()`
- `sendTransitionPrompt()`

现在的执行顺序是：

1. 标记 `waitingForResponse = true`
2. 进入快轮询阶段
3. 按当前设备的预计原生起播时间，调度主拦截
4. 立刻把 query 转发给 OpenClaw
5. 如果这台设备历史上存在漏拦截，再挂有限次数的补偿 guard
6. 如果 OpenClaw 还没真正开口，再播一句短过渡语

这里有几个关键设计：

### 15.1 主拦截不是越早越好

当前版本不再把“刚进入拦截链路就立刻闭嘴”当成默认策略。

原因很直接：

- 小爱如果还没真正开始播，过早打断经常会打空
- 打空以后，后面的原生播报还是会照样出来
- 真正有效的是“贴着预计起播点打第一枪”，而不是无限提前

所以现在的主链路收敛成：

1. 根据当前设备的 `nativePlaybackStartEstimateMs / interceptLeadEstimateMs / pauseCommandEstimateMs`
   推一个主拦截时间点。
2. 如果已经观察到“答案先回写了”这类晚拦截信号，就立即改成零延迟强拦截。
3. 如果还没有这些信号，就等到预计窗口附近再打。

### 15.2 第一枪用 `fast-stop`，后面只做有限补刀

主拦截现在优先走一次 `fast-stop`：

- 并发尝试 MiNA `playerPause`
- 并发尝试 MiNA `playerStop`
- 如果机型支持，再并发尝试 MIOT `pause / stop`
- 只把这组并发动作当成“一次主拦截”

这样做的目标不是“花哨”，而是把真正会让音箱闭嘴的底层路径在同一枪里一次打出去。

但后续补刀不会无限重复。

运行时现在只保留有限次数的补偿：

- 总体思路是 `1 次主拦截 + 最多 2 次补偿`
- 保守 guard 默认只补 `pause`
- 只有运行时真的观测到“原生播报又起了”，才允许再补 1 次强拦截
- 补偿之间还有最小间隔，避免在同一个窗口里无意义连打

这样可以同时避免两个问题：

- 太早拦截，打空
- 太晚或打太多，把后续链路搞乱

### 15.3 校准和运行时必须共用同一时间口径

对话拦截校准现在不再混用“发指令前”和“发指令后”的时间锚点。

当前口径是：

- `commandDispatchMs` 单独记录“测试问句真正发出去花了多久”
- `conversationVisibleMs` 从命令被设备接受后开始算
- `nativePlaybackStartMs` 也从同一个锚点开始算

这样算出来的 `interceptLeadEstimateMs` 才能真的指导运行时主拦截窗口，而不是把 MIOT 指令派发耗时误算进拦截提前量。

### 15.4 转发和打断并行

`forwardToOpenclaw()` 不会等主拦截成功后再开始。

它和 `silenceSpeaker()` 是并行的。

这样做的目的，是在不牺牲打断速度的前提下，把“OpenClaw 开始生成回复”的等待时间提前。

## 16. OpenClaw 转发模型

OpenClaw 转发不是把文字简单扔给默认主会话，而是尽量走专属的小爱语音 agent。

### 16.1 为什么要专属 agent

核心原因是避免 session lock 和上下文污染。

如果和主会话混用，会出现：

- 小爱语音和主对话互相抢 session
- 子会话过多
- 上下文混乱

### 16.2 安装脚本如何处理

`scripts/configure-openclaw-install.mjs` 会自动：

- 创建或复用 `xiaoai` agent
- 为它创建轻量 workspace
- 合并必要的 `xiaoai_*` 工具 allowlist
- 写入更适合语音的 agent 提示词

也就是说，“小爱专属 agent”不是靠用户手动拼配置出来的，而是安装阶段自动完成的。

这里的“轻量 workspace”现在有一个明确约束：

- 默认会准备 `AGENTS.md`、`IDENTITY.md`、`TOOLS.md`、`HEARTBEAT.md`、`MEMORY.md`
- 不再默认生成 `BOOT.md`
- 如果发现旧版本残留的 `BOOT.md` 仅包含“无需启动动作。”这类占位内容，会在安装时清理掉
- `HEARTBEAT.md` 默认只写注释模板，不写实际任务内容；这样既保留文件位点，也符合 OpenClaw 官方对“空文件或仅注释可跳过 heartbeat 调用”的语义

这样处理的原因是：

- `BOOT.md` 一旦存在，就会参与 boot check
- 这个插件当前默认并不需要 boot 动作
- 与其长期生成一个“什么也不做”的 `BOOT.md`，不如默认不生成，让控制台按需启用

### 16.2.1 Workspace 文件控制语义

控制台和 `xiaoai_update_settings` 现在都支持直接修改 `xiaoai` 专属 agent 的 workspace 文件。

这里还有一个额外的边界约束：

- 读取和写入这些文件时，只认 `xiaoai` agent 自己显式配置的 workspace
- 如果 `xiaoai` agent 条目存在但没写 `workspace`，插件会直接报错
- 不再为了“兜底”回退到 `agents.defaults.workspace`，避免误改主 agent 的 workspace 文件

当前受控文件包括：

- `AGENTS.md`
- `IDENTITY.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `BOOT.md`
- `MEMORY.md`

但它们的“禁用”语义不能一刀切，原因来自 OpenClaw workspace 的标准行为：

- 标准文件会被宿主注入上下文
- 空文件会被跳过
- 缺失标准文件可能会触发 missing-file 标记

因此当前实现明确分成三类：

1. `AGENTS.md`
   核心提示文件，不支持禁用。只能编辑，留空保存时恢复默认内容。
2. `BOOT.md`
   特例文件。禁用时直接删除文件，重新保存任意内容时重新创建。
3. `IDENTITY.md / TOOLS.md / HEARTBEAT.md / MEMORY.md`
   禁用时保留文件但写成空内容，借助 OpenClaw “空文件跳过注入”的语义实现禁用，避免直接删除后触发 missing-file 标记。

这也是为什么控制台里虽然统一叫“禁用文件”，底层实际动作并不完全相同。

### 16.3 Prompt 设计

`forwardToOpenclaw()` 生成的 prompt 里会包含：

- 上下文摘要
- 必要时的“这是新会话”提示
- 最新用户语音
- 一段非常明确的系统要求

系统要求大意是：

- 这是小爱音箱实时语音对话
- 目标是尽快开口回答
- 默认优先调用 `xiaoai_speak`
- 如果已有可播放音频 URL，可以直接返回 `mediaUrl / mediaUrls`
- 不要额外说“已播报”

这套 prompt 设计直接影响说话速度和工具选择。

### 16.4 与 OpenClaw 官方 OpenResponses 文档对齐

为了处理部分上游流式实现不规范带来的报错，当前项目支持切到 OpenClaw 官方 `/v1/responses` 非流式接口。

这里已经按官方文档做了两层收敛：

- `model` 不再只写模糊的 `openclaw`，而是显式写成 `openclaw:<agentId>`
- 当语音入口存在稳定会话键时，会把它写入 `user`
- 同时继续保留 `x-openclaw-agent-id` 和 `x-openclaw-session-key` 作为兼容头

这样做的原因很直接：

- `agentId` 显式进入 `model`，更贴近官方推荐的 agent 选择方式
- `user` 可以帮助网关派生稳定会话，不必完全依赖私有头
- 保留兼容头后，旧环境和新环境都更稳

另外还要注意一个前提：

- `/v1/responses` 默认不是天然可用的，必须先启用 `gateway.http.endpoints.responses.enabled`

所以控制台里的“强制走非流式请求”并不是前端假开关，而是会真正驱动网关配置对齐官方能力。

## 17. 会话复用与“新会话”

小爱语音入口默认不是“每问一次都新建一个会话”。

当前策略是：

- 固定复用一个语音入口会话 key
- 只有用户明确要求“新会话 / 重置上下文”时才切换

对应逻辑：

- `resolveOpenclawVoiceSessionKey()`
- `shouldStartNewVoiceSession()`
- `xiaoai_new_session`

这解决了之前“子会话太多、上下文断掉”的问题。

## 18. 上下文记忆与摘要压缩

上下文记忆不是无限拼接，而是有限、分层、按会话隔离。

核心结构：

- `voiceContextTurns`
- `voiceContextArchiveSessionKey`
- `voiceContextArchiveText`

策略是：

1. 每次用户说话或插件成功播报时，记录一条 turn
2. 只保留最近 `N` 轮
3. 超出的旧 turn 会被合并压缩到 archive
4. 构造 prompt 时，先放 archive，再放最近几轮
5. 总字符数受 `voiceContextMaxChars` 控制

这套设计兼顾了三件事：

- 连续对话需要上下文
- prompt 不能无限膨胀
- 超过阈值的内容不能直接粗暴丢掉

## 19. 工具系统

插件注册的工具不止一个“播报”。

关键工具包括：

- `xiaoai_speak`
- `xiaoai_play_audio`
- `xiaoai_tts_bridge`
- `xiaoai_execute`
- `xiaoai_set_volume`
- `xiaoai_get_volume`
- `xiaoai_new_session`
- `xiaoai_wake_up`
- `xiaoai_set_mode`
- `xiaoai_set_wake_word`
- `xiaoai_get_status`
- `xiaoai_login_begin`
- `xiaoai_login_status`
- `xiaoai_console_open`
- `xiaoai_set_dialog_window`

设计原则很清楚：

- “回答用户”优先 `xiaoai_speak`
- “让设备干活”优先 `xiaoai_execute`
- “音频回复”走 `xiaoai_play_audio`
- “需要走 OpenClaw 官方 TTS 音频链路”走 `xiaoai_tts_bridge`
- “配置和排障”走状态类工具

这能明显减少“拿播报去读控制命令”的误用。

## 20. 音频系统：这是项目里最复杂的一块

音频是整个项目最复杂、也最容易踩坑的模块之一。

这里要明确区分四条链路：

### 20.1 链路 A：OpenClaw 返回 `mediaUrl / mediaUrls`

这条是“语音主链路”里的音频回复。

处理流程：

1. OpenClaw 返回 payload
2. 插件解析 `mediaUrl / mediaUrls`
3. 先尝试让音箱本体播放
4. 如果失败，会在事件流里记录“浏览器兜底”事件，供控制台预览

注意：

这里仍然保留“浏览器兜底事件”的概念，因为它是 OpenClaw 音频回复的应急可视化手段。

### 20.2 链路 B：OpenClaw 官方 TTS -> 小爱播放

这条链路是当前新增的专用音频能力。

处理流程：

1. OpenClaw 调用 `xiaoai_tts_bridge`
2. 插件优先调用 OpenClaw 官方 `runtime.tts.synthesizeSpeech / textToSpeech`
3. 拿到音频 buffer 或临时音频文件后，写入插件自己的 `tts-cache`
4. 再通过插件自己的 `audio-relay` 暴露出去
5. 最后让小爱播放这段 relay 音频

这条链路的意义在于：

- 不再依赖第三方临时 TTS URL
- 把“文本播报”和“音频回复播放”彻底区分开
- 让后续跨 claw 项目适配时更容易复用音频输出层

这里要特别说明一件事：

OpenClaw 官方文档还能看到 `runtime.tts.textToSpeechTelephony(...)` 这一类更底层的能力，但它返回的是更接近 telephony/PCM 级别的数据，不是当前项目最适合直接复用的主链路。

原因是：

- 实时语音场景优先要稳定，不要为了“理论上更底层”就引入额外的编码假设
- 不同宿主对 `runtime.tts` 暴露的方法未必完全一致
- 当前项目先走宿主已经暴露的 `synthesizeSpeech / textToSpeech`，再借助本地缓存和 relay，风险更低

所以当前实现不是“忽略官方文档”，而是优先采用官方文档里更容易稳定落地的那一层 API。

还有一个维护时很容易忽略的点：

`xiaoai_tts_bridge` 只是“负责把文本转成音频，再交给播放器”的桥接层，它并不天然保证“播放结束就一定干净地停下”。

真正决定短音频是否会播完后被错误重放的，不是 TTS 桥接本身，而是后面的外部音频播放层是否正确处理了：

- loop type
- 播放状态回读延迟
- 播放结束时机判断
- 停止指令的落地验证

这也是为什么后面单独有“外部音频防循环”章节，而且这部分逻辑同时覆盖：

- 普通 `mediaUrl / mediaUrls`
- 控制台手动播放 URL
- `xiaoai_tts_bridge` 生成的短音频

### 20.3 链路 C：控制台手动输入音频 URL

这条是“用户在网页控制台手动输入 URL”的链路。

当前行为已经收紧：

- 只尝试让音箱本体播放
- 音箱没有真正开始播放时，直接返回错误
- 前端只弹 toast
- 不再自动回退到浏览器预览

这是为了避免“失败后又悄悄换成浏览器放”的多余行为。

同时，这条链路当前已经改成“先本地标准化，再交给小爱”：

- 外部 URL 会优先在本地转成统一 MP3
- 插件再把这段标准化后的音频通过 relay 地址交给音箱
- 如果本地标准化失败，才退回原始 URL 尝试

### 20.4 链路 D：控制台事件页的音频预览

这是浏览器侧的预览能力，不是音箱播放能力。

它主要用于：

- 回看历史事件里的音频
- 预览被标记为“浏览器兜底”的音频事件

换句话说：

- 事件页预览是浏览器播放器
- 手动 URL 播放是音箱播放器
- 两者已经不再混用

### 20.5 借鉴 Home Assistant / hass-xiaomi-miot 的成熟做法

这次音频和播报链路的整理，不是闭门造车，而是明确参考了两条成熟实现线：

1. `hass-xiaomi-miot`
2. `Home Assistant` 自己的 TTS 框架

先说 `hass-xiaomi-miot`。

它在小爱文本播报和指令执行上，核心思路很清楚：

- 文本播报优先走设备规格里更原生的播报动作
- 没有原生动作时，再回退到 `message_router.post`
- 真到规格不齐时，再考虑 MiNA 侧兜底

当前项目已经按这个思路收敛：

- `playText()` 优先 `play_text`
- 失败后回退 `message_router.post`
- 再回退 `mina.textToSpeech(...)`
- `executeDirective()` 优先 `execute_text_directive`
- 缺失时回退 `message_router.post`

这意味着项目在“小爱能力调用顺序”上，已经不再是拍脑袋试错，而是尽量贴近现有成熟生态。

再说 `Home Assistant` 的 TTS 体系。

它更成熟的地方不在于“能不能播”，而在于：

- 有稳定的缓存模型
- 有格式协商意识
- 会尽量避免重复生成同一段音频

当前项目没有把 HA 那整套缓存与格式协商完整照搬进来，原因是语音主链路的目标不同：

- HA 更偏“媒体与自动化”
- 本项目更偏“实时语音入口和极速回播”

但这次已经明确借鉴了它最有价值的一部分：

- `xiaoai_tts_bridge` 增加了基于文本哈希的磁盘缓存
- 重复文本不再每次重新调用 `runtime.tts`
- 缓存文件带 TTL 和数量上限，避免无限膨胀

所以当前结论可以概括成一句话：

- 文本播报/执行链路，向 `hass-xiaomi-miot` 的设备动作回退顺序靠齐
- TTS 音频链路，向 `Home Assistant` 的缓存思路靠齐
- 但语音主链路仍然坚持“优先 `xiaoai_speak`，把首句开口速度放在第一位”

## 21. 音频播放策略与能力探测

让音箱播放外部音频，不能只发一次 URL 就结束，因为不同机型、不同固件的兼容性差异很大。

`playAudioUrl()` 做的事情非常多：

1. 只接受 `http/https`
2. 看这个 URL 最近是否刚失败过
3. 必要时先 pause 当前音频
4. 对外部音频尽量先做本地标准化
5. 评估是否更适合 relay
6. 评估是否更适合 structured music
7. 评估是否需要 mp3 relay
8. 按策略顺序逐个尝试
9. 每次尝试后验证“是否真的开始播放”
10. 成功就记住策略
11. 失败就记录能力失败缓存

实际可能用到的策略包括：

- `original-direct`
- `original-music`
- `relay-direct-mp3`
- `relay-direct`
- `relay-music`
- `relay-music-mp3`

这也是项目里“通用方案”真正落地的部分，不是简单的机型硬编码分支。

## 22. `audio-relay` 的作用

`audio-relay` 是插件自己的一个 HTTP 路由能力。

它主要解决这些问题：

- 音箱对外链直放不稳定
- 某些源站不适合音箱直接拉流
- 某些机型更适合 `player_play_music`
- 某些音频需要转成 mp3
- 某些音频不是“代理上游 URL”，而是插件本地生成的缓冲音频，例如 TTS 桥接结果

它不是“为了炫技多加一层代理”，而是为了提高不同设备上的音频起播成功率。

## 23. 外部音频防循环

之前出现过“测试音频反复循环播放”的问题。

当前实现里加入了 external audio loop guard，用来：

- 记录外部音频的预期 `audioId`
- 暂时切换 loop type
- 在预计播放结束前主动安排停止时机
- 到点时优先直接触发停止，而不是等下一轮轮询
- 在停止后恢复原 loop 配置

这部分逻辑的价值在于避免音箱把外部音频错误地当成持续循环列表的一部分。

### 23.1 为什么不能只靠 loop type

早期实现里，思路比较朴素：

- 播放前把 loop type 切到非循环
- 轮询 `player_get_play_status`
- 看到接近结尾、或发现已经重启到 `position=0` 时，再触发停止

这个思路在“长音频”上通常够用，但在“短 TTS 音频”上不稳。

问题不在于有没有 guard，而在于 guard 触发得太晚。

### 23.2 这次真实定位到的根因

这次不是拍脑袋怀疑，而是直接从日志里定位到的：

- 音频本身只有大约 `4.296s`
- `audio_loop_guard_armed` 已经成功挂上
- `audio_playback_started` 也确认拿到了有效 `audioId`
- 但最终不是在首轮播放结束前停掉
- 而是在音频已经重启、`position` 回到 `0` 之后，才由 `loop-restarted` 分支把它停掉

这说明前一版的主要问题不是“guard 没有工作”，而是：

- 仍然过度依赖轮询观察状态
- 设备上报的 `position` 本身有滞后
- 当轮询间隔、上报延迟和短音频时长叠在一起时，停止时机已经晚于首轮结束点

换句话说，真正的问题是：

- 以前的实现更像“发现它已经重播了，再去补救”
- 现在需要的是“在预计结束点之前主动切断”

### 23.3 当前实现的双保险结构

现在的 guard 不是单一机制，而是双保险：

1. 继续保留轮询 guard
2. 额外引入独立的 `deadline timer`

当前 guard 保存的信息包括：

- `expectedAudioId`
- `restoreLoopType`
- `startedWithUrl`
- `deadlineAtMs`

工作方式是：

1. 外部音频一旦验证为“确实开始播放”，就立刻 arm guard
2. 如果启动快照里已经有 `duration / position`，立即算出 `deadlineAtMs`
3. 同时挂一个独立 timer，到点直接进入停止逻辑
4. 轮询线程继续保留，用来处理：
   - 音频被别的内容替换
   - loop type 被外部改回
   - 状态已经自然结束
   - 没拿到初始 duration，后续再动态补 deadline
5. guard 结束时统一清理 timer，并恢复原 loop 配置

这个结构的关键价值是：

- timer 负责“抢时机”
- 轮询负责“补状态”

两者职责分开后，短音频就不再完全受制于状态回读节奏。

### 23.4 为什么还要把 deadline 前移

即使加了 timer，如果截止点还精确卡在“理论播放结束时间”，仍然可能偏晚。

原因是设备返回的：

- `position`
- `duration`

并不是严格意义上的实时硬件时钟，而更像带缓存的云端状态快照。

所以当前实现会把 deadline 适度前移一个很小的提前量，用来抵消：

- `position` 上报滞后
- 云端接口响应时间
- 停止指令真正落地的验证时间

这里的原则不是“越早越好”，而是：

- 只前移一个很小的安全边界
- 优先避免首轮播完后重启
- 不把正常尾音截得太明显

### 23.5 到点后具体怎么停

deadline 到点后，当前实现不会再等一整轮普通轮询，而是直接进入专门的 deadline 处理路径：

1. 尝试快速读取一次当前播放状态
2. 如果发现已经结束或已被其他音频替换，直接 finish guard
3. 否则立即走 `stopSpeaker(...)`
4. `stopSpeaker(...)` 内部不是单发一个 stop 就结束，而是：
   - 先发 stop
   - 如果没有 settle，再补 pause / stop 兜底
   - 最终接受 paused 或 stopped 作为成功状态
5. 停止成功后清理控制台当前音频状态
6. 最后 finish guard，释放 timer，并在需要时恢复原 loop type

这里的重点是：

- “停止”不是只发一条命令
- “防循环”也不是只看一帧状态

必须把“命令发送”和“状态核验”连成一个完整闭环。

### 23.6 日志里该怎么看这块是否正常

排查这类问题时，最有价值的日志关键字是：

- `audio_loop_guard_armed`
- `audio_playback_started`
- `audio_loop_guard_deadline_set`
- `audio_loop_guard_deadline_timer_set`
- `audio_loop_guard_finished`

如果 `audio_loop_guard_finished.reason` 是：

- `...-stop`
  说明 guard 在截止点主动触发了停止，这是理想路径。
- `...-completed`
  说明回读状态已经确认自然结束，没有检测到错误重播。
- `loop-restarted`
  说明这次仍然是“已经重播后才补救”，要继续看 deadline 是否太晚，或者设备状态回读是否异常。
- `...-expired`
  说明 deadline 触发了，但停止指令没有在预期内 settle，需要继续看设备 stop/pause 支持情况。

所以以后再遇到“播完后怎么又重放一段”的问题，不要先猜：

1. 先看有没有 `audio_loop_guard_armed`
2. 再看有没有 `audio_loop_guard_deadline_timer_set`
3. 最后看 `audio_loop_guard_finished.reason`

这三步基本就能判断问题是在：

- guard 没挂上
- deadline 没算出来
- 还是停止命令没有真正生效

### 23.7 2026-04-02 这轮修复到底改了什么

前一版虽然已经把 `deadline timer` 挂上了，但在极短音频上仍然会慢半拍。

真实日志里最后定位到的剩余问题是：

- deadline 路径在真正发 `pause` 前，仍然会做一次带超时的状态预读
- `sendPauseCommand()` 之前用的是并发延迟重试，`[0, 120]` 会把第二次 pause 也一起发出去
- guard finish 之前还会等待 loop type 恢复
- 停止后还会再做一次状态确认，进一步拉长尾部

这几件事单独看都不算大，但叠在一起后，对 `2s` 到 `3s` 的短音频就已经足够致命。

这次收敛后的关键改动是：

1. `pause` 重试改成串行逻辑，fast path 只允许单次快速 pause，不再提前排队一个 `120ms` 的重复 pause。
2. deadline 路径优先复用 loop guard 最近一次播放快照，避免在截止点前后再被一次慢状态查询拖住。
3. deadline 里的预检查超时进一步缩短，只保留一个非常小的探测窗口。
4. deadline 成功停下后，不再同步等待停止后的再次状态确认。
5. loop type 恢复改成后台执行，不阻塞 `audio_loop_guard_finished`。

这几个改动的目标非常明确：

- deadline 到点就更果断地处理
- 不让“为了确认而确认”的请求把停止时机拖过尾部
- 把“停止动作的实时性”和“后续状态整理”拆开

### 23.8 2026-04-02 最新回归结果

这次不是只改代码没验证，而是直接在云端用真实插件接口回归。

测试环境：

- 时间：`2026-04-02`
- 入口：控制台 API `POST /api/xiaoai-cloud/api/speaker/play-audio`
- 测试文件：`http://47.254.206.25/api/xiaoai-cloud/audio-relay/testshort20260402a.mp3`
- 文件时长：约 `2.304s`
- 音量状态：`volume=0` 且 `muted=true`，因此测试不会实际出声

结果：

- 连续 `4` 轮回归都没有再出现 `loop-restarted`
- 连续 `4` 轮的 `audio_loop_guard_finished.reason` 都是 `armed-completed`
- 结束时间与 `deadlineAtMs` 基本贴合，没有再出现之前那种“晚一个状态轮询窗口”的拖尾

其中一轮的精确样本是：

- `startedTs = 2026-04-02T04:25:22.807Z`
- `finishedTs = 2026-04-02T04:25:24.884Z`
- `deadlineAtMs = 1775103924883`
- `reason = armed-completed`

同一轮里唯一一次 `pause` 发生在：

- `2026-04-02T04:25:17.797Z`

它比 `startedTs` 还早，因此这是播放前的 interrupt 清场，不是播放尾部的补救 pause。

这意味着在当前这组回归场景里，问题已经从：

- “播放完又重播一段，再被 stop/pause 拦下”

收敛成了：

- “首轮自然结束，guard 正常完成”

### 23.9 2026-04-02 关于 `loop_type` 的实测结论

这次专门验证了一个很容易让人误判的点：

- 能不能不要再做 deadline / pause 守卫
- 直接把 `loop_type` 改成“单曲播完停止”

结论是：在当前这条“小爱外部音频 URL / 外部音频列表”链路上，不能指望 `loop_type` 单独解决问题。

实测过程不是只看插件日志，而是直接绕过插件的停止逻辑，调用小米云原始接口观察设备状态：

1. `player_play_music` + 默认 `loop_type=1`
2. 先 `player_set_loop(3)`，再 `player_play_music`
3. `player_play_music` 启动后，再补发一次 `player_set_loop(3)`
4. `player_play_url`

实测现象非常稳定：

- `player_play_music` 会把刚设置的 `loop_type=3` 又覆盖回 `1`
- 就算播放开始后再次把 `loop_type` 改成 `3`，音频仍然会从头回绕
- `player_play_url` 也一样会出现同类回绕，不是只有 `player_play_music` 才这样

也就是说：

- `loop_type` 的显示值不等于这条外部音频链路的真实“播完即停”行为
- 单条外部音频在某些机型/某些播放模式下，仍然会天然回绕
- 这个问题不能靠“把 loop type 改对”一次性解决

所以当前项目里真正可控、且对不同型号更通用的方案仍然是：

1. 用真实播放进度而不是“请求已受理时间”计算守卫时机
2. 不在 `status=2 + position=0` 的伪起播阶段提前下 deadline
3. 接近尾部时加快轮询，优先识别“回绕到开头”的位置跳变
4. deadline 只作为兜底，不再用它做激进的提前截断

这次最终版本的回归结果是：

- 新 TTS 音频进入 `status=2` 后，没有再回到 `status=1` 继续推进
- 在连续约 `70s+` 的真实状态轮询里，没有再观察到“完成后偷偷重新播放”
- 因此这次修复解决的是“提前掐断 + 播完重放”这一组组合问题，而不是单纯把 loop type 改了一个数值

### 23.10 2026-04-02 `speaker/play-audio` 返回时延优化与回退结论

修完“播完重放”之后，又专门追了一轮控制台接口返回时延。

目标不是“让音箱更早真的开口”，而是缩短：

- `POST /api/xiaoai-cloud/api/speaker/play-audio`
- 从收到请求到返回 `ok: true`

的时间。

这轮实测里，最初稳定版的返回时间大约在：

- `4.3s`

后面做了两组真正留在稳定版里的优化：

1. 如果音箱当前本来就是空闲 / 已暂停，就不要无条件先跑一遍同步 `pauseSpeaker()`
2. `post-playback-start` 的 `player_set_loop(3)` 与 settle 校验改成后台执行，不再阻塞接口返回

这两组改动之后，云端真实回归结果收敛到：

- `~2.55s`

其中一次稳定样本是：

- `PLAY_MS = 2552`

同时满足：

- 首轮能正常播放
- `audioPlayback` 结束后回到 `null`
- 没有重新引入外部音频复播

但这轮优化里还有一个被明确回退的尝试：

- 只要本地 hosted relay 已经出现 `audio_relay_hit`
- 就更早把这次播放判定成“已开始”
- 不再先等第一份 `playerGetStatus`

这一步确实能把返回时间继续压到：

- `~2.15s`

其中一次样本是：

- `PLAY_MS = 2149`

但它也会把“播完重放”问题重新带回来。

回归日志里的典型特征非常明确：

- provider trace 里 `audio_playback_started.snapshot.status = 2`
- `position = 0`
- `relayHitObserved = false`
- nginx access log 里同一 relay 又开始每隔几秒被重复拉取

也就是说：

- `relay hit` 只能证明“音箱的 HTTP 客户端已经摸到了这个 relay”
- 不能证明“播放器状态已经跨过了伪起播 / 排队阶段，进入可安全 arm deadline 的稳定播放态”

最终保留下来的结论是：

1. `speaker/play-audio` 可以安全地去掉无意义的同步清场和同步 loop settle
2. 不能把“hosted relay 命中”单独当成稳定起播确认
3. 当前这条链路里，稳定优先的可接受结果大约就是 `2.5s` 级别，而不是继续为了几十到几百毫秒去牺牲防复播

所以后续如果再有人想继续压这个接口的返回时间，先看这次回退记录，不要重复把同一个坑再踩一遍。

## 24. 音量与静音的处理

音量和播放静音现在已经明确拆成两套状态，不能再用“音量是不是 `0`”去偷代替“是不是静音”。

当前逻辑是：

- 返回给前端的是独立快照：`percent`、`muted`、`deviceMuted`、`unmuteBlocked`、`muteSupported`
- 用户直接改音量时，只修改音量，不再把“非 `0`”自动等价成“取消静音”
- 如果当前处于软静音模式，改音量只会更新“恢复时应该回到多少音量”，不会偷偷把静音关掉
- 用户点静音按钮时，后端才进入“播放静音控制”流程

实现上：

- 优先走 MIOT volume property
- `speaker.mute` 只当作候选能力，不再把 spec 暴露出来的 `mute` 直接当成可靠开关
- 不支持时回退到 MiNA volume
- 静音切换时优先尝试设备 `mute`，如果真实回读证明不可靠，则降级为软静音
- 软静音的做法是记住恢复音量，然后把播放音量写成 `0`；取消静音时再恢复到记录下来的目标音量
- 如果设备 `mute` 和软静音两条链路都被真实验证为不可靠，则直接把 `muteSupported` 降为 `false`
- 可靠性结果按设备实例持久化到 `console.json -> speakerMuteStates`
- 通过 pending cache 减少 UI 抖动和设备状态延迟

这部分最关键的工程原则是：

- MIOT spec 只能回答“这个设备声称支持什么”，不能回答“这条链路真实可不可靠”
- 对播放静音这类状态型控制，最终判断必须基于“写入后再次回读”
- 所以兼容策略必须按设备真实行为动态降级，不能靠机型名单硬编码

## 25. 控制台后端架构

控制台后端完全挂在插件 HTTP 路由里。

主要分成四类路径：

### 25.1 `/console` 与 `/`

返回控制台 HTML 页面。

### 25.2 `/assets/*`

返回前端静态资源。

这里做了：

- 路径归一化
- 目录越权检查
- `ETag`
- `304 Not Modified`

### 25.3 `/api/*`

返回控制台 API：

- bootstrap
- conversations
- events
- speak
- play-audio
- pause / resume / stop
- wake-up
- volume
- mode
- wake word
- dialog window
- thinking
- non-streaming
- model
- openclaw route
- workspace file
- debug log
- voice context
- account logout

### 25.4 `/audio-relay/*`

提供音频 relay 服务。

## 26. 控制台访问鉴权

控制台不是裸开的。

它使用：

- 临时 access token
- `xiaoai_console_token` cookie
- HttpOnly cookie

访问方式通常是：

1. 调用 `xiaoai_console_open`
2. 插件生成带 token 的完整控制台链接
3. 用户打开链接
4. 页面写入 cookie
5. 后续使用 cookie 访问控制台

这也是为什么控制台链接明确要求只发到自己的私聊，不要转发到群聊。

## 27. 控制台前端架构

控制台不是 SPA 框架项目，而是：

- 服务端渲染 HTML 模板
- 一个前端 JS 文件
- 一个 CSS 文件

这样做的优点：

- 构建简单
- 依赖小
- 安装包更可控
- 直接跟插件 HTTP 路由绑定

### 27.1 前端主文件

- `src/console-page.ts`
- `assets/ui/xiaoai-console.js`
- `assets/ui/xiaoai-console.css`

### 27.2 页签职责

- `概览`
  账号、设备、模式、音量、日志、当前音频。
- `对话`
  对话列表、直接发消息、直接播报。
- `控制`
  模式、唤醒词、模型、通知渠道、窗口期、workspace 提示文件、日志、上下文记忆、非流式等。
- `事件`
  所有关键事件、异常、音频预览。

## 28. 最近做过的前端结构修正

为了保证这份文档和当前实现一致，这里记录当前几个关键前端结论：

### 28.1 对话页宽度

桌面端对话列表和输入区现在直接和 topbar 左右对齐，但气泡宽度仍然单独限制，避免一整行拉得太长。

### 28.2 控制页卡片布局

控制页现在使用固定双列分栏，而不是运行时 JS 瀑布流。

这样调整的直接原因是：

- 之前的瀑布流在卡片高度频繁变化时容易把相邻卡片位置带乱
- 音量、通知渠道、workspace 提示文件这类卡片都存在动态高度
- 布局稳定性比“尽量塞满缝隙”更重要

当前策略是：

- 桌面端使用两个 `control-column` 明确分栏
- 移动端退化成单列
- 卡片高度变化只影响所在列，不再触发整屏重排

### 28.2.1 控制页自动回顶的根因与修复

控制页前面还有一个很隐蔽的前端竞态：

- 页面每 3 秒会自动刷新 `bootstrap`
- 控制页里的卡片又会在刷新后重新做一次布局整理
- 旧逻辑没有保留 `.control-screen-scroll` 的滚动位置
- 结果就是用户在控制页往下滑几秒后，会被自动拉回顶部

这次修复不是去关掉自动刷新，而是把滚动位置当作控制页的局部状态保留下来：

- `refreshBootstrap()` 前先读取当前 `scrollTop`
- 渲染完成后在两次 `requestAnimationFrame` 里恢复滚动位置
- 控制页布局整理时也同样保留并恢复 `scrollTop`
- 同时给滚动容器加 `overflow-anchor: none`，避免浏览器自己的锚点修正再次抢滚动

2026-04-08 的真实浏览器回归里，已经在云端控制台把控制页滚到下方并跨过一次自动刷新周期，`scrollTop` 保持不变，没有再自动回顶。

### 28.3 事件页音频预览

之前事件页音频一放就停，根因是定时刷新整段重绘列表，把 `<audio>` 节点销毁了。

现在的处理是：

- 给事件列表构建签名
- 内容未变不重绘
- 音频播放期间跳过重绘
- 暂停 / 结束 / 出错后补刷积压的新事件

## 29. 性能设计

这个项目的性能优化，不是单点，而是一整组策略。

### 29.1 轮询提速

语音活动阶段会临时进入更快轮询节奏。

这能缩短：

- 识别到用户说话的延迟
- OpenClaw 回复后状态同步的延迟

### 29.2 拦截链路并行

主拦截调度和转发给 OpenClaw 并行执行。

这直接减少总等待时间。

### 29.3 优先“贴着窗口打一枪”

实践证明，真正稳定的不是“越早越好”，而是：

- 第一枪贴着预计起播点走一次强拦截
- 后面只做有限的 `pause` 补偿

收敛到“主拦截一次打准，补刀次数受控”，能减少无效分支和试错时间。

### 29.4 专属 agent + 会话复用

减少 session lock 和上下文切换开销。

### 29.5 上下文摘要压缩

控制 prompt 大小，避免每轮都把大段历史重复带给模型。

### 29.6 音频能力缓存

同一源失败后短时间内不重复走长链路探测。

### 29.7 静态资源缓存

控制台资源带 `ETag`，减轻反复打开控制台时的资源加载成本。

### 29.8 音量 pending cache

设备状态回写慢时，先用预期值稳住 UI，减少滑条抽动。

### 29.9 `play-audio` 快路径的边界

`speaker/play-audio` 的性能优化，不是简单地“把确认逻辑全删掉”。

当前稳定版保留的原则是：

- 音箱本来空闲 / 已暂停时，不做无意义的同步 interrupt
- `post-playback-start` 的 loop type 设置放后台，不阻塞接口返回
- `relay hit` 只能作为辅证，不能单独当成稳定起播完成

否则虽然接口返回会更快，但很容易把：

- 伪起播
- deadline 过早
- 外部音频再次回绕

这组问题重新引回来。

## 30. 安全边界

这个项目不是高隔离安全产品，但已经补了几条重要边界。

### 30.1 控制台不是公开无鉴权页面

靠带 token 的入口链接和 HttpOnly cookie 保护。

### 30.2 静态资源受目录约束

`/assets/*` 只允许读取插件资产目录内的文件，阻止路径穿越。

### 30.3 写状态文件时限制权限

持久化文件默认尽量写成仅当前用户可读写。

### 30.4 事件流和日志可控

- 事件只保留最近 300 条
- 调试日志支持开关和自动裁剪

### 30.5 登录入口要走私聊

因为控制台链接里携带访问 token，所以绝不应该往群里发。

## 31. 安装脚本设计

用户表面上只执行：

- `install.sh`
- `install.cmd`

但安装脚本实际上做了不少事情。

### 31.1 支持两种来源

- 源码仓库
- Release bundle

### 31.2 自动判断包管理器

- `npm`
- `pnpm`

### 31.3 自动构建

源码模式下会安装依赖并构建。

### 31.4 自动安装插件

支持：

- 正常安装
- `--dev` link install
- 已存在插件时先卸载再重装

### 31.5 修复 owner 问题

Linux 安装脚本会在非 dev install 下对安装后的插件目录做 owner 归一化，避免用户安装后因为目录 owner 不对导致后续 inspect / 读取失败。

这一步现在不只是“体验优化”，而是兼容 OpenClaw 新版安全检查的必要步骤。

在当前 OpenClaw 版本里，如果插件目录 owner 看起来可疑，宿主会直接拒绝加载插件，日志里会出现类似：

- `blocked plugin candidate: suspicious ownership`
- `plugin not found`

此时表面症状通常不是“权限报错”，而是：

- 插件工具消失
- 控制台路由变成 `404 Not Found`
- `plugins inspect` 看不到插件

### 31.6 安装后自动配置 OpenClaw

通过 `scripts/configure-openclaw-install.mjs`：

- 创建 / 复用专属 `xiaoai` agent
- 强制保证 `xiaoai` 不会变成默认 agent，避免抢占现有渠道入口
- 生成轻量 workspace
- 补齐 `xiaoai_*` 工具 allowlist
- 写入必要配置
- 自动推断当前已启用通知渠道与唯一目标；无法唯一识别时保守回退

这就是为什么 README 可以做到“普通用户不用手动改一堆 JSON”。

### 31.7 手工同步代码不等于完成安装

这次项目维护里又踩到一个很典型的部署坑：

如果只是把仓库文件手工复制到远端，并不等于插件已经处于可运行状态。

至少还要保证：

- `extensions/openclaw-plugin-xiaoai-cloud` 和 `plugins/openclaw-plugin-xiaoai-cloud` 两份目录内容一致
- `dist` 是当前源码重新构建出来的产物
- 目标目录已经安装运行时依赖，例如 `npm ci --omit=dev`
- owner 和权限已经被归一化
- Gateway 已重启

尤其要注意：

- 不要把本地文件直接用会保留 UID/GID 的方式覆盖到远端插件目录
- 例如 `tar | ssh`、某些默认保留 owner 的解包方式，都可能把远端目录写成“本地用户的 uid/gid”
- 一旦远端实际运行 OpenClaw 的用户和插件目录 owner 不匹配，OpenClaw 可能直接把插件屏蔽掉

更稳妥的做法是：

- 优先执行安装脚本
- 如果必须手工同步，解包时显式使用 `tar --no-same-owner`
- 或者使用 `rsync --chown=<OpenClaw运行用户>:<组>`
- 同步后立刻检查 `stat`，确认插件目录 owner 与 OpenClaw 运行用户一致
- 然后再执行 `openclaw gateway restart`

只做“复制文件”而跳过这几步，很容易出现：

- 跑的还是旧版 `dist`
- 插件入口和源码版本不一致
- 运行时缺依赖导致插件加载失败
- 宿主因 suspicious ownership 直接拒绝加载插件
- 控制台路由直接消失

### 31.8 不能假设 OpenClaw CLI 和 systemd 入口永远稳定

`2026-04-12` 这次云端复测又确认了一类更隐蔽、但破坏力很大的问题：

- OpenClaw 本体升级了
- 并不等于 `openclaw` CLI 一定还在 PATH
- 也不等于 systemd service 里写死的旧入口路径还有效

当时远端真实出现的是：

- `npm install -g openclaw@2026.4.11` 过程中全局目录一度进入半坏状态
- `openclaw-gateway.service` 仍然写着旧的
  `/usr/lib/node_modules/openclaw/dist/index.js`
- 结果每次“更新 OpenClaw”后，看起来像 Gateway 卡死
- 实际上是服务启动后立刻退出，再被 systemd 反复拉起

另外，远端还出现过另一种状态：

- OpenClaw 包文件已经在
- 但 `openclaw` 这个 CLI 可执行入口没有落到 PATH
- 此时安装脚本和卸载脚本都会直接报 `spawnSync openclaw ENOENT`

所以安装链路现在必须额外记住两条工程原则：

1. 安装/卸载脚本不能只假设 `openclaw` 一定在 PATH
   - 必要时要允许显式指定 `--openclaw-bin`
   - README 提示词也要把“修复 CLI 入口”写进排障项
2. systemd service 不应该长期硬绑某个历史版本的 `dist/index.js` 绝对路径
   - 更稳妥的是直接走 `openclaw gateway ...`
   - 让服务入口跟随当前 CLI 解析结果，而不是跟随某次历史安装目录

这类问题最容易把人误导成：

- “插件把云端弄炸了”
- “OpenClaw 更新后不兼容插件”

但更准确的说法应该是：

- OpenClaw 升级链路和服务入口没有被一起收敛
- 插件脚本只是把这个宿主级问题更早暴露出来了

所以以后如果用户反馈“每次更新 OpenClaw 后就卡死”，优先排查顺序应该是：

1. `openclaw --version` 是否还能直接执行
2. `openclaw-gateway.service` 的 `ExecStart` 是否仍然指向真实可执行入口
3. 全局安装目录是否存在半坏状态目录（例如 `.openclaw-*` / `openclaw.broken.*`）
4. Gateway 失败到底是插件加载失败，还是宿主入口根本没有启动成功

## 32. 发布打包与 CI

当前 GitHub Actions 做的事情包括：

- Linux `npm ci`
- Linux `npm run build`
- Linux `npm pack --dry-run`
- Linux 安装脚本自检
- Windows `npm ci`
- Windows `npm run build`
- Windows `npm pack --dry-run`
- Windows 安装脚本自检
- release bundle 打包
- Release 资产上传

release bundle 里会包含：

- `dist`
- `assets`
- `scripts/configure-openclaw-install.mjs`
- `scripts/configure-openclaw-uninstall.mjs`
- `package.json`
- `package-lock.json`
- `openclaw.plugin.json`
- `install.sh`
- `install.cmd`
- `uninstall.sh`
- `uninstall.cmd`

文档文件保留在仓库里阅读，不进入 release bundle。

### 32.1 2026-04-08 云端安装 / 卸载实测

这次不是只做本地静态检查，还直接在真实云端 OpenClaw 环境里把四条路径都走了一遍：

1. 安装脚本卸载
2. 安装脚本安装
3. `openclaw plugins uninstall`
4. `openclaw plugins install`

实测结果：

- `uninstall.sh --keep-agent --keep-history --non-interactive` 成功执行
- `install.sh` 成功完成依赖安装、构建、插件安装、`xiaoai` agent 恢复和 allowlist 修复
- `openclaw plugins uninstall openclaw-plugin-xiaoai-cloud --force` 成功移除插件
- `openclaw plugins install --force --dangerously-force-unsafe-install <path>` 成功重新装回插件
- 重装后 `openclaw plugins inspect openclaw-plugin-xiaoai-cloud --json` 返回 `status=loaded`

这里也顺带再次确认了一个产品层面的事实：

- 纯 `openclaw plugins install` 负责的是“把插件装进 OpenClaw”
- 仓库安装脚本负责的是“把插件装好并把外围配置收拾完整”

所以 README 里仍然推荐普通用户优先走仓库或 release 自带的安装脚本。

### 32.2 2026-04-12 云端 OpenClaw 更新与 README 提示词复测

`2026-04-12` 这次不是只验证插件本身，而是把“宿主更新 + 插件卸载 + 通过 OpenClaw 安装”整条链路重新走了一遍。

实际确认到的结果包括：

1. OpenClaw 成功更新到 `2026.4.11`
2. `openclaw-gateway.service` 改成了更稳妥的：
   - `ExecStart=/usr/bin/openclaw gateway --port 18798`
3. 卸载插件时，选择“删除 `xiaoai` agent，但保留历史记录”
   - 历史会正确备份到 `plugin-backups/`
4. 再用 README 里的“通过 OpenClaw 安装”提示词触发安装
   - 插件成功重新装回
   - `xiaoai` agent 成功重建
   - `main` 仍然保持默认 agent
   - 通知渠道和目标成功自动推断回原来的 Telegram 私聊目标

但这次也确认了一条很重要的产品行为边界：

- 通过 OpenClaw 提示词安装时，任务不一定会直接走到“控制台完全可用”
- 如果插件此时还没有可用的小米登录态，它会先生成一个临时登录入口
- 然后等待用户完成登录和选设备

也就是说：

- “安装成功”
  和
- “登录态已就绪、可以继续自动校准”

不是同一个完成点。

这也是为什么 README 里的提示词后来又补了一条约束：

- 把登录入口或控制台链接发给用户后，先停下来
- 不要让当前任务一直挂着等登录
- 用户明确回复“配置好了”以后，再继续跑校准

否则就会出现一个很差的体验：

- 插件其实已经装好了
- 但 `main` agent 的任务一直占着会话不结束
- 后续普通 `ping` 或其它测试消息都会被堵在同一个会话锁后面

这次复测后可以把结论收敛成：

- README 提示词安装链路本身是通的
- 真正需要收敛的是“首次登录前后，任务该不该继续挂住”的行为设计

## 33. 典型问题复盘

下面这些都是项目里真实踩过的坑。

### 33.1 `ETIMEDOUT / fetch failed / token store is not ready`

本质上混着两类问题：

- 小米云网络抖动
- 登录态还没准备好

当前处理方式是：

- 把明显的网络错误视为 transient error
- 初始化失败时优先引导用户登录
- 不把 token-store 未就绪一概当作致命崩溃
- `conversation` 这类会话轮询超时只代表小米云对话历史接口暂时不可达，不应拿它去推断 `muteSupported`、播放静音链路或音量回读链路是否失效
- 控制台在 `ready=true` 时，不应该把这类 transient error 当成主状态故障文案长期挂在“已连接”提示里

### 33.2 `session lock`

根因通常是语音入口和主会话混用。

当前解决方式：

- 强制推荐独立 `xiaoai` agent
- 固定复用语音入口会话
- 只有明确要求新会话时才切换

### 33.3 “关灯循环”

根因是设备控制语句被再次识别成新的用户意图。

当前解决方式：

- 优先用 `xiaoai_execute`
- 记录最近主动执行的指令
- 对短时间回灌做抑制

### 33.4 `Unexpected event order, got message_start before receiving "message_stop"`

这不是插件内部状态机自己乱了，而是上游某些 Anthropic 兼容流式实现不规范。

当前处理方式：

- 提供 `openclawForceNonStreaming`
- 可以切换到 OpenClaw 官方 `/v1/responses` 非流式接口

### 33.5 外链音频不同机型兼容性差

这是客观事实，不是一个简单 bug。

当前项目已经补了：

- 能力探测
- strategy 缓存
- relay
- mp3 relay
- loop guard
- deadline timer

但仍然不能保证所有机型、所有音频源都完全一致。

### 33.6 播放结束后又重复播放一段，甚至重复多次才停

这类问题和“音频兼容性”有关，但又不是简单的“某机型不支持播放”。

更准确地说，它通常出在：

- 音箱把外部音频当成可循环内容
- guard 结束判断偏晚
- 设备 `position` 上报滞后
- stop/pause 的状态核验不够完整

这次修复后的核心结论是：

- 不能只靠轮询等它自己暴露“已经重播”
- 必须在预计结束点之前主动挂 deadline timer
- deadline 到点后要直接进停止路径
- deadline 路径本身也要尽量短，不能再被额外的状态预读、重复 pause、同步恢复 loop type 拖慢
- 停止后的状态整理应该和“抢停止时机”拆开

### 33.6.1 2026-04-07 为什么本地部署和云端部署不能共用一套固定拦截时序

这次再次回看日志后，可以确认另一个常见误区：

- 问题不只是“有没有 deadline”
- 还包括“deadline 提前量是不是和当前部署环境匹配”

原因很直接：

- 本地部署时，`playerGetStatus`、`pause`、`stop` 往返通常更短
- 云端部署时，这些链路会多一段公网 RTT，状态回读和停止生效都会更慢
- 如果两边共用同一个固定 `lead ms`，本地可能过早截断，云端可能来不及拦住第一次重播

所以现在不能再依赖单一固定常量，而是改成：

- 固定安全基线
- 加上当前设备最近实测出来的延迟画像

当前纳入画像的量包括：

- `statusProbeEstimateMs`：一次 `playerGetStatus` 实测耗时
- `pauseSettleEstimateMs`：`pause` 到状态确认稳定的耗时
- `stopSettleEstimateMs`：`stop` 到状态确认稳定的耗时
- `playbackDetectEstimateMs`：播放请求被接受，到真正观察到起播的耗时

deadline 提前量现在按下面的思路动态计算：

- `max(320ms, commandSettle + statusProbe + 120ms, playbackDetect * 0.6 + statusProbe + 120ms)`
- 最终再夹在 `320ms` 到 `1800ms` 之间

这样做的意义是：

- 本地部署不会被无意义地额外提前太多
- 云端部署会自动把 deadline 往前提，给 `pause/stop` 留出足够落地时间
- 同一台音箱在同一次播放里，起播探测阶段采到的 RTT 也会立刻反映到这次 deadline 计算

这里要特别强调一遍：

- `relay hit` 仍然只能说明“音箱开始拉这个 URL”
- 不能单独拿它当“已经稳定起播，可以安全按固定剩余时长算 deadline”的信号

真正稳定的做法仍然是：

1. 起播验证阶段持续读宿主播放状态
2. 记录这条链路的真实探测/停止耗时
3. 用这些实时样本去推这次播放的 deadline lead
4. deadline 到点后走尽量短的 fast path，状态整理放后台

### 33.6.2 为什么要加静音校准和 `1.5s` 尾部保守留白

只靠运行时零散采样还不够稳定，尤其是在下面两种情况下：

- 用户刚换了音箱，当前设备还没有任何历史画像
- 部署环境刚从本地切到云端，或者网络 RTT 突然明显变化

所以现在又补了一层“可主动触发”的静音校准：

- 控制页新增“音频时序校准”卡片
- 后端提供 `POST /api/device/audio-calibration`
- 校准时播放的是静音样本，不会真的出声
- 每一轮都会测起播检测、停止收敛、状态探测
- 结果按设备写入 `speakerAudioLatencyProfiles`
- 最近一次校准摘要写入 `lastAudioCalibration`

这层机制的目的不是追求绝对精确，而是尽快把设备拉回“有可用时序画像”的状态。

另外，尾部安全留白也从原来的 `1000ms` 提高到了 `1500ms`。

原因是：

- 小米云状态回读本来就不是硬实时
- 云端部署时公网 RTT 会放大停止落地的不确定性
- 尾部多留 `0.5s` 的保守空间，整体比误判已结束后又被重播更划算

所以当前策略是：

- 动态 deadline 仍然按实时画像计算
- 但 relay 音频尾部统一再补 `1.5s` 静音留白
- 用户如果觉得某台设备时序偏差明显，就直接跑一遍静音校准

所以以后看到“短 TTS 更容易重播”，不要先怀疑 TTS 本身。

优先排查顺序应该是：

1. `audio_playback_started` 是否拿到了有效 `audioId`
2. `audio_loop_guard_deadline_timer_set` 是否出现
3. `audio_loop_guard_finished.reason` 是 `armed-completed`、`...-stop`，还是 `loop-restarted`
4. deadline 前后的 `player_play_operation pause` 是不是只发生在播放前清场，而不是播放尾部补救
5. 如果仍然走 `...-stop` 或 `loop-restarted`，再继续看 `stopSpeaker(...)` 最终有没有 settle 到 paused/stopped

### 33.6.3 对话拦截校准不能拿单台设备外推所有型号

这次继续收敛对话拦截时，又暴露出另一个容易把实现带偏的点：

- 某一台设备日志里“看不到原生回复起播状态”
- 不等于所有型号都看不到
- 某一台设备只能靠 fallback 拦截
- 也不等于应该给整个插件写死一套 `L05C/LX06/...` 型号表

真正稳定的做法只能是“按当前设备自己的校准结果决策”，而不是：

- 从单台设备的现象倒推出全局规则
- 依赖某组运行时阈值去猜“这台大概也是 fallback-only”
- 按 `hardware/model` 写死特判

现在这条链路已经改成显式的“设备级校准策略”：

- `conversationInterceptLatencyProfiles` 仍然按设备实例持久化延迟画像
- `lastConversationInterceptCalibration` 额外记录当前设备这次校准的 `strategy`
- `strategy` 只允许三种值：
  - `observable`
  - `mixed`
  - `fallback-only`

三种策略分别表示：

- `observable`
  校准轮次里都能直接观察到原生回复起播信号
- `mixed`
  有些轮次能观察到，有些轮次只能 fallback 估算
- `fallback-only`
  校准轮次全部只能依赖 fallback 估算

运行时行为也跟着收敛成了按策略走：

- `observable`
  主拦截链路按正常状态探测工作，不额外加保守 pause guard
- `mixed`
  仍然加保守 pause guard，因为这类设备已经证明“有时能看到，有时看不到”
- `fallback-only`
  一定加保守 pause guard

这里最重要的工程原则是：

- “是否需要保守补偿”由当前设备自己的校准摘要决定
- 不是由某台别的设备的日志决定
- 也不是由 `hardware/model` 名字决定

另外，这次还顺手修掉了一个会直接影响跨设备正确性的实现细节：

- fallback guard 现在仍然以“拦截开始时刻”为锚点调度
- 但主拦截本身不再默认立刻发送，而是贴着这台设备自己的预计起播窗口发出
- 并把 `pause` 命令自身耗时单独记为 `pauseCommandEstimateMs`
- guard 只保留有限次数，避免为了追求极限而在同一轮里过度补刀

这意味着：

- 同一个型号的两台设备，如果网络环境不同，也允许收敛出不同策略
- 同一台设备从本地部署切到云端部署后，也应该重新跑一次对话拦截校准
- 控制台或工具返回校准结果时，必须把 `strategy` 一并带出来，方便确认当前设备到底属于哪类

所以以后如果用户说“不能只看我一个设备的日志来收敛”，正确响应不是去补更多型号特判，而是：

1. 先确认当前切换到的是哪台设备
2. 看这台设备最近一次 `conversation calibration` 的 `strategy`
3. 如果没校准或环境刚变，就重跑这台设备自己的对话拦截校准
4. 再根据它自己的 `observable / mixed / fallback-only` 结果决定运行时拦截策略

### 33.6.4 为什么对话拦截校准里还会听到小爱先说几个字

这次继续排查后，确认过一个关键事实：

- 之前“校准后仍会先漏出几个字”，并不是因为用户没跑到新代码
- 而是校准路径和真实运行路径之前并不完全一致

真实运行时，对话拦截会这样做：

- 先根据当前设备画像推主拦截时间点
- 不再默认一开始就盲打 `silenceSpeaker()`
- 如果这台设备最近校准结果是 `mixed` 或 `fallback-only`
- 就从“拦截开始时刻”立刻挂上保守 `pause guard`

但旧版校准流程之前不是这样：

- 它一部分时间用“发指令前”的时间点算
- 另一部分时间又用“发指令后”的时间点算
- 校准 guard 也没有严格贴着运行时的主拦截窗口

这会直接导致两类偏差：

- 主拦截可能提得过早，出现“打空”
- `interceptLeadEstimateMs` 可能被派发耗时污染，导致后续窗口继续偏

所以之前会出现一种错觉：

- 运行时看起来还行
- 但校准时反而总能听到前几个字

现在已经把校准流程改成和运行时同口径：

- `conversationVisibleMs` 和 `nativePlaybackStartMs` 都改成从命令真正被接受后开始计时
- 校准 guard 也跟运行时一样，只保留有限次数补刀
- 并额外保留一小段观测窗口，避免太早下结论

这条修正的意义不是“完全保证零漏字”，而是：

- 让校准测出来的结果更接近真实运行时的行为
- 避免因为校准链路本身偏慢，误把问题甩给设备型号或网络环境

如果校准后仍偶发先漏一两个字，优先排查顺序应该是：

1. 这台设备最近一次校准 `strategy` 是不是仍然 `fallback-only`
2. 当前部署环境是否刚从本地切到云端，或反过来
3. 当前轮询间隔是否被调得过低，导致超时和抖动变大
4. 当前网络是否让 `pause / stop` 命令本身耗时明显上升

也就是说，“校准时漏几个字”首先是一个时序问题，不要先把它理解成 TTS、文案、或单一型号特判的问题。

### 33.6.5 为什么轮询间隔不能一味往低调，以及为什么要做自动退避

最近专门核过一轮线上日志后，可以确认两点：

- 插件的会话轮询不是并发风暴，而是串行拉取
- 配置里的 `80ms` 也不等于真的每秒硬打 `12.5` 次请求

真实观测里，即使把配置调到 `80ms`：

- `device_profile/v2/conversation` 的实际请求节奏仍然会被单次 RTT 拉长
- 云端样本里更接近 `~250ms/次`
- 也就是大约 `~4 req/s`

在已检查的那段日志里，没有直接看到 `429`，但这不代表可以无限继续往下压：

- 轮询间隔越低，对网络抖动越敏感
- 一旦小米侧接口本身开始慢、丢、超时
- 低间隔只会把 `ETIMEDOUT`、瞬时失败和恢复抖动进一步放大

所以这次把策略收敛成两条：

1. 配置值低于 `120ms` 时，控制台只通过 `toast` 提示风险，不往卡片里塞额外说明
2. 运行时一旦连续遇到瞬时网络错误或疑似限流，就自动把“实际生效轮询间隔”临时抬高

这里要特别区分两件事：

- 用户保存的配置值
- 当前运行时临时生效的退避间隔

自动退避只影响后者，不会偷偷改写用户保存下来的配置。也就是说：

- 你设的还是原来的值
- 但运行时为了活下来，会在一小段时间里按更保守的节奏去轮询
- 等错误窗口过去，再逐步恢复

当前退避触发条件主要包括：

- `ETIMEDOUT`
- 常见瞬时网络失败
- 疑似 `429 / rate limit / too many requests`

这样做的目标不是追求“永远最快”，而是：

- 在平稳网络下继续保持较快拦截
- 在小米侧慢下来时先保命，避免把整条链路拖进连续超时

工程上目前的建议下限仍然是：

- 不建议低于 `120ms`

如果用户硬要再压低，也不是完全禁止，但要理解代价：

- 不是一定触发风控
- 而是更容易把偶发慢请求放大成实际可见的抖动、超时和拦截不稳定

### 33.7 音量设为 `0` 后又跳回 `5%`

这次定位到的根因不是单一代码 bug，而是“设备行为 + 部署状态”叠在一起：

1. 这台 `L05C` 设备的真实回读状态是 `volume=5, mute=true`
2. 本地和 `plugins/...` 目录里的新版代码已经会读取 `mute`
3. 但远端实际运行的 `extensions/.../dist/provider.js` 还是旧版逻辑，只按 `volume` 算百分比
4. 于是控制台就把“已静音但底层回读 5”错误显示成了 `5%`

这类问题的教训很明确：

- 不能只看源码，要看远端实际运行的 `dist`
- 不能只同步一份目录，要同时核对 `extensions` 和 `plugins`
- 对带状态设备，必须用真实接口回读验证，而不是只看前端显示

修复后正确表现应该是：

- 控制台必须把“音量数值”和“播放静音状态”分开表示
- 设备回读为 `volume=16, mute=true` 时，前端应该显示为“`16% + 已静音`”
- 不能再因为底层 `volume` 保留为 `5/16`，就把它误显示成“未静音”

### 33.8 设备 `mute` 链路可能单向可写，不能按机型硬编码处理

这次由一台 `L05C` 真机把问题暴露出来，但结论不是“给 `L05C` 写死特判”，而是更通用的一条：

- 某台设备 spec 里有 `speaker.mute`
- `speaker.mute=true` 可以成功
- `speaker.mute=false` 相关接口也可能全部回成功
- 但真实回读仍然一直是 `mute=true`

已经做过的真实验证包括：

1. `miotspec/prop/set` 写 `siid=2 piid=2 value=false`
2. `miotspec/prop/set` 写 `value=0`
3. `remote/ubus` 写 `mediaplayer.player_set_mute`
4. `remote/ubus` 写 `mediaplayer.unmute`
5. `remote/ubus` 写 `mediaplayer.set_mute`
6. `/home/rpc/<did>` 写 `set_mute` / `unmute` / `player_set_mute`
7. 先发 TTS / `player_play_operation play` 再解静音

结论都一样：

- 接口层很多都会回 `code:0`
- 但真实 MIOT 回读仍然是 `mute=true`
- 所以不能把“接口返回成功”当成“设备已经解除静音”

后来又进一步确认，另一些设备甚至连“软静音 = 把音量写成 `0`”都不可靠：

- 请求写入 `0`
- 真实回读却停在 `5` 之类的非零音量

所以最终工程策略不是“这台设备以后永远走软静音”，而是：

- 先探测设备 `mute` 链路是否可靠，对应 `deviceMuteUnreliable`
- 再探测软静音链路是否可靠，对应 `softMuteUnreliable`
- 只要还有一条可靠链路，静音功能就保留
- 只有当两条链路都失败时，才把当前设备的 `muteSupported` 降成 `false`

这套状态是按设备实例持久化的，不是按 `L05C`、`LX06` 这类型号写死。

### 33.8.1 需要“绝对安静”的流程不能只信 `muted=true`

后来又暴露出另一层更隐蔽的问题：

- 某些流程并不是“显示静音状态”这么简单，而是真的要求音箱不能出声
- 例如“对话拦截校准”会主动向小爱发测试问句
- 如果这里只看 `muted=true`，或者只看上层合成后的 `snapshot.muted`
- 一旦设备的 `mute` 属性本身就是摆设，就可能在所谓“静默校准”里真的播报出来

所以这类流程必须额外遵守一条更严格的规则：

- 不看合成后的 `muted` 显示态来判断“现在是否安静”
- 直接读取底层真实音量回读
- 只有当真实音量已经降到接近 `0`，才允许继续执行
- 如果尝试把音量写成 `0` 后，真实回读仍然压不下去，就直接取消这次静默流程
- 并把这次结果记成软静音链路不可靠，避免后续继续误判

这和前端显示逻辑并不矛盾：

- 前端仍然应该把 `volume=16, mute=true` 显示成“`16% + 已静音`”
- 但凡是要求“绝对不能出声”的后端动作，都不能把这个状态当成真正静音

### 33.9 自动刷新会覆盖本地音量草稿

这次真实浏览器回归又抓到一个前端竞态：

1. 用户快速拖动音量滑杆，例如连续经过 `15 -> 12 -> 16`
2. 前端 `input` 事件已经把本地草稿值更新到了 `16`
3. 但在最终 `change` 事件触发前，后台每 3 秒一次的 `bootstrap` 自动刷新刚好回来
4. 旧逻辑会在“当前没有 in-flight / queued 请求”时，直接把 `currentVolumeValue` 用服务端已确认值覆盖掉
5. 于是滑杆又被刷回旧值 `13`
6. 后面的 `change` 事件读到的也就成了 `13`
7. 最终用户明明拖到了 `16`，后端却根本没有收到 `16`

这个问题的本质不是音量接口失败，而是“服务端确认值”和“本地未提交草稿值”混在了一起。

修复原则应该明确：

- 只要本地还在编辑数字，或者音量防抖计时器还没提交，就不能让 `bootstrap` 覆盖当前草稿值
- 服务端自动刷新只能更新 `confirmedVolumeValue`
- `currentVolumeValue` 必须保留用户最后一次本地操作，直到它真正提交或被用户取消
- 否则就会出现“滑杆闪一下”“数字跳一下”“change 事件最终发错值”的假性抽风

这次修复后，真实浏览器里重放快速拖动：

- 先前失败的 `[15, 12, 16]` 已能稳定提交成 `16`
- `slider_change` 不再被自动刷新偷换成旧值
- 后端最终回读恢复为 `volume=16, mute=true`

### 33.10 静音能力不可用必须显式暴露给前端

另一个容易把人带偏的点是，前端不能只拿一个 `muted` 布尔值就自以为知道了全部真相。

后端现在会把下面几个事实拆开返回：

- `deviceMuted`：真实设备 mute 属性当前是不是 `true`
- `unmuteBlocked`：当前动作期望已解静音，但设备回读仍然阻塞
- `muteSupported`：当前设备是否还存在至少一条可靠的播放静音控制链路

控制台拿到这个状态后，正确行为应该是：

- 仍有可靠链路时，前端只按真实快照刷新，不假装操作成功
- 如果 `muteSupported=false`，音量说明明确显示“当前设备不支持可靠的播放静音控制”
- 静音按钮切成禁用态，并显示“`不支持`”
- 关闭静音失败时，错误响应里也要带最新音量快照，前端立刻回到真实状态，而不是等下一次轮询

这个坑的本质不是“按钮没点上”，而是：

- 设备能力和 UI 模型不一致
- 如果不把“链路可靠性”单独建模，前端就一定会给出错误操作暗示

### 33.11 控制台突然变成 `Not Found`

这次还踩到一个连锁坑：

在把新版代码同步到远端以后，控制台一度从可访问变成了 `/api/xiaoai-cloud/...` 全部 `Not Found`。

最终根因不是路由代码坏了，而是插件根本没成功加载。

这个问题先后出现过两种具体形态：

#### 33.11.1 运行时依赖丢失

- 手工同步时把目录覆盖成了新版本
- 但没有把运行时依赖一起装回去
- 插件启动时报 `Cannot find module 'json5'`
- Gateway 因此跳过了这个插件
- 控制台路由自然也就全部消失

#### 33.11.2 插件目录 owner 错误

- 手工通过 `tar | ssh` 同步时，把本地 UID/GID 一起带到了远端
- 远端插件目录被写成了例如 `uid=1000`
- 当前 OpenClaw 会把这种目录判定为 `suspicious ownership`
- 插件被宿主直接屏蔽
- `plugins.entries.openclaw-plugin-xiaoai-cloud` 会表现成 `plugin not found`
- 控制台路由 `/api/xiaoai-cloud/...` 因插件未加载而直接返回 `404`

这类故障很容易误判成：

- nginx 反代错了
- 控制台路由前缀冲突
- 插件代码里 `registerHttpRoute(...)` 失效

但如果直接在 OpenClaw 上游地址访问同一路径也还是 `404`，就应该优先排查“插件有没有真的加载成功”。

这个问题说明一件事：

对这个项目来说，“部署完成”的判定标准不能只是“文件已经复制上去”，还必须包括：

- 插件成功加载
- 路由已注册
- 控制台能返回 `302 -> 200`
- `bootstrap` API 可正常访问
- 插件目录 owner 与 OpenClaw 运行用户一致

否则只是“目录看起来在”，不代表服务真的在跑。

### 33.12 OpenClaw 更新后看起来“卡死”，其实是 service 入口失效

`2026-04-12` 这次云端更新里，用户表面看到的是：

- 刚更新完 OpenClaw
- 后台就进不去
- 服务像“卡死”了一样

但真正抓到的根因是：

- `openclaw-gateway.service` 仍然写着旧的 `ExecStart`
- 指向的是历史版本的 `/usr/lib/node_modules/openclaw/dist/index.js`
- 升级后如果全局安装目录结构变动，或者安装过程一度半坏
- 这个路径就可能失效
- systemd 会不断自动重试
- 用户体感上就会变成“Gateway 卡死”

这类问题的关键点在于：

- 它不是插件逻辑把进程拖死
- 而是宿主服务入口本身已经失效

这次最终收敛后的修法是：

- 恢复 `/usr/bin/openclaw`
- 把 service 改成直接执行 `openclaw gateway --port ...`
- 不再长期硬绑某个具体 `dist/index.js` 绝对路径

所以以后只要再次出现“更新 OpenClaw 后后台就挂了”，优先先看 systemd service，而不要先怀疑控制台代码或插件 HTTP 路由。

### 33.13 `openclaw` 已安装但不在 PATH，安装/卸载脚本会直接报 `ENOENT`

这次实测还暴露出另一个宿主层问题：

- OpenClaw 包已经装在全局目录里
- 但 `openclaw` 这个命令并没有真正出现在 PATH

此时最直观的表面症状就是：

- `install.sh` / `uninstall.sh` 一启动就失败
- 错误通常是 `spawnSync openclaw ENOENT`

这不是插件脚本逻辑本身坏了，而是：

- 脚本默认把 `openclaw` 当成可执行命令
- 宿主环境却没有把它暴露出来

工程上正确的收敛方式不是“假装没这回事”，而是同时做两层兜底：

1. 脚本层保留 `--openclaw-bin`
   - 允许用户或自动化环境显式指定真实 CLI 路径
2. 文档和提示词层明确写出
   - 如果 `openclaw` 不可用，要先修复 CLI 入口
   - 或者显式指定 `--openclaw-bin`

也就是说，`openclaw CLI 可执行` 现在已经不是一个可以再默认忽略的前置条件，而是安装/卸载链路必须显式检查的一部分。

### 33.14 卸载脚本不能在已删除插件目录里继续重启 Gateway

这次真实卸载还抓到一个脚本级 bug：

- `uninstall.sh` 入口本身是在插件目录里执行的
- 卸载过程中插件目录已经被删掉
- 但脚本后面还继续在这个已删除的工作目录里调用
  `openclaw gateway restart` / `openclaw gateway start`
- Node 在读取当前工作目录时会直接报：
  `uv_cwd ENOENT`

这里最容易误解的点是：

- 看到最后一步报错，会以为整个卸载都失败了

但真实情况通常是：

- 插件主体已经卸掉
- 历史备份也已经写进 `plugin-backups/`
- 真正失败的是“卸载后的显式服务恢复步骤”

这类 bug 的正确修法不是去改 Gateway，而是：

- 卸载脚本调用 OpenClaw CLI 时，默认切到一个稳定存在的目录
- 例如 `stateDir` 或用户 home 目录
- 不能继续继承那个随时可能被删掉的插件目录作为 `cwd`

这次已经把 `configure-openclaw-uninstall.mjs` 改成了这种更稳妥的做法。

所以以后如果再次看到：

- 卸载日志前面都正常
- 最后在 `gateway restart/start` 时突然抛 `uv_cwd ENOENT`

优先应该判断：

- 插件和 agent 是否其实已经按预期移除
- 历史是否已经备份成功
- 然后再看是不是仅仅卡在“最后一步服务恢复”

## 34. 当前明确的边界与取舍

这个项目已经比较完整，但仍然有明确边界。

### 34.1 它仍然依赖小米云轮询

这意味着延迟再怎么压，也不会像本地硬件级接管那样无限接近零。

### 34.2 音频外链兼容性不能被“纯代码”彻底消灭

不同型号、固件、源站、音频编码都会影响结果。

### 34.3 控制台手动 URL 播放现在刻意更保守

失败就报错，不再偷偷换浏览器预览。

这是刻意的产品取舍，不是功能缺失。

### 34.4 OpenClaw 音频回复仍保留浏览器兜底事件

因为这条链路属于“对话结果应急可预览”，和“用户手动点一个 URL”不是同一个使用场景。

### 34.5 `speaker/play-audio` 的返回时间不等于真正出声时间

当前稳定版已经把接口返回压到约 `2.5s` 级别，但这不代表音箱一定会在相同时间内真实出声。

原因仍然包括：

- 小米云 `player_play_music` 的受理和设备侧落地延迟
- 设备 `playerGetStatus` 的回读延迟
- 短音频在某些机型上的 `status=2 -> status=1` 抖动

所以以后评估“音频播放变慢了没有”，要分开看：

- API 返回时间
- 首次 relay 命中时间
- 设备真正进入稳定播放的时间
- 是否存在复播 / 回绕

这四个指标不能混为一谈。

## 35. 建议的阅读顺序

如果你要真正接手维护，建议按这个顺序读：

1. `index.ts`
2. `src/provider.ts`
3. `src/xiaomi-client.ts`
4. `src/auth-portal.ts`
5. `src/state-store.ts`
6. `src/console-page.ts`
7. `assets/ui/xiaoai-console.js`
8. `assets/ui/xiaoai-console.css`
9. `scripts/configure-openclaw-install.mjs`
10. `install.sh` / `install.cmd`

如果你只关心某一块：

- 登录问题：先看 `src/auth-portal.ts` 和 `src/xiaomi-client.ts`
- 拦截延迟：先看 `src/provider.ts` 里的 `pollConversationOnce / interceptAndForward / pauseSpeaker`
- 音频兼容性：先看 `playAudioUrl()` 以及 `audio-relay`
- 控制台异常：先看 `handleGatewayHttpRoute()`、`src/console-page.ts`、`assets/ui/xiaoai-console.js`
- 安装问题：先看 `install.sh`、`install.cmd`、`scripts/configure-openclaw-install.mjs`

## 36. 总结

这个项目本质上不是“把几个接口拼起来”这么简单。

它真正难的地方在于同时处理：

- 小米登录和设备发现
- 小米云对话轮询
- 低延迟打断
- OpenClaw 转发与会话管理
- 音频兼容性
- 控制台与运维体验
- 安全和持久化边界

如果只从 README 看，它像一个“能装就能用的插件”。

如果从实现看，它实际上已经是一套完整的小爱语音接入层。
