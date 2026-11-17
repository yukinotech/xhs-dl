import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type RequestListener } from "node:http";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  transfer,
  mediaUrl,
  RateLimiter,
  type TransferProgress,
} from "../src/download/transfer.js";
const roots: string[] = [],
  servers: Server[] = [];
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB9kAAAAASUVORK5CYII=",
  "base64",
);
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function setup(handler: RequestListener) {
  const root = await mkdtemp(join(tmpdir(), "xhs-transfer-test-"));
  roots.push(root);
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    root,
    path: join(root, "media.png"),
    base,
    options: {
      resume: true,
      overwrite: false,
      retries: 0,
      requestTimeoutMs: 1000,
      validateUrl: (url: string) => new URL(url),
    },
  };
}
describe("media HTTP transfer", () => {
  it("streams exact bytes, validates file signature and falls back to backup without cookies", async () => {
    let calls = 0;
    const s = await setup((req, res) => {
      expect(req.headers.cookie).toBeUndefined();
      calls++;
      if (req.url === "/bad") {
        res.writeHead(403);
        res.end();
      } else {
        res.writeHead(200, {
          "content-type": "image/png",
          "content-length": png.length,
          etag: '"synthetic"',
        });
        res.end(png);
      }
    });
    const result = await transfer(
      [s.base + "/bad", s.base + "/good"],
      s.path,
      s.options,
    );
    expect(await readFile(s.path)).toEqual(png);
    expect(result.bytes).toBe(png.length);
    expect(result.sha256).toHaveLength(64);
    expect(calls).toBe(2);
  });
  it("continues a validated partial with 206 and an unchanged strong ETag", async () => {
    const offset = 20;
    let range = "";
    const s = await setup((req, res) => {
      range = String(req.headers.range);
      expect(req.headers["if-range"]).toBe('"synthetic"');
      res.writeHead(206, {
        "content-type": "image/png",
        "content-length": png.length - offset,
        "content-range": `bytes ${offset}-${png.length - 1}/${png.length}`,
        etag: '"synthetic"',
      });
      res.end(png.subarray(offset));
    });
    await writeFile(s.path + ".part", png.subarray(0, offset));
    await writeFile(
      s.path + ".part.json",
      JSON.stringify({
        url: s.base + "/file",
        etag: '"synthetic"',
        last_modified: null,
        total: png.length,
      }),
    );
    const events: TransferProgress[] = [];
    await transfer([s.base + "/file"], s.path, {
      ...s.options,
      progress: (event) => events.push(event),
    });
    expect(events.find((event) => event.phase === "downloading")).toMatchObject(
      {
        downloaded_bytes: offset,
        total_bytes: png.length,
        transferred_bytes: 0,
        resumed_bytes: offset,
      },
    );
    expect(events.at(-1)).toMatchObject({
      phase: "verifying",
      downloaded_bytes: png.length,
      total_bytes: png.length,
      transferred_bytes: png.length - offset,
    });
    expect(range).toBe("bytes=20-");
    expect(await readFile(s.path)).toEqual(png);
  });
  it("restarts safely when Range is ignored or the ETag changes", async () => {
    let requests = 0;
    const s = await setup((req, res) => {
      requests++;
      if (req.headers.range) {
        res.writeHead(206, {
          "content-type": "image/png",
          "content-range": `bytes 20-${png.length - 1}/${png.length}`,
          etag: '"changed"',
        });
        res.end(png.subarray(20));
      } else {
        res.writeHead(200, { "content-type": "image/png", etag: '"changed"' });
        res.end(png);
      }
    });
    await writeFile(s.path + ".part", png.subarray(0, 20));
    await writeFile(
      s.path + ".part.json",
      JSON.stringify({
        url: s.base + "/file",
        etag: '"old"',
        last_modified: null,
        total: png.length,
      }),
    );
    const events: TransferProgress[] = [];
    await transfer([s.base + "/file"], s.path, {
      ...s.options,
      progress: (event) => events.push(event),
    });
    expect(
      events
        .filter((event) => event.phase === "connecting")
        .map((event) => event.resumed_bytes),
    ).toEqual([20, 0]);
    expect(events.at(-1)?.downloaded_bytes).toBe(png.length);
    expect(requests).toBe(2);
    expect(await readFile(s.path)).toEqual(png);
  });
  it("retains a usable partial when the socket disconnects and can resume it", async () => {
    let disconnect = true;
    const s = await setup((req, res) => {
      if (disconnect) {
        res.writeHead(200, {
          "content-type": "image/png",
          "content-length": png.length,
          etag: '"same"',
        });
        res.write(png.subarray(0, 20));
        setTimeout(() => res.destroy(), 25);
      } else {
        const offset = Number(String(req.headers.range).match(/\d+/)?.[0]);
        res.writeHead(206, {
          "content-type": "image/png",
          "content-length": png.length - offset,
          "content-range": `bytes ${offset}-${png.length - 1}/${png.length}`,
          etag: '"same"',
        });
        res.end(png.subarray(offset));
      }
    });
    await expect(
      transfer([s.base + "/file"], s.path, s.options),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect((await stat(s.path + ".part")).size).toBe(20);
    disconnect = false;
    await transfer([s.base + "/file"], s.path, s.options);
    expect(await readFile(s.path)).toEqual(png);
  });
  it("rejects HTML even with an image content type and never overwrites by default", async () => {
    let html = true;
    const s = await setup((_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(html ? "<html>not media</html>" : png);
    });
    await expect(
      transfer([s.base + "/file"], s.path, s.options),
    ).rejects.toMatchObject({ code: "INVALID_MEDIA" });
    await expect(stat(s.path)).rejects.toMatchObject({ code: "ENOENT" });
    html = false;
    await writeFile(s.path, "keep existing");
    await expect(
      transfer([s.base + "/file"], s.path, s.options),
    ).rejects.toMatchObject({ code: "OUTPUT_COLLISION" });
    expect(await readFile(s.path, "utf8")).toBe("keep existing");
  });
  it("rejects arbitrary hosts and non-HTTP schemes before any request", () => {
    for (const value of [
      "file:///etc/passwd",
      "http://127.0.0.1/a",
      "https://xhscdn.com.evil.invalid/a",
      "https://user:pass@sns-video.xhscdn.com/a",
    ])
      expect(() => mediaUrl(value)).toThrow();
  });
});

it("bounds retries on transient server errors", async () => {
  let calls = 0;
  const s = await setup((_req, res) => {
    if (++calls === 1) {
      res.writeHead(503);
      res.end();
    } else {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(png);
    }
  });
  await transfer([s.base + "/file"], s.path, { ...s.options, retries: 1 });
  expect(calls).toBe(2);
  expect(await readFile(s.path)).toEqual(png);
});

it("applies one aggregate rate budget to concurrent consumers", async () => {
  const limiter = new RateLimiter(1000);
  const start = performance.now();
  await Promise.all([
    limiter.consume(100),
    limiter.consume(100),
    limiter.consume(100),
  ]);
  expect(performance.now() - start).toBeGreaterThanOrEqual(280);
});
