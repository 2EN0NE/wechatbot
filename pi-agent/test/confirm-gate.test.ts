import { afterEach, describe, expect, it, vi } from "vitest";
import {
	armConfirmGate,
	confirmGateLastError,
	confirmGateMode,
} from "../src/confirm-gate.js";

type Holder = { __confirmGateApi?: unknown };

function installApi(api: Record<string, unknown>): void {
  (globalThis as Holder).__confirmGateApi = api;
}

afterEach(() => {
  delete (globalThis as Holder).__confirmGateApi;
});

describe("远端豁免弱桥接（ADR-0014）", () => {
  it("接口缺失 → off，arm 返回 undefined", () => {
    expect(confirmGateMode()).toBe("off");
    expect(armConfirmGate()).toBeUndefined();
  });

  it("形状不符（缺必需方法）→ 视为不可用", () => {
    installApi({ isArmed: () => true });
    expect(confirmGateMode()).toBe("off");
    expect(armConfirmGate()).toBeUndefined();
  });

  it("有许可未占用 → licensed-idle", () => {
    installApi({ hasLicense: () => true, isArmed: () => false, arm: vi.fn() });
    expect(confirmGateMode()).toBe("licensed-idle");
  });

  it("无许可 → off（即使 isArmed 报 true 也不认）", () => {
    installApi({ hasLicense: () => false, isArmed: () => true, arm: vi.fn() });
    expect(confirmGateMode()).toBe("off");
  });

  it("armed：arm(owner) 原样透传返回的解除函数", () => {
    const disarm = vi.fn();
    const arm = vi.fn(() => disarm);
    installApi({ hasLicense: () => true, isArmed: () => true, arm });

    expect(confirmGateMode()).toBe("armed");
    expect(armConfirmGate()).toBe(disarm);
    expect(arm).toHaveBeenCalledWith("wechat");
    expect(armConfirmGate("other-owner")).toBe(disarm);
    expect(arm).toHaveBeenLastCalledWith("other-owner");
  });

  it("arm 被拒（无许可返回 undefined）→ 不抛错", () => {
    installApi({
      hasLicense: () => false,
      isArmed: () => false,
      arm: () => undefined,
    });
    expect(armConfirmGate()).toBeUndefined();
  });
});

describe("远端豁免弱桥接 — 实现抛错时 fail-soft", () => {
  it("isArmed 抛错（会话替换后旧 ctx 失效）→ off，不冒泡", () => {
    installApi({
      hasLicense: () => true,
      isArmed: () => {
        throw new Error("This extension ctx is stale");
      },
      arm: vi.fn(),
    });
    expect(() => confirmGateMode()).not.toThrow();
    expect(confirmGateMode()).toBe("off");
    // 原始异常保留给调用方：用于区分「没有许可」与「接口实现抛错」（adr/0014 补充 3）。
    expect(confirmGateLastError()).toBe("This extension ctx is stale");
  });

  it("arm 抛错 → undefined，不冒泡（不能让连接流程失败）", () => {
    installApi({
      hasLicense: () => true,
      isArmed: () => true,
      arm: () => {
        throw new Error("This extension ctx is stale");
      },
    });
    expect(() => armConfirmGate()).not.toThrow();
    expect(armConfirmGate()).toBeUndefined();
  });

  it("后续结论明确（接口缺失 / 无许可）时清空陈旧异常，别把「没带标志」误报成接口抛错", () => {
    installApi({
      hasLicense: () => true,
      isArmed: () => {
        throw new Error("This extension ctx is stale");
      },
      arm: vi.fn(),
    });
    expect(confirmGateMode()).toBe("off");
    expect(confirmGateLastError()).toBe("This extension ctx is stale");

    // 接口消失：结论是「没有接口」，不是「接口实现抛错」。
    delete (globalThis as Holder).__confirmGateApi;
    expect(confirmGateMode()).toBe("off");
    expect(confirmGateLastError()).toBeUndefined();

    // 「无许可」同样早退，也要清空。
    installApi({
      hasLicense: () => true,
      isArmed: () => {
        throw new Error("stale again");
      },
      arm: vi.fn(),
    });
    expect(confirmGateMode()).toBe("off");
    expect(confirmGateLastError()).toBe("stale again");
    installApi({ hasLicense: () => false, isArmed: () => true, arm: vi.fn() });
    expect(confirmGateMode()).toBe("off");
    expect(confirmGateLastError()).toBeUndefined();
  });
});
