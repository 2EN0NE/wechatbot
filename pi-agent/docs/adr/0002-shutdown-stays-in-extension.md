# 优雅退出留在扩展层（SDK 的 stop() 保持不变）

为了等待完整优雅退出，桥保存 `bot.start()` 返回的 promise——它只有在轮询循环停止且 `notifyStop` 完成后才 resolve——并在 `session_shutdown` 里 `bot.stop()` 之后 await 它。SDK 的 `stop()` 保持 `void`。

把 `stop()` 改成返回 `this.runPromise`（handoff 曾建议）是错的：`runPromise` 在 `start()` 的 `finally` 里、`notifyStop` 之前就被置 null，await 它会过早 resolve。既然 pi-agent 是唯一消费者，SDK API 改动作为不必要风险被跳过。
