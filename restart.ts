// restart.ts — Kill the running weixin-acp node process and immediately restart it.
// Reads the ACP profile config (~/.openclaw/acp-profiles.json) to determine
// which agent to launch, including env vars.
// Usage: deno run --allow-run --allow-sys --allow-read --allow-env restart.ts

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PROCESS_MATCH = "weixin-agent-sdk";
const ENTRY_PATH =
  "c:\\Users\\bf_alexphzhou\\weixin-agent-sdk\\packages\\weixin-acp\\dist\\main.mjs";
const NODE_PATH = "C:\\Program Files\\nodejs\\node.exe";

function toPowerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

interface AcpProfile {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface AcpConfig {
  profiles: Record<string, AcpProfile>;
  activeProfile?: string;
  defaultProfile?: string;
}

function resolveStateDir(): string {
  return (
    Deno.env.get("OPENCLAW_STATE_DIR")?.trim() ||
    Deno.env.get("CLAWDBOT_STATE_DIR")?.trim() ||
    join(homedir(), ".openclaw")
  );
}

function loadAcpConfig(): AcpConfig {
  const configPath = join(resolveStateDir(), "acp-profiles.json");
  if (!existsSync(configPath)) return { profiles: {} };
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as AcpConfig;
    if (parsed && typeof parsed.profiles === "object") return parsed;
  } catch {
    // corrupt — start fresh
  }
  return { profiles: {} };
}

/** Resolve the ACP command + args + env from the profile config. */
function resolveProfile(): {
  args: string[];
  env?: Record<string, string>;
  profileName: string;
} {
  const config = loadAcpConfig();

  // Prefer activeProfile, fall back to defaultProfile
  const profileName = config.activeProfile || config.defaultProfile;
  if (profileName) {
    const profile = config.profiles[profileName];
    if (profile) {
      return {
        args: [ENTRY_PATH, "start", "--", profile.command, ...(profile.args ?? [])],
        env: profile.env,
        profileName,
      };
    }
  }

  // Fallback: use the "codebuddy" shortcut
  return {
    args: [ENTRY_PATH, "codebuddy"],
    profileName: "codebuddy (fallback)",
  };
}

async function findPid(): Promise<number | null> {
  const cmd = new Deno.Command("powershell", {
    args: [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${PROCESS_MATCH}*packages\\weixin-acp\\dist\\main.mjs*' -and $_.Name -eq 'node.exe' } | Select-Object -ExpandProperty ProcessId`,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const { stdout } = await cmd.output();
  const text = new TextDecoder().decode(stdout).trim();
  if (!text) return null;
  const pid = parseInt(text.split("\n")[0].trim(), 10);
  return Number.isNaN(pid) ? null : pid;
}

async function killProcess(pid: number): Promise<void> {
  const cmd = new Deno.Command("taskkill", {
    args: ["/F", "/T", "/PID", String(pid)],
    stdout: "piped",
    stderr: "piped",
  });
  await cmd.output();
}

async function startProcess(): Promise<void> {
  const { args, env, profileName } = resolveProfile();
  const workingDirectory = Deno.cwd();
  console.log(`Starting with profile: ${profileName}`);
  console.log(`  cwd: ${workingDirectory}`);
  console.log(`  args: ${args.join(" ")}`);
  if (env) console.log(`  env: ${JSON.stringify(env)}`);

  const argsEscaped = args.map(toPowerShellLiteral).join(",");
  const workingDirectoryEscaped = toPowerShellLiteral(workingDirectory);

  // Build env var setup if profile has env
  let envSetup = "";
  if (env && Object.keys(env).length > 0) {
    const envEntries = Object.entries(env)
      .map(([k, v]) => `$env:${k}=${toPowerShellLiteral(v)};`)
      .join("");
    envSetup = envEntries;
  }

  const ps = new Deno.Command("powershell", {
    args: [
      "-NoProfile",
      "-Command",
      `${envSetup}Start-Process -FilePath ${toPowerShellLiteral(NODE_PATH)} -WorkingDirectory ${workingDirectoryEscaped} -ArgumentList ${argsEscaped}`,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const { stderr } = await ps.output();
  const err = new TextDecoder().decode(stderr).trim();
  if (err) console.error(err);
}

async function main() {
  const pid = await findPid();
  if (pid !== null) {
    await killProcess(pid);
    console.log(`Killed PID ${pid}`);
    await new Promise((r) => setTimeout(r, 2000));
  } else {
    console.log("No existing weixin-acp process");
  }
  await startProcess();
  console.log("Started weixin-acp");
}

main();
