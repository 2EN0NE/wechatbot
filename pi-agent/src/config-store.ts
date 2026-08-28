/**
 * 配置持久化（IO 层）。
 *
 * 用户级：~/.pi/agent/wechatbot.json（getAgentDir() 尊重 PI_AGENT_DIR 覆盖）
 * 项目级：<cwd>/.pi/wechatbot.json（CONFIG_DIR_NAME 尊重 rebrand）
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
 normalizeUserConfig,
 normalizeProjectConfig,
 defaultUserConfig,
 type UserConfig,
 type ProjectConfig,
} from "./settings.js";

export function userConfigPath(): string {
 return join(getAgentDir(), "wechatbot.json");
}

export function projectConfigPath(cwd: string): string {
 return join(cwd, CONFIG_DIR_NAME, "wechatbot.json");
}

export interface LoadedConfigs {
 user: UserConfig;
 project: ProjectConfig;
}

export async function loadConfigs(cwd: string): Promise<LoadedConfigs> {
 const [user, project] = await Promise.all([loadUser(), loadProject(cwd)]);
 return { user, project };
}

function isMissingFile(e: unknown): boolean {
 return (
  typeof e === "object" &&
  e !== null &&
  (e as { code?: string }).code === "ENOENT"
 );
}

function errorText(e: unknown): string {
 return e instanceof Error ? e.message : String(e);
}

/**
 * 读取并解析 JSON 配置文件。
 * 文件缺失（首次运行）返回 null → 默认配置；JSON 损坏或 IO 错误大声失败。
 */
async function readConfig(path: string): Promise<unknown | null> {
 let raw: string;
 try {
  raw = await readFile(path, "utf-8");
 } catch (e) {
  if (isMissingFile(e)) return null;
  throw new Error(`读取配置失败 ${path}：${errorText(e)}`, { cause: e });
 }
 try {
  return JSON.parse(raw);
 } catch (e) {
  throw new Error(`配置 JSON 损坏 ${path}：${errorText(e)}`, { cause: e });
 }
}

export async function loadUser(): Promise<UserConfig> {
 const raw = await readConfig(userConfigPath());
 if (raw === null) return defaultUserConfig();
 return normalizeUserConfig(raw);
}

export async function loadProject(cwd: string): Promise<ProjectConfig> {
 const raw = await readConfig(projectConfigPath(cwd));
 if (raw === null) return {};
 return normalizeProjectConfig(raw);
}

export async function saveUser(config: UserConfig): Promise<void> {
 await writeJson(userConfigPath(), config);
}

export async function saveProject(
 cwd: string,
 config: ProjectConfig,
): Promise<void> {
 await writeJson(projectConfigPath(cwd), config);
}

async function writeJson(path: string, data: unknown): Promise<void> {
 await mkdir(dirname(path), { recursive: true });
 await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}
