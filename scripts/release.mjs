import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { binaryTargets, distributionFiles } from "./binary-targets.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const [command, argument] = process.argv.slice(2);
const version = pkg.version;
assert.match(
  version,
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
  "Unsupported release version",
);
const checksum = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
export function archiveName(target) {
  assert.ok(Object.hasOwn(binaryTargets, target), "Unknown binary target");
  return `xhs-dl-v${version}-${target}.${target.startsWith("windows-") ? "zip" : "tar.gz"}`;
}
function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...options });
  if (result.status !== 0)
    throw new Error(
      `${cmd} failed (${result.status ?? result.error?.message})`,
    );
}
if (command === "validate") {
  assert.equal(
    argument,
    `v${version}`,
    "Release tag must match package.json version",
  );
  console.log(`Validated release ${argument}`);
} else if (command === "package") {
  const name = archiveName(argument),
    source = join(root, "binaries", argument);
  const { executable } = binaryTargets[argument];
  assert.equal(
    await readFile(join(source, "SHA256SUMS"), "utf8"),
    `${await checksum(join(source, executable))}  ${executable}\n`,
    "Binary checksum mismatch",
  );
  const staging = await mkdtemp(join(root, "binaries", "release-stage-"));
  const folder = `xhs-dl-v${version}-${argument}`,
    destination = join(staging, folder);
  const output = join(root, "release-assets", name);
  try {
    for (const file of [
      executable,
      "SHA256SUMS",
      "DEPENDENCY-LICENSES.txt",
      ...distributionFiles,
    ]) {
      const path = join(source, file);
      assert.ok((await lstat(path)).isFile(), `Refuse non-file asset: ${file}`);
      await mkdir(dirname(join(destination, file)), { recursive: true });
      await cp(path, join(destination, file));
    }
    await mkdir(dirname(output), { recursive: true });
    await rm(output, { force: true });
    if (argument.startsWith("windows-")) {
      // Use static PowerShell code and environment values, not interpolated shell paths.
      run(
        "pwsh",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath $env:XHS_RELEASE_FOLDER -DestinationPath $env:XHS_RELEASE_ARCHIVE -CompressionLevel Optimal",
        ],
        {
          env: {
            ...process.env,
            XHS_RELEASE_FOLDER: destination,
            XHS_RELEASE_ARCHIVE: output,
          },
        },
      );
    } else
      run("tar", ["-czf", output, "-C", staging, folder], {
        env: { ...process.env, COPYFILE_DISABLE: "1" },
      });
    console.log(`Packaged release-assets/${name}`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
} else if (command === "checksums") {
  const names = Object.keys(binaryTargets).map(archiveName).sort();
  const actual = (await readdir(join(root, "release-assets")))
    .filter((name) => name !== "SHA256SUMS")
    .sort();
  assert.deepEqual(
    actual,
    names,
    "Release assets must contain exactly the eight expected archives",
  );
  const lines = [];
  for (const name of names) {
    const path = join(root, "release-assets", name);
    assert.ok((await lstat(path)).isFile(), `Missing release archive: ${name}`);
    lines.push(`${await checksum(path)}  ${name}`);
  }
  await writeFile(
    join(root, "release-assets", "SHA256SUMS"),
    lines.join("\n") + "\n",
  );
  console.log(
    `Verified all ${names.length} platform archives and wrote SHA256SUMS`,
  );
} else
  throw new Error(
    "Usage: node scripts/release.mjs validate <tag> | package <target> | checksums",
  );
