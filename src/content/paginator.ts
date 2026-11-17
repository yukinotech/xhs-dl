import { randomUUID } from "node:crypto";
import { z } from "zod";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import type { Store } from "../infrastructure/store.js";
import {
  summarySchema,
  accessSchema,
  unknownAccess,
  type ListOptions,
  type RemotePage,
  type Summary,
  type ListResult,
} from "../domain/content.js";
import { AppError } from "../domain/errors.js";
const checkpointSchema = z.object({
  version: z.literal(1),
  key: z.string(),
  created_at: z.number(),
  expires_at: z.number(),
  pending: z.array(summarySchema),
  seen: z.array(z.string()),
  native: z.string().nullable(),
  has_more: z.boolean().nullable(),
  access: accessSchema,
  no_progress: z.number(),
  pages: z.number(),
  halt_reason: z.string().optional(),
  context: z.record(z.string(), z.string()),
});
export type Checkpoint = z.infer<typeof checkpointSchema>;
export type PagerSpec = {
  key: string;
  viewer: ListResult["viewer"];
  target: ListResult["target"];
  kind: ListResult["kind"];
  context?: Record<string, string>;
  fetch: (
    cursor: string,
    size: number,
    context: Record<string, string>,
  ) => Promise<RemotePage>;
  observe?: (access: ListResult["access"]) => Promise<void>;
};
export async function paginate(
  store: Store,
  spec: PagerSpec,
  options: ListOptions = {},
  onItem?: (item: Summary) => Promise<void>,
  retain = true,
): Promise<ListResult> {
  if (options.all && options.limit !== undefined)
    throw new AppError("INVALID_ARGUMENT", "--all 与 --limit 互斥。", 2);
  if (options.refresh && options.cursor)
    throw new AppError("INVALID_ARGUMENT", "--refresh 与 --cursor 互斥。", 2);
  for (const [name, n] of Object.entries({
    limit: options.limit,
    pageSize: options.pageSize,
    maxPages: options.maxPages,
  })) {
    if (n !== undefined && (!Number.isInteger(n) || n < 1))
      throw new AppError("INVALID_ARGUMENT", `${name} 必须为正整数。`, 2);
  }
  const size = options.pageSize ?? 20;
  if (size > 30)
    throw new AppError("INVALID_ARGUMENT", "page-size 最大为 30。", 2);
  const limit = options.all ? Infinity : (options.limit ?? 20),
    maxPages = options.maxPages ?? 100;
  const id = options.cursor ?? "cp_" + randomUUID();
  if (!/^cp_[0-9a-f-]{36}$/.test(id))
    throw new AppError("CURSOR_EXPIRED", "cursor 无效。", 2);
  await store.initialize();
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(join(store.dir, id), {
      realpath: false,
      stale: 30000,
      retries: 0,
    });
  } catch {
    throw new AppError("SESSION_BUSY", "该分页状态正由另一个查询使用。", 6);
  }
  try {
    let cp: Checkpoint;
    if (options.cursor) {
      let value: Checkpoint | null;
      try {
        value = await store.read(id + ".json", checkpointSchema);
      } catch {
        throw new AppError("CURSOR_EXPIRED", "分页状态损坏或版本不兼容。", 2);
      }
      if (!value || value.expires_at < Date.now())
        throw new AppError("CURSOR_EXPIRED", "分页状态不存在或已到期。", 2);
      if (value.key !== spec.key)
        throw new AppError(
          "CURSOR_CONTEXT_MISMATCH",
          "cursor 的账号、目标、类别或筛选条件不匹配。",
          2,
        );
      cp = value;
    } else
      cp = {
        version: 1,
        key: spec.key,
        created_at: Date.now(),
        expires_at: Date.now() + 86400000,
        pending: [],
        seen: [],
        native: "",
        has_more: null,
        access: unknownAccess(),
        no_progress: 0,
        pages: 0,
        context: spec.context ?? {},
      };
    const result: ListResult = {
      viewer: spec.viewer,
      target: spec.target,
      kind: spec.kind,
      access: cp.access,
      items: [],
      page: {
        next_cursor: id,
        has_more: cp.has_more,
        exhausted: false,
        stop_reason: "limit",
        order:
          spec.kind === "search"
            ? (options.sort ?? "relevance")
            : "platform_default",
        consistency: "best_effort",
      },
      counts: {
        emitted: 0,
        fetched: 0,
        duplicates: 0,
        filtered: 0,
        unavailable: 0,
      },
      reported_total: null,
      filter_mode: spec.kind === "search" ? "remote" : "local",
    };
    let fetchedPages = 0;
    const seen = new Set(cp.seen);
    const save = () => store.write(id + ".json", cp);
    await save();
    const stop = (reason: string, exhausted = false) => {
      result.page = {
        ...result.page,
        has_more: cp.pending.length ? true : cp.has_more,
        exhausted,
        stop_reason: reason,
        next_cursor: exhausted ? null : id,
      };
      result.access = cp.access;
      return result;
    };
    try {
      while (result.counts.emitted < limit) {
        while (cp.pending.length && result.counts.emitted < limit) {
          const item = cp.pending[0]!;
          if (seen.has(item.ref.id)) {
            result.counts.duplicates++;
            cp.pending.shift();
            await save();
            continue;
          }
          if (
            options.type &&
            options.type !== "all" &&
            item.type !== options.type
          ) {
            result.counts.filtered++;
            seen.add(item.ref.id);
            cp.seen.push(item.ref.id);
            cp.pending.shift();
            await save();
            continue;
          }
          if (onItem) await onItem(item);
          if (retain) result.items.push(item);
          result.counts.emitted++;
          if (item.availability === "unavailable") result.counts.unavailable++;
          seen.add(item.ref.id);
          cp.seen.push(item.ref.id);
          cp.pending.shift();
          await save();
        }
        if (cp.pending.length) return stop("limit");
        if (cp.has_more === false) return stop("exhausted", true);
        if (cp.pages > 0 && cp.native === null)
          return stop(cp.halt_reason ?? "unknown_pagination");
        if (fetchedPages >= maxPages) return stop("max_pages");
        if (cp.no_progress >= 3) return stop("no_progress");
        const previous = cp.native;
        const page = await spec.fetch(cp.native ?? "", size, cp.context);
        fetchedPages++;
        cp.pages++;
        result.counts.fetched += page.items.length + page.unavailable;
        result.counts.unavailable += page.unavailable;
        result.reported_total = page.reportedTotal;
        cp.access = {
          state: "allowed",
          reason: spec.target?.is_self ? "self" : "api_allowed",
          checked_at: new Date().toISOString(),
          evidence: "api_response",
        };
        result.access = cp.access;
        await spec.observe?.(cp.access);
        cp.pending = page.items;
        cp.native = page.next;
        cp.has_more = page.hasMore;
        cp.no_progress = page.items.some((x) => !seen.has(x.ref.id))
          ? 0
          : cp.no_progress + 1;
        if (
          previous !== "" &&
          previous !== null &&
          page.next === previous &&
          page.hasMore !== false
        ) {
          cp.native = null;
          cp.halt_reason = "repeated_cursor";
        }
        await save();
      }
      if (!cp.pending.length && cp.has_more === false)
        return stop("exhausted", true);
      return stop("limit");
    } catch (error) {
      await save();
      if (error instanceof AppError && error.exitCode === 11) {
        cp.access = {
          state: "denied",
          reason: error.code === "LIST_PRIVATE" ? "private" : "forbidden",
          checked_at: new Date().toISOString(),
          evidence: "api_response",
        };
        await spec.observe?.(cp.access);
        await save();
      }
      stop(
        error instanceof AppError && error.exitCode === 11
          ? "permission_changed"
          : "error",
      );
      if (result.counts.emitted) {
        const e =
          error instanceof AppError
            ? error
            : new AppError("INTERNAL_ERROR", "分页处理失败。", 1);
        throw new AppError(
          "PARTIAL_FAILURE",
          "查询中途停止，已获取条目保留。",
          9,
          {
            terminal_error: {
              code: e.code,
              exit_code: e.exitCode,
              details: e.details,
            },
            partial_result: result,
          },
        );
      }
      throw error;
    }
  } finally {
    await release();
  }
}
