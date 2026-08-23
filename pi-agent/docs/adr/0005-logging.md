# 桥接日志：自定义 FileTransport 写 ~/.pi/logs/wechat_<日期>.log

pi 不会把扩展的 stderr 重定向到 `.pi/logs/`——stderr 会直接刷进 TUI 界面。因此扩展自己实现 `FileTransport`（复用 SDK 的 `LogTransport` 接口），把日志追加写到 `~/.pi/logs/wechat_<YYYYMMDD>.log`（与 pi-logger 的文件布局一致）。

格式沿用 SDK `StderrTransport` 的单行格式：`ISO时间戳 LEVEL [context] message {json}`。

两个 logger 都走文件：

- 扩展自己的：`createLogger({ transport: fileTransport }).child("wechat")`
- SDK 内部（poller / auth / sender / typing）：`new WeChatBot({ logger: createLogger({ transport: fileTransport, level: "info" }) })` 注入同一 transport

关键打点（扩展层）：

- 消息接收 / 命令识别（info，含 `textPreviewFor` 脱敏预览 ≤80 字符单行）
- 桥未连接时丢弃消息（warn）——补上「断线丢消息无痕」的盲区
- `sendUserMessage` 失败（error）
- `agent_settled` 回复结果（info，outcome）与回复失败（error）
- 连接 / 断开 / session 过期 / SDK 错误

日志写入是 fire-and-forget（异步 `appendFile`，失败静默）——日志绝不能 crash 桥。QR 码仍写 stderr（登录时需在终端显示给用户扫）。

否决的备选：第三方 `pi-logger`。它做的是 agent 侧遥测（token / 成本 / trace 层级），不覆盖桥接侧事件；我们只需文件追加，SDK 的 `Logger` / `LogTransport` 接口已足够，无需新依赖。
