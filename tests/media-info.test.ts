import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectMedia } from "../src/download/media-info.js";
function box(type: string, data: Buffer) {
  const b = Buffer.alloc(8 + data.length);
  b.writeUInt32BE(b.length);
  b.write(type, 4);
  data.copy(b, 8);
  return b;
}
function timing() {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(1000, 12);
  b.writeUInt32BE(2000, 16);
  return b;
}
function track(kind: string, codec: string) {
  const handler = Buffer.alloc(12);
  handler.write(kind, 8);
  const sample = Buffer.alloc(28);
  if (kind === "vide") {
    sample.writeUInt16BE(1920, 24);
    sample.writeUInt16BE(1080, 26);
  } else {
    sample.writeUInt16BE(2, 16);
    sample.writeUInt32BE(44100 * 65536, 24);
  }
  const entries = Buffer.alloc(8);
  entries.writeUInt32BE(1, 4);
  const times = Buffer.alloc(16);
  times.writeUInt32BE(1, 4);
  times.writeUInt32BE(100, 8);
  times.writeUInt32BE(20, 12);
  return box(
    "trak",
    box(
      "mdia",
      Buffer.concat([
        box("hdlr", handler),
        box("mdhd", timing()),
        box(
          "minf",
          box(
            "stbl",
            Buffer.concat([
              box("stsd", Buffer.concat([entries, box(codec, sample)])),
              box("stts", times),
            ]),
          ),
        ),
      ]),
    ),
  );
}
describe("bounded media header inspection", () => {
  it("seeks past a media payload to report video and audio from an MP4 moov", async () => {
    const root = await mkdtemp(join(tmpdir(), "xhs-header-"));
    try {
      const path = join(root, "video.mp4");
      await writeFile(
        path,
        Buffer.concat([
          box("ftyp", Buffer.from("isom0000")),
          box("mdat", Buffer.alloc(1024 * 1024)),
          box(
            "moov",
            Buffer.concat([
              box("mvhd", timing()),
              track("vide", "hvc1"),
              track("soun", "mp4a"),
            ]),
          ),
        ]),
      );
      expect(await inspectMedia(path)).toMatchObject({
        source: "file_header",
        container: "mp4",
        width: 1920,
        height: 1080,
        codec: "hevc",
        duration_seconds: 2,
        frame_rate: 50,
        audio: [{ codec: "aac", sample_rate: 44100, channels: 2 }],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("reads image dimensions and tolerates truncated boxes without unbounded allocation", async () => {
    const root = await mkdtemp(join(tmpdir(), "xhs-header-"));
    try {
      const png = Buffer.alloc(24);
      Buffer.from("89504e470d0a1a0a", "hex").copy(png);
      png.writeUInt32BE(800, 16);
      png.writeUInt32BE(600, 20);
      const path = join(root, "image");
      await writeFile(path, png);
      expect(await inspectMedia(path)).toMatchObject({
        container: "png",
        width: 800,
        height: 600,
      });
      await writeFile(
        path,
        Buffer.from("000000106674797069736f6d30303030ffffffff6d6f6f76", "hex"),
      );
      expect(await inspectMedia(path)).toMatchObject({
        container: "mp4",
        duration_seconds: null,
      });
      const dimensions = Buffer.alloc(12);
      dimensions.writeUInt32BE(1024, 4);
      dimensions.writeUInt32BE(768, 8);
      await writeFile(
        path,
        Buffer.concat([
          box("ftyp", Buffer.from("avif0000avif")),
          box(
            "meta",
            Buffer.concat([
              Buffer.alloc(4),
              box("iprp", box("ipco", box("ispe", dimensions))),
            ]),
          ),
        ]),
      );
      expect(await inspectMedia(path)).toMatchObject({
        container: "avif",
        codec: "av1",
        width: 1024,
        height: 768,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
