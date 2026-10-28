# 上游 feature request 草稿（未提交）

**标题**：让事件上下文也能发起会话替换（或提供 `pi.newSession()`）

## 问题

`newSession / switchSession / fork` 目前只存在于 `ExtensionCommandContext`（命令 handler 的 ctx）。
事件 handler（`session_start`、`agent_end`、以及由外部通道驱动的消息回调）拿到的是
`ExtensionContext`，无法发起会话替换。

这导致「非 TUI 通道」（微信桥、RPC 侧桥、自动化脚本）必须绕道：
注册一个内部扩展命令，再用 `pi.sendUserMessage('/内部命令', { expandPromptTemplates: true })`
派发，才能拿到命令 ctx。可行但不符合直觉，且内部命令会出现在自动补全里、需要防误触。

## 建议（任一即可）

1. `ExtensionAPI` 增加 `newSession(options?) / fork() / switchSession() / navigateTree()`，
   内部复用现有 `runner.createCommandContext()` 的绑定；或
2. 事件 ctx 也暴露这组方法（会话替换的「安全性」由 pi 在调用时判定，例如仅在 idle 时允许）；或
3. 显式 API：`pi.withCommandContext(fn)` —— 借一个当前会话的命令 ctx 执行回调，回调结束后失效。

## 其它上下文

- pi 1.4 起 `AgentSession.dispose()` 会 `runner.invalidate()`，旧 ctx 立即失效；
  这使「缓存一个命令 ctx 长期使用」不可行，必须每次按需获取。
- 现有用法参考：`agent-session.js` 的 `_tryExecuteExtensionCommand()`。

## 临时方案

本仓库（`@wechatbot/pi-agent`）暂时使用内部命令 `wechat-internal-new` + `sendUserMessage` 派发，
见 `../adr/0014-remote-confirm-exemption.md`（补充 2）。上游提供上述任一 API 后即可删除该命令。
