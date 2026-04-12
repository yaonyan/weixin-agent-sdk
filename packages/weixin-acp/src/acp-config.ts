/**
 * ACP profile configuration — persistent profiles for switching ACP agents.
 *
 * Config file: `~/.openclaw/acp-profiles.json`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { McpServer } from "@agentclientprotocol/sdk";
import type { AcpProfile } from "./types.js";

function resolveStateDir(): string {
  return (
    process.env.OPENCLAW_STATE_DIR?.trim() ||
    process.env.CLAWDBOT_STATE_DIR?.trim() ||
    path.join(os.homedir(), ".openclaw")
  );
}

export interface AcpConfig {
  profiles: Record<string, AcpProfile>;
  activeProfile?: string;
  defaultProfile?: string;
}

function resolveAcpConfigPath(): string {
  return path.join(resolveStateDir(), "acp-profiles.json");
}

export function loadAcpConfig(): AcpConfig {
  try {
    const raw = fs.readFileSync(resolveAcpConfigPath(), "utf-8");
    const parsed = JSON.parse(raw) as AcpConfig;
    if (parsed && typeof parsed.profiles === "object") return parsed;
  } catch {
    // missing or corrupt — start fresh
  }
  return { profiles: {} };
}

export function saveAcpConfig(config: AcpConfig): void {
  const filePath = resolveAcpConfigPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), "utf-8");
}

export function addProfile(config: AcpConfig, name: string, command: string, args?: string[], env?: Record<string, string>, mcpServers?: McpServer[]): void {
  config.profiles[name] = { command, args: args?.length ? args : undefined, env: env && Object.keys(env).length > 0 ? env : undefined, mcpServers: mcpServers?.length ? mcpServers : undefined };
}

export function removeProfile(config: AcpConfig, name: string): boolean {
  if (!(name in config.profiles)) return false;
  delete config.profiles[name];
  if (config.activeProfile === name) {
    config.activeProfile = undefined;
  }
  if (config.defaultProfile === name) {
    config.defaultProfile = undefined;
  }
  return true;
}

export function getActiveProfile(config: AcpConfig): AcpProfile | undefined {
  if (!config.activeProfile) return undefined;
  return config.profiles[config.activeProfile];
}

export function setActiveProfile(config: AcpConfig, name: string): void {
  config.activeProfile = name;
}

export function getDefaultProfile(config: AcpConfig): AcpProfile | undefined {
  if (!config.defaultProfile) return undefined;
  return config.profiles[config.defaultProfile];
}

export function setDefaultProfile(config: AcpConfig, name: string): void {
  config.defaultProfile = name;
}
