import { CookieJar } from "tough-cookie";
import { FetchClient } from "./fetch.js";
import { AppError, protocolError } from "../domain/errors.js";

export const ORIGINS = {
  web: "https://www.xiaohongshu.com",
  api: "https://edith.xiaohongshu.com",
  security: "https://as.xiaohongshu.com",
  search: "https://so.xiaohongshu.com",
};
export type Origin = keyof typeof ORIGINS;
export type WireResponse = { status: number; headers: Headers; text: string };
export interface Transport {
  jar: CookieJar;
  request(
    origin: Origin,
    path: string,
    options?: {
      method?: string;
      body?: string;
      headers?: Record<string, string>;
    },
  ): Promise<WireResponse>;
  close(): Promise<void>;
}
export class HttpTransport implements Transport {
  private client: FetchClient;
  constructor(
    public jar: CookieJar,
    private requestTimeoutMs = 30000,
    private signal?: AbortSignal,
    proxy?: string,
    private origins: Partial<typeof ORIGINS> = ORIGINS,
  ) {
    this.client = new FetchClient(proxy);
  }
  async request(
    origin: Origin,
    path: string,
    options: {
      method?: string;
      body?: string;
      headers?: Record<string, string>;
    } = {},
  ) {
    const base = this.origins[origin] ?? ORIGINS[origin];
    if (!path.startsWith("/") || path.startsWith("//"))
      throw protocolError("HTTP 路径必须是站内绝对路径。");
    let url = new URL(path, base);
    for (let hop = 0; hop < 5; hop++) {
      if (url.origin !== base)
        throw protocolError("拒绝将会话凭证发送到站外重定向。");
      const cookie = await this.jar.getCookieString(url.toString());
      const headers = { ...options.headers, ...(cookie ? { cookie } : {}) };
      let response;
      try {
        response = await this.client.fetch(url, {
          method: options.method ?? "GET",
          body: options.body,
          headers,
          redirect: "manual",
          signal: AbortSignal.any([
            AbortSignal.timeout(this.requestTimeoutMs),
            ...(this.signal ? [this.signal] : []),
          ]),
        });
        for (const value of response.headers.getSetCookie())
          await this.jar.setCookie(value, url.toString(), {
            ignoreError: true,
          });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!location) throw protocolError("HTTP 重定向缺少 location。");
          if (options.method && options.method !== "GET")
            throw protocolError("拒绝自动重发带副作用的重定向请求。");
          url = new URL(location, url);
          continue;
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (response.body)
          for await (const chunk of response.body) {
            size += chunk.length;
            if (size > 4 * 1024 * 1024)
              throw protocolError("HTTP 响应超过允许大小。");
            chunks.push(chunk);
          }
        const text = Buffer.concat(chunks).toString("utf8");
        return {
          status: response.status,
          headers: new Headers([...response.headers]),
          text,
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (this.signal?.aborted)
          throw new AppError(
            "CANCELLED",
            "操作已取消或整体超时。",
            this.signal.reason?.name === "TimeoutError" ? 6 : 130,
          );
        const cause = (error as { cause?: { code?: string } }).cause?.code;
        throw new AppError(
          "NETWORK_ERROR",
          "HTTP 请求失败或超时。",
          6,
          { host: url.hostname, network_code: cause ?? null },
          true,
        );
      }
    }
    throw protocolError("HTTP 重定向次数过多。");
  }
  async close() {
    await this.client.close();
  }
}
export function apiData(
  response: WireResponse,
  operation: string,
): Record<string, unknown> {
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(response.text);
  } catch {
    /* Classified below; never print an HTML response. */
  }
  if (!json || typeof json !== "object" || Array.isArray(json))
    throw protocolError("平台返回了非对象响应。", {
      operation,
      http_status: response.status,
    });
  const code = json.code;
  const details = {
    operation,
    http_status: response.status,
    platform_code:
      typeof code === "number" || typeof code === "string" ? code : null,
  };
  if (
    [461, 471].includes(response.status) ||
    response.headers.has("verifyuuid")
  )
    throw new AppError(
      "VERIFICATION_REQUIRED",
      "平台要求额外验证，当前 HTTP 登录尚不能继续。",
      4,
      details,
      false,
      "complete_platform_verification",
    );
  if (response.status === 429 || code === 300012)
    throw new AppError(
      "RATE_LIMITED",
      "平台暂时限制请求频率，请稍后重试。",
      5,
      { ...details, retry_after_seconds: response.headers.get("retry-after") },
      true,
    );
  if (
    response.status === 401 ||
    [-100, -101, -102, -103].includes(Number(code))
  )
    throw new AppError(
      "SESSION_EXPIRED",
      "登录状态无效或已过期，请重新登录。",
      3,
      details,
      false,
      "login",
    );
  if (response.status === 406)
    throw protocolError("平台拒绝请求签名；需要更新 HTTP 协议适配。", details);
  if (
    json.success !== true &&
    !(json.code === 0 && response.status >= 200 && response.status < 300)
  ) {
    if (
      operation === "sms.verify" &&
      [-10010, -10011, -10012].includes(Number(code))
    )
      throw new AppError(
        "INVALID_CODE",
        "验证码无效或已过期。",
        4,
        details,
        false,
        "enter_new_code",
      );
    throw new AppError(
      "PLATFORM_ERROR",
      "平台未接受本次请求。",
      response.status >= 500 ? 6 : 7,
      details,
      response.status >= 500,
    );
  }
  if (response.status < 200 || response.status >= 300)
    throw protocolError("HTTP 状态与平台成功响应不一致。", details);
  const data = json.data;
  if (data === null || data === undefined) return {};
  if (typeof data !== "object" || Array.isArray(data))
    throw protocolError("平台响应 data 结构不兼容。", details);
  return data as Record<string, unknown>;
}
