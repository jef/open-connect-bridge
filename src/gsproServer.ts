import net from "node:net";
import { Status } from "./status.js";

/** Accepts GSPconnect's outbound GSPro connection and discards its frames. */
export function serveGsproPort(
  port: number,
  signal: AbortSignal,
  status: Status,
  host = "127.0.0.1",
): Promise<void> {
  return new Promise((resolve) => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer();
    let listening = `listening on ${host}:${port}`;

    server.on("connection", (socket) => {
      sockets.add(socket);
      const peer = `${socket.remoteAddress}:${socket.remotePort}`;
      status.show({ gspro: `connected from ${peer}` }, `GSPconnect connected from ${peer}`);
      socket.on("data", () => undefined);
      socket.on("error", () => undefined);
      socket.on("close", () => {
        sockets.delete(socket);
        if (!signal.aborted && sockets.size === 0) {
          status.show({ gspro: listening }, "GSPconnect disconnected");
        }
      });
    });

    server.on("error", (error: NodeJS.ErrnoException) => {
      const failed = `cannot listen on ${host}:${port} (${error.code ?? error.message})`;
      listening = failed;
      status.show({ gspro: failed }, failed);
    });

    const finish = () => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
      if (!server.listening) resolve();
    };

    server.listen(port, host, () => {
      status.show({ gspro: listening }, `listening for GSPconnect on ${host}:${port}`);
    });
    if (signal.aborted) finish();
    else signal.addEventListener("abort", finish, { once: true });
  });
}
