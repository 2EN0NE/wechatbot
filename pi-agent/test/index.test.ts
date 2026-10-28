import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFile, stat, writeFile, appendFile } from "node:fs/promises";

// ── 模块 mock ──────────────────────────────────────────────────────────
const h = vi.hoisted(() => ({
  bots: [] as any[],
  logCalls: [] as Array<{ level: string; event: string; data?: any }>,
}));

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
      child: () => {
        const record =
          (level: string) => (event: string, data?: any) =>
            h.logCalls.push({ level, event, data });
        return {
          info: vi.fn(record("info")),
          debug: vi.fn(record("debug")),
          warn: vi.fn(record("warn")),
          error: vi.fn(record("error")),
        };
      },
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
  // 命令级 ctx：pi 的扩展命令 handler 拿到的那个（含 newSession）。
  const commandCtx = makeFakeCtx({
    newSession: vi.fn(async () => ({ cancelled: false })),
  });
  // pi 的 sendUserMessage 是「发后不管」：签名返回 void（types.d.ts），扩展命令 handler
  // 在后台跑，失败走 runner.emitError 而非 rejection（loader.js:311）。替身必须保持这个
  // 契约，否则会掩盖依赖「派发完成」信号的交接 bug（adr/0014）。
  const commandRuns: Promise<void>[] = [];
  const pi: any = {
    sendUserMessage: vi.fn((content: any, opts?: any) => {
      // 模拟 pi 的 `_tryExecuteExtensionCommand`：expandPromptTemplates + "/name"
      // 会用**命令级 ctx**（含 newSession）执行扩展命令的 handler。
      if (!opts?.expandPromptTemplates) return;
      const text = typeof content === "string" ? content : "";
      if (!text.startsWith("/")) return;
      const name = text.slice(1).split(/\s+/)[0];
      const cmd = commands.get(name);
      if (!cmd) return;
      commandRuns.push(
        (async () => {
          await cmd.handler("", commandCtx);
        })(),
      );
    }),
    // pi 的 getCommands() 返回 invocationName（单实例时就是注册名）：桥在派发内部命令前
    // 据此确认命令可用（漏查会把 /wechat-internal-new 当普通 prompt 送给模型）。
    getCommands: vi.fn(() =>
      [...commands.keys()].map((name) => ({
        name,
        description: "",
        source: "extension",
        sourceInfo: { path: "/x/src/index.ts" },
      })),
    ),
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
  /** 等后台命令 handler 跑完（sendUserMessage 是发后不管，测试需显式等待）。 */
  const flushCommands = async (): Promise<void> => {
    while (commandRuns.length > 0) await Promise.all(commandRuns.splice(0));
  };
  return { pi, handlers, commands, tools, commandCtx, flushCommands };
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
    // 事件 ctx 没有会话控制方法（pi 1.4）：newSession 只在命令 ctx 上（见 makeFakePi.commandCtx）。
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
  h.logCalls.length = 0;
  vi.mocked(readFile).mockImplementation(async () => ENOENT());
});

afterEach(() => {
  vi.useRealTimers();
  // 远端豁免接口挂在 globalThis 上，跨用例必须清理（ADR-0014）。
  delete (globalThis as { __confirmGateApi?: unknown }).__confirmGateApi;
});

// ── 用例 ───────────────────────────────────────────────────────────────

describe("发送者白名单鉴权（ADR-0010）", () => {
  beforeEach(() => {
    vi.mocked(writeFile).mockClear();
  });

  it("首用户配对：持久化 allowedUserId 并回发欢迎语", async () => {
    const { pi, commands } = makeFakePi();
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);
    const onMsg = bot().onMessageCb;

    await onMsg(makeMsg("hello owner"));

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(bot().reply).toHaveBeenCalled(); // 欢迎语
    // saveUser 持久化 allowedUserId 到用户级 wechatbot.json
    await vi.waitFor(() => {
      expect(vi.mocked(writeFile)).toHaveBeenCalled();
    });
    const saved = vi
      .mocked(writeFile)
      .mock.calls.find((c) => String(c[0]).endsWith("wechatbot.json"));
    expect(saved).toBeTruthy();
    expect(String(saved![1])).toContain("allowedUserId");
    expect(String(saved![1])).toContain("user1");
  });

  it("未授权发送者被静默丢弃：不处理、不回复、无欢迎语", async () => {
    const { pi, handlers, commands } = makeFakePi();
    vi.mocked(readFile).mockImplementation(async () =>
      JSON.stringify({ allowedUserId: "owner" }),
    );
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);
    await fire(handlers, "session_start", {}, ctx); // reloadConfig 加载 allowedUserId
    const onMsg = bot().onMessageCb;

    const stranger = makeMsg("hello stranger");
    stranger.userId = "stranger";
    await onMsg(stranger);

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(bot().reply).not.toHaveBeenCalled();
  });

  it("白名单内的发送者正常处理", async () => {
    const { pi, handlers, commands } = makeFakePi();
    vi.mocked(readFile).mockImplementation(async () =>
      JSON.stringify({ allowedUserId: "user1" }),
    );
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);
    await fire(handlers, "session_start", {}, ctx);
    const onMsg = bot().onMessageCb;

    await onMsg(makeMsg("hello authorized"));
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("未授权发送者的命令（含豁免命令）同样被静默丢弃", async () => {
    const { pi, handlers, commands, commandCtx } = makeFakePi();
    vi.mocked(readFile).mockImplementation(async () =>
      JSON.stringify({ allowedUserId: "owner" }),
    );
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);
    await fire(handlers, "session_start", {}, ctx); // reloadConfig 加载 allowedUserId
    const onMsg = bot().onMessageCb;

    // /new 是豁免命令（恒可用、不可关闭），/status 是默认关闭原生命令——
    // 二者都应被白名单拦截，证明鉴权优先级高于命令豁免，陌生人无法以宿主权限触发命令。
    for (const text of ["/new", "/status"]) {
      const stranger = makeMsg(text);
      stranger.userId = "stranger";
      await onMsg(stranger);
    }

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(bot().reply).not.toHaveBeenCalled();
    expect(commandCtx.newSession).not.toHaveBeenCalled(); // /new 未触发会话重建
  });

  it("配对后第二个不同发送者立即被拒绝（无需等待落盘）", async () => {
    const { pi, commands } = makeFakePi();
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);
    const onMsg = bot().onMessageCb;

    await onMsg(makeMsg("hello owner")); // 未设 allowedUserId → user1 配对并持久化

    const stranger = makeMsg("hello stranger");
    stranger.userId = "stranger";
    await onMsg(stranger);

    // 配对后内存态立即锁定：仅 owner 被处理一次（另加一次欢迎语），陌生人被拒。
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(bot().reply).toHaveBeenCalledTimes(1);
  });
});

describe("桥接层薄 journal（ADR-0011）", () => {
  beforeEach(() => {
    vi.mocked(appendFile).mockClear();
  });

  it("文本消息入队前写 admitted，回复成功后写 settled", async () => {
    const { pi, handlers, commands } = makeFakePi();
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);
    const onMsg = bot().onMessageCb;

    await onMsg(makeMsg("hello journal"));

    const admitCall = vi
      .mocked(appendFile)
      .mock.calls.find(
        (c) =>
          String(c[0]).endsWith("wechat-journal.jsonl") &&
          String(c[1]).includes('"kind":"admitted"'),
      );
    expect(admitCall).toBeTruthy();
    expect(String(admitCall![1])).toContain("hello journal");

    await fire(
      handlers,
      "agent_end",
      {
        messages: [
          { role: "assistant", content: [{ type: "text", text: "reply" }] },
        ],
      },
      ctx,
    );
    await fire(handlers, "agent_settled", {}, ctx);

    const settleCall = vi
      .mocked(appendFile)
      .mock.calls.find(
        (c) =>
          String(c[0]).endsWith("wechat-journal.jsonl") &&
          String(c[1]).includes('"kind":"settled"'),
      );
    expect(settleCall).toBeTruthy();
  });

  it("重连后回放未结算的文本 turn，不触发欢迎语", async () => {
    const { pi, commands } = makeFakePi();
    vi.mocked(readFile).mockImplementation(async (path: any) => {
      const p = String(path);
      if (p.endsWith("wechat-journal.jsonl")) {
        return (
          JSON.stringify({
            kind: "admitted",
            turnId: "t1",
            userId: "user1",
            text: "replayed hello",
            type: "text",
            contextToken: "ct",
            timestamp: "",
          }) + "\n"
        );
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage).toHaveBeenCalledWith("[wechat] replayed hello", {
      deliverAs: "followUp",
    });
    expect(bot().reply).not.toHaveBeenCalled();
  });

  it("会话关闭后 in-flight turn 不写 settled，留待重连回放", async () => {
    const { pi, handlers, commands } = makeFakePi();
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);
    const onMsg = bot().onMessageCb;

    await onMsg(makeMsg("hello before crash")); // admit + in-flight，尚未 settle

    // 模拟崩溃/会话关闭：shutdownBot 清空 activeTurn 与 pendingTurns，但不结算 journal。
    await fire(handlers, "session_shutdown", {}, ctx);

    // in-flight turn 未被结算：journal 保留「有 admitted 无 settled」，供重连回放。
    const settled = vi
      .mocked(appendFile)
      .mock.calls.some(
        (c) =>
          String(c[0]).endsWith("wechat-journal.jsonl") &&
          String(c[1]).includes('"kind":"settled"'),
      );
    expect(settled).toBe(false);
  });

  it("回复发送失败不写 settled，留待崩溃回放（P1 回归）", async () => {
    const { pi, handlers, commands } = makeFakePi();
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);
    const onMsg = bot().onMessageCb;

    await onMsg(makeMsg("hello reply-fail")); // 配对 + 欢迎语 + admit + in-flight

    // 之后让回复发送（bot.reply）失败一次，模拟网络故障。
    bot().reply.mockRejectedValueOnce(new Error("network down"));

    await fire(
      handlers,
      "agent_end",
      {
        messages: [
          { role: "assistant", content: [{ type: "text", text: "reply" }] },
        ],
      },
      ctx,
    );
    await fire(handlers, "agent_settled", {}, ctx);

    // 回发失败：不写 settled，admitted 仍在，崩溃回放会重新处理（至少一次）。
    const settled = vi
      .mocked(appendFile)
      .mock.calls.some(
        (c) =>
          String(c[0]).endsWith("wechat-journal.jsonl") &&
          String(c[1]).includes('"kind":"settled"'),
      );
    expect(settled).toBe(false);
  });
});

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
    vi.mocked(appendFile).mockClear();
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

    // 折叠的 B/C 与 aborted 的 A 均写 settled（终结路径全覆盖，adr/0011）。
    const settleCalls = vi
      .mocked(appendFile)
      .mock.calls.filter(
        (c) =>
          String(c[0]).endsWith("wechat-journal.jsonl") &&
          String(c[1]).includes('"kind":"settled"'),
      );
    expect(settleCalls).toHaveLength(3);
  });

  it("agent_end 多次触发只回复一次，取最后一次 summary", async () => {
    const { pi, handlers, commands } = makeFakePi();
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);
    const onMsg = bot().onMessageCb;

    const msg = makeMsg("hello");
    await onMsg(msg);

    await fire(
      handlers,
      "agent_end",
      {
        messages: [
          { role: "assistant", content: [{ type: "text", text: "partial A" }] },
        ],
      },
      ctx,
    );
    await fire(
      handlers,
      "agent_end",
      {
        messages: [
          { role: "assistant", content: [{ type: "text", text: "final B" }] },
        ],
      },
      ctx,
    );
    await fire(handlers, "agent_settled", {}, ctx);

    expect(bot().reply).toHaveBeenCalledWith(msg, "final B");
    const finalReplies = bot().reply.mock.calls.filter(
      (c: any[]) => c[1] === "final B",
    );
    expect(finalReplies).toHaveLength(1);
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
    vi.mocked(appendFile).mockClear();
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

    // 最终失败也写 settled，避免崩溃回放无限重试同一条已终结 turn（adr/0011）。
    const settleCall = vi
      .mocked(appendFile)
      .mock.calls.find(
        (c) =>
          String(c[0]).endsWith("wechat-journal.jsonl") &&
          String(c[1]).includes('"kind":"settled"'),
      );
    expect(settleCall).toBeTruthy();
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

  it("附件超过上限时拒绝", async () => {
    const { pi, commands, tools } = makeFakePi();
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);
    const onMsg = bot().onMessageCb;
    const attach = tools.find((t) => t.name === "wechat_attach");

    await onMsg(makeMsg("hello")); // 建立活动轮次
    vi.mocked(stat).mockResolvedValue({ isFile: () => true } as any);

    const ten = Array.from({ length: 10 }, (_, i) => `/a${i + 1}.txt`);
    await attach.execute("id", { paths: ten });

    await expect(
      attach.execute("id", { paths: ["/overflow.txt"] }),
    ).rejects.toThrow("Attachment limit reached");
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

describe("桥指标与 journal 可见性（ADR-0013）", () => {
  it("文本 turn 准入后记 journal admitted 事件（含 turnId / userId / depth）", async () => {
    const { pi, commands } = makeFakePi();
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);
    const onMsg = bot().onMessageCb;

    await onMsg(makeMsg("hello counters"));

    const admitted = h.logCalls.find((c) => c.event === "journal admitted");
    expect(admitted).toBeTruthy();
    expect(typeof admitted!.data.turnId).toBe("string");
    expect(admitted!.data.userId).toBe("user1");
    expect(admitted!.data.depth).toBe(0);
  });

  it("轮次终结后记 journal settled 事件（含 turnId）", async () => {
    const { pi, handlers, commands } = makeFakePi();
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);
    const onMsg = bot().onMessageCb;

    await onMsg(makeMsg("hello settle"));
    await fire(
      handlers,
      "agent_end",
      {
        messages: [
          { role: "assistant", content: [{ type: "text", text: "ok" }] },
        ],
      },
      ctx,
    );
    await fire(handlers, "agent_settled", {}, ctx);

    const settled = h.logCalls.find((c) => c.event === "journal settled");
    expect(settled).toBeTruthy();
    expect(typeof settled!.data.turnId).toBe("string");
  });

  it("/status 追加桥侧计数行，只列非零项", async () => {
    const { pi, handlers, commands } = makeFakePi();
    vi.mocked(readFile).mockImplementation(async (path: any) => {
      if (String(path).endsWith("wechatbot.json")) {
        return JSON.stringify({ commands: { status: "on" } });
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);
    await fire(handlers, "session_start", {}, ctx);
    const onMsg = bot().onMessageCb;

    // 先跑完一轮，让 admitted / settled 计数非零
    await onMsg(makeMsg("hello status"));
    await fire(
      handlers,
      "agent_end",
      {
        messages: [
          { role: "assistant", content: [{ type: "text", text: "ok" }] },
        ],
      },
      ctx,
    );
    await fire(handlers, "agent_settled", {}, ctx);

    const statusMsg = makeMsg("/status");
    await onMsg(statusMsg);

    const statusReply = vi
      .mocked(bot().reply)
      .mock.calls.find((c: any[]) => c[0] === statusMsg);
    expect(statusReply).toBeTruthy();
    expect(String(statusReply![1])).toContain("Bridge: admitted 1 · settled 1");
  });

  it("回放进来的 turn 计入 replayed", async () => {
    vi.mocked(readFile).mockImplementation(async (path: any) => {
      const p = String(path);
      if (p.endsWith("wechat-journal.jsonl")) {
        return `${JSON.stringify({
          kind: "admitted",
          turnId: "t-replay",
          userId: "user1",
          text: "replayed hello",
          type: "text",
          contextToken: "ct",
          timestamp: "",
        })}\n`;
      }
      if (p.endsWith("wechatbot.json")) {
        return JSON.stringify({ commands: { status: "on" } });
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const { pi, handlers, commands } = makeFakePi();
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx); // 连接即回放
    await fire(handlers, "session_start", {}, ctx); // 加载 commands.status=on

    const statusMsg = makeMsg("/status");
    await bot().onMessageCb(statusMsg);
    const statusReply = vi
      .mocked(bot().reply)
      .mock.calls.filter((c: any[]) => c[0] === statusMsg)
      .at(-1); // 首个入站消息会先收到欢迎语，/status 的回执在最后
    expect(String(statusReply![1])).toContain("replayed 1");
  });
});

describe("桥指标：dropped / stalled 接线（ADR-0013）", () => {
  /** 启用 /status，并让配置读取与 journal 读取互不干扰。 */
  function mockStatusEnabled(): void {
    vi.mocked(readFile).mockImplementation(async (path: any) => {
      if (String(path).endsWith("wechatbot.json")) {
        return JSON.stringify({ commands: { status: "on" } });
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
  }

  async function askStatus(onMsg: any): Promise<string> {
    const statusMsg = makeMsg("/status");
    await onMsg(statusMsg);
    const reply = vi
      .mocked(bot().reply)
      .mock.calls.find((c: any[]) => c[0] === statusMsg);
    return String(reply![1]);
  }

  it("不活跃超时触发后 /status 计入 stalled", async () => {
    vi.useFakeTimers();
    mockStatusEnabled();
    const { pi, handlers, commands } = makeFakePi();
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);
    await fire(handlers, "session_start", {}, ctx);
    const onMsg = bot().onMessageCb;

    await onMsg(makeMsg("hello stall"));
    await fire(handlers, "agent_start", {}, ctx);
    await vi.advanceTimersByTimeAsync(180_000);

    expect(await askStatus(onMsg)).toContain("stalled 1");
  });

  it("sendUserMessage 重试耗尽后 /status 计入 dropped", async () => {
    vi.useFakeTimers();
    mockStatusEnabled();
    const { pi, handlers, commands } = makeFakePi();
    pi.sendUserMessage.mockRejectedValue(new Error("boom"));
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);
    await fire(handlers, "session_start", {}, ctx);
    const onMsg = bot().onMessageCb;

    const sending = onMsg(makeMsg("hello drop"));
    await vi.advanceTimersByTimeAsync(8_000); // 1s + 2s + 4s 退避
    await sending;

    expect(await askStatus(onMsg)).toContain("dropped 1");
  });

  it("积压越过阈值记 queued turns rising，队列清空后记 queued turns drained", async () => {
    const { pi, handlers, commands } = makeFakePi();
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);
    const onMsg = bot().onMessageCb;

    // m1 立刻成为 active turn，m2–m5 排队 → 深度 4，越过阈值 3
    for (const text of ["m1", "m2", "m3", "m4", "m5"]) {
      await onMsg(makeMsg(text));
    }

    const rising = h.logCalls.find((c) => c.event === "queued turns rising");
    expect(rising).toBeTruthy();
    expect(rising!.level).toBe("warn");
    expect(rising!.data.threshold).toBe(3);
    expect(rising!.data.depth).toBeGreaterThan(3);

    // 逐个推进队列直至清空
    for (let i = 0; i < 5; i++) await fire(handlers, "agent_settled", {}, ctx);

    expect(
      h.logCalls.some((c) => c.event === "queued turns drained"),
    ).toBe(true);
  });

  it("skill 命令入队也观测深度：越过阈值记 queued turns rising", async () => {
    const { pi, handlers, commands } = makeFakePi();
    pi.getCommands.mockReturnValue([
      { name: "review", source: "skill", description: "审阅" },
    ]);
    vi.mocked(readFile).mockImplementation(async (path: any) => {
      if (String(path).startsWith("/fake/agent")) {
        return JSON.stringify({ commands: { review: "on" } });
      }
      return JSON.stringify({});
    });
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);
    await fire(handlers, "session_start", {}, ctx); // 填充 pluginSources
    const onMsg = bot().onMessageCb;

    await onMsg(makeMsg("hello active")); // 占住 active turn
    for (let i = 0; i < 4; i++) await onMsg(makeMsg("/review")); // 深度 1→4

    const rising = h.logCalls.find((c) => c.event === "queued turns rising");
    expect(rising).toBeTruthy();
    expect(rising!.data.depth).toBe(4);
  });

  it("断开清空积压时记 queued turns drained（不留 rising 无 drained）", async () => {
    const { pi, handlers, commands } = makeFakePi();
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);
    const onMsg = bot().onMessageCb;

    for (const text of ["m1", "m2", "m3", "m4", "m5"]) {
      await onMsg(makeMsg(text));
    }
    expect(h.logCalls.some((c) => c.event === "queued turns rising")).toBe(true);

    await fire(handlers, "session_shutdown", {}, ctx);

    const drained = h.logCalls.find((c) => c.event === "queued turns drained");
    expect(drained).toBeTruthy();
    expect(drained!.data.depth).toBe(0);
  });
});

describe("journal 写盘失败时不谎报成功（ADR-0013）", () => {
  /** 只让 journal 的写入失败，日志 transport 的 appendFile 照常吞掉。 */
  function failJournalWrites(match: (data: string) => boolean): void {
    vi.mocked(appendFile).mockImplementation(async (p: any, data: any) => {
      if (String(p).endsWith("wechat-journal.jsonl") && match(String(data))) {
        throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
      }
    });
  }

  afterEach(() => {
    vi.mocked(appendFile).mockImplementation(async () => {});
  });

  it("admit 写入失败：不记 journal admitted，失败由 journal error 上报", async () => {
    failJournalWrites(() => true);
    const { pi, commands } = makeFakePi();
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);

    await bot().onMessageCb(makeMsg("hello no journal"));

    expect(h.logCalls.some((c) => c.event === "journal admitted")).toBe(false);
    expect(h.logCalls.some((c) => c.event === "journal error")).toBe(true);
    // 准入落盘失败不阻断投递（尽力而为），turn 仍然交给 pi
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("settle 写入失败：不记 journal settled，失败由 journal error 上报", async () => {
    failJournalWrites((data) => data.includes('"kind":"settled"'));
    const { pi, handlers, commands } = makeFakePi();
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);
    const onMsg = bot().onMessageCb;

    await onMsg(makeMsg("hello settle fail"));
    await fire(
      handlers,
      "agent_end",
      {
        messages: [
          { role: "assistant", content: [{ type: "text", text: "ok" }] },
        ],
      },
      ctx,
    );
    await fire(handlers, "agent_settled", {}, ctx);

    expect(h.logCalls.some((c) => c.event === "journal admitted")).toBe(true);
    expect(h.logCalls.some((c) => c.event === "journal settled")).toBe(false);
    expect(h.logCalls.some((c) => c.event === "journal error")).toBe(true);
  });
});

// ── 远端豁免接线（ADR-0014）──────────────────────────────────────────────

interface FakeConfirmGate {
  hasLicense: ReturnType<typeof vi.fn>;
  isArmed: ReturnType<typeof vi.fn>;
  arm: ReturnType<typeof vi.fn>;
  disarm: ReturnType<typeof vi.fn>;
}

function installFakeConfirmGate(
  overrides: { licensed?: boolean; armed?: boolean } = {},
): FakeConfirmGate {
  const disarm = vi.fn();
  const gate: FakeConfirmGate = {
    hasLicense: vi.fn(() => overrides.licensed ?? true),
    isArmed: vi.fn(() => overrides.armed ?? true),
    arm: vi.fn(() => (overrides.licensed === false ? undefined : disarm)),
    disarm,
  };
  (globalThis as { __confirmGateApi?: unknown }).__confirmGateApi = {
    hasLicense: gate.hasLicense,
    isArmed: gate.isArmed,
    owners: () => ["wechat"],
    arm: gate.arm,
    status: () => ({
      license: overrides.licensed ?? true,
      armed: overrides.armed ?? true,
      owners: ["wechat"],
      mode: overrides.armed === false ? "licensed-idle" : "armed",
    }),
  };
  return gate;
}

function replyTexts(): string[] {
  return vi.mocked(bot().reply).mock.calls.map((c: any[]) => String(c[1]));
}

describe("远端豁免接线（ADR-0014）", () => {
  it("连接就绪即 arm('wechat')，会话关闭即 disarm（幂等）", async () => {
    const gate = installFakeConfirmGate();
    const { pi, handlers, commands } = makeFakePi();
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);

    expect(gate.arm).toHaveBeenCalledWith("wechat");
    expect(gate.disarm).not.toHaveBeenCalled();

    await fire(handlers, "session_shutdown", {}, ctx);
    expect(gate.disarm).toHaveBeenCalledTimes(1);
  });

  it("无豁免接口时连接照常成功（fail-soft，不 arm 也不抛错）", async () => {
    const { pi, commands } = makeFakePi();
    const ctx = makeFakeCtx();
    await expect(connect(pi, commands, ctx)).resolves.toBeUndefined();
    expect(bot()).toBeTruthy();
  });

  it("登录中重复 /wechat 不会泄漏豁免占用：arm 次数与 disarm 次数配平", async () => {
    const gate = installFakeConfirmGate();
    const { pi, handlers, commands } = makeFakePi();
    const ctx = makeFakeCtx();
    wechatBridge(pi);
    const startWechat = commands.get("wechat")!;

    // 两个 startWechat 并发在飞行中（connected 仍为 false，两次都会走到 arm）。
    await Promise.all([
      startWechat.handler(undefined, ctx),
      startWechat.handler(undefined, ctx),
    ]);
    expect(gate.arm).toHaveBeenCalledTimes(2);
    // 第二次占用前先释放第一次的解除函数，否则 selector 引用计数泄漏、永久 armed。
    expect(gate.disarm).toHaveBeenCalledTimes(1);

    await fire(handlers, "session_shutdown", {}, ctx);
    expect(gate.disarm).toHaveBeenCalledTimes(2);
  });

  it("解除函数抛错（selector 侧 stale ctx）不打断关闭流程：先摘引用再调用，不重放坏引用", async () => {
    const gate = installFakeConfirmGate();
    gate.disarm.mockImplementation(() => {
      throw new Error("This extension ctx is stale after session replacement or reload.");
    });
    const { pi, handlers, commands } = makeFakePi();
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);
    const activeBot = bot();

    await expect(fire(handlers, "session_shutdown", {}, ctx)).resolves.toBeUndefined();

    expect(activeBot.stop).toHaveBeenCalledTimes(1);
    expect(gate.disarm).toHaveBeenCalledTimes(1);
    expect(h.logCalls.some((c) => c.event === "confirm gate disarm failed")).toBe(true);

    // 引用已摘除：再次关闭不会重放同一个坏解除函数（否则 selector 侧引用计数永不递减）。
    await fire(handlers, "session_shutdown", {}, ctx);
    expect(gate.disarm).toHaveBeenCalledTimes(1);
  });

  it("接口探测抛错：拒绝回执指出接口异常，而不是误导为「没带启动参数」", async () => {
    installFakeConfirmGate();
    (globalThis as { __confirmGateApi?: any }).__confirmGateApi.isArmed = () => {
      throw new Error("This extension ctx is stale after session replacement or reload.");
    };
    const { pi, commands } = makeFakePi();
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);

    await bot().onMessageCb(makeMsg("/new"));

    const refusal = replyTexts().find((t) =>
      t.includes("a TUI confirmation prompt would block it"),
    );
    expect(refusal).toContain("the confirm-gate API raised");
    expect(refusal).toContain("This extension ctx is stale");
    expect(refusal).not.toContain("Start pi with --unattended-confirm");
  });

  it("未 armed：/new 直接回执拒绝，不触达 ctx.newSession（不挂起）", async () => {
    const gate = installFakeConfirmGate({ licensed: false, armed: false });
    const { pi, commands, commandCtx } = makeFakePi();
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);
    expect(gate.arm).toHaveBeenCalledWith("wechat"); // 被拒 → 不占用

    await bot().onMessageCb(makeMsg("/new"));

    expect(commandCtx.newSession).not.toHaveBeenCalled();
    expect(
      replyTexts().some((t) => t.includes("a TUI confirmation prompt would block it")),
    ).toBe(true);
  });

  it("armed + 被扩展取消：回执 cancel，且不残留重连标志（session_start 不重建 bot）", async () => {
    installFakeConfirmGate();
    const { pi, handlers, commands, commandCtx, flushCommands } = makeFakePi();
    commandCtx.newSession.mockResolvedValue({ cancelled: true });
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);

    await bot().onMessageCb(makeMsg("/new"));
    await flushCommands(); // 派发是发后不管，命令 handler 在后台跑
    expect(commandCtx.newSession).toHaveBeenCalledTimes(1);
    expect(replyTexts().some((t) => t.includes("New session cancelled"))).toBe(true);

    // 若 restartAfterReplace 残留，session_start 会重连并新建 bot —— 必须没有。
    const botsBefore = h.bots.length;
    await fire(handlers, "session_start", {}, ctx);
    expect(h.bots.length).toBe(botsBefore);
  });

  it("armed + 会话替换成功：session_start 自动重连并补发 ack", async () => {
    installFakeConfirmGate();
    const { pi, handlers, commands, commandCtx, flushCommands } = makeFakePi();
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);
    const botsBefore = h.bots.length;

    await bot().onMessageCb(makeMsg("/new"));
    await flushCommands(); // 派发是发后不管，命令 handler 在后台跑
    // 真实顺序：session_before_switch → session_shutdown（旧实例停 bot）→ session_start（重连）
    await fire(handlers, "session_shutdown", {}, ctx);
    await fire(handlers, "session_start", {}, ctx);

    expect(h.bots.length).toBe(botsBefore + 1);
    expect(
      replyTexts().some((t) => t.includes("New session started")),
    ).toBe(true);
  });
});

// ── 会话替换后不得再用旧 ctx（pi 1.4 契约）───────────────────────────────

describe("会话替换后的 stale ctx（ADR-0014 回归）", () => {
  it("arm() 抛 stale 错（selector 旧 ctx）时连接照常成功，且不误报 Login failed", async () => {
    const gate = installFakeConfirmGate();
    gate.arm.mockImplementation(() => {
      throw new Error("This extension ctx is stale after session replacement or reload.");
    });
    const { pi, commands } = makeFakePi();
    const ctx = makeFakeCtx();

    await expect(connect(pi, commands, ctx)).resolves.toBeUndefined();
    expect(bot()).toBeTruthy();
    expect(
      vi.mocked(ctx.ui.notify).mock.calls.some((c: any[]) =>
        String(c[0]).includes("Login failed"),
      ),
    ).toBe(false);
  });

  it("/new 由内部命令的 fresh 命令 ctx 执行：事件 ctx 无 newSession 且替换后失效也不影响", async () => {
    installFakeConfirmGate();
    let stale = false;
    const ctx = makeFakeCtx();
    const ui = ctx.ui;
    Object.defineProperty(ctx, "ui", {
      configurable: true,
      get() {
        if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
        return ui;
      },
    });

    const { pi, handlers, commands, commandCtx, flushCommands } = makeFakePi();
    // 核心回归：事件 ctx 根本没有 newSession（pi 1.4 只在命令 ctx 上提供）。
    expect(ctx.newSession).toBeUndefined();
    // 最坏时序：派发那一刻起旧 ctx 即视为失效（pi 可能在派发后任意时刻完成替换）。
    // 因此派发后任何 ctx 访问都会被本用例的 ui getter 抓到并 reject。
    const send = vi.mocked(pi.sendUserMessage);
    const dispatchInBackground = send.getMockImplementation()!;
    send.mockImplementation((content: any, opts?: any) => {
      dispatchInBackground(content, opts);
      stale = true;
    });
    await connect(pi, commands, ctx);
    const botsBefore = h.bots.length;

    // 派发 /new 后不得再访问 ctx：若 dispatchMessage 仍 updateStatus(ctx)，这里就会 reject。
    await bot().onMessageCb(makeMsg("/new"));
    await flushCommands(); // 派发是发后不管，命令 handler 在后台跑
    expect(commandCtx.newSession).toHaveBeenCalledTimes(1);

    // 真实顺序：session_shutdown（旧实例停 bot）→ session_start（新 ctx 重连并补发 ack）
    await fire(handlers, "session_shutdown", {}, ctx);
    await fire(handlers, "session_start", {}, makeFakeCtx());
    expect(h.bots.length).toBe(botsBefore + 1);
    expect(replyTexts().some((t) => t.includes("New session started"))).toBe(true);
  });
});

// ── 内部 /new 命令（adr/0014）───────────────────────────────────────────

describe("内部 /new 命令（adr/0014）", () => {
  it("无待处理微信请求时直接调用：只 notify，不替换会话（防 TUI 误触）", async () => {
    installFakeConfirmGate();
    const { pi, commands, commandCtx } = makeFakePi();
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);

    const cmd = commands.get("wechat-internal-new");
    expect(cmd).toBeTruthy();
    await cmd!.handler("", commandCtx);

    expect(commandCtx.newSession).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(commandCtx.ui.notify)
        .mock.calls.some((c: any[]) => String(c[0]).includes("仅由微信桥调用")),
    ).toBe(true);
  });

  it("派发未被执行的残留请求过期后丢弃：不替换会话、只回执提示日志", async () => {
    installFakeConfirmGate();
    const { pi, commands, commandCtx } = makeFakePi();
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);

    // 模拟「sendUserMessage 吞掉了派发」：命令 handler 从未执行，pendingNewRequest 残留。
    vi.mocked(pi.sendUserMessage).mockImplementation(() => {});
    vi.useFakeTimers();
    const sent = bot().onMessageCb(makeMsg("/new"));
    await vi.advanceTimersByTimeAsync(0);
    await sent;

    // 派发点已回执「已受理」：即使 handler 永不执行，用户也不会「发了 /new 没反应」。
    expect(replyTexts().some((t) => t.includes("Starting a new session"))).toBe(true);
    expect(commandCtx.newSession).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(31_000);
    await commands.get("wechat-internal-new")!.handler("", commandCtx);

    expect(commandCtx.newSession).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(commandCtx.ui.notify)
        .mock.calls.some((c: any[]) => String(c[0]).includes("仅由微信桥调用")),
    ).toBe(true);
    expect(
      h.logCalls.some((c) => c.event === "internal /new invoked without a live WeChat request"),
    ).toBe(true);
  });

  it("内部命令未被以本名注册（被重名消歧）→ 拒绝且不派发，不把内部命令当 prompt 送给模型", async () => {
    installFakeConfirmGate();
    const { pi, commands } = makeFakePi();
    const ctx = makeFakeCtx();
    // 模拟 pi 的重名消歧：注册名变成 wechat-internal-new:1，本名不再存在。
    pi.getCommands.mockReturnValue([
      {
        name: "wechat-internal-new:1",
        source: "extension",
        description: "",
        sourceInfo: { path: "/x/src/index.ts" },
      },
    ]);
    await connect(pi, commands, ctx);

    await bot().onMessageCb(makeMsg("/new"));

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(replyTexts().some((t) => t.includes("is not registered"))).toBe(true);
    expect(
      h.logCalls.some((c) => c.event === "internal command unavailable — refusing /new"),
    ).toBe(true);
  });

  it("连续两条 /new：拒绝后一条，不覆盖在飞请求", async () => {
    installFakeConfirmGate();
    const { pi, commands } = makeFakePi();
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);
    // 第一条派发后 handler 尚未执行（真实契约：发后不管）。
    vi.mocked(pi.sendUserMessage).mockImplementation(() => {});

    await bot().onMessageCb(makeMsg("/new"));
    await bot().onMessageCb(makeMsg("/new"));

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(replyTexts().some((t) => t.includes("already in progress"))).toBe(true);
  });

  it("不出现在 /help 的命令清单里", async () => {
    const { pi, handlers, commands } = makeFakePi();
    pi.getCommands.mockReturnValue([
      {
        name: "wechat-internal-new",
        source: "extension",
        description: "（内部）微信桥专用 /new 通道",
        sourceInfo: { path: "/x/src/index.ts" },
      },
    ]);
    const ctx = makeFakeCtx();
    await connect(pi, commands, ctx);
    await fire(handlers, "session_start", {}, ctx);

    await bot().onMessageCb(makeMsg("/help"));
    expect(replyTexts().join("\n")).not.toContain("wechat-internal-new");
  });
});
