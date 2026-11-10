import fs from "node:fs";
import semanticRelease from "semantic-release";

const dryRun = process.argv.includes("--dry-run");
const result = await semanticRelease({ dryRun });

if (dryRun && process.env.GITHUB_OUTPUT) {
  const version = result ? result.nextRelease.version : "";
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
}

if (!result) console.log("No releasable commits found.");
