import { describe, it, expect } from "vitest";
import {
  WECHAT_PREFIX,
  ERROR_FALLBACK,
  extractAssistantText,
  replyActionFor,
  deriveStatus,
  withWechatPrefix,
  piContentToText,
  foldQueuedTurns,
  isWechatPrompt,
  systemPromptSuffix,
  formatTokens,
  textPreviewFor,
  gracefulStop,
} from "../src/bridge-state.js";

describe("extractAssistantText", () => {
  it("returns an empty summary for an empty message list", () => {
    expect(extractAssistantText([])).toEqual({});
  });

  it("skips non-assistant messages", () => {
    expect(
      extractAssistantText([
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ]),
    ).toEqual({});
  });

  it("returns the last assistant message text", () => {
    const messages = [
      { role: "assistant", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "second" }] },
    ];
    expect(extractAssistantText(messages).text).toBe("second");
  });

  it("joins multiple text blocks", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "hello " },
          { type: "text", text: "world" },
          { type: "toolCall", name: "x" },
        ],
      },
    ];
    expect(extractAssistantText(messages).text).toBe("hello world");
  });

  it("captures stopReason and errorMessage", () => {
    const messages = [
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "boom",
        content: [],
      },
    ];
    expect(extractAssistantText(messages)).toEqual({
      text: undefined,
      stopReason: "error",
      errorMessage: "boom",
    });
  });
});

describe("replyActionFor", () => {
  it("is silent on aborted", () => {
    expect(replyActionFor({ stopReason: "aborted", text: "partial" })).toEqual({
      kind: "aborted",
    });
  });

  it("returns the errorMessage on error", () => {
    expect(
      replyActionFor({ stopReason: "error", errorMessage: "network down" }),
    ).toEqual({
      kind: "error",
      text: "network down",
    });
  });

  it("falls back when error has no message", () => {
    expect(replyActionFor({ stopReason: "error" })).toEqual({
      kind: "error",
      text: ERROR_FALLBACK,
    });
  });

  it("replies with text on normal completion", () => {
    expect(replyActionFor({ stopReason: "stop", text: "all done" })).toEqual({
      kind: "reply",
      text: "all done",
    });
  });

  it("is silent when normal completion has no text", () => {
    expect(replyActionFor({ stopReason: "stop" })).toEqual({ kind: "silent" });
  });
});

describe("deriveStatus", () => {
  it("reports error above everything", () => {
    expect(
      deriveStatus({
        connected: true,
        connecting: false,
        active: false,
        queuedCount: 0,
        error: "x",
      }),
    ).toEqual({
      kind: "error",
      message: "x",
    });
  });

  it("reports connecting during login", () => {
    expect(
      deriveStatus({
        connected: false,
        connecting: true,
        active: false,
        queuedCount: 0,
      }),
    ).toEqual({
      kind: "connecting",
    });
  });

  it("reports disconnected before connected", () => {
    expect(
      deriveStatus({
        connected: false,
        connecting: false,
        active: false,
        queuedCount: 0,
      }),
    ).toEqual({
      kind: "disconnected",
    });
  });

  it("reports processing with queue count when a turn is active", () => {
    expect(
      deriveStatus({
        connected: true,
        connecting: false,
        active: true,
        queuedCount: 0,
      }),
    ).toEqual({
      kind: "processing",
      queued: 0,
    });
  });

  it("reports processing +N queued when idle but queue is non-empty", () => {
    expect(
      deriveStatus({
        connected: true,
        connecting: false,
        active: false,
        queuedCount: 3,
      }),
    ).toEqual({
      kind: "processing",
      queued: 3,
    });
  });

  it("reports connected when idle with empty queue", () => {
    expect(
      deriveStatus({
        connected: true,
        connecting: false,
        active: false,
        queuedCount: 0,
      }),
    ).toEqual({
      kind: "connected",
    });
  });
});

describe("withWechatPrefix", () => {
  it("prefixes a string content", () => {
    expect(withWechatPrefix("hello")).toBe(`${WECHAT_PREFIX} hello`);
  });

  it("prefixes the first text block of an array", () => {
    const result = withWechatPrefix([
      { type: "text", text: "hello" },
      { type: "image", data: "x", mimeType: "image/jpeg" },
    ]) as Array<{ type: string; text?: string; data?: string }>;
    expect(result[0].text).toBe(`${WECHAT_PREFIX} hello`);
    expect(result).toHaveLength(2);
  });

  it("adds a leading text block when the array has no text", () => {
    const result = withWechatPrefix([
      { type: "image", data: "x", mimeType: "image/jpeg" },
    ]) as Array<{
      type: string;
      text?: string;
    }>;
    expect(result[0]).toEqual({ type: "text", text: WECHAT_PREFIX });
    expect(result).toHaveLength(2);
  });
});

describe("isWechatPrompt", () => {
  it("detects the wechat prefix", () => {
    expect(isWechatPrompt("[wechat] hello")).toBe(true);
  });

  it("ignores leading whitespace", () => {
    expect(isWechatPrompt("  [wechat] hello")).toBe(true);
  });

  it("rejects non-wechat prompts", () => {
    expect(isWechatPrompt("hello")).toBe(false);
  });
});

describe("systemPromptSuffix", () => {
  it("adds the wechat-origin line for wechat turns", () => {
    const suffix = systemPromptSuffix(true);
    expect(suffix).toContain("came from WeChat");
  });

  it("omits the wechat-origin line otherwise", () => {
    expect(systemPromptSuffix(false)).not.toContain("came from WeChat");
  });
});

describe("formatTokens", () => {
  it("formats small counts as plain numbers", () => {
    expect(formatTokens(500)).toBe("500");
  });

  it("formats thousands with one decimal", () => {
    expect(formatTokens(1500)).toBe("1.5k");
  });

  it("rounds larger thousands", () => {
    expect(formatTokens(12000)).toBe("12k");
  });

  it("formats millions with one decimal", () => {
    expect(formatTokens(1200000)).toBe("1.2M");
  });

  it("rounds larger millions", () => {
    expect(formatTokens(12000000)).toBe("12M");
  });
});

describe("textPreviewFor", () => {
  it("falls back to the message type when there is no text", () => {
    expect(textPreviewFor({ text: undefined, type: "image" })).toBe("[image]");
    expect(textPreviewFor({ text: "", type: "video" })).toBe("[video]");
  });

  it("returns short text as-is (trimmed)", () => {
    expect(textPreviewFor({ text: "  hello  ", type: "text" })).toBe("hello");
  });

  it("caps long text at 80 chars with an ellipsis", () => {
    const long = "a".repeat(100);
    const preview = textPreviewFor({ text: long, type: "text" });
    expect(preview.length).toBe(81); // 80 chars + "…"
    expect(preview.endsWith("…")).toBe(true);
    expect(preview.startsWith("a".repeat(80))).toBe(true);
  });

  it("collapses internal whitespace to single spaces", () => {
    expect(textPreviewFor({ text: "line1\nline2   line3", type: "text" })).toBe(
      "line1 line2 line3",
    );
  });
});

describe("piContentToText", () => {
  it("returns a plain string unchanged", () => {
    expect(piContentToText("hello")).toBe("hello");
  });

  it("joins text blocks and drops non-text blocks", () => {
    expect(
      piContentToText([
        { type: "text", text: "a" },
        { type: "image", data: "x", mimeType: "image/png" },
        { type: "text", text: "b" },
      ]),
    ).toBe("ab");
  });

  it("returns an empty string for a text-free array", () => {
    expect(
      piContentToText([{ type: "image", data: "x", mimeType: "image/png" }]),
    ).toBe("");
  });
});

describe("foldQueuedTurns", () => {
  it("returns current unchanged when history is empty", () => {
    expect(foldQueuedTurns("hello", [])).toBe("hello");
  });

  it("returns current unchanged when history has no text", () => {
    expect(foldQueuedTurns("hello", [""])).toBe("hello");
  });

  it("folds history text ahead of the current string message", () => {
    const result = foldQueuedTurns("what now?", [
      "[wechat] first question",
      "[wechat] second question",
    ]) as string;
    expect(result).toContain("1. first question");
    expect(result).toContain("2. second question");
    expect(result).toContain("Current WeChat message:");
    expect(result.endsWith("what now?")).toBe(true);
  });

  it("strips the [wechat] prefix from history entries", () => {
    const result = foldQueuedTurns("now", ["[wechat] earlier"]) as string;
    expect(result).not.toContain("[wechat] earlier");
    expect(result).toContain("1. earlier");
  });

  it("prepends into the first text block of an array current", () => {
    const result = foldQueuedTurns(
      [
        { type: "text", text: "tail" },
        { type: "image", data: "x", mimeType: "image/png" },
      ],
      ["[wechat] earlier"],
    ) as Array<{ type: string; text?: string }>;
    expect(result[0].type).toBe("text");
    expect((result[0].text ?? "").endsWith("tail")).toBe(true);
    expect(result.length).toBe(2);
    expect(result[1].type).toBe("image");
  });
});

describe("gracefulStop", () => {
  it("is a no-op when there is no bot", async () => {
    await expect(gracefulStop(null, null)).resolves.toBeUndefined();
  });

  it("stops the bot and awaits startPromise before resolving", async () => {
    let resolveStart!: () => void;
    const startPromise = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    const calls: string[] = [];
    const bot = { stop: () => calls.push("stop") };

    const stopping = gracefulStop(bot, startPromise);
    expect(calls).toEqual(["stop"]);

    let settled = false;
    void stopping.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false); // still awaiting startPromise

    resolveStart();
    await stopping;
    expect(settled).toBe(true);
  });

  it("swallows a rejected startPromise", async () => {
    const bot = { stop: () => {} };
    const startPromise = Promise.reject(new Error("poll failed"));
    await expect(gracefulStop(bot, startPromise)).resolves.toBeUndefined();
  });
});
