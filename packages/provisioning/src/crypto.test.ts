import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CryptoError, decryptSecret, encryptSecret } from "./crypto.js";

const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a secret", () => {
    const payload = encryptSecret("sk-or-v1-super-secret", KEY_A);
    expect(payload.startsWith("v1:")).toBe(true);
    expect(payload).not.toContain("sk-or-v1-super-secret");
    expect(decryptSecret(payload, KEY_A)).toBe("sk-or-v1-super-secret");
  });

  it("uses a random IV each time, so ciphertexts differ", () => {
    const a = encryptSecret("same-plaintext", KEY_A);
    const b = encryptSecret("same-plaintext", KEY_A);
    expect(a).not.toBe(b);
  });

  it("fails to decrypt with the wrong key", () => {
    const payload = encryptSecret("sk-or-v1-super-secret", KEY_A);
    expect(() => decryptSecret(payload, KEY_B)).toThrow(CryptoError);
  });

  it("rejects a key that isn't 32 bytes", () => {
    expect(() => encryptSecret("x", Buffer.from("too-short").toString("base64"))).toThrow(CryptoError);
  });
});
