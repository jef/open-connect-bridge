import { heartbeatMessage, shotMessage, shotText } from "./protocol.js";
import { Status } from "./status.js";
import { BallData, Sender } from "./types.js";

/** Numbers shots, sends them, and keeps the heartbeat schedule shared by every source. */
export class ShotRelay {
  private shotNumber = 0;
  private nextHeartbeat: number;

  constructor(
    private readonly client: Sender,
    private readonly status: Status,
    private readonly heartbeatMs: number,
  ) {
    this.nextHeartbeat = Date.now() + heartbeatMs;
  }

  /** Time in ms until the next heartbeat is due. */
  untilHeartbeat(): number {
    return this.nextHeartbeat - Date.now();
  }

  async emit(ball: BallData): Promise<void> {
    this.shotNumber++;
    const line = shotText(ball);
    this.status.show(
      { shots: this.shotNumber, lastShot: line },
      `shot ${this.shotNumber}: ${line}`,
    );
    if (await this.client.send(shotMessage(ball, this.shotNumber))) {
      this.nextHeartbeat = Date.now() + this.heartbeatMs;
    } else {
      const missed = "shot was not delivered; Open Connect listener is down";
      this.status.show({ lastError: missed }, missed);
    }
  }

  async heartbeatIfDue(): Promise<void> {
    if (Date.now() < this.nextHeartbeat) return;
    await this.client.send(heartbeatMessage(this.shotNumber));
    this.nextHeartbeat = Date.now() + this.heartbeatMs;
  }
}
