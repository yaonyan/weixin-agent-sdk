export type AcpProfile = {
  /** Command to launch the ACP agent, e.g. "claude-agent-acp" */
  command: string;
  /** Command arguments, e.g. [] */
  args?: string[];
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
};
