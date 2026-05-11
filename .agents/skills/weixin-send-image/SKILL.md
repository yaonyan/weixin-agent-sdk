---
name: weixin-send-image
version: 2.0.0
description: "Send an image or message to the current WeChat user. Use this skill whenever the agent needs to push a file to the user mid-work — e.g. after generating a chart, screenshot, QR code, or any local image. The agent can continue working immediately after the send completes."
metadata:
  requires:
    bins: ["weixin-send"]
---

# Weixin Send Image

Use the `weixin-send` CLI to push images or messages to the WeChat user at any point during work. **The agent can continue working right after the command returns.**

## Prerequisites

Before using `weixin-send`, verify it is available:

```bash
which weixin-send
```

If the command is not found, link it from the SDK package in this repo:

```bash
cd packages/sdk && npm link
```

Then confirm it works:

```bash
weixin-send --help
```

## Usage

```bash
# Send an image
weixin-send /tmp/chart.png

# Send an image with a caption
weixin-send /tmp/report.png --text "Report is ready"

# Send a text message
weixin-send --text "Step 1 done, working on step 2..."

# Send a remote image (auto-downloaded)
weixin-send https://example.com/image.png --text "Here is the result"

# Check account status
weixin-send --list-accounts
```

## Mid-work example

The agent is running a multi-step task: generate chart → **send to user** → continue processing.

```bash
# Step 1: generate the chart
python generate_chart.py --output /tmp/sales-chart.png

# Step 2: send it immediately — no need to wait until the task is done
weixin-send /tmp/sales-chart.png --text "Sales chart ready"

# Step 3: keep working
python analyze_data.py ...
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Sent successfully |
| 1 | Send failed (see stderr for details) |

## When to use

- The agent produced an image file (e.g. `/tmp/*.png`) and needs to deliver it to the user
- The agent wants to send a mid-task progress update
- The user asked to send a chart, screenshot, or QR code to WeChat

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `no valid context_token found` | User has not sent a message in the last 20 hours | Ask the user to send any message to refresh the token |
| `no logged-in account` | Login not completed | Run `weixin-login` to scan the QR code |
| file not found | Wrong path | Verify the file exists; use an absolute path |

## How it works

`weixin-send` is a CLI bundled with `weixin-agent-sdk`. It:

1. Reads the logged-in account from `~/.openclaw/openclaw-weixin/accounts/`
2. Loads the cached `context_token` from `~/.openclaw/openclaw-weixin/context-tokens/`
3. Calls `getuploadurl` to obtain a pre-signed CDN upload URL
4. AES-128-ECB encrypts the file and PUT it to the CDN
5. Calls `sendmessage` with the CDN reference to deliver the IMAGE message

## Key files

- CLI source: `packages/sdk/src/bin/weixin-send.ts`
- File upload: `packages/sdk/src/cdn/upload.ts` — `uploadFileToWeixin()`
- Message send: `packages/sdk/src/messaging/send.ts` — `sendImageMessageWeixin()`
- Unified entry: `packages/sdk/src/messaging/send-media.ts` — `sendWeixinMediaFile()`
