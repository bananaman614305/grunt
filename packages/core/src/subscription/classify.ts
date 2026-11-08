/**
 * Task classification for backend selection (ADR-031).
 *
 * Jev is used when Milo has a Jev key; without one, `heuristicClassify` reads
 * the last user turn with keyword rules so the router still works with no
 * remote call. The heuristic is deliberately simple: it only has to pick a
 * task family good enough to break ties between two frontier subscriptions.
 */

import { messageText } from "../router/context.js";
import { fingerprint } from "../router/fingerprint.js";
import type { Router } from "../router/router.js";
import type { ChatMessage, TaskType } from "../types.js";
import type { Classification, Classifier } from "./types.js";

type Rule = { type: TaskType; pattern: RegExp };

/** First match wins, so the more specific families come first. */
const RULES: Rule[] = [
  {
    type: "classify",
    pattern:
      /\b(classify|categori[sz]e|cluster|sentiment|label (this|these|each)|tag (this|these|each)|which category|what (programming )?language is this|one word|yes or no|conventional commits)\b|^\s*is (this|it) .{1,60}\bor\b/i,
  },
  {
    type: "docs",
    pattern:
      /\b(docstring|readme|documentation|reference docs|design docs?|jsdoc|changelog|release notes|contributing(\.md)?|migration guide|onboarding guide|write (a |an )?(short |one-line |brief )?(comment|guide|docs?|section))\b/i,
  },
  {
    type: "debug",
    pattern:
      /\b(traceback|stack ?trace|exception|segfault|panics?|throws|[a-z]*error\b:?|deadlocks?|oom|memory leak|leaks?|crash(es|ing)?|failing|broken|doesn'?t work|not working|duplicate rows|double-charg\w*|stale data|wrong tenant|regression|what'?s the fix|incident)\b/i,
  },
  {
    type: "review",
    pattern:
      /\b(review|code review|critique|look over|feedback on|audit|anything else\?|is this import unused|style guide|is this (code|approach) (ok|good|safe))\b/i,
  },
  {
    type: "ops",
    pattern:
      /\b(deploy(ment)?|docker(file)?|\.dockerignore|kubernetes|k8s|helm|nginx|terraform|ansible|systemd|cron(tab)?|ci( workflow| pipeline)?|ci\/cd|github actions|pipeline|dns|tls|load balancer|kubectl|ssh|disk usage|linux box|runbook|alerting|on-?call|secrets rotation|observability|structured logging|logging|zero-downtime|migration strategy)\b/i,
  },
  {
    type: "edit",
    pattern:
      /\b(refactor|rename|extract|rewrite (this|the)|convert (this|the)|clean up|simplify (this|the)|change (this|the)|modify|update (this|the)|reformat|missing semicolon|port (this|it) to|make (this|it) (async|faster|typed))\b/i,
  },
  {
    type: "feature",
    pattern:
      /\b(implement|build|create|design and implement|write (a|an|me|the)? ?(function|class|script|program|component|endpoint|api|cli|test|tests|module|service|parser|hook)|add (a|an|support for|multi-\w+)|scaffold|generate (a|an) (app|project))\b/i,
  },
  {
    type: "research",
    pattern:
      /\b(compare|comparison|differences? between|trade-?offs?|pros and cons|research|survey|literature|state of the art|which (is|should i) (better|use)|evaluate|analy[sz]e|in depth|deep dive|history of|what year|when was)\b/i,
  },
];

const CODE_HINT = /```|\b(function|const|let|def|class|import|return|=>|SELECT|public static)\b|[{};]\s*$/m;

function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user") return messageText(m.content);
  }
  return "";
}

/** Keyword rules over the last user turn; 0..3 difficulty from size and shape. */
export function heuristicClassify(messages: ChatMessage[]): Classification {
  const text = lastUserText(messages);
  const rule = RULES.find((r) => r.pattern.test(text));
  const taskType: TaskType = rule?.type ?? "chat";

  const total = messages.reduce((sum, m) => sum + messageText(m.content).length, 0);
  let difficulty = 0;
  if (total > 200) difficulty += 1;
  if (total > 1_500) difficulty += 1;
  if (CODE_HINT.test(text)) difficulty += 0.5;
  if (/\b(design|architecture|prove|optimi[sz]e|concurren|distributed|race condition|scal(e|ing)|security)\b/i.test(text)) {
    difficulty += 1;
  }
  if (taskType === "chat" || taskType === "classify") difficulty -= 0.5;
  difficulty = Math.min(3, Math.max(0, difficulty));

  return { taskType, difficulty, source: "heuristic" };
}

/**
 * Wraps a Jev-backed classifier so any Jev failure (no key, timeout, outage)
 * falls back to the heuristic instead of failing the request.
 */
export function withHeuristicFallback(
  primary: Classifier,
  onFallback?: (error: unknown) => void,
): Classifier {
  return async (messages, signal) => {
    try {
      return await primary(messages, signal);
    } catch (error) {
      onFallback?.(error);
      return heuristicClassify(messages);
    }
  };
}

/**
 * Classification through Milo's existing Jev router: the same question set
 * and policy signals the hosted version used, read for task type and
 * difficulty only. Throws when Jev does not answer; wrap it in
 * `withHeuristicFallback`.
 */
export function jevClassifier(router: Pick<Router, "route">): Classifier {
  return async (messages) => {
    const decision = await router.route({ messages, posture: "balanced", fingerprint: fingerprint(messages) });
    if (decision.signals === undefined) throw new Error("Jev returned no classification");
    return { taskType: decision.signals.taskType, difficulty: decision.signals.difficulty, source: "jev" };
  };
}
