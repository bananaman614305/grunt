/**
 * The local-subscription backend contract (ADR-031).
 *
 * A backend is one official vendor CLI (`codex`, `claude`) that the user has
 * installed and logged into on their own machine. Milo only ever spawns that
 * binary as a child process under the user's account and reads what it
 * prints. It never reads, copies, stores or forwards the CLI's login.
 */

import type { ChatMessage, TaskType } from "../types.js";

export const SUBSCRIPTIONS = ["codex", "claude"] as const;
export type SubscriptionId = (typeof SUBSCRIPTIONS)[number];

export function isSubscriptionId(value: string): value is SubscriptionId {
  return (SUBSCRIPTIONS as readonly string[]).includes(value);
}

/** One request, already flattened for a CLI that takes a single prompt. */
export type BackendRequest = {
  /** System/developer instructions, if the conversation had any. */
  system?: string;
  /** The conversation as one prompt (see `toPrompt`). */
  prompt: string;
  /** CLI model override (`codex -m`, `claude --model`). Absent: the CLI's own default. */
  model?: string;
  signal?: AbortSignal;
  /** Called with each piece of answer text as the CLI produces it. */
  onText?: (delta: string) => void;
};

export type BackendUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /**
   * What the same call would have cost on the vendor's pay-per-token API, when
   * the CLI reports it (Claude Code does; Codex does not). Informational only:
   * a subscription call costs nothing extra.
   */
  apiEquivalentUsd?: number;
};

/** One plan-limit window as the CLI reported it. */
export type LimitWindow = {
  /** `"5h"`, `"weekly"`, `"seven_day"`... whatever the CLI calls it. */
  name: string;
  /** 0..100. Absent when the CLI said the window exists but not how full it is. */
  usedPercent?: number;
  /** ISO 8601. */
  resetsAt?: string;
  windowMinutes?: number;
};

/** The plan-limit reading attached to one CLI call or limits probe. */
export type LimitSignal = {
  observedAt: string;
  /** `limited` means the CLI refused (or will refuse) work until a reset. */
  status: "allowed" | "warning" | "limited";
  windows: LimitWindow[];
};

export type BackendErrorKind = "rate_limited" | "unavailable" | "auth" | "timeout" | "aborted" | "failed";

export type BackendOutcome =
  | {
      ok: true;
      text: string;
      /** The model the CLI says it ran, when it says. */
      model?: string;
      usage: BackendUsage;
      limits?: LimitSignal;
      latencyMs: number;
    }
  | {
      ok: false;
      error: BackendErrorKind;
      /** Short, content-free description (never includes the prompt). */
      message: string;
      limits?: LimitSignal;
      latencyMs: number;
    };

export interface SubscriptionBackend {
  readonly id: SubscriptionId;
  /** Human label, e.g. "ChatGPT (codex)". */
  readonly label: string;
  run(req: BackendRequest): Promise<BackendOutcome>;
  /**
   * Reads the plan's remaining capacity without spending any, when the CLI
   * offers a documented way to. Absent when it does not; resolves `undefined`
   * when the read failed.
   */
  readLimits?(signal?: AbortSignal): Promise<LimitSignal | undefined>;
}

/** Where a capacity number came from. */
export type CapacitySource = "cli" | "estimated" | "unknown";

/** What the router knows about one subscription's remaining capacity right now. */
export type CapacitySnapshot = {
  backend: SubscriptionId;
  /** 0..100 of the most constrained window, when known. */
  usedPercent?: number;
  remainingPercent?: number;
  /** The most constrained window's name and reset. */
  window?: string;
  resetsAt?: string;
  /** True when the plan is refusing work (reported, or a recent rate-limit error). */
  limited: boolean;
  /** When `limited` is expected to lift, if known. */
  limitedUntil?: string;
  source: CapacitySource;
  /** When the CLI last reported limits, if ever. */
  observedAt?: string;
};

export type Classification = {
  taskType: TaskType;
  /** 0..3, the same scale Jev uses. */
  difficulty: number;
  source: "jev" | "heuristic";
};

export type Classifier = (messages: ChatMessage[], signal?: AbortSignal) => Promise<Classification>;
