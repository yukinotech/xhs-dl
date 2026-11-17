import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DownloadEngine } from "../src/download/engine.js";
import { sha256 } from "../src/download/transfer.js";
import { normalizeNote } from "../src/content/normalize.js";
import { configSchema } from "../src/config/config.js";
import { Store } from "../src/infrastructure/store.js";
import type { ContentService } from "../src/content/service.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "xhs-engine-test-"));
  roots.push(root);
  const config = {
    ...configSchema.parse({
      download: {
        paths: join(root, "output"),
        template: "{note.id}/{index}_{media.role}.{ext}",
      },
    }),
    stateDir: join(root, "state"),
    configDir: root,
    configFiles: [],
  };
  let height = 720,
    calls = 0;
  const ref = { id: "1".repeat(24) };
  const service = {
    config,
    store: new Store(config.stateDir, "default"),
    signal: undefined,
    identity: async () => ({ id: "synthetic-viewer", authenticated: true }),
    note: async () =>
      normalizeNote(
        {
          note_id: ref.id,
          type: "video",
          title: "synthetic",
          user: { user_id: "synthetic-author" },
          video: {
            media: {
              stream: {
                future: [
                  {
                    master_url: "https://sns-video.xhscdn.com/synthetic.mp4",
                    height,
                    format: "mp4",
                  },
                ],
              },
            },
          },
        },
        ref,
      ),
  } as unknown as ContentService;
  const fakeTransfer = async (_candidates: string[], path: string) => {
    calls++;
    const data = Buffer.from("synthetic-test-content");
    await writeFile(path, data);
    return {
      bytes: data.length,
      sha256: await sha256(path),
      content_type: "video/mp4",
    };
  };
  return {
    root,
    ref,
    service,
    fakeTransfer,
    calls: () => calls,
    setHeight: (h: number) => {
      height = h;
    },
  };
}
describe("download orchestration", () => {
  it("upgrades a verified best download when a higher variant appears and skips the same quality", async () => {
    const s = await setup();
    const first = new DownloadEngine(
      s.service,
      undefined,
      true,
      s.fakeTransfer,
    );
    await first.note(s.ref);
    expect(first.finish().summary.downloaded).toBe(1);
    s.setHeight(2160);
    const second = new DownloadEngine(
      s.service,
      undefined,
      true,
      s.fakeTransfer,
    );
    await second.note(s.ref, {
      owner_id: "synthetic-owner",
      kind: "favorites",
    });
    expect(second.finish().summary.downloaded).toBe(1);
    expect(second.result.items[0]!.quality).toBe("2160");
    expect(second.result.items[0]!.upgraded).toBe(true);
    const third = new DownloadEngine(
      s.service,
      undefined,
      true,
      s.fakeTransfer,
    );
    await third.note(s.ref);
    expect(third.finish().summary.skipped).toBe(1);
    s.setHeight(1080);
    const lower = new DownloadEngine(
      s.service,
      undefined,
      true,
      s.fakeTransfer,
    );
    await lower.note(s.ref);
    expect(lower.finish().items[0]!.quality).toBe("2160");
    expect(lower.result.summary.skipped).toBe(1);
    expect(s.calls()).toBe(2);
    const path = first.result.items[0]!.path!;
    expect(await sha256(path)).toBe(first.result.items[0]!.sha256);
  });
  it("dry-run does not create output directories or archive files", async () => {
    const s = await setup();
    s.service.config.download.dry_run = true;
    const engine = new DownloadEngine(
      s.service,
      undefined,
      true,
      s.fakeTransfer,
    );
    await engine.note(s.ref);
    expect(engine.finish().summary.planned).toBe(1);
    expect(s.calls()).toBe(0);
    await expect(stat(s.service.config.download.paths)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      stat(join(s.service.store.dir, "download-archive.jsonl")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("detects modified archived files and will not silently overwrite them", async () => {
    const s = await setup();
    const first = new DownloadEngine(
      s.service,
      undefined,
      true,
      s.fakeTransfer,
    );
    await first.note(s.ref);
    await writeFile(first.result.items[0]!.path!, "externally changed");
    const second = new DownloadEngine(
      s.service,
      undefined,
      true,
      s.fakeTransfer,
    );
    await second.note(s.ref);
    expect(() => second.finish()).toThrow();
    expect(second.result.items[0]!.error?.code).toBe("OUTPUT_COLLISION");
    expect(await readFile(first.result.items[0]!.path!, "utf8")).toBe(
      "externally changed",
    );
  });
  it("handles filename rename policy while preserving an unrecognized existing file", async () => {
    const s = await setup();
    const first = new DownloadEngine(
      s.service,
      undefined,
      true,
      s.fakeTransfer,
    );
    await first.note(s.ref);
    const original = first.result.items[0]!.path!;
    await writeFile(original, "external");
    s.service.config.download.on_exists = "rename";
    const second = new DownloadEngine(
      s.service,
      undefined,
      true,
      s.fakeTransfer,
    );
    await second.note(s.ref);
    expect(second.finish().items[0]?.path).toContain("(1)");
    expect(await readFile(original, "utf8")).toBe("external");
  });
  it("reports an unavailable single quality directly and retains batch partial failures", async () => {
    const s = await setup();
    s.service.config.download.quality = "original";
    const one = new DownloadEngine(s.service, undefined, true, s.fakeTransfer);
    await one.note(s.ref);
    try {
      one.finish();
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toMatchObject({
        code: "QUALITY_UNAVAILABLE",
        exitCode: 7,
        details: { partial_result: { summary: { failed: 1 } } },
      });
    }
    const streamed = new DownloadEngine(
      s.service,
      undefined,
      false,
      s.fakeTransfer,
    );
    await streamed.note(s.ref);
    expect(() => streamed.finish()).toThrow(/没有所需清晰度/);
    const batch = new DownloadEngine(
      s.service,
      undefined,
      true,
      s.fakeTransfer,
    );
    await batch.note(s.ref);
    await batch.note({ id: "2".repeat(24) });
    expect(() => batch.finish()).toThrow("部分媒体下载失败");
  });
});
