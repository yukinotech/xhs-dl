import { CookieJar } from "tough-cookie";
import type { Device, Session, User } from "../domain/models.js";
import { AppError, protocolError, requireValue } from "../domain/errors.js";
import {
  makeA1,
  digest,
  createHandshake,
  acceptSsk,
} from "../protocol/crypto.js";
import { sign } from "../protocol/signer.js";
import { USER_AGENT, WEB_BUILD, type Stage } from "../protocol/constants.js";
import {
  type Transport,
  type Origin,
  ORIGINS,
  apiData,
} from "../infrastructure/http.js";

export function createDevice(now = Date.now()): Device {
  const a1 = makeA1(now);
  return {
    a1,
    webId: digest("md5", a1).toString("hex"),
    loadts: now,
    sequence: 0,
    dsl: "",
    dsUpdatedAt: 0,
    deviceTag: "nop",
    webBuild: WEB_BUILD,
    userAgent: USER_AGENT,
    b1: "",
    activated: false,
  };
}
export function newSession(): Session {
  return {
    schema_version: 1,
    protocol_version: "pc-http-2026-11",
    device: createDevice(),
    cookies: {},
    user: null,
    authenticated: false,
    login_pending: false,
    last_checked_at: null,
    last_content_request_at: 0,
  };
}
const string = (v: unknown) => (typeof v === "string" && v ? v : null);
export class XhsClient {
  constructor(
    readonly session: Session,
    readonly transport: Transport,
  ) {}
  async snapshot() {
    this.session.cookies =
      (await this.transport.jar.serialize()) as unknown as Record<
        string,
        unknown
      >;
    return this.session;
  }
  private headers() {
    return {
      "user-agent": this.session.device.userAgent,
      referer: ORIGINS.web + "/",
      origin: ORIGINS.web,
      accept: "application/json, text/plain, */*",
      "accept-language": "zh-CN,zh;q=0.9",
      "sec-ch-ua-platform": '"Windows"',
      "sec-ch-ua":
        '"Google Chrome";v="155", "Chromium";v="155", "Not(A:Brand";v="24"',
      "sec-ch-ua-mobile": "?0",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-site",
    };
  }
  async setCookie(name: string, value: string) {
    await this.transport.jar.setCookie(
      `${name}=${value}; Domain=.xiaohongshu.com; Path=/; Secure`,
      ORIGINS.api,
    );
  }
  async request(
    path: string,
    body?: Record<string, unknown>,
    stage: Stage = "steady",
    origin: Origin = "api",
    extra: Record<string, string> = {},
  ) {
    const encoded = body === undefined ? "" : JSON.stringify(body);
    const response = await this.transport.request(origin, path, {
      method: body === undefined ? "GET" : "POST",
      ...(body !== undefined ? { body: encoded } : {}),
      headers: {
        ...this.headers(),
        ...sign(this.session.device, path, encoded, stage),
        ...(body !== undefined
          ? { "content-type": "application/json;charset=UTF-8" }
          : {}),
        ...extra,
      },
    });
    return response;
  }
  async bootstrap() {
    const navigation = await this.transport.request("web", "/explore", {
      headers: {
        "user-agent": this.session.device.userAgent,
        accept: "text/html",
      },
    });
    if (navigation.status !== 200)
      throw new AppError(
        "NETWORK_ERROR",
        "无法初始化小红书匿名 HTTP 会话。",
        6,
        { http_status: navigation.status },
      );
    const now = Date.now(),
      d = this.session.device;
    for (const [name, value] of Object.entries({
      ets: String(now),
      webBuild: d.webBuild,
      xsecappid: "xhs-pc-web",
      loadts: String(d.loadts),
      a1: d.a1,
      webId: d.webId,
    }))
      await this.setCookie(name, value);
    const ds = await this.transport.request(
      "security",
      "/api/sec/v1/ds?appId=xhs-pc-web",
      { headers: this.headers() },
    );
    d.dsl = requireValue(
      ds.text.match(
        /function\s+getdss\s*\(\s*\)\s*\{\s*return\s+['"](\d+)['"]/,
      )?.[1],
      "无法从 HTTP 安全初始化响应取得协议时间锚点。",
    );
    d.deviceTag = "a3";
    d.dsUpdatedAt = Date.now();
    const handshake = createHandshake();
    const data = apiData(
      await this.request(
        "/api/sns/web/v1/login/activate",
        { client_public_key_base64: handshake.public_key },
        "activate",
      ),
      "auth.activate",
    );
    await this.setCookie(
      "web_session",
      requireValue(string(data.session), "激活响应缺少匿名会话。"),
    );
    if (data.ssk)
      d.ssk = acceptSsk(
        handshake.private_key,
        requireValue(string(data.ssk), "激活密钥格式无效。"),
      );
    d.activated = true;
  }
  async sendSms(phone: string, zone: string) {
    return apiData(
      await this.request(
        "/api/sns/web/v2/login/send_code?" +
          new URLSearchParams({ phone, zone, type: "login" }),
      ),
      "sms.send",
    );
  }
  async verifySms(phone: string, zone: string, code: string) {
    const checked = apiData(
      await this.request(
        "/api/sns/web/v1/login/check_code?" +
          new URLSearchParams({ phone, zone, code }),
      ),
      "sms.verify",
    );
    const token = requireValue(
      string(checked.mobile_token),
      "验证码响应缺少 mobile_token。",
    );
    const handshake = createHandshake();
    const data = apiData(
      await this.request("/api/sns/web/v2/login/code", {
        mobile_token: token,
        zone,
        phone,
        client_public_key_base64: handshake.public_key,
      }),
      "sms.login",
    );
    await this.acceptLogin(data, handshake.private_key);
    return this.me();
  }
  async qrCreate() {
    const data = apiData(
      await this.request(
        "/api/sns/web/v1/login/qrcode/create",
        { qr_type: 1 },
        "qrCreate",
      ),
      "qr.create",
    );
    return {
      qr_id: requireValue(string(data.qr_id), "二维码响应缺少 qr_id。"),
      qr_code: requireValue(string(data.code), "二维码响应缺少 code。"),
      qr_text: requireValue(string(data.url), "二维码响应缺少 url。"),
    };
  }
  async qrPoll(
    qrId: string,
    code: string,
  ): Promise<{
    status:
      "awaiting_scan" | "awaiting_confirmation" | "expired" | "authenticated";
    user?: User;
  }> {
    const data = apiData(
      await this.request("/api/qrcode/userinfo", { qrId, code }, "qrPoll"),
      "qr.poll",
    );
    const status = Number(data.codeStatus);
    if (status === 0) return { status: "awaiting_scan" };
    if (status === 1) return { status: "awaiting_confirmation" };
    if (status === 3) return { status: "expired" };
    if (status !== 2)
      throw protocolError("平台返回未知二维码状态。", { qr_status: status });
    const handshake = createHandshake();
    const login = apiData(
      await this.request(
        "/api/sns/web/v1/login/qrcode/status?" +
          new URLSearchParams({
            qr_id: qrId,
            code,
            client_public_key_base64: handshake.public_key,
          }),
        undefined,
        "qrPoll",
        "api",
        { "x-login-mode": "" },
      ),
      "qr.login",
    );
    if (
      login.code_status !== 2 ||
      typeof login.login_info !== "object" ||
      !login.login_info
    )
      throw protocolError("二维码最终确认响应不兼容。");
    await this.acceptLogin(
      login.login_info as Record<string, unknown>,
      handshake.private_key,
    );
    return { status: "authenticated", user: await this.me() };
  }
  private async acceptLogin(data: Record<string, unknown>, privateKey: string) {
    await this.setCookie(
      "web_session",
      requireValue(string(data.session), "登录响应缺少正式账号会话。"),
    );
    this.session.login_pending = true;
    if (data.ssk)
      this.session.device.ssk = acceptSsk(
        privateKey,
        requireValue(string(data.ssk), "登录密钥格式无效。"),
      );
    else delete this.session.device.ssk;
  }
  async me(): Promise<User> {
    const device = this.session.device;
    if (!device.dsl || Date.now() - device.dsUpdatedAt > 300000) {
      const response = await this.transport.request(
        "security",
        "/api/sec/v1/ds?appId=xhs-pc-web",
        { headers: this.headers() },
      );
      device.dsl = requireValue(
        response.text.match(
          /function\s+getdss\s*\(\s*\)\s*\{\s*return\s+['"](\d+)['"]/,
        )?.[1],
        "无法刷新会话协议时间锚点。",
      );
      device.dsUpdatedAt = Date.now();
    }

    const data = apiData(
      await this.request("/api/sns/web/v2/user/me"),
      "me.get",
    );
    if (data.guest === true || data.is_guest === true || data.guest === 1)
      throw new AppError(
        "AUTH_REQUIRED",
        "当前是匿名会话，请先完成登录。",
        3,
        {},
        false,
        "login",
      );
    const id = requireValue(
      string(data.user_id) ?? string(data.id),
      "当前用户响应缺少 user_id。",
    );
    const user: User = {
      id,
      nickname: string(data.nickname),
      red_id: string(data.red_id) ?? string(data.redId),
      bio: string(data.desc),
      avatar_url:
        string(data.imageb) ?? string(data.images) ?? string(data.avatar),
      profile_url: `${ORIGINS.web}/user/profile/${id}`,
      is_self: true,
      fetched_at: new Date().toISOString(),
    };
    this.session.user = user;
    this.session.authenticated = true;
    this.session.login_pending = false;
    this.session.last_checked_at = user.fetched_at;
    return user;
  }
}
export async function restoreJar(session: Session) {
  return CookieJar.deserialize(JSON.stringify(session.cookies));
}
