import { delay } from "../infrastructure/timing.js";
import type { Note } from "../domain/content.js";
import { noteFromHtml } from "./ssr.js";
import { randomUUID } from "node:crypto";
import type { XhsClient } from "../api/client.js";
import type { Ref, ListKind, RemotePage } from "../domain/content.js";
import { unknownAccess } from "../domain/content.js";
import { AppError, protocolError } from "../domain/errors.js";
import { apiData, type WireResponse } from "../infrastructure/http.js";
import {
  obj,
  arr,
  str,
  pick,
  counter,
  normalizePage,
  normalizeNote,
} from "./normalize.js";
export function contentData(response: WireResponse, operation: string) {
  try {
    return apiData(response, operation);
  } catch (error) {
    if (!(error instanceof AppError) || ![7].includes(error.exitCode))
      throw error;
    let body: Record<string, unknown> = {};
    try {
      body = obj(JSON.parse(response.text));
    } catch {
      /* no raw body in errors */
    }
    const message = str(body.msg) ?? str(body.message) ?? "";
    if (/隐私|不公开|私密|private/i.test(message))
      throw new AppError(
        "LIST_PRIVATE",
        "该用户未向当前身份开放此列表。",
        11,
        error.details,
      );
    if (/无权限|没有权限|forbidden|permission denied/i.test(message))
      throw new AppError(
        "PERMISSION_DENIED",
        "当前身份无权访问此资源。",
        11,
        error.details,
      );
    throw new AppError(
      operation === "note.get" ? "CONTENT_UNAVAILABLE" : "RESOURCE_UNAVAILABLE",
      "当前资源不可访问，平台未提供可确定的原因。",
      7,
      error.details,
    );
  }
}
export async function userProfile(
  client: XhsClient,
  ref: Ref,
  viewerId: string | null,
) {
  const data = contentData(
    await client.request(
      "/api/sns/web/v1/user/otherinfo?" +
        new URLSearchParams({
          target_user_id: ref.id,
          ...(ref.xsec_token
            ? {
                xsec_token: ref.xsec_token,
                xsec_source: ref.xsec_source ?? "pc_user",
              }
            : {}),
        }),
    ),
    "user.get",
  );
  const basic = obj(data.basic_info),
    interactions = arr(data.interactions);
  const count = (...keys: string[]) => {
    const found = interactions
      .map(obj)
      .find((x) => keys.includes(String(x.type)));
    return counter(found?.count);
  };
  return {
    ref,
    nickname: str(basic.nickname),
    red_id: str(basic.red_id),
    bio: str(basic.desc),
    avatar_url: str(basic.imageb) ?? str(basic.images),
    profile_url: "https://www.xiaohongshu.com/user/profile/" + ref.id,
    is_self: viewerId === ref.id,
    fetched_at: new Date().toISOString(),
    counts: {
      posts: counter(data.posted),
      followers: count("fans"),
      following: count("follows"),
      received_likes_and_favorites: count("interaction"),
    },
    list_access: {
      posts: unknownAccess(),
      likes: unknownAccess(),
      favorites: unknownAccess(),
    },
  };
}
export async function userPage(
  client: XhsClient,
  ref: Ref,
  kind: ListKind,
  cursor: string,
  size: number,
): Promise<RemotePage> {
  const path = {
    posts: "/api/sns/web/v1/user_posted",
    likes: "/api/sns/web/v1/note/like/page",
    favorites: "/api/sns/web/v2/note/collect/page",
  }[kind];
  const page = normalizePage(
    contentData(
      await client.request(
        path +
          "?" +
          new URLSearchParams({
            num: String(size),
            cursor,
            user_id: ref.id,
            image_formats: "jpg,webp,avif",
            xsec_token: ref.xsec_token ?? "",
            xsec_source: ref.xsec_source ?? "pc_user",
          }),
      ),
      "user." + kind,
    ),
    { id: ref.id, kind },
  );
  if (
    kind !== "posts" &&
    !page.items.length &&
    client.session.user?.id !== ref.id
  ) {
    const data = contentData(
      await client.request(
        "/api/sns/web/v1/user/otherinfo?" +
          new URLSearchParams({ target_user_id: ref.id }),
      ),
      "user.visibility",
    );
    const tabs = obj(data.tab_public);
    const visible =
      kind === "favorites" ? tabs.collection : pick(tabs, "like", "liked");
    if (
      visible === false ||
      (kind === "favorites" && obj(tabs.collectionNote).lock === true)
    )
      throw new AppError(
        "LIST_PRIVATE",
        "该用户资料明确将此列表设为不可见。",
        11,
      );
  }
  return page;
}
export type SearchContext = { search_id: string; session_id: string };
export function searchContext(): SearchContext {
  return {
    search_id: (
      (BigInt(Date.now()) << 64n) +
      BigInt(Math.floor(Math.random() * 0x7ffffffe))
    ).toString(36),
    session_id: randomUUID(),
  };
}
export async function searchPage(
  client: XhsClient,
  keyword: string,
  page: number,
  size: number,
  context: SearchContext,
  sort = "relevance",
  type = "all",
) {
  const body = {
    keyword,
    page,
    page_size: size,
    search_id: context.search_id,
    sort: (
      {
        relevance: "general",
        latest: "time_descending",
        likes: "popularity_descending",
      } as Record<string, string>
    )[sort],
    note_type: ({ all: 0, video: 1, image: 2 } as Record<string, number>)[type],
    ext_flags: [],
    geo: "",
    image_formats: ["jpg", "webp", "avif"],
    session_id: context.session_id,
  };
  return normalizePage(
    contentData(
      await client.request(
        "/api/sns/web/v2/search/notes",
        body,
        "steady",
        "search",
      ),
      "search.notes",
    ),
    undefined,
    page,
  );
}
export async function noteDetail(
  client: XhsClient,
  ref: Ref,
  options: { intervalMs?: number; signal?: AbortSignal } = {},
) {
  const readApi = async () => {
    if (client.session) client.session.last_content_request_at = Date.now();
    const data = contentData(
      await client.request("/api/sns/web/v1/feed", {
        source_note_id: ref.id,
        image_formats: ["jpg", "webp", "avif"],
        extra: { need_body_topic: "1" },
        xsec_source: ref.xsec_source ?? "pc_search",
        xsec_token: ref.xsec_token ?? "",
      }),
      "note.get",
    );
    const item = arr(data.items)
      .map(obj)
      .find(
        (x) =>
          pick(
            obj(pick(x, "note_card", "noteCard")),
            "note_id",
            "noteId",
            "id",
          ) === ref.id,
      );
    if (!item)
      throw new AppError(
        "CONTENT_UNAVAILABLE",
        "平台未返回对应帖子的详情。",
        7,
      );
    const note = normalizeNote(pick(item, "note_card", "noteCard"), ref);
    if (!note.media.length) throw protocolError("帖子没有可识别的媒体字段。");
    return note;
  };
  let note: Note;
  let source: "api" | "html_fallback" = "api";
  const warnings: string[] = [];
  try {
    note = await readApi();
  } catch (error) {
    if (!(error instanceof AppError) || error.exitCode !== 7) throw error;
    const html = await client.transport.request(
      "web",
      "/explore/" +
        ref.id +
        (ref.xsec_token
          ? "?" +
            new URLSearchParams({
              xsec_token: ref.xsec_token,
              xsec_source: ref.xsec_source ?? "pc_search",
            })
          : ""),
      { headers: { "user-agent": client.session.device.userAgent } },
    );
    if (html.status !== 200)
      throw new AppError("CONTENT_UNAVAILABLE", "静态详情页面不可访问。", 7, {
        http_status: html.status,
      });
    try {
      note = normalizeNote(noteFromHtml(html.text, ref.id), ref);
    } catch (fallback) {
      if (!ref.xsec_token)
        throw new AppError(
          "ACCESS_CONTEXT_REQUIRED",
          "请提供包含 xsec_token 的完整分享链接或显式传入访问参数。",
          2,
        );
      throw fallback;
    }
    source = "html_fallback";
    warnings.push("API_UNAVAILABLE_HTML_FALLBACK");
  }
  const observe = (n: Note) => {
    const variants = n.media.flatMap((m) => m.variants);
    const heights = variants.flatMap((v) =>
      v.height === null ? [] : [v.height],
    );
    return {
      source,
      variant_count: variants.length,
      max_height: heights.length ? Math.max(...heights) : null,
    };
  };
  const signature = (n: Note) =>
    JSON.stringify(
      n.media
        .flatMap((m) =>
          m.variants.map((v) => [
            m.id,
            v.codec,
            v.width,
            v.height,
            v.bitrate,
            v.original,
          ]),
        )
        .sort(),
    );
  const signatures = [signature(note)],
    observations = [observe(note)];
  let attempts = 1;
  // Successful API responses can omit complete codec buckets. Sample a bounded
  // three times for video and merge only variants belonging to this same note.
  if (source === "api" && note.type === "video")
    for (let i = 1; i < 3; i++) {
      await delay(options.intervalMs ?? 1000, options.signal);
      attempts++;
      let next: Note;
      try {
        next = await readApi();
      } catch (error) {
        if (
          !(error instanceof AppError) ||
          ![6, 7].includes(error.exitCode) ||
          options.signal?.aborted
        )
          throw error;
        warnings.push("CANDIDATE_ENRICHMENT_INCOMPLETE");
        break;
      }
      if (next.type !== note.type)
        throw protocolError("多次详情响应的帖子类型不一致。");
      signatures.push(signature(next));
      observations.push(observe(next));
      for (const media of next.media) {
        const previous = note.media.find(
          (m) => m.id === media.id && m.role === media.role,
        );
        if (!previous) {
          note.media.push(media);
          continue;
        }
        for (const variant of media.variants) {
          const key = (v: typeof variant) =>
            JSON.stringify([
              v.codec_raw,
              v.width,
              v.height,
              v.bitrate,
              v.size_bytes,
              v.original,
            ]);
          const existing = previous.variants.find(
            (v) => key(v) === key(variant),
          );
          if (existing) {
            const backups = [
              existing.url,
              ...existing.backup_urls,
              ...variant.backup_urls,
            ].filter((url) => url !== variant.url);
            Object.assign(existing, variant, {
              backup_urls: [...new Set(backups)],
            });
          } else previous.variants.push(variant);
        }
      }
      note.fetched_at = next.fetched_at;
    }
  const changed = new Set(signatures).size > 1;
  if (changed) warnings.push("API_CANDIDATES_VARIED");
  note.resolution = {
    source,
    observations,
    attempts,
    candidates_changed: changed,
    best_effort: true,
    warnings,
  };
  return note;
}
