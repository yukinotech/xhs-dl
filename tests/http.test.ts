import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type RequestListener } from "node:http";
import { CookieJar } from "tough-cookie";
import { HttpTransport, apiData } from "../src/infrastructure/http.js";
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((resolve) => s.close(() => resolve()));
});
async function server(handler: RequestListener) {
  const s = createServer(handler);
  servers.push(s);
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = (s.address() as { port: number }).port;
  return `http://127.0.0.1:${port}`;
}
describe("HTTP transport", () => {
  it("persists scoped cookies and follows only same-origin GET redirects", async () => {
    const base = await server((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, {
          "set-cookie": "synthetic=secret; Path=/",
          location: "/end",
        });
        res.end();
      } else {
        res.end(JSON.stringify({ cookie: req.headers.cookie }));
      }
    });
    const t = new HttpTransport(new CookieJar(), 1000, undefined, undefined, {
      web: base,
      api: base,
      security: base,
    });
    const result = await t.request("web", "/start");
    expect(JSON.parse(result.text)).toEqual({ cookie: "synthetic=secret" });
    const restored = await CookieJar.deserialize(await t.jar.serialize());
    expect(await restored.getCookieString(base)).toBe("synthetic=secret");
    await t.close();
  });
  it("rejects cross-origin credential forwarding and never retries a POST redirect", async () => {
    let received = 0;
    const base = await server((_req, res) => {
      received++;
      res.writeHead(302, { location: "https://example.invalid/secret" });
      res.end();
    });
    const t = new HttpTransport(new CookieJar(), 1000, undefined, undefined, {
      web: base,
      api: base,
      security: base,
    });
    await expect(t.request("web", "/")).rejects.toMatchObject({
      code: "PROTOCOL_INCOMPATIBLE",
    });
    await expect(
      t.request("api", "/", { method: "POST", body: "{}" }),
    ).rejects.toMatchObject({ code: "PROTOCOL_INCOMPATIBLE" });
    expect(received).toBe(2);
    await t.close();
  });
  it("times out a live request and classifies security, rate, and signature failures without returning response text", async () => {
    const base = await server((_req, res) => {
      setTimeout(() => res.end("late"), 100);
    });
    const t = new HttpTransport(new CookieJar(), 20, undefined, undefined, {
      web: base,
      api: base,
      security: base,
    });
    await expect(t.request("api", "/")).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      exitCode: 6,
    });
    await t.close();
    for (const [status, expected] of [
      [471, "VERIFICATION_REQUIRED"],
      [429, "RATE_LIMITED"],
      [406, "PROTOCOL_INCOMPATIBLE"],
    ] as const) {
      try {
        apiData(
          {
            status,
            headers: new Headers(),
            text: "<html>synthetic-sensitive-data</html>",
          },
          "test",
        );
        throw new Error("expected failure");
      } catch (e) {
        expect(e).toMatchObject({ code: expected });
        expect(JSON.stringify(e)).not.toContain("synthetic-sensitive-data");
      }
    }
  });
});
