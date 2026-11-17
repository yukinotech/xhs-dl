// Run with Bun to exercise the actual HTTP, crypto and filesystem dependencies.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { FetchClient } from "../src/infrastructure/fetch.js";
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
let proxied = 0;
const proxy = createServer((req, res) => {
  proxied++;
  const url = new URL(req.url!);
  if (url.hostname === "proxy-only.invalid") {
    res.end("proxied");
    return;
  }
  // Bun sends absolute-form HTTP requests; forward only to the local fixture.
  assert.equal(url.origin, base);
  req.url = url.pathname;
  server.emit("request", req, res);
});
proxy.on("connect", (_req, socket, head) => {
  proxied++;
  const upstream = connect(
    (server.address() as { port: number }).port,
    "127.0.0.1",
    () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    },
  );
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
  socket.on("close", () => upstream.destroy());
});
await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
const transport = new HttpTransport(
  new CookieJar(),
  3000,
  undefined,
  proxyUrl,
  { web: base },
);
const proxyClient = new FetchClient(proxyUrl);
try {
  assert.deepEqual(
    JSON.parse((await transport.request("web", "/start")).text),
    { cookie: "synthetic=fixture" },
  );
  const proxyProbe = await proxyClient.fetch("http://proxy-only.invalid/", {});
  assert.ok(["proxied", "{}"].includes(await proxyProbe.text()));
  assert.ok(proxied > 0, "Explicit proxy must receive requests");
  const result = await transfer([base + "/media"], join(root, "media.png"), {
    resume: true,
    overwrite: false,
    retries: 0,
    requestTimeoutMs: 3000,
    proxy: proxyUrl,
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
    "Bun runtime smoke passed: explicit proxy routing, HTTP redirects/cookies, media download, store locking, X25519.",
  );
} finally {
  await transport.close();
  await proxyClient.close();
  proxy.closeAllConnections();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
