import type { Note, Media, Variant } from "../domain/content.js";
import type { Config } from "../config/config.js";
import { AppError } from "../domain/errors.js";
import {
  renderTemplate,
  safePath,
  validateTemplate,
  type Source,
} from "./template.js";
export type PlannedMedia = {
  media: Media;
  variant: Variant;
  path: string;
  candidates: string[];
  quality: string;
};
export type DownloadPlan = {
  note_id: string;
  created_at: string;
  source?: Source;
  media: PlannedMedia[];
  warnings: string[];
};
export function selectVariant(media: Media, quality: string, fallback = false) {
  const variants = [...media.variants].sort(
    (a, b) =>
      Number(b.original) - Number(a.original) ||
      (b.height ?? 0) - (a.height ?? 0) ||
      (b.bitrate ?? 0) - (a.bitrate ?? 0) ||
      (b.width ?? 0) - (a.width ?? 0),
  );
  let selected: Variant | undefined;
  if (quality === "best") selected = variants[0];
  else if (quality === "original") selected = variants.find((x) => x.original);
  else selected = variants.find((x) => x.height === Number(quality));
  if (!selected && fallback) selected = variants[0];
  if (!selected)
    throw new AppError(
      "QUALITY_UNAVAILABLE",
      `媒体 ${media.id} 没有所需清晰度 ${quality}。`,
      7,
    );
  return selected;
}
export async function planDownload(
  note: Note,
  settings: Config["download"],
  createdAt = new Date().toISOString(),
  source?: Source,
): Promise<DownloadPlan> {
  validateTemplate(settings.template);
  const paths = new Set<string>(),
    media: PlannedMedia[] = [];
  const chosen = note.media.filter(
    (m) =>
      settings.media === "all" ||
      (settings.media === "images" && m.role === "image") ||
      (settings.media === "videos" && m.role !== "image") ||
      (settings.media === "live" &&
        m.group_id !== null &&
        note.media.some(
          (x) => x.group_id === m.group_id && x.role === "live_video",
        )),
  );
  if (!chosen.length)
    throw new AppError(
      "MEDIA_UNAVAILABLE",
      "帖子没有符合 media 选项的内容。",
      7,
    );
  for (const item of chosen) {
    const variant = selectVariant(
      item,
      settings.quality,
      settings.allow_quality_fallback,
    );
    const name = renderTemplate(
      settings.template,
      note,
      item,
      variant,
      createdAt,
      settings.timezone,
      source,
    );
    const path = await safePath(settings.paths, name);
    if (paths.has(path))
      throw new AppError(
        "OUTPUT_COLLISION",
        "同一帖子有多个媒体映射到同一路径；请加入 index 或 media.role。",
        2,
        { path },
      );
    paths.add(path);
    media.push({
      media: item,
      variant,
      path,
      candidates: [...new Set([variant.url, ...variant.backup_urls])],
      quality: variant.original
        ? "original"
        : String(variant.height ?? "unknown"),
    });
  }
  return {
    note_id: note.ref.id,
    created_at: createdAt,
    ...(source ? { source } : {}),
    media,
    warnings: [],
  };
}
