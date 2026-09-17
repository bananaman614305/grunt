/**
 * Schema and loader for the labeled routing eval set
 * (`packages/evals/data/routing.jsonl`). See `packages/evals/data/README.md`
 * for the labeling rules this file encodes.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { TASK_TYPES, TIERS } from "@milo/core";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Default location of the committed routing eval set. */
export const DEFAULT_ROUTING_SET_PATH = resolve(__dirname, "../data/routing.jsonl");

const chatRoleSchema = z.enum(["system", "developer", "user", "assistant", "tool"]);

const chatContentPartSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
});

/** Mirrors `ChatMessage` from `@milo/core`, restated here as a zod schema. */
export const chatMessageSchema = z.object({
  role: chatRoleSchema,
  content: z.union([z.string(), z.array(chatContentPartSchema), z.null()]),
  name: z.string().optional(),
  tool_calls: z.array(z.unknown()).optional(),
  tool_call_id: z.string().optional(),
});

const taskTypeSchema = z.enum(TASK_TYPES);
const tierSchema = z.enum(TIERS);

/** The four Jev difficulty levels, 0 (trivial) to 3 (hardest). */
export const difficultyBandSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

export const routingExampleSchema = z.object({
  id: z.string().min(1),
  messages: z.array(chatMessageSchema).min(1),
  has_tools: z.boolean(),
  task_type: taskTypeSchema,
  difficulty_band: difficultyBandSchema,
  expected_tier_balanced: tierSchema,
  notes: z.string().min(1),
});

export type RoutingExample = z.infer<typeof routingExampleSchema>;

/**
 * Read and validate the JSONL routing eval set at `path` (defaults to the
 * committed `packages/evals/data/routing.jsonl`). Throws with the offending
 * line number on invalid JSON or a schema violation.
 */
export function loadRoutingSet(path: string = DEFAULT_ROUTING_SET_PATH): RoutingExample[] {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");
  const examples: RoutingExample[] = [];

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`${path}:${lineNumber}: invalid JSON (${message})`);
    }

    const result = routingExampleSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`${path}:${lineNumber}: ${result.error.message}`);
    }
    examples.push(result.data);
  });

  return examples;
}
