<p align="center">
  <img src="assets/ui/favicon.svg" alt="XiaoAI Cloud Plugin Logo" width="176" height="176">
</p>

<p align="center">将小爱音箱接入 OpenClaw </p>

<p align="center">
  <img src="https://img.shields.io/badge/OpenClaw-Plugin-1f6feb?style=flat-square" alt="OpenClaw Plugin">
  <img src="https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js 22+">
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript 5">
</p>

## 这是什么
运行在 OpenClaw Gateway 所在环境的插件，把小爱音箱接进 OpenClaw，让 OpenClaw 拥有调用小爱音箱的能力，或者用小爱音箱和 OpenClaw 对话。
<img width="100%" alt="截图 2026-04-03 20 23 13" src="https://github.com/user-attachments/assets/384ef82d-aec7-4cab-9184-66b0299bec2b" />
当前支持的核心功能：
- 语音拦截与转发
- 小爱播报与远程唤醒
- 小爱本地执行指令
- 音量、唤醒词、工作模式、上下文记忆控制
- 内嵌登录、设备切换、事件流和对话控制台
- OpenClaw URL音频回复处理（Beta）

## 快速开始

<details>
<summary><strong>通过 OpenClaw 安装（推荐）</strong></summary>
如果你希望让 OpenClaw 自己完成安装，可以把下面这段话直接发给它。

```text
请帮我安装 `openclaw-plugin-xiaoai-cloud` 插件。

项目仓库：
https://github.com/ZhengXieGang/Xiaoai-Claw-Addon

请在真正运行 OpenClaw Gateway 的宿主机或容器里完成安装，不要只在当前沙箱里模拟。

安装时请按下面的原则处理：
- 以这个 GitHub 仓库为准，不要凭某个零散文件去猜安装方式。
- 下载最新发布的 Release 里的内容，按 Release 里的安装脚本安装。
- Linux / macOS 使用 `install.sh`，Windows 使用 `install.cmd`。
- 如果新版 OpenClaw 对这个插件提示 dangerous code patterns，请先核对仓库内容；确认来源就是这个仓库后，允许使用 `--dangerously-force-unsafe-install` 继续，不要因为安全扫描提示直接停住。

如果安装过程中报错，请先自行排查并修复常见问题，例如：
- Node.js 版本不符合要求
- `openclaw` CLI 不可用
- `openclaw` 已安装但不在 PATH；必要时修复 CLI 入口，或显式指定 `--openclaw-bin`
- 依赖未安装完整
- 权限不足
- Python `requests` 缺失
- 网关重启失败

安装完成后请继续检查：
- 插件已经安装并启用
- 专属 `xiaoai` agent 已创建
- `xiaoai` agent 没有抢占现有默认 agent 或已有渠道入口
- 插件通知渠道与目标已经正确推断；如果无法唯一推断，请明确提示我去控制台或通过对话手动设置
- 如果插件还没拿到可用的小米登录态，先把当前生成的临时登录入口发给我；如果控制台已经可用，再调用 `xiaoai_console_open`，把控制台链接发给我
- 在把登录入口或控制台链接发给我之后，先停下来等我完成登录和选设备，不要让当前任务一直挂起
- 我回复“配置好了”以后，再调用 `xiaoai_run_calibration` 自动跑一遍校准，直接用 `mode=all`，一次完成音频时序校准和对话拦截校准；测试期间音箱可能真实出声，校准时不要和音箱说话，也不要把静音能力当成前置条件；如果设备暂时还没就绪，提示我在我登录并选好音箱后补跑

如果你已经尽力自动修复，仍然无法安装，请：
- 明确告诉我卡在哪一步
- 说明需要我手动处理什么
- 把关键错误日志整理给我，方便我反馈给插件作者
```

</details>

<details>
<summary><strong>从 Release 手动安装</strong></summary>

macOS / Linux：
```bash
chmod +x install.sh
./install.sh
```

Windows：
```bat
install.cmd
```

要求：
- 安装脚本和发布压缩包放在同一目录
- 脚本必须在真正运行 OpenClaw Gateway 的那台机器 / 容器里执行
</details>

<details>
<summary><strong>安装脚本附加参数</strong></summary>

- `--profile <name>`：指定 OpenClaw profile
- `--state-dir <dir>`：指定 `OPENCLAW_STATE_DIR`
- `--openclaw-bin <path>`：指定 OpenClaw CLI 路径
- `--skip-npm-install`：跳过依赖安装

</details>
<details>
<summary><strong>从源码安装</strong></summary>

```bash
cd openclaw-plugin-xiaoai-cloud
chmod +x install.sh
./install.sh
```

Windows：
```bat
cd openclaw-plugin-xiaoai-cloud
install.cmd
```

</details>

<details>
<summary><strong>卸载</strong></summary>

### 通过 OpenClaw 卸载

如果你希望让 OpenClaw 自己完成卸载，可以直接把下面这段话发给它。

```text
请帮我卸载 `openclaw-plugin-xiaoai-cloud` 插件。

项目仓库：
https://github.com/ZhengXieGang/Xiaoai-Claw-Addon

请在真正运行 OpenClaw Gateway 的宿主机或容器里完成卸载，不要只在当前沙箱里模拟。

卸载前请先明确向我确认这两个选择，不要擅自决定：
- 是否保留专用 `xiaoai` agent
- 是否保留该 agent 的对话记录

执行卸载时请按下面的原则处理：
- 以这个 GitHub 仓库为准，不要凭某个零散文件去猜卸载方式。
- 优先使用仓库或 Release 里的卸载脚本。
- Linux / macOS 使用 `uninstall.sh`，Windows 使用 `uninstall.cmd`。
- 如果我要“删除 agent，但保留对话记录”，确保卸载脚本把记录备份到当前 OpenClaw state dir 下的 `plugin-backups/`。

卸载完成后请继续检查：
- 插件已经从 OpenClaw 中移除，或者至少已不再处于启用状态
- OpenClaw Gateway 仍然健康可用
- 如果我选择保留 `xiaoai` agent，请明确提醒我：这个 agent 仍然引用 `xiaoai_*` 工具，在插件重新安装前无法正常工作

如果卸载过程中报错，请先自行排查并修复常见问题，例如：
- `openclaw` CLI 不可用
- `openclaw` 已安装但不在 PATH；必要时修复 CLI 入口，或显式指定 `--openclaw-bin`
- 权限不足
- 插件目录残留
- 配置残留未清理
- 网关重启或恢复失败

如果你已经尽力自动修复，仍然无法卸载，请：
- 明确告诉我卡在哪一步
- 说明需要我手动处理什么
- 把关键错误日志整理给我，方便我反馈给插件作者
```


macOS / Linux：
```bash
chmod +x uninstall.sh
./uninstall.sh
```

Windows：
```bat
uninstall.cmd
```

卸载脚本会交互式询问是否保留专用 `xiaoai` agent、是否保留该 agent 的对话记录。
如果选择“删除 agent，但保留对话记录”，脚本会把记录备份到当前 OpenClaw state dir 下的 `plugin-backups/`。

也可以直接用参数跳过交互：

保留 `xiaoai` agent 和对话记录：
```bash
./uninstall.sh --keep-agent --keep-history
```

删除 `xiaoai` agent，但保留对话记录备份：
```bash
./uninstall.sh --remove-agent --keep-history
```

删除 `xiaoai` agent 和对话记录：
```bash
./uninstall.sh --remove-agent --remove-history
```

</details>

<details>
<summary><strong>安装脚本会干的事</strong></summary>

1. 安装依赖并构建插件
2. 安装到 OpenClaw
3. 创建或复用专属 `xiaoai` agent
4. 写入 `openclawAgent`
5. 保留当前默认 agent，避免 `xiaoai` 抢占已有渠道入口
6. 自动推断当前通知渠道与目标（能唯一识别时）
7. 合并必要工具 allowlist
8. 检查插件并重启 Gateway

</details>

#### 环境要求（安装过程中会自动安装依赖）

- Openclaw 2026.03.24 +
- Node.js `>= 22`
- 可执行的 `openclaw` CLI
- 建议安装 Python 3 + `requests`


## 首次使用

1. 安装完成后让OpenClaw打开小爱控制台，OpenClaw会调用 `xiaoai_console_open`，返回控制台网页链接。
2. 打开控制台，先登录小米账号
3. 在概览页选择要接管的音箱
4. 到控制页校准音频和拦截延迟，设置模式、音量、唤醒词、通知渠道、上下文记忆和必要时的非流式兜底（一般不需要）
5. 这些控制页配置除了网页里可以改，也可以直接通过和 OpenClaw 对话修改；复杂项统一由 `xiaoai_update_settings` 处理，包括通知渠道、模型、上下文记忆，以及 `AGENTS.md`、`IDENTITY.md`、`TOOLS.md`、`HEARTBEAT.md`、`BOOT.md`、`MEMORY.md` 这些 workspace 提示文件的编辑或禁用。`AGENTS.md` 作为核心提示文件会保留启用，其余文件会按 OpenClaw 的 workspace 语义启用或禁用。这些文件只写入 `xiaoai` 专属 agent 的 workspace；如果专属 agent 缺少显式 workspace，插件会直接报错，不会回退去读写主 agent 的默认 workspace


## 用法示例

- 通过小爱和OpenClaw对话
- 让小爱说话，任何话，可通过任务定式
- 让OpenClaw返回音频
- 等等

## 工作模式

- `唤醒模式`：命中唤醒词，或窗口期内才接管
- `代理模式`：完全接管所有语音
- `静默模式`：不接管，只保留主动播报

<details>
<summary><strong>常用工具（OpenClaw会自己调用合适的工具）</strong></summary>

## 常用工具（OpenClaw会自己调用合适的工具）

- `xiaoai_console_open`
- `xiaoai_speak`
- `xiaoai_play_audio`
- `xiaoai_execute`
- `xiaoai_set_volume`
- `xiaoai_get_volume`
- `xiaoai_wake_up`
- `xiaoai_set_mode`
- `xiaoai_set_wake_word`
- `xiaoai_set_dialog_window`
- `xiaoai_update_settings`
- `xiaoai_new_session`
- `xiaoai_get_status`

</details>

<details>
<summary><strong>排障</strong></summary>

先看插件状态：

```bash
openclaw plugins inspect openclaw-plugin-xiaoai-cloud --json
```
再看 OpenClaw 日志：
```bash
openclaw logs --limit 260 --plain | tail -n 260
```
重点看：
- `xiaomi-network.log`
- 控制台 `事件` 页

如果你遇到“音频没播出来”：

1. 先确认返回的是可直接访问的 `http/https` URL
2. 再看控制台事件里是 `speaker` 还是 `browser-fallback`
3. 如果连续都是同一音频源失败，插件会暂时直接走浏览器兜底，这是为了减少等待时间
4. 如果是本地部署，优先检查 `audioPublicBaseUrl` 是否填成了音箱可访问的局域网地址；不要把 `127.0.0.1`、`localhost` 或只给浏览器自己能访问的地址发给音箱
5. 如果是 `xiaoai_tts_bridge`，当找不到可用音频入口时插件会自动降级成 `xiaoai_speak`；这时说明 TTS 音频 relay 没打通，优先检查 gateway 的局域网可达性

如果你遇到“执行指令循环”：

1. 优先使用 `xiaoai_execute`
2. 避免让 `xiaoai_speak` 去读设备控制口令
3. 查看事件页里是否出现最近主动执行指令的回灌忽略记录

</details>

## 本人测试环境
- 阿里云轻量应用服务器2C2G (Debian)
- 小爱音箱Play增强版 (L05C)
- OpenClaw v2026.4.1

## 如果帮到了你，可以捐赠支持我
<img width="30%" alt="mm_reward_qrcode_1775163379040" src="https://github.com/user-attachments/assets/f04e53d0-72aa-4cf7-a50c-f79e6606c786" />
