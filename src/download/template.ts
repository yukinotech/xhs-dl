import { isAbsolute, resolve, relative, sep } from "node:path";
import { lstat, realpath, mkdir } from "node:fs/promises";
import { AppError } from "../domain/errors.js";
import type { Note, Media, Variant } from "../domain/content.js";
const fields = new Set([
  "note.id",
  "note.title",
  "title",
  "note.type",
  "author.id",
  "author.name",
  "published_at",
  "downloaded_at",
  "index",
  "media.id",
  "media.role",
  "ext",
  "source.owner_id",
  "source.kind",
]);
export function component(value: string) {
  let s = value
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\p{Cc}]/gu, "_")
    .replace(/[. ]+$/g, "");
  if (s === "." || s === ".." || !s) s = "_";
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(s)) s = "_" + s;
  const characters = Array.from(s);
  while (Buffer.byteLength(characters.join("")) > 160) characters.pop();
  s = characters.join("");
  return s;
}
export function formatDate(value: string, format: string, zone: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new AppError("TEMPLATE_VALUE_MISSING", "日期字段不可用。", 2);
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const map: Record<string, string> = {
    Y: values.year!,
    m: values.month!,
    d: values.day!,
    H: values.hour!,
    M: values.minute!,
    S: values.second!,
    "%": "%",
  };
  return format.replace(/%./g, (token) => {
    if (!(token[1]! in map))
      throw new AppError(
        "INVALID_TEMPLATE",
        "日期仅支持 %Y %m %d %H %M %S %%。",
        2,
      );
    return map[token[1]!]!;
  });
}
export function validateTemplate(template: string) {
  if (
    !template ||
    isAbsolute(template) ||
    /^[a-zA-Z]:|^\\|(?:^|[/\\])\.\.(?:[/\\]|$)/.test(template)
  )
    throw new AppError(
      "INVALID_TEMPLATE",
      "文件名模板必须是下载根目录内的相对路径。",
      2,
    );
  for (const m of template.matchAll(/\{([^{}]+)\}/g)) {
    const field = m[1]!.split(/[|:]/)[0]!;
    if (!fields.has(field))
      throw new AppError("INVALID_TEMPLATE", `未知模板字段：${field}`, 2);
  }
  if (/[{}]/.test(template.replace(/\{[^{}]+\}/g, "")))
    throw new AppError("INVALID_TEMPLATE", "模板括号不完整。", 2);
}
export function extension(variant: Variant, media: Media) {
  let value = variant.container?.toLowerCase();
  if (value === "jpeg") value = "jpg";
  if (
    value &&
    ["jpg", "png", "webp", "avif", "mp4", "mov", "webm", "heic"].includes(value)
  )
    return value;
  try {
    const url = new URL(variant.url);
    const match = url.pathname.match(/\.([a-z0-9]{2,5})$/i);
    if (
      match &&
      [
        "jpg",
        "jpeg",
        "png",
        "webp",
        "avif",
        "mp4",
        "mov",
        "webm",
        "heic",
      ].includes(match[1]!.toLowerCase())
    )
      return match[1]!.toLowerCase().replace("jpeg", "jpg");
    if (/format\/(png|jpg|webp|avif)/.test(url.href))
      return url.href.match(/format\/(png|jpg|webp|avif)/)![1]!;
  } catch {
    /* validated by transport later */
  }
  return media.role === "image" ? "jpg" : "mp4";
}
export type Source = { owner_id: string; kind: string };
export function renderTemplate(
  template: string,
  note: Note,
  media: Media,
  variant: Variant,
  date: string,
  zone: string,
  source?: Source,
) {
  validateTemplate(template);
  const values: Record<string, string | number | null | undefined> = {
    "note.id": note.ref.id,
    "note.title": note.title,
    title: note.title,
    "note.type": note.type,
    "author.id": note.author.id,
    "author.name": note.author.name,
    published_at: note.published_at,
    downloaded_at: date,
    index: media.index,
    "media.id": media.id,
    "media.role": media.role,
    ext: extension(variant, media),
    "source.owner_id": source?.owner_id,
    "source.kind": source?.kind,
  };
  const rendered = template.replace(
    /\{([^{}]+)\}/g,
    (_all, expression: string) => {
      const sepIndex = expression.indexOf(":"),
        left = sepIndex < 0 ? expression : expression.slice(0, sepIndex),
        format = sepIndex < 0 ? undefined : expression.slice(sepIndex + 1),
        [field, fallback] = left.split("|");
      let value = values[field!];
      if (value === null || value === undefined || value === "")
        value = fallback;
      if (value === null || value === undefined)
        throw new AppError(
          "TEMPLATE_VALUE_MISSING",
          `模板字段不可用：${field}，可用 |fallback 指定备用值。`,
          2,
        );
      if (format) {
        if (["published_at", "downloaded_at"].includes(field!))
          value = formatDate(String(value), format, zone);
        else if (field === "index" && /^0?\d{1,2}$/.test(format))
          value = String(value).padStart(Number(format), "0");
        else
          throw new AppError(
            "INVALID_TEMPLATE",
            `字段不支持该格式：${field}`,
            2,
          );
      }
      return component(String(value));
    },
  );
  return rendered.replaceAll("\\", "/").split("/").map(component).join("/");
}
export function within(root: string, target: string) {
  const rel = relative(root, target);
  return (
    rel === "" ||
    (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel))
  );
}
export async function safePath(
  rootInput: string,
  relativePath: string,
  create = false,
) {
  const root = resolve(rootInput),
    target = resolve(root, relativePath);
  if (!within(root, target))
    throw new AppError("INVALID_TEMPLATE", "目标路径逃出下载根目录。", 2);
  let current = root;
  const pieces = relative(root, target).split(sep);
  const candidates = [
    root,
    ...pieces.map((piece) => {
      current = resolve(current, piece);
      return current;
    }),
  ];
  for (const path of candidates) {
    try {
      if ((await lstat(path)).isSymbolicLink())
        throw new AppError(
          "UNSAFE_PATH",
          "下载路径包含符号链接，已拒绝写入。",
          8,
        );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  if (create) {
    await mkdir(resolve(target, ".."), { recursive: true });
    const actualRoot = await realpath(root),
      parent = await realpath(resolve(target, ".."));
    if (!within(actualRoot, parent))
      throw new AppError("UNSAFE_PATH", "目录解析后逃出下载根目录。", 8);
  }
  return target;
}
