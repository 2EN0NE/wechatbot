/**
 * Pure, testable logic for the WeChat bridge.
 * No pi / SDK runtime imports — only types — so this is unit-testable in isolation.
 */
import type { IncomingMessage } from "@wechatbot/wechatbot";

export type PiContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string }
    >;

/** One inbound WeChat message that maps to one pi agent run. */
export interface WechatTurn {
  /** The message to reply to (carries userId + context token). */
  reply: IncomingMessage;
  /** What gets sent to pi as the user prompt. */
  content: PiContent;
  /** Local file paths queued via wechat_attach to send with the reply. */
  queuedAttachments: string[];
}

export const WECHAT_PREFIX = "[wechat]";
export const MAX_ATTACHMENTS_PER_TURN = 10;

// ── assistant text / stop reason extraction ────────────────────────────

export interface AssistantSummary {
  text?: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface MessageLike {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
  content?: string | Array<{ type?: string; text?: string }>;
}

/** Scan from the end for the last assistant message; return its text, stopReason, errorMessage. */
export function extractAssistantText(
  messages: MessageLike[],
): AssistantSummary {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const stopReason =
      typeof message.stopReason === "string" ? message.stopReason : undefined;
    const errorMessage =
      typeof message.errorMessage === "string"
        ? message.errorMessage
        : undefined;
    const blocks = Array.isArray(message.content) ? message.content : [];
    const text = blocks
      .filter(
        (block) => block.type === "text" && typeof block.text === "string",
      )
      .map((block) => block.text as string)
      .join("")
      .trim();
    return { text: text || undefined, stopReason, errorMessage };
  }
  return {};
}

// ── reply action (stopReason → what to send back) ──────────────────────

export type ReplyAction =
  | { kind: "aborted" }
  | { kind: "silent" }
  | { kind: "error"; text: string }
  | { kind: "reply"; text: string };

export const ERROR_FALLBACK = "pi failed while processing the request.";

export function replyActionFor(summary: AssistantSummary): ReplyAction {
  if (summary.stopReason === "aborted") return { kind: "aborted" };
  if (summary.stopReason === "error")
    return { kind: "error", text: summary.errorMessage || ERROR_FALLBACK };
  if (!summary.text) return { kind: "silent" };
  return { kind: "reply", text: summary.text };
}

// ── status derivation ──────────────────────────────────────────────────

export type BridgeStatus =
  | { kind: "disconnected" }
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "processing"; queued: number }
  | { kind: "error"; message: string };

export interface StatusInput {
  connected: boolean;
  connecting: boolean;
  active: boolean;
  queuedCount: number;
  error?: string;
}

export function deriveStatus(input: StatusInput): BridgeStatus {
  if (input.error) return { kind: "error", message: input.error };
  if (input.connecting) return { kind: "connecting" };
  if (!input.connected) return { kind: "disconnected" };
  if (input.active || input.queuedCount > 0)
    return { kind: "processing", queued: input.queuedCount };
  return { kind: "connected" };
}

// ── wechat prompt prefix / detection ───────────────────────────────────

export function isWechatPrompt(prompt: string): boolean {
  return prompt.trimStart().startsWith(WECHAT_PREFIX);
}

export function withWechatPrefix(content: PiContent): PiContent {
  if (typeof content === "string") return `${WECHAT_PREFIX} ${content}`;
  const [first, ...rest] = content;
  if (first && first.type === "text") {
    return [{ type: "text", text: `${WECHAT_PREFIX} ${first.text}` }, ...rest];
  }
  return [{ type: "text", text: WECHAT_PREFIX }, ...content];
}

/** Extract the plain text of a PiContent, dropping non-text blocks. */
export function piContentToText(content: PiContent): string {
  if (typeof content === "string") return content;
  return content
    .filter(
      (block): block is { type: "text"; text: string } => block.type === "text",
    )
    .map((block) => block.text)
    .join("");
}

/**
 * Fold aborted-queue history into the next inbound message's prompt. When the
 * user sends "stop" while turns are queued, those turns are folded here (instead
 * of being processed one-by-one) so the agent sees them as prior context.
 * `history` entries already carry the `[wechat]` prefix; `current` does not.
 */
export function foldQueuedTurns(
  current: PiContent,
  history: PiContent[],
): PiContent {
  const texts: string[] = [];
  for (const content of history) {
    const text = piContentToText(content).trim();
    const stripped = text.startsWith(WECHAT_PREFIX)
      ? text.slice(WECHAT_PREFIX.length).trim()
      : text;
    if (stripped) texts.push(stripped);
  }
  if (texts.length === 0) return current;

  let block =
    "\n\nEarlier WeChat messages arrived after an aborted turn. Treat them as prior user messages, in order:";
  texts.forEach((text, i) => {
    block += `\n\n${i + 1}. ${text}`;
  });
  block += "\n\nCurrent WeChat message:";

  if (typeof current === "string") {
    return `${block} ${current}`;
  }
  const [first, ...rest] = current;
  if (first && first.type === "text") {
    return [{ type: "text", text: `${block} ${first.text}` }, ...rest];
  }
  return [{ type: "text", text: block }, ...current];
}

// ── system prompt suffix ───────────────────────────────────────────────

export const SYSTEM_PROMPT_SUFFIX = `

WeChat bridge extension is active.
- Messages forwarded from WeChat are prefixed with "[wechat]".
- WeChat does not render markdown — write plain text, use line breaks for structure.
- If a [wechat] user asked for a file or generated artifact, use the wechat_attach tool with the local file path so the extension can send it with your next final reply.
- Do not assume mentioning a local file path in plain text will send it to WeChat. Use wechat_attach.`;

export function systemPromptSuffixFor(prompt: string): string {
  return isWechatPrompt(prompt)
    ? `${SYSTEM_PROMPT_SUFFIX}\n- The current user message came from WeChat.`
    : SYSTEM_PROMPT_SUFFIX;
}

// ── inbound command classification ────────────────────────────────────

export type WechatCommand =
  | "stop"
  | "compact"
  | "status"
  | "help"
  | "new"
  | null;

/** Classify an inbound WeChat text message as a bridge command, or null for a normal turn. */
export function classifyCommand(rawText: string): WechatCommand {
  const lower = rawText.trim().toLowerCase();
  if (lower === "stop" || lower === "/stop") return "stop";
  if (lower === "/compact") return "compact";
  if (lower === "/status") return "status";
  if (lower === "/help") return "help";
  if (lower === "/new") return "new";
  return null;
}

/** One-line, length-capped preview of an inbound message, for logs (never logs full sensitive text). */
export function textPreviewFor(msg: {
  text?: string | null;
  type: string;
}): string {
  const text = msg.text?.trim();
  if (!text) return `[${msg.type}]`;
  const oneLine = text.replace(/\s+/g, " ");
  return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
}

// ── graceful shutdown ──────────────────────────────────────────────────

/** Minimal bot surface needed for graceful shutdown. */
export interface Stoppable {
  stop(): void;
}

/**
 * Stop the bot, then await the promise returned by bot.start() (which only resolves after
 * the poll loop stops and notifyStop completes — see docs/adr/0002-shutdown-stays-in-extension.md).
 */
export async function gracefulStop(
  bot: Stoppable | null,
  startPromise: Promise<void> | null,
): Promise<void> {
  if (!bot) return;
  bot.stop();
  if (startPromise) {
    try {
      await startPromise;
    } catch {
      /* swallow — the poll loop's own error handling already reported it */
    }
  }
}

// ── token formatting (for /status) ─────────────────────────────────────

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}
