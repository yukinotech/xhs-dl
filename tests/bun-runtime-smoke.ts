// Run with Bun to exercise the actual HTTP, crypto and filesystem dependencies.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CookieJar } from "tough-cookie";
import { z } from "zod";
import { HttpTransport } from "../src/infrastructure/http.js";
import { Store } from "../src/infrastructure/store.js";
import { createHandshake } from "../src/protocol/crypto.js";
import { transfer } from "../src/download/transfer.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB9kAAAAASUVORK5CYII=",
  "base64",
);
const root = await mkdtemp(join(tmpdir(), "xhs-bun-runtime-"));
const server = createServer((req, res) => {
  if (req.url === "/media") {
    assert.equal(req.headers.cookie, undefined);
    res.writeHead(200, {
      "content-type": "image/png",
      "content-length": png.length,
    });
    res.end(png);
  } else if (req.url === "/start") {
    res.writeHead(302, {
      "set-cookie": "synthetic=fixture; Path=/",
      location: "/end",
    });
    res.end();
  } else {
    res.end(JSON.stringify({ cookie: req.headers.cookie }));
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const transport = new HttpTransport(
  new CookieJar(),
  3000,
  undefined,
  undefined,
  { web: base },
);
try {
  assert.deepEqual(
    JSON.parse((await transport.request("web", "/start")).text),
    { cookie: "synthetic=fixture" },
  );
  const result = await transfer([base + "/media"], join(root, "media.png"), {
    resume: true,
    overwrite: false,
    retries: 0,
    requestTimeoutMs: 3000,
    validateUrl: (value) => new URL(value),
  });
  assert.equal(result.bytes, png.length);
  assert.deepEqual(await readFile(join(root, "media.png")), png);
  const store = new Store(root, "synthetic");
  await store.locked(async () => {
    await store.write("fixture.json", { ok: true });
    assert.deepEqual(
      await store.read("fixture.json", z.object({ ok: z.boolean() })),
      { ok: true },
    );
  });
  assert.equal(Buffer.from(createHandshake().public_key, "base64").length, 32);
  console.log(
    "Bun runtime smoke passed: HTTP redirects/cookies, media download, store locking, X25519.",
  );
} finally {
  await transport.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
