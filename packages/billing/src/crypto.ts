/**
 * Symmetric encryption for the one secret Milo has to be able to read back:
 * the account's OpenRouter sub-key, which goes upstream on every request
 * (ADR-007). Everything else -- Milo keys included -- is hashed, never
 * encrypted, because nothing needs the plaintext again.
 *
 * AES-256-GCM with a random 96-bit IV per message and the auth tag kept
 * alongside, so a ciphertext that has been edited fails to decrypt rather
 * than decrypting to garbage. The stored form carries a version prefix so a
 * future key rotation or cipher change can be told apart from what is
 * already in the table.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const ENCRYPTION_KEY_ENV = "MILO_ENCRYPTION_KEY";
export const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = "v1";

/** `v1.<iv>.<tag>.<ciphertext>`, each part base64url. */
const FORMAT = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]*)$/;

export type EncryptionKey = Buffer | string;

/**
 * A 32-byte key, from a Buffer or from the base64 the env var carries.
 * Throws on anything that is not exactly 32 bytes: a short key here would
 * silently weaken every ciphertext in the table.
 */
function coerceKey(key: EncryptionKey): Buffer {
  const bytes = typeof key === "string" ? Buffer.from(key, "base64") : key;
  if (bytes.length !== KEY_BYTES) {
    throw new Error(`billing: encryption key must be ${KEY_BYTES} bytes (base64), got ${bytes.length}`);
  }
  return bytes;
}

/** Reads and validates the key from the environment. */
export function encryptionKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env[ENCRYPTION_KEY_ENV];
  if (raw === undefined || raw === "") {
    throw new Error(`billing: ${ENCRYPTION_KEY_ENV} is not set (base64 of ${KEY_BYTES} random bytes)`);
  }
  return coerceKey(raw);
}

/** A fresh key, base64, for `MILO_ENCRYPTION_KEY`. */
export function generateEncryptionKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

export function encryptSecret(plain: string, keyFromEnv: EncryptionKey): string {
  const key = coerceKey(keyFromEnv);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptSecret(stored: string, keyFromEnv: EncryptionKey): string {
  const key = coerceKey(keyFromEnv);
  const match = FORMAT.exec(stored);
  if (match === null) {
    throw new Error("billing: ciphertext is not in the v1 format");
  }
  const iv = Buffer.from(match[1] ?? "", "base64url");
  const tag = Buffer.from(match[2] ?? "", "base64url");
  const ciphertext = Buffer.from(match[3] ?? "", "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("billing: ciphertext has a malformed iv or auth tag");
  }

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (cause) {
    // GCM's tag check failed: wrong key, or someone edited the row.
    throw new Error("billing: ciphertext failed authentication (wrong key or tampered value)", { cause });
  }
}

/** SHA-256 hex. The only form a Milo key is ever stored in. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Constant-time comparison of two hex digests. */
export function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}
