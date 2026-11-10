import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const out = path.resolve("build");
fs.mkdirSync(out, { recursive: true });

await Promise.all([
  build({
    entryPoints: ["src/desktop.ts"],
    outfile: path.join(out, "desktop.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
  }),
  build({
    entryPoints: ["src/preload.ts"],
    outfile: path.join(out, "preload.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
  }),
]);

fs.cpSync("src/ui", path.join(out, "ui"), { recursive: true });
console.log("Built desktop app files in build/");
