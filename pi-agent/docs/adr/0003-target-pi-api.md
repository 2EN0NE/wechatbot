# 目标 pi API：@earendil-works/pi-coding-agent（peer `"*"`）

桥面向 `@earendil-works/pi-coding-agent`——pi 当前线，本机运行时 0.84.2。原 `@mariozechner/pi-coding-agent` 已废弃，org 迁移到 `@earendil-works`。peer 依赖声明为 `"*"`（pi 自带并注入、扩展不打包，见 `docs/packages.md` 的 Dependencies 节）。

用到的每个 API 都已在 0.84.2 核实存在：`ctx.isIdle` / `ctx.abort` / `ctx.compact` / `ctx.getContextUsage`、`sessionManager.getEntries`、`modelRegistry.isUsingOAuth`、`ui.theme.fg`、`registerTool` / `registerCommand` / `sendUserMessage`、所有生命周期事件，以及 `AgentMessage.stopReason` / `errorMessage` / `usage`。

typebox 同理：pi 自带 `typebox`（不是 `@sinclair/typebox`）。工具参数 schema 从 `typebox` 导入，并以 `"*"` 声明为 peer 依赖。
