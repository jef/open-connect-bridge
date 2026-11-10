import { parseArgs } from "node:util";
import { runBridge } from "./bridge.js";
import { listenKeys, readKey } from "./keys.js";
import { menuChoice } from "./protocol.js";
import { paintMenu, renderMenu, Status } from "./status.js";
import { AppSource, DEFAULT_GSPRO_LOG, PREMIER_HISTORY } from "./types.js";

const HELP = `Open Connect bridge

Sends GSPconnect or Foresight Premier shots to an Open Connect listener.

Usage: open-connect-bridge [options]

  --app <gspro|premier>   Skip the menu and use this app
  --log <path>            GSPconnect log (default ${DEFAULT_GSPRO_LOG})
  --history <path>        Premier history.json (default ${PREMIER_HISTORY})
  --host <host>           Open Connect host (default 127.0.0.1)
  --port <port>           Open Connect port (default 921)
  --gspro-port <port>     Port GSPconnect connects to (default 9050)
  --heartbeat <seconds>   Heartbeat interval (default 5)
  -h, --help              Show this help
`;

function port(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new UsageError(`${name} must be a port number from 1 to 65535`);
  }
  return n;
}

class UsageError extends Error {}

async function chooseApp(raw: string | undefined, interactive: boolean): Promise<AppSource | null> {
  if (raw) {
    const app = menuChoice(raw);
    if (app !== "gspro" && app !== "premier") throw new UsageError("choose gspro or premier");
    return app;
  }
  if (!interactive) throw new UsageError("pass --app gspro or premier");

  let complaint = "";
  for (;;) {
    paintMenu(renderMenu(complaint));
    const key = await readKey();
    const picked = key === null ? "quit" : menuChoice(key);
    if (picked === "quit") return null;
    if (picked) return picked;
    complaint = "choose 1, 2, or Q";
  }
}

async function run(): Promise<number> {
  const { values } = parseArgs({
    options: {
      app: { type: "string" },
      log: { type: "string", default: DEFAULT_GSPRO_LOG },
      history: { type: "string", default: PREMIER_HISTORY },
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "921" },
      "gspro-port": { type: "string", default: "9050" },
      heartbeat: { type: "string", default: "5" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const openConnectPort = port(values.port!, "--port");
  const gsproPort = port(values["gspro-port"]!, "--gspro-port");
  const heartbeat = Number(values.heartbeat);
  if (!Number.isFinite(heartbeat) || heartbeat <= 0) {
    throw new UsageError("--heartbeat must be a positive number of seconds");
  }

  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY;
  const app = await chooseApp(values.app, interactive);
  if (app === null) return 0;

  const status = new Status(interactive);
  const abort = new AbortController();
  const stop = () => abort.abort();

  let stopKeys = () => {};
  if (status.enabled) {
    status.show();
    stopKeys = listenKeys((key) => {
      if (key.toLowerCase() === "q") stop();
    });
  }
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    await runBridge(
      {
        app,
        log: values.log!,
        history: values.history!,
        host: values.host!,
        port: openConnectPort,
        gsproPort,
        heartbeatMs: heartbeat * 1000,
      },
      status,
      abort.signal,
    );
  } finally {
    stop();
    stopKeys();
    status.close();
    console.log("stopped");
  }
  return 0;
}

async function pauseBeforeClose(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  console.log("\nPress any key to close.");
  await readKey();
}

run().then(
  (code) => process.exit(code),
  async (error: unknown) => {
    const usage = error instanceof UsageError;
    const message = error instanceof Error ? error.message : String(error);
    console.error(usage ? message : `fatal: ${message}`);
    if (!usage) await pauseBeforeClose();
    process.exit(usage ? 2 : 1);
  },
);
