import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { analyzeCommits } from "@semantic-release/commit-analyzer";
import config from "../release.config.mjs";
import { verifyRelease } from "./verify-release.mjs";

test("conventional commit rules select the intended version bump", async () => {
  const rules = config.plugins[0][1];
  const logger = { log() {} };
  const examples = [
    ["feat: add a source", "minor"],
    ["fix: repair connection", "patch"],
    ["docs: update guide", "patch"],
    ["chore: update tooling", "patch"],
    ["feat!: redesign protocol\n\nBREAKING CHANGE: protocol changed", "major"],
    ["not a conventional commit", null],
  ];
  for (const [message, expected] of examples) {
    const actual = await analyzeCommits(rules, {
      commits: [{ message, hash: "abc123" }],
      logger,
    });
    assert.equal(actual, expected, message);
  }
});

test("release verification rejects mismatched or missing assets", () => {
  const originalDir = process.cwd();
  const previousVersion = process.env.EXPECTED_RELEASE_VERSION;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-connect-release-test-"));
  try {
    process.chdir(dir);
    process.env.EXPECTED_RELEASE_VERSION = "1.0.0";
    assert.throws(
      () => verifyRelease({}, { nextRelease: { version: "1.0.1" } }),
      /version changed/,
    );
    assert.throws(
      () => verifyRelease({}, { nextRelease: { version: "1.0.0" } }),
      /Missing release asset/,
    );
    fs.mkdirSync(path.join("build", "release"), { recursive: true });
    for (const file of [
      "open-connect-bridge.exe",
      "open-connect-bridge-1.0.0-linux-x64.tar.gz",
      "open-connect-bridge-1.0.0-mac-x64.dmg",
      "open-connect-bridge-1.0.0-mac-arm64.dmg",
    ])
      fs.writeFileSync(path.join("build", "release", file), "");
    assert.doesNotThrow(() => verifyRelease({}, { nextRelease: { version: "1.0.0" } }));
  } finally {
    process.chdir(originalDir);
    if (previousVersion === undefined) delete process.env.EXPECTED_RELEASE_VERSION;
    else process.env.EXPECTED_RELEASE_VERSION = previousVersion;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
