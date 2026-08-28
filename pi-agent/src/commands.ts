/**
 * 微信端命令分类（纯逻辑，无 IO / 无 pi 运行时依赖）。
 *
 * 命令分两类（见 docs/adr/0007-command-passthrough.md）：
 *  - 原生命令：桥重实现的 pi 能力（stop/esc、compact、new、status、help）。
 *  - 插件命令：pi 的 skill / prompt / 扩展命令，按名字穿透。
 */

export type NativeCommandId = "stop" | "compact" | "new" | "status" | "help";

export interface NativeCommand {
  id: NativeCommandId;
  /** 精确匹配的触发词（已小写），含斜杠与裸词形式。 */
  tokens: string[];
  /** 豁免命令：始终可用、不可在 /wechat-setting 中关闭。 */
  exempt: boolean;
  description: string;
}

export const NATIVE_COMMANDS: NativeCommand[] = [
  {
    id: "stop",
    tokens: ["stop", "/stop", "esc", "/esc"],
    exempt: true,
    description: "中止当前轮次",
  },
  {
    id: "compact",
    tokens: ["/compact"],
    exempt: true,
    description: "压缩上下文",
  },
  { id: "new", tokens: ["/new"], exempt: true, description: "开启新会话" },
  {
    id: "status",
    tokens: ["/status"],
    exempt: false,
    description: "查询模型 / token / 成本",
  },
  { id: "help", tokens: ["/help"], exempt: false, description: "命令清单" },
];

export function nativeCommandById(id: NativeCommandId): NativeCommand {
  return NATIVE_COMMANDS.find((c) => c.id === id)!;
}

export type PluginSource = "skill" | "prompt" | "extension";

export type CommandIntent =
  | { kind: "native"; id: NativeCommandId }
  | { kind: "plugin"; name: string; source: PluginSource; raw: string }
  | { kind: "message"; raw: string };

/**
 * 分类一条入站微信文本。
 * @param pluginSources 已知插件命令名（小写）→ 来源。由 pi.getCommands() 构建。
 */
export function classifyCommand(
  rawText: string,
  pluginSources: ReadonlyMap<string, PluginSource>,
): CommandIntent {
  const raw = rawText.trim();
  const lower = raw.toLowerCase();
  for (const cmd of NATIVE_COMMANDS) {
    if (cmd.tokens.includes(lower)) return { kind: "native", id: cmd.id };
  }
  if (lower.startsWith("/")) {
    const space = lower.indexOf(" ");
    const name = space === -1 ? lower.slice(1) : lower.slice(1, space);
    const source = pluginSources.get(name);
    if (source) return { kind: "plugin", name, source, raw };
  }
  return { kind: "message", raw };
}
