import { describe, expect, it } from "vitest";
import { noteDetail } from "../src/content/api.js";
import { AppError } from "../src/domain/errors.js";
import type { XhsClient } from "../src/api/client.js";
import { normalizeNote } from "../src/content/normalize.js";
import { selectVariant } from "../src/download/planner.js";
const id = "1".repeat(24),
  ref = { id, xsec_token: "synthetic" };
function card(full: boolean) {
  return {
    note_id: id,
    type: "video",
    video: {
      media: {
        stream: {
          EF4: [
            {
              master_url: "https://sns-video.xhscdn.com/h264.mp4",
              width: 720,
              height: 1280,
              video_codec: "EF4",
            },
          ],
          EF5: full
            ? [
                {
                  master_url: "https://sns-video.xhscdn.com/hevc.mp4",
                  width: 1440,
                  height: 2560,
                  video_codec: "EF5",
                },
              ]
            : [],
        },
      },
    },
  };
}
function response(full: boolean) {
  return {
    status: 200,
    headers: new Headers(),
    text: JSON.stringify({
      success: true,
      code: 0,
      data: { items: [{ note_card: card(full) }] },
    }),
  };
}
describe("note candidate resolution", () => {
  it("merges sparse successful API responses and exposes source evidence instead of losing higher variants", async () => {
    let calls = 0;
    const client = {
      request: async () => response(++calls === 2),
    } as unknown as XhsClient;
    const note = await noteDetail(client, ref, { intervalMs: 0 });
    expect(calls).toBe(3);
    expect(note.resolution).toMatchObject({
      source: "api",
      attempts: 3,
      candidates_changed: true,
      observations: [
        { variant_count: 1 },
        { variant_count: 2 },
        { variant_count: 1 },
      ],
      warnings: ["API_CANDIDATES_VARIED"],
    });
    expect(selectVariant(note.media[0]!, "best")).toMatchObject({
      width: 1440,
      height: 2560,
      codec: "hevc",
      codec_raw: "EF5",
    });
    expect(selectVariant(note.media[0]!, "best", false, "h264").height).toBe(
      1280,
    );
    expect(() => selectVariant(note.media[0]!, "best", false, "av1")).toThrow(
      /编码/,
    );
  });
  it("never swallows a later rate-limit or permission error during enrichment", async () => {
    for (const code of [5, 11]) {
      let calls = 0;
      const client = {
        request: async () => {
          if (++calls === 1) return response(false);
          throw new AppError("STOP", "stop", code);
        },
      } as unknown as XhsClient;
      await expect(
        noteDetail(client, ref, { intervalMs: 0 }),
      ).rejects.toMatchObject({ code: "STOP", exitCode: code });
      expect(calls).toBe(2);
    }
  });
  it("reports an interrupted network enrichment without discarding already available candidates", async () => {
    let calls = 0;
    const client = {
      request: async () => {
        if (++calls === 1) return response(true);
        throw new AppError("NETWORK_ERROR", "network", 6);
      },
    } as unknown as XhsClient;
    const note = await noteDetail(client, ref, { intervalMs: 0 });
    expect(note.resolution?.warnings).toContain(
      "CANDIDATE_ENRICHMENT_INCOMPLETE",
    );
    expect(note.media[0]!.variants).toHaveLength(2);
  });
  it("labels a static HTML fallback and avoids repeatedly requesting images", async () => {
    const client = {
      request: async () => {
        throw new AppError("CONTENT_UNAVAILABLE", "unavailable", 7);
      },
      session: { device: { userAgent: "synthetic" } },
      transport: {
        request: async () => ({
          status: 200,
          text: `window.__INITIAL_STATE__={note:{noteDetailMap:{'${id}':{note:{noteId:'${id}',type:'normal',imageList:[{urlDefault:'https://sns-img.xhscdn.com/synthetic.png'}]}}}}}`,
        }),
      },
    } as unknown as XhsClient;
    expect(
      (await noteDetail(client, ref, { intervalMs: 0 })).resolution,
    ).toMatchObject({ source: "html_fallback", attempts: 1 });
    let calls = 0;
    const imageClient = {
      request: async () => {
        calls++;
        const data = {
          ...card(false),
          type: "normal",
          image_list: [
            { url_default: "https://sns-img.xhscdn.com/synthetic.jpg" },
          ],
        };
        return {
          status: 200,
          headers: new Headers(),
          text: JSON.stringify({
            success: true,
            code: 0,
            data: { items: [{ note_card: data }] },
          }),
        };
      },
    } as unknown as XhsClient;
    expect((await noteDetail(imageClient, ref, { intervalMs: 0 })).type).toBe(
      "image",
    );
    expect(calls).toBe(1);
  });
  it("defaults to the greatest pixel area for video and the detail rendition for images", () => {
    const note = normalizeNote(
      {
        note_id: id,
        type: "video",
        video: {
          media: {
            stream: {
              h264: [
                {
                  master_url: "https://sns-video.xhscdn.com/wide.mp4",
                  width: 4000,
                  height: 1000,
                },
                {
                  master_url: "https://sns-video.xhscdn.com/portrait.mp4",
                  width: 1080,
                  height: 2160,
                },
              ],
            },
          },
        },
      },
      ref,
    );
    expect(selectVariant(note.media[0]!, "best").width).toBe(4000);
    const image = normalizeNote(
      {
        note_id: id,
        type: "normal",
        image_list: [
          {
            info_list: [
              {
                image_scene: "WB_PRV",
                url: "https://sns-img.xhscdn.com/preview.webp",
                width: 4000,
                height: 6000,
              },
              {
                image_scene: "WB_DFT",
                url: "https://sns-img.xhscdn.com/detail.webp",
                width: 1080,
                height: 1620,
              },
            ],
          },
        ],
      },
      ref,
    );
    expect(selectVariant(image.media[0]!, "best").scene).toBe("detail");
  });
});
