import fs from "node:fs";
import path from "node:path";

export function verifyRelease(_pluginConfig, { nextRelease }) {
  const expected = process.env.EXPECTED_RELEASE_VERSION;
  if (!expected) return;
  if (nextRelease.version !== expected) {
    throw new Error(
      `Release version changed from ${expected} to ${nextRelease.version}; refusing to publish mismatched assets.`,
    );
  }
  const files = [
    "open-connect-bridge.exe",
    `open-connect-bridge-${expected}-linux-x64.tar.gz`,
    `open-connect-bridge-${expected}-mac-x64.dmg`,
    `open-connect-bridge-${expected}-mac-arm64.dmg`,
  ];
  for (const file of files) {
    const asset = path.join("build", "release", file);
    if (!fs.existsSync(asset)) throw new Error(`Missing release asset: ${asset}`);
  }
}
