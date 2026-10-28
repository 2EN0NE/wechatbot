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

### 远端豁免（`/new` 不被 TUI 确认框拦住）

微信发起 `/new` 会走 `ctx.newSession()`，pi 随即触发 `session_before_switch`，
`confirm-destructive`、`dirty-repo-guard` 等扩展会在终端弹确认框——没人按键就**永久阻塞**。
桥通过「远端豁免」避免这一点：pi 以 `--unattended-confirm` 启动授予许可，桥在微信连接就绪时
`arm("wechat")` 占用豁免，断开即释放；占用期间这些对话框按声明默认值自动放行。

前置条件（两条都满足才生效）：

1. `@zenone/pi-selector` 等扩展已同步到 `~/.pi/agent/extensions/`（提供 `globalThis.__confirmGateApi`）；
2. pi 启动命令带 `--unattended-confirm`（写在 tmux 启动行 / 别名 / org `launchArgs` 里，不要每次手打）。

自查与行为：

- pi 终端 `/unattended status` → `armed`（微信连接中）/ `licensed-idle`（有许可未连接）/ `off`（未授权）；
- 微信 `/status` 追加一行 `Exemption: armed | licensed-idle | off`；
- 未生效时微信 `/new` **直接回执拒绝并说明原因**（不再挂起），`/compact`、`stop`、普通消息不受影响；
- 占用期间这是**全进程**行为：终端里人工操作 selector 也被自动放行；`/unattended disarm` 可立刻恢复。

日志（`~/.pi/logs/wechat_<YYYYMMDD>.log`）关键行：`confirm gate armed` / `confirm gate disarmed` /
`confirm gate disarm failed` / `new session refused — unattended exemption not armed` /
`new session request dispatched`（已受理）/ `internal command unavailable — refusing /new` /
`new session cancelled by extension` / `internal /new invoked without a live WeChat request`（残留请求被丢弃）。

注意：`/unattended` 是 **pi 终端的扩展命令**，微信端发它不会执行（会被当作普通消息），
微信侧请用 `/status`（需先在 `/wechat-setting` 开启）或看拒绝回执/日志。

`/new` 的执行入口是内部命令 `wechat-internal-new`：pi 1.4 的 `newSession` 只存在于命令 ctx，
桥通过 `sendUserMessage(..., { expandPromptTemplates: true })` 派发它来拿到新鲜命令 ctx。
该 API **返回 void（发后不管）**，派发完成时机不可知，因此派发后桥不再访问 ctx；
TUI 自动补全里能看到这个名字，**勿手敲**（无待处理微信请求时它只提示并返回，超过 30s 的
残留请求同样按无请求处理）。

派发前桥做两项自检：内部命令是否真以本名注册（重名会被 pi 消歧成 `wechat-internal-new:1`，
查不到就明确回执拒绝，而不是把它当普通消息送给模型烧 token）；是否已有未过期的在飞 `/new`
（第二条直接回执 `already in progress`）。`Starting a new session…` 回执在**派发点**发出，
不依赖 handler 是否真的执行（见 `docs/adr/0014` 补充 4）。

pi 1.4 起会话替换后**旧 ctx 立即失效**：若在日志里看到
`Login failed: This extension ctx is stale …` 或 `Handler error: … stale …`，说明有代码在
`ctx.newSession()` 返回后继续使用旧 ctx（已在本版本修复，见 `docs/adr/0014` 补充 3）。

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

记录内容：消息接收（含 ≤80 字符脱敏预览）、命令识别、桥未连接时丢弃消息（warn）、`sendUserMessage` 失败、回复结果、连接 / 断开 / session 过期 / SDK 错误，以及 journal 的准入与结算（`journal admitted` / `journal settled`，带 turnId 与排队深度）、队列深度跨越阈值（`queued turns rising` / `queued turns drained`）、回放（`replayed turn from journal`）。

日志是耐久真源；`/status` 里的桥侧计数行只是当场看一眼的便利（进程内计数，重启归零）：

```
Bridge: admitted 3 · settled 3 · replayed 1 · stalled 1
```

只列非零项，顺序固定（admitted / settled / replayed / dropped / stalled）；全 0 时不显示这一行。

排障：`tail -f ~/.pi/logs/wechat_*.log` 看桥接行为；pi 会话 JSONL 看 agent 处理。

### 崩溃回放演练（真机 UAT）

微信 iLink 无法做 e2e，回放能力靠两阶段断言留证。两个断言对应两件不同的事：

- **入口证据** — admit 在崩溃前真的落了盘（`journal` 里有「已准入未结算」的记录）
- **恢复证据** — 回放真的把它变成一个跑完的轮次（日志有回放事件，且它不再未结算）

只过其中一个是失败。演练会**真给微信发一条回复**（回放会真发），这是验证本身不是 bug。

```bash
cd pi-agent

# 阶段一：入口证据
#   1) 在微信里发一条带标记的消息，例如 drill-20260101
#   2) 断言它已落盘（省略 turnId 时取最近一条未结算，并打印下一步命令）
#      别等 pi 回完：这轮一旦结算，断言就没有可验证对象了（脚本会提示重发）。
npm run drill -- --check-entry

#   3) 模拟崩溃：kill -9 掉 pi 进程（不要用正常退出，那会走优雅关闭）
#   4) 重启 pi 会话并 /wechat 重连

# 阶段二：恢复证据
npm run drill -- --check-replay <turnId>
```

脚本默认读 `~/.pi/agent/wechat-journal.jsonl`（尊重 `PI_CODING_AGENT_DIR` 覆盖，与扩展侧 `getAgentDir()` 同源）与 `~/.pi/logs/wechat_<YYYYMMDD>.log`，可用 `--journal` / `--log` 覆盖；`--help` 看全部用法。

注意：`compact` 在每次重连时运行，会把已结算记录从 journal 里清掉——所以**正常收尾之后 journal 是空文件，这是对的**，不代表回放没跑过。

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
