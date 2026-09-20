/**
 * `POST /v1/verify` (ADR-019): the ground-truth verification endpoint a
 * harness Stop hook posts an agent's turn to.
 *
 * Because Milo holds the Jev key server-side, the auditor lives here: a hook
 * needs a Milo endpoint and its own Milo key, NOT a TypeSafe key. The hook
 * gathers the turn text (or pre-extracted claims), read-only git probes, and
 * receipts, and posts them; Milo extracts the load-bearing claims, checks each
 * against the probes and receipts with one cross-family Jev call, and returns
 * the verdicts plus a one-line summary and the oracles a claim with no backing
 * "demands" (git-tracked case law the hook persists).
 *
 * FAIL-OPEN is the whole contract of this surface: no Jev, an error, a timeout,
 * or a malformed request all return a 200 with an empty, explicitly
 * non-blocking verdict. This endpoint never returns a 5xx that could stall the
 * agent whose turn is being checked -- a self-check that can break the thing it
 * watches is worse than no self-check.
 */

import type { Context, Hono } from "hono";
import {
  claimId,
  demandedOracles,
  emptyResult,
  extractClaims,
  isCrossFamily,
  normalizeReceipts,
  parseGitProbes,
  verifyClaims,
} from "@milo/core";
import type {
  CaseLawEntry,
  Claim,
  ClaimCategory,
  GitProbeState,
  Receipt,
  VerifyGroundTruth,
  VerifyResult,
} from "@milo/core";
import type { AppDeps } from "../app.js";
import { errorMessage } from "../errors.js";
import { readJsonObject } from "./shared.js";

export function registerVerifyRoute(app: Hono, deps: AppDeps): void {
  app.post("/v1/verify", (c) => handleVerify(c, deps));
}

/** What a verify request resolves to once parsed: claims plus ground truth. */
export type VerifyInput = {
  claims: Claim[];
  ground: VerifyGroundTruth;
  executorModel?: string;
};

const CLAIM_CATEGORIES: readonly ClaimCategory[] = ["test", "build", "implementation", "completion", "other"];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Coerce one caller-supplied claim (string or object) into a `Claim`. */
function toClaim(raw: unknown): Claim | undefined {
  if (typeof raw === "string") {
    const text = raw.trim();
    if (text === "") return undefined;
    return { id: claimId(text), text, category: "other" };
  }
  if (isObject(raw) && typeof raw["text"] === "string" && raw["text"].trim() !== "") {
    const text = raw["text"].trim();
    const category =
      typeof raw["category"] === "string" && (CLAIM_CATEGORIES as string[]).includes(raw["category"])
        ? (raw["category"] as ClaimCategory)
        : "other";
    const id = typeof raw["id"] === "string" && raw["id"] !== "" ? raw["id"] : claimId(text);
    return { id, text, category };
  }
  return undefined;
}

/** Coerce the `git` field: raw probe strings, a captured diff, or a parsed state. */
function toGitState(raw: unknown): GitProbeState | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") return parseGitProbes({ diff: raw });
  if (!isObject(raw)) return undefined;
  // An already-structured state (has the parsed fields) is used as-is.
  if ("filesChanged" in raw || "files" in raw) return raw as unknown as GitProbeState;
  // Otherwise treat it as raw probe strings.
  const input: { status?: string; diff?: string; numstat?: string; log?: string } = {};
  if (typeof raw["status"] === "string") input.status = raw["status"];
  if (typeof raw["diff"] === "string") input.diff = raw["diff"];
  if (typeof raw["numstat"] === "string") input.numstat = raw["numstat"];
  if (typeof raw["log"] === "string") input.log = raw["log"];
  return Object.keys(input).length > 0 ? parseGitProbes(input) : undefined;
}

/** Coerce the `receipts` field into a normalized receipt array. */
function toReceipts(raw: unknown): Receipt[] {
  if (!Array.isArray(raw)) return [];
  const receipts: Receipt[] = [];
  for (const r of raw) {
    if (!isObject(r) || typeof r["command"] !== "string") continue;
    const receipt: Receipt = { command: r["command"] };
    if (typeof r["exitCode"] === "number") receipt.exitCode = r["exitCode"];
    if (typeof r["ok"] === "boolean") receipt.ok = r["ok"];
    if (typeof r["summary"] === "string") receipt.summary = r["summary"];
    receipts.push(receipt);
  }
  return normalizeReceipts(receipts);
}

/**
 * Parse a verify request body into claims and ground truth. Pure and tolerant:
 * anything malformed is dropped, and a body with neither a turn nor claims
 * yields no claims (a clean, non-blocking verification). Shared with the
 * completeness gate (`gate.ts`), which reads the same shape off `milo.verify`.
 */
export function parseVerifyInput(raw: unknown): VerifyInput {
  const body = isObject(raw) ? raw : {};

  let claims: Claim[] = [];
  if (Array.isArray(body["claims"])) {
    claims = body["claims"].map(toClaim).filter((c): c is Claim => c !== undefined);
  } else if (typeof body["turn"] === "string") {
    claims = extractClaims(body["turn"]);
  } else if (typeof body["text"] === "string") {
    claims = extractClaims(body["text"]);
  }

  const ground: VerifyGroundTruth = {};
  const git = toGitState(body["git"]);
  if (git !== undefined) ground.git = git;
  const receipts = toReceipts(body["receipts"]);
  if (receipts.length > 0) ground.receipts = receipts;
  if (typeof body["note"] === "string" && body["note"].trim() !== "") ground.note = body["note"];

  const executorModel =
    typeof body["executorModel"] === "string"
      ? body["executorModel"]
      : typeof body["executorFamily"] === "string"
        ? body["executorFamily"]
        : undefined;

  return { claims, ground, ...(executorModel !== undefined ? { executorModel } : {}) };
}

/** The JSON body this endpoint answers with. */
export type VerifyResponse = {
  verdicts: Array<{ id: string; claim: string; category: string; verdict: string; confidence: number }>;
  summary: VerifyResult["summary"];
  /** True when Milo's auditor is cross-family to the executor (always, with Jev). */
  crossFamily: boolean;
  /** Oracles demanded for unbacked claims, for the hook to persist as case law. */
  caseLaw: CaseLawEntry[];
  /** True only on a confident contradiction -- the one thing a block may act on. */
  blocking: boolean;
  /** True when the verifier could not run (fail-open); nothing was checked. */
  unavailable?: boolean;
};

function toResponse(result: VerifyResult, crossFamily: boolean, unavailable = false): VerifyResponse {
  return {
    verdicts: result.results.map((r) => ({
      id: r.claim.id,
      claim: r.claim.text,
      category: r.claim.category,
      verdict: r.verdict,
      confidence: r.confidence,
    })),
    summary: result.summary,
    crossFamily,
    caseLaw: demandedOracles(result.results),
    blocking: result.summary.blocking,
    ...(unavailable ? { unavailable: true } : {}),
  };
}

async function handleVerify(c: Context, deps: AppDeps): Promise<Response> {
  // A malformed body is not an error here: fail open with an empty verdict.
  const body = await readJsonObject(c);
  if (body === undefined) {
    return c.json(toResponse(emptyResult("Verification unavailable: unreadable request."), true, true), 200);
  }

  const input = parseVerifyInput(body);
  const crossFamily = isCrossFamily(input.executorModel);

  // No auditor configured: disclosed, non-blocking, never a 5xx.
  if (deps.jev === undefined) {
    return c.json(toResponse(emptyResult("Verification unavailable: no auditor configured."), crossFamily, true), 200);
  }

  try {
    const result = await verifyClaims(deps.jev, input.claims, input.ground);
    return c.json(toResponse(result, crossFamily), 200);
  } catch (err) {
    // A Jev failure/timeout must never stall the agent whose turn this is.
    deps.logger.warn("verify failed; returning a non-blocking verdict", { error: errorMessage(err) });
    return c.json(toResponse(emptyResult("Verification unavailable: auditor error."), crossFamily, true), 200);
  }
}
