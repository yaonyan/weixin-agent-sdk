import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Agent, ChatRequest } from "../agent/interface.js";
import { sendTyping } from "../api/api.js";
import type { WeixinMessage, MessageItem } from "../api/types.js";
import { MessageItemType, TypingStatus } from "../api/types.js";
import { downloadRemoteImageToTemp } from "../cdn/upload.js";
import { downloadMediaFromItem } from "../media/media-download.js";
import { getExtensionFromMime } from "../media/mime.js";
import { logger } from "../util/logger.js";

import { setContextToken, bodyFromItemList, isMediaItem } from "./inbound.js";
import { sendWeixinErrorNotice } from "./error-notice.js";
import { sendWeixinMediaFile } from "./send-media.js";
import { markdownToPlainText, sendMessageWeixin } from "./send.js";
import { handleSlashCommand } from "./slash-commands.js";
import { isVerboseMode } from "./verbose-mode.js";

const MEDIA_TEMP_DIR = path.join(os.tmpdir(), "weixin-agent/media");

/** Minimum interval (ms) between consecutive verbose message sends. */
const TOOL_CALL_MIN_INTERVAL_MS = 30_000;
/** Short debounce window (ms) before sending the first buffered message. */
const TOOL_CALL_FIRST_SEND_DELAY_MS = 2_000;

/**
 * Buffers verbose tool-call messages and sends them with rate-limiting:
 *
 *   - First message: short debounce, then send immediately.
 *   - Subsequent messages: buffer until 30s has elapsed since the last
 *     send, then flush. If 30s already passed, send right away.
 *   - This ensures steady updates every ~30s even during continuous
 *     activity — messages never pile up indefinitely.
 *   - `flush()` forces immediate send of anything remaining.
 *
 * Timeline example:
 *   0s   tool call 1  → 2s debounce → 2s: send
 *   5s   tool call 2  → buffer (last send was 3s ago)
 *   12s  tool call 3  → buffer (last send was 10s ago)
 *   32s  (30s since last send) → flush 2+3
 *   40s  tool call 4  → buffer (8s since last send)
 *   62s  (30s since last send) → flush 4
 */
class ThrottledToolCallSender {
  private buffer: string[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private intervalTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSendAt = 0;
  private sendChain: Promise<void> = Promise.resolve();

  constructor(
    private send: (text: string) => Promise<unknown>,
    private log: (msg: string) => void,
  ) {}

  /** Called by the agent for each tool-call event. */
  push(text: string): void {
    this.buffer.push(text);

    if (this.lastSendAt === 0) {
      // No message sent yet — first message gets a short debounce
      if (!this.debounceTimer) {
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = undefined;
          void this.doFlush();
        }, TOOL_CALL_FIRST_SEND_DELAY_MS);
      }
      return;
    }

    // Already sent at least once — check if 30s interval has elapsed
    const elapsed = Date.now() - this.lastSendAt;
    if (elapsed >= TOOL_CALL_MIN_INTERVAL_MS) {
      // Enough time passed — send immediately
      void this.doFlush();
    } else {
      // Not yet — schedule a flush when the interval completes
      const remaining = TOOL_CALL_MIN_INTERVAL_MS - elapsed;
      this.scheduleInterval(remaining);
    }
  }

  /** Schedule a flush after `remainingMs` milliseconds. */
  private scheduleInterval(remainingMs: number): void {
    if (this.intervalTimer) clearTimeout(this.intervalTimer);
    this.intervalTimer = setTimeout(() => {
      this.intervalTimer = undefined;
      void this.doFlush();
    }, remainingMs);
  }

  /** Unconditionally send whatever is buffered and wait for prior sends to finish. */
  private doFlush(): Promise<void> {
    if (this.buffer.length === 0) return this.sendChain;

    const batch = this.buffer.join("\n");
    this.buffer = [];
    this.lastSendAt = Date.now();

    this.sendChain = this.sendChain
      .then(async () => {
        await this.send(batch);
      })
      .catch((err) => {
        this.log(`[weixin] throttled tool-call send failed: ${String(err)}`);
      });

    return this.sendChain;
  }

  /** Flush any remaining messages and clear all timers. Call when agent.chat() completes. */
  async flush(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.intervalTimer) {
      clearTimeout(this.intervalTimer);
      this.intervalTimer = undefined;
    }
    await this.doFlush();
  }
}

/** Save a buffer to a temporary file, returning the file path. */
async function saveMediaBuffer(
  buffer: Buffer,
  contentType?: string,
  subdir?: string,
  _maxBytes?: number,
  originalFilename?: string,
): Promise<{ path: string }> {
  const dir = path.join(MEDIA_TEMP_DIR, subdir ?? "");
  await fs.mkdir(dir, { recursive: true });
  let ext = ".bin";
  if (originalFilename) {
    ext = path.extname(originalFilename) || ".bin";
  } else if (contentType) {
    ext = getExtensionFromMime(contentType);
  }
  const name = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`;
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, buffer);
  return { path: filePath };
}

/** Dependencies for processOneMessage. */
export type ProcessMessageDeps = {
  accountId: string;
  agent: Agent;
  baseUrl: string;
  cdnBaseUrl: string;
  token?: string;
  typingTicket?: string;
  log: (msg: string) => void;
  errLog: (msg: string) => void;
  /** ACP profile management callbacks (optional, for ACP-aware agents). */
  acp?: {
    profileName?: string;
    defaultProfileName?: string;
    profileNames?: string[];
    onSwitch?: (profileName: string) => Promise<string | undefined>;
    onAdd?: (name: string, command: string, args: string[]) => Promise<string | undefined>;
    onRm?: (name: string) => Promise<string | undefined>;
    onRestart?: () => Promise<void>;
  };
};

/** Extract raw text from item_list (for slash command detection). */
function extractTextBody(itemList?: MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      return String(item.text_item.text);
    }
  }
  return "";
}

/** Find the first downloadable media item from a message. */
function findMediaItem(itemList?: MessageItem[]): MessageItem | undefined {
  if (!itemList?.length) return undefined;

  const hasDownloadableMedia = (m?: { encrypt_query_param?: string; full_url?: string }) =>
    m?.encrypt_query_param || m?.full_url;

  // Direct media: IMAGE > VIDEO > FILE > VOICE (skip voice with transcription)
  const direct =
    itemList.find(
      (i) => i.type === MessageItemType.IMAGE && hasDownloadableMedia(i.image_item?.media),
    ) ??
    itemList.find(
      (i) => i.type === MessageItemType.VIDEO && hasDownloadableMedia(i.video_item?.media),
    ) ??
    itemList.find(
      (i) => i.type === MessageItemType.FILE && hasDownloadableMedia(i.file_item?.media),
    ) ??
    itemList.find(
      (i) =>
        i.type === MessageItemType.VOICE &&
        hasDownloadableMedia(i.voice_item?.media) &&
        !i.voice_item?.text,
    );
  if (direct) return direct;

  // Quoted media: check ref_msg
  const refItem = itemList.find(
    (i) =>
      i.type === MessageItemType.TEXT &&
      i.ref_msg?.message_item &&
      isMediaItem(i.ref_msg.message_item),
  );
  return refItem?.ref_msg?.message_item ?? undefined;
}

/**
 * Process a single inbound message:
 *   slash command check → download media → call agent → send reply.
 */
export async function processOneMessage(
  full: WeixinMessage,
  deps: ProcessMessageDeps,
): Promise<void> {
  const receivedAt = Date.now();
  const textBody = extractTextBody(full.item_list);

  // --- Slash commands ---
  if (textBody.startsWith("/")) {
    const conversationId = full.from_user_id ?? "";
    const slashResult = await handleSlashCommand(
      textBody,
      {
        to: conversationId,
        contextToken: full.context_token,
        baseUrl: deps.baseUrl,
        token: deps.token,
        accountId: deps.accountId,
        log: deps.log,
        errLog: deps.errLog,
        onClear: () => deps.agent.clearSession?.(conversationId),
        onRestart: deps.acp?.onRestart ?? (deps.agent.restart
          ? () => deps.agent.restart!()
          : undefined),
        onAcpSwitch: deps.acp?.onSwitch,
        onAcpAdd: deps.acp?.onAdd,
        onAcpRm: deps.acp?.onRm,
        acpProfileName: deps.acp?.profileName,
        acpDefaultProfileName: deps.acp?.defaultProfileName,
        acpProfileNames: deps.acp?.profileNames,
      },
      receivedAt,
      full.create_time_ms,
    );
    if (slashResult.handled) return;
  }

  // --- Store context token ---
  const contextToken = full.context_token;
  if (contextToken) {
    setContextToken(deps.accountId, full.from_user_id ?? "", contextToken);
  }

  // --- Download media ---
  let media: ChatRequest["media"];
  const mediaItem = findMediaItem(full.item_list);
  if (mediaItem) {
    try {
      const downloaded = await downloadMediaFromItem(mediaItem, {
        cdnBaseUrl: deps.cdnBaseUrl,
        saveMedia: saveMediaBuffer,
        log: deps.log,
        errLog: deps.errLog,
        label: "inbound",
      });
      if (downloaded.decryptedPicPath) {
        media = { type: "image", filePath: downloaded.decryptedPicPath, mimeType: "image/*" };
      } else if (downloaded.decryptedVideoPath) {
        media = { type: "video", filePath: downloaded.decryptedVideoPath, mimeType: "video/mp4" };
      } else if (downloaded.decryptedFilePath) {
        media = {
          type: "file",
          filePath: downloaded.decryptedFilePath,
          mimeType: downloaded.fileMediaType ?? "application/octet-stream",
        };
      } else if (downloaded.decryptedVoicePath) {
        media = {
          type: "audio",
          filePath: downloaded.decryptedVoicePath,
          mimeType: downloaded.voiceMediaType ?? "audio/wav",
        };
      }
    } catch (err) {
      logger.error(`media download failed: ${String(err)}`);
    }
  }

  // --- Build ChatRequest ---
  const to = full.from_user_id ?? "";
  let throttledSender: ThrottledToolCallSender | undefined;
  const request: ChatRequest = {
    conversationId: to,
    text: bodyFromItemList(full.item_list),
    media,
    onToolCall: isVerboseMode(deps.accountId) && contextToken
      ? async (text: string) => {
          // Lazily create the throttled sender on first call
          if (!throttledSender) {
            throttledSender = new ThrottledToolCallSender(
              (batch) => sendMessageWeixin({
                to,
                text: batch,
                opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken },
              }),
              deps.log,
            );
          }
          throttledSender.push(text);
        }
      : undefined,
  };
  let typingTimer: ReturnType<typeof setInterval> | undefined;
  const startTyping = () => {
    if (!deps.typingTicket) return;
    sendTyping({
      baseUrl: deps.baseUrl,
      token: deps.token,
      body: {
        ilink_user_id: to,
        typing_ticket: deps.typingTicket,
        status: TypingStatus.TYPING,
      },
    }).catch(() => {});
  };
  if (deps.typingTicket) {
    startTyping();
    typingTimer = setInterval(startTyping, 10_000);
  }

  // --- Call agent & send reply ---
  try {
    const response = await deps.agent.chat(request);

    // Flush any remaining throttled tool-call messages BEFORE sending the final
    // reply, so that intermediate updates always arrive before the final answer.
    await throttledSender?.flush();

    if (response.media) {
      let filePath: string;
      const mediaUrl = response.media.url;
      if (mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://")) {
        filePath = await downloadRemoteImageToTemp(
          mediaUrl,
          path.join(MEDIA_TEMP_DIR, "outbound"),
        );
      } else {
        filePath = path.isAbsolute(mediaUrl) ? mediaUrl : path.resolve(mediaUrl);
      }
      await sendWeixinMediaFile({
        filePath,
        to,
        text: response.text ? markdownToPlainText(response.text) : "",
        opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken },
        cdnBaseUrl: deps.cdnBaseUrl,
      });
    } else if (response.text) {
      await sendMessageWeixin({
        to,
        text: markdownToPlainText(response.text),
        opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken },
      });
    }

  } catch (err) {
    logger.error(`processOneMessage: agent or send failed: ${err instanceof Error ? err.stack ?? err.message : JSON.stringify(err)}`);
    await throttledSender?.flush();
    await sendWeixinErrorNotice({
      to,
      contextToken,
      message: `⚠️ 处理消息失败：${err instanceof Error ? err.message : JSON.stringify(err)}`,
      baseUrl: deps.baseUrl,
      token: deps.token,
      errLog: deps.errLog,
    });
  } finally {
    // --- Flush any remaining throttled tool-call messages ---
    await throttledSender?.flush();
    // --- Typing indicator (cancel) ---
    if (typingTimer) clearInterval(typingTimer);
    if (deps.typingTicket) {
      sendTyping({
        baseUrl: deps.baseUrl,
        token: deps.token,
        body: {
          ilink_user_id: to,
          typing_ticket: deps.typingTicket,
          status: TypingStatus.CANCEL,
        },
      }).catch(() => {});
    }
  }
}
