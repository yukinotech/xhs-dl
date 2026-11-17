import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CookieJar } from "tough-cookie";
import { AuthService } from "../src/auth/service.js";
import { XhsClient } from "../src/api/client.js";
import { configSchema, type Config } from "../src/config/config.js";
import type { Session } from "../src/domain/models.js";
import { type Transport, type Origin } from "../src/infrastructure/http.js";

const roots: string[] = [];
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "xhs-auth-test-"));
  roots.push(dir);
  const config: Config = {
    ...configSchema.parse({}),
    configDir: dir,
    stateDir: dir,
    configFiles: [],
  };
  return config;
}
afterEach(async () => {
  for (const dir of roots.splice(0))
    await rm(dir, { recursive: true, force: true });
});
class FakeHttp implements Transport {
  jar = new CookieJar();
  constructor(
    readonly calls: string[],
    readonly session: Session,
    private mode: { qrPolls: number; meFails: number; guest?: boolean },
  ) {}
  async request(
    _origin: Origin,
    path: string,
    options: {
      method?: string;
      body?: string;
      headers?: Record<string, string>;
    } = {},
  ) {
    this.calls.push(path.split("?")[0]!);
    let data: Record<string, unknown> = {};
    if (path === "/explore")
      return {
        status: 200,
        headers: new Headers(),
        text: "<html>synthetic</html>",
      };
    if (path.startsWith("/api/sec/v1/ds"))
      return {
        status: 200,
        headers: new Headers(),
        text: "function getdss() { return '1700000000000'; }",
      };
    if (!options.headers?.["x-s"]) throw new Error("missing signature");
    if (path.endsWith("/activate")) data = { session: "synthetic-visitor" };
    if (path.endsWith("/qrcode/create"))
      data = {
        qr_id: "synthetic-qr",
        code: "synthetic-code",
        url: "https://example.invalid/synthetic-qr",
      };
    if (path === "/api/qrcode/userinfo")
      data = { codeStatus: ++this.mode.qrPolls === 1 ? 0 : 2 };
    if (path.includes("/qrcode/status"))
      data = { code_status: 2, login_info: { session: "synthetic-account" } };
    if (path.includes("/check_code"))
      data = { mobile_token: "synthetic-mobile-token" };
    if (path === "/api/sns/web/v2/login/code")
      data = { session: "synthetic-account" };
    if (path === "/api/sns/web/v2/user/me") {
      if (this.mode.meFails-- > 0) throw new Error("synthetic network failure");
      data = {
        user_id: "synthetic-user",
        nickname: "合成用户",
        red_id: "synthetic-red-id",
        guest: this.mode.guest ?? false,
      };
    }
    return {
      status: 200,
      headers: new Headers(),
      text: JSON.stringify({ success: true, code: 0, data }),
    };
  }
  async close() {}
}
function service(
  config: Config,
  calls: string[],
  mode = { qrPolls: 0, meFails: 0, guest: false },
) {
  return new AuthService(config, undefined, async (session) => {
    const transport = new FakeHttp(calls, session, mode);
    if (Object.keys(session.cookies).length)
      transport.jar = await CookieJar.deserialize(
        JSON.stringify(session.cookies),
      );
    return new XhsClient(session, transport);
  });
}
describe("persistent login", () => {
  it("restores an SMS challenge in a new service, sends once, saves credentials only after me succeeds", async () => {
    const config = await setup(),
      calls: string[] = [];
    const one = service(config, calls);
    const started = await one.start("sms", "00000000000");
    await expect(one.start("sms", "00000000000")).rejects.toMatchObject({
      code: "SESSION_BUSY",
    });
    expect(await one.store.session()).toBeNull();
    const result = await service(config, calls).verify(
      started.challenge_id,
      "123456",
    );
    expect(result.status).toBe("authenticated");
    expect(result).not.toHaveProperty("session");
    expect(calls.filter((x) => x.endsWith("/send_code"))).toHaveLength(1);
    const fresh = service(config, calls);
    expect((await fresh.me()).id).toBe("synthetic-user");
    const c = await fresh.store.challenge();
    expect(c).not.toHaveProperty("phone");
    expect(c).not.toHaveProperty("session");
    const content = await readFile(
      join(fresh.store.dir, "session.json"),
      "utf8",
    );
    expect(content).not.toContain("123456");
    if (process.platform !== "win32")
      expect(
        (await stat(join(fresh.store.dir, "session.json"))).mode & 0o777,
      ).toBe(0o600);
    await fresh.logout();
    expect(await fresh.store.session()).toBeNull();
  });
  it("polls QR through separate invocations and scrubs the completed challenge", async () => {
    const config = await setup(),
      calls: string[] = [],
      mode = { qrPolls: 0, meFails: 0, guest: false };
    const first = await service(config, calls, mode).start("qr");
    expect(
      (await service(config, calls, mode).challenge(first.challenge_id)).status,
    ).toBe("awaiting_scan");
    const result = await service(config, calls, mode).challenge(
      first.challenge_id,
    );
    expect(result.status).toBe("authenticated");
    expect(result).not.toHaveProperty("qr_text");
    expect((await service(config, calls, mode).me()).id).toBe("synthetic-user");
  });
  it("does not exchange a single-use code again when me failed after login", async () => {
    const config = await setup(),
      calls: string[] = [],
      mode = { qrPolls: 0, meFails: 1, guest: false };
    const s = service(config, calls, mode),
      first = await s.start("sms", "00000000000");
    await expect(s.verify(first.challenge_id, "123456")).rejects.toThrow(
      "synthetic network failure",
    );
    expect(await s.store.session()).toBeNull();
    expect(
      (await service(config, calls, mode).verify(first.challenge_id, "123456"))
        .status,
    ).toBe("authenticated");
    expect(calls.filter((x) => x.includes("/check_code"))).toHaveLength(1);
  });
  it("keeps guests anonymous and isolates profiles", async () => {
    const config = await setup(),
      calls: string[] = [],
      s = service(config, calls, { qrPolls: 0, meFails: 0, guest: true });
    const first = await s.start("sms", "00000000000");
    await expect(s.verify(first.challenge_id, "123456")).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
    await expect(
      service({ ...config, profile: "other" }, calls).me(),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(await s.store.session()).toBeNull();
  });
  it("expires, cancels and scrubs state; rejects conflicting profile locks", async () => {
    const config = await setup(),
      calls: string[] = [],
      s = service(config, calls),
      first = await s.start("qr");
    await s.store.locked(async () => {
      await expect(s.status()).rejects.toMatchObject({ code: "SESSION_BUSY" });
    });
    const c = (await s.store.challenge())!;
    c.expires_at = "2000-01-01T00:00:00Z";
    await s.store.locked(() => s.store.saveChallenge(c));
    await expect(s.challenge(first.challenge_id)).rejects.toMatchObject({
      code: "CHALLENGE_EXPIRED",
    });
    expect(await s.store.challenge()).not.toHaveProperty("session");
    const another = await s.start("qr");
    expect((await s.cancel(another.challenge_id)).status).toBe("cancelled");
  });
});

describe("explicit Cookie import", () => {
  it("validates JSON cookies with host/expiry attributes and preserves existing login when import fails", async () => {
    const config = await setup(),
      calls: string[] = [],
      s = service(config, calls);
    const future = Date.now() / 1000 + 3600;
    const result = await s.importCookie(
      JSON.stringify([
        {
          name: "a1",
          value: "0".repeat(52),
          domain: ".xiaohongshu.com",
          path: "/",
          expires: future,
          secure: true,
        },
        {
          name: "web_session",
          value: "synthetic-imported-session",
          domain: ".xiaohongshu.com",
          path: "/",
          expires: future,
          httpOnly: true,
          secure: true,
        },
        {
          name: "other",
          value: "synthetic-other",
          domain: "www.xiaohongshu.com",
          path: "/",
        },
        {
          name: "foreign",
          value: "synthetic-ignored",
          domain: ".example.invalid",
          path: "/",
        },
      ]),
    );
    expect(result.authenticated).toBe(true);
    const saved = (await s.store.session())!;
    const jar = await CookieJar.deserialize(JSON.stringify(saved.cookies));
    const cookies = await jar.getCookies("https://edith.xiaohongshu.com");
    expect(cookies.find((c) => c.key === "web_session")).toMatchObject({
      httpOnly: true,
      secure: true,
    });
    expect(cookies.find((c) => c.key === "foreign")).toBeUndefined();
    expect(cookies.find((c) => c.key === "other")).toBeUndefined();
    await expect(s.importCookie("[null]")).rejects.toMatchObject({
      code: "INVALID_COOKIE_FILE",
    });
    expect((await s.store.session())?.user?.id).toBe("synthetic-user");
  });
  it("imports Netscape HttpOnly records and rejects incomplete credentials before network use", async () => {
    const config = await setup(),
      calls: string[] = [],
      s = service(config, calls);
    await expect(s.importCookie("a1=synthetic-only")).rejects.toMatchObject({
      code: "INVALID_COOKIE_FILE",
    });
    expect(calls).toHaveLength(0);
    const text = `.xiaohongshu.com\tTRUE\t/\tTRUE\t0\ta1\t${"0".repeat(52)}\n#HttpOnly_.xiaohongshu.com\tTRUE\t/\tTRUE\t0\tweb_session\tsynthetic-session`;
    expect((await s.importCookie(text)).authenticated).toBe(true);
    const imported = await CookieJar.deserialize(
      JSON.stringify((await s.store.session())!.cookies),
    );
    expect(
      (await imported.getCookies("https://edith.xiaohongshu.com")).find(
        (c) => c.key === "web_session",
      )?.httpOnly,
    ).toBe(true);
  });
});
