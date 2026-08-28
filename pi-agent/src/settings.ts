/**
 * 微信桥配置模型（纯逻辑，无 IO / 无 pi 运行时依赖）。
 *
 * 持久化到 wechatbot.json：用户级（每条命令 开/关，默认关）+ 项目级
 * （每条命令 继承/开/关，默认继承）。超时阈值同文件、同继承逻辑。
 * 见 docs/adr/0007-command-passthrough.md。
 */

export const DEFAULT_TIMEOUT_SECONDS = 180;

export type Switch = "on" | "off";
export type ProjectSwitch = "inherit" | Switch;

export interface UserConfig {
  timeoutSeconds: number;
  commands: Record<string, Switch>;
}

export interface ProjectConfig {
  timeoutSeconds?: number;
  commands?: Record<string, ProjectSwitch>;
}

export function defaultUserConfig(): UserConfig {
  // help 默认开（发现入口），其余命令默认关；豁免命令与配置无关。见 adr/0009。
  return { timeoutSeconds: DEFAULT_TIMEOUT_SECONDS, commands: { help: "on" } };
}

/** 某命令是否在微信端启用。豁免命令恒开，与配置无关。 */
export function isCommandEnabled(
  id: string,
  exempt: boolean,
  user: UserConfig,
  project: ProjectConfig,
): boolean {
  if (exempt) return true;
  const p = project.commands?.[id];
  if (p && p !== "inherit") return p === "on";
  return (user.commands[id] ?? "off") === "on";
}

/** 生效的不活跃超时阈值（秒）。项目级非空则覆盖，否则落回用户级，再落回默认。 */
export function effectiveTimeoutSeconds(
  user: UserConfig,
  project: ProjectConfig,
): number {
  const t =
    project.timeoutSeconds ?? user.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  return t > 0 ? t : DEFAULT_TIMEOUT_SECONDS;
}

/** 防御性解析：把未知 JSON 归一化为合法 UserConfig。 */
export function normalizeUserConfig(raw: unknown): UserConfig {
  const base = defaultUserConfig();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  const timeout = Number(r.timeoutSeconds);
  if (Number.isFinite(timeout) && timeout > 0) {
    base.timeoutSeconds = Math.floor(timeout);
  }
  const commands = r.commands;
  if (commands && typeof commands === "object") {
    for (const [k, v] of Object.entries(commands as Record<string, unknown>)) {
      if (v === "on" || v === "off") base.commands[k] = v;
    }
  }
  return base;
}

/** 防御性解析：把未知 JSON 归一化为合法 ProjectConfig。 */
export function normalizeProjectConfig(raw: unknown): ProjectConfig {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: ProjectConfig = {};
  const timeout = Number(r.timeoutSeconds);
  if (Number.isFinite(timeout) && timeout > 0) {
    out.timeoutSeconds = Math.floor(timeout);
  }
  const commands = r.commands;
  if (commands && typeof commands === "object") {
    out.commands = {};
    for (const [k, v] of Object.entries(commands as Record<string, unknown>)) {
      if (v === "on" || v === "off" || v === "inherit") {
        out.commands[k] = v;
      }
    }
  }
  return out;
}
