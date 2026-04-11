import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ChatResponse } from "weixin-agent-sdk";
import type { SessionNotification } from "@agentclientprotocol/sdk";

const ACP_MEDIA_OUT_DIR = path.join(os.tmpdir(), "weixin-agent/media/acp-out");
const TOOL_CALL_INPUT_LIMIT = 120;
const OBJECT_ENTRY_LIMIT = 8;
const ARRAY_ITEM_LIMIT = 5;

/** Parse rawInput into a JS value if possible. */
function parseRawInput(rawInput: unknown): unknown {
  if (rawInput == null) return null;
  if (typeof rawInput === "string") {
    const trimmed = rawInput.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return rawInput;
      }
    }
    return rawInput;
  }
  return rawInput;
}

/** Truncate a single value for display. */
function truncateValue(text: string, limit: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= limit) return singleLine;
  return `${singleLine.slice(0, limit)}…`;
}

function summarizeValue(value: unknown): string {
  if (value == null) return "(空)";
  if (typeof value === "string") return truncateValue(value, TOOL_CALL_INPUT_LIMIT);
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.slice(0, ARRAY_ITEM_LIMIT).map((item) => summarizeValue(item));
    const suffix = value.length > ARRAY_ITEM_LIMIT ? `, … 共${value.length}项` : "";
    return `[${items.join(", ")}${suffix}]`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    const parts = entries.slice(0, 3).map(([k, v]) => `${k}: ${summarizeValue(v)}`);
    const suffix = entries.length > 3 ? ", …" : "";
    return `{ ${parts.join(", ")}${suffix} }`;
  }

  return truncateValue(String(value), TOOL_CALL_INPUT_LIMIT);
}

function formatToolParams(obj: Record<string, unknown>): string {
  const entries = Object.entries(obj);
  if (entries.length === 0) return "- 参数: (无)";

  return entries
    .slice(0, OBJECT_ENTRY_LIMIT)
    .map(([key, value]) => `- ${key}: ${summarizeValue(value)}`)
    .concat(entries.length > OBJECT_ENTRY_LIMIT ? [`- … 其余 ${entries.length - OBJECT_ENTRY_LIMIT} 项已省略`] : [])
    .join("\n");
}

function formatToolCall(title: string, rawInput: unknown): string {
  const parsed = parseRawInput(rawInput);
  if (parsed == null) {
    return [`---`, `🔧 ${title}`, `---`].join("\n");
  }

  if (typeof parsed === "object" && !Array.isArray(parsed) && parsed !== null) {
    return [`---`, `🔧 ${title}`, formatToolParams(parsed as Record<string, unknown>), `---`].join("\n");
  }

  return [
    `---`,
    `🔧 ${title}`,
    `- 输入: ${summarizeValue(parsed)}`,
    `---`,
  ].join("\n");
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
  private seenToolCallIds = new Set<string>();

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
      if (this.seenToolCallIds.has(update.toolCallId)) {
        return;
      }
      this.seenToolCallIds.add(update.toolCallId);
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
        parts.push(formatToolCall(update.title, update.rawInput));
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
