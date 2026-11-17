import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  chmod,
  mkdtemp,
  rm,
  readFile,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { binaryTargets, nativeTarget } from "./binary-targets.mjs";

const name = process.argv[2] ?? nativeTarget;
assert.equal(
  name,
  nativeTarget,
  "Smoke test must run on the matching OS and CPU.",
);
const { executable } = binaryTargets[name];
const directory = fileURLToPath(
  new URL(`../binaries/${name}/`, import.meta.url),
);
const bytes = await readFile(join(directory, executable));
assert.equal(
  await readFile(join(directory, "SHA256SUMS"), "utf8"),
  `${createHash("sha256").update(bytes).digest("hex")}  ${executable}\n`,
);
const temporary = await mkdtemp(join(tmpdir(), "xhs-binary-"));
try {
  const entry = join(temporary, executable);
  await copyFile(join(directory, executable), entry);
  await chmod(entry, 0o755);
  await writeFile(join(temporary, ".env"), "XHS_DL_PROFILE=invalid/profile\n");
  // Empty cwd and PATH: the executable cannot find source, node_modules, Node or Bun.
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !/^(XHS_DL_|BUN_|NODE_)/i.test(key) && key.toLowerCase() !== "path",
      ),
    ),
    PATH: "",
    XHS_DL_STATE_DIR: join(temporary, "state"),
    XHS_DL_CONFIG_DIR: join(temporary, "config"),
  };
  function run(args, status = 0) {
    const result = spawnSync(entry, args, {
      cwd: temporary,
      env,
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
    });
    assert.equal(result.error, undefined);
    assert.equal(
      result.status,
      status,
      `${args.join(" ")}: ${result.stderr}\n${result.stdout}`,
    );
    return result.stdout;
  }
  assert.match(run(["--version"]), /^\d+\.\d+\.\d+/);
  assert.match(run(["-H"]), /auth verify/);
  const json = (args) =>
    JSON.parse(
      run([...args, "--format", "json", "--no-config", "--non-interactive"]),
    );
  assert.equal(json(["capabilities"]).ok, true);
  assert.equal(json(["schema", "note"]).ok, true);
  const diagnostic = json(["doctor"]).data;
  assert.equal(diagnostic.authenticated, false);
  assert.equal(diagnostic.profile, "default");
  assert.equal(diagnostic.runtime, "bun");
  assert.ok(diagnostic.bun);
  assert.equal(json(["auth", "status"]).data.authenticated, false);
  assert.equal(json(["config", "init"]).ok, true);
  assert.equal(json(["config", "show"]).ok, true);
  assert.equal(
    JSON.parse(
      run(
        ["me", "get", "--format", "json", "--no-config", "--non-interactive"],
        3,
      ),
    ).ok,
    false,
  );
  run(["--unknown-option", "--format", "json"], 2);
  console.log(
    `Standalone smoke test passed: ${name} (isolated cwd, empty PATH, no login)`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
