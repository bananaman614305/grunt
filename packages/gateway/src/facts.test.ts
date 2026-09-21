/**
 * Personal-fact capture and the relevance gate, gateway side (ADR-017),
 * driven with a real in-memory `DecisionLog`, a reversible encryptor, and a
 * programmable Jev stub -- no HTTP, no network.
 *
 * The load-bearing test is the last one in "routedFacts": a RELEVANT fact is
 * appended to the outgoing body, an IRRELEVANT one is NOT. That is the ADR's
 * cost-and-privacy claim proven end to end through the gateway helpers -- an
 * irrelevant fact never reaches the model and never grows the prompt.
 */

import { describe, expect, it } from "vitest";
import { DecisionLog, relevanceKey } from "@milo/core";
import type { ChatMessage, EmbedClientLike, EmbeddingVector, Encryptor, JevAnswer, JevClientLike, SystemOneResult } from "@milo/core";
import { applyFactNote, maybeCaptureFact, routedFacts } from "./facts.js";

const HASH = "a".repeat(64);
const PROV = "0123456789abcdef";

const enc: Encryptor = {
  encrypt: (p) => `ENC(${Buffer.from(p, "utf8").toString("base64")})`,
  decrypt: (s) => Buffer.from(/^ENC\((.*)\)$/.exec(s)?.[1] ?? "", "base64").toString("utf8"),
};

/** A Jev stub that answers from a fixed map keyed by the questions it is asked. */
function stubJev(answersFor: (keys: string[]) => Record<string, JevAnswer>): JevClientLike {
  return {
    async systemone(req): Promise<SystemOneResult> {
      return {
        model: "jev-latest",
        answers: answersFor(Object.keys(req.questions)),
        usage: { input_tokens: 1, output_tokens: 1 },
        requestId: "req-test",
        latencyMs: 1,
      };
    },
  };
}

/** A stub that records the per-call `apiKey` opt each systemone call saw. */
function keyRecordingJev(
  answersFor: (keys: string[]) => Record<string, JevAnswer>,
): JevClientLike & { keys: Array<string | undefined> } {
  const keys: Array<string | undefined> = [];
  return {
    keys,
    async systemone(req, opts): Promise<SystemOneResult> {
      keys.push(opts?.apiKey);
      return {
        model: "jev-latest",
        answers: answersFor(Object.keys(req.questions)),
        usage: { input_tokens: 1, output_tokens: 1 },
        requestId: "req-test",
        latencyMs: 1,
      };
    },
  };
}

const noul = (v: number): JevAnswer => ({ type: "noul", noul: v });
const choice = (c: string, conf: number): JevAnswer => ({ type: "choice", choice: c, confidence: conf, probabilities: { [c]: conf } });

const userTurn = (text: string): ChatMessage[] => [{ role: "user", content: text }];

describe("maybeCaptureFact", () => {
  it("stores an encrypted fact when the latest turn states one", async () => {
    const log = await DecisionLog.open(":memory:");
    const jev = stubJev(() => ({ fact_stated: noul(0.95), fact_category: choice("identifier", 0.9) }));

    const row = await maybeCaptureFact(log, jev, enc, {
      keyHash: HASH,
      messages: userTurn("remember that my deploy account is acct_4Q7"),
      provenance: PROV,
    });
    expect(row?.category).toBe("identifier");

    const facts = await log.listFacts(HASH, enc);
    expect(facts.map((f) => f.text)).toEqual(["my deploy account is acct_4Q7"]);
    await log.close();
  });

  it("threads the forwarded Jev key to the capture call under openrouter (ADR-022)", async () => {
    const log = await DecisionLog.open(":memory:");
    const jev = keyRecordingJev(() => ({ fact_stated: noul(0.95), fact_category: choice("identifier", 0.9) }));

    await maybeCaptureFact(log, jev, enc, {
      keyHash: HASH,
      messages: userTurn("remember that my deploy account is acct_4Q7"),
      provenance: PROV,
      jevKey: "sk-or-v1-forwarded",
    });
    expect(jev.keys).toEqual(["sk-or-v1-forwarded"]);

    const jev2 = keyRecordingJev(() => ({ fact_stated: noul(0.95), fact_category: choice("identifier", 0.9) }));
    await maybeCaptureFact(log, jev2, enc, {
      keyHash: HASH,
      messages: userTurn("remember that my deploy account is acct_4Q7"),
      provenance: PROV,
    });
    expect(jev2.keys).toEqual([undefined]); // TypeSafe default: Milo's key
    await log.close();
  });

  it("no-ops with the kill switch off, and with no encryptor", async () => {
    const log = await DecisionLog.open(":memory:");
    const jev = stubJev(() => ({ fact_stated: noul(0.95), fact_category: choice("identifier", 0.9) }));
    const opts = { keyHash: HASH, messages: userTurn("remember X is Y"), provenance: PROV };

    await log.setFactSettings(HASH, { enabled: false });
    expect(await maybeCaptureFact(log, jev, enc, opts)).toBeUndefined();

    await log.setFactSettings(HASH, { enabled: true });
    expect(await maybeCaptureFact(log, jev, undefined, opts)).toBeUndefined(); // no envelope
    expect(await log.listFacts(HASH, enc)).toEqual([]);
    await log.close();
  });
});

describe("routedFacts + applyFactNote", () => {
  async function seed(): Promise<DecisionLog> {
    const log = await DecisionLog.open(":memory:");
    await log.putFact(HASH, { category: "address", text: "my staging box is 10.2.0.7", provenance: PROV }, enc);
    await log.putFact(
      HASH,
      { category: "contact", text: "my co-founder is Dana, she owns billing", provenance: PROV },
      enc,
    );
    return log;
  }

  it("threads the forwarded Jev key to the relevance call under openrouter (ADR-022)", async () => {
    const log = await seed();
    const facts = await log.listFacts(HASH, enc);
    const answers = Object.fromEntries(facts.map((f) => [relevanceKey(f.id), noul(0.99)]));
    const jev = keyRecordingJev(() => answers);

    await routedFacts(log, jev, enc, {
      keyHash: HASH,
      messages: userTurn("what is the ip of my staging server?"),
      jevKey: "sk-or-v1-forwarded",
    });
    expect(jev.keys).toEqual(["sk-or-v1-forwarded"]);
    await log.close();
  });

  it("appends the RELEVANT fact and NOT the irrelevant one", async () => {
    const log = await seed();
    const facts = await log.listFacts(HASH, enc);
    const addrId = facts.find((f) => f.category === "address")?.id ?? "";
    const personId = facts.find((f) => f.category === "contact")?.id ?? "";

    // Jev: staging-box relevant, co-founder not.
    const jev = stubJev(() => ({
      [relevanceKey(addrId)]: noul(0.9),
      [relevanceKey(personId)]: noul(0.05),
    }));

    const result = await routedFacts(log, jev, enc, {
      keyHash: HASH,
      messages: userTurn("what is the ip of my staging server?"),
    });
    expect(result?.count).toBe(1);

    const body = applyFactNote({ messages: userTurn("...") }, result);
    const systemNote = (body["messages"] as ChatMessage[]).at(-1);
    expect(systemNote?.role).toBe("system");
    expect(String(systemNote?.content)).toContain("10.2.0.7"); // relevant fact injected
    expect(JSON.stringify(body)).not.toContain("Dana"); // irrelevant fact NOT injected
    await log.close();
  });

  it("injects nothing on low posture, opt-out, kill switch off, or no facts", async () => {
    const log = await seed();
    const facts = await log.listFacts(HASH, enc);
    const jev = stubJev(() => Object.fromEntries(facts.map((f) => [relevanceKey(f.id), noul(0.99)])));
    const base = { keyHash: HASH, messages: userTurn("anything") };

    expect(await routedFacts(log, jev, enc, { ...base, skip: true })).toBeUndefined(); // low posture
    expect(await routedFacts(log, jev, enc, { ...base, extension: { facts: false } })).toBeUndefined(); // opt-out
    expect(await routedFacts(log, jev, undefined, base)).toBeUndefined(); // no envelope

    await log.setFactSettings(HASH, { enabled: false });
    expect(await routedFacts(log, jev, enc, base)).toBeUndefined(); // kill switch
    await log.close();
  });
});

// --- Two-stage retrieval (ADR-018) -----------------------------------------

/** An embed stub: fixed vectors by text, a zero vector for anything else. */
function stubEmbed(map: Record<string, EmbeddingVector>): EmbedClientLike {
  return { async embed(texts) { return texts.map((t) => map[t] ?? [0, 0]); } };
}

/** A Jev stub that also records every systemone call and the keys it saw. */
function spyJev(answersFor: (keys: string[]) => Record<string, JevAnswer>): {
  jev: JevClientLike;
  calls: string[][];
} {
  const calls: string[][] = [];
  const jev: JevClientLike = {
    async systemone(req): Promise<SystemOneResult> {
      const keys = Object.keys(req.questions);
      calls.push(keys);
      return {
        model: "jev-latest",
        answers: answersFor(keys),
        usage: { input_tokens: 1, output_tokens: 1 },
        requestId: "req-test",
        latencyMs: 1,
      };
    },
  };
  return { jev, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

describe("routedFacts two-stage retrieval (ADR-018)", () => {
  const STAGING = "my staging box is 10.2.0.7";
  const COFOUNDER = "my co-founder is Dana, she owns billing";

  async function seedVectored(): Promise<{ log: DecisionLog; stagingId: string; cofounderId: string }> {
    const log = await DecisionLog.open(":memory:");
    const s = await log.putFact(HASH, { category: "address", text: STAGING, provenance: PROV, embedding: [1, 0] }, enc);
    const c = await log.putFact(HASH, { category: "contact", text: COFOUNDER, provenance: PROV, embedding: [0, 1] }, enc);
    return { log, stagingId: s.id, cofounderId: c.id };
  }

  it("asks Jev only about the facts the pre-filter kept", async () => {
    const { log, stagingId, cofounderId } = await seedVectored();
    const { jev, calls } = spyJev(() => ({ [relevanceKey(stagingId)]: noul(0.9) }));

    const result = await routedFacts(log, jev, enc, {
      keyHash: HASH,
      messages: userTurn("what is the ip of my staging server?"),
      embed: stubEmbed({}),
      promptEmbedding: Promise.resolve([1, 0]), // aligned with STAGING, orthogonal to COFOUNDER
    });

    expect(result?.count).toBe(1);
    expect(calls).toHaveLength(1); // one relevance call...
    expect(calls[0]).toEqual([relevanceKey(stagingId)]); // ...about the near fact only
    expect(calls[0]).not.toContain(relevanceKey(cofounderId)); // the far fact never reached Jev
    await log.close();
  });

  it("spends ZERO Jev calls when nothing clears the similarity floor", async () => {
    const { log } = await seedVectored();
    const { jev, calls } = spyJev(() => ({}));

    const result = await routedFacts(log, jev, enc, {
      keyHash: HASH,
      messages: userTurn("an utterly unrelated question about the weather"),
      embed: stubEmbed({}),
      promptEmbedding: Promise.resolve([1, 0, 0]), // orthogonal to both 2-D facts -> mismatch -> 0 sim
    });

    // The query is orthogonal to every stored vector, so the candidate set is
    // empty and the gate returns without ever asking Jev.
    expect(result).toBeUndefined();
    expect(calls).toHaveLength(0);
    await log.close();
  });

  it("fails open: a fact with no vector is still asked about even with a query", async () => {
    const log = await DecisionLog.open(":memory:");
    // No embedding on this fact.
    const row = await log.putFact(HASH, { category: "address", text: STAGING, provenance: PROV }, enc);
    const { jev, calls } = spyJev(() => ({ [relevanceKey(row.id)]: noul(0.9) }));

    const result = await routedFacts(log, jev, enc, {
      keyHash: HASH,
      messages: userTurn("what is my staging ip?"),
      embed: stubEmbed({ [STAGING]: [1, 0] }),
      promptEmbedding: Promise.resolve([0, 1]), // orthogonal, but the fact is unvectored -> passes through
    });

    expect(result?.count).toBe(1);
    expect(calls[0]).toEqual([relevanceKey(row.id)]);
    await log.close();
  });

  it("backfills a missing vector off the response path", async () => {
    const log = await DecisionLog.open(":memory:");
    const row = await log.putFact(HASH, { category: "address", text: STAGING, provenance: PROV }, enc);
    const { jev } = spyJev(() => ({ [relevanceKey(row.id)]: noul(0.1) }));

    await routedFacts(log, jev, enc, {
      keyHash: HASH,
      messages: userTurn("hello"),
      embed: stubEmbed({ [STAGING]: [0.6, 0.8] }),
      promptEmbedding: Promise.resolve([1, 0]),
    });

    await flush(); // let the fire-and-forget backfill settle
    const [stored] = await log.listFacts(HASH, enc);
    expect(stored!.embedding).toEqual([0.6, 0.8]);
    await log.close();
  });

  it("falls back to all facts when no embedding is available (pre-ADR-018 behaviour)", async () => {
    const { log, stagingId, cofounderId } = await seedVectored();
    const { jev, calls } = spyJev((keys) => Object.fromEntries(keys.map((k) => [k, noul(0.99)])));

    // No embed client and no promptEmbedding: query is undefined, so every fact
    // is a candidate and the gate behaves exactly as ADR-017 shipped.
    const result = await routedFacts(log, jev, enc, { keyHash: HASH, messages: userTurn("anything") });
    expect(result?.count).toBe(2);
    expect(calls[0]!.sort()).toEqual([relevanceKey(stagingId), relevanceKey(cofounderId)].sort());
    await log.close();
  });
});

describe("maybeCaptureFact stores an embedding (ADR-018)", () => {
  it("embeds the captured fact text when an embed client is present", async () => {
    const log = await DecisionLog.open(":memory:");
    const jev = stubJev(() => ({ fact_stated: noul(0.95), fact_category: choice("identifier", 0.9) }));

    const row = await maybeCaptureFact(log, jev, enc, {
      keyHash: HASH,
      messages: userTurn("remember that my deploy account is acct_4Q7"),
      provenance: PROV,
      embed: stubEmbed({ "my deploy account is acct_4Q7": [0.2, 0.9] }),
    });
    expect(row).toBeDefined();

    const [stored] = await log.listFacts(HASH, enc);
    expect(stored!.embedding).toEqual([0.2, 0.9]);
    await log.close();
  });

  it("still stores the fact (without a vector) when embedding fails", async () => {
    const log = await DecisionLog.open(":memory:");
    const jev = stubJev(() => ({ fact_stated: noul(0.95), fact_category: choice("identifier", 0.9) }));
    const throwing: EmbedClientLike = { async embed() { throw new Error("embeddings down"); } };

    const row = await maybeCaptureFact(log, jev, enc, {
      keyHash: HASH,
      messages: userTurn("remember that my deploy account is acct_4Q7"),
      provenance: PROV,
      embed: throwing,
    });
    expect(row).toBeDefined();
    const [stored] = await log.listFacts(HASH, enc);
    expect(stored!.text).toBe("my deploy account is acct_4Q7");
    expect(stored!.embedding).toBeUndefined(); // fail-open: stored, just unvectored
    await log.close();
  });
});
