/**
 * Personal-fact memory, gateway side (ADR-017): the fire-and-forget capture
 * sibling of preference capture, the relevance gate that runs before a routed
 * request is forwarded, and the note it appends.
 *
 * The whole feature hangs off one injected `Encryptor` (`deps.factMemory`),
 * which the gateway builds from the billing AES-256-GCM envelope keyed by
 * `MILO_ENCRYPTION_KEY` -- the same key and path that protect the account's
 * OpenRouter sub-key. When it is absent (billing, and thus the key, is not
 * configured) the feature degrades to disabled: nothing is captured, nothing
 * is injected. That is the ADR's documented degradation -- a fact store with
 * no envelope must not store plaintext, so it stores nothing.
 *
 * Nothing here can fail or delay a request: capture is fire-and-forget, and
 * the relevance gate logs and swallows every failure, injecting nothing.
 * Nothing here logs fact content: the capture log line carries the category
 * and a count only, never the text, and the decision log stays content-free.
 */

import {
  buildJevState,
  compileFactNote,
  factRelevanceQuestions,
  latestUserText,
  resolveFactCapture,
  selectCandidates,
  selectRelevantFacts,
  unvectoredIds,
} from "@milo/core";
import type {
  ChatMessage,
  EmbedClientLike,
  EmbeddableFact,
  EmbeddingVector,
  Encryptor,
  FactRow,
  FactStore,
  InjectableFact,
  JevClientLike,
  MiloRequestExtension,
} from "@milo/core";
import { FACT_CAPTURE_QUESTIONS } from "@milo/core";
import type { Logger } from "./app.js";
import { embedOne } from "./embed.js";
import { errorMessage } from "./errors.js";
import type { Body } from "./routes/shared.js";

/** Discloses how many stored facts this routed response was given. */
export const FACTS_INJECTED_HEADER = "x-milo-facts-injected";

/**
 * Budget for the capture and relevance calls, retries included. Generous for
 * capture (nothing waits on it); the relevance gate runs before the forward,
 * so it is kept tight and its failure simply injects nothing.
 */
export const FACT_CAPTURE_BUDGET_MS = 5_000;
export const FACT_RELEVANCE_BUDGET_MS = 2_000;

export type FactCaptureOptions = {
  /** The caller's identity: `callerScope(c)`, never a credential. */
  keyHash: string;
  messages: ChatMessage[];
  /** The decision's fingerprint: the stored fact's provenance. */
  provenance: string;
  /**
   * The embedding client (ADR-018), bound to the caller's forwarded key. When
   * present, the captured fact's text is embedded once at storage so the
   * retrieval pre-filter can rank it later without a Jev call. Fail-open: if
   * embedding fails the fact is still stored, just without a vector, and it
   * fails open through the pre-filter until a backfill supplies one.
   */
  embed?: EmbedClientLike;
  budgetMs?: number;
  /**
   * The caller's forwarded OpenRouter key (ADR-022): under the `"openrouter"`
   * Jev transport it authenticates this capture call so it bills to the user's
   * key, never Milo's `JEV_API_KEY`. Absent under the TypeSafe transport, where
   * Milo's key is used.
   */
  jevKey?: string;
  logger?: Logger;
};

/**
 * Detects and stores a durable personal fact from the latest user turn, when
 * the key's kill switch is on. One Jev call (classification only) decides
 * whether to remember and under which category; the fact text is lifted from
 * the user's own message and encrypted before it lands in a row. Resolves the
 * stored row, or undefined for every no-op and failure path.
 */
export async function maybeCaptureFact(
  store: FactStore,
  jev: JevClientLike | undefined,
  enc: Encryptor | undefined,
  opts: FactCaptureOptions,
): Promise<FactRow | undefined> {
  if (jev === undefined || enc === undefined) return undefined;

  try {
    const settings = await store.getFactSettings(opts.keyHash);
    if (!settings.enabled) return undefined;

    const message = latestUserText(opts.messages);
    if (message.length === 0) return undefined;

    const { state } = buildJevState(opts.messages);
    const result = await jev.systemone(
      { state, questions: FACT_CAPTURE_QUESTIONS },
      {
        budgetMs: opts.budgetMs ?? FACT_CAPTURE_BUDGET_MS,
        ...(opts.jevKey !== undefined && opts.jevKey !== "" ? { apiKey: opts.jevKey } : {}),
      },
    );

    const captured = resolveFactCapture(result.answers, message);
    if (captured === undefined) return undefined;

    // Embed the fact text once, at storage (ADR-018), so retrieval can later
    // rank it locally. Fail-open: a failed embedding stores the fact without a
    // vector rather than dropping it. This is the one point a fact's text is
    // sent to the embedding provider, disclosed in the ADR.
    const embedding = await embedOne(opts.embed, captured.text, opts.logger);

    const candidate = { category: captured.category, text: captured.text, provenance: opts.provenance } as {
      category: typeof captured.category;
      text: string;
      provenance: string;
      embedding?: EmbeddingVector;
    };
    if (embedding !== undefined) candidate.embedding = embedding;
    const row = await store.putFact(opts.keyHash, candidate, enc);
    // Category and id only -- never the fact text (ADR-017).
    opts.logger?.info("captured fact", { id: row.id, category: row.category });
    return row;
  } catch (err) {
    opts.logger?.warn("fact capture failed", { error: errorMessage(err) });
    return undefined;
  }
}

/**
 * The turn's retrieval embedding, prepared in parallel with routing (ADR-018),
 * or undefined when there is nothing to retrieve against. It first makes the
 * cheap, decrypt-free checks -- retrieval on for this key, at least one fact
 * stored -- and only then embeds the turn, so a caller with no facts pays for
 * no embedding call. The result feeds `routedFacts.promptEmbedding`; the whole
 * thing fails open to undefined, which the gate reads as "ask Jev about every
 * fact". Kicked off before `router.route`, its ~50 ms hides under the route.
 */
export async function prepareQueryEmbedding(
  store: FactStore,
  embed: EmbedClientLike | undefined,
  opts: { keyHash: string; messages: ChatMessage[]; logger?: Logger },
): Promise<EmbeddingVector | undefined> {
  if (embed === undefined) return undefined;
  try {
    const settings = await store.getFactSettings(opts.keyHash);
    if (!settings.enabled) return undefined;
    if ((await store.countFacts(opts.keyHash)) === 0) return undefined;
    return await embedOne(embed, latestUserText(opts.messages), opts.logger);
  } catch (err) {
    opts.logger?.warn("query embedding prep failed; falling open", { error: errorMessage(err) });
    return undefined;
  }
}

export type RoutedFacts = {
  /** The system note to append, already compiled. */
  note: string;
  /** How many facts it carries, for `x-milo-facts-injected`. */
  count: number;
};

export type RoutedFactsOptions = {
  keyHash: string;
  messages: ChatMessage[];
  extension?: MiloRequestExtension | undefined;
  /** `true` on `low` posture: the gate is skipped, like the brief and gates. */
  skip?: boolean;
  /**
   * The embedding client (ADR-018), bound to the caller's forwarded key. When
   * present, stage one of retrieval runs: the caller's facts are pre-ranked
   * locally against this turn and only the closest few reach the Jev gate. Its
   * absence, or any embedding failure, falls open to the ADR-017 behaviour of
   * asking Jev about every fact.
   */
  embed?: EmbedClientLike;
  /**
   * The turn's embedding, already in flight (ADR-018). The gateway kicks this
   * off in parallel with the routing Jev call so its ~50 ms hides under the
   * ~350 ms route; by the time this gate runs the vector is usually ready. When
   * omitted, the gate embeds the turn itself.
   */
  promptEmbedding?: Promise<EmbeddingVector | undefined>;
  budgetMs?: number;
  /**
   * The caller's forwarded OpenRouter key (ADR-022): under the `"openrouter"`
   * Jev transport it authenticates the relevance call so it bills to the user's
   * key, never Milo's `JEV_API_KEY`. Absent under the TypeSafe transport.
   */
  jevKey?: string;
  logger?: Logger;
};

/**
 * The relevance-gated fact note for this routed request, or undefined. Reads
 * the caller's decrypted facts, asks Jev which are relevant to *this* request
 * (one noul per fact), and compiles only the relevant ones into a single note.
 * If none are relevant -- or the caller opted out, the kill switch is off, the
 * posture is `low`, there are no facts, or anything fails -- nothing is
 * injected and no fact reaches the model. This is the ADR-017 privacy and cost
 * gate in one.
 */
export async function routedFacts(
  store: FactStore,
  jev: JevClientLike | undefined,
  enc: Encryptor | undefined,
  opts: RoutedFactsOptions,
): Promise<RoutedFacts | undefined> {
  if (jev === undefined || enc === undefined) return undefined;
  if (opts.skip === true) return undefined;
  if (opts.extension?.facts === false) return undefined;

  try {
    const settings = await store.getFactSettings(opts.keyHash);
    if (!settings.enabled) return undefined;

    const rows = await store.listFacts(opts.keyHash, enc);
    if (rows.length === 0) return undefined;

    // Stage one (ADR-018): the turn's embedding, either the one already in
    // flight (hidden under the routing call) or, failing that, embedded now.
    // A failure here resolves to undefined, which the pre-filter reads as
    // "fall open to every fact" -- exactly the pre-ADR-018 gate.
    const query =
      (opts.promptEmbedding !== undefined ? await opts.promptEmbedding : undefined) ??
      (await embedOne(opts.embed, latestUserText(opts.messages), opts.logger));

    const embeddable: EmbeddableFact[] = rows.map((row) => {
      const f: EmbeddableFact = { id: row.id, category: row.category, text: row.text };
      if (row.embedding !== undefined) f.embedding = row.embedding;
      return f;
    });

    // Backfill any missing vectors off the response path (ADR-018), so the
    // pre-filter grows complete and the Jev cost flattens. Fire-and-forget:
    // it never delays or fails this request. Skipped when embedding is
    // unavailable this request (query is undefined), since it would only fail.
    if (query !== undefined && opts.embed !== undefined) {
      void backfillEmbeddings(store, opts.embed, opts.keyHash, rows, opts.logger);
    }

    // The candidates worth a Jev question: the closest few by cosine, plus any
    // unvectored fact (fail-open). An empty set means nothing cleared the
    // similarity floor -- so this request spends ZERO Jev relevance calls, the
    // whole point of the two stages.
    const candidates: InjectableFact[] = selectCandidates(query, embeddable).map((c) => c.fact);
    if (candidates.length === 0) return undefined;

    const { state } = buildJevState(opts.messages);
    const result = await jev.systemone(
      { state, questions: factRelevanceQuestions(candidates) },
      {
        budgetMs: opts.budgetMs ?? FACT_RELEVANCE_BUDGET_MS,
        ...(opts.jevKey !== undefined && opts.jevKey !== "" ? { apiKey: opts.jevKey } : {}),
      },
    );

    const relevant = selectRelevantFacts(result.answers, candidates);
    const note = compileFactNote(relevant);
    if (note === undefined) return undefined;
    return { note, count: relevant.length };
  } catch (err) {
    opts.logger?.warn("fact relevance gate failed", { error: errorMessage(err) });
    return undefined;
  }
}

/**
 * Embeds every fact still missing a vector, in one batched call, and writes
 * each back (ADR-018). Fire-and-forget from the gate: it must never delay or
 * fail a response, so it swallows every error and touches nothing on the hot
 * path. After it runs, the caller's vault is fully vectored and the pre-filter
 * is in full force for the next request.
 */
async function backfillEmbeddings(
  store: FactStore,
  embed: EmbedClientLike,
  keyHash: string,
  rows: FactRow[],
  logger?: Logger,
): Promise<void> {
  try {
    const missing = unvectoredIds(
      rows.map((r) => {
        const f: EmbeddableFact = { id: r.id, category: r.category, text: r.text };
        if (r.embedding !== undefined) f.embedding = r.embedding;
        return f;
      }),
    );
    if (missing.length === 0) return;
    const byId = new Map(rows.map((r) => [r.id, r.text] as const));
    const texts = missing.map((id) => byId.get(id) ?? "");
    const vectors = await embed.embed(texts);
    if (vectors.length !== missing.length) return;
    for (let i = 0; i < missing.length; i++) {
      const id = missing[i] as string;
      const vec = vectors[i] as EmbeddingVector;
      await store.setFactEmbedding(keyHash, id, vec);
    }
    logger?.info("backfilled fact embeddings", { count: missing.length });
  } catch (err) {
    logger?.warn("fact embedding backfill failed", { error: errorMessage(err) });
  }
}

/**
 * Returns `body` with the fact note appended as a final system message, or the
 * body untouched when there is none. Never mutates the input, and touches no
 * field but `messages` -- ADR-017's amendment to the pass-through rule is
 * exactly this one appended message, alongside ADR-011's brief.
 */
export function applyFactNote(body: Body, facts: RoutedFacts | undefined): Body {
  if (facts === undefined) return body;
  const messages = Array.isArray(body["messages"]) ? (body["messages"] as ChatMessage[]) : [];
  return { ...body, messages: [...messages, { role: "system", content: facts.note }] };
}

/**
 * The disclosure header for injected facts. Empty when nothing was injected,
 * so the header's absence always means "no fact shaped this response".
 */
export function factHeaders(facts: RoutedFacts | undefined): Record<string, string> {
  return facts === undefined ? {} : { [FACTS_INJECTED_HEADER]: String(facts.count) };
}
