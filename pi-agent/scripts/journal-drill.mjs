#!/usr/bin/env node
/**
 * 崩溃回放演练的断言脚本（adr/0011 / adr/0013）。
 *
 * 微信平台无法 e2e，现有单测又把 fs mock 掉了（只证明「文件里有记录时代码会回放」），
 * 所以回放能力需要一个能在真机上留下可复查证据的入口。两个断言分开：
 *
 *   --check-entry   入口证据：journal 里有「已准入未结算」的记录
 *                   → 证明 admit 在崩溃前真的落了盘
 *   --check-replay  恢复证据：日志里有该 turn 的回放事件，且它不再未结算
 *                   → 证明回放真的把它变成一个跑完的轮次
 *
 * 纯 fs 读取，不 import pi 运行时，可直接 node 执行。
 *
 * 用法与完整步骤见 pi-agent/README.md 的「崩溃回放演练」节。
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// 必须与扩展侧 getAgentDir() 同源：pi 读取的是 PI_CODING_AGENT_DIR（APP_NAME=pi），
// 不是 PI_AGENT_DIR——用错变量会让断言去看 ~/.pi/agent 下的空文件，把「路径找错」
// 误报成「admit 没有落盘」。
const AGENT_DIR = expandTilde(
  process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
);

/**
 * 展开前导 `~`：pi 的 getAgentDir() 走 expandTildePath，这里必须同样处理，
 * 否则 PI_CODING_AGENT_DIR=~/alt 会被当字面路径读成 ENOENT（同上，路径找错）。
 */
function expandTilde(path) {
  return path.replace(/^~(?=$|[\\/])/, homedir());
}

const LOG_DIR = join(homedir(), ".pi", "logs");

/** 取 flag 后面的值（必填型：--journal / --log）。 */
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  // 缺值必须报错：静默回退到默认路径会去读另一个文件，把「参数写错」变成「断言失败」。
  if (value === undefined || value.startsWith("--")) {
    fail(`${flag} 缺少路径值`);
  }
  return value;
}

/** 取 flag 后面的可选值：下一个 token 又是 flag 时视为省略（turnId 用）。 */
function optionalValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  return next === undefined || next.startsWith("--") ? undefined : next;
}

function todayCompact() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}${mm}${dd}`;
}

/** 单行、限长，避免把整段对话打进终端。 */
function preview(text) {
  const one = String(text ?? "").replace(/\s+/g, " ").trim();
  return one.length > 80 ? `${one.slice(0, 80)}…` : one;
}

function pass(message) {
  console.log(`✓ ${message}`);
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const journalPath =
  argValue("--journal") ?? join(AGENT_DIR, "wechat-journal.jsonl");
const logPath = argValue("--log") ?? join(LOG_DIR, `wechat_${todayCompact()}.log`);

/**
 * 与 src/journal.ts 的 parseJournalLine 等价：drill 是纯 JS、不能 import .ts，
 * 校验规则必须同步——否则会把扩展判定为损坏行、根本不会回放的记录当成入口证据。
 */
function parseEntry(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== "object") return null;
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
  if (obj.kind === "settled") return { kind: "settled", turnId: obj.turnId };
  return null;
}

/**
 * 逐行解析 journal，损坏行跳过（与 src/journal.ts 的容忍策略一致）。
 *
 * `exists` 必须与「文件为空」分开：读不到文件不能当成「没有未结算记录」，
 * 否则路径写错会被断言读成「已结算」（见 checkReplay）。
 */
async function readJournal() {
  let raw;
  try {
    raw = await readFile(journalPath, "utf-8");
  } catch (e) {
    if (e?.code === "ENOENT") return { entries: [], exists: false, corrupt: 0 };
    throw e;
  }
  const entries = [];
  let corrupt = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const entry = parseEntry(line);
    if (entry) entries.push(entry);
    else corrupt++;
  }
  return { entries, exists: true, corrupt };
}

/** 「有 admitted 无 settled」的记录，保持首次出现顺序。 */
function unsettledOf(entries) {
  const settled = new Set(
    entries.filter((e) => e?.kind === "settled").map((e) => e.turnId),
  );
  const admitted = new Map();
  for (const e of entries) {
    if (e?.kind === "admitted") admitted.set(e.turnId, e);
  }
  return [...admitted.values()].filter((e) => !settled.has(e.turnId));
}

async function checkEntry(turnId) {
  const { entries, corrupt } = await readJournal();
  const pending = unsettledOf(entries);
  const settledIds = new Set(
    entries.filter((e) => e?.kind === "settled").map((e) => e.turnId),
  );
  // 「已结算」和「admit 没落盘」是两件事，不能都报成后者：前者说明系统一切正常，
  // 只是这轮已经跑完（admit 与 settle 都落了盘），崩溃回放没有可验证对象。
  const alreadyFinished = turnId
    ? settledIds.has(turnId)
    : pending.length === 0 && settledIds.size > 0;
  if (pending.length === 0 || alreadyFinished) {
    let reason;
    if (alreadyFinished) {
      reason =
        `  → 这轮已正常结算（admit 落盘 + settle 落盘）——桥是健康的，只是没有可验证对象。\n` +
        `  → 重发一条消息后立刻 kill -9（别等 pi 回完），再跑本断言。`;
    } else if (corrupt > 0) {
      reason = `  → 有 ${corrupt} 行损坏/字段不全（扩展同样会跳过，见 src/journal.ts），先修数据或换 --journal。`;
    } else {
      reason =
        `  → admit 没有在崩溃前落盘，或记录已被 compact/discard 清掉。\n` +
        `  → 注意 compact 在每次重连时运行，所以正常收尾之后文件是空的（这是对的）。`;
    }
    fail(`journal 里没有「已准入未结算」的记录：${journalPath}\n${reason}`);
  }
  const hit = turnId
    ? pending.find((e) => e.turnId === turnId)
    : pending.at(-1);
  if (!hit) {
    fail(
      `未找到 turnId=${turnId} 的未结算记录\n` +
        `  当前未结算：${pending.map((e) => e.turnId).join(", ")}`,
    );
  }
  pass(`入口证据成立：turnId=${hit.turnId} 已准入且未结算`);
  console.log(`  userId:   ${hit.userId}`);
  console.log(`  text:     ${preview(hit.text)}`);
  console.log(`  admitted: ${hit.timestamp || "(无时间戳)"}`);
  console.log("");
  console.log("下一步：kill -9 掉 pi 进程 → 重启会话并重连，然后：");
  console.log(`  npm run drill -- --check-replay ${hit.turnId}`);
}

async function checkReplay(turnId) {
  let raw;
  try {
    raw = await readFile(logPath, "utf-8");
  } catch {
    fail(`找不到日志文件：${logPath}\n  → 用 --log <path> 指定当天的日志。`);
  }

  const replayLines = raw
    .split("\n")
    .filter((l) => l.includes("replayed turn from journal"));
  if (replayLines.length === 0) {
    fail(
      `日志里没有任何 "replayed turn from journal"：${logPath}\n` +
        `  → 回放没有发生：重连了吗？kill -9 之后 journal 记录还在吗？`,
    );
  }

  const hit = turnId
    ? replayLines.find((l) => l.includes(turnId))
    : replayLines.at(-1);
  if (!hit) {
    fail(
      `日志里没有 turnId=${turnId} 的回放记录（当天共 ${replayLines.length} 次回放，都不是它）`,
    );
  }

  // 没传 turnId 时必须从日志行解析出来：解析不到就没有证据，不能当成通过。
  const resolvedId = turnId ?? /"turnId":"([^"]+)"/.exec(hit)?.[1];
  if (!resolvedId) {
    fail(
      `无法从回放日志行解析 turnId：${hit.trim()}\n` +
        `  → 用 --check-replay <turnId> 显式指定，或确认日志行已被 kill 截断。`,
    );
  }

  // 已结算 = 它不再出现在「有 admitted 无 settled」集合里。
  // 用这个判据而不是「文件里有 settled 记录」，因为回放后会 compact，把已结算记录清掉。
  const { entries, exists } = await readJournal();
  // journal 读不到 ≠ 已结算：路径写错或文件被删时不能把「没证据」当成「通过」。
  if (!exists) {
    fail(
      `journal 不存在：${journalPath}\n` +
        `  → 无法证明 turnId=${resolvedId} 已结算（路径写错或文件被删除），用 --journal 指定。`,
    );
  }
  const stillPending = unsettledOf(entries).some(
    (e) => e.turnId === resolvedId,
  );
  if (stillPending) {
    fail(
      `turnId=${resolvedId} 仍未结算 —— 回放已发生但轮次没终结（回复发送失败？）\n` +
        `  查 journal：${journalPath}`,
    );
  }

  pass(`恢复证据成立：turnId=${resolvedId} 已被回放并结算`);
  console.log(`  日志：${logPath}`);
  console.log(`  事件：${hit.trim()}`);
  console.log("");
  console.log("两阶段都通过 = 崩溃回放路径在真机上成立。");
}

function usage() {
  console.log(
    [
      "崩溃回放演练断言（adr/0011 / 0013）",
      "",
      "  --check-entry [turnId]    入口证据：journal 里有已准入未结算的记录",
      "  --check-replay [turnId]   恢复证据：日志有回放事件且轮次已结算",
      "  --journal <path>          覆盖 journal 路径",
      "  --log <path>              覆盖日志路径（默认当天）",
      "",
      "省略 turnId 时：check-entry 取最近一条未结算，check-replay 取最近一次回放。",
    ].join("\n"),
  );
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h") || args.length === 0) {
  usage();
} else if (args.includes("--check-entry")) {
  await checkEntry(optionalValue("--check-entry"));
} else if (args.includes("--check-replay")) {
  await checkReplay(optionalValue("--check-replay"));
} else {
  usage();
  process.exit(1);
}
