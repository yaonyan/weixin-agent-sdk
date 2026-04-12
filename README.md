# weixin-agent-sdk

微信 + AI Agent 桥接 SDK，通过 [ACP (Agent Client Protocol)](https://github.com/AcpProtocol/acp) 将任意 AI Agent 接入微信。

## 包结构

| 包 | 说明 |
|---|---|
| `weixin-agent-sdk` | 核心 SDK — 提供微信消息收发、登录、斜杠指令等基础能力 |
| `weixin-acp` | ACP 适配器 — 开箱即用地将 ACP agent (Claude Code, Codex, Copilot, Codebuddy 等) 接入微信 |
| `example-openai` | 示例 — 使用 OpenAI 接口的简单 agent |

## 快速开始

### 安装

```bash
npx weixin-acp login          # 扫码登录微信
npx weixin-acp claude-code    # 使用 Claude Code
npx weixin-acp codex          # 使用 Codex
npx weixin-acp copilot        # 使用 GitHub Copilot
npx weixin-acp codebuddy      # 使用 Codebuddy
npx weixin-acp start -- <command> [args...]  # 使用自定义 agent
```

### 从源码运行

```bash
git clone https://github.com/wong2/weixin-agent-sdk.git
cd weixin-agent-sdk
pnpm install
pnpm --filter weixin-acp run login
pnpm --filter weixin-acp run start -- claude-agent-acp
```

## 微信内命令

在微信聊天中发送以下斜杠命令：

| 命令 | 说明 |
|---|---|
| `/help` | 显示帮助信息 |
| `/status` | 查看当前状态 |
| `/stop` | 停止当前对话 |
| `/echo <message>` | 直接回复并显示通道耗时 |
| `/toggle-debug` | 开关 debug 模式 |
| `/verbose` | 开关 verbose 模式（显示工具调用信息） |
| `/clear` | 清除当前会话 |
| `/restart` | 重启底层 agent 进程 |
| `/acp` | 查看 ACP 配置 |
| `/acp <name>` | 切换到指定 profile |
| `/acp add <name> <command> [args...]` | 添加 profile |
| `/acp rm <name>` | 删除 profile |

## ACP Profile 配置

Profile 配置存储在 `~/.config/weixin-acp/acp-profiles.json`（遵循 XDG 规范）。

可通过环境变量覆盖配置目录：
- `WEIXIN_ACP_STATE_DIR` — 直接指定配置目录
- `XDG_CONFIG_HOME` — 使用 XDG 标准路径（`$XDG_CONFIG_HOME/weixin-acp/`）

示例配置见 [acp-profiles.example.json](./acp-profiles.example.json)。

### Profile 字段

```jsonc
{
  "command": "claude-agent-acp",  // 启动 ACP agent 的命令
  "args": [],                     // 命令参数
  "env": {},                      // 额外环境变量
  "mcpServers": []                // 传给 agent 的 MCP server 定义
}
```

### MCP Server 类型

```jsonc
// SSE
{ "type": "sse", "name": "my-server", "url": "http://localhost:3000/sse", "headers": [] }

// HTTP Streamable
{ "type": "http", "name": "my-server", "url": "http://localhost:3000/mcp", "headers": [] }

// Stdio
{ "type": "stdio", "name": "my-server", "command": "npx", "args": ["my-mcp-server"], "env": [] }
```

## 开发

```bash
pnpm install
pnpm run typecheck
pnpm --filter weixin-acp run build
```

## License

MIT
