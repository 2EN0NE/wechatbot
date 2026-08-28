import { describe, it, expect } from "vitest";
import {
  classifyCommand,
  nativeCommandById,
  NATIVE_COMMANDS,
  type PluginSource,
} from "../src/commands.js";

const SOURCES = new Map<string, PluginSource>([
  ["skill:review", "skill"],
  ["summarize", "prompt"],
  ["wechat-foo", "extension"],
]);

describe("classifyCommand", () => {
  it("detects stop with slash, bare, and esc aliases", () => {
    expect(classifyCommand("stop", SOURCES)).toEqual({
      kind: "native",
      id: "stop",
    });
    expect(classifyCommand("/stop", SOURCES)).toEqual({
      kind: "native",
      id: "stop",
    });
    expect(classifyCommand("esc", SOURCES)).toEqual({
      kind: "native",
      id: "stop",
    });
    expect(classifyCommand("/esc", SOURCES)).toEqual({
      kind: "native",
      id: "stop",
    });
  });

  it("is case-insensitive and trims", () => {
    expect(classifyCommand("  STOP  ", SOURCES).kind).toBe("native");
    expect(classifyCommand("  /Compact", SOURCES)).toEqual({
      kind: "native",
      id: "compact",
    });
  });

  it("detects native commands with slash only (new)", () => {
    expect(classifyCommand("/new", SOURCES)).toEqual({
      kind: "native",
      id: "new",
    });
    // 裸 new 不应触发，避免聊天中误判
    expect(classifyCommand("new", SOURCES).kind).toBe("message");
  });

  it("detects skill / prompt / extension plugin commands", () => {
    expect(classifyCommand("/skill:review args", SOURCES)).toEqual({
      kind: "plugin",
      name: "skill:review",
      source: "skill",
      raw: "/skill:review args",
    });
    expect(classifyCommand("/summarize this", SOURCES)).toEqual({
      kind: "plugin",
      name: "summarize",
      source: "prompt",
      raw: "/summarize this",
    });
    expect(classifyCommand("/wechat-foo", SOURCES)).toEqual({
      kind: "plugin",
      name: "wechat-foo",
      source: "extension",
      raw: "/wechat-foo",
    });
  });

  it("treats unknown slash text as a plain message", () => {
    expect(classifyCommand("/unknown-cmd", SOURCES)).toEqual({
      kind: "message",
      raw: "/unknown-cmd",
    });
    expect(classifyCommand("/etc/hosts", SOURCES)).toEqual({
      kind: "message",
      raw: "/etc/hosts",
    });
  });

  it("returns message for a normal message", () => {
    expect(classifyCommand("hello there", SOURCES)).toEqual({
      kind: "message",
      raw: "hello there",
    });
    expect(classifyCommand("", SOURCES)).toEqual({
      kind: "message",
      raw: "",
    });
  });
});

describe("NATIVE_COMMANDS", () => {
  it("marks stop / compact / new as exempt", () => {
    expect(nativeCommandById("stop").exempt).toBe(true);
    expect(nativeCommandById("compact").exempt).toBe(true);
    expect(nativeCommandById("new").exempt).toBe(true);
  });

  it("does not mark status / help as exempt", () => {
    expect(nativeCommandById("status").exempt).toBe(false);
    expect(nativeCommandById("help").exempt).toBe(false);
  });

  it("lists six native commands", () => {
    expect(NATIVE_COMMANDS.map((c) => c.id).sort()).toEqual([
      "compact",
      "help",
      "new",
      "status",
      "stop",
    ]);
  });
});
