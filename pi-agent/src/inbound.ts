import type { IncomingMessage, DownloadedMedia } from "@wechatbot/wechatbot";
import { writeFile, mkdtemp } from "node:fs/promises";
import { join, extname } from "node:path";
import { tmpdir } from "node:os";
import type { PiContent } from "./bridge-state.js";

/** Minimal bot surface needed to build pi content from an inbound message. */
export interface Downloader {
    download(msg: IncomingMessage): Promise<DownloadedMedia | null>;
}

const TEXT_EXTENSIONS = new Set([
    ".txt",
    ".md",
    ".csv",
    ".json",
    ".xml",
    ".html",
    ".yaml",
    ".yml",
    ".toml",
    ".log",
    ".py",
    ".js",
    ".ts",
    ".go",
    ".rs",
    ".java",
    ".c",
    ".cpp",
    ".h",
]);

/** Build the pi user message content for an inbound WeChat message. */
export async function buildPiContent(
    msg: IncomingMessage,
    bot: Downloader,
): Promise<PiContent> {
    switch (msg.type) {
        case "text":
            return msg.text || "[empty message]";

        case "image": {
            const media = await bot.download(msg);
            if (!media) return "[Image received but could not be downloaded]";

            const content: PiContent = [];
            content.push({
                type: "text",
                text:
                    msg.text === "[image]"
                        ? "User sent an image from WeChat:"
                        : msg.text,
            });
            content.push({
                type: "image",
                data: media.data.toString("base64"),
                mimeType: "image/jpeg",
            });
            return content;
        }

        case "voice": {
            const voice = msg.voices[0];
            if (voice?.text)
                return `[Voice message, transcribed]: ${voice.text}`;

            const media = await bot.download(msg);
            if (media) {
                return `[Voice message received (${media.format}, ${media.data.length} bytes). No transcription available — please ask the user to type their message.]`;
            }
            return "[Voice message received but could not be downloaded]";
        }

        case "file": {
            const file = msg.files[0];
            const fileName = file?.fileName ?? "unknown file";
            const fileSize = file?.size
                ? ` (${formatFileSize(file.size)})`
                : "";

            if (TEXT_EXTENSIONS.has(extname(fileName).toLowerCase())) {
                try {
                    const media = await bot.download(msg);
                    if (media) {
                        const text = media.data.toString("utf-8");
                        const truncated =
                            text.length > 10000
                                ? text.slice(0, 10000) + "\n... [truncated]"
                                : text;
                        return `[File: ${fileName}${fileSize}]\n\n\`\`\`\n${truncated}\n\`\`\``;
                    }
                } catch {
                    /* fall through */
                }
            }
            return `[File received: ${fileName}${fileSize}. To process this file, ask the user to share its content as text.]`;
        }

        case "video": {
            const video = msg.videos[0];
            const duration = video?.durationMs
                ? ` (${Math.round(video.durationMs / 1000)}s)`
                : "";
            try {
                const media = await bot.download(msg);
                if (media) {
                    const tmpDir = await mkdtemp(
                        join(tmpdir(), "wechat-video-"),
                    );
                    const videoPath = join(tmpDir, "video.mp4");
                    await writeFile(videoPath, media.data);
                    return `[Video received${duration}, saved to: ${videoPath}. You can access this file for processing.]`;
                }
            } catch {
                /* fall through */
            }
            return `[Video received${duration} but could not be downloaded.]`;
        }

        default:
            return `[${msg.type} message received — not supported yet]`;
    }
}

export function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
