# 桥接层薄 journal：文本轮次的持久准入与至少一次回放

微信桥长跑丢消息的主风险在桥接层：SDK 游标在 `emit` 消息前就已前进并异步持久化，桥接层从收到消息到 `agent_settled` 回复发出之间若崩溃，该 turn 永久丢失（游标已前进、不会重拉）。为补这个窗口，在桥接层加一层薄 journal，**不动 SDK**——分层铁律要求 settle 依赖 pi 的 `agent_settled`，这是桥接概念，SDK 无从得知；放 SDK 须发明 ack 回调协议，污染通用 SDK。

形态：单文件 append-only JSONL（`~/.pi/agent/wechat-journal.jsonl`），每条文本 turn 记两条记录——`admitted`（入队前写：turnId、userId、text、type、contextToken、timestamp）与 `settled`（turn 生命周期终结时写：turnId）。崩溃恢复（`session_start` 且重连成功后）回放「有 admitted 无 settled」的 turn 重新入队。

`settled` 覆盖**所有**终结路径，不只回复成功：回复成功发出、用户中止（stop）、积压折叠（stop 折叠 queued turns 进下一条）、发送最终失败（重试耗尽后丢弃）。这样回放只重放「崩溃时仍在队列或 active、生命周期未终结」的 turn。发送失败也结算的原因：pumpTurn 已做指数退避重试，最终失败即终结，若回放再重试同一条会无限重试（与 ADR-0001「不再 unshift 回队」同一哲学）。

回放语义为**至少一次**：`settled` 在回复成功后写，崩溃若落在「回复已发出 ↔ settled 写盘」的微秒窗口，该 turn 会重复处理一次（重复回复 + 可能重复一次工具副作用），换取「绝不丢回复」。重复副作用的风险当前可接受：攻击面已被 P0 白名单收窄到 owner 本人，交易/破坏性操作属 roadmap Later（届时靠「敏感指令二次确认」兜底，非本 journal 职责）。

覆盖粒度**仅对话型文本**（`type === "text"` 且 `intent === "message"`）：媒体消息回放依赖 `raw` 里的 CDN 引用（aeskey），崩溃后大概率已过期、download 会失败，且 `raw` 体积大；媒体消息维持现状（崩溃窗口仍可能丢）。skill/prompt 命令展开的 turn 也不纳入——命令由用户主动触发、丢失可重发，且回放需恢复 `expandPromptTemplates` 语义、复杂度不值；native 命令在 handler 内同步回执、无 agent 轮次窗口。回放后重写 journal 只保留未结算的 admitted 记录，防无限增长。

为什么不照搬 pi-telegram 的 snapshot + segment + compaction：那是为多实例 bus、follower 转发、精确 settle 设计的 3445 行实现；wechatbot 当前只需单进程、单 owner 的「不丢文本对话」保证，最小可用版足够。
