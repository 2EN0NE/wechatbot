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
在运行中途取消活动轮次，由用户发送「stop」消息触发。被中止的轮次不回复；排队的轮次折叠进下一条入站消息作为历史上下文。
_Avoid_: cancel, kill, interrupt
