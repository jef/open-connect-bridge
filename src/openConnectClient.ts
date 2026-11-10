import net from "node:net";
import { shortReply } from "./protocol.js";
import { OpenConnectMessage, Sender } from "./types.js";
import { Status } from "./status.js";

const CONNECT_TIMEOUT_MS = 5000;

/** Persistent newline-delimited JSON connection to an Open Connect listener. */
export class OpenConnectClient implements Sender {
  private socket: net.Socket | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly target: string;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly status?: Status,
  ) {
    this.target = `${host}:${port}`;
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }

  /** Sends are serialized so shots and heartbeats never interleave on the wire. */
  send(message: OpenConnectMessage): Promise<boolean> {
    const result = this.queue.then(() => this.sendNow(message));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async sendNow(message: OpenConnectMessage): Promise<boolean> {
    const payload = JSON.stringify(message) + "\n";
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        if (this.socket && (this.socket.destroyed || !this.socket.writable)) {
          this.socket = null;
        }
        if (!this.socket) {
          this.socket = await this.connect();
          this.report(
            `connected   ${this.target}`,
            undefined,
            `connected to Open Connect ${this.target}`,
          );
        }
        await this.write(this.socket, payload);
        this.report(`connected   ${this.target}`, "none");
        return true;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const failed = `Open Connect send failed (${reason}); reconnecting`;
        this.report(`waiting for ${this.target}`, failed, failed);
        this.socket?.destroy();
        this.socket = null;
      }
    }
    return false;
  }

  private connect(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      socket.setNoDelay(true);
      socket.setTimeout(CONNECT_TIMEOUT_MS, () =>
        socket.destroy(new Error("connection timed out")),
      );
      socket.once("connect", () => {
        socket.setTimeout(0);
        resolve(socket);
      });
      socket.on("error", (error) => {
        if (this.socket === socket) this.socket = null;
        reject(error);
      });
      socket.on("close", () => {
        if (this.socket === socket) this.socket = null;
      });
      socket.on("data", (data) => this.onReply(data.toString("utf8")));
    });
  }

  private write(socket: net.Socket, payload: string): Promise<void> {
    return new Promise((resolve, reject) => {
      socket.write(payload, (error) => (error ? reject(error) : resolve()));
    });
  }

  private onReply(raw: string): void {
    const text = raw.trim();
    if (!text) return;
    if (this.status) this.status.show({ simReply: shortReply(text) }, `sim: ${text}`);
    else console.log(`sim: ${text}`);
  }

  private report(openConnect: string, lastError?: string, log?: string): void {
    if (!this.status) {
      if (log) console.log(log);
      return;
    }
    this.status.show(lastError === undefined ? { openConnect } : { openConnect, lastError }, log);
  }
}
