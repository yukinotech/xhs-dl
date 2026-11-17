import {
  mkdir,
  stat,
  readFile,
  appendFile,
  writeFile,
  lstat,
} from "node:fs/promises";
import { dirname, resolve, relative, extname } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { z } from "zod";
import type { ContentService } from "../content/service.js";
import { hash } from "../content/normalize.js";
import { inspectMedia, variantInfo } from "./media-info.js";
import { refSchema, mediaInfoSchema } from "../domain/content.js";
import type { Ref, Note, Summary, MediaInfo } from "../domain/content.js";
import { AppError } from "../domain/errors.js";
import { planDownload, selectVariant, compareVariants } from "./planner.js";
import { safePath, type Source } from "./template.js";
import {
  transfer,
  transferOptions,
  sha256,
  type TransferProgress,
} from "./transfer.js";
import { checkSignal } from "../infrastructure/timing.js";
export type DownloadProgress = TransferProgress & { path: string };
export type DownloadItem = {
  note_id: string | null;
  media_id?: string;
  role?: string;
  path?: string;
  status: "downloaded" | "skipped" | "failed" | "unavailable" | "planned";
  bytes?: number;
  sha256?: string;
  quality?: string;
  candidates?: string[];
  media_info?: MediaInfo;
  resolution?: Note["resolution"];
  upgraded?: boolean;
  error?: { code: string; message: string };
  source?: Source;
};
export type DownloadResult = {
  items: DownloadItem[];
  summary: {
    downloaded: number;
    skipped: number;
    failed: number;
    unavailable: number;
    planned: number;
    notes: number;
  };
  page?: unknown;
};
const entrySchema = z.object({
  key: z.string(),
  path: z.string(),
  bytes: z.number(),
  sha256: z.string(),
  note_id: z.string(),
  media_id: z.string(),
  role: z.string(),
  quality: z.string(),
  completed_at: z.string(),
  media_info: mediaInfoSchema.optional(),
  selection: z
    .object({
      width: z.number().nullable(),
      height: z.number().nullable(),
      bitrate: z.number().nullable(),
      original: z.boolean(),
      scene: z.enum(["detail", "preview", "unknown"]).optional(),
    })
    .optional(),
  source: z.object({ owner_id: z.string(), kind: z.string() }).optional(),
});
type Entry = z.infer<typeof entrySchema>;
const manifestSchema = z.object({
  version: z.literal(1),
  created_at: z.string(),
  ref: refSchema,
  items: z.array(z.record(z.string(), z.unknown())),
});
async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
function redactInfo(note: Note) {
  const copy = structuredClone(note);
  delete copy.ref.xsec_token;
  if (copy.ref.url) {
    const url = new URL(copy.ref.url);
    url.search = "";
    copy.ref.url = url.toString();
  }
  for (const m of copy.media)
    for (const v of m.variants) {
      v.url = v.url.split("?")[0]!;
      v.backup_urls = v.backup_urls.map((x) => x.split("?")[0]!);
    }
  return copy;
}
export class DownloadEngine {
  readonly result: DownloadResult = {
    items: [],
    summary: {
      downloaded: 0,
      skipped: 0,
      failed: 0,
      unavailable: 0,
      planned: 0,
      notes: 0,
    },
  };
  private settings;
  private transferSettings;
  private archive: string;
  private retained: boolean;
  private firstFailure: AppError | undefined;
  private emitted = 0;
  constructor(
    readonly content: ContentService,
    readonly onItem?: (item: DownloadItem) => Promise<void>,
    retain = true,
    private readonly transferFn = transfer,
    private readonly onProgress?: (event: DownloadProgress) => void,
  ) {
    this.settings = content.config.download;
    this.transferSettings = transferOptions(content.config, content.signal);
    this.archive = resolve(
      this.settings.archive ??
        resolve(content.store.dir, "download-archive.jsonl"),
    );
    this.retained = retain;
  }
  private async emit(item: DownloadItem) {
    this.emitted++;
    this.result.summary[item.status]++;
    if (this.retained) this.result.items.push(item);
    await this.onItem?.(item);
  }
  private async archiveEntry(key: string) {
    let text: string;
    try {
      text = await readFile(this.archive, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    let found: Entry | null = null;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const item = entrySchema.safeParse(JSON.parse(line));
        if (item.success && item.data.key === key) found = item.data;
      } catch {
        /* Interrupted append is not a complete record. */
      }
    }
    return found;
  }
  private async saveArchive(entry: Entry) {
    await mkdir(dirname(this.archive), { recursive: true, mode: 0o700 });
    if (
      (await exists(this.archive)) &&
      (await lstat(this.archive)).isSymbolicLink()
    )
      throw new AppError("UNSAFE_PATH", "归档路径不能是符号链接。", 8);
    const release = await lockfile.lock(this.archive, {
      realpath: false,
      retries: { retries: 10, minTimeout: 20, maxTimeout: 100 },
      stale: 30000,
    });
    try {
      let prefix = "";
      try {
        const existing = await readFile(this.archive);
        if (existing.length && existing.at(-1) !== 10) prefix = "\n";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await appendFile(this.archive, prefix + JSON.stringify(entry) + "\n", {
        mode: 0o600,
      });
    } finally {
      await release();
    }
  }
  private async verified(entry: Entry | null) {
    if (!entry) return false;
    try {
      if ((await lstat(entry.path)).isSymbolicLink()) return false;
      return (
        (await stat(entry.path)).size === entry.bytes &&
        (await sha256(entry.path)) === entry.sha256
      );
    } catch {
      return false;
    }
  }
  async note(ref: Ref, source?: Source) {
    checkSignal(this.content.signal);
    this.result.summary.notes++;
    const viewer = await this.content.identity();
    const key = hash({
      viewer: viewer.id,
      note: ref.id,
      root: resolve(this.settings.paths),
      template: this.settings.template,
      quality: this.settings.quality,
      ...(this.settings.video_codec !== "auto"
        ? { video_codec: this.settings.video_codec }
        : {}),
      media: this.settings.media,
      source,
    });
    const name = "job_" + key + ".json";
    await this.content.store.initialize();
    let release: (() => Promise<void>) | undefined;
    if (!this.settings.dry_run) {
      try {
        release = await lockfile.lock(resolve(this.content.store.dir, name), {
          realpath: false,
          stale: 30000,
          retries: 0,
        });
      } catch {
        throw new AppError("SESSION_BUSY", "同一个下载任务正在运行。", 6);
      }
    }
    try {
      const previous = await this.content.store.read(name, manifestSchema);
      const createdAt = previous?.created_at ?? new Date().toISOString();
      let note = await this.content.note(ref);
      const plan = await planDownload(note, this.settings, createdAt, source);
      const manifest = {
        version: 1 as const,
        created_at: createdAt,
        ref,
        source,
        items: [] as Array<Record<string, unknown>>,
      };
      let manifestQueue = Promise.resolve();
      const saveManifest = () =>
        (manifestQueue = manifestQueue.then(() =>
          this.content.store.write(name, manifest),
        ));
      const record = async (item: DownloadItem) => {
        manifest.items.push(item as unknown as Record<string, unknown>);
        await saveManifest();
        await this.emit(item);
      };
      let noteFailed = false;
      if (!this.settings.dry_run) await saveManifest();
      const work = async (index: number) => {
        const media = plan.media[index]!;
        let target = media.path;
        let fileRelease: (() => Promise<void>) | undefined;
        if (this.settings.dry_run) {
          await this.emit({
            note_id: ref.id,
            media_id: media.media.id,
            role: media.media.role,
            path: target,
            status: "planned",
            quality: media.quality,
            candidates: media.candidates,
            media_info: variantInfo(media.variant),
            resolution: note.resolution,
            source,
          });
          return;
        }
        try {
          await safePath(
            this.settings.paths,
            relative(resolve(this.settings.paths), target),
            true,
          );
          // The final path and associated partial files all belong to this media lock.
          fileRelease = await lockfile.lock(target, {
            realpath: false,
            stale: 30000,
            retries: 0,
          });
          for (const suffix of ["", ".part", ".part.json"])
            await safePath(
              this.settings.paths,
              relative(resolve(this.settings.paths), target + suffix),
            );
          const archiveKey = hash({
            viewer: viewer.id,
            note: ref.id,
            media: media.media.id,
            role: media.media.role,
            quality: this.settings.quality,
            ...(media.media.role !== "image" &&
            this.settings.video_codec !== "auto"
              ? { video_codec: this.settings.video_codec }
              : {}),
            path: target,
          });
          const archived = await this.archiveEntry(archiveKey);
          const verified = await this.verified(archived);
          const upgrading =
            verified &&
            this.settings.quality === "best" &&
            !!archived &&
            (archived.selection
              ? compareVariants(media.variant, {
                  ...media.variant,
                  ...archived.selection,
                }) < 0
              : archived.quality !== "original" &&
                (media.variant.original ||
                  (media.variant.height ?? 0) > Number(archived.quality)));
          if (verified && !upgrading) {
            if (source) await this.saveArchive({ ...archived!, source });
            await record({
              note_id: ref.id,
              media_id: media.media.id,
              role: media.media.role,
              path: archived!.path,
              status: "skipped",
              bytes: archived!.bytes,
              sha256: archived!.sha256,
              quality: archived!.quality,
              media_info:
                archived!.media_info ?? (await inspectMedia(archived!.path)),
              resolution: note.resolution,
              source,
            });
            return;
          }
          if (!upgrading && (await exists(target))) {
            if (this.settings.on_exists === "skip") {
              await record({
                note_id: ref.id,
                media_id: media.media.id,
                role: media.media.role,
                path: target,
                status: "skipped",
                quality: media.quality,
                media_info: await inspectMedia(target),
                resolution: note.resolution,
                source,
              });
              return;
            }
            if (this.settings.on_exists === "error")
              throw new AppError(
                "OUTPUT_COLLISION",
                "目标路径已存在且未通过下载归档核对。",
                8,
                { path: target },
              );
            if (this.settings.on_exists === "rename") {
              const ext = extname(target),
                stem = target.slice(0, target.length - ext.length);
              let count = 1;
              while (await exists(target)) {
                if (count > 1000)
                  throw new AppError(
                    "OUTPUT_COLLISION",
                    "无法找到未占用的目标路径。",
                    8,
                  );
                target = `${stem} (${count++})${ext}`;
              }
              await fileRelease();
              fileRelease = await lockfile.lock(target, {
                realpath: false,
                stale: 30000,
                retries: 0,
              });
            }
          }
          let downloaded;
          try {
            downloaded = await this.transferFn(media.candidates, target, {
              ...this.transferSettings,
              overwrite: !!upgrading || this.transferSettings.overwrite,
              progress: this.onProgress
                ? (event) => this.onProgress!({ ...event, path: target })
                : undefined,
            });
          } catch (error) {
            if (
              !(error instanceof AppError) ||
              error.code !== "MEDIA_URL_EXPIRED"
            )
              throw error;
            note = await this.content.note(ref);
            const refreshed = note.media.find(
              (x) => x.id === media.media.id && x.role === media.media.role,
            );
            if (!refreshed)
              throw new AppError("MEDIA_CHANGED", "刷新后媒体身份已改变。", 7);
            const variant = selectVariant(
              refreshed,
              this.settings.quality,
              this.settings.allow_quality_fallback,
              this.settings.video_codec,
            );
            media.variant = variant;
            media.quality = variant.original
              ? "original"
              : String(variant.height ?? "unknown");
            downloaded = await this.transferFn(
              [variant.url, ...variant.backup_urls],
              target,
              {
                ...this.transferSettings,
                overwrite: !!upgrading || this.transferSettings.overwrite,
                progress: this.onProgress
                  ? (event) => this.onProgress!({ ...event, path: target })
                  : undefined,
              },
            );
          }
          const inspected = await inspectMedia(target);
          const mediaInfo = inspected.container
            ? inspected
            : variantInfo(media.variant);
          const entry: Entry = {
            key: archiveKey,
            path: target,
            bytes: downloaded.bytes,
            sha256: downloaded.sha256,
            note_id: ref.id,
            media_id: media.media.id,
            role: media.media.role,
            quality: media.quality,
            completed_at: new Date().toISOString(),
            media_info: mediaInfo,
            selection: {
              width: media.variant.width,
              height: media.variant.height,
              bitrate: media.variant.bitrate,
              original: media.variant.original,
              scene: media.variant.scene,
            },
            ...(source ? { source } : {}),
          };
          await this.saveArchive(entry);
          const item: DownloadItem = {
            note_id: ref.id,
            media_id: media.media.id,
            role: media.media.role,
            path: target,
            status: "downloaded",
            bytes: entry.bytes,
            sha256: entry.sha256,
            quality: media.quality,
            media_info: mediaInfo,
            resolution: note.resolution,
            upgraded: !!upgrading,
            source,
          };
          await record(item);
        } catch (error) {
          noteFailed = true;
          checkSignal(this.content.signal);
          const e =
            error instanceof AppError
              ? error
              : new AppError("DOWNLOAD_FAILED", "下载或写盘失败。", 8);
          this.firstFailure ??= e;
          await record({
            note_id: ref.id,
            media_id: media.media.id,
            role: media.media.role,
            path: target,
            status: "failed",
            error: { code: e.code, message: e.message },
            source,
          });
        } finally {
          await fileRelease?.();
        }
      };
      let next = 0;
      const outcomes = await Promise.allSettled(
        Array.from(
          { length: Math.min(this.settings.concurrency, plan.media.length) },
          async () => {
            while (next < plan.media.length) await work(next++);
          },
        ),
      );
      const rejected = outcomes.find((x) => x.status === "rejected");
      if (rejected?.status === "rejected") throw rejected.reason;
      if (!this.settings.dry_run && !noteFailed) {
        const base = plan.media[0]?.path;
        if (base) {
          for (const [enabled, suffix, text] of [
            [
              this.settings.write_info_json,
              ".info.json",
              JSON.stringify(redactInfo(note), null, 2) + "\n",
            ],
            [
              this.settings.write_description,
              ".description.txt",
              note.description ?? "",
            ],
          ] as const) {
            if (!enabled) continue;
            const target = await safePath(
              this.settings.paths,
              relative(resolve(this.settings.paths), base + suffix),
              true,
            );
            const temp = target + "." + randomUUID() + ".tmp";
            await writeFile(temp, text, { mode: 0o600, flag: "wx" });
            const { rename } = await import("node:fs/promises");
            await rename(temp, target);
          }
        }
      }
    } catch (error) {
      checkSignal(this.content.signal);
      if (error instanceof AppError && error.exitCode === 11) throw error;
      const e =
        error instanceof AppError
          ? error
          : new AppError("DOWNLOAD_FAILED", "帖子下载失败。", 7);
      this.firstFailure ??= e;
      await this.emit({
        note_id: ref.id,
        status: "failed",
        error: { code: e.code, message: e.message },
        source,
      });
    } finally {
      await release?.();
    }
  }
  async invalidInput(error: unknown, index: number) {
    const e =
      error instanceof AppError
        ? error
        : new AppError("INVALID_INPUT", "无法解析批量输入。", 2);
    this.result.summary.notes++;
    await this.emit({
      note_id: null,
      status: "failed",
      error: { code: e.code, message: `第 ${index} 项：${e.message}` },
    });
  }
  async listItem(item: Summary) {
    const source = item.list_context
      ? { owner_id: item.list_context.owner_id, kind: item.list_context.kind }
      : undefined;
    if (item.availability === "unavailable") {
      await this.emit({ note_id: item.ref.id, status: "unavailable", source });
      return;
    }
    await this.note(item.ref, source);
  }
  finish() {
    if (
      this.firstFailure &&
      this.result.summary.notes === 1 &&
      this.emitted === 1 &&
      this.result.summary.failed === 1
    ) {
      const e = this.firstFailure;
      throw new AppError(
        e.code,
        e.message,
        e.exitCode,
        { ...e.details, partial_result: this.result },
        e.retryable,
        e.actionRequired,
      );
    }
    if (this.result.summary.failed)
      throw new AppError(
        "PARTIAL_FAILURE",
        "部分媒体下载失败，已完成文件保留。",
        9,
        { partial_result: this.result },
      );
    return this.result;
  }
}
