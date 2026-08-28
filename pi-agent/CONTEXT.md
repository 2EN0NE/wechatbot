# 微信桥

把微信（iLink Bot）与 pi agent 桥接起来的 pi-agent 扩展——微信用户在手机上跟 pi 聊天，pi 的回复发回微信。

## 术语

**Turn（轮次）**：
一条入站微信消息，对应一次 pi agent 运行——从收到用户消息到把 pi 回复发回。
_Avoid_: message, prompt, request

**Active turn（活动轮次）**：
pi 当前正在处理的轮次。同一时刻至多一个。
_Avoid_: current turn, in-flight message

**Queued turn（排队轮次）**：
pi 忙时到达、按到达顺序等待处理的轮次。
_Avoid_: backlog, pending message

**Busy / Idle（忙 / 空闲）**：
pi 是否正在处理轮次。只有空闲时才把新轮次交给 pi，否则排队。
_Avoid_: occupied, running

**Abort（中止）**：
在运行中途取消活动轮次，由用户发送「stop」/「esc」消息触发（二者等价）。被中止的轮次不回复；排队的轮次折叠进下一条入站消息作为历史上下文。
_Avoid_: cancel, kill, interrupt

**Stall（停滞）**：
活动轮次处理中，自最后一次活动事件（消息 / 工具更新）起超过「不活跃超时」阈值仍未恢复进展的状态。可能由无超时的挂起脚本、等待 TUI 权限确认、或模型长时间无输出造成。
_Avoid_: stuck, hang, frozen

**Inactivity timeout（不活跃超时）**：
以「距最后一次活动事件时长」为判据的超时机制；触发后向微信发送一次提示（附最新回复文本），不自动中止轮次。每轮至多通知一次。
_Avoid_: wall-clock timeout, deadline, watchdog

**Passthrough（命令穿透）**：
微信端输入的命令由桥执行的过程。原生命令由桥重实现其微信行为；插件命令（skill / prompt / 扩展命令）经 pi 展开或调度执行。
_Avoid_: forward, proxy, relay

**Native command（原生命令）**：
桥针对 pi 原生能力重实现、可在微信端直接执行的命令：stop/esc、compact、new、status、help。
_Avoid_: builtin command, bridge command

**Exempt command（豁免命令）**：
始终可用、不可在 `/wechat-setting` 中关闭的桥命令：stop/esc、compact、new。
_Avoid_: always-on, protected command

**Setting（设置）**：
`/wechat-setting` 面板中可配置的**非命令**项（当前仅「不活跃超时」阈值）。只在面板里配置，不作为微信端命令输入；与 Command 相对。
_Avoid_: option, preference, config item

**Welcome message（欢迎语）**：
每次（重）连接后，某微信用户首条入站消息触发的一次性 `/help` 回发；同一连接期内该用户至多收到一次。用于规避「无 context_token 无法主动推送」的平台限制。
_Avoid_: greeting, onboarding message
