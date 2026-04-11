#!/usr/bin/env node

/**
 * WeChat + ACP (Agent Client Protocol) adapter.
 *
 * Usage:
 *   npx weixin-acp login                          # QR-code login
 *   npx weixin-acp claude-code                     # Start with Claude Code
 *   npx weixin-acp codex                           # Start with Codex
 *   npx weixin-acp start -- <command> [args...]    # Start with custom agent
 *
 * Examples:
 *   npx weixin-acp start -- node ./my-agent.js
 */

import { isLoggedIn, login, logout, start } from "weixin-agent-sdk";

import { AcpAgent } from "./src/acp-agent.js";
import {
  loadAcpConfig,
  saveAcpConfig,
  addProfile,
  removeProfile,
  setActiveProfile,
  setDefaultProfile,
  getActiveProfile,
  getDefaultProfile,
} from "./src/acp-config.js";
import type { AcpAgentOptions } from "./src/types.js";

/** Built-in agent shortcuts */
const BUILTIN_AGENTS: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> = {
  "claude-code": { command: "claude-agent-acp" },
  codex: { command: "codex-acp" },
  copilot: { command: "copilot", args: ["--acp"] },
  codebuddy: { command: "cmd", args: ["/c", "codebuddy.cmd", "--acp"], env: { CODEBUDDY_DEFER_TOOL_LOADING: "false" } },
};

const cliCommand = process.argv[2];

async function ensureLoggedIn() {
  if (!isLoggedIn()) {
    console.log("未检测到登录信息，请先扫码登录微信\n");
    await login();
  }
}

async function startAgent(acpCommand: string, acpArgs: string[] = [], profileName?: string, acpEnv?: Record<string, string>) {
  await ensureLoggedIn();

  const agentOptions: AcpAgentOptions = { command: acpCommand, args: acpArgs, env: acpEnv };
  const agent = new AcpAgent(agentOptions, profileName);

  const ac = new AbortController();
  process.on("SIGINT", () => {
    console.log("\n正在停止...");
    agent.dispose();
    ac.abort();
  });
  process.on("SIGTERM", () => {
    agent.dispose();
    ac.abort();
  });

  // ACP profile management callbacks for slash commands
  const acp = {
    get profileName() {
      return agent.profileName;
    },
    get defaultProfileName() {
      return loadAcpConfig().defaultProfile;
    },
    get profileNames() {
      return Object.keys(loadAcpConfig().profiles);
    },
    onSwitch: async (name: string): Promise<string | undefined> => {
      const config = loadAcpConfig();
      const profile = config.profiles[name];
      if (!profile) return undefined;
      const newOptions: AcpAgentOptions = { command: profile.command, args: profile.args, env: profile.env };
      await agent.switchProfile(name, newOptions);
      setActiveProfile(config, name);
      saveAcpConfig(config);
      return name;
    },
    onAdd: async (name: string, cmd: string, args: string[], env?: Record<string, string>): Promise<string | undefined> => {
      const config = loadAcpConfig();
      addProfile(config, name, cmd, args, env);
      saveAcpConfig(config);
      return name;
    },
    onRm: async (name: string): Promise<string | undefined> => {
      const config = loadAcpConfig();
      const removed = removeProfile(config, name);
      if (!removed) return undefined;
      saveAcpConfig(config);
      return name;
    },
    onRestart: async (): Promise<void> => {
      const config = loadAcpConfig();
      const defaultName = config.defaultProfile;
      const defaultProfile = getDefaultProfile(config);
      if (defaultName && defaultProfile) {
        const newOptions: AcpAgentOptions = {
          command: defaultProfile.command,
          args: defaultProfile.args,
          env: defaultProfile.env,
        };
        await agent.switchProfile(defaultName, newOptions);
        setActiveProfile(config, defaultName);
        saveAcpConfig(config);
      }
      await agent.restart();
    },
  };

  return start(agent, { abortSignal: ac.signal, acp });
}

/**
 * Resolve the initial ACP command from config or CLI args.
 * Priority: saved activeProfile > CLI arg > default
 */
function resolveInitialCommand(cliCommand?: string, cliArgs?: string[]): {
  command: string;
  args: string[];
  profileName?: string;
  env?: Record<string, string>;
} {
  // Try to use saved active profile
  const config = loadAcpConfig();
  const active = getActiveProfile(config);
  if (active) {
    console.log(`[acp] 使用已保存的 profile: ${config.activeProfile} (${active.command})`);
    return { command: active.command, args: active.args ?? [], profileName: config.activeProfile, env: active.env };
  }

  // Fall back to CLI args
  return { command: cliCommand ?? "", args: cliArgs ?? [] };
}

async function main() {
  if (cliCommand === "login") {
    await login();
    return;
  }

  if (cliCommand === "logout") {
    logout();
    return;
  }

  if (cliCommand === "start") {
    const ddIndex = process.argv.indexOf("--");
    if (ddIndex === -1 || ddIndex + 1 >= process.argv.length) {
      console.error("错误: 请在 -- 后指定 ACP agent 启动命令");
      console.error("示例: npx weixin-acp start -- codex-acp");
      process.exit(1);
    }

    const [acpCommand, ...acpArgs] = process.argv.slice(ddIndex + 1);
    // Save as a profile if not already present
    const config = loadAcpConfig();
    const existingEntry = Object.entries(config.profiles).find(
      ([, p]) => p.command === acpCommand && JSON.stringify(p.args ?? []) === JSON.stringify(acpArgs),
    );
    if (existingEntry) {
      setActiveProfile(config, existingEntry[0]);
      setDefaultProfile(config, existingEntry[0]);
    } else {
      // Use full command+args as a recognizable profile name
      const autoName = [acpCommand, ...acpArgs].join(" ");
      addProfile(config, autoName, acpCommand, acpArgs);
      setActiveProfile(config, autoName);
      setDefaultProfile(config, autoName);
    }
    saveAcpConfig(config);

    const resolved = resolveInitialCommand(acpCommand, acpArgs);
    await startAgent(resolved.command, resolved.args, resolved.profileName, resolved.env);
    return;
  }

  if (cliCommand && cliCommand in BUILTIN_AGENTS) {
    const { command: acpCommand, args: acpArgs, env: acpEnv } = BUILTIN_AGENTS[cliCommand];
    // Auto-save as profile using the shortcut name
    const config = loadAcpConfig();
    addProfile(config, cliCommand, acpCommand, acpArgs, acpEnv);
    setActiveProfile(config, cliCommand);
    setDefaultProfile(config, cliCommand);
    saveAcpConfig(config);

    const resolved = resolveInitialCommand(acpCommand, acpArgs);
    await startAgent(resolved.command, resolved.args, resolved.profileName, resolved.env);
    return;
  }

  console.log(`weixin-acp — 微信 + ACP 适配器

用法:
  npx weixin-acp login                          扫码登录微信
  npx weixin-acp logout                         退出登录
  npx weixin-acp claude-code                     使用 Claude Code
  npx weixin-acp codex                           使用 Codex
  npx weixin-acp copilot                         使用 GitHub Copilot
  npx weixin-acp codebuddy                       使用 Codebuddy
  npx weixin-acp start -- <command> [args...]    使用自定义 agent

微信内命令:
  /acp                                           查看 ACP 配置
  /acp <name>                                    切换 ACP profile
  /acp add <name> <command> [args...]            添加 profile
  /acp rm <name>                                 删除 profile

示例:
  npx weixin-acp start -- node ./my-agent.js`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
