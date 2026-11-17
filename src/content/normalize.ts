import { createHash } from "node:crypto";
import type {
  Note,
  Ref,
  Media,
  Variant,
  Summary,
  ListKind,
  RemotePage,
} from "../domain/content.js";
import { protocolError } from "../domain/errors.js";
export type Obj = Record<string, unknown>;
export const obj = (x: unknown): Obj =>
  x && typeof x === "object" && !Array.isArray(x) ? (x as Obj) : {};
export const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
export const str = (x: unknown): string | null =>
  typeof x === "string" && x ? x : null;
export const pick = (x: Obj, ...keys: string[]) =>
  keys.map((k) => x[k]).find((v) => v !== undefined && v !== null);
export const number = (x: unknown): number | null =>
  x !== null && x !== undefined && x !== "" && Number.isFinite(Number(x))
    ? Number(x)
    : null;
export function timestamp(x: unknown) {
  const n = number(x);
  if (n !== null && n > 0) {
    const date = new Date(n < 1e12 ? n * 1000 : n);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  return null;
}
function url(x: unknown) {
  const s = str(x);
  return s
    ? s.startsWith("//")
      ? "https:" + s
      : s.replace(/^http:\/\//, "https://")
    : null;
}
export function counter(x: unknown) {
  const text = x == null ? null : String(x);
  return {
    value: text && /^\d+$/.test(text) ? Number(text) : null,
    display: text,
    approximate: !!text && !/^\d+$/.test(text),
  };
}
function variant(raw: unknown, now: string, original = false): Variant | null {
  const x = obj(raw),
    address = url(
      pick(x, "master_url", "masterUrl", "url", "url_default", "urlDefault"),
    );
  if (!address) return null;
  return {
    url: address,
    backup_urls: arr(pick(x, "backup_urls", "backupUrls"))
      .map(url)
      .filter((x): x is string => !!x),
    width: number(x.width),
    height: number(x.height),
    codec: str(pick(x, "video_codec", "videoCodec", "codec")),
    container:
      str(pick(x, "format", "container")) ??
      (address.includes("/stream/") ? "mp4" : null),
    bitrate: number(pick(x, "avg_bitrate", "avgBitrate", "bitrate")),
    size_bytes: number(pick(x, "size", "size_bytes")),
    fetched_at: now,
    expires_at: null,
    original,
  };
}
function streams(raw: unknown, now: string) {
  const stream = obj(raw);
  return Object.values(stream)
    .flatMap(arr)
    .map((x) => variant(x, now))
    .filter((x): x is Variant => !!x);
}
function unique(variants: Variant[]) {
  return variants
    .filter((v, i) => variants.findIndex((x) => x.url === v.url) === i)
    .sort(
      (a, b) =>
        (b.original ? 1 : 0) - (a.original ? 1 : 0) ||
        (b.height ?? 0) - (a.height ?? 0) ||
        (b.bitrate ?? 0) - (a.bitrate ?? 0),
    );
}
export function normalizeSummary(
  raw: unknown,
  owner?: { id: string; kind: ListKind },
  now = new Date().toISOString(),
): Summary | null {
  const outer = obj(raw),
    card = obj(pick(outer, "note_card", "noteCard"));
  const x = Object.keys(card).length ? card : outer;
  const id = str(pick(x, "note_id", "noteId", "id")) ?? str(outer.id);
  if (!id) return null;
  const user = obj(x.user),
    type = pick(x, "type");
  const token =
    str(pick(outer, "xsec_token", "xsecToken")) ??
    str(pick(x, "xsec_token", "xsecToken"));
  const cover = obj(x.cover);
  const source = owner ? "pc_user" : "pc_search";
  const ref: Ref = {
    id,
    ...(token ? { xsec_token: token } : {}),
    xsec_source: source,
  };
  ref.url =
    "https://www.xiaohongshu.com/explore/" +
    id +
    (token
      ? "?" + new URLSearchParams({ xsec_token: token, xsec_source: source })
      : "");
  const unavailable =
    x.status === "deleted" ||
    x.status === "unavailable" ||
    x.is_deleted === true;
  return {
    ref,
    title: str(pick(x, "display_title", "displayTitle", "title")),
    author: {
      id: str(pick(user, "user_id", "userId", "id")),
      name: str(pick(user, "nickname", "nick_name")),
    },
    type:
      type === "video"
        ? "video"
        : ["normal", "image"].includes(String(type))
          ? "image"
          : "unknown",
    cover_url: url(pick(cover, "url_default", "urlDefault", "url")),
    completeness: "summary",
    availability: unavailable ? "unavailable" : "available",
    ...(owner
      ? {
          list_context: {
            owner_id: owner.id,
            kind: owner.kind,
            relation_at: null,
            observed_at: now,
          },
        }
      : {}),
  };
}
export function normalizePage(
  data: Obj,
  owner?: { id: string; kind: ListKind },
  searchPage = 1,
): RemotePage {
  const raw = pick(data, "notes", "items");
  if (!Array.isArray(raw))
    throw protocolError("列表响应缺少 notes/items 数组。");
  const cards = raw.filter((x) => {
    const t = obj(x).model_type;
    return !t || t === "note";
  });
  const items = cards.map((x) => normalizeSummary(x, owner));
  const has = pick(data, "has_more", "hasMore"),
    hasMore = typeof has === "boolean" ? has : null;
  const cursor = pick(data, "cursor", "next_cursor", "nextCursor");
  return {
    items: items.filter((x): x is Summary => !!x),
    unavailable: items.filter((x) => !x).length,
    next: owner
      ? typeof cursor === "string"
        ? cursor
        : null
      : hasMore === true
        ? String(searchPage + 1)
        : null,
    hasMore,
    reportedTotal: number(pick(data, "total", "total_count")),
  };
}
export function normalizeNote(
  raw: unknown,
  ref: Ref,
  now = new Date().toISOString(),
): Note {
  const x = obj(raw),
    id = str(pick(x, "note_id", "noteId", "id")) ?? ref.id;
  if (id !== ref.id) throw protocolError("详情返回的帖子 ID 与请求不一致。");
  const type =
    x.type === "video"
      ? "video"
      : ["normal", "image"].includes(String(x.type))
        ? "image"
        : "unknown";
  const user = obj(x.user);
  const media: Media[] = [];
  const images = arr(pick(x, "image_list", "imageList"));
  if (type !== "video")
    images.forEach((raw, index) => {
      const image = obj(raw);
      const base = variant(image, now);
      const options = arr(pick(image, "info_list", "infoList"))
        .map((raw) => {
          const item = obj(raw);
          return variant({ ...image, ...item }, now);
        })
        .filter((x): x is Variant => !!x);
      if (base) options.push(base);
      const stable =
        str(pick(image, "file_id", "fileId", "image_id", "imageId")) ??
        "image-" +
          hash((base?.url ?? options[0]?.url ?? "missing").split("?")[0]).slice(
            0,
            24,
          );
      const group = `${id}:${stable}`;
      media.push({
        id: stable,
        index: index + 1,
        role: "image",
        group_id: group,
        variants: unique(options),
      });
      const live = streams(image.stream, now);
      if (live.length)
        media.push({
          id: stable + ":live",
          index: index + 1,
          role: "live_video",
          group_id: group,
          variants: unique(live),
        });
    });
  if (type === "video") {
    const video = obj(x.video);
    const options = streams(obj(video.media).stream, now);
    const consumer = obj(video.consumer),
      key = str(pick(consumer, "origin_video_key", "originVideoKey"));
    if (key && /^[a-zA-Z0-9/_\-.]+$/.test(key)) {
      const original = variant(
        { url: "https://sns-video-bd.xhscdn.com/" + key, format: "mp4" },
        now,
        true,
      );
      if (original) options.push(original);
    }
    media.push({
      id: str(pick(video, "video_id", "videoId")) ?? "video",
      index: 1,
      role: "video",
      group_id: null,
      variants: unique(options),
    });
  }
  const stats = obj(pick(x, "interact_info", "interactInfo"));
  return {
    ref: { ...ref, id },
    type,
    title: typeof x.title === "string" ? x.title : null,
    description:
      typeof pick(x, "desc", "description") === "string"
        ? (pick(x, "desc", "description") as string)
        : null,
    author: {
      id: str(pick(user, "user_id", "userId", "id")),
      name: str(user.nickname),
    },
    published_at: timestamp(pick(x, "time", "publish_time", "publishTime")),
    updated_at: timestamp(pick(x, "last_update_time", "lastUpdateTime")),
    tags: arr(pick(x, "tag_list", "tagList"))
      .map((x) => str(obj(x).name))
      .filter((x): x is string => !!x),
    stats: Object.fromEntries(
      ["liked_count", "collected_count", "comment_count", "share_count"].map(
        (k) => [
          k,
          counter(
            pick(
              stats,
              k,
              k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
            ),
          ),
        ],
      ),
    ),
    media,
    fetched_at: now,
    protocol_version: "pc-http-2026-11",
    completeness: "full",
  };
}
export const hash = (x: unknown) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
