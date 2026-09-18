/**
 * The personal-fact store's contract (ADR-017): the durable facts Milo
 * remembers about a caller -- an address, an account id, a person's name and
 * relationship, a spelling convention -- captured across sessions and injected
 * only when relevant.
 *
 * This is the one store in Milo that keeps the user's own words. ADR-003 and
 * ADR-011 refuse to store request content; ADR-017 crosses that line here and
 * only here, and pays for it with three things baked into this contract:
 *
 *   1. the content is **encrypted at rest** -- `putFact`/`listFacts` take an
 *      `Encryptor`, and the row's `content_encrypted` column is never
 *      plaintext. The `Encryptor` is the billing AES-256-GCM envelope
 *      (`packages/billing/src/crypto.ts`, keyed by `MILO_ENCRYPTION_KEY`),
 *      injected by the gateway so this module needs no crypto of its own and
 *      core keeps no dependency on billing;
 *   2. it is **fully listable** -- `listFacts` returns every row decrypted,
 *      for the owner only;
 *   3. it is **one-call deletable** -- `deleteFact` removes one row, scoped by
 *      key hash so one caller cannot touch another's.
 *
 * The `category` is a closed-vocabulary LABEL that rides alongside the
 * ciphertext; the CONTENT is what is encrypted. Rows are keyed by the SHA-256
 * of the bearer credential, exactly as preferences and rosters are (ADR-008),
 * because Milo stores no key material (ADR-003).
 */

import { assertKeyHash } from "../log/roster-store.js";

// ---------------------------------------------------------------------------
// Category vocabulary (a label; never the content)
// ---------------------------------------------------------------------------

/**
 * The closed vocabulary a fact is filed under. The category is a label -- it
 * says what *kind* of fact this is, so the relevance gate and the owner can
 * reason about it -- while the fact text itself is the encrypted content.
 */
export const FACT_CATEGORIES = [
  "address",
  "contact",
  "identifier",
  "credential-hint",
  "convention",
  "other",
] as const;

export type FactCategory = (typeof FACT_CATEGORIES)[number];

export function isFactCategory(value: string): value is FactCategory {
  return (FACT_CATEGORIES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Encryption boundary
// ---------------------------------------------------------------------------

/**
 * The at-rest encryption envelope, injected by the gateway. `encrypt` turns
 * fact text into the string stored in `content_encrypted`; `decrypt` reverses
 * it for the owner. In production this is the billing AES-256-GCM envelope
 * (ADR-017); a test can pass a reversible double. Core defines the shape and
 * imports no crypto, so it never depends on billing.
 */
export type Encryptor = {
  encrypt(plain: string): string;
  decrypt(stored: string): string;
};

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type FactRow = {
  /** ulid; what `DELETE /v1/memory/:id` names. */
  id: string;
  /** SHA-256 hex of the caller's credential. Never the credential. */
  keyHash: string;
  category: FactCategory;
  /** The fact, in the clear. Only ever returned to the owner (`listFacts`). */
  text: string;
  /** Fingerprint hash of the capturing turn. A digest, never content. */
  provenance: string;
  createdAt: string;
  updatedAt: string;
};

/** What one capture observation asks the store to record. */
export type FactCandidate = {
  category: FactCategory;
  /** The fact text, in the clear; encrypted before it lands in a row. */
  text: string;
  /** Fingerprint-style hash of the turn that taught it. */
  provenance: string;
  /** ISO 8601 write time; defaults to now. Injectable for tests. */
  now?: string;
};

/** The per-key kill switch (ADR-017), default on. */
export type FactSettings = {
  keyHash: string;
  enabled: boolean;
};

export type FactStore = {
  /** Encrypts `candidate.text` and inserts a fact. Returns the stored row. */
  putFact(keyHash: string, candidate: FactCandidate, enc: Encryptor): Promise<FactRow>;
  /** Every fact this key stored, newest first, decrypted for the owner. */
  listFacts(keyHash: string, enc: Encryptor): Promise<FactRow[]>;
  /** True when the row existed *and* belonged to this key. Needs no crypto. */
  deleteFact(keyHash: string, id: string): Promise<boolean>;
  /** The kill switch; on for a key that never wrote a row. */
  getFactSettings(keyHash: string): Promise<FactSettings>;
  setFactSettings(keyHash: string, patch: { enabled: boolean }): Promise<FactSettings>;
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** A provenance is a fingerprint-style hex digest, exactly as ADR-011's. */
const PROVENANCE = /^[0-9a-f]{8,128}$/;

/** The longest fact text the store will keep; a fact is a fact, not a document. */
export const FACT_TEXT_MAX_CHARS = 2_000;

/**
 * Guards every write: hash-keyed, a real category, a non-empty and bounded
 * text, and a digest provenance. The text is the one field that is content,
 * so it is length-checked but never inspected further -- the store's job is to
 * encrypt it, not to read it.
 */
export function assertFactCandidate(keyHash: string, candidate: FactCandidate): void {
  assertKeyHash(keyHash);
  if (!isFactCategory(candidate.category)) {
    throw new Error(`fact store: unknown category "${candidate.category}"`);
  }
  if (typeof candidate.text !== "string" || candidate.text.trim().length === 0) {
    throw new Error("fact store: a fact must have non-empty text");
  }
  if (candidate.text.length > FACT_TEXT_MAX_CHARS) {
    throw new Error(`fact store: fact text exceeds ${FACT_TEXT_MAX_CHARS} characters`);
  }
  if (!PROVENANCE.test(candidate.provenance)) {
    throw new Error(
      "fact store: provenance must be a fingerprint-style hex digest, never content or a key",
    );
  }
}
