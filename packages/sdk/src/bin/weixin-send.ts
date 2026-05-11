#!/usr/bin/env node
/**
 * weixin-send — 向微信用户发送消息或图片的 CLI 工具
 *
 * 用法:
 *   weixin-send <file-path>          # 发送图片/视频/文件
 *   weixin-send --text "你好"         # 发送文字消息
 *   weixin-send <file-path> --text "说明文字"  # 发送带文字的图片
 *   weixin-send --list-accounts      # 列出所有已登录账号
 *
 * 选项:
 *   --text, -t <text>     附加的文字说明（图片/文件时可选，文字消息时必填）
 *   --account, -a <id>    指定账号 ID（默认使用第一个已登录账号）
 *   --help, -h            显示帮助
 *   --list-accounts       列出所有已登录账号的状态
 *
 * 退出码:
 *   0  成功
 *   1  参数错误或发送失败
 */

import path from "node:path";
import os from "node:os";

import { downloadRemoteImageToTemp } from "../cdn/upload.js";
import { getContextToken } from "../messaging/inbound.js";
import { sendWeixinMediaFile } from "../messaging/send-media.js";
import { markdownToPlainText, sendMessageWeixin } from "../messaging/send.js";
import {
  listWeixinAccountIds,
  loadWeixinAccount,
  resolveWeixinAccount,
} from "../auth/accounts.js";

const MEDIA_TEMP_DIR = path.join(os.tmpdir(), "weixin-agent/media/outbound");

function printHelp(): void {
  console.log(`weixin-send — 向微信用户发送消息

用法:
  weixin-send <file-path>                    发送图片/视频/文件
  weixin-send --text "你好"                  发送文字消息
  weixin-send <file-path> --text "说明文字"  发送带文字的图片

选项:
  --text, -t <text>     附加的文字说明
  --account, -a <id>    指定账号 ID（默认使用第一个已登录账号）
  --list-accounts       列出所有已登录账号的状态
  --help, -h            显示帮助信息

示例:
  weixin-send /tmp/chart.png
  weixin-send /tmp/report.png --text "报告已生成"
  weixin-send --text "任务完成，已为您处理完毕"
  weixin-send https://example.com/image.png
`);
}

function listAccounts(): void {
  const ids = listWeixinAccountIds();
  if (ids.length === 0) {
    console.log("没有已登录的账号。请先运行 weixin-login 完成登录。");
    return;
  }
  console.log(`已登录账号 (${ids.length} 个):`);
  for (const id of ids) {
    const data = loadWeixinAccount(id);
    const hasToken = Boolean(data?.token);
    const userId = data?.userId ?? "(未知用户)";
    const contextToken = data?.userId ? getContextToken(id, data.userId) : undefined;
    const hasContext = Boolean(contextToken);
    const status = hasToken
      ? hasContext
        ? "✅ 可发送（token + context_token 均有效）"
        : "⚠️  有 token 但缺 context_token（需要用户先发一条消息）"
      : "❌ 未登录";
    console.log(`  ${id}  用户=${userId}  ${status}`);
  }
}

interface ParsedArgs {
  filePath?: string;
  text?: string;
  accountId?: string;
  listAccounts?: boolean;
  help?: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {};
  const args = argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg === "--list-accounts") {
      result.listAccounts = true;
    } else if ((arg === "--text" || arg === "-t") && i + 1 < args.length) {
      result.text = args[++i];
    } else if ((arg === "--account" || arg === "-a") && i + 1 < args.length) {
      result.accountId = args[++i];
    } else if (!arg.startsWith("-")) {
      result.filePath = arg;
    } else {
      console.error(`未知参数: ${arg}`);
      process.exit(1);
    }
  }

  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (args.listAccounts) {
    listAccounts();
    process.exit(0);
  }

  // 必须有 filePath 或 text
  if (!args.filePath && !args.text) {
    console.error("错误: 请提供文件路径或 --text 文字内容");
    console.error("用法: weixin-send <file-path> 或 weixin-send --text '消息'");
    process.exit(1);
  }

  // 解析账号
  let accountId = args.accountId;
  if (!accountId) {
    const ids = listWeixinAccountIds();
    if (ids.length === 0) {
      console.error("错误: 没有已登录的账号，请先运行 weixin-login");
      process.exit(1);
    }
    accountId = ids[0];
    if (ids.length > 1) {
      console.error(`提示: 检测到多个账号，使用第一个: ${accountId}`);
    }
  }

  const account = resolveWeixinAccount(accountId);
  if (!account.configured) {
    console.error(`错误: 账号 ${accountId} 未配置 (缺少 token)，请先运行 weixin-login`);
    process.exit(1);
  }

  const accountData = loadWeixinAccount(account.accountId);
  const userId = accountData?.userId;
  if (!userId) {
    console.error(`错误: 账号 ${accountId} 没有关联的用户 ID，请重新运行 weixin-login`);
    process.exit(1);
  }

  const contextToken = getContextToken(account.accountId, userId);
  if (!contextToken) {
    console.error(
      `错误: 没有找到有效的 context_token。\n` +
      `context_token 由用户发来消息时自动刷新，有效期约 20 小时。\n` +
      `请先让用户发一条消息，或等待用户下次发消息后重试。`,
    );
    process.exit(1);
  }

  const apiOpts = {
    baseUrl: account.baseUrl,
    token: account.token,
    contextToken,
  };

  try {
    if (args.filePath) {
      let filePath = args.filePath;

      // 如果是远程 URL，先下载到本地临时文件
      if (filePath.startsWith("http://") || filePath.startsWith("https://")) {
        process.stderr.write(`正在下载远程图片: ${filePath}\n`);
        filePath = await downloadRemoteImageToTemp(filePath, MEDIA_TEMP_DIR);
      } else if (!path.isAbsolute(filePath)) {
        filePath = path.resolve(filePath);
      }

      const text = args.text ? markdownToPlainText(args.text) : "";
      process.stderr.write(`正在发送文件: ${filePath}\n`);
      await sendWeixinMediaFile({
        filePath,
        to: userId,
        text,
        opts: apiOpts,
        cdnBaseUrl: account.cdnBaseUrl,
      });
      console.log("✅ 文件已发送");
    } else if (args.text) {
      process.stderr.write(`正在发送文字消息...\n`);
      await sendMessageWeixin({
        to: userId,
        text: markdownToPlainText(args.text),
        opts: apiOpts,
      });
      console.log("✅ 消息已发送");
    }
  } catch (err) {
    console.error(`❌ 发送失败: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`❌ 未预期的错误: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
