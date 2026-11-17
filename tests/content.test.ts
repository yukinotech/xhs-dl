import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeNote,
  normalizeSummary,
  normalizePage,
} from "../src/content/normalize.js";
import { noteFromHtml } from "../src/content/ssr.js";
import { resolveRef, contentUrl } from "../src/content/links.js";
import {
  renderTemplate,
  safePath,
  validateTemplate,
} from "../src/download/template.js";
import { planDownload } from "../src/download/planner.js";
import { configSchema } from "../src/config/config.js";
const id = "1".repeat(24),
  ref = { id, xsec_token: "synthetic-token" },
  now = "2026-01-02T03:04:05Z";
export function syntheticNote() {
  return normalizeNote(
    {
      note_id: id,
      type: "normal",
      title: "a/b:caption",
      desc: "合成正文",
      time: 1700000000000,
      user: { user_id: "2".repeat(24), nickname: "合成作者" },
      image_list: [
        {
          file_id: "first",
          width: 10,
          height: 20,
          url_default: "https://sns-img.xhscdn.com/synthetic.jpg",
          stream: {
            futureCodec: [
              {
                master_url: "https://sns-video.xhscdn.com/synthetic.mp4",
                height: 1080,
                width: 1920,
                backup_urls: ["https://sns-video-bd.xhscdn.com/synthetic.mp4"],
              },
            ],
          },
          live_photo: true,
        },
        {
          file_id: "second",
          url_default: "https://sns-img.xhscdn.com/other.png",
        },
      ],
    },
    ref,
    now,
  );
}
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
describe("content normalization", () => {
  it("preserves graph order and Live Photo identity without turning summaries into full details", () => {
    const note = syntheticNote();
    expect(note.media.map((x) => x.role)).toEqual([
      "image",
      "live_video",
      "image",
    ]);
    expect(note.media[0]!.group_id).toBe(note.media[1]!.group_id);
    expect(note.media[1]!.variants[0]!.backup_urls).toHaveLength(1);
    const card = normalizeSummary(
      {
        note_id: id,
        type: "normal",
        cover: { url_default: "https://example.invalid/cover.jpg" },
      },
      { id: "owner", kind: "favorites" },
    );
    expect(card?.completeness).toBe("summary");
    expect(card).not.toHaveProperty("media");
    expect(card?.list_context?.owner_id).toBe("owner");
  });
  it("dynamically reads video codec buckets and does not invent a source video", () => {
    const note = normalizeNote(
      {
        note_id: id,
        type: "video",
        image_list: [{ url_default: "https://example.invalid/cover.jpg" }],
        video: {
          media: {
            stream: {
              unknownCodec: [
                {
                  master_url: "https://sns-video.xhscdn.com/video.mp4",
                  height: 2160,
                  avg_bitrate: 5000,
                },
              ],
            },
          },
        },
      },
      ref,
    );
    expect(note.media).toHaveLength(1);
    expect(note.media[0]!.variants[0]).toMatchObject({
      height: 2160,
      original: false,
    });
  });
  it("keeps an actual terminal page even with no cursor; missing has_more stays unknown", () => {
    expect(
      normalizePage(
        { notes: [{ note_id: id, type: "normal" }], has_more: false },
        { id: "owner", kind: "posts" },
      ),
    ).toMatchObject({ hasMore: false, next: null, items: [{ ref: { id } }] });
    expect(
      normalizePage({ notes: [] }, { id: "owner", kind: "likes" }).hasMore,
    ).toBeNull();
  });
  it("parses static SSR state including undefined, rejects executable expressions", () => {
    const html = `<script>window.__INITIAL_STATE__={note:{noteDetailMap:{'${id}':{note:{noteId:'${id}',type:'normal',desc:undefined}}}}};</script>`;
    expect(noteFromHtml(html, id)).toMatchObject({ noteId: id, desc: null });
    expect(() =>
      noteFromHtml(
        `<script>window.__INITIAL_STATE__=(globalThis.attacked=true)</script>`,
        id,
      ),
    ).toThrow();
    expect((globalThis as Record<string, unknown>).attacked).toBeUndefined();
  });
});
describe("links and safe output templates", () => {
  it("preserves share parameters and prevents arbitrary URL fetches", async () => {
    const value = await resolveRef(
      "分享：https://www.xiaohongshu.com/explore/" +
        id +
        "?xsec_token=abc%2Bdef&xsec_source=pc_user",
      "note",
    );
    expect(value).toMatchObject({
      id,
      xsec_token: "abc+def",
      xsec_source: "pc_user",
    });
    for (const url of [
      "http://localhost/x",
      "file:///etc/passwd",
      "https://www.xiaohongshu.com.evil.invalid/explore/" + id,
      "https://user:password@www.xiaohongshu.com/explore/" + id,
    ])
      expect(() => contentUrl(url)).toThrow();
  });
  it("formats timestamp, index and fallback while sanitizing variable slashes", () => {
    const note = syntheticNote(),
      media = note.media[0]!,
      variant = media.variants[0]!;
    expect(
      renderTemplate(
        "{downloaded_at:%Y%m%d%H%M%S}/{title}/{index:03}.{ext}",
        note,
        media,
        variant,
        now,
        "Asia/Shanghai",
      ),
    ).toBe("20260102110405/a_b_caption/001.jpg");
    expect(
      renderTemplate(
        "{source.kind|direct}/{index}.{ext}",
        note,
        media,
        variant,
        now,
        "UTC",
      ),
    ).toBe("direct/1.jpg");
    expect(() => validateTemplate("../{note.id}")).toThrow();
    expect(() => validateTemplate("{unknown}")).toThrow();
  });
  it("rejects ambiguous Live Photo paths and supports grouped roles", async () => {
    const config = configSchema.parse({
      download: { paths: "/tmp/synthetic-plan", template: "{index}.{ext}" },
    });
    const note = syntheticNote();
    note.media[1]!.variants[0]!.container = "jpg";
    await expect(planDownload(note, config.download)).rejects.toMatchObject({
      code: "OUTPUT_COLLISION",
    });
    config.download.template = "{index}_{media.role}.{ext}";
    expect((await planDownload(note, config.download)).media).toHaveLength(3);
  });
  it("rejects symbolic-link writes outside the chosen root", async () => {
    const root = await mkdtemp(join(tmpdir(), "xhs-path-test-"));
    roots.push(root);
    const out = join(root, "outside"),
      dest = join(root, "download");
    await mkdir(out);
    await mkdir(dest);
    await symlink(
      out,
      join(dest, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(safePath(dest, "linked/file.jpg", true)).rejects.toMatchObject(
      { code: "UNSAFE_PATH" },
    );
  });
});
