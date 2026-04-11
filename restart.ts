// restart.ts — Kill the running weixin-acp node process and immediately restart it.
// Usage: deno run --allow-run --allow-sys restart.ts

const PROCESS_MATCH = "weixin-agent-sdk";
const ENTRY_PATH =
  "c:\\Users\\bf_alexphzhou\\weixin-agent-sdk\\packages\\weixin-acp\\dist\\main.mjs";
const NODE_PATH = "C:\\Program Files\\nodejs\\node.exe";
const START_ARGS = [
  ENTRY_PATH,
  "start",
  "--",
  "cmd",
  "/c",
  "codebuddy.cmd",
  "--acp",
];

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
    args: ["/F", "/PID", String(pid)],
    stdout: "piped",
    stderr: "piped",
  });
  await cmd.output();
}

async function startProcess(): Promise<void> {
  const argsEscaped = START_ARGS.map((a) => `'${a.replace(/'/g, "''")}'`).join(",");
  const ps = new Deno.Command("powershell", {
    args: [
      "-NoProfile",
      "-Command",
      `Start-Process -FilePath '${NODE_PATH}' -ArgumentList ${argsEscaped}`,
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
