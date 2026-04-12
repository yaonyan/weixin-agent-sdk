/**
 * ACP profile configuration — persistent profiles for switching ACP agents.
 *
 * Config file: `~/.config/weixin-acp/acp-profiles.json` (XDG: `$XDG_CONFIG_HOME/weixin-acp/`)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { McpServer } from "@agentclientprotocol/sdk";
import type { AcpProfile } from "./types.js";

const MODEL_FLAG = "--model";

function resolveStateDir(): string {
  const custom = process.env.WEIXIN_ACP_STATE_DIR?.trim();
  if (custom) return custom;

  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg) return path.join(xdg, "weixin-acp");

  return path.join(os.homedir(), ".config", "weixin-acp");
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

export function getProfileModel(profile?: AcpProfile): string | undefined {
  const args = profile?.args ?? [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === MODEL_FLAG) {
      const next = args[i + 1]?.trim();
      return next || undefined;
    }
    if (arg.startsWith(`${MODEL_FLAG}=`)) {
      const inline = arg.slice(MODEL_FLAG.length + 1).trim();
      return inline || undefined;
    }
  }
  return undefined;
}

export function setProfileModel(profile: AcpProfile, model?: string): void {
  const nextArgs: string[] = [];
  const args = profile.args ?? [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === MODEL_FLAG) {
      i += 1;
      continue;
    }
    if (arg.startsWith(`${MODEL_FLAG}=`)) {
      continue;
    }
    nextArgs.push(arg);
  }

  const normalizedModel = model?.trim();
  if (normalizedModel) {
    nextArgs.push(MODEL_FLAG, normalizedModel);
  }

  profile.args = nextArgs.length > 0 ? nextArgs : undefined;
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
