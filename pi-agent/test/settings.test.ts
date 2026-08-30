// 微信桥配置模型测试。
import { describe, it, expect } from "vitest";
import {
  defaultUserConfig,
  isCommandEnabled,
  effectiveTimeoutSeconds,
  normalizeUserConfig,
  normalizeProjectConfig,
  DEFAULT_TIMEOUT_SECONDS,
  type UserConfig,
  type ProjectConfig,
} from "../src/settings.js";

describe("isCommandEnabled", () => {
  const user: UserConfig = { timeoutSeconds: 180, commands: { status: "on" } };
  const empty: ProjectConfig = {};

  it("always enables exempt commands regardless of config", () => {
    expect(isCommandEnabled("stop", true, user, empty)).toBe(true);
    expect(
      isCommandEnabled("stop", true, user, { commands: { stop: "off" } }),
    ).toBe(true);
  });

  it("defaults non-exempt commands to off", () => {
    expect(isCommandEnabled("help", false, user, empty)).toBe(false);
  });

  it("honours the user-level switch", () => {
    expect(isCommandEnabled("status", false, user, empty)).toBe(true);
  });

  it("lets project override user with on/off", () => {
    expect(
      isCommandEnabled("status", false, user, { commands: { status: "off" } }),
    ).toBe(false);
    expect(
      isCommandEnabled("help", false, user, { commands: { help: "on" } }),
    ).toBe(true);
  });

  it("falls back to user when project says inherit", () => {
    expect(
      isCommandEnabled("status", false, user, {
        commands: { status: "inherit" },
      }),
    ).toBe(true);
  });
});

describe("effectiveTimeoutSeconds", () => {
  it("uses project value when present", () => {
    expect(
      effectiveTimeoutSeconds(
        { timeoutSeconds: 180, commands: {} },
        { timeoutSeconds: 300 },
      ),
    ).toBe(300);
  });

  it("falls back to user, then default", () => {
    expect(
      effectiveTimeoutSeconds({ timeoutSeconds: 120, commands: {} }, {}),
    ).toBe(120);
    expect(effectiveTimeoutSeconds(defaultUserConfig(), {})).toBe(
      DEFAULT_TIMEOUT_SECONDS,
    );
  });

  it("rejects non-positive values with the default", () => {
    expect(
      effectiveTimeoutSeconds({ timeoutSeconds: 0, commands: {} }, {}),
    ).toBe(DEFAULT_TIMEOUT_SECONDS);
  });
});

describe("defaultUserConfig", () => {
  it("默认开 help（发现入口），其余命令关", () => {
    const cfg = defaultUserConfig();
    expect(cfg.commands.help).toBe("on");
    expect(cfg.commands.status).toBeUndefined();
    expect(cfg.timeoutSeconds).toBe(DEFAULT_TIMEOUT_SECONDS);
  });
});

describe("normalizeUserConfig", () => {
  it("returns defaults for garbage input", () => {
    expect(normalizeUserConfig(null)).toEqual(defaultUserConfig());
    expect(normalizeUserConfig("x")).toEqual(defaultUserConfig());
    expect(normalizeUserConfig(42)).toEqual(defaultUserConfig());
  });

  it("coerces timeout and drops invalid command values", () => {
    const out = normalizeUserConfig({
      timeoutSeconds: 90,
      commands: { status: "on", help: "nope", bad: 1 },
    });
    expect(out.timeoutSeconds).toBe(90);
    // 默认 help:on 保留；输入里的 status:on 生效；help:"nope"/bad 被丢弃。
    expect(out.commands).toEqual({ help: "on", status: "on" });
  });

  it("explicit help off is respected", () => {
    const out = normalizeUserConfig({ commands: { help: "off" } });
    expect(out.commands.help).toBe("off");
  });

  it("ignores non-positive timeouts", () => {
    expect(normalizeUserConfig({ timeoutSeconds: -5 }).timeoutSeconds).toBe(
      DEFAULT_TIMEOUT_SECONDS,
    );
  });

  it("保留非空 allowedUserId，丢弃空串与非字符串", () => {
    expect(normalizeUserConfig({ allowedUserId: "wxid_1" }).allowedUserId).toBe(
      "wxid_1",
    );
    // 保留时 trim 首尾空白，避免带空白的值永不匹配、锁死白名单（无配对回退）。
    expect(
      normalizeUserConfig({ allowedUserId: "  wxid_1  " }).allowedUserId,
    ).toBe("wxid_1");
    expect(
      normalizeUserConfig({ allowedUserId: "" }).allowedUserId,
    ).toBeUndefined();
    expect(
      normalizeUserConfig({ allowedUserId: "  " }).allowedUserId,
    ).toBeUndefined();
    expect(
      normalizeUserConfig({ allowedUserId: 42 }).allowedUserId,
    ).toBeUndefined();
  });
});

describe("normalizeProjectConfig", () => {
  it("returns empty for garbage input", () => {
    expect(normalizeProjectConfig(null)).toEqual({});
    expect(normalizeProjectConfig("x")).toEqual({});
  });

  it("keeps only valid project switches", () => {
    const out = normalizeProjectConfig({
      timeoutSeconds: 240,
      commands: { status: "on", help: "inherit", bad: "off" },
    });
    expect(out.timeoutSeconds).toBe(240);
    expect(out.commands).toEqual({ status: "on", help: "inherit", bad: "off" });
  });
});
