# weixin-agent-sdk

Bridge any AI agent to WeChat via [ACP (Agent Client Protocol)](https://github.com/AcpProtocol/acp).

## Packages

| Package | Description |
|---------|-------------|
| `weixin-agent-sdk` | Core SDK — WeChat messaging, login, slash commands, media send |
| `weixin-acp` | ACP adapter — connect any ACP agent (Claude Code, Codex, Copilot, Codebuddy …) to WeChat out of the box |
| `example-openai` | Example — simple agent backed by the OpenAI API |

---

## Quick start

### Using `weixin-acp` (recommended)

```bash
# Log in via QR code
npx weixin-acp login

# Start with a built-in ACP agent
npx weixin-acp claude-code   # Claude Code
npx weixin-acp codex         # Codex
npx weixin-acp copilot       # GitHub Copilot
npx weixin-acp codebuddy     # Codebuddy

# Start with any custom ACP-compatible command
npx weixin-acp start -- <command> [args...]
```

### From source

```bash
git clone https://github.com/yaonyan/weixin-agent-sdk.git
cd weixin-agent-sdk
pnpm install

# Build (order matters: SDK first, then ACP)
pnpm --filter weixin-agent-sdk run build
pnpm --filter weixin-acp run build

# Log in
pnpm --filter weixin-acp run login

# Start
pnpm --filter weixin-acp run start -- claude-agent-acp
```

### Custom agent (OpenAI example)

Implement the `Agent` interface and pass it to `start()`:

```typescript
import { login, start } from "weixin-agent-sdk";
import type { Agent, ChatRequest, ChatResponse } from "weixin-agent-sdk";

class MyAgent implements Agent {
  async chat(request: ChatRequest): Promise<ChatResponse> {
    return { text: `You said: ${request.text}` };
  }
}

// QR-code login (once)
await login();

// Start the bot
await start(new MyAgent());
```

See `packages/example-openai` for a full working example with OpenAI.

---

## ACP profile configuration

Profiles are stored at `~/.config/weixin-acp/acp-profiles.json` (XDG).  
Override the directory with `WEIXIN_ACP_STATE_DIR` or `XDG_CONFIG_HOME`.

```jsonc
{
  "profiles": {
    "claude-code": { "command": "claude-agent-acp" },
    "codex":       { "command": "codex-acp" },
    "copilot":     { "command": "copilot", "args": ["--acp"] }
  },
  "activeProfile": "claude-code",
  "defaultProfile": "claude-code"
}
```

See [`acp-profiles.example.json`](./acp-profiles.example.json) for a full reference.

### Profile fields

| Field | Type | Description |
|-------|------|-------------|
| `command` | `string` | Command to launch the ACP agent subprocess |
| `args` | `string[]` | Extra command-line arguments |
| `env` | `Record<string,string>` | Extra environment variables |
| `mcpServers` | `McpServerDef[]` | MCP servers passed to the agent |

### MCP server types

```jsonc
// SSE
{ "type": "sse",   "name": "my-server", "url": "http://localhost:3000/sse" }

// HTTP Streamable
{ "type": "http",  "name": "my-server", "url": "http://localhost:3000/mcp" }

// Stdio
{ "type": "stdio", "name": "my-server", "command": "npx", "args": ["my-mcp-server"] }
```

---

## Slash commands

Send any of the following from the WeChat chat window:

| Command | Description |
|---------|-------------|
| `/help` | Show help |
| `/status` | Show current bot and account status |
| `/stop` | Cancel the current in-progress response |
| `/echo <message>` | Echo the message back with channel latency |
| `/clear` | Clear the current session |
| `/restart` | Restart the underlying agent subprocess |
| `/verbose` | Toggle verbose mode (streams live tool-call updates) |
| `/toggle-debug` | Toggle debug logging |
| `/model` | Show the current model |
| `/model <id>` | Switch model (if the agent supports it) |
| `/mode` | Show the current mode |
| `/mode <id>` | Switch mode (if the agent supports it) |
| `/acp` | Show current ACP profile and available profiles |
| `/acp <name>` | Switch to a different profile |
| `/acp add <name> <command> [args...]` | Register a new profile |
| `/acp rm <name>` | Remove a profile |

---

## Sending images mid-work

The SDK ships a `weixin-send` CLI that lets any agent push images or messages to the WeChat user **during** a task, without waiting for the task to finish.

```bash
# Check the CLI is available
which weixin-send

# If not found, link it from the SDK package
cd packages/sdk && npm link

# Send an image
weixin-send /tmp/chart.png

# Send an image with a caption
weixin-send /tmp/report.png --text "Report is ready"

# Send a plain text message
weixin-send --text "Step 1 done, moving on to step 2..."

# Send a remote image (auto-downloaded)
weixin-send https://example.com/result.png

# Check account and token status
weixin-send --list-accounts
```

The agent returns `{ text?, media?: { type, url } }` from `chat()` for end-of-turn delivery, or calls `weixin-send` at any point during work for immediate delivery.

---

## `ChatRequest` / `ChatResponse` reference

```typescript
interface ChatRequest {
  conversationId: string;       // WeChat user ID — use for per-user context
  text: string;                 // Inbound message text
  media?: {                     // Attached media (already downloaded & decrypted)
    type: "image" | "audio" | "video" | "file";
    filePath: string;
    mimeType: string;
    fileName?: string;
  };
  onToolCall?: (msg: string) => Promise<void>; // Verbose mode callback
}

interface ChatResponse {
  text?: string;                // Reply text (markdown → plain text before send)
  media?: {                     // Reply media
    type: "image" | "video" | "file";
    url: string;                // Local absolute path or http(s):// URL
    fileName?: string;
  };
  cancelled?: boolean;          // True if the turn was cancelled — skip sending
}
```

---

## Proactive messaging

After `start()` returns a `Bot` instance you can push messages at any time:

```typescript
const bot = await start(agent);

// Send text
await bot.sendMessage("Task finished.");

// Send an image
await bot.sendMessage({
  text: "Here is your report",
  media: { type: "image", url: "/tmp/report.png" },
});
```

> Requires the user to have sent at least one message so a `context_token` is cached (valid ~20 hours, persisted to disk across restarts).

---

## Development

```bash
pnpm install
pnpm --filter weixin-agent-sdk run build   # build SDK first
pnpm --filter weixin-acp run build
pnpm run typecheck
```

---

## License

MIT
