# Harness 形态冻结：继续留在 pi coding-agent 扩展，暂不迁 pi-durable

`@earendil-works/pi-durable@1.3.0` 能覆盖桥接层目前手搓的全部持久化能力：task 级 checkpoint（逐 step 落盘）、`requestId` 精确一次提交、`replay: "safe"` 决定工具是否重跑、持久化排队消息、多 conversation 并发与 fork、documents（持久应用状态）、task 所有权树与 abort 补偿。官方也明说接下来要做的正是 "a Slack bot or a GitHub triage bot"——与微信桥同形。

但它不是 pi coding agent 的一部分：`pi-coding-agent@1.3.0` 的 dependencies 里没有它，官方明文 "**It does not replace the Pi coding agent**"，且标注 experimental、API 可能变。迁过去等于把桥从「一个挂进当前 pi 会话的扩展」重写成「一个独立应用」——设置面板（ADR-0008）、命令穿透（ADR-0007）、TUI 状态栏、`/wechat` 挂到当前会话的整体形态全部作废。

决策：**冻结当前形态**（pi coding-agent 扩展），主题2 用扩展内的 journal（ADR-0011）收尾，不因 pi-durable 的出现改变路线。

为什么冻结不会白做：pi coding agent 1.3.0 对 turn 级恢复零支持——"durable" 只出现在 `pi.appendEntry()`（不进模型上下文的数据）与 RPC 的 durable cursor（session entry id 游标），没有任何 turn / task 级 checkpoint。journal 仍是当前唯一保障。更关键的是，**即使将来迁到 pi-durable，入口窗口依然要桥接层自己处理**：SDK poller 是「游标先异步落盘、后 `emit`」，而 `requestId` 只保护「客户端还握着这条消息的重试」，保护不了「桥已经忘了这条消息」。要真正消掉这个窗口，得把准入写盘提前到游标提交之前——那是游标所有权 / 分层问题（ADR-0011 的分层铁律），不随 harness 迁移消失。

因此 Replay（回放）的职责可分层看待：入口准入（admit）在任何形态下都属于桥接层；准入后的「重放整个 turn」在扩展形态下由 journal 承担，在 durable 形态下由 harness checkpoint 接管；真机验证两种形态都需要，只是验证对象从「回放一个 turn」变成「resume 一个 task」。

重评触发条件（任一满足则重开此议题，且以 spike 验证而非先验判断）：pi-durable 去掉 experimental 标注转 stable；主题4 多进程编排启动（其原生形态正是多 conversation + subagent-as-conversation）；主题5 幂等 / 事务保障启动（其原生原语是 `requestId` + task abort 补偿）。
