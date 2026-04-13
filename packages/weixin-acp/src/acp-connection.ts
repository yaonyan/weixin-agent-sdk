import type { ChildProcess } from "node:child_process";
import { execSync } from "node:child_process";
import spawn from "cross-spawn";
import { Readable, Writable } from "node:stream";

import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import type { SessionId, SessionNotification } from "@agentclientprotocol/sdk";

import type { AcpAgentOptions } from "./types.js";
import { ResponseCollector } from "./response-collector.js";

function log(msg: string) {
  console.log(`[acp] ${msg}`);
}

function formatEnv(env?: Record<string, string>): string {
  if (!env || Object.keys(env).length === 0) return "(none)";
  return JSON.stringify(env);
}

function describeToolCall(update: {
  title?: string | null;
  kind?: string | null;
  toolCallId?: string;
}): string {
  return update.title ?? update.kind ?? update.toolCallId ?? "tool";
}

const isWindows = process.platform === "win32";

/**
 * Kill a child process and its entire process tree.
 * On Windows, `process.kill()` only kills the immediate process, leaving
 * grandchildren (e.g. MCP proxy nodes) orphaned. Use `taskkill /T` instead.
 */
function killProcessTree(proc: ChildProcess): void {
  const pid = proc.pid;
  if (pid == null) {
    proc.kill();
    return;
  }
  if (isWindows) {
    try {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore" });
    } catch {
      // Process may have already exited; fall back to normal kill.
      try { proc.kill(); } catch { /* already dead */ }
    }
  } else {
    try { proc.kill(); } catch { /* already dead */ }
  }
}

/**
 * Manages the ACP agent subprocess and ClientSideConnection lifecycle.
 */
export class AcpConnection {
  private process: ChildProcess | null = null;
  private connection: ClientSideConnection | null = null;
  private ready = false;
  private initPromise: Promise<ClientSideConnection> | null = null;
  private collectors = new Map<SessionId, ResponseCollector>();

  private onExit?: () => void;
  private onSessionUpdate?: (notification: SessionNotification) => Promise<void> | void;

  constructor(
    private options: AcpAgentOptions,
    onExit?: () => void,
    onSessionUpdate?: (notification: SessionNotification) => Promise<void> | void,
  ) {
    this.onExit = onExit;
    this.onSessionUpdate = onSessionUpdate;
  }

  registerCollector(sessionId: SessionId, collector: ResponseCollector): void {
    this.collectors.set(sessionId, collector);
  }

  unregisterCollector(sessionId: SessionId): void {
    this.collectors.delete(sessionId);
  }

  isReady(): boolean {
    return this.ready;
  }

  isInitializing(): boolean {
    return this.initPromise !== null;
  }

  /**
   * Ensure the subprocess is running and the connection is initialized.
   */
  async ensureReady(): Promise<ClientSideConnection> {
    if (this.ready && this.connection) {
      return this.connection;
    }
    // Guard against concurrent initialization: reuse the in-flight promise.
    if (this.initPromise) {
      return this.initPromise;
    }
    // Capture the promise reference so .finally() only clears if no newer
    // initPromise has been set (e.g. after dispose() + new ensureReady()).
    const promise = this._doInit().finally(() => {
      if (this.initPromise === promise) {
        this.initPromise = null;
      }
    });
    this.initPromise = promise;
    return this.initPromise;
  }

  private async _doInit(): Promise<ClientSideConnection> {
    const args = this.options.args ?? [];
    log(`profile env overrides: ${formatEnv(this.options.env)}`);
    log(`spawning: ${this.options.command} ${args.join(" ")} (cwd: ${this.options.cwd ?? process.cwd()})`);

    const proc = spawn(this.options.command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.options.env },
      cwd: this.options.cwd,
    });
    this.process = proc;

    // Forward child stderr to our own stderr (non-fatal if it fails)
    proc.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });

    proc.on("exit", (code) => {
      log(`subprocess exited (code=${code})`);
      if (this.process === proc) {
        this.ready = false;
        this.connection = null;
        this.process = null;
        this.onExit?.();
      }
    });

    const writable = Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>;
    const readable = Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(writable, readable);

    const conn = new ClientSideConnection((_agent) => ({
      sessionUpdate: async (params) => {
        const update = params.update;
        switch (update.sessionUpdate) {
          case "tool_call":
            log(`tool_call: ${describeToolCall(update)} (${update.status ?? "started"})`);
            break;
          case "tool_call_update":
            if (update.status) {
              log(`tool_call_update: ${describeToolCall(update)} → ${update.status}`);
            }
            break;
          case "agent_thought_chunk":
            if (update.content.type === "text") {
              log(`thinking: ${update.content.text.slice(0, 100)}`);
            }
            break;
          case "current_mode_update":
            log(`current_mode_update: ${update.currentModeId}`);
            break;
        }
        try {
          await this.onSessionUpdate?.(params);
        } catch (err) {
          log(`session update hook failed: ${String(err)}`);
        }
        const collector = this.collectors.get(params.sessionId);
        if (collector) {
          await collector.handleUpdate(params);
        }
      },
      requestPermission: async (params) => {
        const firstOption = params.options[0];
        log(
          `permission: auto-approved "${firstOption?.name ?? "allow"}" (${firstOption?.optionId ?? "unknown"})`,
        );
        return {
          outcome: {
            outcome: "selected" as const,
            optionId: firstOption?.optionId ?? "allow",
          },
        };
      },
    }), stream);

    log("initializing connection...");
    await conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "weixin-agent-sdk", version: "0.1.0" },
      clientCapabilities: {},
    });
    log("connection initialized");

    this.connection = conn;
    this.ready = true;
    return conn;
  }

  /**
   * Cancel an ongoing prompt turn for a session.
   * Sends a session/cancel notification to the ACP agent subprocess.
   */
  async cancelSession(sessionId: SessionId): Promise<void> {
    if (!this.ready || !this.connection) {
      log(`cancelSession: connection not ready, ignoring (session=${sessionId})`);
      return;
    }
    log(`cancelling session=${sessionId}`);
    await this.connection.cancel({ sessionId });
  }

  /**
   * Restart the subprocess and reinitialize the ACP connection.
   */
  async restart(): Promise<void> {
    this.dispose();
    await this.ensureReady();
  }

  /**
   * Kill the subprocess and its entire process tree, then clean up.
   */
  dispose(): void {
    this.ready = false;
    // Clear initPromise so the old .finally() won't overwrite a newer one.
    // The old promise will still resolve/reject, but its .finally() guard
    // (`if (this.initPromise === promise)`) will skip the null-assignment
    // because this.initPromise no longer references it.
    this.initPromise = null;
    this.collectors.clear();
    if (this.process) {
      killProcessTree(this.process);
      this.process = null;
    }
    this.connection = null;
  }
}
