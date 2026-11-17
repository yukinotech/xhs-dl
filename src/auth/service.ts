import { randomUUID } from "node:crypto";
import { CookieJar } from "tough-cookie";
import type { Config } from "../config/config.js";
import { XhsClient, newSession, restoreJar } from "../api/client.js";
import { HttpTransport, ORIGINS } from "../infrastructure/http.js";
import { Store } from "../infrastructure/store.js";
import { AppError } from "../domain/errors.js";
import type { Challenge, Session } from "../domain/models.js";

export type ClientFactory = (session: Session) => Promise<XhsClient>;
const terminal = new Set(["authenticated", "expired", "cancelled", "failed"]);
export function publicChallenge(c: Challenge) {
  return {
    challenge_id: c.id,
    method: c.method,
    status: c.status,
    created_at: c.created_at,
    expires_at: c.expires_at,
    ...(c.phone ? { phone_masked: c.phone.replace(/\d(?=\d{4})/g, "*") } : {}),
    ...(c.qr_text ? { qr_text: c.qr_text } : {}),
    ...(c.user ? { user: c.user } : {}),
  };
}
export class AuthService {
  readonly store: Store;
  private factory: ClientFactory;
  constructor(
    readonly config: Config,
    signal?: AbortSignal,
    factory?: ClientFactory,
  ) {
    this.store = new Store(config.stateDir, config.profile);
    this.factory =
      factory ??
      (async (session) =>
        new XhsClient(
          session,
          new HttpTransport(
            Object.keys(session.cookies).length
              ? await restoreJar(session)
              : new CookieJar(),
            config.network.request_timeout_seconds * 1000,
            signal,
            config.network.proxy,
          ),
        ));
  }
  private async client<T>(session: Session, fn: (c: XhsClient) => Promise<T>) {
    const client = await this.factory(session);
    try {
      return await fn(client);
    } finally {
      await client.snapshot();
      await client.transport.close();
    }
  }
  private expire(challenge: Challenge) {
    if (
      !terminal.has(challenge.status) &&
      Date.parse(challenge.expires_at) <= Date.now()
    ) {
      challenge.status = "expired";
      this.scrub(challenge);
    }
    return challenge;
  }
  private scrub(challenge: Challenge) {
    delete challenge.session;
    delete challenge.phone;
    delete challenge.zone;
    delete challenge.qr_id;
    delete challenge.qr_code;
    delete challenge.qr_text;
  }
  private async loadChallenge(id: string) {
    const c = await this.store.challenge();
    if (!c || c.id !== id)
      throw new AppError(
        "CHALLENGE_EXPIRED",
        "登录挑战不存在或已被替换。",
        4,
        {},
        false,
        "start_login",
      );
    this.expire(c);
    await this.store.saveChallenge(c);
    if (c.status === "expired" || c.status === "cancelled")
      throw new AppError(
        "CHALLENGE_EXPIRED",
        "登录挑战已过期或取消，请重新发起。",
        4,
        {},
        false,
        "start_login",
      );
    return c;
  }
  async start(method: "sms" | "qr", phone?: string, zone = "86") {
    if (
      method === "sms" &&
      (!phone || !/^\d{5,15}$/.test(phone) || !/^\d{1,4}$/.test(zone))
    )
      throw new AppError(
        "INVALID_ARGUMENT",
        "请输入有效手机号和国家/地区代码。",
        2,
      );
    return this.store.locked(async () => {
      const existing = await this.store.challenge();
      if (existing && !terminal.has(this.expire(existing).status))
        throw new AppError(
          "SESSION_BUSY",
          "已有待完成的登录挑战；请继续验证、等待或取消。",
          6,
          { challenge_id: existing.id },
        );
      const now = Date.now();
      const challenge: Challenge = {
        schema_version: 1,
        id: randomUUID(),
        method,
        status: "initializing",
        created_at: new Date(now).toISOString(),
        expires_at: new Date(now + 300000).toISOString(),
        ...(method === "sms" ? { phone, zone } : {}),
        session: newSession(),
      };
      await this.store.saveChallenge(challenge);
      let sideEffect = false;
      try {
        await this.client(challenge.session!, async (client) => {
          await client.bootstrap();
          challenge.session = await client.snapshot();
          if (method === "sms") {
            challenge.status = "sending";
            await this.store.saveChallenge(challenge);
            sideEffect = true;
            await client.sendSms(phone!, zone);
            challenge.status = "awaiting_code";
          } else {
            Object.assign(challenge, await client.qrCreate());
            challenge.status = "awaiting_scan";
          }
        });
        await this.store.saveChallenge(challenge);
        return publicChallenge(challenge);
      } catch (error) {
        if (!sideEffect) {
          challenge.status = "failed";
          this.scrub(challenge);
        }
        await this.store.saveChallenge(challenge);
        if (error instanceof AppError)
          throw new AppError(
            error.code,
            error.message,
            error.exitCode,
            {
              ...error.details,
              challenge_id: challenge.id,
              ...(sideEffect
                ? { delivery_status: "unknown", sms_resend: false }
                : {}),
            },
            error.retryable,
            error.actionRequired,
          );
        throw error;
      }
    });
  }
  async verify(id: string, code: string) {
    if (!/^\d{4,8}$/.test(code))
      throw new AppError("INVALID_CODE", "验证码应为 4 至 8 位数字。", 2);
    return this.store.locked(async () => {
      const c = await this.loadChallenge(id);
      if (c.status === "authenticated") return publicChallenge(c);
      if (
        c.method !== "sms" ||
        !c.session ||
        !c.phone ||
        !c.zone ||
        !["awaiting_code", "sending"].includes(c.status)
      )
        throw new AppError(
          "INVALID_CHALLENGE_STATE",
          "该挑战不能提交短信验证码。",
          2,
        );
      try {
        const user = await this.client(c.session, (client) =>
          c.session!.login_pending
            ? client.me()
            : client.verifySms(c.phone!, c.zone!, code),
        );
        c.user = user;
        c.status = "authenticated";
        await this.store.saveSession(c.session);
        this.scrub(c);
        await this.store.saveChallenge(c);
        return publicChallenge(c);
      } catch (error) {
        await this.store.saveChallenge(c);
        throw error;
      }
    });
  }
  async challenge(id: string) {
    return this.store.locked(async () => {
      const c = await this.loadChallenge(id);
      if (c.session?.login_pending) {
        try {
          c.user = await this.client(c.session, (client) => client.me());
          c.status = "authenticated";
          await this.store.saveSession(c.session);
          this.scrub(c);
          await this.store.saveChallenge(c);
          return publicChallenge(c);
        } catch (error) {
          await this.store.saveChallenge(c);
          throw error;
        }
      }
      if (c.method !== "qr" || terminal.has(c.status))
        return publicChallenge(c);
      if (!c.session || !c.qr_id || !c.qr_code)
        throw new AppError(
          "STATE_INVALID",
          "二维码挑战缺少继续登录所需状态。",
          10,
        );
      try {
        const result = await this.client(c.session, async (client) =>
          c.session!.login_pending
            ? { status: "authenticated" as const, user: await client.me() }
            : client.qrPoll(c.qr_id!, c.qr_code!),
        );
        c.status = result.status;
        if (result.status === "authenticated") {
          c.user = result.user;
          await this.store.saveSession(c.session);
          this.scrub(c);
        }
        if (result.status === "expired") this.scrub(c);
        await this.store.saveChallenge(c);
        return publicChallenge(c);
      } catch (error) {
        await this.store.saveChallenge(c);
        throw error;
      }
    });
  }
  async cancel(id: string) {
    return this.store.locked(async () => {
      const c = await this.loadChallenge(id);
      if (c.status === "authenticated")
        throw new AppError(
          "ALREADY_AUTHENTICATED",
          "挑战已完成；如需清除凭证，请使用 auth logout。",
          2,
        );
      c.status = "cancelled";
      this.scrub(c);
      await this.store.saveChallenge(c);
      return publicChallenge(c);
    });
  }
  async status(check = false) {
    return this.store.locked(async () => {
      const session = await this.store.session();
      const challenge = await this.store.challenge();
      if (challenge) {
        this.expire(challenge);
        await this.store.saveChallenge(challenge);
      }
      if (check && session) {
        return this.check(session);
      }
      return {
        profile: this.config.profile,
        authenticated: session?.authenticated ?? false,
        verified: false,
        user: session?.user ?? null,
        last_checked_at: session?.last_checked_at ?? null,
        challenge: challenge ? publicChallenge(challenge) : null,
      };
    });
  }
  private async check(session: Session) {
    try {
      const user = await this.client(session, (client) => client.me());
      await this.store.saveSession(session);
      return {
        profile: this.config.profile,
        authenticated: true,
        verified: true,
        user,
        last_checked_at: session.last_checked_at,
      };
    } catch (error) {
      if (
        error instanceof AppError &&
        ["SESSION_EXPIRED", "AUTH_REQUIRED"].includes(error.code)
      ) {
        session.authenticated = false;
        session.user = null;
      }
      await this.store.saveSession(session);
      throw error;
    }
  }
  async me() {
    return this.store.locked(async () => {
      const session = await this.store.session();
      if (!session?.authenticated)
        throw new AppError(
          "AUTH_REQUIRED",
          "尚未登录，请先运行 xhs-dl auth login。",
          3,
          {},
          false,
          "login",
        );
      return (await this.check(session)).user;
    });
  }
  async logout() {
    return this.store.locked(async () => {
      await this.store.clear();
      return {
        profile: this.config.profile,
        authenticated: false,
        cleared: true,
      };
    });
  }
  async importCookie(text: string) {
    if (text.length > 1024 * 1024)
      throw new AppError("INVALID_COOKIE_FILE", "Cookie 文件过大。", 2);
    return this.store.locked(async () => {
      const session = newSession();
      await this.client(session, async (client) => {
        const value = text.trim();
        if (value.startsWith("[")) {
          let values: unknown;
          try {
            values = JSON.parse(value);
          } catch {
            throw new AppError(
              "INVALID_COOKIE_FILE",
              "Cookie JSON 解析失败。",
              2,
            );
          }
          if (!Array.isArray(values))
            throw new AppError(
              "INVALID_COOKIE_FILE",
              "Cookie JSON 应为数组。",
              2,
            );
          for (const raw of values) {
            if (!raw || typeof raw !== "object" || Array.isArray(raw))
              throw new AppError(
                "INVALID_COOKIE_FILE",
                "Cookie 条目必须为对象。",
                2,
              );
            const c = raw as Record<string, unknown>;
            if (typeof c.name !== "string" || typeof c.value !== "string")
              throw new AppError(
                "INVALID_COOKIE_FILE",
                "Cookie 条目缺少 name/value。",
                2,
              );
            const domain =
              typeof c.domain === "string" ? c.domain : ".xiaohongshu.com";
            if (!/^\.?([a-z0-9-]+\.)*xiaohongshu\.com$/.test(domain)) continue;
            const expiry =
              typeof c.expires === "number"
                ? c.expires
                : typeof c.expirationDate === "number"
                  ? c.expirationDate
                  : undefined;
            await client.transport.jar.setCookie(
              `${c.name}=${c.value}${c.hostOnly ? "" : `; Domain=${domain}`}; Path=${typeof c.path === "string" ? c.path : "/"}${c.secure === false ? "" : "; Secure"}${c.httpOnly ? "; HttpOnly" : ""}${expiry !== undefined && expiry >= 0 ? `; Expires=${new Date(expiry * 1000).toUTCString()}` : ""}`,
              `https://${domain.replace(/^\./, "")}/`,
            );
          }
        } else {
          const lines = value.split(/\r?\n/);
          const netscape = lines.some((l) => l.split("\t").length === 7);
          if (netscape) {
            for (const line of lines) {
              if (
                !line ||
                (line.startsWith("#") && !line.startsWith("#HttpOnly_"))
              )
                continue;
              const cols = line.replace(/^#HttpOnly_/, "").split("\t");
              if (cols.length !== 7) continue;
              const domain = cols[0]!;
              if (!/^\.?([a-z0-9-]+\.)*xiaohongshu\.com$/.test(domain))
                continue;
              await client.transport.jar.setCookie(
                `${cols[5]}=${cols[6]}${cols[1] === "TRUE" ? `; Domain=${domain}` : ""}; Path=${cols[2] || "/"}${line.startsWith("#HttpOnly_") ? "; HttpOnly" : ""}${cols[3] === "TRUE" ? "; Secure" : ""}${Number(cols[4]) > 0 ? `; Expires=${new Date(Number(cols[4]) * 1000).toUTCString()}` : ""}`,
                `https://${domain.replace(/^\./, "")}/`,
              );
            }
          } else {
            for (const pair of value.replace(/^cookie:\s*/i, "").split(";")) {
              const match = pair.trim().match(/^([^=\s]+)=(.*)$/);
              if (match) await client.setCookie(match[1]!, match[2]!);
            }
          }
        }
        const cookies = await client.transport.jar.getCookies(ORIGINS.api);
        const get = (name: string) =>
          cookies.find((c) => c.key === name)?.value;
        if (!get("a1") || !get("web_session"))
          throw new AppError(
            "INVALID_COOKIE_FILE",
            "Cookie 必须包含 a1 和 web_session。",
            2,
          );
        session.device.a1 = get("a1")!;
        session.device.webId = get("webId") ?? session.device.webId;
        session.device.loadts = Number(get("loadts")) || Date.now();
        session.device.webBuild = get("webBuild") ?? session.device.webBuild;
        // Imported sessions still require a fresh HTTP time anchor before signing.
        const ds = await client.transport.request(
          "security",
          "/api/sec/v1/ds?appId=xhs-pc-web",
          { headers: { "user-agent": session.device.userAgent } },
        );
        const anchor = ds.text.match(
          /function\s+getdss\s*\(\s*\)\s*\{\s*return\s+['"](\d+)['"]/,
        );
        if (!anchor)
          throw new AppError(
            "PROTOCOL_INCOMPATIBLE",
            "无法更新导入会话的协议时间锚点。",
            10,
          );
        session.device.dsl = anchor[1]!;
        session.device.dsUpdatedAt = Date.now();
        session.device.deviceTag = "a3";
        session.device.activated = true;
        await client.me();
      });
      await this.store.saveSession(session);
      return {
        profile: this.config.profile,
        authenticated: true,
        verified: true,
        user: session.user,
      };
    });
  }
}
