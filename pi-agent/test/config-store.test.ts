import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFile, writeFile, mkdir } from "node:fs/promises";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => "/fake/agent",
  CONFIG_DIR_NAME: ".pi",
}));
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

import {
  loadUser,
  loadProject,
  saveUser,
  saveProject,
  userConfigPath,
  projectConfigPath,
} from "../src/config-store.js";
import { defaultUserConfig } from "../src/settings.js";

beforeEach(() => {
  vi.mocked(readFile).mockReset();
  vi.mocked(writeFile).mockReset();
  vi.mocked(mkdir).mockReset();
});

describe("路径", () => {
  it("用户级配置位于 getAgentDir() 下", () => {
    expect(userConfigPath()).toBe("/fake/agent/wechatbot.json");
  });

  it("项目级配置位于 <cwd>/.pi/ 下", () => {
    expect(projectConfigPath("/proj")).toBe("/proj/.pi/wechatbot.json");
  });
});

describe("loadUser", () => {
  it("文件缺失时返回默认配置", async () => {
    vi.mocked(readFile).mockRejectedValueOnce(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    await expect(loadUser()).resolves.toEqual(defaultUserConfig());
  });

  it("读取合法 JSON 并归一化", async () => {
    vi.mocked(readFile).mockResolvedValueOnce(
      JSON.stringify({ timeoutSeconds: 90, commands: { status: "on" } }),
    );
    await expect(loadUser()).resolves.toMatchObject({
      timeoutSeconds: 90,
      commands: { status: "on" },
    });
  });

  it("损坏 JSON 大声失败（不再静默回退）", async () => {
    vi.mocked(readFile).mockResolvedValueOnce("not json {");
    await expect(loadUser()).rejects.toThrow(/配置 JSON 损坏/);
  });

  it("非 ENOENT 的 IO 错误大声失败", async () => {
    vi.mocked(readFile).mockRejectedValueOnce(
      Object.assign(new Error("EACCES: permission denied"), {
        code: "EACCES",
      }),
    );
    await expect(loadUser()).rejects.toThrow(/读取配置失败/);
  });

  it("合法 JSON 中的未知字段被归一化", async () => {
    vi.mocked(readFile).mockResolvedValueOnce(
      JSON.stringify({ unknown: 1, timeoutSeconds: 300 }),
    );
    await expect(loadUser()).resolves.toEqual({
      timeoutSeconds: 300,
      commands: { help: "on" },
    });
  });
});

describe("loadProject", () => {
  it("文件缺失返回空配置", async () => {
    vi.mocked(readFile).mockRejectedValueOnce(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    await expect(loadProject("/proj")).resolves.toEqual({});
  });

  it("损坏 JSON 大声失败", async () => {
    vi.mocked(readFile).mockResolvedValueOnce("{");
    await expect(loadProject("/proj")).rejects.toThrow(/配置 JSON 损坏/);
  });
});

describe("saveUser", () => {
  it("mkdir 父目录并以 pretty JSON 写入", async () => {
    vi.mocked(mkdir).mockResolvedValue(undefined as any);
    vi.mocked(writeFile).mockResolvedValue(undefined as any);
    await saveUser({ timeoutSeconds: 120, commands: { status: "on" } });
    expect(mkdir).toHaveBeenCalledWith("/fake/agent", { recursive: true });
    expect(writeFile).toHaveBeenCalledWith(
      "/fake/agent/wechatbot.json",
      `${JSON.stringify({ timeoutSeconds: 120, commands: { status: "on" } }, null, 2)}\n`,
      "utf-8",
    );
  });
});

describe("saveProject / loadProject 往返", () => {
  it("保存后读回一致", async () => {
    vi.mocked(mkdir).mockResolvedValue(undefined as any);
    let written = "";
    vi.mocked(writeFile).mockImplementation(async (_p, data: any) => {
      written = data;
    });
    await saveProject("/proj", {
      timeoutSeconds: 240,
      commands: { status: "inherit" },
    });
    expect(mkdir).toHaveBeenCalledWith("/proj/.pi", { recursive: true });

    vi.mocked(readFile).mockResolvedValueOnce(written);
    await expect(loadProject("/proj")).resolves.toEqual({
      timeoutSeconds: 240,
      commands: { status: "inherit" },
    });
  });
});
