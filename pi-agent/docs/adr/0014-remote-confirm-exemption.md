# 14 — 远端豁免接入：`/new` 不再被 TUI 确认框拦住

- 状态：**已接受**（2026-10-27）
- 相关：nano-pi-agent-creator `docs/adr/0068-remote-mode-confirm-exemption-cwd-scoped.md`（机制与接口）、permission-gate 外部确认 ADR-0028（弱桥接形态先例）、本仓库 `adr/0004`（`/new` 依赖 `ctx.newSession()`）、`adr/0007`（命令穿透）

## 背景

微信发 `/new` → 桥调 `ctx.newSession()` → pi 顺序 emit `session_before_switch`。
`confirm-destructive` 与 `dirty-repo-guard` 各弹一个 TUI 选择器，`ctx.hasUI` 在 TUI 下恒为 true，
无人按键即**永久阻塞**，微信侧再也收不到回执。

同形态还存在于 `/fork`、`/resume`、`agent_end` 相关确认等（nano 侧共 11 处），
该侧已实现「远端豁免模式」：启动 flag 授予许可、通道 `arm()` 占用、`selector` 对声明了
`unattendedDefault` 的对话框在 armed 时直接返回默认值（不弹框）。

本 ADR 只决定**本仓库（通道侧）如何接入**。

## 决策

### D1 弱桥接，不引入 `@zenone/pi-selector` 依赖

新建 `src/confirm-gate.ts`，按鸭子类型读 `globalThis.__confirmGateApi`
（`hasLicense` / `isArmed` / `arm`）。理由：跨仓库解耦（与 ADR-0028 同形）；本仓库
`node_modules` 里没有该包，import 会让未安装 selector 的环境直接加载失败。
fail-soft：接口缺失、形状不符、无许可、`arm()` 被拒 → 一律 `undefined` / `"off"`，不抛错。

### D2 连接就绪 arm，断开 / 登录失败 / 会话替换 disarm

- arm：`startWechat` 中 `connected = true` 之后，`armConfirmGate("wechat")`。
- disarm：`shutdownBot()` 首行（覆盖 quit / reload / 会话替换），以及 `bot.start()` 失败与
  登录异常两条 `connected = false` 路径。
- 解除函数存**模块级** `disarmConfirmGate`：扩展实例会被 `newSession` 重建，但模块闭包保留
  （同 `restartAfterReplace` / `pendingAck`），旧实例的 `session_shutdown` 必须能释放占用。
- 顺序安全性：`session_before_switch`（guards 判断）在 `session_shutdown`（disarm）**之前**，
  因此 `/new` 当下必然仍处于 armed。

### D3 `/new` 前置自检，未生效直接拒绝（不进入挂起）

自检放在发送 "Starting a new session…" **之前**：`confirmGateMode() !== "armed"` → 回执
「TUI 确认框会拦住，需 `--unattended-confirm`」，不调用 `ctx.newSession()`。
理由：挂起对用户表现为「发了 /new 没反应」，比明确拒绝更差。

### D4 处理 `newSession()` 的 `{cancelled}`

取消（任一 handler 返回 `{cancel:true}`）时会话**未替换**。此时必须回滚
`restartAfterReplace` / `pendingAck` 并给微信回执；否则下一次真实 `session_start`
（手动 `/new`、resume）会误触发重连并补发过期 ack。

### D5 `/status` 暴露豁免状态

追加一行 `Exemption: armed / licensed-idle / off`，让「为什么 /new 被拒」可自查。

## 不做的事

- 不 monkey-patch `ctx.ui` 或改写 `ctx.hasUI`：那是全进程隐式行为，违背「许可显式可证明」。
- 不覆盖 B 类（由扩展命令/面板打开的对话框）：命令穿透默认关，用户显式加白名单即接受其交互成本
  （与 nano ADR-0068 D6 一致）。
- 不改 SDK 层（分层铁律）。

## 后果与残余风险

- 微信连接期间，**整个 pi 进程**的 selector 对话框都按声明默认值放行（含 TUI 前的人类操作）；
  这是远端模式的既定代价，`/unattended disarm` 可随时恢复。
- armed 但调用点未声明默认值的 selector（如 `/custom-compact` 多 profile 选择）会「静默取消」；
  `questionnaire` 工具返回 cancelled。均不挂起，但行为与有人值守时不同。
- `session_shutdown`（disarm）到新会话 `session_start`（arm）之间存在窗口，此时远端触发会回退旧行为；
  窗口内桥未连接，实际影响可忽略。
- 许可缺失时本仓库只能 fail-soft 提示，无法自行授予（flag 只能由启动命令给出）。

## 验证

- 单测：`test/confirm-gate.test.ts`（三态、形状校验、arm 透传、探测异常与陈旧异常清理）；
  `test/index.test.ts`「远端豁免接线（ADR-0014）」（连接即 arm、shutdown 即 disarm、解除函数抛错不打断
  关闭流程、无接口 fail-soft、未 armed 拒绝且不触达 `newSession`、cancelled 回滚不重连、成功路径重连并补发 ack）；
  「内部 /new 命令」4 例（无请求只 notify、残留请求过期丢弃且派发点已回执、内部命令缺失即拒绝、并发
  `/new` 拒绝）。
- 手工 UAT（真机）：启动带 `--unattended-confirm` → `/unattended status` 为 `armed` →
  微信 `/new` 无 TUI 框、免扫码重连、收到 ack；`/unattended disarm` 后 TUI 手动 `/new`
  恢复弹框（armed 期间是全进程行为，见「后果」）。
- 日志：`~/.pi/logs/wechat_<date>.log` 出现 `confirm gate armed/disarmed`、`confirm gate disarm failed`、
  `new session refused — unattended exemption not armed`、`new session request dispatched`、
  `internal command unavailable — refusing /new`、`new session cancelled by extension`。

## 补充：pi 1.4 的 stale ctx 契约（2026-10-27 真机 UAT 回归）

pi 1.4 起 `AgentSession.dispose()` 会 `invalidate` 旧 runner（`dist/core/agent-session.js`
`dispose()` → `_extensionRunner.invalidate()`）。会话替换后**旧 ctx 的任何属性访问都抛**
`This extension ctx is stale …`。真机 UAT 暴露两处违规：

1. **selector 侧（nano 仓库）**：`refreshStatus()` 用 `session_start` 缓存下来的 ctx 刷状态栏；
   通道的 `session_start` 可能早于 selector 的（handler 顺序不定），`arm()` 于是拿着**旧 ctx**
   访问 `ui.setStatus` → 抛错 → 通道把「arm 成功」误判成「Login failed」。
   修复：`refreshStatus` 改为 try/catch 并丢弃失效 ctx（下次 `session_start` 重绑），
   单测见 nano `test/vitest/extensions/unattended-gate.test.ts`「会话替换后的旧 ctx」。

2. **桥接侧（本仓库）**：`ctx.newSession()` 返回后，`dispatchMessage` 仍用旧 ctx 调
   `updateStatus(ctx)` → `Handler error: … stale …`。
   修复：`handleNativeCommand` 返回 `boolean`（true = 会话已替换），`dispatchMessage`
   据此**直接退出**，不再触碰 ctx。另有 `confirm-gate.ts` 的 `armConfirmGate` /
   `confirmGateMode` 全面 try/catch：arm 只是优化，任何 selector 侧异常都不得让连接失败。

结论：ADR-0004 的「模块级标志 + 新实例 `session_start` 重连」方案在 pi 1.4 仍成立
（模块实例跨替换保留、工厂会重新执行、`pi` 与 ctx 都是新的）；但**旧 ctx 一旦替换即不可再用**，
不能靠它做收尾（刷状态、回执等）。回执一律走 SDK 的 bot 对象（与 pi ctx 无关）。

## 补充 2：会话控制方法只存在于命令 ctx（2026-10-27 真机 UAT 二次回归）

`newSession / switchSession / fork` 在 pi 1.4 只挂在 `ExtensionCommandContext` 上；
事件 handler（`session_start`、`session_shutdown`、`agent_end` …）拿到的是 `ExtensionContext`，
**没有**这些方法。桥在 `/new` 重连后把事件 ctx 存进 `bot.onMessage` 闭包，于是第二次 `/new`
报 `ctx.newSession is not a function`（首次 `/wechat` 命令连的实例不会，故此前漏测）。
类型上被 `startWechat(ctx: any)` 掩盖。

决策：注册内部扩展命令 **`wechat-internal-new`**。

- 微信 `/new` 只做前置检查（idle、豁免 armed），然后
  `pi.sendUserMessage('/wechat-internal-new', { expandPromptTemplates: true })` 派发；
- pi 的 `_tryExecuteExtensionCommand()` 用 `runner.createCommandContext()`（新鲜命令 ctx）执行 handler
  （`agent-session.js:1698-1710`），真正的 `newSession()` 在 handler 内调用；
- handler 无待处理请求时**只 notify 并返回**（防 TUI 手敲误触）；
- 内部命令按名字从 `reloadConfig` / 面板排除（不依赖源码 grep 启发式）；
- `startWechat` / `dispatchMessage` / `handleNativeCommand` 的 ctx 类型收敛为 `ExtensionContext`，
  派发后**一律不再访问 ctx**（原设计的 `sessionReplacedByInternalCommand` 交接不成立，见补充 3）。

代价与边界：TUI 自动补全里能看到这个内部命令（`RegisteredCommand` 无 `hidden` 字段）；
命令派发依赖 `expandPromptTemplates` 语义，若上游变更则退化为「明确回执拒绝」而非挂起。

## 补充 3：评审修正（2026-10-27）

补充 2 里「派发方按 `sessionReplacedByInternalCommand` 决定是否跳过后续 ctx 访问」**不成立**，
三处证据：`dist/core/extensions/loader.js:311` 的 `sendUserMessage` 无 return、
`agent-session.js:2774` 的 `.catch()` 链未 return（失败走 `runner.emitError`）、
`types.d.ts:1267` 的签名是 `void`。因此 `await pi.sendUserMessage(...)` 在下一个微任务即返回，
标志只在 `newSession()` resolve 后才置位 —— 派发方读到的永远是 `false`。

修正（均带回归用例）：

1. **派发后不再碰 ctx**：`/new` 分支派发成功后直接 `return true`（语义改为「ctx 已不可再用」），
   `dispatchMessage` 据此跳过 `updateStatus(ctx)`；删掉 `sessionReplacedByInternalCommand`。
2. **残留请求加时限**：`pendingNewRequest` 记 `at`，超过 30s（`PENDING_NEW_REQUEST_TTL_MS`）的请求
   在内部命令里按「无待处理请求」丢弃 —— 派发是发后不管，handler 未被派发时无人清空请求，
   否则 TUI 里手敲内部命令会给早已离开的用户补发回执并触发一次意料之外的会话替换。
3. **错误分类**：`confirm-gate.ts` 保留最近一次探测异常（`confirmGateLastError()`），
   `/new` 拒绝回执据此区分「没有许可」（提示 `--unattended-confirm`）与「接口实现抛错」。
4. **arm 前先释放**：`startWechat` 先 `releaseConfirmGate()` 再 `arm()`。登录中重复执行 `/wechat`
   会产生两个登录流程，覆盖旧解除函数会让 selector 引用计数泄漏、断开后永久 armed（违背 D2）。

测试替身同步修正：`makeFakePi` 的 `sendUserMessage` 改为同步返回 `void` + 后台执行 handler
（配 `flushCommands()`），与真实契约一致 —— 之前它会 `await` handler，正是它掩盖了上述问题。

## 补充 4：二轮评审修正（2026-10-27，派发可观测与断开健壮性）

评审指出补充 3 仍有两类「静默」与一处健壮性缺口，确认后按下列方式修掉（均带回归用例）：

1. **「已受理」回执移到派发点**：原先 "Starting a new session…" 在内部命令 handler 里发，
   而 handler 可能永远不执行（命令未注册/被重名消歧、实例被替换、并发 `/new`），
   用户表现为「发了 `/new` 没反应」。现在回执与 `new session request dispatched` 日志都在
   `sendUserMessage` **之前**发出，同时保证回执顺序先于 ack。
2. **派发前确认内部命令可用**：`pi.getCommands()` 返回的是 `invocationName`，重名会被消歧成
   `wechat-internal-new:1`。查不到就明确回执拒绝 —— 否则 `prompt()` 会把 `/wechat-internal-new`
   当普通用户文本送给模型（真实 turn、烧 token），与补充 2「退化为明确回执拒绝」的描述不符。
3. **单槽 `pendingNewRequest` 加重入保护**：已有未过期在飞请求时，第二条 `/new` 直接回执拒绝，
   不再覆盖（覆盖会让两条回执对象错配，且后一条被静默吞掉）。
4. **`releaseConfirmGate()` fail-soft**：先摘 `disarmConfirmGate` 引用再调用解除函数。
   解除函数可能抛错（selector 侧 stale ctx，同补充 1 的触发面），原先裸调用会中断
   `shutdownBot()`（bot 停不下来）并让坏引用被反复重放、引用计数永久不降（违背 D2）。
   现在记录 `confirm gate disarm failed` 后继续清理 —— 该处已是断开边界，没有可返回的错误通道。
5. **`confirmGateLastError()` 不再粘滞**：`confirmGateMode()` 的两个早退分支（接口缺失 / 无许可）
   也清空 `lastProbeError`，避免把「没带 `--unattended-confirm`」误报成「接口实现抛错」。
