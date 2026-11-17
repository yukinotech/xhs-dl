import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  diffieHellman,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { protocolError } from "../domain/errors.js";

export function digest(algorithm: string, value: string | Uint8Array) {
  return createHash(algorithm).update(value).digest();
}
export function crc32(value: string): number {
  let value32 = 0xffffffff;
  for (const byte of Buffer.from(value)) {
    value32 ^= byte;
    for (let bit = 0; bit < 8; bit++)
      value32 = (value32 >>> 1) ^ (value32 & 1 ? 0xedb88320 : 0);
  }
  return ~value32 >>> 0;
}
export function makeA1(now = Date.now()) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const raw =
    now.toString(16) +
    Array.from(randomBytes(30), (x) => chars[x % 36]).join("") +
    "50000";
  return (raw + crc32(raw).toString()).slice(0, 52);
}
export function createHandshake() {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  return {
    private_key: privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
    public_key: publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("base64"),
  };
}
export function acceptSsk(
  privateKey: string,
  encoded: string,
  serverHex = "2abd22ca0b02bb78a760935708be24e09bb369843669f235c5bc1cec11fab26f",
) {
  try {
    if (!/^[A-Za-z0-9+/]{80}$/.test(encoded)) throw new Error("invalid length");
    const key = createPrivateKey({
      key: Buffer.from(privateKey, "base64"),
      format: "der",
      type: "pkcs8",
    });
    const publicKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b656e032100", "hex"),
        Buffer.from(serverHex, "hex"),
      ]),
      format: "der",
      type: "spki",
    });
    const secret = diffieHellman({ privateKey: key, publicKey });
    const blob = Buffer.from(encoded, "base64");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      secret,
      blob.subarray(0, 12),
    );
    decipher.setAuthTag(blob.subarray(-16));
    const plain = Buffer.concat([
      decipher.update(blob.subarray(12, -16)),
      decipher.final(),
    ]);
    if (plain.length !== 32) throw new Error("invalid ssk");
    return plain.toString("base64");
  } catch {
    throw protocolError("登录密钥交换失败，平台协议可能已变更。");
  }
}
