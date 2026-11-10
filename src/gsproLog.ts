import fs from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { parseGsproBallLine } from "./protocol.js";
import { ShotRelay } from "./relay.js";
import { Status } from "./status.js";
import { GSPRO_MARKER } from "./types.js";
import { sleep } from "./util.js";

const POLL_MS = 200;

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Tails GSPconnect's debug log. The marker line is followed by a line holding
 * the ball data array; anything already in the log at startup is skipped.
 */
export async function followGsproLog(
  file: string,
  relay: ShotRelay,
  signal: AbortSignal,
  status: Status,
): Promise<void> {
  if (!(await exists(file))) {
    status.show({ note: "waiting for the log file" }, `waiting for log ${file}`);
    while (!signal.aborted && !(await exists(file))) await sleep(1000, signal);
  }
  if (signal.aborted) return;

  let handle = await fs.open(file, "r");
  let position = (await handle.stat()).size;
  let decoder = new StringDecoder("utf8");
  let pending = "";
  let waitingForArray = false;
  status.show({ note: "" }, `tailing ${file}`);

  const handleLine = async (line: string): Promise<void> => {
    if (line.includes(GSPRO_MARKER)) {
      waitingForArray = true;
      return;
    }
    if (!waitingForArray) return;
    waitingForArray = false;
    const ball = parseGsproBallLine(line);
    if (ball) await relay.emit(ball);
  };

  try {
    while (!signal.aborted) {
      let size: number;
      try {
        size = (await fs.stat(file)).size;
      } catch {
        await sleep(POLL_MS, signal);
        continue;
      }

      if (size < position) {
        // The log was truncated or replaced; start over on the new file.
        await handle.close();
        handle = await fs.open(file, "r");
        position = 0;
        decoder = new StringDecoder("utf8");
        pending = "";
        waitingForArray = false;
      }

      if (size > position) {
        const buffer = Buffer.alloc(Math.min(size - position, 1 << 20));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        position += bytesRead;
        pending += decoder.write(buffer.subarray(0, bytesRead));
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) await handleLine(line);
        if (bytesRead > 0) continue;
      }

      await relay.heartbeatIfDue();
      await sleep(POLL_MS, signal);
    }
  } finally {
    await handle.close();
  }
}
