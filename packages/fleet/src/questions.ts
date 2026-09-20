/**
 * The questions the supervisor asks Jev about a running worker (ADR-015).
 *
 * This is Milo's structural edge over a process-liveness fleet: because every
 * worker's model traffic already flows through Milo, the supervisor can hand
 * Jev a description of what a worker has been *doing* -- its recent turns and
 * tool calls, how long it has been quiet, whether any edit has landed -- and
 * ask, in content terms, whether it is making progress, spinning, stuck, or
 * finished. A supervisor that only watches the OS process cannot tell a worker
 * thinking hard from a worker looping forever; both are "alive".
 *
 * The wording follows `packages/core/src/router/questions.ts`: describe the
 * work, not the prose. Changing it changes supervision verdicts -- re-check the
 * fixture event streams in `supervisor.test.ts` after any edit.
 *
 * The state these questions grade is the coarse summary built by
 * `summarizeWindow` in `supervisor.ts`: counts and gaps, never message
 * content, so no worker output rides into the supervision call.
 */

import type { JevChoiceQuestion, JevNoulQuestion, JevQuestion } from "@milo/core";
import { WORKER_VERDICTS, type WorkerVerdict } from "./types.js";

/** The answer keys the supervisor reads back from one supervision call. */
export const SUPERVISION_KEYS = ["worker_state", "needs_human"] as const;
export type SupervisionKey = (typeof SUPERVISION_KEYS)[number];

const WORKER_STATE_CRITERIA: Record<WorkerVerdict, string> = {
  progressing:
    "The worker is doing useful, varied work toward the task: a mix of reads and edits, tool calls that advance rather than repeat, output that builds on the last turn, and edits that have started to land. Recent activity looks like forward motion.",
  idle:
    "The worker has gone quiet without finishing: little or no recent activity, a long gap since the last turn or tool call, no diff produced yet, and nothing that looks like deliberate long work. It looks stalled or waiting rather than thinking.",
  wedged:
    "The worker is active but stuck: the same or nearly the same tool calls repeat with no new ground covered, it retries the same failing action, cycles between a small set of files, or produces turns that restate earlier ones. Effort is being spent but the task is not advancing.",
  done:
    "The worker has finished the task: a diff has landed, recent activity has wound down to verification or a summary, and there is no sign of further work planned. The worktree carries a coherent change that answers the assignment.",
};

/**
 * The core classifier. A `choice` so the verdict arrives already typed with a
 * confidence and a probability over the four states; the fleet routes on the
 * verdict and escalates the low-confidence ones.
 */
export const workerStateQuestion: JevChoiceQuestion = {
  type: "choice",
  instructions:
    "Below is a summary of what one autonomous coding worker has been doing recently: how many turns and tool calls it has made in the window, which tools and how often, how long since its last activity, and whether it has produced any file edits. It is one worker in a parallel fleet, running unattended. Judge its current state from this activity. Weigh repetition and lack of new ground heavily -- a worker can look busy while making no progress. Judge the work, not the volume of it.",
  criteria: WORKER_STATE_CRITERIA,
};

/**
 * The attention gate. Separate from the verdict because a worker can be
 * `wedged` in a way it will retry out of, or `progressing` yet blocked on a
 * decision only a person can make. The fleet surfaces a true answer here in
 * `needsAttention()` regardless of the verdict.
 */
export const needsHumanQuestion: JevNoulQuestion = {
  type: "noul",
  instructions:
    "Given the same activity summary, does this worker need a human to intervene now, rather than more time or an automatic nudge? Answer for whether a person must step in, not for whether the worker is merely slow.",
  criteria: {
    true: "The worker is blocked on something automation cannot resolve: it needs a decision, a credential, an ambiguous requirement clarified, or it is repeating a failing action that will not succeed on retry. Waiting longer will not help.",
    false: "The worker is progressing, or is stuck in a way a nudge, a retry, or simply more time could clear. No human decision is required yet.",
  },
};

/** The question set for one supervision `/v1/systemone` call. Keys are answer keys. */
export const SUPERVISION_QUESTIONS: Record<string, JevQuestion> = {
  worker_state: workerStateQuestion,
  needs_human: needsHumanQuestion,
};

/** Type guard: is a raw choice string one of the four worker verdicts. */
export function isWorkerVerdict(value: string): value is WorkerVerdict {
  return (WORKER_VERDICTS as readonly string[]).includes(value);
}
