import { describe, it, expect } from "vitest";
import { buildHelpText, type HelpCommandEntry } from "../src/help.js";

const native: HelpCommandEntry[] = [
  { trigger: "/stop（esc）", description: "中止当前轮次" },
  { trigger: "/compact", description: "压缩上下文" },
  { trigger: "/help", description: "本命令清单" },
];

const plugin: HelpCommandEntry[] = [
  { trigger: "/summarize", description: "总结" },
];

describe("buildHelpText", () => {
  it("说明在前、命令在后，原生在透传前", () => {
    const text = buildHelpText({ timeoutSeconds: 180, native, plugin });
    const lines = text.split("\n");
    expect(lines[0]).toBe("说明：");
    expect(text.indexOf("微信端命令：")).toBeGreaterThan(
      text.indexOf("不活跃超时"),
    );
    expect(text.indexOf("/stop（esc）")).toBeGreaterThan(
      text.indexOf("微信端命令："),
    );
    expect(text.indexOf("/summarize")).toBeGreaterThan(text.indexOf("/help"));
  });

  it("动态拼接生效的超时秒数", () => {
    expect(buildHelpText({ timeoutSeconds: 300, native, plugin })).toContain(
      "当前 300 秒无进展",
    );
    expect(buildHelpText({ timeoutSeconds: 60, native, plugin })).toContain(
      "当前 60 秒无进展",
    );
  });

  it("只列出传入的命令（不自行过滤）", () => {
    const text = buildHelpText({ timeoutSeconds: 180, native: [], plugin: [] });
    expect(text).not.toContain("/stop");
    expect(text).toContain("微信端命令：");
  });

  it("含用户需知的 5 条固定限制", () => {
    const text = buildHelpText({ timeoutSeconds: 180, native, plugin });
    expect(text).toContain("纯文本回复");
    expect(text).toContain("不流式");
    expect(text).toContain("忙时排队");
    expect(text).toContain("依赖 pi 常驻");
    expect(text).toContain("媒体限制");
  });
});
