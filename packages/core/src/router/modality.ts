/**
 * The multimodal pre-gate's detector (ADR-020): a pure read of a request's
 * message content parts that says which input modality the conversation
 * carries. It runs *before* any Jev call -- modality is a fact about the
 * payload, not a classification -- so the compute controller can pin a
 * vision- or omni-capable model before it sizes difficulty.
 *
 * The controller's band-0..2 branch model (`deepseek/deepseek-v4-flash`) is
 * text-only: an image, audio, or video part sent to it is dropped or errors.
 * So this detector fails *toward* a capable model, never toward the blind
 * one: any content part that is not recognisably text counts as media, and
 * an unclassifiable media part routes to the omni model rather than falling
 * through to the text branch.
 *
 * See `modalityBudget` in `controller.ts` for what each modality buys.
 */

import type { ChatMessage, Modality } from "../types.js";

/**
 * Content-part `type` values that are plain text and must NOT trip the gate.
 * Everything else inside a content-parts array is treated as media (OpenAI
 * and OpenRouter chat-completions bodies only ever put `text` parts and media
 * parts in a message's `content` array; refusals, tool calls and results ride
 * their own fields, not `content`).
 */
const TEXT_PART_TYPES = new Set(["text", "input_text", "output_text"]);

/** True when a content part carries non-text media of any kind. */
function isMediaPart(type: string): boolean {
  return !TEXT_PART_TYPES.has(type);
}

/**
 * Which media a single content part carries, by its `type` string. Keyworded
 * rather than exact-matched so provider spelling variants all land right:
 * `image_url`/`input_image`/`image`, `input_audio`/`audio`,
 * `video_url`/`input_video`/`video`. A media part that matches none of these
 * (a bare `file`/`input_file`, or an unknown type) is `"other"` -- unknown
 * media, routed to the omni model so it is never sent to the blind branch.
 */
function mediaKind(type: string): "image" | "audio" | "video" | "other" {
  const t = type.toLowerCase();
  if (t.includes("video")) return "video";
  if (t.includes("audio")) return "audio";
  if (t.includes("image")) return "image";
  return "other";
}

/**
 * The dominant input modality across the whole conversation.
 *
 * Precedence is capability-first: any audio or video (or unclassifiable
 * media) present outranks an image, because those need the omni model and an
 * image alone only needs the vision branch. Order among the non-image kinds
 * (`video` > `audio` > `other`) is a disclosure label only -- all three route
 * the same way. A conversation with no media part -- string content, or only
 * text parts -- is `"text"`.
 *
 * The whole message array is scanned, not just the last turn: an image posted
 * earlier in context still requires a vision-capable model to read the thread.
 */
export function detectModality(messages: ChatMessage[]): Modality {
  let image = false;
  let audio = false;
  let video = false;
  let other = false;

  for (const message of messages) {
    const content = message.content;
    // A string (or null) content is text: it can never carry a media part.
    if (!Array.isArray(content)) continue;
    for (const rawPart of content) {
      // The declared part shape is `{ type: string }`, but the payload is
      // parsed from an untrusted client body, so read `type` defensively.
      const type = (rawPart as { type?: unknown }).type;
      if (typeof type !== "string" || type === "" || !isMediaPart(type)) continue;
      switch (mediaKind(type)) {
        case "image":
          image = true;
          break;
        case "audio":
          audio = true;
          break;
        case "video":
          video = true;
          break;
        case "other":
          other = true;
          break;
      }
    }
  }

  if (video) return "video";
  if (audio) return "audio";
  // Unclassifiable media is non-image as far as we can tell, so it takes the
  // omni route; "video" is the conservative disclosure label (assume the most
  // demanding modality), and it is what keeps such a request off the blind
  // text branch.
  if (other) return "video";
  if (image) return "image";
  return "text";
}
