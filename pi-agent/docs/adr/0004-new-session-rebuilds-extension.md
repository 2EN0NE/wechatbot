# /new 命令依赖 ctx.newSession()，扩展实例重建后桥通过模块级标志自动重连

微信侧 `/new` 的语义是「开启新话题、清空上下文」。pi 扩展 API 没有轻量的清空上下文方法：`ctx.compact()` 只是压缩（保留摘要），唯一真正的「新会话」入口是 `ctx.newSession()`。它只存在于 `ExtensionCommandContext`（session 控制方法仅在用户发起的命令中安全），因此 `dispatchMessage` 的 ctx 参数类型从 `ExtensionContext` 提升为 `ExtensionCommandContext`。

关键副作用：`newSession()` 会重建扩展实例——旧实例触发 `session_shutdown`（我们的 handler 会 `shutdownBot()` 停掉微信连接）、新实例触发 `session_start`。如果直接调用，桥会断开且需要手动重新 `/wechat` 扫码。

决策：桥的状态（bot 连接）不需要跨实例移交；新实例在 `session_start` 时若检测到模块级标志 `restartAfterReplace`，就调用同一个 `startWechat` 登录流程。SDK 的 `auth.login({force:false})` 会用 `storage:"file"` 持久化的凭证免扫码恢复（SDK 文档明确「try stored credentials first, fall back to QR flow」），因此用户无感。`/new` 的确认消息通过模块级 `pendingAck` 延迟到重连成功后发送（`newSession` 返回时旧实例的 bot 已停，直接回复会静默失败）。

不做的事：不在 `session_shutdown` 里保留 bot 对象跨实例移交——事件回调绑定旧闭包、旧 ctx 已 stale，风险远大于「短暂断开 + 免扫码重连」。
