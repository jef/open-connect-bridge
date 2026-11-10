import { BallData, DEVICE_ID, MISSING, OpenConnectMessage } from "./types.js";

const FLOAT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

export function round4(value: number): number {
  return Number(value.toFixed(4));
}

/**
 * GSPconnect logs eight floats before its GSPro frame:
 * speed, VLA, HLA, side spin, total spin, back spin, spin axis, unused.
 */
export function parseGsproBallLine(line: string): BallData | null {
  const start = line.lastIndexOf("[");
  const end = line.lastIndexOf("]");
  if (start < 0 || end <= start) return null;

  const parts = line
    .slice(start + 1, end)
    .split(",")
    .map((p) => p.trim());
  if (parts.length !== 8 || !parts.every((p) => FLOAT.test(p))) return null;

  const [speed, vla, hla, sideSpin, totalSpin, backSpin, spinAxis] = parts.map(Number);
  return {
    Speed: round4(speed),
    VLA: round4(vla),
    HLA: round4(hla),
    SideSpin: round4(sideSpin),
    TotalSpin: round4(totalSpin),
    BackSpin: round4(backSpin),
    SpinAxis: round4(spinAxis),
  };
}

function num(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.abs(value) >= MISSING ? null : value;
}

export function premierBall(record: Record<string, unknown>): BallData | null {
  const speed = num(record.ballSpeedMPH);
  const vla = num(record.launchAngleDeg);
  const hla = num(record.azimuthDeg);
  if (speed === null || speed <= 0 || vla === null || hla === null) return null;

  const sideSpin = num(record.sideSpinRPM) ?? 0;
  const backSpin = num(record.backspinRPM) ?? 0;
  const spinAxis = num(record.spinAxisTiltDeg) ?? 0;
  const totalSpin = num(record.totalSpinRPM) ?? Math.hypot(backSpin, sideSpin);

  return {
    Speed: round4(speed),
    VLA: round4(vla),
    HLA: round4(hla),
    SideSpin: round4(sideSpin),
    TotalSpin: round4(totalSpin),
    BackSpin: round4(backSpin),
    SpinAxis: round4(spinAxis),
  };
}

export function shotMessage(ball: BallData, shotNumber: number): OpenConnectMessage {
  return {
    DeviceID: DEVICE_ID,
    Units: "Yards",
    ShotNumber: shotNumber,
    APIversion: "1",
    BallData: ball,
    ShotDataOptions: {
      ContainsBallData: true,
      ContainsClubData: false,
      LaunchMonitorIsReady: true,
      LaunchMonitorBallDetected: true,
      IsHeartBeat: false,
    },
  };
}

export function heartbeatMessage(shotNumber: number): OpenConnectMessage {
  return {
    DeviceID: DEVICE_ID,
    Units: "Yards",
    ShotNumber: shotNumber,
    APIversion: "1",
    ShotDataOptions: {
      ContainsBallData: false,
      ContainsClubData: false,
      LaunchMonitorIsReady: true,
      LaunchMonitorBallDetected: false,
      IsHeartBeat: true,
    },
  };
}

export function shotText(ball: BallData): string {
  return (
    `${ball.Speed} mph  VLA ${ball.VLA}  HLA ${ball.HLA}  ` +
    `spin ${ball.TotalSpin}  axis ${ball.SpinAxis}`
  );
}

export function shortReply(text: string): string {
  try {
    const body: unknown = JSON.parse(text);
    if (body && typeof body === "object") {
      const message = (body as Record<string, unknown>).Message;
      if (typeof message === "string" && message.trim()) {
        return message.split(/\s+/).filter(Boolean).join(" ").slice(0, 80);
      }
    }
  } catch {
    // not JSON; fall through to the raw text
  }
  const flat = text.split(/\s+/).filter(Boolean).join(" ");
  return flat ? flat.slice(0, 80) : "none";
}

export function menuChoice(text: string): "gspro" | "premier" | "quit" | null {
  switch (text.trim().toLowerCase()) {
    case "q":
    case "quit":
    case "exit":
      return "quit";
    case "1":
    case "gspro":
    case "gsp":
    case "gspconnect":
      return "gspro";
    case "2":
    case "premier":
      return "premier";
    default:
      return null;
  }
}
