/** Small parsing helpers shared by the CLI backends. */

import type { BackendErrorKind } from "./types.js";

const RATE_LIMITED = /usage limit|rate[ -]?limit|\b429\b|too many requests|quota|limit reached|out of credits/i;
const AUTH = /not logged in|please log ?in|run .*login|login required|unauthori[sz]ed|\b401\b|invalid api key|authentication/i;

/**
 * Sorts a CLI's own failure text into the few kinds the router acts on.
 * The text is the CLI's error message, never the prompt.
 */
export function classifyCliFailure(message: string): BackendErrorKind {
  if (RATE_LIMITED.test(message)) return "rate_limited";
  if (AUTH.test(message)) return "auth";
  return "failed";
}

export function parseJson(line: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return undefined;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function lastLine(text: string): string | undefined {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !/\bWARN\b/.test(l));
  return lines.at(-1);
}

export function truncate(text: string, max = 300): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
