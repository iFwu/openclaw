import { describe, expect, it } from "vitest";
import { applyAssistantDeliveryDirectives } from "./transcript-assistant-delivery.js";

describe("assistant delivery normalization across native parts", () => {
  it("does not reinterpret admitted literal text or mint facts across its boundary", () => {
    const literal = "Literal [[reply_to:other]] [[audio_as_voice]] [[tts:text]]say[[/tts:text]]";
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: literal, textInterpretation: "literal" },
        { type: "text", text: "[[reply_to_current]]Actual raw answer." },
      ],
    };
    applyAssistantDeliveryDirectives(message, { stripForDisplay: true });
    expect(message).toMatchObject({
      content: [{ text: literal, textInterpretation: "literal" }, { text: "Actual raw answer." }],
      openclawDelivery: { replyToCurrent: true },
    });
    expect(message).not.toHaveProperty("openclawDelivery.replyToId");
    expect(message).not.toHaveProperty("openclawDelivery.audioAsVoice");
    expect(message).not.toHaveProperty("openclawDelivery.tts");
  });
  it("records delivery facts without rewriting the model's raw multipart bytes", () => {
    const parts = [
      "[[reply_to_current]]Hello.",
      "Use `[[audio_as_voice]]` literally. [[tts:text]]Speak `code`.[[/tts:text]]",
    ];
    const message = {
      role: "assistant",
      content: parts.map((text, index) => ({
        type: "text",
        text,
        textSignature: `native-${index}`,
      })),
      openclawDelivery: { mediaUrls: ["./kept.png"] },
    };
    const content = message.content;
    const blocks = [...content];
    applyAssistantDeliveryDirectives(message);
    expect(message.content).toBe(content);
    expect(message.content.map((block) => block.text)).toEqual(parts);
    expect(message.openclawDelivery).toEqual({
      mediaUrls: ["./kept.png"],
      replyToCurrent: true,
      tts: { tagged: true, text: "Speak `code`." },
    });
    for (const [index, block] of message.content.entries()) {
      expect(block).toBe(blocks[index]);
      expect(block.textSignature).toBe(`native-${index}`);
    }
    const snapshot = structuredClone(message);
    applyAssistantDeliveryDirectives(message);
    expect(message).toEqual(snapshot);
  });

  it.each([
    {
      name: "reply IDs containing code bytes",
      parts: ["Prefix.", "[[reply_to:`quoted`]]Reply."],
      expected: ["Prefix.", "Reply."],
      facts: { replyToId: "`quoted`" },
    },
    {
      name: "speech text containing code and placeholder-like bytes",
      parts: ["Prefix.", "Shown. [[tts:text]]Speak `code` \uE0000\uE000.[[/tts:text]]"],
      expected: ["Prefix.", "Shown."],
      facts: { tts: { tagged: true, text: "Speak `code` \uE0000\uE000." } },
    },
    {
      name: "speech directive values containing code bytes",
      parts: ["Prefix.", "[[tts:provider=openai voice=`quoted`]]Shown."],
      expected: ["Prefix.", "Shown."],
      facts: {
        tts: { tagged: true, directives: [{ provider: "openai", values: { voice: "`quoted`" } }] },
      },
    },
    {
      name: "code whitespace around a genuine voice directive",
      parts: ["Use `", "  [[reply_to:literal]]  `\n[[audio_as_voice]]Done."],
      expected: ["Use `", "  [[reply_to:literal]]  `\nDone."],
      facts: { audioAsVoice: true },
    },
  ])("preserves $name and remains idempotent", ({ parts, expected, facts }) => {
    const content = parts.map((text, index) => ({
      type: "text",
      text,
      textSignature: `native-${index}`,
    }));
    const identities = [...content];
    const message = { role: "assistant", content, openclawDelivery: { mediaUrls: ["./kept.png"] } };
    applyAssistantDeliveryDirectives(message, { stripForDisplay: true });
    expect(message.content).toBe(content);
    expect(message.content.map((block) => block.text)).toEqual(expected);
    expect(message.openclawDelivery).toEqual({ mediaUrls: ["./kept.png"], ...facts });
    for (const [index, block] of message.content.entries()) {
      expect(block).toBe(identities[index]);
      expect(block.textSignature).toBe(`native-${index}`);
    }
    const prepared = structuredClone(message);
    applyAssistantDeliveryDirectives(message, { stripForDisplay: true });
    expect(message).toEqual(prepared);
  });

  it("keeps commentary code context separate from final intent", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "```text\n[[reply_to:commentary]]",
          textSignature: JSON.stringify({ v: 1, id: "progress", phase: "commentary" }),
        },
        {
          type: "text",
          text: "[[reply_to_current]]Final reply.",
          textSignature: JSON.stringify({ v: 1, id: "answer", phase: "final_answer" }),
        },
      ],
    };
    applyAssistantDeliveryDirectives(message, { stripForDisplay: true });
    expect(message).toMatchObject({
      content: [{ text: "```text\n[[reply_to:commentary]]" }, { text: "Final reply." }],
      openclawDelivery: { replyToCurrent: true },
    });
  });
});
