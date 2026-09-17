/**
 * The four questions Milo asks Jev about every routed conversation.
 *
 * This file is the routing prompt. Milo's users run agents that orchestrate
 * other agents, so most "conversations" are really sub-agent briefs: a long
 * system prompt, a tool list, and one instruction. The criteria below are
 * written for that shape, not for chat, and describe the *work requested*
 * rather than the size or tone of the prompt.
 *
 * Changing this wording changes routing. Re-run `pnpm eval` after any edit and
 * bump POLICY_VERSION if the policy thresholds move with it (ADR-002).
 */

import type { JevChoiceQuestion, JevNoulQuestion, JevQuestion, JevScoreQuestion } from "../jev/types.js";
import type { TASK_TYPES } from "../types.js";

/** The keys of the answers the router reads back. */
export const QUESTION_KEYS = ["task_type", "difficulty", "needs_reasoning", "long_output"] as const;
export type QuestionKey = (typeof QUESTION_KEYS)[number];

const TASK_TYPE_CRITERIA: Record<(typeof TASK_TYPES)[number], string> = {
  chat: "Open conversation with nothing to build or change: a question about an opinion, a greeting, brainstorming, or asking the agent what it thinks or what it just did.",
  edit: "A bounded change to code or text that already exists: rename a symbol, adjust a config value, apply a described diff, tidy formatting, move a function.",
  feature: "Build something that does not exist yet: a new module, endpoint, command, test suite, script, or capability, from a description of what it should do.",
  debug: "Find and fix something that is wrong: a failing test, a stack trace, a flaky job, a wrong result, a regression, or behaviour that does not match the spec.",
  research: "Gather and synthesize information before acting: read a codebase or docs to explain how something works, compare libraries or approaches, survey prior art, answer a question that needs investigation.",
  review: "Judge work that already exists: review a diff or pull request, audit for security or correctness, critique a design or a plan, check that an implementation matches its brief.",
  docs: "Write or revise prose describing a system: README, API reference, changelog, migration guide, code comments, an ADR or design write-up.",
  ops: "Run or configure the machinery around the code: builds, CI pipelines, deploys, dependency upgrades, database migrations, infrastructure, environment and tooling setup.",
  classify: "Mechanically label, extract, route, or reformat a given input: pick a category, pull fields out of text, summarize into a fixed shape, decide which sub-agent or tool should handle something.",
};

export const taskTypeQuestion: JevChoiceQuestion = {
  type: "choice",
  instructions:
    "This is a request sent to an AI coding agent, often a sub-agent inside a larger orchestration. Classify the kind of work it asks for. Judge the work requested by the latest user turn; the system prompt, tools, and earlier turns are context that describes the agent's role. If the request covers several kinds of work, choose the one that dominates the output the agent must produce.",
  criteria: TASK_TYPE_CRITERIA,
};

export const difficultyQuestion: JevScoreQuestion = {
  type: "score",
  instructions:
    "How hard is this request for a competent AI coding agent? Rate the work asked for, not the length of the prompt: a long brief with one mechanical instruction is easy, and a short question that asks for an architectural decision is hard. Ignore how politely or vaguely it is phrased.",
  criteria: [
    "Trivial: a one-line answer or a lookup. Rename a symbol, read a value out of a file, restate something already in the prompt, reformat text, answer a factual question. There is one obvious right answer and no judgment is involved.",
    "Routine: a small self-contained change or a short answer. One or two files, a familiar pattern, an obvious test, or an explanation of well-known material. Judgment is limited to local naming and style.",
    "Substantial: the work spans several files or needs design judgment. Choosing between reasonable approaches, refactoring across modules, writing a non-obvious algorithm, reviewing a real diff, or investigating a bug whose cause is not yet known.",
    "Hard: concurrency, correctness-critical or security-sensitive logic, an architecture other work will depend on, subtle debugging across layers, or deep research in an unfamiliar system. A wrong answer is expensive and easy to miss.",
  ],
};

export const needsReasoningQuestion: JevNoulQuestion = {
  type: "noul",
  instructions:
    "Would answering this well require the agent to work through the problem step by step before it can produce the output, rather than writing the answer directly?",
  criteria: {
    true: "The answer has to be derived: trace state or control flow through code, plan a change across several steps, weigh trade-offs between designs, reason from evidence to a root cause, or satisfy several constraints at once.",
    false: "The answer can be produced directly from what the prompt already states or from ordinary recall: a lookup, a mechanical edit, a formatting or naming change, a restatement, boilerplate, or a familiar single-step task.",
  },
};

export const longOutputQuestion: JevNoulQuestion = {
  type: "noul",
  instructions:
    "How long will the agent's reply be? Estimate the size of the output it must produce, not the size of the prompt it was given.",
  criteria: {
    true: "The reply will likely exceed about 2,000 tokens, which is roughly 250 lines of code or 1,500 words: a whole new file or module, several files at once, a full document, an exhaustive review, or a long structured report.",
    false: "The reply will likely stay under about 2,000 tokens: a focused patch, a short explanation, a direct answer, a single function, a handful of edits, or a label.",
  },
};

/** The question set for one `/v1/systemone` call. Keys are the answer keys. */
export const ROUTER_QUESTIONS: Record<string, JevQuestion> = {
  task_type: taskTypeQuestion,
  difficulty: difficultyQuestion,
  needs_reasoning: needsReasoningQuestion,
  long_output: longOutputQuestion,
};
