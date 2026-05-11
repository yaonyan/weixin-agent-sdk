---
name: weixin-acp-dev
description: Develop, build, run, and restart the local weixin-acp repo for the CodeBuddy ACP bridge.
allowed-tools: Read, Write, Edit, MultiEdit, Grep, Glob, Bash, PowerShell
---

# Weixin ACP Repo Developer

Use this skill when working on the local `weixin-agent-sdk` repository, especially:
- `packages/weixin-acp`
- `packages/sdk`
- slash commands such as `/verbose`, `/status`, `/help`, `/restart`
- ACP transport behavior between WeChat and CodeBuddy

## Working rules
- Prefer changing the local source in this repo, not the temporary `npx` cache copy.
- After code changes, validate both packages that matter:
  - `pnpm --filter weixin-agent-sdk typecheck`
  - `pnpm --filter weixin-agent-sdk build`
  - `pnpm --filter weixin-acp typecheck`
  - `pnpm --filter weixin-acp build`
- When restarting the runtime, target the local built process under `packages/weixin-acp/dist/main.mjs`, not unrelated old `npx` processes unless the user explicitly asks.

## Start / Restart
Kill any running weixin-acp process and start a fresh one (or just start if none is running):

```bash
deno run --allow-run --allow-sys "c:\Users\bf_alexphzhou\weixin-agent-sdk\restart.ts"
```

The script at `restart.ts` in the repo root: finds the running weixin-acp node process, kills it if found, waits 2s for port release, then starts a new one via PowerShell `Start-Process` (visible console window).

## Slash commands available from WeChat
These are sent by messaging the bot on WeChat:
- `/help` — show available commands
- `/status` — show login/debug/verbose/restart state
- `/echo <msg>` — echo test with timing
- `/toggle-debug` — toggle debug mode
- `/verbose` — toggle verbose mode (live tool-call messages)
- `/clear` — reset conversation session
- `/restart` — restart **only** the ACP subprocess (not the whole node process)

Note: `/restart` only restarts the inner ACP agent subprocess. To fully kill and respawn the outer node process, use the **restart.ts** script above.

## Common workflow
1. Read the relevant files in `packages/weixin-acp` and `packages/sdk`
2. Make focused edits only for the requested behavior
3. Rebuild the two packages
4. If needed, restart the local ACP runtime via `restart.ts`
5. Report the exact files changed with `file:line` references

## Useful focus areas
- Slash commands: `packages/sdk/src/messaging/slash-commands.ts`
- WeChat message pipeline: `packages/sdk/src/messaging/process-message.ts`
- ACP bridge: `packages/weixin-acp/src/acp-agent.ts`
- ACP connection lifecycle: `packages/weixin-acp/src/acp-connection.ts`
- ACP streaming/result handling: `packages/weixin-acp/src/response-collector.ts`
