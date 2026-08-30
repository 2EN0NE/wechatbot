/**
 * 桥接层薄 journal（adr/0011）：文本轮次的持久准入与至少一次回放。
 *
 * 单文件 append-only JSONL。每条文本 turn 两条记录：
 *   - admitted：入队前写（turnId、userId、text、type、contextToken、timestamp）
 *   - settled：turn 生命周期终结时写（回复成功 / 中止 / 折叠 / 发送最终失败）
 * 崩溃恢复时回放「有 admitted 无 settled」的记录，重新入队处理。
 *
 * 纯逻辑（parseJournalLine / replayUnsettledFromLines）与 IO 分离，便于单测。
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface AdmittedEntry {
  kind: "admitted";
  turnId: string;
  userId: string;
  text: string;
  type: "text";
  contextToken: string;
  timestamp: string;
}

export interface SettledEntry {
  kind: "settled";
  turnId: string;
}

export type JournalEntry = AdmittedEntry | SettledEntry;

/** 逐行解析，容忍损坏行（返回 null，不中断回放）。 */
export function parseJournalLine(line: string): JournalEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof obj.turnId !== "string") return null;
    if (obj.kind === "admitted") {
      if (
        typeof obj.userId !== "string" ||
        typeof obj.text !== "string" ||
        typeof obj.contextToken !== "string"
      ) {
        return null;
      }
      return {
        kind: "admitted",
        turnId: obj.turnId,
        userId: obj.userId,
        text: obj.text,
        type: "text",
        contextToken: obj.contextToken,
        timestamp: typeof obj.timestamp === "string" ? obj.timestamp : "",
      };
    }
    if (obj.kind === "settled") {
      return { kind: "settled", turnId: obj.turnId };
    }
    return null;
  } catch {
    return null;
  }
}

/** 从行序列回放「有 admitted 无 settled」的记录，保持首次出现顺序。 */
export function replayUnsettledFromLines(lines: string[]): AdmittedEntry[] {
  const settled = new Set<string>();
  const admitted = new Map<string, AdmittedEntry>();
  for (const line of lines) {
    const entry = parseJournalLine(line);
    if (!entry) continue;
    if (entry.kind === "settled") settled.add(entry.turnId);
    else admitted.set(entry.turnId, entry);
  }
  return [...admitted.values()].filter((e) => !settled.has(e.turnId));
}

export interface Journal {
  /** 入队前持久化一条 admitted 记录（尽力而为，失败不抛出）。 */
  admit(entry: Omit<AdmittedEntry, "kind">): Promise<void>;
  /** turn 生命周期终结时持久化一条 settled 记录（尽力而为）。 */
  settle(turnId: string): Promise<void>;
  /** 回放尚未结算的 admitted 记录。 */
  replayUnsettled(): Promise<AdmittedEntry[]>;
  /** 重写文件，只保留未结算的 admitted 记录，防无限增长。 */
  compact(): Promise<void>;
  /** session 过期时清空文件：context_token 已失效，未结算记录无法回放。 */
  discard(): Promise<void>;
}

function isMissingFile(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { code?: string }).code === "ENOENT"
  );
}

export function createJournal(
  path: string,
  onError?: (error: unknown) => void,
): Journal {
  // 串行化所有 journal 操作：appendFile（admit/settle）与 compact 的读-改-写
  // 必须互斥，否则 compact 的覆盖写会丢失并发追加的 admitted/settled 记录。
  let chain: Promise<unknown> = Promise.resolve();
  function run<T>(op: () => Promise<T>): Promise<T> {
    const result = chain.then(op);
    chain = result.catch(() => undefined);
    return result;
  }

  // appendFile/writeFile 不会自建父目录（与 config-store 的 writeJson 不同）；
  // 首次运行且 ~/.pi/agent 尚未创建时，不 mkdir 会让 admit 静默 ENOENT 失效。
  async function ensureDir(): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
  }

  /** 读取并解析「有 admitted 无 settled」的记录；读取/IO 失败时 throw，由调用方决定回退。 */
  async function readUnsettled(): Promise<AdmittedEntry[]> {
    const raw = await readFile(path, "utf-8");
    const lines = raw.split("\n");
    const corrupt = lines.filter(
      (l) => l.trim() !== "" && parseJournalLine(l) === null,
    ).length;
    if (corrupt > 0) {
      onError?.(new Error(`journal 中 ${corrupt} 行损坏，已跳过`));
    }
    return replayUnsettledFromLines(lines);
  }

  return {
    async admit(entry) {
      await run(async () => {
        try {
          await ensureDir();
          await appendFile(
            path,
            `${JSON.stringify({ ...entry, kind: "admitted" })}\n`,
            "utf-8",
          );
        } catch (e) {
          onError?.(e);
        }
      });
    },
    async settle(turnId) {
      await run(async () => {
        try {
          await ensureDir();
          await appendFile(
            path,
            `${JSON.stringify({ kind: "settled", turnId })}\n`,
            "utf-8",
          );
        } catch (e) {
          onError?.(e);
        }
      });
    },
    async replayUnsettled() {
      return run(async () => {
        try {
          return await readUnsettled();
        } catch (e) {
          // 尽力而为：读失败（含 ENOENT）不阻断连接，只是本次不重放。
          if (!isMissingFile(e)) onError?.(e);
          return [];
        }
      });
    },
    async compact() {
      await run(async () => {
        try {
          // 直接读文件再覆盖：读取失败时跳过写盘，绝不因读取错误截断已有记录。
          const unsettled = await readUnsettled();
          await writeFile(
            path,
            unsettled.map((e) => `${JSON.stringify(e)}\n`).join(""),
            "utf-8",
          );
        } catch (e) {
          // 首次运行无文件（ENOENT）无需 compact；其他 IO 错误保留原文件。
          if (isMissingFile(e)) return;
          onError?.(e);
        }
      });
    },
    async discard() {
      await run(async () => {
        try {
          await ensureDir();
          await writeFile(path, "", "utf-8");
        } catch (e) {
          if (isMissingFile(e)) return;
          onError?.(e);
        }
      });
    },
  };
}
