import { OpenConnectClient } from "./openConnectClient.js";
import { followGsproLog } from "./gsproLog.js";
import { serveGsproPort } from "./gsproServer.js";
import { followPremier } from "./premierReader.js";
import { ShotRelay } from "./relay.js";
import { Status } from "./status.js";
import { AppSource } from "./types.js";

export interface BridgeOptions {
  app: AppSource;
  log: string;
  history: string;
  host: string;
  port: number;
  gsproPort: number;
  heartbeatMs: number;
}

export async function runBridge(
  options: BridgeOptions,
  status: Status,
  signal: AbortSignal,
): Promise<void> {
  status.show({
    source: options.app === "gspro" ? "GSPconnect" : "Foresight Premier",
    watching: options.app === "gspro" ? options.log : options.history,
    openConnect: `waiting for ${options.host}:${options.port}`,
    gspro: options.app === "gspro" ? `listening on 127.0.0.1:${options.gsproPort}` : null,
  });

  const client = new OpenConnectClient(options.host, options.port, status);
  const relay = new ShotRelay(client, status, options.heartbeatMs);
  try {
    if (options.app === "gspro") {
      const server = serveGsproPort(options.gsproPort, signal, status);
      try {
        await followGsproLog(options.log, relay, signal, status);
      } finally {
        await server;
      }
    } else {
      await followPremier(options.history, relay, signal, status);
    }
  } finally {
    client.close();
  }
}
