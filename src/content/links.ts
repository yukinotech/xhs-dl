import { fetch, ProxyAgent, type Dispatcher } from "undici";
import { AppError } from "../domain/errors.js";
import type { Ref } from "../domain/content.js";
const ID = /^[a-fA-F0-9]{24}$/;
export function contentUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError("INVALID_URL", "无法解析小红书链接。", 2);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    ![
      "xiaohongshu.com",
      "www.xiaohongshu.com",
      "xhslink.com",
      "www.xhslink.com",
    ].includes(url.hostname)
  )
    throw new AppError(
      "INVALID_URL",
      "只接受小红书主页、帖子或 xhslink 分享链接。",
      2,
    );
  url.protocol = "https:";
  return url;
}
export function extractUrl(text: string) {
  const candidates = text.match(/https?:\/\/[^\s<>"“”]+/g) ?? [];
  if (candidates.length !== 1)
    throw new AppError(
      "INVALID_ARGUMENT",
      "请输入单条链接或仅含一个链接的分享文本。",
      2,
    );
  return candidates[0]!.replace(/[，。！；、)）]+$/, "");
}
export async function resolveRef(
  input: string | Ref,
  kind: "note" | "user",
  options: {
    token?: string;
    source?: string;
    proxy?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<Ref> {
  if (typeof input !== "string") {
    if (!ID.test(input.id))
      throw new AppError(
        "INVALID_ID",
        "帖子/用户 ID 必须是 24 位十六进制。",
        2,
      );
    return {
      ...input,
      ...(options.token ? { xsec_token: options.token } : {}),
      ...(options.source ? { xsec_source: options.source } : {}),
    };
  }
  if (ID.test(input))
    return {
      id: input,
      ...(options.token ? { xsec_token: options.token } : {}),
      ...(options.source ? { xsec_source: options.source } : {}),
    };
  let url = contentUrl(extractUrl(input));
  let dispatcher: Dispatcher | undefined;
  try {
    if (options.proxy) dispatcher = new ProxyAgent(options.proxy);
    for (
      let hop = 0;
      ["xhslink.com", "www.xhslink.com"].includes(url.hostname);
      hop++
    ) {
      if (hop >= 5) throw new AppError("INVALID_URL", "短链重定向过多。", 2);
      const response = await fetch(url, {
        redirect: "manual",
        dispatcher,
        signal: AbortSignal.any([
          AbortSignal.timeout(options.timeoutMs ?? 30000),
          ...(options.signal ? [options.signal] : []),
        ]),
      });
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (![301, 302, 303, 307, 308].includes(response.status) || !location)
        throw new AppError("CONTENT_UNAVAILABLE", "分享短链没有有效跳转。", 7, {
          http_status: response.status,
        });
      url = contentUrl(new URL(location, url).toString());
    }
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError("NETWORK_ERROR", "短链展开失败或超时。", 6, {}, true);
  } finally {
    await dispatcher?.close();
  }
  const match =
    kind === "user"
      ? url.pathname.match(/^\/user\/profile\/([a-fA-F0-9]{24})\/?$/)
      : url.pathname.match(
          /^\/(?:explore|discovery\/item)\/([a-fA-F0-9]{24})\/?$/,
        );
  if (!match)
    throw new AppError(
      "INVALID_URL",
      kind === "user" ? "链接不是用户主页。" : "链接不是帖子详情。",
      2,
    );
  const token =
      options.token ?? url.searchParams.get("xsec_token") ?? undefined,
    source = options.source ?? url.searchParams.get("xsec_source") ?? undefined;
  return {
    id: match[1]!,
    url: url.toString(),
    ...(token ? { xsec_token: token } : {}),
    ...(source ? { xsec_source: source } : {}),
  };
}
