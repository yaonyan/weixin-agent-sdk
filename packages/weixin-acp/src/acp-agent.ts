import type { Agent, ChatRequest, ChatResponse } from "weixin-agent-sdk";
import type { NewSessionResponse, SessionId, SessionNotification } from "@agentclientprotocol/sdk";

import type { AcpAgentOptions, AcpSessionSnapshot } from "./types.js";
import { AcpConnection } from "./acp-connection.js";
import { convertRequestToContentBlocks } from "./content-converter.js";
import { ResponseCollector } from "./response-collector.js";

function log(msg: string) {
  console.log(`[acp] ${msg}`);
}

/** Maximum time (ms) to wait for a single prompt round-trip before giving up. */
const PROMPT_TIMEOUT_MS = 10 * 60_000; // 10 minutes

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label}: timed out after ${ms / 1000}s`));
    }, ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

type SessionEntry = {
  sessionId: SessionId;
  snapshot: AcpSessionSnapshot;
};

function cloneSnapshot(snapshot: AcpSessionSnapshot): AcpSessionSnapshot {
  return {
    sessionId: snapshot.sessionId,
    currentModeId: snapshot.currentModeId,
    currentModelId: snapshot.currentModelId,
    availableModes: snapshot.availableModes?.map((mode) => ({ ...mode })),
    availableModels: snapshot.availableModels?.map((model) => ({ ...model })),
  };
}

function snapshotFromSessionResponse(response: Pick<NewSessionResponse, "sessionId" | "modes" | "models">): AcpSessionSnapshot {
  return {
    sessionId: response.sessionId,
    currentModeId: response.modes?.currentModeId,
    availableModes: response.modes?.availableModes?.map((mode) => ({
      id: mode.id,
      name: mode.name,
      description: mode.description,
    })),
    currentModelId: response.models?.currentModelId,
    availableModels: response.models?.availableModels?.map((model) => ({
      modelId: model.modelId,
      name: model.name,
      description: model.description,
    })),
  };
}

/**
 * Agent adapter that bridges ACP (Agent Client Protocol) agents
 * to the weixin-agent-sdk Agent interface.
 */
export class AcpAgent implements Agent {
  private connection: AcpConnection;
  private sessions = new Map<string, SessionEntry>();
  private options: AcpAgentOptions;
  private currentProfileName?: string;
  private coldStartGreetingClaimed = false;

  constructor(options: AcpAgentOptions, profileName?: string) {
    this.options = options;
    this.currentProfileName = profileName;
    this.connection = this.createConnection(options);
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    let conn;
    try {
      conn = await this.connection.ensureReady();
    } catch (err) {
      this.coldStartGreetingClaimed = false;
      throw err;
    }

    // Get or create an ACP session for this conversation
    const entry = await this.getOrCreateSessionEntry(request.conversationId, conn);
    const sessionId = entry.sessionId;

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
      promptResponse = await withTimeout(
        conn.prompt({ sessionId, prompt: blocks }),
        PROMPT_TIMEOUT_MS,
        "acp prompt",
      );
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

  private async getOrCreateSessionEntry(
    conversationId: string,
    conn: Awaited<ReturnType<AcpConnection["ensureReady"]>>,
  ): Promise<SessionEntry> {
    const existing = this.sessions.get(conversationId);
    if (existing) return existing;

    log(`creating new session for conversation=${conversationId}`);
    const res = await conn.newSession({
      cwd: this.options.cwd ?? process.cwd(),
      mcpServers: this.options.mcpServers ?? [],
    });
    log(`session created: ${res.sessionId}, cwd: ${this.options.cwd ?? process.cwd()}`);

    const entry: SessionEntry = {
      sessionId: res.sessionId,
      snapshot: snapshotFromSessionResponse(res),
    };
    this.sessions.set(conversationId, entry);
    return entry;
  }

  private updateSessionSnapshot(sessionId: SessionId, mutator: (snapshot: AcpSessionSnapshot) => void): void {
    for (const entry of this.sessions.values()) {
      if (entry.sessionId !== sessionId) continue;
      mutator(entry.snapshot);
      return;
    }
  }

  private async handleSessionUpdate(notification: SessionNotification): Promise<void> {
    const update = notification.update;
    if (update.sessionUpdate === "current_mode_update") {
      this.updateSessionSnapshot(notification.sessionId, (snapshot) => {
        snapshot.currentModeId = update.currentModeId;
      });
    }
  }

  /**
   * Return the current session snapshot for a conversation.
   * Creates the session lazily if it does not exist yet.
   */
  async getSessionSnapshot(conversationId: string): Promise<AcpSessionSnapshot> {
    const conn = await this.connection.ensureReady();
    const entry = await this.getOrCreateSessionEntry(conversationId, conn);
    return cloneSnapshot(entry.snapshot);
  }

  /**
   * Set the runtime ACP model for a conversation session.
   */
  async setSessionModel(conversationId: string, modelId: string): Promise<AcpSessionSnapshot | undefined> {
    const conn = await this.connection.ensureReady();
    const entry = await this.getOrCreateSessionEntry(conversationId, conn);
    const trimmedModelId = modelId.trim();
    if (!trimmedModelId) return undefined;

    const availableModels = entry.snapshot.availableModels;
    if (availableModels?.length && !availableModels.some((model) => model.modelId === trimmedModelId)) {
      return undefined;
    }

    await conn.unstable_setSessionModel({ sessionId: entry.sessionId, modelId: trimmedModelId });
    entry.snapshot.currentModelId = trimmedModelId;
    return cloneSnapshot(entry.snapshot);
  }

  /**
   * Set the runtime ACP mode for a conversation session.
   */
  async setSessionMode(conversationId: string, modeId: string): Promise<AcpSessionSnapshot | undefined> {
    const conn = await this.connection.ensureReady();
    const entry = await this.getOrCreateSessionEntry(conversationId, conn);
    const trimmedModeId = modeId.trim();
    if (!trimmedModeId) return undefined;

    const availableModes = entry.snapshot.availableModes;
    if (availableModes?.length && !availableModes.some((mode) => mode.id === trimmedModeId)) {
      return undefined;
    }

    await conn.setSessionMode({ sessionId: entry.sessionId, modeId: trimmedModeId });
    entry.snapshot.currentModeId = trimmedModeId;
    return cloneSnapshot(entry.snapshot);
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
    this.coldStartGreetingClaimed = false;
    this.options = options;
    this.currentProfileName = name;
    this.connection = this.createConnection(options);
  }

  claimColdStartGreeting(): boolean {
    if (this.connection.isReady() || this.connection.isInitializing()) {
      return false;
    }
    if (this.coldStartGreetingClaimed) {
      return false;
    }
    this.coldStartGreetingClaimed = true;
    return true;
  }

  private createConnection(options: AcpAgentOptions): AcpConnection {
    return new AcpConnection(options, () => {
      log("subprocess exited, clearing session cache");
      this.sessions.clear();
      this.coldStartGreetingClaimed = false;
    }, (notification) => this.handleSessionUpdate(notification));
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
    const entry = this.sessions.get(conversationId);
    if (!entry) {
      log(`stop: no active session for conversation=${conversationId}`);
      return;
    }
    log(`stop: cancelling conversation=${conversationId} (session=${entry.sessionId})`);
    await this.connection.cancelSession(entry.sessionId);
  }

  /**
   * Clear/reset the session for a given conversation.
   * The next message will automatically create a fresh session.
   */
  clearSession(conversationId: string): void {
    const entry = this.sessions.get(conversationId);
    if (entry) {
      log(`clearing session for conversation=${conversationId} (session=${entry.sessionId})`);
      this.connection.unregisterCollector(entry.sessionId);
      this.sessions.delete(conversationId);
    }
  }

  /**
   * Restart the ACP subprocess and clear all cached sessions.
   */
  async restart(): Promise<void> {
    log("restarting ACP subprocess");
    this.sessions.clear();
    this.coldStartGreetingClaimed = false;
    await this.connection.restart();
  }

  /**
   * Kill the ACP subprocess and clean up all sessions.
   */
  dispose(): void {
    this.sessions.clear();
    this.coldStartGreetingClaimed = false;
    this.connection.dispose();
  }
}
