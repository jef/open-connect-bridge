import { app, BrowserWindow, dialog, ipcMain, screen, shell } from "electron";
import path from "node:path";
import { runBridge, BridgeOptions } from "./bridge.js";
import { defaultLaunchLocations, launchApplication, QuickLaunch } from "./quickLaunch.js";
import { Status, StatusFields } from "./status.js";
import { AppSource, DEFAULT_GSPRO_LOG, PREMIER_HISTORY } from "./types.js";
import { contentHeightForScreen } from "./windowSizing.js";

type DesktopOptions = {
  app: AppSource;
  log: string;
  history: string;
  host: string;
  port: number;
  gsproPort: number;
  heartbeat: number;
};

let window: BrowserWindow | null = null;
let controller: AbortController | null = null;
let bridgeTask: Promise<void> | null = null;
let currentStatus: StatusFields | null = null;
const logs: string[] = [];
let quickLaunch: QuickLaunch;

function send(channel: string, value: unknown): void {
  if (window && !window.isDestroyed()) window.webContents.send(channel, value);
}

function recordLog(line: string): void {
  logs.push(line);
  if (logs.length > 200) logs.splice(0, logs.length - 200);
  send("bridge:log", line);
}

function parseOptions(input: unknown): DesktopOptions {
  if (!input || typeof input !== "object") throw new Error("Invalid bridge settings");
  const value = input as Record<string, unknown>;
  const appSource = value.app;
  if (appSource !== "gspro" && appSource !== "premier") {
    throw new Error("Choose GSPconnect or Foresight Premier");
  }
  const host = typeof value.host === "string" ? value.host.trim() : "";
  const log = typeof value.log === "string" ? value.log.trim() : "";
  const history = typeof value.history === "string" ? value.history.trim() : "";
  if (!host) throw new Error("Open Connect host is required");
  if (!log || !history) throw new Error("Log and history file paths are required");
  const port = Number(value.port);
  const gsproPort = Number(value.gsproPort);
  const heartbeat = Number(value.heartbeat);
  for (const [label, number] of [
    ["Open Connect port", port],
    ["GSPconnect port", gsproPort],
  ] as const) {
    if (!Number.isInteger(number) || number < 1 || number > 65535) {
      throw new Error(`${label} must be from 1 to 65535`);
    }
  }
  if (!Number.isFinite(heartbeat) || heartbeat <= 0) {
    throw new Error("Heartbeat must be a positive number of seconds");
  }
  return { app: appSource, log, history, host, port, gsproPort, heartbeat };
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1040,
    height: 780,
    minWidth: 760,
    minHeight: 640,
    title: "Open Connect Bridge",
    backgroundColor: "#0b1115",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void window.loadFile(path.join(__dirname, "ui", "index.html"));
  window.on("unmaximize", () => send("bridge:measure-window", null));
  window.on("leave-full-screen", () => send("bridge:measure-window", null));
  window.on("restore", () => send("bridge:measure-window", null));
  window.on("closed", () => {
    window = null;
    stopBridge();
  });
}

async function stopBridge(): Promise<void> {
  if (!controller) return;
  const active = bridgeTask;
  controller.abort();
  await active;
  controller = null;
  bridgeTask = null;
  send("bridge:running", false);
}

ipcMain.handle("bridge:get-initial", () => ({
  status: currentStatus,
  logs,
  running: controller !== null,
  defaults: {
    log: DEFAULT_GSPRO_LOG,
    history: PREMIER_HISTORY,
  },
}));

ipcMain.handle("bridge:start", async (_event, input: unknown) => {
  if (controller) throw new Error("The bridge is already running");
  const options = parseOptions(input);
  const abort = new AbortController();
  controller = abort;
  const status = new Status(false, undefined, recordLog, (fields) => {
    currentStatus = fields;
    send("bridge:status", fields);
  });
  const bridgeOptions: BridgeOptions = {
    ...options,
    heartbeatMs: options.heartbeat * 1000,
  };
  bridgeTask = runBridge(bridgeOptions, status, abort.signal)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      status.show({ lastError: message }, `fatal: ${message}`);
    })
    .finally(() => {
      if (controller === abort) {
        controller = null;
        bridgeTask = null;
        send("bridge:running", false);
      }
    });
  send("bridge:running", true);
  return true;
});

ipcMain.handle("bridge:stop", stopBridge);
ipcMain.on("bridge:resize-window", (event, height: unknown) => {
  if (
    !window ||
    event.sender !== window.webContents ||
    typeof height !== "number" ||
    !Number.isFinite(height) ||
    height <= 0 ||
    window.isMaximized() ||
    window.isFullScreen() ||
    window.isMinimized()
  ) {
    return;
  }
  const bounds = window.getBounds();
  const [width, currentHeight] = window.getContentSize();
  const workArea = screen.getDisplayMatching(bounds).workArea;
  const targetHeight = contentHeightForScreen(
    height,
    bounds.height - currentHeight,
    workArea.height,
  );
  if (targetHeight === currentHeight) return;
  window.setContentSize(width, targetHeight);
  const resized = window.getBounds();
  const y = Math.max(
    workArea.y,
    Math.min(resized.y, workArea.y + workArea.height - resized.height),
  );
  if (y !== resized.y) window.setPosition(resized.x, y);
});
function launchSource(value: unknown): AppSource {
  if (value !== "gspro" && value !== "premier") throw new Error("Invalid launch monitor app");
  return value;
}

ipcMain.handle("bridge:launch", (_event, source: unknown) =>
  quickLaunch.open(launchSource(source)),
);
ipcMain.handle("bridge:choose-app", (_event, source: unknown) =>
  quickLaunch.choose(launchSource(source)),
);
ipcMain.handle("bridge:browse", async (_event, kind: unknown) => {
  const result = await dialog.showOpenDialog(window!, {
    properties: ["openFile"],
    filters:
      kind === "history"
        ? [
            { name: "JSON files", extensions: ["json"] },
            { name: "All files", extensions: ["*"] },
          ]
        : [
            { name: "Log files", extensions: ["txt", "log"] },
            { name: "All files", extensions: ["*"] },
          ],
  });
  return result.canceled ? null : result.filePaths[0];
});

app.whenReady().then(() => {
  quickLaunch = new QuickLaunch(
    path.join(app.getPath("userData"), "quick-launch.json"),
    defaultLaunchLocations(process.platform, process.env),
    async (source) => {
      if (!window) throw new Error("The app window is not available");
      const result = await dialog.showOpenDialog(window, {
        title: `Choose ${source === "gspro" ? "GSPconnect" : "Foresight Premier"}`,
        properties: process.platform === "darwin" ? ["openFile", "openDirectory"] : ["openFile"],
        ...(process.platform === "win32"
          ? { filters: [{ name: "Applications and shortcuts", extensions: ["exe", "lnk"] }] }
          : {}),
      });
      return result.canceled ? null : result.filePaths[0];
    },
    (file) => launchApplication(file, process.platform, shell.openPath),
  );
  createWindow();
});
app.on("before-quit", () => {
  controller?.abort();
});
app.on("window-all-closed", () => {
  app.quit();
});
