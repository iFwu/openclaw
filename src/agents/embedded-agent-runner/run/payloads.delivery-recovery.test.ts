import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { getReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import { buildPayloads } from "./payloads.test-helpers.js";

describe("buildEmbeddedRunPayloads delivery recovery", () => {
  it("keeps voice intent and terminal transcript ownership on their own answer", () => {
    const prior = {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "MEDIA:/tmp/first.ogg" }],
      openclawDelivery: { audioAsVoice: true },
    } as AssistantMessage;
    const current = {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "MEDIA:/tmp/second.mp3" }],
    } as AssistantMessage;
    const payloads = buildPayloads({
      answerSegments: [{ textEnd: 0, messageEnd: 1, finalMessageStart: 1, lastAssistant: prior }],
      lastAssistant: current,
      assistantMessageIndex: 3,
      assistantTranscriptOwned: true,
      assistantTranscriptIdempotencyKey: "terminal-answer",
    });
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({ mediaUrl: "/tmp/first.ogg", audioAsVoice: true });
    expect(payloads[1]).toMatchObject({ mediaUrl: "/tmp/second.mp3" });
    expect(payloads[1]).not.toHaveProperty("audioAsVoice");
    expect(getReplyPayloadMetadata(payloads[0]!)).toMatchObject({
      assistantMessageIndex: 1,
      precedingInputAnswer: true,
    });
    expect(getReplyPayloadMetadata(payloads[0]!)).not.toHaveProperty("assistantTranscriptOwned");
    expect(getReplyPayloadMetadata(payloads[0]!)).not.toHaveProperty(
      "assistantTranscriptIdempotencyKey",
    );
    expect(getReplyPayloadMetadata(payloads[1]!)).toMatchObject({
      assistantMessageIndex: 3,
      assistantTranscriptOwned: true,
      assistantTranscriptIdempotencyKey: "terminal-answer",
    });
  });

  it("uses persisted delivery facts for a recovered final assistant", () => {
    const payloads = buildPayloads({
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        content: [
          {
            type: "text",
            text: "[[reply_to:message-7]] [[audio_as_voice]]Recovered answer [[tts:text]]Recovered speech[[/tts:text]]",
          },
        ],
        openclawDelivery: {
          audioAsVoice: true,
          replyToCurrent: true,
          replyToId: "message-7",
          tts: {
            tagged: true,
            text: "Recovered speech",
          },
        },
      } as AssistantMessage,
    });

    expect(payloads).toEqual([
      expect.objectContaining({
        text: "Recovered answer",
        audioAsVoice: true,
        replyToCurrent: true,
        replyToId: "message-7",
      }),
    ]);
    expect(getReplyPayloadMetadata(payloads[0]!)?.tts).toEqual({
      tagged: true,
      text: "Recovered speech",
    });
  });

  it("does not recover delivery facts by parsing a pre-upgrade assistant", () => {
    const payloads = buildPayloads({
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "[[reply_to:message-7]] Recovered answer" }],
      } as AssistantMessage,
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("Recovered answer");
    expect(payloads[0]).not.toHaveProperty("replyToCurrent");
    expect(payloads[0]).not.toHaveProperty("replyToId");
  });
});
