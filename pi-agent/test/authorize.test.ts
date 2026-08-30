// 发送者白名单鉴权纯逻辑测试（adr/0010）。
import { describe, it, expect } from "vitest";
import { authorizationState } from "../src/authorize.js";

describe("authorizationState", () => {
  it("未设 allowedUserId → 首用户配对", () => {
    expect(authorizationState("wxid_1", undefined)).toEqual({
      kind: "pair",
      userId: "wxid_1",
    });
  });

  it("匹配 allowedUserId → 放行", () => {
    expect(authorizationState("wxid_1", "wxid_1")).toEqual({ kind: "allow" });
  });

  it("不匹配 → 拒绝", () => {
    expect(authorizationState("stranger", "wxid_1")).toEqual({ kind: "deny" });
  });
});
