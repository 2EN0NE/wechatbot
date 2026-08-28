/**
 * /help 文案生成（纯逻辑，无 IO / 无 pi 运行时依赖）。
 *
 * 面向微信用户的精简说明：只列影响使用的限制 + 当前已启用命令，
 * 不暴露平台层/桥接层/使用层内部分层。超时槽位按生效值动态拼接。
 * 见 docs/adr/0009-help-user-facing.md。
 */

export interface HelpCommandEntry {
 /** 展示触发词，如 "/stop（esc）" 或 "/skill:foo"。 */
 trigger: string;
 description: string;
}

export interface HelpTextOptions {
 /** 生效中的不活跃超时秒数（项目级 > 用户级 > 默认）。 */
 timeoutSeconds: number;
 /** 已启用的原生命令，顺序已排好（豁免在前）。 */
 native: HelpCommandEntry[];
 /** 已启用的透传命令，顺序已排好。 */
 plugin: HelpCommandEntry[];
}

const USER_NOTES: string[] = [
 "纯文本回复：不渲染 markdown，排版只靠换行",
 "不流式：pi 处理完才一次性发完整回复",
 "忙时排队：pi 处理中时新消息按顺序等待（状态栏 +N queued）",
 "依赖 pi 常驻：pi 退出后桥断开，需在 pi 终端重连",
 "媒体限制：图片可识别；文本类文件读内容，其他只描述；视频只给下载路径",
];

export function buildHelpText(opts: HelpTextOptions): string {
 const lines: string[] = ["说明："];
 USER_NOTES.forEach((note, i) => lines.push(`${i + 1}. ${note}`));
 lines.push(
  `6. 不活跃超时：当前 ${opts.timeoutSeconds} 秒无进展会发一次提醒并附最新进度快照；卡住可发送 stop（或 esc）中止`,
 );
 lines.push("");
 lines.push("微信端命令：");
 for (const c of opts.native) lines.push(`${c.trigger}  ${c.description}`);
 for (const c of opts.plugin) lines.push(`${c.trigger}  ${c.description}`);
 return lines.join("\n");
}
