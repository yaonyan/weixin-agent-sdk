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
import type { McpServer } from "@agentclientprotocol/sdk";

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
  getProfileModel,
  setProfileModel,
} from "./src/acp-config.js";
import type { AcpAgentOptions, AcpProfile } from "./src/types.js";

/** Built-in agent shortcuts */
const BUILTIN_AGENTS: Record<string, { command: string; args?: string[]; env?: Record<string, string>; mcpServers?: McpServer[] }> = {
  "claude-code": { command: "claude-agent-acp" },
  codex: { command: "codex-acp" },
  copilot: { command: "copilot", args: ["--acp"] },
  codebuddy: {
    command: "cmd",
    args: ["/c", "codebuddy.cmd", "--acp"],
    env: { CODEBUDDY_DEFER_TOOL_LOADING: "false" },
    mcpServers: [
      { type: "sse", name: "mcpc", url: "http://127.0.0.1:3000/sse", headers: [] },
    ],
  },
};

const cliCommand = process.argv[2];

function createAgentOptions(
  command: string,
  args: string[] | undefined,
  env: Record<string, string> | undefined,
  cwd: string,
  mcpServers?: McpServer[],
): AcpAgentOptions {
  return { command, args, env, cwd, mcpServers };
}

async function ensureLoggedIn() {
  if (!isLoggedIn()) {
    console.log("未检测到登录信息，请先扫码登录微信\n");
    await login();
  }
}

function supportsModelSwitch(profile: AcpProfile): boolean {
  const command = profile.command.toLowerCase();
  if (command === "codebuddy") return true;
  if (command === "cmd" && (profile.args ?? []).some((arg) => /codebuddy(?:\.cmd)?/i.test(arg))) {
    return true;
  }
  return getProfileModel(profile) !== undefined;
}

function getCurrentProfileState(currentProfileName?: string): {
  config: ReturnType<typeof loadAcpConfig>;
  profileName: string;
  profile: AcpProfile;
  model?: string;
  supportsModelSwitch: boolean;
} | undefined {
  const config = loadAcpConfig();
  const profileName = currentProfileName ?? config.activeProfile;
  if (!profileName) return undefined;

  const profile = config.profiles[profileName];
  if (!profile) return undefined;

  return {
    config,
    profileName,
    profile,
    model: getProfileModel(profile),
    supportsModelSwitch: supportsModelSwitch(profile),
  };
}

async function startAgent(acpCommand: string, acpArgs: string[] = [], profileName?: string, acpEnv?: Record<string, string>, acpMcpServers?: McpServer[]) {
  await ensureLoggedIn();

  const cwd = process.cwd();
  const agent = new AcpAgent(createAgentOptions(acpCommand, acpArgs, acpEnv, cwd, acpMcpServers), profileName);

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
    get command() {
      return getCurrentProfileState(agent.profileName)?.profile.command;
    },
    get model() {
      return getCurrentProfileState(agent.profileName)?.model;
    },
    get modelSwitchSupported() {
      return getCurrentProfileState(agent.profileName)?.supportsModelSwitch ?? false;
    },
    onSwitch: async (name: string): Promise<string | undefined> => {
      const config = loadAcpConfig();
      const profile = config.profiles[name];
      if (!profile) return undefined;
      await agent.switchProfile(
        name,
        createAgentOptions(profile.command, profile.args, profile.env, cwd, profile.mcpServers),
      );
      setActiveProfile(config, name);
      saveAcpConfig(config);
      return name;
    },
    onAdd: async (
      name: string,
      cmd: string,
      args: string[],
      env?: Record<string, string>,
      mcpServers?: Array<{
        type: string;
        name: string;
        url?: string;
        headers?: Array<{ name: string; value: string }>;
        command?: string;
        args?: string[];
        env?: Array<{ name: string; value: string }>;
      }>,
    ): Promise<string | undefined> => {
      const normalizedServers: McpServer[] | undefined = mcpServers
        ? mcpServers.flatMap((server): McpServer[] => {
            if (server.type === "stdio" && server.command) {
              return [{
                name: server.name,
                command: server.command,
                args: server.args ?? [],
                env: server.env ?? [],
              }];
            }

            if (server.type === "http" && server.url) {
              return [{
                type: "http",
                name: server.name,
                url: server.url,
                headers: server.headers ?? [],
              }];
            }

            if (server.type === "sse" && server.url) {
              return [{
                type: "sse",
                name: server.name,
                url: server.url,
                headers: server.headers ?? [],
              }];
            }

            return [];
          })
        : undefined;

      const config = loadAcpConfig();
      addProfile(config, name, cmd, args, env, normalizedServers);
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
    onGetSessionState: async (conversationId: string) => {
      const snapshot = await agent.getSessionSnapshot(conversationId);
      return {
        currentModelId: snapshot.currentModelId,
        availableModels: snapshot.availableModels?.map((model) => ({
          id: model.modelId,
          name: model.name,
          description: model.description,
        })),
        currentModeId: snapshot.currentModeId,
        availableModes: snapshot.availableModes?.map((mode) => ({
          id: mode.id,
          name: mode.name,
          description: mode.description,
        })),
      };
    },
    onSetMode: async (conversationId: string, modeId: string) => {
      const snapshot = await agent.setSessionMode(conversationId, modeId);
      if (!snapshot) return undefined;
      return {
        currentModeId: snapshot.currentModeId,
        availableModes: snapshot.availableModes?.map((mode) => ({
          id: mode.id,
          name: mode.name,
          description: mode.description,
        })),
      };
    },
    onSetModel: async (conversationId: string, modelId: string) => {
      const snapshot = await agent.setSessionModel(conversationId, modelId);
      if (!snapshot) return undefined;
      return {
        currentModelId: snapshot.currentModelId,
        availableModels: snapshot.availableModels?.map((model) => ({
          id: model.modelId,
          name: model.name,
          description: model.description,
        })),
      };
    },
    onRestart: async (): Promise<void> => {
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
  mcpServers?: McpServer[];
} {
  const config = loadAcpConfig();

  const active = getActiveProfile(config);
  if (active && config.activeProfile) {
    console.log(`[acp] 使用已保存的 profile: ${config.activeProfile} (${active.command})`);
    return {
      command: active.command,
      args: active.args ?? [],
      profileName: config.activeProfile,
      env: active.env,
      mcpServers: active.mcpServers,
    };
  }

  const defaultProfile = getDefaultProfile(config);
  if (defaultProfile && config.defaultProfile) {
    console.log(`[acp] 使用默认 profile: ${config.defaultProfile} (${defaultProfile.command})`);
    return {
      command: defaultProfile.command,
      args: defaultProfile.args ?? [],
      profileName: config.defaultProfile,
      env: defaultProfile.env,
      mcpServers: defaultProfile.mcpServers,
    };
  }

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
    await startAgent(resolved.command, resolved.args, resolved.profileName, resolved.env, resolved.mcpServers);
    return;
  }

  if (cliCommand && cliCommand in BUILTIN_AGENTS) {
    const { command: acpCommand, args: acpArgs, env: acpEnv, mcpServers: acpMcpServers } = BUILTIN_AGENTS[cliCommand];
    // Auto-save as profile using the shortcut name
    const config = loadAcpConfig();
    addProfile(config, cliCommand, acpCommand, acpArgs, acpEnv, acpMcpServers);
    setActiveProfile(config, cliCommand);
    setDefaultProfile(config, cliCommand);
    saveAcpConfig(config);

    const resolved = resolveInitialCommand(acpCommand, acpArgs);
    await startAgent(resolved.command, resolved.args, resolved.profileName, resolved.env, resolved.mcpServers);
    return;
  }

  if (!cliCommand) {
    const resolved = resolveInitialCommand();
    if (resolved.command) {
      await startAgent(resolved.command, resolved.args, resolved.profileName, resolved.env, resolved.mcpServers);
      return;
    }
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
