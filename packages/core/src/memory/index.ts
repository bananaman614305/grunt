/**
 * Personal-fact memory (ADR-017): the encrypted fact store's contract, the
 * Jev capture questions and resolver, and the relevance gate. The store's
 * methods live on `DecisionLog` (one database, one migration path), exactly
 * as the preference and roster stores do.
 */

export {
  FACT_CATEGORIES,
  FACT_TEXT_MAX_CHARS,
  assertFactCandidate,
  isFactCategory,
} from "./store.js";
export type {
  Encryptor,
  FactCandidate,
  FactCategory,
  FactRow,
  FactSettings,
  FactStore,
} from "./store.js";

export {
  FACT_CAPTURE_QUESTIONS,
  FACT_CATEGORY_CHOICES,
  FACT_CATEGORY_CONFIDENCE_THRESHOLD,
  FACT_CATEGORY_KEY,
  FACT_DETECTION_THRESHOLD,
  FACT_STATED_KEY,
  NO_FACT_CATEGORY,
  extractFactText,
  factCategoryQuestion,
  factStatedQuestion,
  latestUserText,
  resolveFactCapture,
} from "./capture.js";
export type { CapturedFact } from "./capture.js";

export {
  FACT_NOTE_CHAR_CAP,
  FACT_RELEVANCE_THRESHOLD,
  compileFactNote,
  factRelevanceQuestions,
  relevanceKey,
  selectRelevantFacts,
} from "./inject.js";
export type { InjectableFact } from "./inject.js";

export {
  RETRIEVAL_SIM_FLOOR,
  RETRIEVAL_TOP_K,
  cosineSimilarity,
  selectCandidates,
  unvectoredIds,
} from "./embed.js";
export type {
  EmbedClientLike,
  EmbeddableFact,
  EmbeddingVector,
  ScoredCandidate,
  SelectOptions,
} from "./embed.js";
