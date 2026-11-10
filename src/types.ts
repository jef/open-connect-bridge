import os from "node:os";
import path from "node:path";

export const DEVICE_ID = "Foresight GC3";
export const MISSING = 1e30;
export const GSPRO_MARKER = "Logging ball data IMMEDIATELY before sending to GSPro";
export const DEFAULT_GSPRO_LOG = "C:\\GSProV1\\Core\\GSPC\\ConnectDebug.txt";
export const PREMIER_HISTORY = path.join(
  os.homedir(),
  "AppData",
  "LocalLow",
  "Foresight Sports",
  "Foresight Premier",
  "ShotReplay",
  "history.json",
);

export type AppSource = "gspro" | "premier";

export interface BallData {
  Speed: number;
  VLA: number;
  HLA: number;
  SideSpin: number;
  TotalSpin: number;
  BackSpin: number;
  SpinAxis: number;
}

export interface ShotDataOptions {
  ContainsBallData: boolean;
  ContainsClubData: boolean;
  LaunchMonitorIsReady: boolean;
  LaunchMonitorBallDetected: boolean;
  IsHeartBeat: boolean;
}

export interface OpenConnectMessage {
  DeviceID: string;
  Units: "Yards";
  ShotNumber: number;
  APIversion: "1";
  BallData?: BallData;
  ShotDataOptions: ShotDataOptions;
}

export interface Sender {
  send(message: OpenConnectMessage): Promise<boolean>;
}
