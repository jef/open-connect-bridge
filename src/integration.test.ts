import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { runBridge } from "./bridge.js";
import { followGsproLog } from "./gsproLog.js";
import { OpenConnectClient } from "./openConnectClient.js";
import { followPremier } from "./premierReader.js";
import { shotMessage } from "./protocol.js";
import { ShotRelay } from "./relay.js";
import { Status } from "./status.js";
import { OpenConnectMessage } from "./types.js";
import { sleep } from "./util.js";

interface Listener {
  port: number;
  received: OpenConnectMessage[];
  close(): Promise<void>;
}

async function listen(reply = true): Promise<Listener> {
  const received: OpenConnectMessage[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        received.push(JSON.parse(buffer.slice(0, index)));
        buffer = buffer.slice(index + 1);
        if (reply) socket.write('{"Code":200,"Message":"Shot received"}\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

async function until(condition: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "timed out waiting for condition");
    await sleep(20);
  }
}

const ball = {
  Speed: 80,
  VLA: 10,
  HLA: 1,
  SideSpin: 0,
  TotalSpin: 3000,
  BackSpin: 3000,
  SpinAxis: 0,
};

test("client sends newline-delimited JSON and records the sim reply", async () => {
  const listener = await listen();
  const status = new Status(
    false,
    () => undefined,
    () => undefined,
  );
  const client = new OpenConnectClient("127.0.0.1", listener.port, status);
  try {
    assert.equal(await client.send(shotMessage(ball, 1)), true);
    await until(() => status.simReply === "Shot received");
    assert.equal(listener.received[0].ShotNumber, 1);
    assert.equal(status.openConnect, `connected   127.0.0.1:${listener.port}`);
  } finally {
    client.close();
    await listener.close();
  }
});

test("client reports failure when the listener is down, then recovers", async () => {
  const probe = await listen();
  const port = probe.port;
  await probe.close();

  const status = new Status(
    false,
    () => undefined,
    () => undefined,
  );
  const client = new OpenConnectClient("127.0.0.1", port, status);
  try {
    assert.equal(await client.send(shotMessage(ball, 1)), false);
    assert.match(status.lastError, /Open Connect send failed/);
    assert.equal(status.openConnect, `waiting for 127.0.0.1:${port}`);

    const server = net.createServer((s) => s.on("data", () => undefined));
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    assert.equal(await client.send(shotMessage(ball, 2)), true);
    assert.equal(status.lastError, "none");
    client.close();
    server.close();
  } finally {
    client.close();
  }
});

test("GSPconnect log: new shots are forwarded, existing ones skipped", async () => {
  const listener = await listen();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-gspro-"));
  const log = path.join(dir, "ConnectDebug.txt");
  const marker = "INFO - Logging ball data IMMEDIATELY before sending to GSPro\n";
  fs.writeFileSync(log, marker + "INFO - [1,2,3,4,5,6,7,0]\n");

  const status = new Status(
    false,
    () => undefined,
    () => undefined,
  );
  const client = new OpenConnectClient("127.0.0.1", listener.port, status);
  const relay = new ShotRelay(client, status, 60_000);
  const abort = new AbortController();
  const done = followGsproLog(log, relay, abort.signal, status);
  try {
    await sleep(400);
    fs.appendFileSync(log, marker + "INFO - [82.5,12.25,-1.5,100,3000.5,2999,2.5,0]\n");
    await until(() => listener.received.length === 1);
    const message = listener.received[0];
    assert.equal(message.ShotNumber, 1);
    assert.equal(message.BallData?.Speed, 82.5);
    assert.equal(message.BallData?.HLA, -1.5);
    assert.equal(status.shots, 1);
  } finally {
    abort.abort();
    await done;
    client.close();
    await listener.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Premier history: skips existing records and sends each new one once", async () => {
  const listener = await listen();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-premier-"));
  const file = path.join(dir, "history.json");
  const record = (id: string, speed: number) => ({
    id,
    ballSpeedMPH: speed,
    launchAngleDeg: 15,
    azimuthDeg: 2,
    backspinRPM: 4000,
    sideSpinRPM: 300,
    spinAxisTiltDeg: 4,
  });
  fs.writeFileSync(file, JSON.stringify({ records: [record("old", 70)] }));

  const status = new Status(
    false,
    () => undefined,
    () => undefined,
  );
  const client = new OpenConnectClient("127.0.0.1", listener.port, status);
  const relay = new ShotRelay(client, status, 60_000);
  const abort = new AbortController();
  const done = followPremier(file, relay, abort.signal, status);
  try {
    await until(() => status.note === "1 existing shots skipped");
    fs.writeFileSync(file, JSON.stringify({ records: [record("old", 70), record("new", 91.5)] }));
    await until(() => listener.received.length === 1);
    fs.writeFileSync(file, JSON.stringify({ records: [record("old", 70), record("new", 91.5)] }));
    await sleep(300);
    assert.equal(listener.received.length, 1);
    assert.equal(listener.received[0].BallData?.Speed, 91.5);
  } finally {
    abort.abort();
    await done;
    client.close();
    await listener.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("heartbeats are sent while idle", async () => {
  const listener = await listen();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-hb-"));
  const file = path.join(dir, "history.json");
  fs.writeFileSync(file, '{"records":[]}');

  const status = new Status(
    false,
    () => undefined,
    () => undefined,
  );
  const client = new OpenConnectClient("127.0.0.1", listener.port, status);
  const relay = new ShotRelay(client, status, 200);
  const abort = new AbortController();
  const done = followPremier(file, relay, abort.signal, status);
  try {
    await until(() => listener.received.length >= 2);
    assert.ok(listener.received.every((m) => m.ShotDataOptions.IsHeartBeat));
  } finally {
    abort.abort();
    await done;
    client.close();
    await listener.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("bridge uses the configured target and switches target after restart", async () => {
  const first = await listen(false);
  const second = await listen(false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-target-"));
  const file = path.join(dir, "history.json");
  fs.writeFileSync(file, '{"records":[]}');
  const status = new Status(
    false,
    () => undefined,
    () => undefined,
  );
  const options = {
    app: "premier" as const,
    log: "",
    history: file,
    host: "127.0.0.1",
    port: first.port,
    gsproPort: 9050,
    heartbeatMs: 100,
  };
  let abort = new AbortController();
  let running = runBridge(options, status, abort.signal);
  try {
    await until(() => first.received.length > 0);
    assert.equal(second.received.length, 0);
    abort.abort();
    await running;
    const firstCount = first.received.length;
    abort = new AbortController();
    running = runBridge({ ...options, port: second.port }, status, abort.signal);
    await until(() => second.received.length > 0);
    assert.equal(first.received.length, firstCount);
    assert.equal(status.openConnect, `connected   127.0.0.1:${second.port}`);
  } finally {
    abort.abort();
    await running;
    await first.close();
    await second.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
