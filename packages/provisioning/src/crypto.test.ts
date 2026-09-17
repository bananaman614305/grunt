import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./crypto.js";

const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");

describe("encryptSecret / decryptSecret (shared with @milo/billing)", () => {
  it("round-trips a secret without leaking it", () => {
    const payload = encryptSecret("sk-or-v1-super-secret", KEY_A);
    expect(payload).not.toContain("sk-or-v1-super-secret");
    expect(decryptSecret(payload, KEY_A)).toBe("sk-or-v1-super-secret");
  });

  it("uses a random IV each time, so ciphertexts differ", () => {
    expect(encryptSecret("same-plaintext", KEY_A)).not.toBe(encryptSecret("same-plaintext", KEY_A));
  });

  it("fails to decrypt with the wrong key", () => {
    const payload = encryptSecret("secret", KEY_A);
    expect(() => decryptSecret(payload, KEY_B)).toThrow();
  });

  it("rejects a key that is not 32 bytes", () => {
    expect(() => encryptSecret("secret", Buffer.from("short").toString("base64"))).toThrow(/32 bytes/);
  });
});
