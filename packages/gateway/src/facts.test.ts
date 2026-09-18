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
import type { ChatMessage, Encryptor, JevAnswer, JevClientLike, SystemOneResult } from "@milo/core";
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
