import { randomBytes } from "node:crypto";
import type { Device } from "../domain/models.js";
import { protocolError } from "../domain/errors.js";
import { crc32, digest } from "./crypto.js";
import {
  XS_ALPHABET,
  MNS_ALPHABET,
  MNS58_ALPHABET,
  STREAM_0101,
  STREAM_0301,
  stages,
  type Stage,
} from "./constants.js";

const STANDARD =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export function encode64(bytes: Uint8Array, alphabet: string) {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/[A-Za-z0-9+/]/g, (x) => alphabet[STANDARD.indexOf(x)]!);
}
function le(value: number, bytes: number) {
  const result = Buffer.alloc(bytes);
  if (bytes === 8) result.writeBigUInt64LE(BigInt(value));
  else result.writeUInt32LE(value >>> 0);
  return result;
}
function sized(value: string) {
  const b = Buffer.from(value);
  if (b.length > 255) throw protocolError("协议字段长度超过单字节限制。");
  return Buffer.concat([Buffer.from([b.length]), b]);
}
const rotate = (n: number, b: number) => (n << b) | (n >>> (32 - b));
// Four-lane ARX transform of timestamp || MD5(path), defined by the PC wire protocol.
export function deviceDigest(bytes: Buffer) {
  let [a, b, c, d] = [
    0x6d2b79f5 ^ bytes.length,
    0x1b873593 ^ (bytes.length << 8),
    0x85ebca6b ^ (bytes.length << 16),
    0xc2b2ae35 ^ (bytes.length << 24),
  ];
  for (let i = 0; i + 8 <= bytes.length; i += 8) {
    const x = bytes.readInt32LE(i),
      y = bytes.readInt32LE(i + 4);
    a = rotate(((a! + x) | 0) ^ c!, 7);
    b = rotate(((b! ^ x) + d!) | 0, 11);
    c = rotate(((c! + y) | 0) ^ a, 13);
    d = rotate(((d! ^ y) + b) | 0, 17);
  }
  a = a! ^ bytes.length;
  b = b! ^ a;
  c = (c! + b) | 0;
  d = d! ^ c;
  a = rotate(a, 9);
  b = rotate(b, 13);
  c = rotate(c, 17);
  d = rotate(d, 19);
  a = (a + c) | 0;
  b = b ^ d;
  c = (c + a) | 0;
  d = d ^ b;
  return Buffer.concat([a, b, c, d].map((n) => le(n, 4)));
}
function tea(bytes: Buffer) {
  const words = Array.from(
    { length: Math.ceil(bytes.length / 4) + 1 },
    () => 0,
  );
  for (let i = 0; i < bytes.length; i++)
    words[i >>> 2] = words[i >>> 2]! | (bytes[i]! << ((i % 4) * 8));
  words[words.length - 1] = bytes.length;
  const key = Buffer.from("e6483ca2a1eed5e3");
  const keys = Array.from({ length: 4 }, (_, i) => key.readInt32LE(i * 4));
  let sum = 0,
    z = words.at(-1)!;
  for (let round = 0; round < Math.floor(6 + 52 / words.length); round++) {
    sum = (sum + 1013904243) | 0;
    const e = (sum >>> 2) & 3;
    for (let p = 0; p < words.length; p++) {
      const y = words[(p + 1) % words.length]!;
      const mix =
        (((z >>> 5) ^ (y << 2)) + ((y >>> 3) ^ (z << 4))) ^
        ((sum ^ y) + (keys[(p & 3) ^ e]! ^ z));
      z = words[p] = (words[p]! + mix) | 0;
    }
  }
  return Buffer.concat(words.map((n) => le(n, 4)));
}
export function pack(
  device: Device,
  path: string,
  body: string,
  stage: Stage,
  now: number,
  version: number,
) {
  const info = stages[stage],
    v = version & 255,
    full = path + body;
  const md5path = digest("md5", path);
  const ds =
    device.deviceTag === "nop"
      ? md5path
      : deviceDigest(Buffer.concat([le(now, 8), md5path]));
  return Buffer.concat([
    Buffer.from([121, 104, 96, 41]),
    le(version, 4),
    le(now, 8),
    le(device.loadts, 8),
    le(device.sequence, 4),
    le(info.environment, 4),
    le(Buffer.byteLength(full), 4),
    Buffer.from(
      digest("md5", full)
        .subarray(0, 8)
        .map((x) => x ^ v),
    ),
    sized(device.a1),
    sized("xhs-pc-web"),
    Buffer.from([1, v ^ 115]),
    Buffer.from(info.tail, "hex"),
    sized(device.deviceTag),
    Buffer.from([16]),
    Buffer.from(ds.map((x) => x ^ v)),
  ]);
}
export function mns(
  device: Device,
  path: string,
  body: string,
  stage: Stage,
  now: number,
  version: number,
) {
  const plain = pack(device, path, body, stage, now, version),
    tier = stages[stage].tier;
  if (tier === "0201") return "mns0201_" + encode64(tea(plain), MNS_ALPHABET);
  const stream = Buffer.from(
    tier === "0101" ? STREAM_0101 : STREAM_0301,
    "base64",
  );
  if (plain.length > stream.length)
    throw protocolError("签名协议包超过已知密钥流长度。");
  const bytes = Buffer.from(plain.map((x, i) => x ^ stream[i]!));
  if (tier === "0301") return "mns0301_" + encode64(bytes, MNS_ALPHABET);
  let n = BigInt("0x" + bytes.toString("hex")),
    result = "";
  while (n > 0n) {
    result = MNS58_ALPHABET[Number(n % 58n)] + result;
    n /= 58n;
  }
  let zeros = 0;
  while (bytes[zeros] === 0) zeros++;
  return "mns0101_" + "1".repeat(zeros) + result;
}
export function sign(
  device: Device,
  path: string,
  body: string,
  stage: Stage = "steady",
  now = Date.now(),
) {
  device.sequence++;
  const x3 = mns(device, path, body, stage, now, randomBytes(4).readUInt32LE());
  const hash = digest("md5", path + body);
  const envelope: Record<string, unknown> = {
    x0: "4.4.3",
    x1: "xhs-pc-web",
    x2: "Windows",
    x3,
    x4: body ? "object" : "",
    x5: hash.toString("hex"),
  };
  if (device.ssk) {
    const secret = Buffer.from(device.ssk, "base64");
    const nonce = le((now + randomBytes(4).readUInt32LE()) >>> 0, 4);
    const encrypted = Buffer.concat([
      nonce,
      digest("sha1", Buffer.concat([secret, nonce])),
      secret.subarray(32),
    ]);
    envelope.x6 = {
      "xhs-pc-web": digest("sha1", Buffer.concat([hash, encrypted])).toString(
        "base64",
      ),
    };
    envelope.x7 = { "xhs-pc-web": encrypted.toString("base64") };
  }
  const xs =
    "XYS_" + encode64(Buffer.from(JSON.stringify(envelope)), XS_ALPHABET);
  const b1 = device.b1 || null;
  const common = {
    s0: 5,
    s1: "",
    x0: "1",
    x1: "4.4.3",
    x2: "Windows",
    x3: "xhs-pc-web",
    x4: device.webBuild,
    x5: device.a1,
    x6: "",
    x7: "",
    x8: b1,
    x9: (crc32(b1 ?? "null") ^ 0xedb88320) | 0,
    x10: device.sequence,
    x11: "normal",
    x12: `${device.dsUpdatedAt || "null"};${device.dsl}`,
  };
  return {
    "x-s": xs,
    "x-t": String(now),
    "x-s-common": encode64(Buffer.from(JSON.stringify(common)), XS_ALPHABET),
    "x-b3-traceid": randomBytes(8).toString("hex"),
    "x-xray-traceid":
      (
        (BigInt(now) << 23n) |
        BigInt(randomBytes(3).readUIntBE(0, 3) & 0x7fffff)
      )
        .toString(16)
        .padStart(16, "0")
        .slice(-16) + randomBytes(8).toString("hex"),
  };
}
