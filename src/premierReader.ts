import fs from "node:fs";
import path from "node:path";
import { premierBall } from "./protocol.js";
import { ShotRelay } from "./relay.js";
import { Status } from "./status.js";
import { sleep, Wake } from "./util.js";

type HistoryRecord = Record<string, unknown> & { id: unknown };

/** Reads the history file, retrying briefly because Premier may be mid-write. */
export async function readHistory(file: string): Promise<HistoryRecord[]> {
  let payload: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    let text: string;
    try {
      text = await fs.promises.readFile(file, "utf8");
    } catch {
      return [];
    }
    try {
      payload = JSON.parse(text.replace(/^\uFEFF/, ""));
      break;
    } catch {
      await sleep(20);
    }
  }
  const records = (payload as { records?: unknown } | null)?.records;
  if (!Array.isArray(records)) return [];
  return records.filter(
    (r): r is HistoryRecord =>
      !!r && typeof r === "object" && !Array.isArray(r) && !!(r as HistoryRecord).id,
  );
}

async function drain(file: string, seen: Set<string>, relay: ShotRelay): Promise<boolean> {
  let sent = false;
  for (const record of await readHistory(file)) {
    const id = String(record.id);
    if (seen.has(id)) continue;
    const ball = premierBall(record);
    if (!ball) continue;
    seen.add(id);
    await relay.emit(ball);
    sent = true;
  }
  return sent;
}

/**
 * Watches Premier's history file. Records present at startup are skipped;
 * each new record with usable ball data is sent once.
 */
export async function followPremier(
  file: string,
  relay: ShotRelay,
  signal: AbortSignal,
  status: Status,
): Promise<void> {
  const dir = path.dirname(file);
  const seen = new Set<string>();

  if (!fs.existsSync(dir)) {
    status.show({ note: "waiting for the history folder" }, `waiting for ${file}`);
    while (!signal.aborted && !fs.existsSync(dir)) {
      await relay.heartbeatIfDue();
      await sleep(500, signal);
    }
  }
  if (signal.aborted) return;

  for (const record of await readHistory(file)) seen.add(String(record.id));
  const skipped = `${seen.size} existing shots skipped`;
  status.show({ note: skipped }, `tailing ${file} (${skipped})`);

  const wake = new Wake();
  let watcherOk = true;
  const watcher = fs.watch(dir, () => wake.poke());
  watcher.on("error", () => {
    watcherOk = false;
    wake.poke();
  });

  try {
    while (!signal.aborted) {
      const timeout = Math.max(50, Math.min(500, relay.untilHeartbeat()));
      const changed = await wake.wait(timeout, signal);
      if (signal.aborted) break;
      if ((changed || !watcherOk) && fs.existsSync(file)) await drain(file, seen, relay);
      await relay.heartbeatIfDue();
    }
  } finally {
    watcher.close();
  }
}
