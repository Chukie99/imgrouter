#!/usr/bin/env node
import { exec, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(pkgRoot, "src", "index.ts");

const args = process.argv.slice(2);
const has = (name) => args.includes(name);

function value(name, fallback) {
  const i = args.indexOf(name);
  if (i !== -1 && args[i + 1] && !args[i + 1].startsWith("-")) return args[i + 1];
  const eq = args.find((a) => a.startsWith(name + "="));
  if (eq) return eq.slice(name.length + 1);
  return fallback;
}

const COMMANDS = ["start", "stop", "tray", "help"];
const first = args[0];
const command = first && !first.startsWith("-") && COMMANDS.includes(first) ? first : "start";

const dataDir = value("--home", process.env.IMGROUTER_HOME || path.join(os.homedir(), ".imgrouter"));
const port = Number(value("--port", process.env.PORT || process.env.IMGROUTER_PORT || 8787));
const baseUrl = `http://localhost:${port}`;
const pidFile = path.join(dataDir, "imgrouter.pid");
const logFile = path.join(dataDir, "imgrouter.log");

const TRAY_PS1 = `param([int]$Port = 8787, [string]$Home = "$env:USERPROFILE\\.imgrouter")

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$pidFile = Join-Path $Home "imgrouter.pid"
$url = "http://localhost:$Port/"

$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = [System.Drawing.SystemIcons]::Application
$ni.Text = "imgrouter :$Port"
$ni.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add("Open dashboard")
$openItem.add_Click({ Start-Process $url })
$stopItem = $menu.Items.Add("Stop server")
$stopItem.add_Click({
  if (Test-Path $pidFile) {
    $serverPid = (Get-Content $pidFile -Raw).Trim()
    & taskkill /PID $serverPid /T /F | Out-Null
  }
  $ni.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})
$exitItem = $menu.Items.Add("Exit tray")
$exitItem.add_Click({ $ni.Visible = $false; [System.Windows.Forms.Application]::Exit() })

$ni.ContextMenuStrip = $menu
$ni.add_MouseDoubleClick({ Start-Process $url })

[System.Windows.Forms.Application]::Run()
`;

function printHelp() {
  console.log(`imgrouter — local Gemini image router / gateway

Usage:
  imgrouter                 start in the background and open the dashboard
  imgrouter start           run in the foreground (logs in this terminal) + open dashboard
  imgrouter tray            run in the background with a tray icon (Windows)
  imgrouter stop            stop a running instance
  imgrouter help            show this help

Options:
  --port <n>     port to listen on (default 8787)
  --home <dir>   data directory (default ~/.imgrouter)
  --no-open      do not open the browser
  --daemon, -d   run in the background

Env: IMGROUTER_HOME, PORT, and any value from <home>/.env`);
}

function loadEnvFile(dir) {
  const file = path.join(dir, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === "darwin" ? `open "${url}"` : platform === "win32" ? `start "" "${url}"` : `xdg-open "${url}"`;
  exec(cmd, { shell: true, windowsHide: true }, (err) => {
    if (err) console.log(`Open manually: ${url}`);
  });
}

async function isUp() {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isUp()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function removePidFile() {
  try {
    fs.rmSync(pidFile, { force: true });
  } catch {
    /* ignore */
  }
}

function serverEnv() {
  return {
    ...process.env,
    PORT: String(port),
    DB_PATH: process.env.DB_PATH || path.join(dataDir, "imgrouter.db"),
    IMAGES_DIR: process.env.IMAGES_DIR || path.join(dataDir, "images"),
  };
}

function stopServer() {
  if (!fs.existsSync(pidFile)) {
    console.log("imgrouter is not running (no pid file).");
    return;
  }
  const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  try {
    if (process.platform === "win32") exec(`taskkill /PID ${pid} /T /F`, { windowsHide: true }, () => {});
    else process.kill(pid, "SIGTERM");
    console.log(`Stopped imgrouter (pid ${pid}).`);
  } catch (error) {
    console.log(`Could not stop pid ${pid}: ${error.message}`);
  }
  removePidFile();
}

async function startForeground() {
  fs.mkdirSync(dataDir, { recursive: true });
  loadEnvFile(dataDir);

  if (await isUp()) {
    console.log(`imgrouter is already running -> ${baseUrl}`);
    if (!has("--no-open")) openBrowser(`${baseUrl}/`);
    return;
  }

  console.log(`[imgrouter] starting  (data: ${dataDir})`);
  const child = spawn(process.execPath, ["--import", "tsx", serverEntry], {
    cwd: pkgRoot,
    stdio: "inherit",
    env: serverEnv(),
  });

  fs.writeFileSync(pidFile, String(child.pid));
  child.on("exit", (code) => {
    removePidFile();
    process.exit(code ?? 0);
  });
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));

  if (await waitForHealth(20000)) {
    console.log(`[imgrouter] ready -> ${baseUrl}`);
    if (has("--no-open")) console.log(`Open ${baseUrl}/ in your browser.`);
    else openBrowser(`${baseUrl}/`);
  } else {
    console.log("[imgrouter] server did not become ready in time - check the log above.");
  }
}

async function startDaemon() {
  fs.mkdirSync(dataDir, { recursive: true });
  loadEnvFile(dataDir);

  if (await isUp()) {
    console.log(`imgrouter is already running -> ${baseUrl}`);
    return true;
  }

  const logFd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, ["--import", "tsx", serverEntry], {
    cwd: pkgRoot,
    env: serverEnv(),
    detached: true,
    windowsHide: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  fs.writeFileSync(pidFile, String(child.pid));

  if (await waitForHealth(20000)) {
    console.log(`[imgrouter] running in background -> ${baseUrl}`);
    console.log(`[imgrouter] log: ${logFile}`);
    return true;
  }
  console.log(`[imgrouter] did not start in time - see ${logFile}`);
  return false;
}

async function startDaemonAndOpen() {
  const ok = await startDaemon();
  if (ok && !has("--no-open")) openBrowser(`${baseUrl}/`);
}

async function runTray() {
  if (process.platform !== "win32") {
    console.log("Tray is Windows-only. Use `imgrouter start --daemon` instead.");
    return;
  }
  if (!(await isUp())) {
    console.log("[imgrouter] starting the server in the background for the tray...");
    await startDaemon();
  }

  const scriptPath = path.join(dataDir, "imgrouter-tray.ps1");
  fs.writeFileSync(scriptPath, TRAY_PS1);
  const tray = spawn(
    "powershell.exe",
    ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", scriptPath, "-Port", String(port), "-Home", dataDir],
    { detached: true, windowsHide: true, stdio: "ignore" },
  );
  tray.unref();
  console.log("[imgrouter] tray icon is in the notification area (right-click to open/stop).");
}

if (command === "help" || has("--help") || has("-h")) {
  printHelp();
} else if (command === "stop") {
  stopServer();
} else if (command === "tray") {
  await runTray();
} else if (first === "start" && !has("--daemon") && !has("-d")) {
  await startForeground();
} else {
  // bare `imgrouter` (or --daemon / start --daemon) → background + auto-open the dashboard
  await startDaemonAndOpen();
}
