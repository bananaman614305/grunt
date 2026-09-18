/**
 * The personal-fact store (ADR-017), as implemented by `DecisionLog`.
 *
 * The invariants these tests exist for are the three non-negotiables the ADR
 * bakes in: the content is ENCRYPTED AT REST (the raw `content_encrypted`
 * column is ciphertext, never the fact text), the store is LISTABLE (decrypted
 * for the owner), and it is DELETABLE (scoped by key hash). Plus: the fact
 * text never touches the content-free decision log.
 */

import { createClient } from "@libsql/client";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DecisionLog } from "../log/decision-log.js";
import { assertFactCandidate } from "./store.js";
import type { Encryptor, FactCandidate } from "./store.js";

const HASH = createHash("sha256").update("Bearer sk-or-v1-fact-owner", "utf8").digest("hex");
const OTHER_HASH = createHash("sha256").update("Bearer sk-or-v1-someone-else", "utf8").digest("hex");
const PROVENANCE = "0123456789abcdef0123456789abcdef";

/**
 * A visible, reversible double for the billing envelope: the ciphertext is
 * obviously not the plaintext (a marked base64), so a raw column read proves
 * the store never wrote cleartext. Round-trips exactly.
 */
const fakeEnc: Encryptor = {
  encrypt: (plain) => `ENC(${Buffer.from(plain, "utf8").toString("base64")})`,
  decrypt: (stored) => {
    const m = /^ENC\((.*)\)$/.exec(stored);
    if (m === null) throw new Error("not a fake ciphertext");
    return Buffer.from(m[1] ?? "", "base64").toString("utf8");
  },
};

function candidate(overrides: Partial<FactCandidate> = {}): FactCandidate {
  return { category: "identifier", text: "my deploy account is acct_4Q7", provenance: PROVENANCE, ...overrides };
}

let dir: string;
let dbPath: string;
let log: DecisionLog;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "milo-facts-"));
  dbPath = join(dir, "milo.db");
  log = await DecisionLog.open(`file:${dbPath}`);
});

afterEach(async () => {
  await log.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("assertFactCandidate", () => {
  it("refuses a raw key as the hash", () => {
    expect(() => assertFactCandidate("sk-or-v1-x", candidate())).toThrow(/SHA-256/);
  });
  it("refuses an unknown category, empty text, and non-digest provenance", () => {
    expect(() => assertFactCandidate(HASH, candidate({ category: "nonsense" as never }))).toThrow(/category/);
    expect(() => assertFactCandidate(HASH, candidate({ text: "   " }))).toThrow(/non-empty/);
    expect(() => assertFactCandidate(HASH, candidate({ provenance: "the user said hi" }))).toThrow(/digest/);
  });
});

describe("putFact / listFacts", () => {
  it("stores the text as CIPHERTEXT at rest and returns it decrypted to the owner", async () => {
    const secret = "my staging box is 10.2.0.7 and the co-founder is Dana";
    const row = await log.putFact(HASH, candidate({ category: "address", text: secret }), fakeEnc);

    // Owner read: decrypted.
    const listed = await log.listFacts(HASH, fakeEnc);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: row.id, category: "address", text: secret, provenance: PROVENANCE });

    // Raw column read via a second client on the same file: NEVER the plaintext.
    const raw = createClient({ url: `file:${dbPath}` });
    const rs = await raw.execute({ sql: "SELECT content_encrypted FROM facts WHERE id = ?", args: [row.id] });
    const stored = String(rs.rows[0]?.content_encrypted);
    raw.close();
    expect(stored).toMatch(/^ENC\(/);
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain("10.2.0.7");
    expect(stored).not.toContain("Dana");
  });

  it("lists newest first and scopes strictly by key hash", async () => {
    await log.putFact(HASH, candidate({ text: "first" }), fakeEnc);
    await log.putFact(HASH, candidate({ text: "second" }), fakeEnc);
    await log.putFact(OTHER_HASH, candidate({ text: "not yours" }), fakeEnc);

    const mine = await log.listFacts(HASH, fakeEnc);
    expect(mine.map((f) => f.text)).toEqual(["second", "first"]);
    // Another key sees only its own.
    const theirs = await log.listFacts(OTHER_HASH, fakeEnc);
    expect(theirs.map((f) => f.text)).toEqual(["not yours"]);
  });
});

describe("deleteFact", () => {
  it("deletes only this caller's row, and 404-shapes a foreign or missing id", async () => {
    const mine = await log.putFact(HASH, candidate(), fakeEnc);

    expect(await log.deleteFact(OTHER_HASH, mine.id)).toBe(false); // not theirs
    expect(await log.listFacts(HASH, fakeEnc)).toHaveLength(1); // survived
    expect(await log.deleteFact(HASH, "01NOPE")).toBe(false); // missing
    expect(await log.deleteFact(HASH, mine.id)).toBe(true); // ours
    expect(await log.listFacts(HASH, fakeEnc)).toHaveLength(0);
  });
});

describe("the kill switch", () => {
  it("is on for a key that never wrote a row, and flips per key", async () => {
    expect((await log.getFactSettings(HASH)).enabled).toBe(true);
    await log.setFactSettings(HASH, { enabled: false });
    expect((await log.getFactSettings(HASH)).enabled).toBe(false);
    // Another key is unaffected.
    expect((await log.getFactSettings(OTHER_HASH)).enabled).toBe(true);
    await log.setFactSettings(HASH, { enabled: true });
    expect((await log.getFactSettings(HASH)).enabled).toBe(true);
  });
});

describe("the decision log stays content-free", () => {
  it("keeps no fact text in the decisions table", async () => {
    const secret = "my API profile is prod-west and the account is acct_ZZ9";
    await log.putFact(HASH, candidate({ text: secret }), fakeEnc);

    const raw = createClient({ url: `file:${dbPath}` });
    const decisions = await raw.execute("SELECT * FROM decisions");
    raw.close();
    expect(decisions.rows).toHaveLength(0); // storing a fact writes no decision

    let dump = "";
    for await (const line of log.exportJsonl()) dump += line;
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain("acct_ZZ9");
  });
});
