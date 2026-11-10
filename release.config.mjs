export default {
  branches: ["main"],
  plugins: [
    [
      "@semantic-release/commit-analyzer",
      {
        releaseRules: [
          { breaking: true, release: "major" },
          { type: "feat", release: "minor" },
          { type: "*", release: "patch" },
        ],
      },
    ],
    "./scripts/verify-release.mjs",
    "@semantic-release/release-notes-generator",
    [
      "@semantic-release/github",
      {
        assets: ["build/release/*.exe", "build/release/*.tar.gz", "build/release/*.dmg"],
        successComment: false,
        failComment: false,
      },
    ],
  ],
};
