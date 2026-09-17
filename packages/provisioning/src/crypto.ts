/**
 * AES-256-GCM envelope for the OpenRouter sub-key stored on `Account.openRouterSubKeyEnc`.
 *
 * `@milo/billing` does not exist in this tree yet (checked at merge time: no
 * `packages/billing` on `main` or any `wave7/*` branch), so this is a local,
 * self-contained implementation with the shape ADR-007 asks for: a 32-byte
 * key from base64 `MILO_ENCRYPTION_KEY`, a random IV per encryption, and a
 * versioned prefix so the format can change later without breaking old
 * ciphertexts. If `@milo/billing` ships an `encryptSecret`/`decryptSecret`
 * pair with this same shape, this module should be replaced by a re-export
 * of that one instead of carrying a second implementation.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoError";
  }
}

function loadKey(encryptionKeyB64: string): Buffer {
  let key: Buffer;
  try {
    key = Buffer.from(encryptionKeyB64, "base64");
  } catch {
    throw new CryptoError("MILO_ENCRYPTION_KEY is not valid base64");
  }
  if (key.length !== KEY_BYTES) {
    throw new CryptoError(`MILO_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}`);
  }
  return key;
}

/**
 * Encrypts `plaintext` (the OpenRouter sub-key) with a random IV. Output is
 * `v1:<iv-b64>:<ciphertext+tag-b64>`, safe to store as
 * `Account.openRouterSubKeyEnc`.
 */
export function encryptSecret(plaintext: string, encryptionKeyB64: string): string {
  const key = loadKey(encryptionKeyB64);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), Buffer.concat([ciphertext, tag]).toString("base64")].join(":");
}

/** Reverses `encryptSecret`. Throws `CryptoError` on a bad version, key, or tag. */
export function decryptSecret(payload: string, encryptionKeyB64: string): string {
  const parts = payload.split(":");
  if (parts.length !== 3) throw new CryptoError("malformed encrypted secret");
  const [version, ivB64, dataB64] = parts as [string, string, string];
  if (version !== VERSION) throw new CryptoError(`unsupported encrypted secret version: ${version}`);

  const key = loadKey(encryptionKeyB64);
  const iv = Buffer.from(ivB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const TAG_BYTES = 16;
  if (data.length <= TAG_BYTES) throw new CryptoError("malformed encrypted secret");
  const tag = data.subarray(data.length - TAG_BYTES);
  const ciphertext = data.subarray(0, data.length - TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new CryptoError("failed to decrypt secret (wrong key or tampered ciphertext)");
  }
}
