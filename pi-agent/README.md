# @wechatbot/pi-agent

Pi 扩展——在 pi 里输入 `/wechat`，终端扫二维码，即可用微信跟 Pi 聊天。

## 安装

### 从 npm（推荐）

```bash
pi install npm:@wechatbot/pi-agent
```

装完即可，下次启动 pi 会话自动加载，输入 `/wechat` 开始。

### 从 git

```bash
pi install https://github.com/corespeed-io/wechatbot
```

### 快速试用（不安装）

```bash
pi -e npm:@wechatbot/pi-agent
```

### 本地开发

```bash
git clone https://github.com/corespeed-io/wechatbot
cd wechatbot/pi-agent && npm install

# 直接加载
pi -e ./src/index.ts

# 或复制到自动发现目录
cp -r . ~/.pi/agent/extensions/wechat/
```

## 用法

在 pi 里：

```
/wechat          扫二维码 → 把微信接到当前 pi 会话
/wechat-setting  配置微信端命令穿透与不活跃超时（项目级/用户级面板）
```

已连接时再次 `/wechat` 会弹出菜单：Reconnect（重连）/ Disconnect（断开）/ Status（状态）/ Cancel。

### 连接后（在微信里给 bot 发消息即可）

```
> /wechat

  📱 用微信扫这个二维码：

    ▄▄▄▄▄▄▄ ▄▄▄ ▄▄▄▄▄▄▄
    █ ▄▄▄ █ █▀█ █ ▄▄▄ █
    █ ███ █ ▄▀▄ █ ███ █
    █▄▄▄▄▄█ █ ▄ █▄▄▄▄▄█
    ▄▄▄▄▄ ▄▄▄█▄▄▄ ▄▄▄▄▄
    █▄█▀█▄▄ ▀▀▄▀▀█▄▀█▀▄

  [wechat] ✓ 已连接：e06c1ceea05e@im.bot

# 在微信里发「帮我看看这个 bug」…
# pi 处理后把回复发回微信。
# pi 思考期间微信显示「对方正在输入中…」。
```

### 微信侧命令（从手机发给 bot）

| 命令 | 作用 | 默认 |
|---|---|---|
| `stop` / `/stop` / `esc` / `/esc` | 中止当前正在处理的轮次（排队的消息折叠进下一条入站消息作为历史上下文） | 恒可用（豁免） |
| `/compact` | 触发上下文压缩（pi 忙时拒绝，提示先 stop） | 恒可用（豁免） |
| `/new` | 开启新会话，旧会话归档（桥会自动重连，免扫码） | 恒可用（豁免） |
| `/status` | 查询模型、token、成本、上下文占用 | 关 |
| `/help` | 说明 + 当前可用命令清单 | 开 |
| 插件命令（`/skill:*`、prompt 模板、非交互扩展命令） | 穿透到 pi 执行，skill/prompt 的回复自然回微信 | 关 |

`stop`/`esc`、`compact`、`new` 是紧急中止与收尾抓手，始终可用、不可关闭；`/help` 默认开（发现入口），其余命令默认关闭。在 pi 终端执行 `/wechat-setting` 打开面板，按「项目级 / 用户级」作用域 + 「原生 / 透传 / 设置」分区逐个配置；按 `/` 可逐字符筛选当前分区快速定位。

每次（重）连接后，某微信用户发来**第一条消息**时会先收到一份 `/help` 欢迎语（同一连接期内每用户一次）；连接时 pi 终端也会显示一份。

### 不活跃超时

pi 处理一个轮次时若超过阈值（默认 180 秒，可在 `/wechat-setting` 配置）无任何进展（无消息/工具更新），桥会向微信发送一次提示，附上最新流式回复文本，并提示可发送 `stop` 中止；不自动中止。每轮至多提示一次。

### 回文件给微信（`wechat_attach` 工具）

agent 需要把文件（图片 / 视频 / 文档）发回微信时，调用 `wechat_attach` 工具并传入本地文件路径即可；扩展会在下一轮回复里把文件随文本一起发出（按 MIME 自动路由 image / video / file）。不要只在正文里写路径——那样不会发送。

## 能力特性

- **busy 不丢消息**：一次只让一条微信消息在 pi 里处理，新消息按到达顺序排队，`agent_settled` 逐条推进，不覆盖、不丢失。
- **stop 折叠积压**：`stop` 中止当前 turn 时，排队消息折叠成历史摘要注入下一条，不逐条追过时内容。
- **不活跃超时**：轮次卡住（脚本挂起、等权限确认、模型长时间无输出）超过阈值时微信侧提示一次并附最新进度，不自动中止。
- **命令穿透可配**：`/wechat-setting` 面板按项目级/用户级（Tab 切换）+ 原生/透传/设置（←/→ 切换）两级 tab 配置，`/` 进入逐字符筛选（所有 tab 可用）；默认关、三条豁免、`/help` 默认开；持久化到 wechatbot.json。
- **欢迎语**：每次（重）连接后对某用户首条消息回发一份 `/help`，规避「无 context_token 无法主动推送」的平台限制。
- **结束处理正确**：被中止（aborted）静默不回复；出错（error）回传错误摘要；正常结束才回文本。
- **优雅退出**：会话关闭时完整等待轮询停止 + `notifyStop` 完成。
- **状态可观测**：pi 状态栏显示 connected / processing +N queued / error，含排队计数。
- **媒体收发**：图片作为视觉输入、语音转写、文件 / 视频落盘后告知 pi 路径；回复自动剥离 markdown。

## 日志

桥接日志写到文件 `~/.pi/logs/wechat_<YYYYMMDD>.log`（不刷 TUI），格式 `ISO时间戳 LEVEL [context] 消息 {json}`。

记录内容：消息接收（含 ≤80 字符脱敏预览）、命令识别、桥未连接时丢弃消息（warn）、`sendUserMessage` 失败、回复结果、连接 / 断开 / session 过期 / SDK 错误。

排障：`tail -f ~/.pi/logs/wechat_*.log` 看桥接行为；pi 会话 JSONL 看 agent 处理。

## 工作原理

```
微信用户（手机）
    │
    ▼
iLink API（腾讯） ←── @wechatbot/wechatbot SDK
    │
    ▼
Pi 扩展
    │
    ├── 微信消息 → 构造 turn → 入队 → pumpTurn 串行发一条给 pi
    │
    └── agent_settled → 按 stopReason 分支 → bot.reply() 发回微信
```

1. `/wechat` 创建 `WeChatBot` 实例（SDK）
2. SDK 调 iLink API 获取二维码 URL
3. `qrcode-terminal` 把二维码渲染到终端 stderr
4. 微信扫码 → 登录确认 → 凭证落盘
5. SDK 长轮询 → 收到微信消息 → 构造 turn → 入队；无 in-flight 时 `pumpTurn` 发一条给 pi（串行）
6. pi 安定（`agent_settled`）→ 取 `activeTurn` 按 stopReason 决定回复 / 静默 / 报错 → `bot.reply()` 发回 → 推进队列发下一条
7. `bot.sendTyping()` 在 pi 思考期间显示「对方正在输入中…」

## 依赖

| 包 | 用途 |
|---|---|
| `@wechatbot/wechatbot` | 微信 iLink Bot SDK——登录、轮询、发送、typing、context_token |
| `qrcode-terminal` | 终端渲染可扫描二维码 |
| `@earendil-works/pi-coding-agent` | Pi 扩展 API（peer 依赖 `"*"`，pi 自带） |
| `typebox` | 工具参数 schema（peer 依赖 `"*"`，pi 自带） |

## Pi 包说明

这是一个 [pi 包](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)，package.json 声明了 `"keywords": ["pi-package"]` 和 `"pi": { "extensions": [...] }`。安装后 pi 自动发现扩展。
