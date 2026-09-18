/**
 * `predictions.jsonl` shaping. This is the one file the official SWE-bench
 * evaluator consumes from us, so its shape is a hard contract: one JSON object
 * per line, exactly `{ instance_id, model_name_or_path, model_patch }`.
 */

export type Prediction = {
  instance_id: string;
  /** The agent scaffold's name, not the underlying model (see docs/swebench.md). */
  model_name_or_path: string;
  /** Unified diff to apply; may be "" for an instance the agent left untouched. */
  model_patch: string;
};

export function toPrediction(instanceId: string, modelPatch: string, modelName: string): Prediction {
  return { instance_id: instanceId, model_name_or_path: modelName, model_patch: modelPatch };
}

/**
 * Serialize predictions to JSONL. Keys are emitted in the evaluator's canonical
 * order and every line ends with a newline, including the last, so the file can
 * be appended to or concatenated safely.
 */
export function formatPredictionsJsonl(predictions: Prediction[]): string {
  return predictions
    .map((p) =>
      JSON.stringify({
        instance_id: p.instance_id,
        model_name_or_path: p.model_name_or_path,
        model_patch: p.model_patch,
      }),
    )
    .join("\n") + (predictions.length > 0 ? "\n" : "");
}
