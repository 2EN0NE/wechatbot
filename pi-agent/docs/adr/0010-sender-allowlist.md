# 发送者白名单鉴权：放桥接层，混合形态（首用户配对 + 显式锁定）

微信 iLink 平台的 bot 是「任何能给它发消息的人都能以宿主权限触发工具执行」——roadmap 主题 1 已自认这是缺口。鉴权（谁能驱动 Pi agent）是桥接的编排职责，**不放 SDK 层**：SDK 是多语言通用实现，只负责协议稳定性（游标持久化、指数退避、session 重登、优雅停止），把 Pi 特有的授权策略塞进 SDK 会污染通用 API 面。拦截点在 `dispatchMessage` 入口，未授权即拒绝，不进入队列、不触发任何工具执行。

白名单形态选**混合**：`UserConfig.allowedUserId`（用户级 `~/.pi/agent/wechatbot.json`）为空时走「首用户配对」——首个发消息的 wxid 被授权并立即持久化，此后白名单锁定、不再自动配对；显式配置则跳过配对、严格匹配。未授权消息静默丢弃，只在桥日志记一条脱敏记录（wxid + `textPreviewFor` 摘要），不回任何内容，避免向陌生人泄露 agent 的存在与命令面。配对成功的 wxid 回发一次欢迎语（复用 `welcomedUsers` 链路，触发对象从「每个新用户」收窄为「配对成功的那一个」）。

为什么默认拒绝却保留配对、而非纯 default-deny：纯 default-deny 要求用户先登录、拿到自己 wxid、手动填配置、重载，破坏「扫码即用」体验；混合形态用「首个说话的人即 owner」保留零配置 onboarding，同时用显式锁定把「谁能配对」的口子收紧。残留风险是配对窗口期（未配对状态下第一个说话者成为 owner），对单人自用可接受。

参考：pi-telegram 的 `allowedUserId` + pair/allow/deny 三态（`lib/config.ts`）。
