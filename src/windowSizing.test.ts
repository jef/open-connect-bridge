import assert from "node:assert/strict";
import { test } from "vitest";
import { contentHeightForScreen } from "./windowSizing.js";

test("window height fits content and is limited to the display work area", () => {
  assert.equal(contentHeightForScreen(700.2, 39, 1080), 701);
  assert.equal(contentHeightForScreen(1200, 39, 1080), 1041);
  assert.equal(contentHeightForScreen(700, 39, 39), 1);
});
