import { describe, it, expect, vi } from "vitest";
import type { IncomingMessage, DownloadedMedia } from "@wechatbot/wechatbot";

vi.mock("node:fs/promises", () => ({
  mkdtemp: vi.fn(async (prefix: string) => `${prefix}xyz`),
  writeFile: vi.fn(async () => {}),
}));
vi.mock("node:os", () => ({
  tmpdir: () => "/tmp",
}));

import {
  buildPiContent,
  formatFileSize,
  type Downloader,
} from "../src/inbound.js";
import { mkdtemp, writeFile } from "node:fs/promises";

function makeMsg(
  partial: Partial<IncomingMessage> & { type: IncomingMessage["type"] },
): IncomingMessage {
  return {
    userId: "user1",
    text: "",
    timestamp: new Date(),
    images: [],
    voices: [],
    files: [],
    videos: [],
    raw: {} as IncomingMessage["raw"],
    _contextToken: "",
    ...partial,
  } as IncomingMessage;
}

function makeBot(
  download: (msg: IncomingMessage) => Promise<DownloadedMedia | null>,
): Downloader {
  return { download };
}

const media = (
  data: Buffer,
  extra?: Partial<DownloadedMedia>,
): DownloadedMedia => ({
  data,
  type: "file",
  ...extra,
});

describe("buildPiContent", () => {
  it("returns text for a text message", async () => {
    const bot = makeBot(async () => null);
    await expect(
      buildPiContent(makeMsg({ type: "text", text: "hello" }), bot),
    ).resolves.toBe("hello");
  });

  it("falls back for an empty text message", async () => {
    const bot = makeBot(async () => null);
    await expect(
      buildPiContent(makeMsg({ type: "text", text: "" }), bot),
    ).resolves.toBe("[empty message]");
  });

  it("returns image blocks with base64 data", async () => {
    const bot = makeBot(async () => media(Buffer.from("img")));
    const result = await buildPiContent(
      makeMsg({ type: "image", text: "[image]" }),
      bot,
    );
    expect(Array.isArray(result)).toBe(true);
    const blocks = result as Array<{
      type: string;
      text?: string;
      data?: string;
    }>;
    expect(blocks[0]).toEqual({
      type: "text",
      text: "User sent an image from WeChat:",
    });
    expect(blocks[1].type).toBe("image");
    expect(blocks[1].data).toBe(Buffer.from("img").toString("base64"));
  });

  it("returns fallback when image download fails", async () => {
    const bot = makeBot(async () => null);
    await expect(
      buildPiContent(makeMsg({ type: "image", text: "[image]" }), bot),
    ).resolves.toBe("[Image received but could not be downloaded]");
  });

  it("returns transcribed voice text when present", async () => {
    const bot = makeBot(async () => null);
    const msg = makeMsg({ type: "voice", voices: [{ text: "call me" }] });
    await expect(buildPiContent(msg, bot)).resolves.toBe(
      "[Voice message, transcribed]: call me",
    );
  });

  it("describes an untranscribed voice message with format and size", async () => {
    const bot = makeBot(async () =>
      media(Buffer.alloc(100), { format: "wav", type: "voice" }),
    );
    const msg = makeMsg({ type: "voice", voices: [{}] });
    await expect(buildPiContent(msg, bot)).resolves.toContain(
      "[Voice message received (wav, 100 bytes)",
    );
  });

  it("falls back when voice download fails", async () => {
    const bot = makeBot(async () => null);
    const msg = makeMsg({ type: "voice", voices: [{}] });
    await expect(buildPiContent(msg, bot)).resolves.toBe(
      "[Voice message received but could not be downloaded]",
    );
  });

  it("includes the content of a text-extension file", async () => {
    const bot = makeBot(async () => media(Buffer.from("line1\nline2")));
    const msg = makeMsg({
      type: "file",
      files: [{ fileName: "notes.txt", size: 11 }],
    });
    const result = await buildPiContent(msg, bot);
    expect(result).toContain("[File: notes.txt (11B)]");
    expect(result).toContain("line1\nline2");
  });

  it("truncates a text file over 10000 chars", async () => {
    const big = "x".repeat(10050);
    const bot = makeBot(async () => media(Buffer.from(big)));
    const msg = makeMsg({ type: "file", files: [{ fileName: "big.log" }] });
    const result = (await buildPiContent(msg, bot)) as string;
    expect(result).toContain("... [truncated]");
    expect(result).not.toContain("x".repeat(10001));
  });

  it("describes a non-text file without downloading it", async () => {
    const download = vi.fn(async () => null);
    const bot = makeBot(download);
    const msg = makeMsg({
      type: "file",
      files: [{ fileName: "archive.zip", size: 2048 }],
    });
    const result = await buildPiContent(msg, bot);
    expect(result).toBe(
      "[File received: archive.zip (2.0KB). To process this file, ask the user to share its content as text.]",
    );
    expect(download).not.toHaveBeenCalled();
  });

  it("falls back when a text file download fails", async () => {
    const bot = makeBot(async () => {
      throw new Error("network");
    });
    const msg = makeMsg({ type: "file", files: [{ fileName: "a.txt" }] });
    await expect(buildPiContent(msg, bot)).resolves.toContain(
      "[File received: a.txt",
    );
  });

  it("saves a video to a temp path", async () => {
    const bot = makeBot(async () => media(Buffer.from("v"), { type: "video" }));
    const msg = makeMsg({ type: "video", videos: [{ durationMs: 2500 }] });
    const result = (await buildPiContent(msg, bot)) as string;
    expect(result).toContain("(3s)");
    expect(result).toContain("saved to: /tmp/wechat-video-xyz/video.mp4");
    expect(mkdtemp).toHaveBeenCalledWith("/tmp/wechat-video-");
    expect(writeFile).toHaveBeenCalledWith(
      "/tmp/wechat-video-xyz/video.mp4",
      Buffer.from("v"),
    );
  });

  it("falls back when video download fails", async () => {
    const bot = makeBot(async () => null);
    const msg = makeMsg({ type: "video", videos: [{}] });
    await expect(buildPiContent(msg, bot)).resolves.toBe(
      "[Video received but could not be downloaded.]",
    );
  });

  it("returns unsupported for unknown types", async () => {
    const bot = makeBot(async () => null);
    const msg = makeMsg({ type: "text", text: "x" });
    (msg as { type: string }).type = "sticker";
    await expect(buildPiContent(msg, bot)).resolves.toBe(
      "[sticker message received — not supported yet]",
    );
  });
});

describe("formatFileSize", () => {
  it("formats bytes, KB, and MB", () => {
    expect(formatFileSize(512)).toBe("512B");
    expect(formatFileSize(2048)).toBe("2.0KB");
    expect(formatFileSize(3 * 1024 * 1024)).toBe("3.0MB");
  });
});
