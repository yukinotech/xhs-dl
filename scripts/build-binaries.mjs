import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile, cp, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  binaryTargets,
  nativeTarget,
  distributionFiles,
} from "./binary-targets.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "Usage: pnpm build:binary [native | all | <target> ...]\nTargets: " +
      Object.keys(binaryTargets).join(", "),
  );
  process.exit(0);
}
const requested = args.length ? args : ["native"];
const targets = [
  ...new Set(
    requested.flatMap((name) =>
      name === "all"
        ? Object.keys(binaryTargets)
        : name === "native"
          ? [nativeTarget]
          : [name],
    ),
  ),
];
for (const name of targets) {
  if (!Object.hasOwn(binaryTargets, name))
    throw new Error(`Unknown target: ${name}. Use --help to list targets.`);
}
const bun = process.env.BUN_EXECUTABLE || "bun";
const version = spawnSync(bun, ["--version"], { encoding: "utf8" });
if (version.status !== 0)
  throw new Error(
    "Bun 1.4.4+ is required on the build machine; install Bun or set BUN_EXECUTABLE.",
  );
const [major, minor, patch] = version.stdout.trim().split(".").map(Number);
if (!(major > 1 || (major === 1 && (minor > 4 || (minor === 4 && patch >= 4)))))
  throw new Error("Bun 1.4.4+ is required.");
// Preserve dependency license notices when node_modules is no longer distributed.
const pnpmArgs = ["licenses", "list", "--prod", "--json"];
const licenses = spawnSync("pnpm", pnpmArgs, {
  cwd: root,
  encoding: "utf8",
  shell: process.platform === "win32",
});
if (licenses.status !== 0)
  throw new Error(
    "Cannot collect dependency licenses: run this build with pnpm build:binary.",
  );
const notices = [
  "Production dependency license notices (includes transitive dependencies).",
];
for (const dependency of Object.values(JSON.parse(licenses.stdout)).flat()) {
  notices.push(
    `\n## ${dependency.name} ${dependency.versions.join(", ")} (${dependency.license})`,
  );
  for (const path of dependency.paths) {
    for (const file of await readdir(path)) {
      if (/^(licen[sc]e|copying|notice)(\.[a-z0-9_-]+)?$/i.test(file))
        notices.push(await readFile(join(path, file), "utf8"));
    }
  }
}
const dependencyNotices = notices.join("\n\n") + "\n";
for (const name of targets) {
  const { target, executable } = binaryTargets[name];
  const directory = join(root, "binaries", name);
  await mkdir(directory, { recursive: true });
  const result = spawnSync(
    bun,
    [
      "build",
      "src/cli.ts",
      "--compile",
      "--minify",
      "--env=disable",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--no-compile-autoload-tsconfig",
      "--no-compile-autoload-package-json",
      `--target=${target}`,
      "--outfile",
      join(directory, executable),
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (result.status !== 0)
    throw new Error(
      `Bun build failed for ${name}: ${result.error?.message ?? result.status}`,
    );
  // Explicit allowlist: never package local state, configs, downloads or reference clones.
  for (const asset of distributionFiles) {
    await mkdir(join(directory, asset, ".."), { recursive: true });
    await cp(join(root, asset), join(directory, asset));
  }
  await writeFile(
    join(directory, "DEPENDENCY-LICENSES.txt"),
    dependencyNotices,
  );
  const digest = createHash("sha256")
    .update(await readFile(join(directory, executable)))
    .digest("hex");
  await writeFile(join(directory, "SHA256SUMS"), `${digest}  ${executable}\n`);
  console.log(
    `Built binaries/${name}/${executable} (Bun ${version.stdout.trim()})`,
  );
}
