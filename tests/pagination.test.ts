import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/infrastructure/store.js";
import { paginate, type PagerSpec } from "../src/content/paginator.js";
import { normalizeSummary } from "../src/content/normalize.js";
import { AppError } from "../src/domain/errors.js";
const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0))
    await rm(r, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "xhs-page-test-"));
  roots.push(root);
  return new Store(root, "default");
}
const card = (n: number, type = "normal") =>
  normalizeSummary({
    note_id: n.toString().padStart(24, "0"),
    type,
    display_title: "synthetic",
  })!;
function spec(fetch: PagerSpec["fetch"]): PagerSpec {
  return {
    key: "synthetic-binding",
    viewer: { id: "viewer", authenticated: true },
    target: { id: "owner", is_self: false },
    kind: "favorites",
    fetch,
  };
}
describe("checkpoint pagination", () => {
  it("resumes buffered page items without losing or refetching them", async () => {
    const store = await setup();
    let requests = 0;
    const s = spec(async (cursor) => {
      requests++;
      return cursor === ""
        ? {
            items: [card(1), card(2), card(3)],
            next: "next",
            hasMore: true,
            unavailable: 0,
            reportedTotal: null,
          }
        : {
            items: [card(3), card(4)],
            next: null,
            hasMore: false,
            unavailable: 0,
            reportedTotal: null,
          };
    });
    const first = await paginate(store, s, { limit: 1 });
    expect(first.items.map((x) => x.ref.id)).toEqual([card(1).ref.id]);
    expect(requests).toBe(1);
    const rest = await paginate(store, s, {
      all: true,
      cursor: first.page.next_cursor!,
    });
    expect(rest.items.map((x) => x.ref.id)).toEqual([
      card(2).ref.id,
      card(3).ref.id,
      card(4).ref.id,
    ]);
    expect(rest.counts.duplicates).toBe(1);
    expect(rest.page.exhausted).toBe(true);
    expect(requests).toBe(2);
  });
  it("continues through locally filtered pages and enforces the page budget", async () => {
    const store = await setup();
    let calls = 0;
    const result = await paginate(
      store,
      spec(async () => ({
        items: [card(++calls, calls === 1 ? "normal" : "video")],
        next: String(calls),
        hasMore: true,
        unavailable: 0,
        reportedTotal: null,
      })),
      { type: "video", limit: 1, maxPages: 2 },
    );
    expect(result.items[0]?.type).toBe("video");
    expect(calls).toBe(2);
    expect(result.counts.filtered).toBe(1);
  });
  it("rejects cross-account/target cursors before fetching", async () => {
    const store = await setup();
    const s = spec(async () => ({
      items: [card(1), card(2)],
      next: "next",
      hasMore: true,
      unavailable: 0,
      reportedTotal: null,
    }));
    const first = await paginate(store, s, { limit: 1 });
    let called = false;
    await expect(
      paginate(
        store,
        {
          ...s,
          key: "different-identity",
          fetch: async () => {
            called = true;
            throw new Error();
          },
        },
        { cursor: first.page.next_cursor! },
      ),
    ).rejects.toMatchObject({ code: "CURSOR_CONTEXT_MISMATCH" });
    expect(called).toBe(false);
  });
  it("does not turn denied lists into empty successes and preserves streamed partial results", async () => {
    const store = await setup();
    await expect(
      paginate(
        store,
        spec(async () => {
          throw new AppError("LIST_PRIVATE", "private", 11);
        }),
      ),
    ).rejects.toMatchObject({ code: "LIST_PRIVATE", exitCode: 11 });
    let calls = 0;
    const emitted: string[] = [];
    await expect(
      paginate(
        store,
        spec(async () => {
          if (calls++) throw new AppError("LIST_PRIVATE", "private", 11);
          return {
            items: [card(1)],
            hasMore: true,
            next: "next",
            unavailable: 0,
            reportedTotal: null,
          };
        }),
        { all: true },
        async (item) => {
          emitted.push(item.ref.id);
        },
      ),
    ).rejects.toMatchObject({
      exitCode: 9,
      details: {
        terminal_error: { code: "LIST_PRIVATE", exit_code: 11 },
        partial_result: { counts: { emitted: 1 }, page: { exhausted: false } },
      },
    });
    expect(emitted).toHaveLength(1);
  });
  it("never commits an item when the consumer fails before persisting it", async () => {
    const store = await setup();
    const s = spec(async () => ({
      items: [card(1), card(2)],
      hasMore: false,
      next: null,
      unavailable: 0,
      reportedTotal: null,
    }));
    try {
      await paginate(store, s, { all: true }, async () => {
        throw new AppError("CONSUMER_FAILED", "failed", 8);
      });
    } catch {
      /* Find this test-owned checkpoint without reading real state. */
    }
    const { readdir } = await import("node:fs/promises");
    const token = (await readdir(store.dir))
      .find((x) => x.endsWith(".json"))!
      .replace(".json", "");
    const result = await paginate(store, s, { cursor: token, all: true });
    expect(result.items.map((x) => x.ref.id)).toEqual([
      card(1).ref.id,
      card(2).ref.id,
    ]);
  });
  it("stops a repeated native cursor without declaring exhaustion", async () => {
    const store = await setup();
    let count = 0;
    const result = await paginate(
      store,
      spec(async () => ({
        items: [card(++count)],
        next: "same",
        hasMore: true,
        unavailable: 0,
        reportedTotal: null,
      })),
      { all: true },
    );
    expect(result.page).toMatchObject({
      stop_reason: "repeated_cursor",
      exhausted: false,
    });
    expect(count).toBe(2);
  });
});

it("does not conflate an explicit empty terminal list with an unknown empty page", async () => {
  const store = await setup();
  const allowed = await paginate(
    store,
    spec(async () => ({
      items: [],
      next: null,
      hasMore: false,
      unavailable: 0,
      reportedTotal: null,
    })),
  );
  expect(allowed.access.state).toBe("allowed");
  expect(allowed.page.exhausted).toBe(true);
  const unknown = await paginate(
    store,
    spec(async () => ({
      items: [],
      next: null,
      hasMore: null,
      unavailable: 0,
      reportedTotal: null,
    })),
  );
  expect(unknown.page.exhausted).toBe(false);
  expect(unknown.page.stop_reason).toBe("unknown_pagination");
});
