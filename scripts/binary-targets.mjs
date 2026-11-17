export const binaryTargets = {
  "darwin-arm64": { target: "bun-darwin-arm64", executable: "xhs-dl" },
  "darwin-x64": { target: "bun-darwin-x64", executable: "xhs-dl" },
  "windows-x64": { target: "bun-windows-x64", executable: "xhs-dl.exe" },
  "windows-arm64": { target: "bun-windows-arm64", executable: "xhs-dl.exe" },
  "linux-x64": { target: "bun-linux-x64", executable: "xhs-dl" },
  "linux-arm64": { target: "bun-linux-arm64", executable: "xhs-dl" },
  "linux-x64-musl": { target: "bun-linux-x64-musl", executable: "xhs-dl" },
  "linux-arm64-musl": { target: "bun-linux-arm64-musl", executable: "xhs-dl" },
};
export const nativeTarget = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;

export const distributionFiles = [
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "skills/xhs-dl/SKILL.md",
  "skills/xhs-dl/references/commands.md",
  "docs/architecture-plan.md",
  "docs/reference-research.md",
  "docs/video-quality-investigation.md",
  "docs/roadmap.md",
  "docs/user-content-spec.md",
  "docs/xhs-dl.conf.example",
  "docs/BUN-LICENSE.txt",
  "docs/releases.md",
];
