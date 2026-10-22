/**
 * scripts/journal-drill.mjs 的断言语义（e2e：真起一个 node 进程跑脚本）。
 *
 * 覆盖两类回归：
 *   - 「读不到 journal」不能被当成「已结算」（路径写错 → 假阳性）
 *   - journal 解析必须与 src/journal.ts 的 parseJournalLine 同严格度，
 *     扩展会跳过的损坏记录不能被当成入口证据
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(
  new URL("../scripts/journal-drill.mjs", import.meta.url),
);

/** 跑一次 drill，返回退出码与合并后的输出（失败信息走 stderr）。 */
function drill(args: string[]): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf-8",
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const admittedLine = (turnId: string): string =>
  JSON.stringify({
    kind: "admitted",
    turnId,
    userId: "u1",
    text: "hi",
    type: "text",
    contextToken: "ct",
    timestamp: "2026-01-01T00:00:00.000Z",
  });

const settledLine = (turnId: string): string =>
  JSON.stringify({ kind: "settled", turnId });

const replayLogLine = (turnId: string): string =>
  `2026-01-01T00:00:10.000Z INFO  [wechat] replayed turn from journal {"turnId":"${turnId}","userId":"u1"}`;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "drill-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fixture(name: string, lines: string[]): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, lines.map((l) => `${l}\n`).join(""), "utf-8");
  return path;
}

describe("journal-drill --check-entry", () => {
  it("已准入未结算 → 通过并打印 turnId", async () => {
    const journal = await fixture("j.jsonl", [admittedLine("t1")]);
    const r = drill(["--check-entry", "--journal", journal]);
    expect(r.out).toContain("✓ 入口证据成立：turnId=t1");
    expect(r.status).toBe(0);
  });

  it("空 journal → 失败", async () => {
    const journal = await fixture("empty.jsonl", []);
    const r = drill(["--check-entry", "--journal", journal]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("没有「已准入未结算」的记录");
  });

  it("字段不全的 admitted（扩展会当损坏行跳过）→ 失败并提示损坏行", async () => {
    // 缺 userId / text / contextToken：src/journal.ts 的 parseJournalLine 判为 null。
    const journal = await fixture("bad.jsonl", [
      JSON.stringify({ kind: "admitted", turnId: "t9", type: "text" }),
    ]);
    const r = drill(["--check-entry", "--journal", journal]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("1 行损坏/字段不全");
  });
});

describe("journal-drill --check-replay", () => {
  it("日志有回放事件且 journal 不再有该记录 → 通过", async () => {
    const journal = await fixture("j.jsonl", [
      admittedLine("t1"),
      settledLine("t1"),
    ]);
    const log = await fixture("l.log", [replayLogLine("t1")]);
    const r = drill([
      "--check-replay",
      "t1",
      "--journal",
      journal,
      "--log",
      log,
    ]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("✓ 恢复证据成立：turnId=t1");
  });

  it("journal 文件不存在 → 失败（读不到 ≠ 已结算）", async () => {
    const log = await fixture("l.log", [replayLogLine("t1")]);
    const r = drill([
      "--check-replay",
      "t1",
      "--journal",
      join(dir, "NOPE.jsonl"),
      "--log",
      log,
    ]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("journal 不存在");
  });

  it("记录仍未结算 → 失败", async () => {
    const journal = await fixture("j.jsonl", [admittedLine("t1")]);
    const log = await fixture("l.log", [replayLogLine("t1")]);
    const r = drill([
      "--check-replay",
      "t1",
      "--journal",
      journal,
      "--log",
      log,
    ]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("仍未结算");
  });
});
