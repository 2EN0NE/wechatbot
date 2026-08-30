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
 *   - Inactivity timeout (notify WeChat once when a turn stalls — adr/0006)
 *   - Configurable command passthrough via /wechat-setting (adr/0007)
 *
 * Uses @wechatbot/wechatbot SDK for iLink protocol.
 * Uses qrcode-terminal for QR display.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
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
import { randomUUID } from "node:crypto";
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
  systemPromptSuffix,
  formatTokens,
  textPreviewFor,
  gracefulStop,
  MAX_ATTACHMENTS_PER_TURN,
  type AssistantSummary,
  type WechatTurn,
} from "./bridge-state.js";
import { buildPiContent } from "./inbound.js";
import { authorizationState } from "./authorize.js";
import { createJournal } from "./journal.js";
import {
  classifyCommand,
  nativeCommandById,
  NATIVE_COMMANDS,
  type CommandIntent,
  type NativeCommandId,
  type PluginSource,
} from "./commands.js";
import {
  isCommandEnabled,
  effectiveTimeoutSeconds,
  defaultUserConfig,
  type UserConfig,
  type ProjectConfig,
} from "./settings.js";
import { loadConfigs, saveUser, saveProject } from "./config-store.js";
import { InactivityTimer } from "./timeout.js";
import { buildHelpText, type HelpCommandEntry } from "./help.js";
import {
  WechatSettingsPanel,
  type PanelCommandItem,
  TIMEOUT_ITEM_ID,
} from "./panel.js";

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

  // 配置 + 命令穿透（adr/0007）
  let userConfig: UserConfig = defaultUserConfig();
  let projectConfig: ProjectConfig = {};
  let pluginSources = new Map<string, PluginSource>();
  let pluginDescriptions = new Map<string, string>();

  // 欢迎语：每次（重）连接后，某用户首条消息回发一次 /help（adr/0009）。
  const welcomedUsers = new Set<string>();

  // 不活跃超时（adr/0006）
  let timeoutTimer: InactivityTimer | null = null;
  let latestPartialText = "";

  // Bridge-side structured logging → ~/.pi/logs/wechat_<date>.log via fileTransport.
  const log = createLogger({ transport: fileTransport }).child("wechat");

  // 桥接层薄 journal（adr/0011）：文本轮次的持久准入与崩溃回放。
  const journal = createJournal(
    join(getAgentDir(), "wechat-journal.jsonl"),
    (e) => log.error("journal error", { error: String(e) }),
  );

  // ── Config helpers ───────────────────────────────────────────────────

  function enabledFor(id: string, exempt: boolean): boolean {
    return isCommandEnabled(id, exempt, userConfig, projectConfig);
  }

  async function reloadConfig(ctx: ExtensionContext): Promise<void> {
    const loaded = await loadConfigs(ctx.cwd);
    userConfig = loaded.user;
    projectConfig = loaded.project;
    pluginSources = new Map<string, PluginSource>();
    pluginDescriptions = new Map<string, string>();
    for (const c of pi.getCommands()) {
      if (c.name === "wechat" || c.name === "wechat-setting") continue;
      if (!(await isPassthroughEligible(c))) continue;
      pluginSources.set(c.name.toLowerCase(), c.source);
      pluginDescriptions.set(c.name.toLowerCase(), c.description ?? "");
    }
  }

  /** 启发式判定扩展命令是否 TUI 交互型（读源码 grep ctx.ui / select / confirm 等）。 */
  async function isInteractiveExtension(path?: string): Promise<boolean> {
    if (!path) return false;
    try {
      const src = await readFile(path, "utf-8");
      return /ctx\.ui\.|\.select\(|\.confirm\(|\.custom\(|\.input\(|\.editor\(/.test(
        src,
      );
    } catch {
      return false;
    }
  }

  /** 交互型扩展命令既不参与穿透判定也不入面板，保证展示与判定同源（adr/0007）。 */
  async function isPassthroughEligible(c: SlashCommandInfo): Promise<boolean> {
    if (c.source !== "extension") return true;
    return !(await isInteractiveExtension(c.sourceInfo.path));
  }

  async function buildPanelItems(): Promise<PanelCommandItem[]> {
    const items: PanelCommandItem[] = [
      {
        id: TIMEOUT_ITEM_ID,
        name: "不活跃超时（秒）",
        description: "无进展多久后微信提醒一次（Enter 切换）",
        exempt: true,
        source: "native",
        section: "setting",
      },
    ];
    for (const c of NATIVE_COMMANDS) {
      items.push({
        id: c.id,
        name: c.tokens[0],
        description: c.description,
        exempt: c.exempt,
        source: "native",
        section: "native",
      });
    }
    for (const c of pi.getCommands()) {
      if (c.name === "wechat" || c.name === "wechat-setting") continue;
      if (!(await isPassthroughEligible(c))) continue;
      items.push({
        id: c.name.toLowerCase(),
        name: `/${c.name}`,
        description: c.description ?? "",
        exempt: false,
        source: c.source,
        section: "plugin",
      });
    }
    return items;
  }

  // ── Inactivity timeout ───────────────────────────────────────────────

  const onInactivityTimeout = () => {
    const turn = activeTurn;
    if (!turn) return;
    const secs = effectiveTimeoutSeconds(userConfig, projectConfig);
    const progress = latestPartialText
      ? `\n\n最新进度：\n${latestPartialText}`
      : "\n\n（尚未产生输出）";
    void sendTextReply(
      turn.reply,
      `pi 处理超过 ${secs} 秒无进展，仍在处理中。${progress}\n\n如需中止，发送 stop（或 esc）。`,
    );
    log.info("inactivity timeout notified", {
      userId: turn.reply.userId,
      seconds: secs,
    });
  };

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

  function helpText(): string {
    const native: HelpCommandEntry[] = [];
    for (const c of NATIVE_COMMANDS) {
      if (!enabledFor(c.id, c.exempt)) continue;
      native.push({
        trigger: c.id === "stop" ? "/stop（esc）" : c.tokens[0],
        description: c.description,
      });
    }
    const plugin: HelpCommandEntry[] = [...pluginSources.keys()]
      .filter((name) => enabledFor(name, false))
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({
        trigger: `/${name}`,
        description: pluginDescriptions.get(name) ?? "",
      }));
    return buildHelpText({
      timeoutSeconds: effectiveTimeoutSeconds(userConfig, projectConfig),
      native,
      plugin,
    });
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
        await pi.sendUserMessage(turn.content, {
          deliverAs: "followUp",
          ...(turn.expandPromptTemplates
            ? { expandPromptTemplates: true }
            : {}),
        });
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
        // 通知微信用户并置错误状态。写 settled 标记生命周期终结（adr/0011）。
        activeTurn = null;
        bridgeError = error;
        if (turn.turnId) await journal.settle(turn.turnId);
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

  // 崩溃回放（adr/0011）：重放 journal 中「有 admitted 无 settled」的文本 turn。
  // 回放的 turn 已 admitted（即已授权），绕过鉴权与欢迎语，直接入队处理。
  async function replayJournalTurns(): Promise<void> {
    const entries = await journal.replayUnsettled();
    for (const entry of entries) {
      const msg: IncomingMessage = {
        userId: entry.userId,
        text: entry.text,
        type: "text",
        timestamp: new Date(entry.timestamp || Date.now()),
        images: [],
        voices: [],
        files: [],
        videos: [],
        // SAFETY: 文本回放不访问 raw——buildPiContent 对 type === "text" 直接返回 msg.text。
        raw: {} as unknown as IncomingMessage["raw"],
        _contextToken: entry.contextToken,
      };
      const turn = await buildWechatTurn(msg);
      turn.turnId = entry.turnId;
      pendingTurns.push(turn);
      log.info("replayed turn from journal", {
        turnId: entry.turnId,
        userId: entry.userId,
      });
    }
    await journal.compact();
    if (activeTurn === null && pendingTurns.length > 0) {
      await pumpTurn();
    }
  }

  // ── Native command handlers ──────────────────────────────────────────

  async function handleNativeCommand(
    id: NativeCommandId,
    msg: IncomingMessage,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    const cmd = nativeCommandById(id);
    if (!enabledFor(id, cmd.exempt)) {
      await sendTextReply(
        msg,
        `命令 /${id} 未在微信端启用（用 /wechat-setting 配置）。`,
      );
      return;
    }

    switch (id) {
      case "stop": {
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
      case "compact": {
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
      case "status": {
        await sendTextReply(msg, await buildStatusText(ctx));
        return;
      }
      case "new": {
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
      case "help": {
        await sendTextReply(msg, helpText());
        return;
      }
    }
  }

  // ── Plugin command passthrough ───────────────────────────────────────

  async function handlePluginCommand(
    intent: Extract<CommandIntent, { kind: "plugin" }>,
    msg: IncomingMessage,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    if (!enabledFor(intent.name, false)) {
      await sendTextReply(
        msg,
        `命令 /${intent.name} 未在微信端启用（用 /wechat-setting 配置）。`,
      );
      return;
    }

    if (intent.source === "extension") {
      // 扩展命令：执行其 handler，输出走 ctx.ui / pi.sendMessage，回不到微信。
      // sendUserMessage 返回 Promise，分发失败是异步的——只有 await 后才能观察、
      // 并把失败转成边界安全的微信回执；否则 rejection 会变成未处理拒绝。
      try {
        await pi.sendUserMessage(intent.raw, { expandPromptTemplates: true });
      } catch (e) {
        await sendTextReply(
          msg,
          `扩展命令执行失败：${e instanceof Error ? e.message : String(e)}`,
        );
        return;
      }
      await sendTextReply(
        msg,
        `已触发扩展命令 /${intent.name}。其输出在 pi 终端，可能不会回传微信。`,
      );
      updateStatus(ctx);
      return;
    }

    // skill / prompt：展开成普通 turn，回复自然回微信。入队与普通消息一致。
    // 不纳入 journal（adr/0011 仅覆盖对话型文本）：命令可重发，且回放需恢复
    // expandPromptTemplates 语义、复杂度不值。
    const turn: WechatTurn = {
      reply: msg,
      content: intent.raw,
      queuedAttachments: [],
      expandPromptTemplates: true,
    };
    pendingTurns.push(turn);
    try {
      await bot!.sendTyping(msg.userId);
    } catch {
      /* non-fatal */
    }
    if (activeTurn) {
      log.debug("queued plugin command", { queued: pendingTurns.length });
    } else {
      await pumpTurn();
    }
    updateStatus(ctx);
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

    // 发送者白名单鉴权（adr/0010）：未授权静默丢弃，只记脱敏日志、不回任何内容；
    // 首用户配对则持久化 allowedUserId，此后白名单锁定、不再自动配对。
    const auth = authorizationState(msg.userId, userConfig.allowedUserId);
    if (auth.kind === "deny") {
      log.warn("message dropped — sender not authorized", {
        userId: msg.userId,
        preview: textPreviewFor({ text: msg.text, type: msg.type }),
      });
      return;
    }
    if (auth.kind === "pair") {
      userConfig = { ...userConfig, allowedUserId: auth.userId };
      void saveUser(userConfig).catch((e) =>
        log.error("persist allowedUserId failed", { error: String(e) }),
      );
      log.info("paired first sender as authorized user", {
        userId: auth.userId,
      });
    }

    const intent = classifyCommand(msg.text ?? "", pluginSources);

    // 每次（重）连接后，该用户首条消息回发一次 /help 欢迎语；若首条消息本身就是
    // /help，则直接交给下方处理，避免连发两份（adr/0009）。
    if (!welcomedUsers.has(msg.userId)) {
      welcomedUsers.add(msg.userId);
      if (!(intent.kind === "native" && intent.id === "help")) {
        try {
          await sendTextReply(msg, helpText());
        } catch (e) {
          log.warn("welcome message failed", {
            userId: msg.userId,
            error: String(e),
          });
        }
      }
    }

    log.info(
      intent.kind === "message"
        ? "message received"
        : `command: ${intent.kind === "native" ? intent.id : `plugin:${intent.name}`}`,
      {
        userId: msg.userId,
        type: msg.type,
        preview: textPreviewFor({ text: msg.text, type: msg.type }),
      },
    );

    if (intent.kind === "native") {
      await handleNativeCommand(intent.id, msg, ctx);
      updateStatus(ctx);
      return;
    }
    if (intent.kind === "plugin") {
      await handlePluginCommand(intent, msg, ctx);
      return;
    }

    // Fold any backlog left by a "stop" into this message, then enqueue and
    // send immediately if nothing is in flight.
    const historyTurns = preserveQueuedTurnsAsHistory
      ? pendingTurns.splice(0)
      : [];
    preserveQueuedTurnsAsHistory = false;

    // 被折叠的积压 turn 生命周期终结：写 settled，避免崩溃回放重复处理（adr/0011）。
    for (const folded of historyTurns) {
      if (folded.turnId) await journal.settle(folded.turnId);
    }

    // 文本消息先持久准入（admitted）再入队；journal 写失败不阻断（尽力而为）。
    const turn = await buildWechatTurn(msg, historyTurns);
    if (msg.type === "text") {
      turn.turnId = randomUUID();
      await journal.admit({
        turnId: turn.turnId,
        userId: msg.userId,
        text: msg.text,
        type: "text",
        contextToken: msg._contextToken,
        timestamp: msg.timestamp.toISOString(),
      });
    }
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
    const fromWechat =
      isWechatPrompt(event.prompt ?? "") || activeTurn !== null;
    if (!fromWechat) return;
    return {
      systemPrompt: event.systemPrompt + systemPromptSuffix(fromWechat),
    };
  });

  pi.on("agent_start", async (_event, ctx) => {
    currentAbort = () => ctx.abort();
    latestPartialText = "";
    // 前一轮的 agent_end 可能因 auto-retry/auto-compact 又触发一次 agent_start；
    // 覆盖前先 disarm 旧计时器，避免孤儿计时器在下一轮误报“无进展”。
    timeoutTimer?.disarm();
    const timeoutMs = effectiveTimeoutSeconds(userConfig, projectConfig) * 1000;
    timeoutTimer = new InactivityTimer(timeoutMs, onInactivityTimeout);
    timeoutTimer.arm();
    updateStatus(ctx);
  });

  pi.on("message_update", async (event) => {
    timeoutTimer?.touch();
    const text = extractAssistantText([event.message]).text;
    if (text) latestPartialText = text;
  });

  pi.on("tool_execution_start", async () => {
    timeoutTimer?.touch();
  });

  pi.on("tool_execution_update", async () => {
    timeoutTimer?.touch();
  });

  pi.on("tool_execution_end", async () => {
    timeoutTimer?.touch();
  });

  pi.on("agent_end", async (event, ctx) => {
    // agent_end may fire multiple times for one turn (auto-retry / auto-compact).
    // Record the latest summary; the reply is sent once on agent_settled.
    lastEndSummary = extractAssistantText(event.messages);
    currentAbort = undefined;
    updateStatus(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    timeoutTimer?.disarm();
    timeoutTimer = null;
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
    // 该动作是否承载「用户必须收到」的回发内容：reply / error 必然回发文字，
    // silent 仅当有待发附件时才回发提示。aborted 与纯 silent 无回发，stopTyping
    // 失败不影响结算。
    const hasReplyDeliverable =
      action.kind === "error" ||
      action.kind === "reply" ||
      (action.kind === "silent" && turn.queuedAttachments.length > 0);
    let replyDelivered = false;
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
      replyDelivered = true;
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

    // turn 生命周期终结：回复成功 / 中止 / 静默 → 写 settled。唯一例外是「有回发
    // 内容但发送失败」——此时保留 unsettled，崩溃回放会重新处理，保证至少一次送达
    //（adr/0011）。
    if (turn.turnId && (!hasReplyDeliverable || replyDelivered)) {
      await journal.settle(turn.turnId);
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

  // ── /wechat-setting command ──────────────────────────────────────────

  const openSettings = async (
    _args: string | undefined,
    ctx: ExtensionCommandContext,
  ) => {
    await reloadConfig(ctx);
    const items = await buildPanelItems();
    await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
      const panel = new WechatSettingsPanel({
        items,
        user: userConfig,
        project: projectConfig,
        theme,
        keys: keybindings,
        requestRender: () => tui.requestRender(),
        done: () => done(undefined),
        saveUser: (c) => {
          // 面板持有打开时的快照；配对（adr/0010）可能在面板打开期间把
          // allowedUserId 写入内存，合并最新值避免用陈旧快照覆盖白名单锁定。
          const merged: UserConfig = {
            ...c,
            allowedUserId: userConfig.allowedUserId,
          };
          void saveUser(merged).catch((e) =>
            log.error("save user config failed", { error: String(e) }),
          );
        },
        saveProject: (c) => {
          void saveProject(ctx.cwd, c).catch((e) =>
            log.error("save project config failed", { error: String(e) }),
          );
        },
      });
      return panel;
    });
    // 面板关闭后重载，让运行时立即用上新配置。
    await reloadConfig(ctx);
    log.info("wechat settings updated", { cwd: ctx.cwd });
  };

  pi.registerCommand("wechat-setting", {
    description: "配置微信端命令穿透与不活跃超时",
    handler: openSettings,
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
      welcomedUsers.clear();
      ctx.ui.notify(
        `WeChat connected!\nAccount: ${creds.accountId}\n\n${helpText()}`,
        "info",
      );
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
        // session 过期后 context_token 被平台清除（docs/protocol.md），journal
        // 中未结算的 turn 已无法回放（回复会因失效 token 路由失败）。清空之，
        // 避免用失效 token 重放（adr/0011）。
        void journal.discard();
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

      // 崩溃回放：重连成功后重放未结算的文本 turn（adr/0011）。
      await replayJournalTurns();

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
    timeoutTimer?.disarm();
    timeoutTimer = null;
    await shutdownBot();
  });

  pi.on("session_start", async (_event, ctx) => {
    await reloadConfig(ctx);
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
