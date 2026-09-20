import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../types.js";
import { detectModality } from "./modality.js";

/** A user turn with structured content parts. */
function user(content: ChatMessage["content"]): ChatMessage {
  return { role: "user", content };
}

describe("detectModality", () => {
  it("reads a plain string turn as text", () => {
    expect(detectModality([user("Rename res to rows.")])).toBe("text");
  });

  it("reads null content as text", () => {
    expect(detectModality([{ role: "assistant", content: null }])).toBe("text");
  });

  it("does not trip on text content parts", () => {
    expect(
      detectModality([
        { role: "system", content: [{ type: "text", text: "You are a sub-agent." }] },
        user([{ type: "text", text: "Explain this function." }]),
      ]),
    ).toBe("text");
  });

  it("detects an image_url part as image", () => {
    expect(detectModality([user([{ type: "text", text: "What is this?" }, { type: "image_url" }])])).toBe("image");
  });

  it("detects an input_audio part as audio", () => {
    expect(detectModality([user([{ type: "input_audio" }])])).toBe("audio");
  });

  it("detects a video_url part as video", () => {
    expect(detectModality([user([{ type: "video_url" }])])).toBe("video");
  });

  it("outranks an image with audio (non-image modality wins)", () => {
    expect(detectModality([user([{ type: "image_url" }, { type: "input_audio" }])])).toBe("audio");
  });

  it("outranks audio with video", () => {
    expect(detectModality([user([{ type: "input_audio" }, { type: "video_url" }])])).toBe("video");
  });

  it("sees an image earlier in the conversation, not just the last turn", () => {
    const messages: ChatMessage[] = [
      user([{ type: "text", text: "Look at this diagram" }, { type: "image_url" }]),
      { role: "assistant", content: "It shows a pipeline." },
      user("Now rename the second stage."),
    ];
    expect(detectModality(messages)).toBe("image");
  });

  it("routes an unknown media part away from text (never the blind branch)", () => {
    // A part type we do not hardcode, carrying media, must not read as text.
    const modality = detectModality([user([{ type: "input_file" }])]);
    expect(modality).not.toBe("text");
    expect(modality).not.toBe("image"); // unclassifiable -> omni route, not vision-only
    expect(modality).toBe("video");
  });

  it("routes a bare file part to the omni route", () => {
    expect(detectModality([user([{ type: "file" }])])).toBe("video");
  });

  it("treats a wholly unknown part type as media", () => {
    expect(detectModality([user([{ type: "some_new_media_kind" }])])).not.toBe("text");
  });
});
