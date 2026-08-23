# Turn 生命周期：扩展侧串行化 + agent_settled 逐条回复

入站微信消息变成 turn；扩展维护一个 FIFO `pendingTurns`（排队中的 turn）加一个 `activeTurn`（当前 in-flight 的 turn）。**一次只让一条微信消息在 pi 里处理**：`pumpTurn` 在无 in-flight turn 时把队首发给 pi，`agent_settled` 回复该 turn 后再推进队列。

为什么不能靠 pi 原生 followUp 排队：`sendUserMessage(content, { deliverAs: "followUp" })` 在 agent streaming 时把消息放进 pi 的 followUp 队列，但 agent 的 run 循环会在**同一个 run 里把 followUp 队列 drain 掉**（外层 `for(;;)` 循环 `continue`），而 `agent_settled` 只在**整个 run 完全结束**时触发一次。于是连发两条微信消息（A 直接触发 run，B followUp 排队）会被合并成一个 run：`agent_end` 两次（`lastEndSummary` 被 B 覆盖）、`agent_settled` 一次（只 shift 一条），结果只发出最后一条回复——第一条静默丢失。

扩展侧串行化（`activeTurn` + `pumpTurn` + `agent_settled` 推进队列）保证：每个微信 turn 独占一个 run，`agent_settled` 一次恰好对应一个 turn，`agent_end` 的 `lastEndSummary`（auto-retry 时覆盖到最后一次）配对正确。

排队积压与历史折叠：串行化是严格 FIFO，连发多条会按到达顺序排队（状态栏显示 `+N queued`）。用户发 `stop` 中止当前 turn 时，若队列非空，排队的 turn 不再逐条处理，而是由 `foldQueuedTurns` 折叠成一段「历史摘要」注入下一条入站消息，让 agent 一次性看到积压消息，避免 abort 后继续串行追过时内容。`pumpTurn` 的 `sendUserMessage` 失败时做指数退避重试（初始 1 次 + 重试 3 次，延迟 1s/2s/4s），每次重试与最终失败都写日志；仍失败则丢弃该 turn、微信通知用户并置错误状态（`bridgeError`），不再 `unshift` 回队（否则会无限重试同一条）。

结束处理拆成两个事件：`agent_end` 可能因 auto-retry / auto-compact **多次触发**，只记录最后一次的 summary（`extractAssistantText`）；`agent_settled` 触发一次，取 `activeTurn`，按 `stopReason` 分支回复（aborted → 静默，error → 错误摘要，normal → 回复），正常结束但文本为空时静默，然后推进队列。

已知限制：微信 turn 与「用户在 TUI 里手动发的消息」交错时，两条会在同一 run 里合并，`agent_settled` 会把最后一条的 summary 误配给微信 turn——pi 没有「每个顶层消息」级别的事件，无法在扩展侧区分。纯微信连发场景不受影响。
