# AGENTS.md — wechatbot 仓库约定

本文件是仓库级补充说明，与全局 `~/.pi/agent/AGENTS.md` 的原则合并使用。
全局原则（可观测可验证 / 先思考后编码 / 简洁优先 / 精准修改 / 目标驱动执行 / git 约束）此处不重复，仅补充本仓库特有约定。

## 文档与注释语言

- 备注、代码注释、文档（README、CONTEXT.md、ADR）**一律用中文**。
- 代码本身（标识符、类型名、字符串字面量）用英文。
- 需要英文版时放显式 `.EN` 后缀文件（如 `README.EN.MD`），主文档保持中文。

## 仓库结构与分层

多语言 monorepo，同一套 iLink 协议四个 SDK 平行实现：

- `nodejs/` — TypeScript SDK，主实现与参考（协议 / 轮询 / 发送 / typing / storage / 媒体加密）
- `python/` / `golang/` / `rust/` — 平行 SDK，对齐 nodejs 的 API 面
- `pi-agent/` — pi 扩展（微信 ↔ pi 桥接，薄桥接层）
- `docs/protocol.md`（协议）、`docs/architecture.md`（分层架构）

**分层铁律**：底层稳定性（游标持久化、指数退避、session 重登、优雅停止）由 SDK 层负责；pi-agent 只做桥接编排。能不动 SDK 就不动 SDK。

## 领域词汇与架构决策

- 领域词汇以 `pi-agent/CONTEXT.md` 为准（Turn / Active turn / Queued turn / Busy·Idle / Abort），用词保持一致，不引入同义漂移。
- 架构决策记入 `pi-agent/docs/adr/`（编号 + 中文）。已定决策默认不重议；确需推翻时显式标注。
- 深模块优先：纯逻辑抽成独立模块（如 `bridge-state.ts` / `inbound.ts`），接口即测试面；不为了「好测」把编排逻辑抽散——失去 locality 反而把真正的 bug 藏进调用点。

## pi 扩展开发注意

- 扩展 session-local、进程内、无沙箱运行；桥接长跑的前提是 pi 会话常驻。
- 目标 pi API：`@earendil-works/pi-coding-agent`（peer 依赖 `"*"`，见 ADR-0003）；工具参数 schema 从 pi 自带的 `typebox` 导入（不是 `@sinclair/typebox`）。
- 微信 iLink 平台硬限制：无消息编辑 / 流式 draft API，不要做流式实时回传。

## 测试与可观测

- 单测用 vitest：`cd pi-agent && npm test`；类型检查 `npm run typecheck`。
- 测试目录与源码分离（`pi-agent/test/`，tsconfig 已 exclude）。
- 长程稳定性无法界面 e2e：靠统一状态栏（`updateStatus`，含队列计数）+ SDK 结构化日志观测。改完要能回答「桥现在什么状态、队列堆了几条」。
- 桥接侧日志复用 SDK 的 `createLogger` + 自定义 `FileTransport`，写到 `~/.pi/logs/wechat_<日期>.log`（**不要写 stderr，会刷 TUI**，见 ADR-0005）；消息文本一律 `textPreviewFor` 脱敏（≤80 字符单行）。
