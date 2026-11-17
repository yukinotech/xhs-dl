import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config/config.js";
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
describe("complete config precedence", () => {
  it("merges explicit TOML, environment and CLI with boolean false and records each source", async () => {
    const root = await mkdtemp(join(tmpdir(), "xhs-config-test-"));
    roots.push(root);
    vi.stubEnv("XHS_DL_CONFIG_DIR", join(root, "user"));
    vi.stubEnv("XHS_DL_STATE_DIR", join(root, "state"));
    vi.stubEnv("XHS_DL_RESUME", "false");
    vi.stubEnv("XHS_DL_CONCURRENCY", "5");
    await mkdir(join(root, "nested"));
    const path = join(root, "nested", "config.conf");
    await writeFile(
      path,
      '[download]\npaths="./output"\nresume=true\nconcurrency=2\nwrite_info_json=true\n',
    );
    const config = await loadConfig({
      config: path,
      overrides: {
        "download.concurrency": 3,
        "download.write_info_json": false,
      },
    });
    expect(config.download).toMatchObject({
      paths: resolve(root, "nested", "output"),
      resume: false,
      concurrency: 3,
      write_info_json: false,
    });
    expect(config.sources?.["download.resume"]).toBe("env:XHS_DL_RESUME");
    expect(config.sources?.["download.concurrency"]).toBe("cli");
  });
  it("rejects unknown keys and invalid boolean env values instead of coercing them true", async () => {
    const root = await mkdtemp(join(tmpdir(), "xhs-config-test-"));
    roots.push(root);
    vi.stubEnv("XHS_DL_CONFIG_DIR", join(root, "user"));
    vi.stubEnv("XHS_DL_RESUME", "false-ish");
    await expect(loadConfig({ configEnabled: false })).rejects.toMatchObject({
      code: "INVALID_CONFIG",
    });
    vi.stubEnv("XHS_DL_RESUME", "false");
    const path = join(root, "config.conf");
    await writeFile(path, '[download]\nunknown="bad"');
    await expect(loadConfig({ config: path })).rejects.toMatchObject({
      code: "INVALID_CONFIG",
    });
  });
});
