import { FetchClient } from "../infrastructure/fetch.js";
import {
  open,
  stat,
  readFile,
  writeFile,
  rename,
  rm,
  link,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { AppError } from "../domain/errors.js";
import { delay, checkSignal } from "../infrastructure/timing.js";
import type { Config } from "../config/config.js";
export function mediaUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError("INVALID_MEDIA_URL", "媒体 URL 无效。", 7);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    !["xhscdn.com", "xhsimg.com", "xiaohongshu.com"].some(
      (d) => url.hostname === d || url.hostname.endsWith("." + d),
    )
  )
    throw new AppError("INVALID_MEDIA_URL", "拒绝非小红书 CDN 媒体地址。", 7);
  url.protocol = "https:";
  return url;
}
export class RateLimiter {
  private next = 0;
  constructor(
    readonly bytesPerSecond: number,
    readonly signal?: AbortSignal,
  ) {}
  async consume(bytes: number) {
    if (!this.bytesPerSecond) return;
    const now = performance.now(),
      start = Math.max(this.next, now);
    this.next = start + (bytes / this.bytesPerSecond) * 1000;
    await delay(this.next - now, this.signal);
  }
}
export async function sha256(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
export function validMedia(bytes: Buffer) {
  return (
    bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
    bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
    bytes.subarray(0, 6).toString().startsWith("GIF8") ||
    (bytes.subarray(0, 4).toString() === "RIFF" &&
      bytes.subarray(8, 12).toString() === "WEBP") ||
    bytes.subarray(4, 8).toString() === "ftyp" ||
    bytes.subarray(0, 4).equals(Buffer.from("1a45dfa3", "hex"))
  );
}
export type TransferProgress = {
  phase: "connecting" | "downloading" | "retrying" | "verifying";
  downloaded_bytes: number;
  total_bytes: number | null;
  transferred_bytes: number;
  resumed_bytes: number;
  attempt: number;
};
export type TransferOptions = {
  resume: boolean;
  overwrite: boolean;
  retries: number;
  requestTimeoutMs: number;
  proxy?: string;
  signal?: AbortSignal;
  limiter?: RateLimiter;
  validateUrl?: (url: string) => URL;
  progress?: (event: TransferProgress) => void;
};
type PartMeta = {
  url: string;
  etag: string | null;
  last_modified: string | null;
  total: number | null;
};
export async function transfer(
  candidates: string[],
  path: string,
  options: TransferOptions,
) {
  const part = path + ".part",
    metadata = part + ".json";
  const client = new FetchClient(options.proxy);
  let last: unknown;
  let wireBytes = 0,
    attemptNumber = 0;
  let state: TransferProgress = {
    phase: "connecting",
    downloaded_bytes: 0,
    total_bytes: null,
    transferred_bytes: 0,
    resumed_bytes: 0,
    attempt: 0,
  };
  const notify = (update: Partial<TransferProgress>) => {
    state = { ...state, ...update, transferred_bytes: wireBytes };
    options.progress?.({ ...state });
  };
  const validate = options.validateUrl ?? mediaUrl;
  const candidate = async (
    raw: string,
    forceRestart = false,
  ): Promise<{
    bytes: number;
    sha256: string;
    content_type: string | null;
  }> => {
    checkSignal(options.signal);
    let offset = 0,
      old: PartMeta | null = null;
    if (options.resume && !forceRestart) {
      try {
        old = JSON.parse(await readFile(metadata, "utf8")) as PartMeta;
        offset = (await stat(part)).size;
      } catch {
        old = null;
        offset = 0;
      }
    }
    const validator =
      old?.etag && !old.etag.startsWith("W/") ? old.etag : old?.last_modified;
    if (!validator) offset = 0;
    attemptNumber++;
    notify({
      phase: "connecting",
      attempt: attemptNumber,
      downloaded_bytes: offset,
      resumed_bytes: offset,
      total_bytes:
        typeof old?.total === "number" &&
        Number.isFinite(old.total) &&
        old.total >= 0
          ? old.total
          : null,
    });
    let url = validate(raw),
      response: Awaited<ReturnType<FetchClient["fetch"]>> | undefined;
    for (let hop = 0; hop < 5; hop++) {
      response = await client.fetch(url, {
        redirect: "manual",
        signal: AbortSignal.any([
          AbortSignal.timeout(options.requestTimeoutMs),
          ...(options.signal ? [options.signal] : []),
        ]),
        headers: {
          referer: "https://www.xiaohongshu.com/",
          ...(offset
            ? { Range: `bytes=${offset}-`, "If-Range": validator! }
            : {}),
          "accept-encoding": "identity",
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location)
          throw new AppError("DOWNLOAD_HTTP_ERROR", "媒体跳转缺少地址。", 7);
        url = validate(new URL(location, url).toString());
        response = undefined;
        continue;
      }
      break;
    }
    if (!response)
      throw new AppError("DOWNLOAD_HTTP_ERROR", "媒体重定向过多。", 7);
    if (response.status === 416 && offset && !forceRestart) {
      await response.body?.cancel();
      return candidate(raw, true);
    }
    if (response.status === 429) {
      await response.body?.cancel();
      throw new AppError("RATE_LIMITED", "CDN 暂时限制下载频率。", 5, {}, true);
    }
    if (response.status !== 200 && response.status !== 206) {
      await response.body?.cancel();
      throw new AppError(
        [401, 403, 404, 410].includes(response.status)
          ? "MEDIA_URL_EXPIRED"
          : "DOWNLOAD_HTTP_ERROR",
        "媒体 CDN 请求失败。",
        response.status >= 500 ? 6 : 7,
        { http_status: response.status },
        response.status >= 500,
      );
    }
    const type = response.headers.get("content-type");
    if (type && /html|json|text\//i.test(type)) {
      await response.body?.cancel();
      throw new AppError(
        "INVALID_MEDIA",
        "CDN 返回了文本/错误页而不是媒体。",
        7,
      );
    }
    const etag = response.headers.get("etag"),
      modified = response.headers.get("last-modified"),
      range = response.headers.get("content-range");
    if (response.status === 206) {
      const match = range?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
      const identity =
        old?.etag && !old.etag.startsWith("W/")
          ? etag === old.etag
          : old?.last_modified
            ? modified === old.last_modified
            : false;
      if (
        !offset ||
        !match ||
        Number(match[1]) !== offset ||
        Number(match[2]) < offset ||
        Number(match[3]) <= Number(match[2]) ||
        !identity
      ) {
        await response.body?.cancel();
        if (forceRestart)
          throw new AppError("INVALID_RANGE", "CDN 返回无效的分段响应。", 7);
        return candidate(raw, true);
      }
    } else offset = 0;
    const length = Number(response.headers.get("content-length"));
    const expected = response.headers.has("content-length") ? length : null;
    const total =
      response.status === 206 ? Number(range!.match(/\/(\d+)$/)![1]) : expected;
    notify({
      phase: "downloading",
      downloaded_bytes: offset,
      resumed_bytes: offset,
      total_bytes:
        total !== null && Number.isFinite(total) && total >= 0 ? total : null,
    });
    const meta: PartMeta = {
      url: url.toString(),
      etag,
      last_modified: modified,
      total,
    };
    await writeFile(metadata, JSON.stringify(meta), { mode: 0o600 });
    const file = await open(part, offset ? "a" : "w", 0o600);
    let transferred = 0;
    try {
      if (response.body)
        for await (const chunk of response.body) {
          checkSignal(options.signal);
          await options.limiter?.consume(chunk.length);
          let written = 0;
          while (written < chunk.length) {
            const result = await file.write(
              chunk,
              written,
              chunk.length - written,
            );
            if (!result.bytesWritten)
              throw new AppError("FILESYSTEM_ERROR", "媒体写盘无进展。", 8);
            written += result.bytesWritten;
          }
          transferred += chunk.length;
          wireBytes += chunk.length;
          notify({ downloaded_bytes: offset + transferred });
        }
      await file.sync();
    } finally {
      await file.close();
    }
    if (expected !== null && transferred !== expected)
      throw new AppError(
        "INCOMPLETE_DOWNLOAD",
        "媒体长度与响应不符，已保留断点。",
        6,
        {},
        true,
      );
    notify({ phase: "verifying" });
    const handle = await open(part, "r");
    const head = Buffer.alloc(16);
    try {
      await handle.read(head, 0, 16, 0);
    } finally {
      await handle.close();
    }
    if (!validMedia(head)) {
      await rm(part, { force: true });
      await rm(metadata, { force: true });
      throw new AppError("INVALID_MEDIA", "文件头不是受支持的图片或视频。", 7);
    }
    const bytes = (await stat(part)).size;
    if (total !== null && bytes !== total)
      throw new AppError(
        "INCOMPLETE_DOWNLOAD",
        "媒体总长度不符，已保留断点。",
        6,
        {},
        true,
      );
    const checksum = await sha256(part);
    if (options.overwrite) await rename(part, path);
    else {
      try {
        await link(part, path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST")
          throw new AppError(
            "OUTPUT_COLLISION",
            "目标文件已存在，拒绝覆盖。",
            8,
            { path },
          );
        throw e;
      }
      await rm(part);
    }
    await rm(metadata, { force: true });
    return { bytes, sha256: checksum, content_type: type };
  };
  try {
    for (let attempt = 0; attempt <= options.retries; attempt++) {
      for (const url of candidates) {
        try {
          return await candidate(url);
        } catch (error) {
          checkSignal(options.signal);
          last = error;
          notify({ phase: "retrying" });
          if (
            error instanceof AppError &&
            ["CANCELLED", "TIMEOUT", "OUTPUT_COLLISION"].includes(error.code)
          )
            throw error;
        }
      }
      if (attempt < options.retries) {
        if (
          last instanceof AppError &&
          !last.retryable &&
          last.code !== "MEDIA_URL_EXPIRED"
        )
          break;
        await delay(Math.min(1000 * 2 ** attempt, 10000), options.signal);
      }
    }
    if (last instanceof AppError) throw last;
    throw new AppError(
      "NETWORK_ERROR",
      "媒体下载连接失败或中断，已保留可用断点。",
      6,
      {},
      true,
    );
  } finally {
    await client.close();
  }
}
export function transferOptions(
  config: Config,
  signal?: AbortSignal,
): TransferOptions {
  return {
    resume: config.download.resume,
    overwrite: config.download.on_exists === "overwrite",
    retries: config.network.retries,
    requestTimeoutMs: config.network.request_timeout_seconds * 1000,
    proxy: config.network.proxy,
    signal,
    limiter: new RateLimiter(config.download.rate_limit, signal),
  };
}
