# 命令穿透模型：原生重实现 + 插件分级，默认关、三命令豁免

微信端「命令」不把 pi 的 /** 命令原样转发执行，因为内置命令是交互式的（弹 TUI 面板，微信用户无法作答）、扩展命令的 handler 输出走 `ctx.ui` / `pi.sendMessage` 回不到微信。桥改为分两类：

- **原生命令**（stop/esc、compact、new、status、help）：桥逐个重实现其微信行为（调 `ctx.abort` / `ctx.compact` / `ctx.newSession` / 拼状态文本）。
- **插件命令**（`getCommands()` 结果）：skill / prompt 命令直接穿透（展开成 turn，回复自然回微信）；扩展命令按「读 `sourceInfo.path` 源码无 `ctx.ui.*` 调用」启发式筛选后列出，并在面板 footer 与选项上以告警色提示「可能无回复」。

默认全关，`stop`/`esc`、`compact`、`new` 三条豁免（始终可用、灰化不可关，作为紧急中止与收尾抓手）。

配置持久化到 `wechatbot.json`：用户级 `~/.pi/agent/wechatbot.json`（每条 开/关，默认关）、项目级 `join(ctx.cwd, CONFIG_DIR_NAME, "wechatbot.json")`（每条 继承/开/关，默认继承）；生效值取项目级非「继承」值，否则落回用户级。超时阈值同文件、同继承逻辑。

为什么用三级状态而非项目级简单覆盖：三级状态能同时表达「某项目关掉某命令」与「某项目沿用全局」，与 pi 自身 `settings.json` 的全局/项目心智一致。
