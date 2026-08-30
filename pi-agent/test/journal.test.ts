import { describe, it, expect, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseJournalLine,
  replayUnsettledFromLines,
  createJournal,
} from "../src/journal.js";

// 仅把 readFile 替换成可注入失败的 vi.fn（默认转发真实实现），其余 fs 方法保持真实 IO，
// 用于验证 compact 在读取失败时跳过写盘、不截断已有记录（P1 回归）。
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const admitted = (turnId: string) =>
  JSON.stringify({
    kind: "admitted",
    turnId,
    userId: "u1",
    text: "hi",
    type: "text",
    contextToken: "ct",
    timestamp: "",
  });

describe("parseJournalLine", () => {
  it("解析 admitted", () => {
    expect(parseJournalLine(admitted("t1"))).toEqual({
      kind: "admitted",
      turnId: "t1",
      userId: "u1",
      text: "hi",
      type: "text",
      contextToken: "ct",
      timestamp: "",
    });
  });

  it("解析 settled", () => {
    expect(
      parseJournalLine(JSON.stringify({ kind: "settled", turnId: "t1" })),
    ).toEqual({ kind: "settled", turnId: "t1" });
  });

  it("容忍损坏行、未知 kind、缺失字段", () => {
    expect(parseJournalLine("")).toBeNull();
    expect(parseJournalLine("{not json")).toBeNull();
    expect(
      parseJournalLine(JSON.stringify({ kind: "weird", turnId: "t1" })),
    ).toBeNull();
    expect(parseJournalLine(JSON.stringify({ kind: "admitted" }))).toBeNull();
  });
});

describe("replayUnsettledFromLines", () => {
  it("只回放有 admitted 无 settled 的记录，按序", () => {
    const result = replayUnsettledFromLines([
      admitted("t1"),
      admitted("t2"),
      JSON.stringify({ kind: "settled", turnId: "t1" }),
    ]);
    expect(result.map((e) => e.turnId)).toEqual(["t2"]);
  });

  it("settled 先于 admitted 也正确排除", () => {
    const result = replayUnsettledFromLines([
      JSON.stringify({ kind: "settled", turnId: "t1" }),
      admitted("t1"),
    ]);
    expect(result).toEqual([]);
  });

  it("重复 admitted 去重保留一次", () => {
    expect(
      replayUnsettledFromLines([admitted("t1"), admitted("t1")]),
    ).toHaveLength(1);
  });
});

describe("createJournal（真实 IO）", () => {
  async function makeJournal() {
    const dir = await mkdtemp(join(tmpdir(), "wechat-journal-"));
    const path = join(dir, "journal.jsonl");
    const errors: unknown[] = [];
    const journal = createJournal(path, (e) => errors.push(e));
    return { dir, path, journal, errors };
  }

  it("admit → settle → replay 空，compact 清空", async () => {
    const { dir, path, journal } = await makeJournal();
    try {
      await journal.admit({
        turnId: "t1",
        userId: "u1",
        text: "hi",
        type: "text",
        contextToken: "ct",
        timestamp: "",
      });
      await journal.settle("t1");
      expect(await journal.replayUnsettled()).toEqual([]);
      await journal.compact();
      expect(await readFile(path, "utf-8")).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("admit 未 settle → 回放该条，compact 保留", async () => {
    const { dir, path, journal } = await makeJournal();
    try {
      await journal.admit({
        turnId: "t1",
        userId: "u1",
        text: "hi",
        type: "text",
        contextToken: "ct",
        timestamp: "ts",
      });
      expect((await journal.replayUnsettled()).map((e) => e.turnId)).toEqual([
        "t1",
      ]);
      await journal.compact();
      expect(await readFile(path, "utf-8")).toContain("t1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("文件不存在时 replay 返回空", async () => {
    const { journal } = await makeJournal();
    expect(await journal.replayUnsettled()).toEqual([]);
  });

  it("replay 跳过损坏行并通过 onError 报告", async () => {
    const { dir, path, journal, errors } = await makeJournal();
    try {
      await writeFile(path, "{not json\n" + admitted("t1") + "\n", "utf-8");
      const result = await journal.replayUnsettled();
      expect(result.map((e) => e.turnId)).toEqual(["t1"]);
      expect(errors.some((e) => String(e).includes("1 行损坏"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("compact 读取失败时跳过写盘、不截断已有记录（P1 回归）", async () => {
    const { dir, path, journal, errors } = await makeJournal();
    try {
      await journal.admit({
        turnId: "t1",
        userId: "u1",
        text: "hi",
        type: "text",
        contextToken: "ct",
        timestamp: "",
      });
      // 模拟瞬时 IO 读取错误（非 ENOENT）：旧实现会把文件清空。
      vi.mocked(readFile).mockRejectedValueOnce(
        Object.assign(new Error("EIO"), { code: "EIO" }),
      );
      await journal.compact();
      // 读失败 → 跳过写盘：原记录仍在，且已上报错误。
      const content = await readFile(path, "utf-8");
      expect(content).toContain("t1");
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("discard 清空文件，未结算记录不再回放", async () => {
    const { dir, path, journal } = await makeJournal();
    try {
      await journal.admit({
        turnId: "t1",
        userId: "u1",
        text: "hi",
        type: "text",
        contextToken: "ct",
        timestamp: "",
      });
      await journal.discard();
      expect(await journal.replayUnsettled()).toEqual([]);
      expect(await readFile(path, "utf-8")).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
