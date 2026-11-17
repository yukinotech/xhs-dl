import { z } from "zod";
export const refSchema = z.object({
  id: z.string().min(1),
  url: z.string().optional(),
  xsec_token: z.string().optional(),
  xsec_source: z.string().optional(),
});
export type Ref = z.infer<typeof refSchema>;
export const listKindSchema = z.enum(["posts", "likes", "favorites"]);
export type ListKind = z.infer<typeof listKindSchema>;
export const accessSchema = z.object({
  state: z.enum(["allowed", "denied", "unknown"]),
  reason: z.enum([
    "self",
    "api_allowed",
    "private",
    "forbidden",
    "undetermined",
  ]),
  checked_at: z.string().nullable(),
  evidence: z.enum(["api_response", "cached_observation", "none"]),
});
export type ListAccess = z.infer<typeof accessSchema>;
export const unknownAccess = (): ListAccess => ({
  state: "unknown",
  reason: "undetermined",
  checked_at: null,
  evidence: "none",
});
export const variantSchema = z.object({
  url: z.string(),
  backup_urls: z.array(z.string()),
  width: z.number().nullable(),
  height: z.number().nullable(),
  codec: z.string().nullable(),
  container: z.string().nullable(),
  bitrate: z.number().nullable(),
  size_bytes: z.number().nullable(),
  fetched_at: z.string(),
  expires_at: z.string().nullable(),
  original: z.boolean().default(false),
});
export const mediaSchema = z.object({
  id: z.string(),
  index: z.number().int(),
  role: z.enum(["image", "video", "live_video"]),
  group_id: z.string().nullable(),
  variants: z.array(variantSchema),
});
export type Variant = z.infer<typeof variantSchema>;
export type Media = z.infer<typeof mediaSchema>;
export const authorSchema = z.object({
  id: z.string().nullable(),
  name: z.string().nullable(),
});
export const summarySchema = z.object({
  ref: refSchema,
  title: z.string().nullable(),
  author: authorSchema,
  type: z.enum(["image", "video", "unknown"]),
  cover_url: z.string().nullable(),
  completeness: z.literal("summary"),
  availability: z.enum(["available", "unavailable", "unknown"]),
  list_context: z
    .object({
      owner_id: z.string(),
      kind: listKindSchema,
      relation_at: z.string().nullable(),
      observed_at: z.string(),
    })
    .optional(),
});
export type Summary = z.infer<typeof summarySchema>;
export const noteSchema = z.object({
  ref: refSchema,
  type: z.enum(["image", "video", "unknown"]),
  title: z.string().nullable(),
  description: z.string().nullable(),
  author: authorSchema,
  published_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  tags: z.array(z.string()),
  stats: z.record(
    z.string(),
    z.object({
      value: z.number().nullable(),
      display: z.string().nullable(),
      approximate: z.boolean(),
    }),
  ),
  media: z.array(mediaSchema),
  fetched_at: z.string(),
  protocol_version: z.string(),
  completeness: z.literal("full"),
});
export type Note = z.infer<typeof noteSchema>;
export type RemotePage = {
  items: Summary[];
  next: string | null;
  hasMore: boolean | null;
  unavailable: number;
  reportedTotal: number | null;
};
export type ListOptions = {
  limit?: number;
  all?: boolean;
  pageSize?: number;
  maxPages?: number;
  cursor?: string;
  type?: "all" | "image" | "video";
  refresh?: boolean;
  sort?: "relevance" | "latest" | "likes";
};
export type PageInfo = {
  next_cursor: string | null;
  has_more: boolean | null;
  exhausted: boolean;
  stop_reason: string;
  order: string;
  consistency: "best_effort";
};
export type ListResult = {
  viewer: { id: string | null; authenticated: boolean };
  target: { id: string; is_self: boolean } | null;
  kind: ListKind | "search";
  access: ListAccess;
  items: Summary[];
  page: PageInfo;
  counts: {
    emitted: number;
    fetched: number;
    duplicates: number;
    filtered: number;
    unavailable: number;
  };
  reported_total: number | null;
  filter_mode: "local" | "remote";
};

export const countSchema = z.object({
  value: z.number().nullable(),
  display: z.string().nullable(),
  approximate: z.boolean(),
});
export const profileSchema = z.object({
  ref: refSchema,
  nickname: z.string().nullable(),
  red_id: z.string().nullable(),
  bio: z.string().nullable(),
  avatar_url: z.string().nullable(),
  profile_url: z.string(),
  is_self: z.boolean(),
  fetched_at: z.string(),
  counts: z.object({
    posts: countSchema,
    followers: countSchema,
    following: countSchema,
    received_likes_and_favorites: countSchema,
  }),
  list_access: z.object({
    posts: accessSchema,
    likes: accessSchema,
    favorites: accessSchema,
  }),
});
export const listResultSchema = z.object({
  viewer: z.object({ id: z.string().nullable(), authenticated: z.boolean() }),
  target: z.object({ id: z.string(), is_self: z.boolean() }).nullable(),
  kind: z.enum(["posts", "likes", "favorites", "search"]),
  access: accessSchema,
  items: z.array(summarySchema),
  page: z.object({
    next_cursor: z.string().nullable(),
    has_more: z.boolean().nullable(),
    exhausted: z.boolean(),
    stop_reason: z.string(),
    order: z.string(),
    consistency: z.literal("best_effort"),
  }),
  counts: z.object({
    emitted: z.number(),
    fetched: z.number(),
    duplicates: z.number(),
    filtered: z.number(),
    unavailable: z.number(),
  }),
  reported_total: z.number().nullable(),
  filter_mode: z.enum(["local", "remote"]),
});

export const downloadItemSchema = z.object({
  note_id: z.string().nullable(),
  media_id: z.string().optional(),
  role: z.string().optional(),
  path: z.string().optional(),
  status: z.enum(["downloaded", "skipped", "failed", "unavailable", "planned"]),
  bytes: z.number().optional(),
  sha256: z.string().optional(),
  quality: z.string().optional(),
  candidates: z.array(z.string()).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  source: z.object({ owner_id: z.string(), kind: z.string() }).optional(),
});
export const downloadResultSchema = z.object({
  items: z.array(downloadItemSchema),
  summary: z.object({
    downloaded: z.number(),
    skipped: z.number(),
    failed: z.number(),
    unavailable: z.number(),
    planned: z.number(),
    notes: z.number(),
  }),
  page: z.unknown().optional(),
});
export const errorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  action_required: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
});
