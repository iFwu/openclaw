import { describe, expect, it, vi } from "vitest";
import * as codeRegions from "../shared/text/code-regions.js";
import { normalizeLiveAssistantBufferedText } from "./live-chat-projector.js";
import { createChatRunState } from "./server-chat-state.js";

describe("live chat directive projection", () => {
  it.each(["reply_to_current", "tts:text"])(
    "keeps settled literal %s directives without repeatedly parsing the growing reply",
    (directive) => {
      const regions = vi.spyOn(codeRegions, "findCodeRegions");
      const ownership = vi.spyOn(codeRegions, "findCodeOwnership");
      const state = createChatRunState();
      const run = state.getOrCreate("reply");
      const literal = `The marker is \`[[${directive}]]\`.\n\nNext paragraph.\n\n`;
      const block = "```ts\nconst value = 1;\n```\n\n";
      try {
        state.updateBuffer("reply", { delta: literal });
        expect(state.resolveBuffer("reply").text).toBe(literal);
        for (let index = 1; index <= 100; index++) {
          state.updateBuffer("reply", { delta: block });
          expect(state.resolveBuffer("reply").text).toBe(literal + block.repeat(index));
        }
        const parsedChars = [...regions.mock.calls, ...ownership.mock.calls].reduce(
          (total, [text]) => total + text.length,
          0,
        );
        expect(parsedChars).toBeLessThan((run.rawBuffer?.length ?? 0) * 4);
      } finally {
        regions.mockRestore();
        ownership.mockRestore();
      }
    },
  );

  it("removes completed speech-only text from the live display without changing raw bytes", () => {
    const state = createChatRunState();
    const raw = "[[reply_to_current]]Shown. [[tts:text]]Spoken.[[/tts:text]]";
    state.updateBuffer("speech", { delta: raw });
    expect(state.resolveBuffer("speech").text).toBe("Shown.");
    expect(state.getOrCreate("speech").rawBuffer).toBe(raw);
  });

  it("keeps completed nonliteral speech followed by ordinary appends within the linear parsing budget", () => {
    const regions = vi.spyOn(codeRegions, "findCodeRegions");
    const ownership = vi.spyOn(codeRegions, "findCodeOwnership");
    const state = createChatRunState();
    const raw = "[[tts:text]]Spoken.[[/tts:text]]Visible";
    try {
      state.updateBuffer("speech-tail", { delta: raw });
      expect(state.resolveBuffer("speech-tail").text).toBe("Visible");
      for (let index = 1; index <= 100; index++) {
        state.updateBuffer("speech-tail", { delta: "x" });
        expect(state.resolveBuffer("speech-tail").text).toBe("Visible" + "x".repeat(index));
      }
      const parsedChars = [...regions.mock.calls, ...ownership.mock.calls].reduce(
        (sum, [text]) => sum + text.length,
        0,
      );
      expect(parsedChars).toBeLessThan(
        (state.getOrCreate("speech-tail").rawBuffer?.length ?? 0) * 4,
      );
    } finally {
      regions.mockRestore();
      ownership.mockRestore();
    }
  });

  it("keeps code-bearing completed speech and whitespace appends within the linear parsing budget", () => {
    const regions = vi.spyOn(codeRegions, "findCodeRegions");
    const ownership = vi.spyOn(codeRegions, "findCodeOwnership");
    const state = createChatRunState();
    const raw = "[[tts:text]]`Spoken.`[[/tts:text]]Visible ";
    try {
      state.updateBuffer("code-speech-tail", { delta: raw });
      expect(state.resolveBuffer("code-speech-tail").text).toBe("Visible");
      for (let index = 1; index <= 100; index++) {
        state.updateBuffer("code-speech-tail", { delta: index % 2 ? " " : "x" });
        const source = state.getOrCreate("code-speech-tail").rawBuffer ?? "";
        expect(state.resolveBuffer("code-speech-tail").text).toBe(
          source.slice(raw.indexOf("Visible")).trimEnd(),
        );
      }
      const parsedChars = [...regions.mock.calls, ...ownership.mock.calls].reduce(
        (sum, [text]) => sum + text.length,
        0,
      );
      expect(parsedChars).toBeLessThan(
        (state.getOrCreate("code-speech-tail").rawBuffer?.length ?? 0) * 4,
      );
    } finally {
      regions.mockRestore();
      ownership.mockRestore();
    }
  });

  it.each([
    {
      name: "split speech opener and closer",
      deltas: ["[", "[tts:", "text]]`Spoken.`[", "[/tts:", "text]]Visible", " ", "x"],
    },
    {
      name: "an unmatched opener across paragraph boundaries",
      deltas: ["[[tts:text]]A", "\n\nB", "[[/tts:", "text]]Shown", " ", "again"],
    },
    {
      name: "bare TTS pairing across chunks",
      deltas: ["[[tts]] A ", "B", "[[/tts", "]]", " ", "C"],
    },
    {
      name: "late backticks in a speech body",
      deltas: ["before `[[tts:text]]Spoken.[[/tts:text]]Shown", "x", "` after"],
    },
    {
      name: "a later reference after ordinary speech appends",
      deltas: [
        "[[tts:text]]`Spoken.`[[/tts:text]]Shown",
        "x",
        " ![`[[tts:text]]`][x]\n\nnext\n\n[x]:",
        " /image.png",
      ],
    },
    {
      name: "a reference definition completed with ordinary bytes",
      deltas: ["![`[[tts:text]]`][x]\n\n[x]:", "/image.png"],
    },
    {
      name: "code whitespace after retiring an inert proof",
      deltas: ["[[tts:text]]`Spoken.`[[/tts:text]]Shown", " ", "x", "\n\n    code ", "\n    more"],
    },
    {
      name: "a new speech block across an inert append boundary",
      deltas: [
        "[[tts:text]]`Spoken.`[[/tts:text]]Shown ",
        "x",
        " [",
        "[tts:text]]More",
        "[[/tts:text]]",
        " ",
        "y",
      ],
    },
    {
      name: "leading code indentation after an empty speech projection",
      deltas: ["[[tts:text]]`Spoken.`[[/tts:text]]    ", "x", " ", "y"],
    },
    {
      name: "authored code indentation after speech removal",
      deltas: ["[[tts:text]]`Spoken.`[[/tts:text]]    Visible", " ", "x"],
    },
  ])("matches canonical live speech projection for $name", ({ deltas }) => {
    const state = createChatRunState();
    let raw = "";
    let streamed = "";
    for (const delta of deltas) {
      raw += delta;
      state.updateBuffer("speech-parity", { delta });
      const canonical = normalizeLiveAssistantBufferedText(raw);
      const visible = state.resolveBuffer("speech-parity").text;
      expect(visible).toBe(canonical);
      expect(state.getOrCreate("speech-parity").rawBuffer).toBe(raw);
      const update = state.takeBufferDelta("speech-parity", visible);
      if (update) {
        streamed = update.replace ? update.deltaText : streamed + update.deltaText;
      }
      expect(streamed).toBe(canonical);
    }
  });

  it("retires speech append proofs on replacements including empty text", () => {
    const state = createChatRunState();
    const frames = [
      "[[tts:text]]`Spoken.`[[/tts:text]]Shown ",
      "[[tts:text]]`Spoken.`[[/tts:text]]Shown x",
      "Replacement ",
      "",
      "[[tts:text]]New[[/tts:text]]Fresh ",
      "[[tts:text]]New[[/tts:text]]Fresh x",
    ];
    let previous = "";
    for (const text of frames) {
      state.updateBuffer("speech-replace", {
        itemId: "answer",
        ...(text && text.startsWith(previous)
          ? { delta: text.slice(previous.length) }
          : { text, replace: true }),
      });
      expect(state.resolveBuffer("speech-replace").text).toBe(
        normalizeLiveAssistantBufferedText(text),
      );
      expect(state.getOrCreate("speech-replace").rawBuffer).toBe(text);
      previous = text;
    }
  });

  it.each([
    {
      name: "a closing backtick restores a previously stripped marker",
      frames: ["before `[[reply_to_current]]", "before `[[reply_to_current]]` after"],
      visible: ["before `", "before `[[reply_to_current]]` after"],
    },
    {
      name: "a later image reference changes earlier code ownership",
      frames: [
        "![`[[reply_to_current]]`][x]\n\nnext",
        "![`[[reply_to_current]]`][x]\n\nnext\n\n[x]: /image.png",
      ],
      visible: ["![`[[reply_to_current]]`][x]\n\nnext", "![``][x]\n\nnext\n\n[x]: /image.png"],
    },
    {
      name: "a new directive crosses the append boundary after settled code",
      frames: [
        "`[[reply_to_current]]`\n\nNext [",
        "`[[reply_to_current]]`\n\nNext [[reply_to_current]] after",
      ],
      visible: ["`[[reply_to_current]]`\n\nNext", "`[[reply_to_current]]`\n\nNext  after"],
    },
    {
      name: "a replacement retires the old literal prefix",
      frames: ["`[[reply_to_current]]`\n\nNext", "[[reply_to_current]] visible"],
      visible: ["`[[reply_to_current]]`\n\nNext", " visible"],
    },
  ])("preserves changing Markdown meaning when $name", ({ frames, visible }) => {
    const state = createChatRunState();
    let previous = "";
    frames.forEach((text, index) => {
      state.updateBuffer("reply", {
        itemId: "answer",
        ...(text.startsWith(previous) ? { delta: text.slice(previous.length) } : { text }),
      });
      expect(state.resolveBuffer("reply").text).toBe(visible[index]);
      previous = text;
    });
  });

  it("keeps terminal tail release separate from live state and clears projection on retirement", () => {
    const state = createChatRunState();
    const run = state.getOrCreate("reply");
    state.updateBuffer("reply", { delta: "`[[reply_to_current]]`\n\nNext [" });
    expect(state.resolveBuffer("reply").text).toBe("`[[reply_to_current]]`\n\nNext");
    expect(state.resolveBuffer("reply", { final: true }).text).toBe(run.rawBuffer);
    expect(state.resolveBuffer("reply").text).toBe("`[[reply_to_current]]`\n\nNext");
    state.clearRun("reply");
    expect(state.runs.has("reply")).toBe(false);
    state.updateBuffer("reply", { delta: "[[reply_to_current]] visible" });
    expect(state.resolveBuffer("reply").text).toBe(" visible");
  });

  it("retains pending display deltas across reads and reconciles terminal whitespace", () => {
    const state = createChatRunState();
    state.updateBuffer("reply", { delta: "N" });
    expect(state.resolveBuffer("reply").suppress).toBe(true);
    expect(state.takeBufferDelta("reply", "")).toBeUndefined();
    state.updateBuffer("reply", { delta: "ice" });
    expect(state.resolveBuffer("reply").text).toBe("Nice");
    state.updateBuffer("reply", { delta: " work " });
    expect(state.resolveBuffer("reply").text).toBe("Nice work ");
    expect(state.takeBufferDelta("reply", "Nice work ")).toEqual({ deltaText: "Nice work " });
    expect(state.takeBufferDelta("reply", "Nice work ")).toBeUndefined();
    expect(state.takeBufferDelta("reply", "Nice work")).toEqual({
      deltaText: "Nice work",
      replace: true,
    });
    state.updateBuffer("reply", { delta: "again" });
    expect(state.takeBufferDelta("reply", "Nice work again")).toEqual({ deltaText: " again" });
  });

  it("reprojects managed media facts without leaking a terminal tail into live reads", () => {
    const state = createChatRunState();
    const text = "`[[reply_to_current]]`\n\nPicture\nMEDIA:./plot.png\nDone";
    state.updateBuffer("reply", { delta: text });
    expect(state.resolveBuffer("reply").text).toBe(text);
    expect(state.takeBufferDelta("reply", text)).toEqual({ deltaText: text });
    state.updateBuffer("reply", { managedMediaUrls: ["./plot.png"] });
    const visible = "`[[reply_to_current]]`\n\nPicture\nDone";
    expect(state.resolveBuffer("reply").text).toBe(visible);
    expect(state.takeBufferDelta("reply", visible)).toEqual({ deltaText: visible, replace: true });
  });

  it("retires code ownership when the display cap removes its opening delimiter", () => {
    const state = createChatRunState();
    const prefix = "`[[reply_to_current]]`\n\nNext ";
    state.updateBuffer("reply", { delta: prefix + "x".repeat(500_000 - prefix.length) });
    expect(state.resolveBuffer("reply").text.startsWith(prefix)).toBe(true);
    state.updateBuffer("reply", { delta: "!" });
    const visible = state.resolveBuffer("reply").text;
    expect(visible.startsWith("`\n\nNext ")).toBe(true);
    expect(visible).not.toContain("[[reply_to_current]]");
    expect(visible.endsWith("!")).toBe(true);
  });
});
