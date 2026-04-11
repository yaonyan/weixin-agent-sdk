/**
 * Per-bot verbose mode toggle, persisted to disk so it survives gateway restarts.
 *
 * State file: `<stateDir>/openclaw-weixin/verbose-mode.json`
 * Format:     `{ "accounts": { "<accountId>": true, ... } }`
 */
import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../storage/state-dir.js";
import { logger } from "../util/logger.js";

interface VerboseModeState {
  accounts: Record<string, boolean>;
}

function resolveVerboseModePath(): string {
  return path.join(resolveStateDir(), "openclaw-weixin", "verbose-mode.json");
}

function loadState(): VerboseModeState {
  try {
    const raw = fs.readFileSync(resolveVerboseModePath(), "utf-8");
    const parsed = JSON.parse(raw) as VerboseModeState;
    if (parsed && typeof parsed.accounts === "object") return parsed;
  } catch {
    // missing or corrupt — start fresh
  }
  return { accounts: {} };
}

function saveState(state: VerboseModeState): void {
  const filePath = resolveVerboseModePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
}

/** Toggle verbose mode for a bot account. Returns the new state. */
export function toggleVerboseMode(accountId: string): boolean {
  const state = loadState();
  const next = !state.accounts[accountId];
  state.accounts[accountId] = next;
  try {
    saveState(state);
  } catch (err) {
    logger.error(`verbose-mode: failed to persist state: ${String(err)}`);
  }
  return next;
}

/** Check whether verbose mode is active for a bot account. */
export function isVerboseMode(accountId: string): boolean {
  return loadState().accounts[accountId] === true;
}
