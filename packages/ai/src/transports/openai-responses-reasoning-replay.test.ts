import type { AssistantMessage, Context, Model } from "@openclaw/llm-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convertResponsesMessages as convertProviderResponsesMessages } from "../providers/openai-responses-shared.js";
import { createZeroUsage } from "../usage.test-support.js";
import { buildOpenAIResponsesReasoningReplayMetadata } from "./openai-responses-compaction-replay.js";
import { OPENAI_RESPONSES_REASONING_REPLAY_META_KEY } from "./openai-responses-contracts.js";
import { convertResponsesMessages } from "./openai-responses-replay-internal.js";
import { log } from "./openai-transport-shared.js";

afterEach(() => vi.restoreAllMocks());

const model = {
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 8192,
} satisfies Model<"openai-responses">;
const replayIdentity = { sessionId: "session-a", authProfileId: "profile-a" };

type ReplayFixtureBlock = AssistantMessage["content"][number] & {
  openclawReasoningReplay?: unknown;
};

function createAssistant(content: ReplayFixtureBlock[]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createZeroUsage(),
    stopReason: "stop",
    timestamp: 0,
  };
}

const responseConverters = [
  {
    name: "transport-owned",
    convert: (context: Context) =>
      convertResponsesMessages(model, context, new Set(["openai"]), replayIdentity),
  },
  {
    name: "provider-owned",
    convert: (context: Context) =>
      convertProviderResponsesMessages(model, context, new Set(["openai"]), replayIdentity),
  },
] as const;

describe("OpenAI Responses reasoning replay", () => {
  it.each(["provider", "api", "model", "baseUrlHash", "sessionHash", "authProfileHash"] as const)(
    "diagnostic names the %s fence without exposing captured values or ciphertext",
    (field) => {
      const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
      const secret = `synthetic-private-${field}`;
      const metadata = buildOpenAIResponsesReasoningReplayMetadata(model, replayIdentity);
      const input = convertResponsesMessages(
        model,
        {
          messages: [
            createAssistant([
              {
                type: "thinking",
                thinking: "private-thought",
                thinkingSignature: JSON.stringify({
                  type: "reasoning",
                  id: "rs_diagnostic",
                  summary: [],
                  encrypted_content: "private-ciphertext",
                }),
                openclawReasoningReplay: { ...metadata, [field]: secret },
              },
            ]),
          ],
        },
        new Set(["openai"]),
        replayIdentity,
      );
      expect(input).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]?.[0]);
      expect(line).toContain(`${field}(`);
      expect(line.length).toBeLessThan(700);
      expect(line).not.toContain(secret);
      expect(line).not.toContain("private-ciphertext");
      expect(line).not.toContain("private-thought");
      expect(line).not.toContain(model.baseUrl);
      expect(line).not.toContain(replayIdentity.sessionId);
      expect(line).not.toContain(replayIdentity.authProfileId);
    },
  );

  it("diagnostic distinguishes absent metadata from invalid block metadata without overriding precedence", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const item = {
      type: "reasoning",
      id: "rs_missing_diagnostic",
      summary: [],
      encrypted_content: "secret-cipher",
    };
    const metadata = buildOpenAIResponsesReasoningReplayMetadata(model, replayIdentity);
    for (const invalidBlock of [false, true]) {
      const input = convertResponsesMessages(
        model,
        {
          messages: [
            createAssistant([
              {
                type: "thinking",
                thinking: "",
                thinkingSignature: JSON.stringify({
                  ...item,
                  ...(invalidBlock
                    ? { [OPENAI_RESPONSES_REASONING_REPLAY_META_KEY]: metadata }
                    : {}),
                }),
                ...(invalidBlock ? { openclawReasoningReplay: null } : {}),
              },
            ]),
          ],
        },
        new Set(["openai"]),
        replayIdentity,
      );
      expect(input).toEqual([]);
    }
    expect(warn.mock.calls.map((call) => call[0]).join("\n")).toContain("capturedMetadata=absent");
    expect(warn.mock.calls.map((call) => call[0]).join("\n")).toContain("capturedMetadata=invalid");
  });

  it("diagnostic stays quiet for matched, unencrypted, and preserved unattributed reasoning", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const metadata = buildOpenAIResponsesReasoningReplayMetadata(model, replayIdentity);
    const encrypted = {
      type: "reasoning",
      id: "rs_diagnostic_controls",
      summary: [],
      encrypted_content: "synthetic-cipher",
    };
    const matched = createAssistant([
      {
        type: "thinking",
        thinking: "",
        thinkingSignature: JSON.stringify({
          ...encrypted,
          [OPENAI_RESPONSES_REASONING_REPLAY_META_KEY]: metadata,
        }),
        openclawReasoningReplay: metadata,
      },
    ]);
    expect(
      convertResponsesMessages(model, { messages: [matched] }, new Set(["openai"]), replayIdentity),
    ).toEqual([encrypted]);
    const unencrypted = createAssistant([
      {
        type: "thinking",
        thinking: "",
        thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_unencrypted", summary: [] }),
      },
    ]);
    convertResponsesMessages(
      model,
      { messages: [unencrypted] },
      new Set(["openai"]),
      replayIdentity,
    );
    const unattributed = createAssistant([
      { type: "thinking", thinking: "", thinkingSignature: JSON.stringify(encrypted) },
    ]);
    expect(
      convertProviderResponsesMessages(
        model,
        { messages: [unattributed] },
        new Set(["openai"]),
        replayIdentity,
      ),
    ).toEqual([encrypted]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("diagnostic deduplicates retained fences and evicts old identities after bounded churn", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const metadata = buildOpenAIResponsesReasoningReplayMetadata(model, replayIdentity);
    const drop = (index: number) =>
      convertResponsesMessages(
        model,
        {
          messages: [
            createAssistant([
              {
                type: "thinking",
                thinking: "",
                thinkingSignature: JSON.stringify({
                  type: "reasoning",
                  id: "rs_churn",
                  summary: [],
                  encrypted_content: "private-cipher",
                }),
                openclawReasoningReplay: { ...metadata, sessionHash: `churn-${index}` },
              },
            ]),
          ],
        },
        new Set(["openai"]),
        replayIdentity,
      );
    drop(0);
    drop(0);
    expect(warn).toHaveBeenCalledTimes(1);
    for (let index = 1; index <= 256; index += 1) {
      drop(index);
    }
    expect(warn).toHaveBeenCalledTimes(257);
    drop(0);
    expect(warn).toHaveBeenCalledTimes(258);
  });

  it("diagnostic bounds imported identifiers and never lets a logging failure disable the fence", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const metadata = buildOpenAIResponsesReasoningReplayMetadata(model, replayIdentity);
    const item = {
      type: "reasoning",
      id: "rs_log_failure",
      summary: [],
      encrypted_content: "secret-cipher",
    };
    const context: Context = {
      messages: [
        createAssistant([
          {
            type: "thinking",
            thinking: "",
            thinkingSignature: JSON.stringify(item),
            openclawReasoningReplay: { ...metadata, model: "private\nidentifier=".repeat(4096) },
          },
        ]),
      ],
    };
    expect(convertResponsesMessages(model, context, new Set(["openai"]), replayIdentity)).toEqual(
      [],
    );
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line.length).toBeLessThan(700);
    expect(line).not.toContain("private");
    expect(line).not.toContain("\n");
    warn.mockImplementation(() => {
      throw new Error("synthetic logging failure");
    });
    expect(
      convertResponsesMessages(model, context, new Set(["openai"]), {
        ...replayIdentity,
        sessionId: "log-failure-session",
      }),
    ).toEqual([]);
  });

  it.each(responseConverters)(
    "$name preserves encrypted reasoning and removes bare orphan tails after payload preparation",
    ({ convert }) => {
      for (const encryptedContent of [undefined, null, "", "synthetic-completed-reasoning"]) {
        const item = {
          type: "reasoning",
          id: "rs_standalone",
          summary: [],
          ...(encryptedContent === undefined ? {} : { encrypted_content: encryptedContent }),
        };
        const block = {
          type: "thinking" as const,
          thinking: "",
          thinkingSignature: JSON.stringify(item),
          openclawReasoningReplay: buildOpenAIResponsesReasoningReplayMetadata(
            model,
            replayIdentity,
          ),
        };
        const input = convert({ messages: [createAssistant([block])] });
        expect(input).toEqual(encryptedContent ? [item] : []);

        const paired = convert({
          messages: [createAssistant([block, { type: "text", text: "Following answer" }])],
        });
        expect(paired.map((entry) => entry.type)).toEqual(["reasoning", "message"]);
      }
    },
  );

  it.each(responseConverters)(
    "$name removes standalone reasoning when replay identity strips its ciphertext",
    ({ name, convert }) => {
      const metadata = buildOpenAIResponsesReasoningReplayMetadata(model, replayIdentity);
      const item = {
        type: "reasoning",
        id: "rs_foreign",
        summary: [],
        encrypted_content: "synthetic-foreign-reasoning",
      };
      for (const replayMetadata of [
        undefined,
        null,
        { ...metadata, v: 2 },
        { ...metadata, provider: "other-provider" },
        { ...metadata, model: "other-model" },
        { ...metadata, baseUrlHash: "other-endpoint" },
        { ...metadata, sessionHash: "other-session" },
        { ...metadata, authProfileHash: "other-auth" },
      ]) {
        const block = {
          type: "thinking" as const,
          thinking: "",
          thinkingSignature: JSON.stringify(item),
          ...(replayMetadata === undefined ? {} : { openclawReasoningReplay: replayMetadata }),
        };
        const input = convert({ messages: [createAssistant([block])] });
        const preservesUnattributed = name === "provider-owned" && replayMetadata === undefined;
        expect(input).toEqual(preservesUnattributed ? [item] : []);
      }
    },
  );
});
