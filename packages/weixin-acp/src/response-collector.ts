import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { logger, type ChatResponse } from "weixin-agent-sdk";
import type { SessionNotification } from "@agentclientprotocol/sdk";

const ACP_MEDIA_OUT_DIR = path.join(os.tmpdir(), "weixin-agent/media/acp-out");
const TOOL_CALL_INPUT_LIMIT = 120;
const NESTED_VALUE_LIMIT = 48;
const OBJECT_ENTRY_LIMIT = 8;
const ARRAY_ITEM_LIMIT = 4;
const RAW_INPUT_PARSE_DEPTH = 3;
const TOOL_CALL_SINGLE_LINE_LIMIT = 160;

/** Parse rawInput into a JS value if possible. */
function parseRawInput(rawInput: unknown): unknown {
  if (rawInput == null || typeof rawInput !== "string") return rawInput;

  let current: unknown = rawInput;
  for (let i = 0; i < RAW_INPUT_PARSE_DEPTH; i += 1) {
    if (typeof current !== "string") return current;
    const trimmed = current.trim();
    if (!trimmed) return rawInput;
    try {
      current = JSON.parse(trimmed);
    } catch {
      return i === 0 ? rawInput : current;
    }
  }
  return current;
}

/** Truncate a single value for display. */
function truncateValue(text: string, limit: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= limit) return singleLine;
  return `${singleLine.slice(0, limit)}…`;
}

function summarizeValue(value: unknown, limit = TOOL_CALL_INPUT_LIMIT): unknown {
  if (value == null) return null;
  if (typeof value === "string") return truncateValue(value, limit);
  if (typeof value === "number" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    const items = value
      .slice(0, ARRAY_ITEM_LIMIT)
      .map((item) => summarizeValue(item, NESTED_VALUE_LIMIT));
    if (value.length > ARRAY_ITEM_LIMIT) {
      items.push(`… ${value.length - ARRAY_ITEM_LIMIT} more item(s)`);
    }
    return items;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const summarized: Record<string, unknown> = {};
    for (const [key, nested] of entries.slice(0, OBJECT_ENTRY_LIMIT)) {
      summarized[key] = summarizeValue(nested, NESTED_VALUE_LIMIT);
    }
    if (entries.length > OBJECT_ENTRY_LIMIT) {
      summarized.__truncated__ = `${entries.length - OBJECT_ENTRY_LIMIT} more field(s)`;
    }
    return summarized;
  }

  return truncateValue(String(value), limit);
}

function hasMeaningfulToolInput(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function stringifyToolInput(value: unknown, pretty: boolean): string {
  if (!hasMeaningfulToolInput(value)) return "";
  if (typeof value === "string") {
    return pretty ? value.trim() : truncateValue(value, TOOL_CALL_INPUT_LIMIT);
  }

  const summarized = summarizeValue(value);
  try {
    const json = JSON.stringify(summarized, null, pretty ? 2 : 0);
    if (json != null) return json;
  } catch {
    // Fall through to string conversion below.
  }

  return pretty ? String(value) : truncateValue(String(value), TOOL_CALL_INPUT_LIMIT);
}

function sanitizeCodeFenceContent(text: string): string {
  return text.replace(/```/g, "``\u200b`");
}

function toBashCodeBlock(text: string): string {
  return `\`\`\`bash\n${sanitizeCodeFenceContent(text)}\n\`\`\``;
}

function serializeForLog(value: unknown): string {
  if (value == null) return "null";
  if (typeof value === "string") return value;
  try {
    const json = JSON.stringify(value);
    if (json != null) return json;
  } catch {
    // Fall through to string conversion.
  }
  return String(value);
}

function previewForLog(value: unknown): string {
  return truncateValue(serializeForLog(value), TOOL_CALL_INPUT_LIMIT);
}

function formatToolCall(title: string, rawInput: unknown): string {
  const parsed = parseRawInput(rawInput);
  const inlineInput = stringifyToolInput(parsed, false);
  const inline = inlineInput ? `${title} ${inlineInput}` : title;

  if (!inline.includes("\n") && inline.length <= TOOL_CALL_SINGLE_LINE_LIMIT) {
    return toBashCodeBlock(inline);
  }

  const blockInput = stringifyToolInput(parsed, true);
  return toBashCodeBlock(blockInput ? `${title}\n${blockInput}` : title);
}

function shouldEmitToolCall(update: { title?: string | null; rawInput?: unknown; status?: string | null }): boolean {
  const parsed = parseRawInput(update.rawInput);
  if (hasMeaningfulToolInput(parsed)) return true;

  const title = update.title?.trim();
  if (!title) return false;
  if (title.includes("`") || /\s/.test(title) || /[\/\\.=:-]/.test(title)) return true;

  return update.status !== "in_progress";
}

function isImageContent(value: unknown): value is { type: "image"; data: string; mimeType: string } {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { type?: unknown }).type === "image" &&
      typeof (value as { data?: unknown }).data === "string" &&
      typeof (value as { mimeType?: unknown }).mimeType === "string",
  );
}

function findImageInToolContent(content: unknown): { base64: string; mimeType: string } | null {
  if (!Array.isArray(content)) return null;

  for (const item of content) {
    if (
      item &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "content" &&
      isImageContent((item as { content?: unknown }).content)
    ) {
      const image = (item as { content: { data: string; mimeType: string } }).content;
      return { base64: image.data, mimeType: image.mimeType };
    }
  }

  return null;
}

/**
 * Collects sessionUpdate notifications for a single prompt round-trip
 * and converts the accumulated result into a ChatResponse.
 *
 * When verbose mode is active (onToolCall provided), text accumulated
 * before a tool_call is included in the verbose batch and excluded from
 * the final response text to avoid duplication.
 */
export class ResponseCollector {
  private textChunks: string[] = [];
  private imageData: { base64: string; mimeType: string } | null = null;
  private emittedToolCallIds = new Set<string>();

  /** Text chunks not yet pushed to onToolCall. */
  private pendingTextChunks: string[] = [];
  /** Number of raw text characters already emitted via onToolCall. */
  private verboseSentLength = 0;

  constructor(private onToolCall?: (message: string) => Promise<void>) {}

  /**
   * Feed a sessionUpdate notification into the collector.
   */
  async handleUpdate(notification: SessionNotification): Promise<void> {
    const update = notification.update;

    if (update.sessionUpdate === "agent_message_chunk") {
      const content = update.content;

      if (content.type === "text") {
        this.textChunks.push(content.text);
        this.pendingTextChunks.push(content.text);
      } else if (content.type === "image") {
        this.imageData = {
          base64: content.data,
          mimeType: content.mimeType,
        };
      }
      return;
    }

    if (update.sessionUpdate === "tool_call") {
      const parsedInput = parseRawInput(update.rawInput);
      const formattedToolCall = formatToolCall(update.title, update.rawInput);
      const shouldEmit = shouldEmitToolCall(update);
      logger.info(
        `[acp-tool-call] title=${update.title ?? "tool"} toolCallId=${update.toolCallId ?? "unknown"} status=${update.status ?? "unknown"} raw=${serializeForLog(update.rawInput)} parsed=${serializeForLog(parsedInput)} emit=${shouldEmit} rendered=${previewForLog(formattedToolCall)}`,
      );
      if (!shouldEmit) {
        return;
      }
      if (update.toolCallId && this.emittedToolCallIds.has(update.toolCallId)) {
        return;
      }
      if (update.toolCallId) {
        this.emittedToolCallIds.add(update.toolCallId);
      }
      if (this.onToolCall) {
        // Include any pending text that preceded this tool call.
        const pendingTextRaw = this.pendingTextChunks.join("");
        const pendingText = pendingTextRaw.trim();
        this.pendingTextChunks = [];
        const parts: string[] = [];
        if (pendingTextRaw) {
          this.verboseSentLength += pendingTextRaw.length;
        }
        if (pendingText) {
          parts.push(pendingText);
        }
        parts.push(formattedToolCall);
        await this.onToolCall(parts.join("\n"));
      }
      return;
    }

    if (update.sessionUpdate === "tool_call_update") {
      const image = findImageInToolContent(update.content);
      if (image) {
        this.imageData = image;
      }
    }
  }

  /**
   * Build a ChatResponse from all collected chunks.
   * Text already sent via onToolCall (verbose) is excluded to avoid duplication.
   */
  async toResponse(): Promise<ChatResponse> {
    const response: ChatResponse = {};

    // Full text minus what was already sent via verbose
    const fullText = this.textChunks.join("");
    const remaining = fullText.slice(this.verboseSentLength);
    if (remaining.trim()) {
      response.text = remaining;
    }

    if (this.imageData) {
      await fs.mkdir(ACP_MEDIA_OUT_DIR, { recursive: true });
      const ext = this.imageData.mimeType.split("/")[1] ?? "png";
      const filename = `${crypto.randomUUID()}.${ext}`;
      const filePath = path.join(ACP_MEDIA_OUT_DIR, filename);
      await fs.writeFile(filePath, Buffer.from(this.imageData.base64, "base64"));
      response.media = { type: "image", url: filePath };
    }

    return response;
  }
}
