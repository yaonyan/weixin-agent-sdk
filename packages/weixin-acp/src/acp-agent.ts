import type { Agent, ChatRequest, ChatResponse } from "weixin-agent-sdk";
import type { SessionId } from "@agentclientprotocol/sdk";

import type { AcpAgentOptions } from "./types.js";
import { AcpConnection } from "./acp-connection.js";
import { convertRequestToContentBlocks } from "./content-converter.js";
import { ResponseCollector } from "./response-collector.js";

function log(msg: string) {
  console.log(`[acp] ${msg}`);
}

/**
 * Agent adapter that bridges ACP (Agent Client Protocol) agents
 * to the weixin-agent-sdk Agent interface.
 */
export class AcpAgent implements Agent {
  private connection: AcpConnection;
  private sessions = new Map<string, SessionId>();
  private options: AcpAgentOptions;
  private currentProfileName?: string;

  constructor(options: AcpAgentOptions, profileName?: string) {
    this.options = options;
    this.currentProfileName = profileName;
    this.connection = this.createConnection(options);
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const conn = await this.connection.ensureReady();

    // Get or create an ACP session for this conversation
    const sessionId = await this.getOrCreateSession(request.conversationId, conn);

    // Convert the ChatRequest to ACP ContentBlock[]
    const blocks = await convertRequestToContentBlocks(request);
    if (blocks.length === 0) {
      return { text: "" };
    }

    // Register a collector, send the prompt, then gather the response
    const preview = request.text?.slice(0, 50) || (request.media ? `[${request.media.type}]` : "");
    log(`prompt: "${preview}" (session=${sessionId})`);

    const collector = new ResponseCollector(request.onToolCall);
    this.connection.registerCollector(sessionId, collector);
    let promptResponse: { stopReason?: string } | undefined;
    try {
      promptResponse = await conn.prompt({ sessionId, prompt: blocks });
    } finally {
      this.connection.unregisterCollector(sessionId);
    }

    const response = await collector.toResponse();
    if (promptResponse?.stopReason === "cancelled") {
      response.cancelled = true;
    }
    log(`response: ${response.text?.slice(0, 80) ?? "[no text]"}${response.media ? " +media" : ""}${response.cancelled ? " (cancelled)" : ""}`);
    return response;
  }

  private async getOrCreateSession(
    conversationId: string,
    conn: Awaited<ReturnType<AcpConnection["ensureReady"]>>,
  ): Promise<SessionId> {
    const existing = this.sessions.get(conversationId);
    if (existing) return existing;

    log(`creating new session for conversation=${conversationId}`);
    const res = await conn.newSession({
      cwd: this.options.cwd ?? process.cwd(),
      mcpServers: this.options.mcpServers ?? [],
    });
    log(`session created: ${res.sessionId}, cwd: ${this.options.cwd ?? process.cwd()}`);
    this.sessions.set(conversationId, res.sessionId);
    return res.sessionId;
  }

  /**
   * Switch to a different ACP agent profile at runtime.
   * Disposes the current subprocess and connection; the next chat() call
   * will lazily start a new subprocess with the given options.
   */
  async switchProfile(name: string, options: AcpAgentOptions): Promise<void> {
    log(`switching profile: ${this.currentProfileName ?? "(none)"} → ${name}`);
    this.connection.dispose();
    this.sessions.clear();
    this.options = options;
    this.currentProfileName = name;
    this.connection = this.createConnection(options);
  }

  private createConnection(options: AcpAgentOptions): AcpConnection {
    return new AcpConnection(options, () => {
      log("subprocess exited, clearing session cache");
      this.sessions.clear();
    });
  }

  /** Get the name of the currently active profile. */
  get profileName(): string | undefined {
    return this.currentProfileName;
  }

  /**
   * Cancel the active prompt turn for a conversation.
   * Sends a session/cancel notification to the ACP agent.
   */
  async stop(conversationId: string): Promise<void> {
    const sessionId = this.sessions.get(conversationId);
    if (!sessionId) {
      log(`stop: no active session for conversation=${conversationId}`);
      return;
    }
    log(`stop: cancelling conversation=${conversationId} (session=${sessionId})`);
    await this.connection.cancelSession(sessionId);
  }

  /**
   * Clear/reset the session for a given conversation.
   * The next message will automatically create a fresh session.
   */
  clearSession(conversationId: string): void {
    const sessionId = this.sessions.get(conversationId);
    if (sessionId) {
      log(`clearing session for conversation=${conversationId} (session=${sessionId})`);
      this.connection.unregisterCollector(sessionId);
      this.sessions.delete(conversationId);
    }
  }

  /**
   * Restart the ACP subprocess and clear all cached sessions.
   */
  async restart(): Promise<void> {
    log("restarting ACP subprocess");
    this.sessions.clear();
    await this.connection.restart();
  }

  /**
   * Kill the ACP subprocess and clean up all sessions.
   */
  dispose(): void {
    this.sessions.clear();
    this.connection.dispose();
  }
}
