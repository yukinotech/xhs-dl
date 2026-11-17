import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const tsxLoader = pathToFileURL(
  createRequire(import.meta.url).resolve("tsx"),
).href;
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { terminalQr } from "../src/infrastructure/qr.js";
const roots: string[] = [];
async function root() {
  const p = await mkdtemp(join(tmpdir(), "xhs-cli-test-"));
  roots.push(p);
  return p;
}
afterEach(async () => {
  for (const p of roots.splice(0))
    await rm(p, { recursive: true, force: true });
});
function cli(dir: string, args: string[], extra: Record<string, string> = {}) {
  return spawnSync(
    process.execPath,
    ["--import", tsxLoader, resolve("src/cli.ts"), ...args],
    {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        XHS_DL_STATE_DIR: join(dir, "state"),
        XHS_DL_CONFIG_DIR: join(dir, "config"),
        XHS_DL_FORMAT: "json",
        ...extra,
      },
      timeout: 10000,
    },
  );
}
describe("CLI process contract", () => {
  it("reports real unauthenticated status and never prompts or contaminates JSON", async () => {
    const dir = await root();
    const status = cli(dir, ["auth", "status", "--format", "json"]);
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout).data).toMatchObject({
      authenticated: false,
      verified: false,
    });
    expect(status.stderr).toBe("");
    const me = cli(dir, ["me", "get", "--format", "json"]);
    expect(me.status).toBe(3);
    expect(JSON.parse(me.stdout).error.code).toBe("AUTH_REQUIRED");
    expect(me.stderr).toBe("");
    const login = cli(dir, ["auth", "login", "--method", "sms"]);
    expect(login.status).toBe(2);
    expect(JSON.parse(login.stdout).error.code).toBe("INTERACTION_REQUIRED");
  });
  it("structures parser errors and empty groups; offline discovery does not create state", async () => {
    const dir = await root();
    for (const args of [
      ["unknown"],
      ["auth"],
      ["me"],
      ["config"],
      ["user"],
      ["note"],
      ["search"],
      ["auth", "start"],
      ["version", "--timeout", "bad"],
    ]) {
      const result = cli(dir, args);
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout).error.code).toBe("INVALID_ARGUMENT");
    }
    const cap = JSON.parse(cli(dir, ["capabilities"]).stdout);
    expect(cap.data.browser_required).toBe(false);
    expect(cap.data.capabilities.download.implemented).toBe(true);
    expect(
      JSON.parse(cli(dir, ["schema", "user"]).stdout).data.properties.id,
    ).toBeDefined();
  });
  it("loads configuration in order and allows CLI false/no-config to override files", async () => {
    const dir = await root();
    await writeFile(
      join(dir, "xhs-dl.conf"),
      'profile="file-profile"\n[network]\nrequest_timeout_seconds=12\n',
    );
    const result = cli(dir, ["config", "show", "--profile", "flag-profile"], {
      XHS_DL_PROFILE: "env-profile",
    });
    expect(JSON.parse(result.stdout).data).toMatchObject({
      profile: "flag-profile",
      network: { request_timeout_seconds: 12 },
    });
    const noConfig = cli(dir, ["config", "show", "--no-config"]);
    expect(
      JSON.parse(noConfig.stdout).data.network.request_timeout_seconds,
    ).toBe(30);
    await writeFile(join(dir, "xhs-dl.conf"), 'network="invalid"');
    const bad = cli(dir, ["config", "show"]);
    expect(bad.status).toBe(2);
    expect(JSON.parse(bad.stdout).error.code).toBe("INVALID_CONFIG");
  });
  it("writes JSONL terminal events and a complete help manual", async () => {
    const dir = await root();
    const result = cli(dir, ["auth", "status", "--format", "jsonl"]);
    const lines = result.stdout
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x));
    expect(lines.map((x) => x.type)).toEqual(["item", "summary"]);
    const help = cli(dir, ["-H"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("auth verify");
    expect(help.stdout).toContain("stdout");
  });
  it("renders a compact quiet zone without ANSI and supports both terminal themes", () => {
    for (const theme of ["light", "dark"]) {
      const qr = terminalQr("https://example.invalid/synthetic", theme);
      expect(qr.text).not.toContain("\u001b");
      expect(qr.text.trimEnd().split("\n").length).toBeGreaterThan(10);
      expect(qr.columns).toBeLessThanOrEqual(80);
    }
  });
});

it("bounds verification-code stdin waiting by the configured timeout", async () => {
  const dir = await root();
  const { spawn } = await import("node:child_process");
  const child = spawn(
    process.execPath,
    [
      "--import",
      tsxLoader,
      resolve("src/cli.ts"),
      "auth",
      "verify",
      "--challenge",
      "synthetic",
      "--code-stdin",
      "--timeout",
      "0.05",
      "--format",
      "json",
    ],
    {
      cwd: dir,
      env: {
        ...process.env,
        XHS_DL_STATE_DIR: join(dir, "state"),
        XHS_DL_CONFIG_DIR: join(dir, "config"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let text = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    text += chunk;
  });
  let error = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    error += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  expect(code).toBe(6);
  expect(JSON.parse(text).error.code).toBe("TIMEOUT");
  expect(error).toBe("");
});

it("streams all per-input failures and a terminal summary for invalid batch URLs", async () => {
  const dir = await root();
  const result = cli(dir, [
    "download",
    "file:///etc/passwd",
    "not-a-link",
    "--format",
    "jsonl",
    "--non-interactive",
  ]);
  expect(result.status).toBe(9);
  const events = result.stdout
    .trim()
    .split("\n")
    .map((x) => JSON.parse(x));
  expect(events.map((x) => x.type)).toEqual([
    "item",
    "item",
    "error",
    "summary",
  ]);
  expect(events[0].data.note_id).toBeNull();
  expect(events.at(-1)).toMatchObject({
    ok: false,
    count: 2,
    summary: { failed: 2, downloaded: 0 },
  });
});
