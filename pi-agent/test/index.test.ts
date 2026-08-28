import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFile, stat } from "node:fs/promises";

// ── 模块 mock ──────────────────────────────────────────────────────────
const h = vi.hoisted(() => ({ bots: [] as any[] }));

vi.mock("qrcode-terminal", () => ({ default: { generate: vi.fn() } }));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => "/fake/agent",
  CONFIG_DIR_NAME: ".pi",
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }),
  writeFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  appendFile: vi.fn(async () => {}),
  stat: vi.fn(async () => ({ isFile: () => true })),
  mkdtemp: vi.fn(async (prefix: string) => `${prefix}xyz`),
}));

vi.mock("@wechatbot/wechatbot", () => {
  class FakeWeChatBot {
    reply = vi.fn(async () => {});
    sendTyping = vi.fn(async () => {});
    stopTyping = vi.fn(async () => {});
    login = vi.fn(async () => ({ accountId: "acct1", userId: "user1" }));
    start = vi.fn(async () => {});
    stop = vi.fn(() => {});
    getCredentials = vi.fn(() => ({ accountId: "acct1", userId: "user1" }));
    onMessageCb: any;
    onMessage = vi.fn((cb: any) => {
      this.onMessageCb = cb;
    });
    on = vi.fn();
    constructor() {
      h.bots.push(this);
    }
  }
  return {
    WeChatBot: FakeWeChatBot,
    createLogger: () => ({
      child: () => ({
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    }),
    stripMarkdown: (s: string) => s,
  };
});

import wechatBridge from "../src/index.js";

// ── 假 pi / ctx ────────────────────────────────────────────────────────

type Handler = (event: any, ctx: any) => any;

function makeFakePi() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<
    string,
    { description: string; handler: (...a: any[]) => any }
  >();
  const tools: any[] = [];
  const pi: any = {
    sendUserMessage: vi.fn(async () => {}),
    getCommands: vi.fn(() => []),
    on: vi.fn((event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    registerCommand: vi.fn((name: string, opts: any) =>
      commands.set(name, opts),
    ),
    registerTool: vi.fn((tool: any) => tools.push(tool)),
  };
  return { pi, handlers, commands, tools };
}

function makeFakeCtx(overrides: any = {}): any {
  return {
    cwd: "/proj",
    ui: {
      theme: {
        fg: (_k: string, v: string) => v,
        bold: (s: string) => s,
        dim: (s: string) => s,
      },
      setStatus: vi.fn(),
      notify: vi.fn(),
      select: vi.fn(async () => "Cancel"),
      custom: vi.fn(async () => {}),
    },
    isIdle: vi.fn(() => true),
    abort: vi.fn(),
    compact: vi.fn(),
    newSession: vi.fn(async () => {}),
    sessionManager: { getEntries: vi.fn(() => []) },
    getContextUsage: vi.fn(() => undefined),
    model: undefined,
    modelRegistry: { isUsingOAuth: vi.fn(() => false) },
    ...overrides,
  };
}

function makeMsg(text: string): any {
  return {
    userId: "user1",
    text,
    type: "text",
    timestamp: new Date(),
    images: [],
    voices: [],
    files: [],
    videos: [],
    raw: {},
    _contextToken: "",
  };
}

async function connect(pi: any, commands: Map<string, any>, ctx: any) {
  wechatBridge(pi);
  await commands.get("wechat")!.handler(undefined, ctx);
}

function bot(): any {
  return h.bots[h.bots.length - 1];
}

async function fire(
  handlers: Map<string, Handler[]>,
  event: string,
  payload: any,
  ctx: any,
) {
  for (const fn of handlers.get(event) ?? []) {
    await fn(payload, ctx);
  }
}

const ENOENT = () => {
  throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
};

beforeEach(() => {
  h.bots.length = 0;
  vi.mocked(readFile).mockImplementation(async () => ENOENT());
});

afterEach(() => {
  vi.useRealTimers();
});

// ── 用例 ───────────────────────────────────────────────────────────────

describe("turn 串行化（核心链路）", () => {
  it("一次一条 in-flight，agent_settled 回复后推进队列", async () => {
    const { pi, handlers, commands } = makeFakePi();
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);
    const onMsg = bot().onMessageCb;

    const msgA = makeMsg("hello A");
    const msgB = makeMsg("hello B");

    await onMsg(msgA);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage).toHaveBeenCalledWith("[wechat] hello A", {
      deliverAs: "followUp",
    });

    await onMsg(msgB); // 忙时入队，不直接发送
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);

    await fire(
      handlers,
      "agent_end",
      {
        messages: [
          { role: "assistant", content: [{ type: "text", text: "reply A" }] },
        ],
      },
      ctx,
    );
    await fire(handlers, "agent_settled", {}, ctx);

    // 首条消息先回发欢迎语，故第 1 次 reply 是欢迎语、第 2 次才是回复 A
    expect(bot().reply).toHaveBeenNthCalledWith(2, msgA, "reply A");
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
    expect(pi.sendUserMessage).toHaveBeenLastCalledWith("[wechat] hello B", {
      deliverAs: "followUp",
    });

    await fire(
      handlers,
      "agent_end",
      {
        messages: [
          { role: "assistant", content: [{ type: "text", text: "reply B" }] },
        ],
      },
      ctx,
    );
    await fire(handlers, "agent_settled", {}, ctx);
    expect(bot().reply).toHaveBeenNthCalledWith(3, msgB, "reply B");
  });

  it("stop 中止当前轮次并把积压折叠进下一条", async () => {
    const { pi, handlers, commands } = makeFakePi();
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);
    const onMsg = bot().onMessageCb;

    await onMsg(makeMsg("hello A")); // in-flight
    await onMsg(makeMsg("hello B")); // queued
    await onMsg(makeMsg("hello C")); // queued
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);

    await fire(handlers, "agent_start", {}, ctx); // 设置 currentAbort

    const stopMsg = makeMsg("stop");
    await onMsg(stopMsg);
    expect(ctx.abort).toHaveBeenCalledTimes(1);
    expect(bot().reply).toHaveBeenCalledWith(stopMsg, "Aborted current turn.");

    // agent_settled（aborted）：静默，不推进队列（preserve 标志）
    await fire(handlers, "agent_settled", {}, ctx);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);

    await onMsg(makeMsg("hello D"));
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
    const content = pi.sendUserMessage.mock.calls[1][0];
    expect(content).toContain("hello B");
    expect(content).toContain("hello C");
    expect(content).toContain("Current WeChat message:");
    expect(content).toContain("hello D");
  });
});

describe("命令门禁", () => {
  it("默认关闭的原生命令被拒绝且不触达 pi", async () => {
    const { pi, commands } = makeFakePi();
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);
    const onMsg = bot().onMessageCb;

    const statusMsg = makeMsg("/status");
    await onMsg(statusMsg);
    expect(bot().reply).toHaveBeenCalledWith(
      statusMsg,
      "命令 /status 未在微信端启用（用 /wechat-setting 配置）。",
    );
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("豁免命令 stop 恒可用（无活动轮次时回复 No active turn）", async () => {
    const { pi, commands } = makeFakePi();
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);
    const onMsg = bot().onMessageCb;

    const stopMsg = makeMsg("stop");
    await onMsg(stopMsg);
    expect(bot().reply).toHaveBeenCalledWith(stopMsg, "No active turn.");
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("插件命令默认关闭；开启后以 expandPromptTemplates 穿透", async () => {
    const { pi, handlers, commands } = makeFakePi();
    pi.getCommands.mockReturnValue([
      { name: "review", source: "skill", description: "审阅" },
    ]);
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);
    await fire(handlers, "session_start", {}, ctx); // reloadConfig 填充 pluginSources
    const onMsg = bot().onMessageCb;

    // 默认关：拒绝
    await onMsg(makeMsg("/review"));
    expect(bot().reply).toHaveBeenCalledWith(
      expect.anything(),
      "命令 /review 未在微信端启用（用 /wechat-setting 配置）。",
    );
    expect(pi.sendUserMessage).not.toHaveBeenCalled();

    // 用户级开启 review：skill 命令作为 turn 穿透
    vi.mocked(readFile).mockImplementation(async (path: any) => {
      if (String(path).startsWith("/fake/agent")) {
        return JSON.stringify({ commands: { review: "on" } });
      }
      return JSON.stringify({});
    });
    await fire(handlers, "session_start", {}, ctx); // 重新加载配置
    const msg = makeMsg("/review");
    await onMsg(msg);
    expect(pi.sendUserMessage).toHaveBeenCalledWith("/review", {
      deliverAs: "followUp",
      expandPromptTemplates: true,
    });
  });
});

describe("不活跃超时接线", () => {
  it("超过阈值通知一次，重复推进不再通知", async () => {
    vi.useFakeTimers();
    const { pi, handlers, commands } = makeFakePi();
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);
    const onMsg = bot().onMessageCb;

    await onMsg(makeMsg("hello"));
    await fire(handlers, "agent_start", {}, ctx);

    await vi.advanceTimersByTimeAsync(180_000);
    // 第 1 次 reply 是首条消息的欢迎语，第 2 次才是超时通知
    expect(bot().reply).toHaveBeenCalledTimes(2);
    expect(bot().reply.mock.calls[1][1]).toContain("无进展");

    await vi.advanceTimersByTimeAsync(180_000);
    expect(bot().reply).toHaveBeenCalledTimes(2);
  });

  it("活动事件（message_update）重置计时", async () => {
    vi.useFakeTimers();
    const { pi, handlers, commands } = makeFakePi();
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);
    const onMsg = bot().onMessageCb;

    await onMsg(makeMsg("hello"));
    await fire(handlers, "agent_start", {}, ctx);

    await vi.advanceTimersByTimeAsync(100_000);
    await fire(
      handlers,
      "message_update",
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "progress" }],
        },
      },
      ctx,
    );
    await vi.advanceTimersByTimeAsync(100_000); // 距 touch 仅 100s
    expect(bot().reply).toHaveBeenCalledTimes(1); // 仅欢迎语，无超时通知

    await vi.advanceTimersByTimeAsync(80_000); // 距 touch 满 180s
    expect(bot().reply).toHaveBeenCalledTimes(2);
  });
});

describe("sendUserMessage 重试", () => {
  it("指数退避重试，最终失败丢弃并通知微信用户", async () => {
    vi.useFakeTimers();
    const { pi, commands } = makeFakePi();
    pi.sendUserMessage.mockRejectedValue(new Error("boom"));
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);
    const onMsg = bot().onMessageCb;

    const msg = makeMsg("hello");
    const p = onMsg(msg);
    await vi.runAllTimersAsync();
    await p;

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(4);
    expect(bot().reply).toHaveBeenCalledWith(msg, "消息处理失败：boom");
  });
});

describe("wechat_attach 工具", () => {
  it("无活动轮次时拒绝，校验文件后入队", async () => {
    const { pi, commands, tools } = makeFakePi();
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);
    const onMsg = bot().onMessageCb;
    const attach = tools.find((t) => t.name === "wechat_attach");

    // 无活动轮次
    await expect(attach.execute("id", { paths: ["/a.txt"] })).rejects.toThrow(
      "only be used while replying",
    );

    await onMsg(makeMsg("hello")); // 建立活动轮次

    // stat 返回非文件 → 拒绝
    vi.mocked(stat).mockResolvedValueOnce({ isFile: () => false } as any);
    await expect(attach.execute("id", { paths: ["/dir"] })).rejects.toThrow(
      "Not a file",
    );

    // 正常文件 → 入队
    vi.mocked(stat).mockResolvedValueOnce({ isFile: () => true } as any);
    const result = await attach.execute("id", {
      paths: ["/a.txt", "/b.txt"],
    });
    expect(result.content[0].text).toContain("2");
    expect(result.details.paths).toEqual(["/a.txt", "/b.txt"]);
  });
});

describe("agent_start 替代计时器不误报（审查 P1）", () => {
  it("auto-retry 二次 agent_start 会 disarm 旧计时器，只通知一次", async () => {
    vi.useFakeTimers();
    const { pi, handlers, commands } = makeFakePi();
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);
    const onMsg = bot().onMessageCb;

    await onMsg(makeMsg("hello"));
    await fire(handlers, "agent_start", {}, ctx); // timer1（180s）
    await vi.advanceTimersByTimeAsync(170_000);

    // auto-retry：再次 agent_start，应先 disarm timer1 再 arm timer2
    await fire(handlers, "agent_start", {}, ctx);
    await vi.advanceTimersByTimeAsync(10_000); // t=180：若未 disarm，timer1 会在此误报
    expect(bot().reply).toHaveBeenCalledTimes(1); // 仅欢迎语，timer1 未误报

    await vi.advanceTimersByTimeAsync(170_000); // t=350：timer2 到期
    expect(bot().reply).toHaveBeenCalledTimes(2);
    expect(bot().reply.mock.calls[1][1]).toContain("无进展");
  });
});

describe("扩展命令穿透错误处理（审查 P3）", () => {
  it("sendUserMessage 拒绝时向微信返回边界安全回执", async () => {
    const { pi, handlers, commands } = makeFakePi();
    pi.getCommands.mockReturnValue([
      {
        name: "extcmd",
        source: "extension",
        description: "扩展",
        sourceInfo: { path: "/fake/ext.ts" },
      },
    ]);
    vi.mocked(readFile).mockImplementation(async (path: any) => {
      const p = String(path);
      if (p.startsWith("/fake/agent"))
        return JSON.stringify({ commands: { extcmd: "on" } });
      if (p.startsWith("/proj")) return JSON.stringify({});
      return "export default function ext() {}"; // 非交互型扩展源码
    });
    pi.sendUserMessage.mockRejectedValue(new Error("dispatch boom"));
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);
    await fire(handlers, "session_start", {}, ctx); // reloadConfig 填充 pluginSources + 配置
    const onMsg = bot().onMessageCb;

    const msg = makeMsg("/extcmd");
    await onMsg(msg);
    expect(pi.sendUserMessage).toHaveBeenCalledWith("/extcmd", {
      expandPromptTemplates: true,
    });
    expect(bot().reply).toHaveBeenCalledWith(
      msg,
      "扩展命令执行失败：dispatch boom",
    );
  });

  it("交互型扩展不入 pluginSources，被当作普通消息转发", async () => {
    const { pi, handlers, commands } = makeFakePi();
    pi.getCommands.mockReturnValue([
      {
        name: "promptcmd",
        source: "extension",
        description: "弹面板",
        sourceInfo: { path: "/fake/interactive.ts" },
      },
    ]);
    vi.mocked(readFile).mockImplementation(async (path: any) => {
      const p = String(path);
      if (p.startsWith("/fake/agent")) return JSON.stringify({});
      if (p.startsWith("/proj")) return JSON.stringify({});
      return "ctx.ui.select('pick');"; // 交互型
    });
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);
    await fire(handlers, "session_start", {}, ctx);
    const onMsg = bot().onMessageCb;

    const msg = makeMsg("/promptcmd");
    await onMsg(msg);
    // 未被识别为插件命令 → 作为普通消息转发（不带 expandPromptTemplates）
    expect(pi.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("/promptcmd"),
      { deliverAs: "followUp" },
    );
    expect(bot().reply).not.toHaveBeenCalledWith(
      msg,
      expect.stringContaining("已触发扩展命令"),
    );
  });
});
