// @ts-nocheck — This file is meant to run with Deno, not Node.js tsc.
// restart.ts — Kill the running weixin-acp node process and immediately restart it.
// The ACP profile config is read by the package itself
// from ~/.config/weixin-acp/acp-profiles.json (or WEIXIN_ACP_STATE_DIR).
//
// Prerequisites:
//   1. pnpm install
//   2. pnpm --filter weixin-agent-sdk run build
//   3. pnpm --filter weixin-acp run build
//   4. pnpm --filter weixin-acp run login   (scan QR code to sign in)
//
// Usage:   deno run -A restart.ts
// Supports: Windows (PowerShell) · macOS · Linux

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROCESS_MATCH = "weixin-agent-sdk";
const isWindows = Deno.build.os === "windows";
const ENTRY_PATH = join(
  Deno.cwd(),
  "packages",
  "weixin-acp",
  "dist",
  "main.mjs",
);
const NODE_PATH = isWindows
  ? join(
    Deno.env.get("ProgramFiles") ?? "C:\\Program Files",
    "nodejs",
    "node.exe",
  )
  : "node";

function resolveStateDir(): string {
  const custom = Deno.env.get("WEIXIN_ACP_STATE_DIR")?.trim();
  if (custom) return custom;

  const xdg = Deno.env.get("XDG_CONFIG_HOME")?.trim();
  if (xdg) return join(xdg, "weixin-acp");

  return join(homedir(), ".config", "weixin-acp");
}

const STATE_DIR = resolveStateDir();
const STDOUT_LOG_PATH = join(STATE_DIR, "weixin-acp.out.log");
const STDERR_LOG_PATH = join(STATE_DIR, "weixin-acp.err.log");

function toShellLiteral(value: string): string {
  if (isWindows) return `'${value.replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findPids(): Promise<number[]> {
  if (isWindows) {
    const cmd = new Deno.Command("powershell", {
      args: [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${ENTRY_PATH_PATTERN}*' -and $_.Name -eq 'node.exe' } | Select-Object -ExpandProperty ProcessId`,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const { stdout } = await cmd.output();
    const text = new TextDecoder().decode(stdout).trim();
    if (!text) return [];
    return text
      .split("\n")
      .map((line) => parseInt(line.trim(), 10))
      .filter((pid) => !Number.isNaN(pid));
  }

  const cmd = new Deno.Command("pgrep", {
    args: ["-f", `${PROCESS_MATCH}.*weixin-acp/dist/main.mjs`],
    stdout: "piped",
    stderr: "piped",
  });
  const { stdout, code } = await cmd.output();
  if (code !== 0) return [];
  const text = new TextDecoder().decode(stdout).trim();
  if (!text) return [];
  return text
    .split("\n")
    .map((line) => parseInt(line.trim(), 10))
    .filter((pid) => !Number.isNaN(pid));
}

async function killProcesses(pids: number[]): Promise<void> {
  if (pids.length === 0) return;

  if (isWindows) {
    for (const pid of pids) {
      const cmd = new Deno.Command("taskkill", {
        args: ["/F", "/T", "/PID", String(pid)],
        stdout: "piped",
        stderr: "piped",
      });
      await cmd.output();
    }
    return;
  }

  const cmd = new Deno.Command("kill", {
    args: pids.map(String),
    stdout: "piped",
    stderr: "piped",
  });
  await cmd.output();
}

async function startProcess(): Promise<number | null> {
  const workingDirectory = Deno.cwd();
  mkdirSync(STATE_DIR, { recursive: true });

  console.log("Starting weixin-acp");
  console.log(`  cwd: ${workingDirectory}`);
  console.log(`  entry: ${ENTRY_PATH}`);
  console.log(`  stdout log: ${STDOUT_LOG_PATH}`);
  console.log(`  stderr log: ${STDERR_LOG_PATH}`);

  if (isWindows) {
    const argsEscaped = [ENTRY_PATH].map(toShellLiteral).join(",");
    const workingDirectoryEscaped = toShellLiteral(workingDirectory);
    const stdoutLogEscaped = toShellLiteral(STDOUT_LOG_PATH);
    const stderrLogEscaped = toShellLiteral(STDERR_LOG_PATH);

    const ps = new Deno.Command("powershell", {
      args: [
        "-NoProfile",
        "-Command",
        `$p = Start-Process -FilePath ${
          toShellLiteral(NODE_PATH)
        } -WorkingDirectory ${workingDirectoryEscaped} -ArgumentList ${argsEscaped} -RedirectStandardOutput ${stdoutLogEscaped} -RedirectStandardError ${stderrLogEscaped} -PassThru; $p.Id`,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const { stdout, stderr } = await ps.output();
    const err = new TextDecoder().decode(stderr).trim();
    if (err) console.error(err);

    const text = new TextDecoder().decode(stdout).trim();
    if (!text) return null;
    const pid = parseInt(text.split("\n")[0].trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  }

  const shellCommand = [
    `cd ${toShellLiteral(workingDirectory)}`,
    `touch ${toShellLiteral(STDOUT_LOG_PATH)} ${toShellLiteral(STDERR_LOG_PATH)}`,
    `nohup ${toShellLiteral(NODE_PATH)} ${toShellLiteral(ENTRY_PATH)} >> ${toShellLiteral(STDOUT_LOG_PATH)} 2>> ${toShellLiteral(STDERR_LOG_PATH)} < /dev/null &`,
    "echo $!",
  ].join("\n");

  const cmd = new Deno.Command("sh", {
    args: ["-c", shellCommand],
    stdout: "piped",
    stderr: "piped",
  });
  const { stdout, stderr } = await cmd.output();
  const err = new TextDecoder().decode(stderr).trim();
  if (err) console.error(err);

  const text = new TextDecoder().decode(stdout).trim();
  if (!text) return null;
  const pid = parseInt(text.split("\n").pop()?.trim() ?? "", 10);
  return Number.isNaN(pid) ? null : pid;
}

async function waitForStartup(expectedPid: number | null): Promise<number[]> {
  for (let i = 0; i < 6; i++) {
    await sleep(500);
    const pids = await findPids();
    if (expectedPid !== null) {
      if (pids.includes(expectedPid)) return pids;
    } else if (pids.length > 0) {
      return pids;
    }
  }
  return [];
}

async function main() {
  const existingPids = await findPids();
  if (existingPids.length > 0) {
    await killProcesses(existingPids);
    console.log(`Killed PIDs ${existingPids.join(", ")}`);
    await sleep(2000);
  } else {
    console.log("No existing weixin-acp process");
  }

  const startedPid = await startProcess();
  const runningPids = await waitForStartup(startedPid);

  if (runningPids.length > 0) {
    console.log(
      `Started weixin-acp${startedPid !== null ? ` (pid ${startedPid})` : ""}`,
    );
    console.log(`  running pids: ${runningPids.join(", ")}`);
    return;
  }

  console.error("weixin-acp may have exited immediately; check logs:");
  console.error(`  stdout: ${STDOUT_LOG_PATH}`);
  console.error(`  stderr: ${STDERR_LOG_PATH}`);
  Deno.exit(1);
}

main();
