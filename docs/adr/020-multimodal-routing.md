# ADR-020: A multimodal routing gate over the compute controller

Status: accepted, 2026-09-20. Extends ADR-012 (the DeepSeek compute
controller). Adds one field to `packages/core/src/types.ts` and one nullable
decision-log column; changes no existing routing behaviour for text requests.

## Context

Milo's deployed mode is the DeepSeek compute controller (ADR-012). Its branch
model for bands 0–2, `deepseek/deepseek-v4-flash`, is **text-only**: its
OpenRouter `input_modalities` are `["text"]`. A request that carries an image,
audio, or video content part sent to that model is answered blind — the media
part is dropped or errors — with nothing in the response saying the modality
was lost. The band-to-model mapping reads difficulty, not modality, so today an
image on an easy band silently lands on a blind model.

Two capable models were verified live against
`https://openrouter.ai/api/v1/models` before this decision:

- `deepseek/deepseek-v4.1-flash` — `input_modalities: ["text","image"]`,
  output `["text"]`. Already the band-3 orchestrator, and confirmed live to
  read a solid-colour test image correctly. It does **not** accept audio or
  video.
- `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` — `input_modalities:
  ["text","audio","image","video"]`, output `["text"]`, prompt/completion
  price both `0`. A free omni model that reads every input modality.

## Decision

A **deterministic modality pre-gate** runs inside the compute controller,
before the model is chosen. Modality is read straight off the request's message
content parts (`packages/core/src/router/modality.ts`, `detectModality`) — it
needs no Jev classification, only the payload — so the Jev sizing call and its
signals are unchanged; only the model and sample count move.

1. **Text-only request → unchanged.** The existing compute-controller path runs
   exactly as before: band → budget → model, byte-for-byte. No `modality`
   field is set, and the gateway discloses `x-milo-modality: text`.
2. **Image present, no audio/video → pin `deepseek/deepseek-v4.1-flash`.** The
   band mapping is overridden (v4-flash is blind). Default one call; escalate to
   the band-3 sampling budget (best-of-5) **only** when Jev flags the *visual*
   task as hard, read off the same `isHardBand` gate the controller already
   uses for text — so vision sampling and text sampling can never drift. The
   band is still sized, because that is what gates the escalation.
3. **Audio or video present → route to `nvidia/nemotron-3-nano-omni-…:free`,
   one call, no best-of-N** (no sampling on a free model; `milo.samples` cannot
   re-size it). The omni model also reads images, so "any non-image modality
   present" (audio and/or video, with or without an image) takes this route.

Detection fails **toward** capability, never toward the blind model: any
content part whose `type` is not recognisably text counts as media, and an
unclassifiable media part (a bare `file`/`input_file`, or an unknown type)
takes the omni route rather than the text branch. The whole message array is
scanned, so an image earlier in context still forces a vision-capable model.

`milo.candidates` is unchanged: it is an explicit allow-list, so a list that
excludes the forced model steps the gate aside and the request resolves against
the roster, exactly as it already did for the controller's own model.

## Contract change (`types.ts`)

One additive, optional field on `RouteDecision`:

```ts
export const MODALITIES = ["text", "image", "audio", "video"] as const;
export type Modality = (typeof MODALITIES)[number];
// on RouteDecision:
modality?: Modality;
```

`modality` is set only on a non-text route; absent means text. It carries a
closed-vocabulary label, never message content, so it is safe in the decision
log and in a response header. The gateway emits it as `x-milo-modality`
alongside `x-milo-model` (defaulting to `text` when absent), and the decision
log gains a nullable `modality` column (schema migration 9, same
`ADD COLUMN`-if-absent shape as migrations 4 and 5). No existing field changes
meaning; every prior row and every text decision reads as `text`.

## Consequences

- An image request is answered by a model that can see it; audio and video are
  answered by a model that can hear and watch them, at zero marginal cost.
- The response and the audit trail say which modality drove the model, so a
  dropped-modality regression is visible instead of silent.
- The gate is pure and deterministic, tested without network
  (`modality.test.ts`, `controller.test.ts`).
- Scope held: text routing, the roster mode, sampling ranking, briefs, gates,
  and pruning are untouched. Output is text-only throughout — no model here
  emits image/audio/video, so no output-modality handling is added.
