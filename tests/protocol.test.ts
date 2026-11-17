import { describe, it, expect } from "vitest";
import {
  createCipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import fixture from "./fixtures/signatures.json" with { type: "json" };
import { mns, sign } from "../src/protocol/signer.js";
import {
  createHandshake,
  acceptSsk,
  crc32,
  makeA1,
} from "../src/protocol/crypto.js";
import { createDevice } from "../src/api/client.js";
import type { Device } from "../src/domain/models.js";
import type { Stage } from "../src/protocol/constants.js";

describe("local HTTP protocol", () => {
  for (const vector of fixture.cases)
    it(`matches the locked offline ${vector.stage} wire vector`, () => {
      expect(
        mns(
          vector.device as Device,
          vector.path,
          vector.body,
          vector.stage as Stage,
          vector.now,
          vector.version,
        ),
      ).toBe(vector.expected);
    });
  it("roundtrips X25519/AES-GCM with a 60-byte unpadded base64 envelope, rejects tampering", () => {
    const client = createHandshake(),
      server = generateKeyPairSync("x25519");
    const clientPublic = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b656e032100", "hex"),
        Buffer.from(client.public_key, "base64"),
      ]),
      format: "der",
      type: "spki",
    });
    const secret = diffieHellman({
      privateKey: server.privateKey,
      publicKey: clientPublic,
    });
    const nonce = randomBytes(12),
      plain = randomBytes(32),
      cipher = createCipheriv("aes-256-gcm", secret, nonce);
    const envelope = Buffer.concat([
      nonce,
      cipher.update(plain),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    const publicHex = server.publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("hex");
    expect(envelope.toString("base64")).toHaveLength(80);
    expect(
      acceptSsk(client.private_key, envelope.toString("base64"), publicHex),
    ).toBe(plain.toString("base64"));
    envelope[20] = envelope[20]! ^ 1;
    expect(() =>
      acceptSsk(client.private_key, envelope.toString("base64"), publicHex),
    ).toThrow("密钥交换失败");
  });
  it("signs exactly the outgoing UTF-8 body and persists sequence", () => {
    const d = createDevice(1700000000000);
    d.dsl = "1700000000000";
    d.ssk = Buffer.alloc(32, 1).toString("base64");
    const one = sign(d, "/path", '{"中文":1}', "steady", 1700000001000);
    const two = sign(d, "/path", '{"中文":2}', "steady", 1700000001000);
    expect(d.sequence).toBe(2);
    expect(one["x-s"]).not.toBe(two["x-s"]);
    expect(one["x-t"]).toBe("1700000001000");
  });
  it("generates random device tokens with a known CRC primitive", () => {
    expect(crc32("123456789")).toBe(0xcbf43926);
    expect(makeA1()).toHaveLength(52);
    expect(makeA1()).not.toBe(makeA1());
  });
});
