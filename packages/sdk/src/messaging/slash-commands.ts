/**
 * Weixin 斜杠指令处理模块
 *
 * 支持的指令：
 * - /help                   显示帮助信息
 * - /status                 查看当前状态
 * - /echo <message>         直接回复消息（不经过 AI），并附带通道耗时统计
 * - /toggle-debug           开关 debug 模式，启用后每条 AI 回复追加全链路耗时
 * - /verbose                开关 verbose 模式，启用后发送工具调用信息
 * - /clear                  清除当前会话，重新开始对话
 * - /restart                重启底层 agent 进程
 * - /acp                    查看/切换/管理 ACP agent 配置
 */
import type { WeixinApiOptions } from "../api/api.js";
import { resolveWeixinAccount } from "../auth/accounts.js";
import { logger } from "../util/logger.js";

import { isDebugMode, toggleDebugMode } from "./debug-mode.js";
import { isVerboseMode, toggleVerboseMode } from "./verbose-mode.js";
import { sendMessageWeixin } from "./send.js";

export interface SlashCommandResult {
  /** 是否是斜杠指令（true 表示已处理，不需要继续走 AI） */
  handled: boolean;
}

/**
 * Minimal MCP server definition matching the ACP protocol McpServer type.
 * Kept inline to avoid coupling the SDK package to @agentclientprotocol/sdk.
 */
export type McpServerDef =
  | { type: "http"; name: string; url: string; headers?: Array<{ name: string; value: string }> }
  | { type: "sse"; name: string; url: string; headers?: Array<{ name: string; value: string }> }
  | { type: "stdio"; name: string; command: string; args?: string[]; env?: Array<{ name: string; value: string }> };

export interface SlashCommandContext {
  to: string;
  contextToken?: string;
  baseUrl: string;
  token?: string;
  accountId: string;
  log: (msg: string) => void;
  errLog: (msg: string) => void;
  /** Called when /clear is invoked to reset the agent session. */
  onClear?: () => void;
  /** Called when /restart is invoked to restart the underlying agent. */
  onRestart?: () => Promise<void> | void;
  /** Called when /stop is invoked to cancel the active prompt turn. */
  onStop?: (conversationId: string) => Promise<void>;
  /** Called when /acp <name> is invoked to switch the ACP profile. Returns the new profile name on success. */
  onAcpSwitch?: (profileName: string) => Promise<string | undefined>;
  /** Called when /acp add <name> <command> [args...] is invoked. Returns the profile name on success. */
  onAcpAdd?: (name: string, command: string, args: string[], env?: Record<string, string>, mcpServers?: McpServerDef[]) => Promise<string | undefined>;
  /** Called when /acp rm <name> is invoked. Returns the removed profile name on success. */
  onAcpRm?: (name: string) => Promise<string | undefined>;
  /** Get the current ACP profile name. */
  acpProfileName?: string;
  /** Get all available ACP profile names. */
  acpProfileNames?: string[];
  /** Get the default ACP profile name used by /restart recovery. */
  acpDefaultProfileName?: string;
}

/** 发送回复消息 */
async function sendReply(ctx: SlashCommandContext, text: string): Promise<void> {
  const opts: WeixinApiOptions & { contextToken?: string } = {
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    contextToken: ctx.contextToken,
  };
  await sendMessageWeixin({ to: ctx.to, text, opts });
}

function buildHelpText(): string {
  return [
    "可用命令",
    "/help - 显示帮助信息",
    "/status - 查看当前状态",
    "/stop - 停止当前对话",
    "/echo <message> - 直接回复并显示通道耗时",
    "/toggle-debug - 开关 debug 模式",
    "/verbose - 开关 verbose 模式",
    "/clear - 清除当前会话",
    "/restart - 重启底层 agent 进程",
    "/acp - 查看当前 ACP 配置",
    "/acp <name> - 切换到指定 ACP profile",
    "/acp add <name> <command> [args...] - 添加 ACP profile",
    "/acp rm <name> - 删除 ACP profile",
  ].join("\n");
}

function buildStatusText(ctx: SlashCommandContext): string {
  const account = resolveWeixinAccount(ctx.accountId);
  const lines = [
    "当前状态",
    `账号: ${account.accountId}`,
    `登录: ${account.configured ? "已登录" : "未登录"}`,
    `Base URL: ${account.baseUrl}`,
    `Debug: ${isDebugMode(ctx.accountId) ? "开启" : "关闭"}`,
    `Verbose: ${isVerboseMode(ctx.accountId) ? "开启" : "关闭"}`,
    `Stop: ${ctx.onStop ? "支持" : "不支持"}`,
    `Restart: ${ctx.onRestart ? "支持" : "不支持"}`,
  ];
  if (ctx.acpProfileName !== undefined) {
    lines.push(`ACP: ${ctx.acpProfileName}`);
  }
  if (ctx.acpDefaultProfileName !== undefined) {
    lines.push(`ACP 默认: ${ctx.acpDefaultProfileName}`);
  }
  return lines.join("\n");
}

/** 处理 /echo 指令 */
async function handleEcho(
  ctx: SlashCommandContext,
  args: string,
  receivedAt: number,
  eventTimestamp?: number,
): Promise<void> {
  const message = args.trim();
  if (message) {
    await sendReply(ctx, message);
  }
  const eventTs = eventTimestamp ?? 0;
  const platformDelay = eventTs > 0 ? `${receivedAt - eventTs}ms` : "N/A";
  const timing = [
    "⏱ 通道耗时",
    `├ 事件时间: ${eventTs > 0 ? new Date(eventTs).toISOString() : "N/A"}`,
    `├ 平台→插件: ${platformDelay}`,
    `└ 插件处理: ${Date.now() - receivedAt}ms`,
  ].join("\n");
  await sendReply(ctx, timing);
}

/**
 * 尝试处理斜杠指令
 *
 * @returns handled=true 表示该消息已作为指令处理，不需要继续走 AI 管道
 */
export async function handleSlashCommand(
  content: string,
  ctx: SlashCommandContext,
  receivedAt: number,
  eventTimestamp?: number,
): Promise<SlashCommandResult> {
  const trimmed = content.trim();
  if (!trimmed.startsWith("/")) {
    return { handled: false };
  }

  const spaceIdx = trimmed.indexOf(" ");
  const command = spaceIdx === -1 ? trimmed.toLowerCase() : trimmed.slice(0, spaceIdx).toLowerCase();
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);

  logger.info(`[weixin] Slash command: ${command}, args: ${args.slice(0, 50)}`);

  try {
    switch (command) {
      case "/help":
        await sendReply(ctx, buildHelpText());
        return { handled: true };
      case "/status":
        await sendReply(ctx, buildStatusText(ctx));
        return { handled: true };
      case "/echo":
        await handleEcho(ctx, args, receivedAt, eventTimestamp);
        return { handled: true };
      case "/toggle-debug": {
        const enabled = toggleDebugMode(ctx.accountId);
        await sendReply(
          ctx,
          enabled
            ? "Debug 模式已开启"
            : "Debug 模式已关闭",
        );
        return { handled: true };
      }
      case "/verbose": {
        const enabled = toggleVerboseMode(ctx.accountId);
        await sendReply(
          ctx,
          enabled
            ? "Verbose 模式已开启"
            : "Verbose 模式已关闭",
        );
        return { handled: true };
      }
      case "/clear": {
        ctx.onClear?.();
        await sendReply(ctx, "✅ 会话已清除，重新开始对话");
        return { handled: true };
      }
      case "/stop": {
        if (!ctx.onStop) {
          await sendReply(ctx, "当前 agent 不支持 /stop");
          return { handled: true };
        }
        await ctx.onStop(ctx.to);
        await sendReply(ctx, "✅ 已停止当前对话");
        return { handled: true };
      }
      case "/restart": {
        if (!ctx.onRestart) {
          await sendReply(ctx, "当前 agent 不支持 /restart");
          return { handled: true };
        }
        await ctx.onRestart();
        await sendReply(ctx, "✅ ACP 进程已重启");
        return { handled: true };
      }
      case "/acp": {
        // /acp — show status
        // /acp <name> — switch profile
        // /acp add <name> <command> [args...] — add profile
        // /acp rm <name> — remove profile
        const subArgs = args.trim();
        if (!subArgs) {
          // Show current profile + available profiles
          const current = ctx.acpProfileName ?? "(无)";
          const defaultProfile = ctx.acpDefaultProfileName ?? "(无)";
          const names = ctx.acpProfileNames ?? [];
          const profileList = names.length > 0
            ? names.map((n) => {
                const tags = [
                  n === ctx.acpProfileName ? "当前" : "",
                  n === ctx.acpDefaultProfileName ? "默认" : "",
                ].filter(Boolean);
                return tags.length > 0 ? `  * ${n} (${tags.join("/")})` : `    ${n}`;
              }).join("\n")
            : "  (无配置)";
          await sendReply(ctx, [`ACP 配置`, `当前: ${current}`, `默认: ${defaultProfile}`, `可用 profiles:`, profileList].join("\n"));
          return { handled: true };
        }

        const parts = subArgs.split(/\s+/);
        const subCommand = parts[0];

        if (subCommand === "add") {
          if (!ctx.onAcpAdd) {
            await sendReply(ctx, "当前 agent 不支持 /acp add");
            return { handled: true };
          }
          if (parts.length < 3) {
            await sendReply(ctx, "用法: /acp add <name> <command> [args...]");
            return { handled: true };
          }
          const addName = parts[1];
          const addCommand = parts[2];
          const addArgs = parts.slice(3);
          const result = await ctx.onAcpAdd(addName, addCommand, addArgs);
          if (result) {
            await sendReply(ctx, `✅ 已添加 profile: ${addName} (${addCommand} ${addArgs.join(" ")})`);
          } else {
            await sendReply(ctx, `❌ 添加 profile 失败`);
          }
          return { handled: true };
        }

        if (subCommand === "rm") {
          if (!ctx.onAcpRm) {
            await sendReply(ctx, "当前 agent 不支持 /acp rm");
            return { handled: true };
          }
          if (parts.length < 2) {
            await sendReply(ctx, "用法: /acp rm <name>");
            return { handled: true };
          }
          const rmName = parts[1];
          const result = await ctx.onAcpRm(rmName);
          if (result) {
            await sendReply(ctx, `✅ 已删除 profile: ${rmName}`);
          } else {
            await sendReply(ctx, `❌ profile "${rmName}" 不存在`);
          }
          return { handled: true };
        }

        // Switch profile: /acp <name>
        if (!ctx.onAcpSwitch) {
          await sendReply(ctx, "当前 agent 不支持 /acp 切换");
          return { handled: true };
        }
        const switchName = parts[0];
        const switchResult = await ctx.onAcpSwitch(switchName);
        if (switchResult) {
          await sendReply(ctx, `✅ 已切换到: ${switchResult}`);
        } else {
          await sendReply(ctx, `❌ profile "${switchName}" 不存在`);
        }
        return { handled: true };
      }
      default:
        return { handled: false };
    }
  } catch (err) {
    logger.error(`[weixin] Slash command error: ${String(err)}`);
    try {
      await sendReply(ctx, `❌ 指令执行失败: ${String(err).slice(0, 200)}`);
    } catch {
      // 发送错误消息也失败了，只能记日志
    }
    return { handled: true };
  }
}
