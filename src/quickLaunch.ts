import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { AppSource } from "./types.js";

type Locations = Partial<Record<AppSource, string>>;

export function defaultLaunchLocations(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Record<AppSource, string[]> {
  if (platform !== "win32") return { gspro: [], premier: [] };
  const programData = env.ProgramData;
  const programFiles = env.ProgramFiles;
  return {
    gspro: ["C:\\GSProV1\\Core\\GSPC\\GSPconnect.exe"],
    premier: [
      ...(programData
        ? [
            path.win32.join(
              programData,
              "Microsoft",
              "Windows",
              "Start Menu",
              "Programs",
              "Foresight Premier",
              "Foresight Premier.lnk",
            ),
          ]
        : []),
      ...(programFiles
        ? [path.win32.join(programFiles, "Foresight Premier", "ForesightPremier.exe")]
        : []),
    ],
  };
}

export class QuickLaunch {
  constructor(
    private readonly settingsFile: string,
    private readonly defaults: Record<AppSource, string[]>,
    private readonly pick: (source: AppSource) => Promise<string | null>,
    private readonly launch: (file: string) => Promise<void>,
  ) {}

  private async readLocations(): Promise<Locations> {
    let text: string;
    try {
      text = await fs.readFile(this.settingsFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    const data: unknown = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Invalid quick launch settings");
    }
    const record = data as Record<string, unknown>;
    for (const source of ["gspro", "premier"]) {
      if (record[source] !== undefined && (typeof record[source] !== "string" || !record[source])) {
        throw new Error("Invalid quick launch settings");
      }
    }
    return record as Locations;
  }

  async choose(source: AppSource): Promise<string | null> {
    const file = await this.pick(source);
    if (!file) return null;
    const locations = await this.readLocations();
    locations[source] = file;
    await fs.mkdir(path.dirname(this.settingsFile), { recursive: true });
    await fs.writeFile(this.settingsFile, JSON.stringify(locations, null, 2), "utf8");
    return file;
  }

  async open(source: AppSource): Promise<boolean> {
    const locations = await this.readLocations();
    let file = locations[source];
    if (!file) {
      for (const candidate of this.defaults[source]) {
        try {
          await fs.access(candidate);
          file = candidate;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    if (!file) file = (await this.choose(source)) ?? undefined;
    if (!file) return false;
    try {
      await this.launch(file);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not open ${file}: ${message}. Use Change location to select the app.`);
    }
    return true;
  }
}

export async function launchApplication(
  file: string,
  platform: NodeJS.Platform,
  openPath: (file: string) => Promise<string>,
): Promise<void> {
  if (
    (platform === "win32" && path.extname(file).toLowerCase() === ".lnk") ||
    (platform === "darwin" && path.extname(file).toLowerCase() === ".app")
  ) {
    const error = await openPath(file);
    if (error) throw new Error(error);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(file, [], { cwd: path.dirname(file), detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
