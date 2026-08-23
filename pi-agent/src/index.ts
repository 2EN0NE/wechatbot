/**
 * Pi Extension: WeChat Bridge
 *
 * Type /wechat or /weixin in pi → QR code appears → scan with WeChat →
 * WeChat messages become pi prompts → pi responses sent back to WeChat.
 *
 * Supports:
 *   - Text messages (bidirectional)
 *   - Image messages (receive → send to pi as vision, reply back)
 *   - File messages (text files → include content, others → describe)
 *   - Video messages (download → save to temp → tell pi the path)
 *   - Voice messages (transcribed text or SILK→WAV download)
 *   - Media auto-routing (image/video/file by MIME type)
 *   - Turn queue (no message lost while pi is busy), graceful abort, /status /compact /help
 *
 * Uses @wechatbot/wechatbot SDK for iLink protocol.
 * Uses qrcode-terminal for QR display.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  WeChatBot,
  createLogger,
  stripMarkdown,
  type IncomingMessage,
  type LogEntry,
  type LogTransport,
} from "@wechatbot/wechatbot";
import { Type } from "typebox";
import qrTerminal from "qrcode-terminal";
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import {
  extractAssistantText,
  replyActionFor,
  deriveStatus,
  withWechatPrefix,
  foldQueuedTurns,
  isWechatPrompt,
  systemPromptSuffixFor,
  formatTokens,
  classifyCommand,
  textPreviewFor,
  gracefulStop,
  MAX_ATTACHMENTS_PER_TURN,
  type AssistantSummary,
  type WechatTurn,
} from "./bridge-state.js";
import { buildPiContent } from "./inbound.js";

// ── File logging transport ────────────────────────────────────────────
// pi does NOT redirect extension stderr to .pi/logs/ — stderr paints into the TUI.
// So we write log lines ourselves, matching pi-logger's `~/.pi/logs/<source>_<YYYYMMDD>.log` layout.

function todayCompact(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}${mm}${dd}`;
}

function formatLogLine(entry: LogEntry): string {
  const ts = entry.timestamp.toISOString();
  const ctx = entry.context ? ` [${entry.context}]` : "";
  const lvl = entry.level.toUpperCase().padEnd(5);
  const data = entry.data ? ` ${JSON.stringify(entry.data)}` : "";
  return `${ts} ${lvl}${ctx} ${entry.message}${data}`;
}

const fileTransport: LogTransport = {
  write(entry: LogEntry): void {
    const dir = join(homedir(), ".pi", "logs");
    const file = join(dir, `wechat_${todayCompact()}.log`);
    void (async () => {
      try {
        await mkdir(dir, { recursive: true });
        await appendFile(file, `${formatLogLine(entry)}\n`, "utf-8");
      } catch {
        /* silent — logging must never crash the bridge */
      }
    })();
  },
};

// ── Send retry (exponential backoff) ───────────────────────────────────
// pi.sendUserMessage can fail transiently (no model selected, compaction in
// progress). Retry up to 3 times with backoff; after the final attempt, drop
// the turn, notify the WeChat user, and leave the error visible in status.

const MAX_SEND_ATTEMPTS = 4; // 1 initial + 3 retries
const SEND_RETRY_BASE_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 模块级状态：ctx.newSession() 会重建扩展实例（旧实例 session_shutdown 停 bot、
// 新实例 session_start 接管）。这些标志跨实例保留，让新实例自动重连并回执 /new 确认。
let restartAfterReplace = false;
let pendingAck: { reply: IncomingMessage; text: string } | null = null;

export default function wechatBridge(pi: ExtensionAPI) {
  let bot: WeChatBot | null = null;
  let connected = false;
  let connecting = false;
  const pendingTurns: WechatTurn[] = [];
  let activeTurn: WechatTurn | null = null;
  let preserveQueuedTurnsAsHistory = false;
  let lastEndSummary: AssistantSummary | null = null;
  let currentAbort: (() => void) | undefined;
  let startPromise: Promise<void> | null = null;
  let bridgeError: string | undefined;

  // Bridge-side structured logging → ~/.pi/logs/wechat_<date>.log via fileTransport.
  const log = createLogger({ transport: fileTransport }).child("wechat");

  // ── Status rendering ─────────────────────────────────────────────────

  function updateStatus(ctx: ExtensionContext): void {
    const theme = ctx.ui.theme;
    const label = theme.fg("accent", "wechat");
    const status = deriveStatus({
      connected,
      connecting,
      active: activeTurn !== null,
      queuedCount: pendingTurns.length,
      error: bridgeError,
    });
    switch (status.kind) {
      case "disconnected":
        ctx.ui.setStatus(
          "wechat",
          `${label} ${theme.fg("muted", "disconnected")}`,
        );
        break;
      case "connecting":
        ctx.ui.setStatus(
          "wechat",
          `${label} ${theme.fg("warning", "connecting")}`,
        );
        break;
      case "connected":
        ctx.ui.setStatus(
          "wechat",
          `${label} ${theme.fg("success", "connected")}`,
        );
        break;
      case "processing": {
        const queued =
          status.queued > 0
            ? theme.fg("muted", ` +${status.queued} queued`)
            : "";
        ctx.ui.setStatus(
          "wechat",
          `${label} ${theme.fg("accent", "processing")}${queued}`,
        );
        break;
      }
      case "error":
        ctx.ui.setStatus(
          "wechat",
          `${label} ${theme.fg("error", "error")} ${theme.fg("muted", status.message)}`,
        );
        break;
    }
  }

  // ── Reply helpers ────────────────────────────────────────────────────

  async function sendTextReply(
    reply: IncomingMessage,
    text: string,
  ): Promise<void> {
    if (!bot) return;
    await bot.reply(reply, stripMarkdown(text));
  }

  async function notifySendFailure(
    turn: WechatTurn,
    error: string,
  ): Promise<void> {
    if (!bot) return;
    try {
      await sendTextReply(turn.reply, `消息处理失败：${error}`);
    } catch {
      /* 通知失败静默——不能递归重试 */
    }
  }

  async function sendAttachments(turn: WechatTurn): Promise<void> {
    if (!bot) return;
    for (const filePath of turn.queuedAttachments) {
      try {
        const data = await readFile(filePath);
        const fileName = basename(filePath);
        await bot.reply(turn.reply, { file: data, fileName });
      } catch {
        await bot.reply(
          turn.reply,
          `[Failed to send file: ${basename(filePath)}]`,
        );
      }
    }
  }

  async function buildStatusText(ctx: ExtensionContext): Promise<string> {
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let totalCost = 0;

    for (const entry of ctx.sessionManager.getEntries()) {
      const message = (
        entry as {
          type?: string;
          message?: { role?: string; usage?: UsageLike };
        }
      ).message;
      if (
        (entry as { type?: string }).type !== "message" ||
        message?.role !== "assistant"
      )
        continue;
      const usage = message.usage;
      if (!usage) continue;
      totalInput += usage.input ?? 0;
      totalOutput += usage.output ?? 0;
      totalCacheRead += usage.cacheRead ?? 0;
      totalCacheWrite += usage.cacheWrite ?? 0;
      totalCost += usage.cost?.total ?? 0;
    }

    const usage = ctx.getContextUsage();
    const lines: string[] = [];
    if (ctx.model) {
      lines.push(`Model: ${ctx.model.provider}/${ctx.model.id}`);
    }
    const tokenParts: string[] = [];
    if (totalInput) tokenParts.push(`↑${formatTokens(totalInput)}`);
    if (totalOutput) tokenParts.push(`↓${formatTokens(totalOutput)}`);
    if (totalCacheRead) tokenParts.push(`R${formatTokens(totalCacheRead)}`);
    if (totalCacheWrite) tokenParts.push(`W${formatTokens(totalCacheWrite)}`);
    if (tokenParts.length > 0) lines.push(`Usage: ${tokenParts.join(" ")}`);
    const usingSubscription = ctx.model
      ? ctx.modelRegistry.isUsingOAuth(ctx.model)
      : false;
    if (totalCost || usingSubscription) {
      lines.push(
        `Cost: $${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`,
      );
    }
    if (usage) {
      const contextWindow =
        usage.contextWindow ?? ctx.model?.contextWindow ?? 0;
      const percent =
        usage.percent === null ? "?" : `${usage.percent.toFixed(1)}%`;
      lines.push(`Context: ${percent}/${formatTokens(contextWindow)}`);
    } else {
      lines.push("Context: unknown");
    }
    if (lines.length === 0) lines.push("No usage data yet.");
    return lines.join("\n");
  }

  // ── Turn construction ────────────────────────────────────────────────

  async function buildWechatTurn(
    msg: IncomingMessage,
    historyTurns: WechatTurn[] = [],
  ): Promise<WechatTurn> {
    const rawContent = await buildPiContent(msg, bot!);
    const folded = foldQueuedTurns(
      rawContent,
      historyTurns.map((t) => t.content),
    );
    const content = withWechatPrefix(folded);
    return {
      reply: msg,
      content,
      queuedAttachments: [],
    };
  }

  // ── Serialised turn pump ───────────────────────────────────────────
  // pi's agent run drains followUp messages into the SAME run, so a burst of
  // WeChat messages would collapse into one agent_settled (dropping replies).
  // Keep exactly one turn in flight; agent_settled advances the queue.

  async function pumpTurn(): Promise<void> {
    const turn = pendingTurns.shift();
    if (!turn) return;
    activeTurn = turn;

    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
      try {
        await pi.sendUserMessage(turn.content, { deliverAs: "followUp" });
        log.debug("sent turn to pi", { userId: turn.reply.userId });
        return;
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        if (attempt < MAX_SEND_ATTEMPTS) {
          const delayMs = SEND_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
          log.warn("sendUserMessage failed — retrying", {
            userId: turn.reply.userId,
            attempt,
            delayMs,
            error,
          });
          await sleep(delayMs);
          continue;
        }
        // 最终失败：丢弃该 turn（不再 unshift 否则会无限重试同一条），
        // 通知微信用户并置错误状态。
        activeTurn = null;
        bridgeError = error;
        log.error("failed to send turn to pi after retries", {
          userId: turn.reply.userId,
          attempts: MAX_SEND_ATTEMPTS,
          error,
        });
        await notifySendFailure(turn, error);
        return;
      }
    }
  }

  // ── Message dispatch (command interception + queue) ──────────────────

  async function dispatchMessage(
    msg: IncomingMessage,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    if (!bot || !connected) {
      log.warn("message dropped — bridge not connected", {
        userId: msg.userId,
        type: msg.type,
      });
      return;
    }
    const command = classifyCommand(msg.text ?? "");
    log.info(command ? `command: ${command}` : "message received", {
      userId: msg.userId,
      type: msg.type,
      preview: textPreviewFor({ text: msg.text, type: msg.type }),
    });

    if (command === "stop") {
      if (currentAbort) {
        if (pendingTurns.length > 0) {
          preserveQueuedTurnsAsHistory = true;
        }
        currentAbort();
        updateStatus(ctx);
        await sendTextReply(msg, "Aborted current turn.");
      } else {
        await sendTextReply(msg, "No active turn.");
      }
      return;
    }

    if (command === "compact") {
      if (!ctx.isIdle()) {
        await sendTextReply(
          msg,
          'Cannot compact while pi is busy. Send "stop" first.',
        );
        return;
      }
      ctx.compact({
        onComplete: () => {
          void sendTextReply(msg, "Compaction completed.");
        },
        onError: (error) => {
          void sendTextReply(
            msg,
            `Compaction failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      });
      await sendTextReply(msg, "Compaction started.");
      return;
    }

    if (command === "status") {
      await sendTextReply(msg, await buildStatusText(ctx));
      return;
    }

    if (command === "new") {
      if (!ctx.isIdle()) {
        await sendTextReply(
          msg,
          'Cannot start a new session while pi is busy. Send "stop" first.',
        );
        return;
      }
      await sendTextReply(
        msg,
        "Starting a new session — the bridge will reconnect automatically…",
      );
      restartAfterReplace = true;
      pendingAck = {
        reply: msg,
        text: "New session started. Previous conversation archived; WeChat connection restored.",
      };
      try {
        await ctx.newSession();
      } catch (e) {
        restartAfterReplace = false;
        pendingAck = null;
        await sendTextReply(
          msg,
          `Failed to start new session: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      return;
    }

    if (command === "help") {
      await sendTextReply(
        msg,
        "Send me a message and I will forward it to pi. Commands: /status, /compact, /new, /help, stop.",
      );
      return;
    }

    // Fold any backlog left by a "stop" into this message, then enqueue and
    // send immediately if nothing is in flight.
    const historyTurns = preserveQueuedTurnsAsHistory
      ? pendingTurns.splice(0)
      : [];
    preserveQueuedTurnsAsHistory = false;
    const turn = await buildWechatTurn(msg, historyTurns);
    pendingTurns.push(turn);

    try {
      await bot.sendTyping(msg.userId);
    } catch {
      /* non-fatal */
    }

    if (activeTurn) {
      log.debug("queued turn for pi", { queued: pendingTurns.length });
    } else {
      await pumpTurn();
    }
    updateStatus(ctx);
  }

  // ── Lifecycle events ─────────────────────────────────────────────────

  pi.on("before_agent_start", async (event) => {
    if (!isWechatPrompt(event.prompt ?? "")) return;
    return {
      systemPrompt:
        event.systemPrompt + systemPromptSuffixFor(event.prompt ?? ""),
    };
  });

  pi.on("agent_start", async (_event, ctx) => {
    currentAbort = () => ctx.abort();
    updateStatus(ctx);
  });

  pi.on("agent_end", async (event, ctx) => {
    // agent_end may fire multiple times for one turn (auto-retry / auto-compact).
    // Record the latest summary; the reply is sent once on agent_settled.
    lastEndSummary = extractAssistantText(event.messages);
    currentAbort = undefined;
    updateStatus(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const turn = activeTurn;
    activeTurn = null;
    const summary = lastEndSummary;
    lastEndSummary = null;
    if (!turn) {
      log.debug("agent settled without an active WeChat turn");
      updateStatus(ctx);
      return;
    }
    if (!bot || !connected) {
      log.warn("agent settled but bridge is disconnected — reply dropped");
      updateStatus(ctx);
      return;
    }

    const action = replyActionFor(summary ?? {});
    try {
      switch (action.kind) {
        case "aborted":
          await bot.stopTyping(turn.reply.userId);
          break;
        case "error":
          await sendTextReply(turn.reply, action.text);
          break;
        case "reply":
          await sendTextReply(turn.reply, action.text);
          await sendAttachments(turn);
          break;
        case "silent":
          if (turn.queuedAttachments.length > 0) {
            await sendTextReply(turn.reply, "Attached requested file(s).");
            await sendAttachments(turn);
          } else {
            await bot.stopTyping(turn.reply.userId);
          }
          break;
      }
      // Reply round-trip succeeded — the bridge is healthy. Clear any transient
      // error left by bot.on("error") (poller/handler noise) so status self-heals.
      bridgeError = undefined;
      log.info("reply sent", {
        userId: turn.reply.userId,
        outcome: action.kind,
      });
    } catch (e) {
      bridgeError = e instanceof Error ? e.message : String(e);
      log.error("reply failed", {
        userId: turn.reply.userId,
        error: bridgeError,
      });
    }

    // Advance the queue — unless a "stop" folded the backlog into the next
    // inbound message (preserveQueuedTurnsAsHistory is set), or a message that
    // arrived during the reply await above already claimed activeTurn via
    // pumpTurn. Without this guard, two turns could be in flight at once and
    // the followUp drain would drop one reply.
    if (
      !preserveQueuedTurnsAsHistory &&
      activeTurn === null &&
      pendingTurns.length > 0
    ) {
      await pumpTurn();
    }
    updateStatus(ctx);
  });

  // ── wechat_attach tool ───────────────────────────────────────────────

  pi.registerTool({
    name: "wechat_attach",
    label: "WeChat Attach",
    description:
      "Queue one or more local files to be sent with the next WeChat reply.",
    promptSnippet: "Queue local files to be sent with the next WeChat reply.",
    promptGuidelines: [
      "When handling a [wechat] message and the user asked for a file or generated artifact, call wechat_attach with the local path instead of only mentioning the path in text.",
    ],
    parameters: Type.Object({
      paths: Type.Array(
        Type.String({ description: "Local file path to attach" }),
        {
          minItems: 1,
          maxItems: MAX_ATTACHMENTS_PER_TURN,
        },
      ),
    }),
    async execute(_toolCallId, params) {
      const turn = activeTurn;
      if (!turn) {
        throw new Error(
          "wechat_attach can only be used while replying to an active WeChat turn",
        );
      }
      const added: string[] = [];
      for (const inputPath of params.paths) {
        const stats = await stat(inputPath);
        if (!stats.isFile()) {
          throw new Error(`Not a file: ${inputPath}`);
        }
        if (turn.queuedAttachments.length >= MAX_ATTACHMENTS_PER_TURN) {
          throw new Error(
            `Attachment limit reached (${MAX_ATTACHMENTS_PER_TURN})`,
          );
        }
        turn.queuedAttachments.push(inputPath);
        added.push(inputPath);
      }
      return {
        content: [
          {
            type: "text",
            text: `Queued ${added.length} WeChat attachment(s).`,
          },
        ],
        details: { paths: added },
      };
    },
  });

  // ── /wechat command ──────────────────────────────────────────────────

  const startWechat = async (_args: string | undefined, ctx: any) => {
    if (connected && bot) {
      const action = await ctx.ui.select("WeChat is connected", [
        "Reconnect",
        "Disconnect",
        "Status",
        "Cancel",
      ]);
      if (action === "Reconnect") {
        await shutdownBot();
        // fall through to login flow below
      } else if (action === "Disconnect") {
        await shutdownBot();
        ctx.ui.setStatus("wechat", undefined);
        ctx.ui.notify("WeChat disconnected", "info");
        log.info("disconnected");
        return;
      } else if (action === "Status") {
        const creds = bot.getCredentials();
        ctx.ui.notify(
          `Account: ${creds?.accountId}\nUser: ${creds?.userId}`,
          "info",
        );
        return;
      } else {
        return;
      }
    }

    bot = new WeChatBot({
      storage: "file",
      logger: createLogger({ transport: fileTransport, level: "info" }),
    });
    connecting = true;
    updateStatus(ctx);

    try {
      const creds = await bot.login({
        force: false,
        callbacks: {
          onQrUrl: (url) => {
            qrTerminal.generate(url, { small: true }, (qr: string) => {
              process.stderr.write("\n");
              process.stderr.write("  📱 Scan this QR code in WeChat:\n\n");
              for (const line of qr.split("\n")) {
                process.stderr.write(`  ${line}\n`);
              }
              process.stderr.write("\n");
            });
            ctx.ui.setStatus("wechat", `⏳ Scan QR in WeChat… (${url})`);
          },
          onScanned: () => {
            ctx.ui.setStatus("wechat", "📱 Scanned — confirm in WeChat…");
          },
          onExpired: () => {
            ctx.ui.setStatus("wechat", "⏳ QR expired — new one coming…");
          },
        },
      });

      connected = true;
      connecting = false;
      bridgeError = undefined;
      ctx.ui.notify(`WeChat connected!\nAccount: ${creds.accountId}`, "info");
      log.info("connected", { accountId: creds.accountId });

      bot.onMessage(async (msg: IncomingMessage) => {
        await dispatchMessage(msg, ctx);
      });

      bot.on("error", (err) => {
        bridgeError = err instanceof Error ? err.message : String(err);
        log.error("SDK error", { error: bridgeError });
        updateStatus(ctx);
      });
      bot.on("session:expired", () => {
        bridgeError = "Session expired — re-login…";
        log.warn("session expired — re-login required");
        updateStatus(ctx);
      });
      bot.on("session:restored", () => {
        bridgeError = undefined;
        updateStatus(ctx);
      });

      startPromise = bot.start().catch((e) => {
        bridgeError = e instanceof Error ? e.message : String(e);
        connected = false;
        updateStatus(ctx);
      });

      updateStatus(ctx);
    } catch (e) {
      connecting = false;
      connected = false;
      bridgeError = e instanceof Error ? e.message : String(e);
      updateStatus(ctx);
      ctx.ui.notify(
        `Login failed: ${e instanceof Error ? e.message : e}`,
        "error",
      );
      bot = null;
    }
  };

  async function shutdownBot(): Promise<void> {
    await gracefulStop(bot, startPromise);
    bot = null;
    connected = false;
    connecting = false;
    pendingTurns.length = 0;
    activeTurn = null;
    preserveQueuedTurnsAsHistory = false;
    lastEndSummary = null;
    currentAbort = undefined;
    startPromise = null;
    bridgeError = undefined;
  }

  pi.registerCommand("wechat", {
    description: "Connect WeChat — scan QR to chat with Pi from your phone",
    handler: startWechat,
  });

  pi.on("session_shutdown", async () => {
    await shutdownBot();
  });

  pi.on("session_start", async (_event, ctx) => {
    if (restartAfterReplace) {
      restartAfterReplace = false;
      // 新会话已就绪：用存储的凭证免扫码重登，恢复桥接。
      await startWechat(undefined, ctx);
      const ack = pendingAck;
      pendingAck = null;
      if (ack) {
        await sendTextReply(ack.reply, ack.text);
      }
    } else if (connected && bot) {
      updateStatus(ctx);
    }
  });
}

// ── Usage aggregation type ─────────────────────────────────────────────

interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}
