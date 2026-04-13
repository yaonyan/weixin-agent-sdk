import fs from "node:fs";
import path from "node:path";

import { logger } from "../util/logger.js";
import { generateId } from "../util/random.js";
import { resolveStateDir } from "../storage/state-dir.js";
import type { WeixinMessage, MessageItem } from "../api/types.js";
import { MessageItemType } from "../api/types.js";

// ---------------------------------------------------------------------------
// Context token store (in-process cache + disk persistence)
// ---------------------------------------------------------------------------

/**
 * contextToken is issued per-message by the Weixin getupdates API and must
 * be echoed verbatim in every outbound send.
 *
 * Tokens are cached in-memory for fast access AND persisted to disk so that
 * the bot can proactively send messages after a process restart (e.g. cold-start
 * greeting) without waiting for the user to send a message first.
 *
 * Disk path: ~/.openclaw/openclaw-weixin/context-tokens/{accountId}:{userId}.json
 * Token validity is roughly 24 hours (server-side).
 */
const contextTokenStore = new Map<string, string>();

function contextTokenKey(accountId: string, userId: string): string {
  return `${accountId}:${userId}`;
}

function resolveContextTokenDir(): string {
  return path.join(resolveStateDir(), "openclaw-weixin", "context-tokens");
}

function resolveContextTokenPath(key: string): string {
  // Replace colons with underscores for filesystem safety
  const safeKey = key.replace(/:/g, "_");
  return path.join(resolveContextTokenDir(), `${safeKey}.json`);
}

/** Persist a context token to disk (best-effort, never throws). */
function persistContextToken(key: string, token: string): void {
  try {
    const dir = resolveContextTokenDir();
    fs.mkdirSync(dir, { recursive: true });
    const filePath = resolveContextTokenPath(key);
    fs.writeFileSync(
      filePath,
      JSON.stringify({ token, savedAt: new Date().toISOString() }),
      "utf-8",
    );
  } catch (err) {
    logger.debug(`persistContextToken: failed for key=${key}: ${String(err)}`);
  }
}

/** Load a context token from disk (returns undefined if missing or stale). */
function loadPersistedContextToken(key: string): string | undefined {
  try {
    const filePath = resolveContextTokenPath(key);
    if (!fs.existsSync(filePath)) return undefined;
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as { token?: string; savedAt?: string };
    if (typeof data.token !== "string") return undefined;

    // Discard tokens older than 20 hours (server validity ~24h, leave margin)
    if (data.savedAt) {
      const age = Date.now() - new Date(data.savedAt).getTime();
      if (age > 20 * 60 * 60 * 1000) {
        logger.debug(`loadPersistedContextToken: expired for key=${key} (age=${Math.round(age / 3600000)}h)`);
        return undefined;
      }
    }

    return data.token;
  } catch {
    return undefined;
  }
}

/** Store a context token for a given account+user pair (memory + disk). */
export function setContextToken(accountId: string, userId: string, token: string): void {
  const k = contextTokenKey(accountId, userId);
  logger.debug(`setContextToken: key=${k}`);
  contextTokenStore.set(k, token);
  persistContextToken(k, token);
}

/** Retrieve the cached context token for a given account+user pair. */
export function getContextToken(accountId: string, userId: string): string | undefined {
  const k = contextTokenKey(accountId, userId);

  // Fast path: in-memory cache
  const memVal = contextTokenStore.get(k);
  if (memVal !== undefined) {
    logger.debug(`getContextToken: key=${k} found=true (memory)`);
    return memVal;
  }

  // Slow path: check disk (e.g. after process restart)
  const diskVal = loadPersistedContextToken(k);
  if (diskVal !== undefined) {
    // Warm the in-memory cache
    contextTokenStore.set(k, diskVal);
    logger.debug(`getContextToken: key=${k} found=true (disk)`);
    return diskVal;
  }

  logger.debug(`getContextToken: key=${k} found=false`);
  return undefined;
}

// ---------------------------------------------------------------------------
// Message ID generation
// ---------------------------------------------------------------------------

function generateMessageSid(): string {
  return generateId("openclaw-weixin");
}

/** Inbound context passed to the OpenClaw core pipeline (matches MsgContext shape). */
export type WeixinMsgContext = {
  Body: string;
  From: string;
  To: string;
  AccountId: string;
  OriginatingChannel: "openclaw-weixin";
  OriginatingTo: string;
  MessageSid: string;
  Timestamp?: number;
  Provider: "openclaw-weixin";
  ChatType: "direct";
  /** Set by monitor after resolveAgentRoute so dispatchReplyFromConfig uses the correct session. */
  SessionKey?: string;
  context_token?: string;
  MediaUrl?: string;
  MediaPath?: string;
  MediaType?: string;
  /** Raw message body for framework command authorization. */
  CommandBody?: string;
  /** Whether the sender is authorized to execute slash commands. */
  CommandAuthorized?: boolean;
};

/** Returns true if the message item is a media type (image, video, file, or voice). */
export function isMediaItem(item: MessageItem): boolean {
  return (
    item.type === MessageItemType.IMAGE ||
    item.type === MessageItemType.VIDEO ||
    item.type === MessageItemType.FILE ||
    item.type === MessageItemType.VOICE
  );
}

export function bodyFromItemList(itemList?: MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (!ref) return text;
      // Quoted media is passed as MediaPath; only include the current text as body.
      if (ref.message_item && isMediaItem(ref.message_item)) return text;
      // Build quoted context from both title and message_item content.
      const parts: string[] = [];
      if (ref.title) parts.push(ref.title);
      if (ref.message_item) {
        const refBody = bodyFromItemList([ref.message_item]);
        if (refBody) parts.push(refBody);
      }
      if (!parts.length) return text;
      return `[引用: ${parts.join(" | ")}]\n${text}`;
    }
    // 语音转文字：如果语音消息有 text 字段，直接使用文字内容
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return "";
}

export type WeixinInboundMediaOpts = {
  /** Local path to decrypted image file. */
  decryptedPicPath?: string;
  /** Local path to transcoded/raw voice file (.wav or .silk). */
  decryptedVoicePath?: string;
  /** MIME type for the voice file (e.g. "audio/wav" or "audio/silk"). */
  voiceMediaType?: string;
  /** Local path to decrypted file attachment. */
  decryptedFilePath?: string;
  /** MIME type for the file attachment (guessed from file_name). */
  fileMediaType?: string;
  /** Local path to decrypted video file. */
  decryptedVideoPath?: string;
};

/**
 * Convert a WeixinMessage from getUpdates to the inbound MsgContext for the core pipeline.
 * Media: only pass MediaPath (local file, after CDN download + decrypt).
 * We never pass MediaUrl — the upstream CDN URL is encrypted/auth-only.
 * Priority when multiple media types present: image > video > file > voice.
 */
export function weixinMessageToMsgContext(
  msg: WeixinMessage,
  accountId: string,
  opts?: WeixinInboundMediaOpts,
): WeixinMsgContext {
  const from_user_id = msg.from_user_id ?? "";
  const ctx: WeixinMsgContext = {
    Body: bodyFromItemList(msg.item_list),
    From: from_user_id,
    To: from_user_id,
    AccountId: accountId,
    OriginatingChannel: "openclaw-weixin",
    OriginatingTo: from_user_id,
    MessageSid: generateMessageSid(),
    Timestamp: msg.create_time_ms,
    Provider: "openclaw-weixin",
    ChatType: "direct",
  };
  if (msg.context_token) {
    ctx.context_token = msg.context_token;
  }

  if (opts?.decryptedPicPath) {
    ctx.MediaPath = opts.decryptedPicPath;
    ctx.MediaType = "image/*";
  } else if (opts?.decryptedVideoPath) {
    ctx.MediaPath = opts.decryptedVideoPath;
    ctx.MediaType = "video/mp4";
  } else if (opts?.decryptedFilePath) {
    ctx.MediaPath = opts.decryptedFilePath;
    ctx.MediaType = opts.fileMediaType ?? "application/octet-stream";
  } else if (opts?.decryptedVoicePath) {
    ctx.MediaPath = opts.decryptedVoicePath;
    ctx.MediaType = opts.voiceMediaType ?? "audio/wav";
  }

  return ctx;
}

/** Extract the context_token from an inbound WeixinMsgContext. */
export function getContextTokenFromMsgContext(ctx: WeixinMsgContext): string | undefined {
  return ctx.context_token;
}
