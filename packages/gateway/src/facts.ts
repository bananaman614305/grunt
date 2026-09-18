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
  selectRelevantFacts,
} from "@milo/core";
import type {
  ChatMessage,
  Encryptor,
  FactRow,
  FactStore,
  InjectableFact,
  JevClientLike,
  MiloRequestExtension,
} from "@milo/core";
import { FACT_CAPTURE_QUESTIONS } from "@milo/core";
import type { Logger } from "./app.js";
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
  budgetMs?: number;
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
      { budgetMs: opts.budgetMs ?? FACT_CAPTURE_BUDGET_MS },
    );

    const captured = resolveFactCapture(result.answers, message);
    if (captured === undefined) return undefined;

    const row = await store.putFact(
      opts.keyHash,
      { category: captured.category, text: captured.text, provenance: opts.provenance },
      enc,
    );
    // Category and id only -- never the fact text (ADR-017).
    opts.logger?.info("captured fact", { id: row.id, category: row.category });
    return row;
  } catch (err) {
    opts.logger?.warn("fact capture failed", { error: errorMessage(err) });
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
  budgetMs?: number;
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

    const facts: InjectableFact[] = rows.map((row) => ({ id: row.id, category: row.category, text: row.text }));
    const { state } = buildJevState(opts.messages);
    const result = await jev.systemone(
      { state, questions: factRelevanceQuestions(facts) },
      { budgetMs: opts.budgetMs ?? FACT_RELEVANCE_BUDGET_MS },
    );

    const relevant = selectRelevantFacts(result.answers, facts);
    const note = compileFactNote(relevant);
    if (note === undefined) return undefined;
    return { note, count: relevant.length };
  } catch (err) {
    opts.logger?.warn("fact relevance gate failed", { error: errorMessage(err) });
    return undefined;
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
