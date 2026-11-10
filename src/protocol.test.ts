import assert from "node:assert/strict";
import { test } from "vitest";
import {
  heartbeatMessage,
  menuChoice,
  parseGsproBallLine,
  premierBall,
  shortReply,
  shotMessage,
} from "./protocol.js";
import { Status } from "./status.js";

const SAMPLE =
  "2026-10-22 14:34:51,050 [1] INFO  VGPconnect.ForesightForm [(null)] - " +
  "[82.3337,19.9920921,1.68702,1161.0,6899.38574,6801.0,9.687589,0]";

test("parses the GSPconnect ball line", () => {
  const ball = parseGsproBallLine(SAMPLE);
  assert.deepEqual(ball, {
    Speed: 82.3337,
    VLA: 19.9921,
    HLA: 1.687,
    SideSpin: 1161,
    TotalSpin: 6899.3857,
    BackSpin: 6801,
    SpinAxis: 9.6876,
  });
});

test("rejects malformed ball lines", () => {
  assert.equal(parseGsproBallLine("no brackets"), null);
  assert.equal(parseGsproBallLine("[1,2,3]"), null);
  assert.equal(parseGsproBallLine("[1,2,3,4,5,6,7,x]"), null);
  assert.equal(parseGsproBallLine("[1,2,3,4,5,6,7,]"), null);
  assert.equal(parseGsproBallLine("[0x10,2,3,4,5,6,7,8]"), null);
});

test("shot and heartbeat messages match Open Connect v1", () => {
  const message = shotMessage(parseGsproBallLine(SAMPLE)!, 1);
  assert.equal(message.DeviceID, "Foresight GC3");
  assert.equal(message.ShotNumber, 1);
  assert.equal(message.ShotDataOptions.ContainsClubData, false);
  assert.equal(message.ShotDataOptions.LaunchMonitorBallDetected, true);

  const beat = heartbeatMessage(4);
  assert.equal(beat.ShotDataOptions.IsHeartBeat, true);
  assert.equal(beat.ShotDataOptions.LaunchMonitorBallDetected, false);
  assert.equal(beat.BallData, undefined);
});

test("premierBall maps a history record", () => {
  const ball = premierBall({
    id: "shot-1",
    ballSpeedMPH: 82.3337,
    launchAngleDeg: 19.9920921,
    azimuthDeg: 1.68702,
    backspinRPM: 6801,
    sideSpinRPM: 1161,
    totalSpinRPM: Math.hypot(6801, 1161),
    spinAxisTiltDeg: 9.687589,
  })!;
  assert.equal(ball.Speed, 82.3337);
  assert.equal(ball.VLA, 19.9921);
  assert.equal(ball.HLA, 1.687);
  assert.equal(ball.TotalSpin, Number(Math.hypot(6801, 1161).toFixed(4)));
});

test("premierBall derives total spin and skips unusable records", () => {
  const ball = premierBall({
    ballSpeedMPH: 100,
    launchAngleDeg: 10,
    azimuthDeg: 0,
    backspinRPM: 3,
    sideSpinRPM: 4,
  })!;
  assert.equal(ball.TotalSpin, 5);
  assert.equal(ball.SpinAxis, 0);
  assert.equal(premierBall({ ballSpeedMPH: 3.4028234663852886e38 }), null);
  assert.equal(premierBall({ ballSpeedMPH: 0, launchAngleDeg: 1, azimuthDeg: 1 }), null);
  assert.equal(premierBall({ ballSpeedMPH: true, launchAngleDeg: 1, azimuthDeg: 1 }), null);
});

test("menu choices and reply summaries", () => {
  assert.equal(menuChoice("q"), "quit");
  assert.equal(menuChoice("1"), "gspro");
  assert.equal(menuChoice("2"), "premier");
  assert.equal(menuChoice("3"), null);
  assert.equal(shortReply('{"Code":200,"Message":"Shot received"}'), "Shot received");
  assert.equal(shortReply("  plain   text "), "plain text");
});

test("status panel renders per source", () => {
  const status = new Status(false);
  status.source = "Foresight Premier";
  status.watching = "C:\\history.json";
  status.note = "6 existing shots skipped";
  status.openConnect = "waiting for 127.0.0.1:921";
  const panel = status.render();
  assert.ok(panel.startsWith("Open Connect bridge\n"));
  assert.ok(panel.includes("  Source        Foresight Premier"));
  assert.ok(panel.includes("6 existing shots skipped"));
  assert.ok(panel.includes("open a Shot Analysis session."));
  assert.ok(!panel.includes("  GSPconnect"));
  assert.ok(panel.endsWith("  Q  Exit"));

  status.source = "GSPconnect";
  status.gspro = "listening on 127.0.0.1:9050";
  const gspro = status.render();
  assert.ok(gspro.includes("Open GSPconnect.exe."));
  assert.ok(!gspro.includes("Shot Analysis"));
});
