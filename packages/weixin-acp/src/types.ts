import type { McpServer, ModelInfo, SessionId, SessionMode } from "@agentclientprotocol/sdk";

export type AcpProfile = {
  /** Command to launch the ACP agent, e.g. "claude-agent-acp" */
  command: string;
  /** Command arguments, e.g. [] */
  args?: string[];
  /** Extra environment variables for the subprocess */
  env?: Record<string, string>;
  /** MCP servers to pass to the ACP agent on session creation */
  mcpServers?: McpServer[];
};

export type AcpAgentOptions = {
  /** Command to launch the ACP agent, e.g. "npx" */
  command: string;
  /** Command arguments, e.g. ["@zed-industries/codex-acp"] */
  args?: string[];
  /** Extra environment variables for the subprocess */
  env?: Record<string, string>;
  /** Working directory for the subprocess and ACP sessions */
  cwd?: string;
  /** Prompt timeout in milliseconds (default: 120_000) */
  promptTimeoutMs?: number;
  /** MCP servers to pass to the ACP agent on session creation */
  mcpServers?: McpServer[];
};

export type AcpRuntimeMode = Pick<SessionMode, "id" | "name" | "description">;
export type AcpRuntimeModel = Pick<ModelInfo, "modelId" | "name" | "description">;

export type AcpSessionSnapshot = {
  sessionId: SessionId;
  availableModes?: AcpRuntimeMode[];
  currentModeId?: string;
  availableModels?: AcpRuntimeModel[];
  currentModelId?: string;
};
