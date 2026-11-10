import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { defaultLaunchLocations, launchApplication, QuickLaunch } from "./quickLaunch.js";

test("Windows defaults use the known connector and Premier locations", () => {
  const defaults = defaultLaunchLocations("win32", {
    ProgramData: "C:\\ProgramData",
    ProgramFiles: "C:\\Program Files",
  });
  assert.deepEqual(defaults.gspro, ["C:\\GSProV1\\Core\\GSPC\\GSPconnect.exe"]);
  assert.deepEqual(defaults.premier, [
    "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Foresight Premier\\Foresight Premier.lnk",
    "C:\\Program Files\\Foresight Premier\\ForesightPremier.exe",
  ]);
  assert.deepEqual(defaultLaunchLocations("linux", {}), { gspro: [], premier: [] });
});

test("quick launch uses defaults, saves choices separately, and handles cancellation", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ocb-launch-"));
  try {
    const defaultFile = path.join(dir, "default.exe");
    const customFile = path.join(dir, "custom.exe");
    await fs.writeFile(defaultFile, "");
    const settings = path.join(dir, "settings.json");
    const launched: string[] = [];
    let selected: string | null = null;
    const service = new QuickLaunch(
      settings,
      { gspro: [defaultFile], premier: [] },
      async () => selected,
      async (file) => {
        launched.push(file);
      },
    );
    assert.equal(await service.open("gspro"), true);
    assert.deepEqual(launched, [defaultFile]);
    assert.equal(await service.open("premier"), false);
    selected = customFile;
    assert.equal(await service.open("premier"), true);
    assert.deepEqual(JSON.parse(await fs.readFile(settings, "utf8")), { premier: customFile });
    selected = path.join(dir, "other.exe");
    assert.equal(await service.choose("gspro"), selected);
    const restored = new QuickLaunch(
      settings,
      { gspro: [], premier: [] },
      async () => null,
      async (file) => {
        launched.push(file);
      },
    );
    assert.equal(await restored.open("premier"), true);
    assert.equal(await restored.open("gspro"), true);
    assert.deepEqual(launched, [defaultFile, customFile, customFile, selected]);
    selected = null;
    assert.equal(await service.choose("premier"), null);
    assert.equal(JSON.parse(await fs.readFile(settings, "utf8")).premier, customFile);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("quick launch surfaces errors and rejects invalid settings", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ocb-launch-"));
  try {
    const settings = path.join(dir, "settings.json");
    const service = new QuickLaunch(
      settings,
      { gspro: [], premier: [] },
      async () => "missing.exe",
      async () => {
        throw new Error("not found");
      },
    );
    await assert.rejects(service.open("gspro"), /not found.*Change location/);
    await fs.writeFile(settings, '{"gspro":123}');
    await assert.rejects(service.open("gspro"), /Invalid quick launch settings/);
    await fs.writeFile(settings, "{");
    await assert.rejects(service.open("gspro"), SyntaxError);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("shortcuts and app bundles use the shell and report failures", async () => {
  const paths: string[] = [];
  const open = async (file: string) => {
    paths.push(file);
    return "";
  };
  await launchApplication("C:\\Premier.lnk", "win32", open);
  await launchApplication("/Applications/Premier.app", "darwin", open);
  assert.deepEqual(paths, ["C:\\Premier.lnk", "/Applications/Premier.app"]);
  await assert.rejects(
    launchApplication("missing.lnk", "win32", async () => "not found"),
    /not found/,
  );
  await assert.rejects(
    launchApplication(path.join(os.tmpdir(), "ocb-no-such-app"), process.platform, open),
    /ENOENT/,
  );
});
