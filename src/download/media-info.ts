import { open } from "node:fs/promises";
import type { MediaInfo, Variant } from "../domain/content.js";

export function variantInfo(v: Variant): MediaInfo {
  return {
    source: "api",
    container: v.container,
    width: v.width,
    height: v.height,
    codec: v.codec,
    duration_seconds: v.duration_seconds ?? null,
    frame_rate: null,
    audio: [],
  };
}
type Box = { type: string; start: number; end: number; data: number };
function boxes(b: Buffer, start = 0, end = b.length): Box[] {
  const result: Box[] = [];
  for (let p = start; p + 8 <= end;) {
    let size = b.readUInt32BE(p),
      header = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = Number(b.readBigUInt64BE(p + 8));
      header = 16;
    }
    if (size === 0) size = end - p;
    if (!Number.isSafeInteger(size) || size < header || p + size > end) break;
    result.push({
      type: b.toString("ascii", p + 4, p + 8),
      start: p,
      end: p + size,
      data: p + header,
    });
    p += size;
  }
  return result;
}
function child(b: Buffer, parent: Box, type: string) {
  return boxes(b, parent.data, parent.end).find((x) => x.type === type);
}
function timing(b: Buffer, box: Box) {
  const p = box.data,
    version = b[p];
  if (box.end < p + (version === 1 ? 32 : 20))
    return { duration: null, scale: 0 };
  const scale = b.readUInt32BE(p + (version === 1 ? 20 : 12));
  const duration =
    version === 1 ? Number(b.readBigUInt64BE(p + 24)) : b.readUInt32BE(p + 16);
  return {
    duration: scale && Number.isFinite(duration) ? duration / scale : null,
    scale,
  };
}
function mp4Info(b: Buffer, out: MediaInfo) {
  const moov = boxes(b).find((x) => x.type === "moov");
  if (!moov) return;
  const mvhd = child(b, moov, "mvhd");
  if (mvhd) out.duration_seconds = timing(b, mvhd).duration;
  for (const trak of boxes(b, moov.data, moov.end).filter(
    (x) => x.type === "trak",
  )) {
    const mdia = child(b, trak, "mdia");
    if (!mdia) continue;
    const hdlr = child(b, mdia, "hdlr"),
      mdhd = child(b, mdia, "mdhd"),
      minf = child(b, mdia, "minf");
    if (!hdlr || hdlr.data + 12 > hdlr.end || !minf) continue;
    const kind = b.toString("ascii", hdlr.data + 8, hdlr.data + 12),
      stbl = child(b, minf, "stbl");
    if (!stbl) continue;
    const stsd = child(b, stbl, "stsd");
    if (!stsd || stsd.data + 8 > stsd.end) continue;
    const entry = boxes(b, stsd.data + 8, stsd.end)[0];
    if (!entry) continue;
    const codec =
      (
        {
          avc1: "h264",
          avc3: "h264",
          hvc1: "hevc",
          hev1: "hevc",
          av01: "av1",
          vvc1: "vvc",
          mp4a: "aac",
        } as Record<string, string>
      )[entry.type] ?? entry.type;
    if (kind === "vide") {
      out.codec = codec;
      if (entry.start + 36 <= entry.end) {
        out.width = b.readUInt16BE(entry.start + 32) || null;
        out.height = b.readUInt16BE(entry.start + 34) || null;
      }
      if (mdhd) {
        const time = timing(b, mdhd);
        out.duration_seconds ??= time.duration;
        const stts = child(b, stbl, "stts");
        if (stts && stts.data + 8 <= stts.end) {
          const count = b.readUInt32BE(stts.data + 4);
          let frames = 0,
            ticks = 0;
          if (count < 100000 && stts.data + 8 + count * 8 <= stts.end) {
            for (let i = 0; i < count; i++) {
              const p = stts.data + 8 + i * 8,
                n = b.readUInt32BE(p);
              frames += n;
              ticks += n * b.readUInt32BE(p + 4);
            }
            if (ticks && time.scale)
              out.frame_rate = (frames * time.scale) / ticks;
          }
        }
      }
    } else if (kind === "soun" && entry.start + 36 <= entry.end)
      out.audio.push({
        codec,
        sample_rate: b.readUInt32BE(entry.start + 32) >>> 16,
        channels: b.readUInt16BE(entry.start + 24),
      });
  }
}
// Read bounded headers only; no ffmpeg/ffprobe executable or full-file decode required.
export async function inspectMedia(path: string): Promise<MediaInfo> {
  const out: MediaInfo = {
    source: "file_header",
    container: null,
    width: null,
    height: null,
    codec: null,
    duration_seconds: null,
    frame_rate: null,
    audio: [],
  };
  const file = await open(path, "r");
  try {
    const size = (await file.stat()).size,
      head = Buffer.alloc(Math.min(size, 65536));
    await file.read(head, 0, head.length, 0);
    if (
      head.subarray(0, 4).toString() === "RIFF" &&
      head.subarray(8, 12).toString() === "WEBP"
    ) {
      out.container = out.codec = "webp";
      const kind = head.toString("ascii", 12, 16);
      if (kind === "VP8X" && head.length >= 30) {
        out.width = head.readUIntLE(24, 3) + 1;
        out.height = head.readUIntLE(27, 3) + 1;
      } else if (kind === "VP8 " && head.length >= 30) {
        out.width = head.readUInt16LE(26) & 0x3fff;
        out.height = head.readUInt16LE(28) & 0x3fff;
      } else if (kind === "VP8L" && head.length >= 25) {
        const bits = head.readUInt32LE(21);
        out.width = (bits & 0x3fff) + 1;
        out.height = ((bits >>> 14) & 0x3fff) + 1;
      }
    } else if (
      head.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) &&
      head.length >= 24
    ) {
      out.container = out.codec = "png";
      out.width = head.readUInt32BE(16);
      out.height = head.readUInt32BE(20);
    } else if (head[0] === 255 && head[1] === 216) {
      out.container = "jpg";
      out.codec = "jpeg";
      for (let p = 2; p + 9 < head.length;) {
        if (head[p] !== 255) break;
        const marker = head[p + 1]!,
          n = head.readUInt16BE(p + 2);
        if (n < 2 || p + 2 + n > head.length) break;
        if (
          [
            192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
          ].includes(marker)
        ) {
          out.height = head.readUInt16BE(p + 5);
          out.width = head.readUInt16BE(p + 7);
          break;
        }
        p += 2 + n;
      }
    } else if (head.subarray(0, 4).toString() === "GIF8" && head.length >= 10) {
      out.container = out.codec = "gif";
      out.width = head.readUInt16LE(6);
      out.height = head.readUInt16LE(8);
    } else if (head.toString("ascii", 4, 8) === "ftyp") {
      const ftypSize = Math.min(head.readUInt32BE(0), head.length);
      const brands = [head.toString("ascii", 8, 12)];
      for (let p = 16; p + 4 <= ftypSize; p += 4)
        brands.push(head.toString("ascii", p, p + 4));
      if (brands.some((x) => ["avif", "avis"].includes(x))) {
        out.container = "avif";
        out.codec = "av1";
      } else if (
        brands.some((x) =>
          ["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(x),
        )
      ) {
        out.container = "heic";
        out.codec = "hevc";
      } else out.container = "mp4";
      if (out.container !== "mp4") {
        const meta = boxes(head).find((x) => x.type === "meta");
        if (meta && meta.data + 4 <= meta.end) {
          const iprp = boxes(head, meta.data + 4, meta.end).find(
            (x) => x.type === "iprp",
          );
          const ipco = iprp ? child(head, iprp, "ipco") : undefined;
          const ispe = ipco ? child(head, ipco, "ispe") : undefined;
          if (ispe && ispe.data + 12 <= ispe.end) {
            out.width = head.readUInt32BE(ispe.data + 4);
            out.height = head.readUInt32BE(ispe.data + 8);
          }
        }
        return out;
      }
      // moov can follow mdat. Seek across top-level boxes without loading media payload.
      for (let p = 0, n = 0; p + 8 <= size && n < 10000; n++) {
        const h = Buffer.alloc(16);
        await file.read(h, 0, Math.min(16, size - p), p);
        let length = h.readUInt32BE(0);
        let header = 8;
        if (length === 1) {
          length = Number(h.readBigUInt64BE(8));
          header = 16;
        }
        if (length === 0) length = size - p;
        if (
          !Number.isSafeInteger(length) ||
          length < header ||
          p + length > size
        )
          break;
        if (h.toString("ascii", 4, 8) === "moov") {
          if (length <= 16 * 1024 * 1024) {
            const data = Buffer.alloc(length);
            await file.read(data, 0, length, p);
            mp4Info(data, out);
          }
          break;
        }
        p += length;
      }
    }
    return out;
  } finally {
    await file.close();
  }
}
