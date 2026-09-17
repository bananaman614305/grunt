import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  encryptionKeyFromEnv,
  generateEncryptionKey,
  hashesEqual,
  sha256Hex,
} from "./crypto.js";

const KEY = generateEncryptionKey();

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a sub-key", () => {
    const plain = "sk-or-v1-0123456789abcdef0123456789abcdef";
    expect(decryptSecret(encryptSecret(plain, KEY), KEY)).toBe(plain);
  });

  it("round-trips an empty string and multi-byte text", () => {
    expect(decryptSecret(encryptSecret("", KEY), KEY)).toBe("");
    expect(decryptSecret(encryptSecret("clé — 🔑", KEY), KEY)).toBe("clé — 🔑");
  });

  it("uses a fresh iv, so the same plaintext encrypts differently each time", () => {
    const a = encryptSecret("same", KEY);
    const b = encryptSecret("same", KEY);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, KEY)).toBe(decryptSecret(b, KEY));
  });

  it("carries a version prefix", () => {
    expect(encryptSecret("x", KEY).startsWith("v1.")).toBe(true);
  });

  it("does not leak the plaintext into the stored form", () => {
    const stored = encryptSecret("sk-or-v1-secret-material", KEY);
    expect(stored).not.toContain("secret-material");
    expect(stored).not.toContain("sk-or");
  });

  it("accepts a Buffer key as well as base64", () => {
    const bytes = Buffer.from(KEY, "base64");
    expect(decryptSecret(encryptSecret("x", bytes), KEY)).toBe("x");
  });
});

describe("tamper detection", () => {
  const plain = "sk-or-v1-tamper";

  it("rejects a flipped byte of ciphertext", () => {
    const stored = encryptSecret(plain, KEY);
    const parts = stored.split(".");
    const ciphertext = Buffer.from(parts[3] ?? "", "base64url");
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 0x01;
    parts[3] = ciphertext.toString("base64url");
    expect(() => decryptSecret(parts.join("."), KEY)).toThrow(/failed authentication/);
  });

  it("rejects a flipped byte of the iv", () => {
    const parts = encryptSecret(plain, KEY).split(".");
    const iv = Buffer.from(parts[1] ?? "", "base64url");
    iv[0] = (iv[0] ?? 0) ^ 0x01;
    parts[1] = iv.toString("base64url");
    expect(() => decryptSecret(parts.join("."), KEY)).toThrow(/failed authentication/);
  });

  it("rejects a truncated auth tag", () => {
    const parts = encryptSecret(plain, KEY).split(".");
    parts[2] = Buffer.from(parts[2] ?? "", "base64url").subarray(0, 8).toString("base64url");
    expect(() => decryptSecret(parts.join("."), KEY)).toThrow(/malformed iv or auth tag/);
  });

  it("rejects the wrong key", () => {
    const stored = encryptSecret(plain, KEY);
    expect(() => decryptSecret(stored, generateEncryptionKey())).toThrow(/failed authentication/);
  });

  it("rejects a value that is not in the v1 format", () => {
    expect(() => decryptSecret("not-a-ciphertext", KEY)).toThrow(/not in the v1 format/);
    expect(() => decryptSecret("v2.a.b.c", KEY)).toThrow(/not in the v1 format/);
  });
});

describe("keys", () => {
  it("generates 32 bytes", () => {
    expect(Buffer.from(generateEncryptionKey(), "base64")).toHaveLength(32);
  });

  it("refuses a key that is not 32 bytes", () => {
    const short = Buffer.from("too short").toString("base64");
    expect(() => encryptSecret("x", short)).toThrow(/must be 32 bytes/);
  });

  it("reads and validates MILO_ENCRYPTION_KEY", () => {
    expect(encryptionKeyFromEnv({ MILO_ENCRYPTION_KEY: KEY })).toHaveLength(32);
    expect(() => encryptionKeyFromEnv({})).toThrow(/MILO_ENCRYPTION_KEY is not set/);
    expect(() => encryptionKeyFromEnv({ MILO_ENCRYPTION_KEY: "c2hvcnQ=" })).toThrow(/must be 32 bytes/);
  });
});

describe("sha256Hex", () => {
  it("is stable and 64 hex characters", () => {
    const hash = sha256Hex("mk_abc");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex("mk_abc")).toBe(hash);
    expect(sha256Hex("mk_abd")).not.toBe(hash);
  });

  it("compares digests without leaking length differences", () => {
    expect(hashesEqual(sha256Hex("a"), sha256Hex("a"))).toBe(true);
    expect(hashesEqual(sha256Hex("a"), sha256Hex("b"))).toBe(false);
    expect(hashesEqual(sha256Hex("a"), "ff")).toBe(false);
  });
});
