import { describe, expect, it, vi, type Mock } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { EmbeddedRunAttemptResult } from "./embedded-agent-runner/run/types.js";
import {
  type EmbeddedAttemptParams,
  makeFallbackSuccessAttempt,
  makeModelFallbackConfig,
  withModelFallbackWorkspace,
  writeFallbackAuthStore,
  writeFallbackMultiProfileAuthStore,
} from "./model-fallback.run-embedded.e2e.test-support.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";

export function registerSettledContinuationTests(context: {
  runEmbeddedAttemptMock: Mock<(params: unknown) => Promise<EmbeddedRunAttemptResult>>;
  runEmbeddedEntryFallback: (params: {
    agentDir: string;
    workspaceDir: string;
    sessionKey: string;
    runId: string;
    config?: OpenClawConfig;
  }) => Promise<{ provider: string; result: { payloads?: Array<{ text?: string }> } }>;
  observedModelRoutingProvenance: Array<{ stage: "initial" | "fallback"; fallbackReason?: string }>;
  expectAttemptOrder: (expected: Array<{ provider: string; authProfileId: string }>) => void;
  expectProviderAttemptCounts: (expected: { openai: number; groq: number }) => void;
  countProviderAttempts: (provider: string) => number;
}) {
  const {
    runEmbeddedAttemptMock,
    runEmbeddedEntryFallback,
    observedModelRoutingProvenance,
    expectAttemptOrder,
    expectProviderAttemptCounts,
    countProviderAttempts,
  } = context;
  describe("settled-write model continuation", () => {
    it("retains the selected policy root through settled-write profile rotation and model fallback", async () => {
      await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
        await writeFallbackMultiProfileAuthStore(agentDir, { openAiProfileCount: 2 });
        const baseConfig = makeModelFallbackConfig();
        const config: OpenClawConfig = {
          ...baseConfig,
          agents: {
            ...baseConfig.agents,
            defaults: {
              ...baseConfig.agents?.defaults,
              model: {
                primary: "openai/mock-1",
                fallbacks: [],
                fallbackChains: {
                  "openai/mock-1": ["groq/mock-2"],
                  "groq/mock-2": [],
                },
              },
            },
          },
          auth: { order: { openai: ["openai:p1", "openai:p2"], groq: ["groq:p1"] } },
        };
        const toolAssistant = buildEmbeddedRunnerAssistant({
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: "write-1", name: "write", arguments: {} }],
        });
        const completedTranscript: EmbeddedRunAttemptResult["messagesSnapshot"] = [
          { role: "user", content: "hello", timestamp: 1 },
          toolAssistant,
          {
            role: "toolResult",
            toolCallId: "write-1",
            toolName: "write",
            content: [{ type: "text", text: "written" }],
            isError: false,
            timestamp: 2,
          },
        ];
        let originalPromptAttempts = 0;
        runEmbeddedAttemptMock.mockImplementation(async (raw) => {
          const params = raw as EmbeddedAttemptParams & {
            sessionId: string;
            prompt: string;
            disableTools?: boolean;
            skipPreparedUserTurnMessage?: boolean;
            suppressNextUserMessagePersistence?: boolean;
          };
          const firstProfile = params.provider === "openai" && params.authProfileId === "openai:p1";
          if (params.prompt === "hello") {
            originalPromptAttempts += 1;
          }
          if (!firstProfile) {
            expect(params.prompt).toContain("preserving completed work");
            expect(params.skipPreparedUserTurnMessage).toBe(true);
            expect(params.suppressNextUserMessagePersistence).toBe(true);
          }
          expect(params.disableTools).not.toBe(true);
          expect(observedModelRoutingProvenance.at(-1)).toMatchObject({
            requestedProvider: "openai",
            requestedModel: "mock-1",
            fallbackPolicyRoot: { provider: "openai", model: "mock-1" },
          });
          if (params.provider === "groq") {
            return { ...makeFallbackSuccessAttempt(), sessionIdUsed: params.sessionId };
          }
          expect(params.provider).toBe("openai");
          const assistant = buildEmbeddedRunnerAssistant({
            provider: "openai",
            model: "mock-1",
            stopReason: "error",
            content: [],
            errorMessage: "429 Too Many Requests: Please try again in 1s",
          });
          return makeEmbeddedRunnerAttempt({
            sessionIdUsed: params.sessionId,
            providerRetryMaxRetries: 0,
            messagesSnapshot: [
              ...completedTranscript,
              ...(!firstProfile
                ? [{ role: "user" as const, content: params.prompt, timestamp: 3 }]
                : []),
              assistant,
            ],
            lastAssistant: assistant,
            currentAttemptAssistant: assistant,
            toolMetas: firstProfile
              ? [{ toolCallId: "write-1", toolName: "write", replaySafe: false }]
              : [],
            itemLifecycle: firstProfile
              ? { startedCount: 1, completedCount: 1, activeCount: 0 }
              : { startedCount: 0, completedCount: 0, activeCount: 0 },
            ...(!firstProfile
              ? {
                  currentAttemptReplayMetadata: {
                    replaySafe: true,
                    hadPotentialSideEffects: false,
                  },
                }
              : {}),
          });
        });

        const result = await runEmbeddedEntryFallback({
          agentDir,
          workspaceDir,
          config,
          runId: "run:settled-profile-model-fallback",
          sessionKey: "agent:test:settled-profile-model-fallback",
        });

        expectAttemptOrder([
          { provider: "openai", authProfileId: "openai:p1" },
          { provider: "openai", authProfileId: "openai:p2" },
          { provider: "groq", authProfileId: "groq:p1" },
        ]);
        expect(originalPromptAttempts).toBe(1);
        expect(observedModelRoutingProvenance).toMatchObject([
          { stage: "initial", fallbackPolicyRoot: { provider: "openai", model: "mock-1" } },
          {
            stage: "fallback",
            fallbackReason: "rate_limit",
            fallbackPolicyRoot: { provider: "openai", model: "mock-1" },
          },
        ]);
        expect(result.provider).toBe("groq");
        expect(result.result.payloads?.[0]?.text).toBe("fallback ok");
      });
    });

    it("continues a settled write on the fallback with normal tools and no original-prompt replay", async () => {
      await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
        await writeFallbackAuthStore(agentDir);
        const runId = "run:settled-fallback";
        let completedWrites = 0;
        runEmbeddedAttemptMock.mockImplementation(async (raw) => {
          const params = raw as {
            provider: string;
            sessionId: string;
            prompt: string;
            disableTools?: boolean;
            skipPreparedUserTurnMessage?: boolean;
            suppressNextUserMessagePersistence?: boolean;
          };
          if (params.provider === "groq") {
            expect(params.prompt).toContain("preserving completed work");
            expect(params.prompt).not.toBe("hello");
            expect(params.skipPreparedUserTurnMessage).toBe(true);
            expect(params.suppressNextUserMessagePersistence).toBe(true);
            expect(params.disableTools).not.toBe(true);
            return { ...makeFallbackSuccessAttempt(), sessionIdUsed: params.sessionId };
          }
          if (params.prompt === "hello") {
            completedWrites += 1;
          }
          const assistant = buildEmbeddedRunnerAssistant({
            provider: "openai",
            model: "mock-1",
            stopReason: "error",
            content: [],
            errorMessage: "HTTP 502 Bad Gateway",
          });
          return makeEmbeddedRunnerAttempt({
            sessionIdUsed: params.sessionId,
            providerRetryMaxRetries: 0,
            messagesSnapshot: [
              { role: "user", content: "hello", timestamp: 1 },
              buildEmbeddedRunnerAssistant({
                stopReason: "toolUse",
                content: [{ type: "toolCall", id: "write-1", name: "write", arguments: {} }],
              }),
              {
                role: "toolResult",
                toolCallId: "write-1",
                toolName: "write",
                content: [{ type: "text", text: "written" }],
                isError: false,
                timestamp: 2,
              },
              assistant,
            ],
            lastAssistant: assistant,
            currentAttemptAssistant: assistant,
            toolMetas: [{ toolCallId: "write-1", toolName: "write", replaySafe: false }],
            itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
          });
        });

        const result = await runEmbeddedEntryFallback({
          agentDir,
          workspaceDir,
          runId,
          sessionKey: "agent:test:settled-fallback",
        });
        expect(result.provider).toBe("groq");
        expect(result.result.payloads?.[0]?.text).toBe("fallback ok");
        expect(completedWrites).toBe(1);
        expect(countProviderAttempts("groq")).toBe(1);
      });
    });

    it("does not switch models after an uncertain write followed by a model-only failure", async () => {
      await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
        await writeFallbackAuthStore(agentDir);
        let primaryAttempts = 0;
        runEmbeddedAttemptMock.mockImplementation(async (raw) => {
          const params = raw as { provider: string; sessionId: string; prompt: string };
          expect(params.provider).toBe("openai");
          const first = primaryAttempts++ === 0;
          if (!first) {
            expect(params.prompt).toContain("preserving completed work");
          }
          const assistant = buildEmbeddedRunnerAssistant({
            provider: "openai",
            model: "mock-1",
            stopReason: "error",
            content: [],
            errorMessage: "HTTP 502 Bad Gateway",
          });
          return makeEmbeddedRunnerAttempt({
            sessionIdUsed: params.sessionId,
            providerRetryMaxRetries: 1,
            lastAssistant: assistant,
            currentAttemptAssistant: assistant,
            messagesSnapshot: [assistant],
            toolMetas: first
              ? [{ toolCallId: "write-uncertain", toolName: "write", replaySafe: false }]
              : [],
            itemLifecycle: first
              ? { startedCount: 1, completedCount: 0, activeCount: 1 }
              : { startedCount: 0, completedCount: 0, activeCount: 0 },
            ...(!first
              ? {
                  currentAttemptReplayMetadata: {
                    replaySafe: true,
                    hadPotentialSideEffects: false,
                  },
                }
              : {}),
          });
        });

        const result = await runEmbeddedEntryFallback({
          agentDir,
          workspaceDir,
          runId: "run:uncertain-fallback",
          sessionKey: "agent:test:uncertain-fallback",
        });
        expect(primaryAttempts).toBe(2);
        expect(countProviderAttempts("groq")).toBe(0);
        expect(result.provider).toBe("openai");
      });
    });
  });
  describe("settled-write continuation preparation failures", () => {
    it.each([
      { boundary: "waitForCurrentUserMessagePersistence", providerRetryMaxRetries: 0 },
      { boundary: "settleOwnedTranscriptProjection", providerRetryMaxRetries: 0 },
      { boundary: "waitForCurrentUserMessagePersistence", providerRetryMaxRetries: 1 },
      { boundary: "settleOwnedTranscriptProjection", providerRetryMaxRetries: 1 },
    ] as const)(
      "stops fallback when $boundary rejects with retry budget $providerRetryMaxRetries",
      async ({ boundary, providerRetryMaxRetries }) => {
        await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
          await writeFallbackAuthStore(agentDir);
          const continuationModule =
            await import("./embedded-agent-runner/run/model-continuation.js");
          const createCallbacks = continuationModule.createModelContinuationCallbacks;
          let armed = false;
          let restoreWait: (() => void) | undefined;
          const preparationFailure = vi.fn(async () => {
            throw new Error("HTTP 502 Bad Gateway");
          });
          const factorySpy = vi
            .spyOn(continuationModule, "createModelContinuationCallbacks")
            .mockImplementation((input) => {
              if (!armed) {
                expectProviderAttemptCounts({ openai: 1, groq: 0 });
                armed = true;
                // Normalization already settled its own wait before these callbacks are created.
                const waitSpy = vi
                  .spyOn(input.sessionPromptState, boundary)
                  .mockImplementationOnce(preparationFailure);
                restoreWait = () => waitSpy.mockRestore();
              }
              return createCallbacks(input);
            });
          try {
            runEmbeddedAttemptMock.mockImplementation(async (raw) => {
              const params = raw as EmbeddedAttemptParams & { sessionId: string; prompt: string };
              if (params.provider === "groq") {
                return { ...makeFallbackSuccessAttempt(), sessionIdUsed: params.sessionId };
              }
              expect(params.provider).toBe("openai");
              expect(params.prompt).toBe("hello");
              const assistant = buildEmbeddedRunnerAssistant({
                provider: "openai",
                model: "mock-1",
                stopReason: "error",
                content: [],
                errorMessage: "HTTP 502 Bad Gateway",
              });
              return makeEmbeddedRunnerAttempt({
                sessionIdUsed: params.sessionId,
                providerRetryMaxRetries,
                messagesSnapshot: [
                  { role: "user", content: "hello", timestamp: 1 },
                  buildEmbeddedRunnerAssistant({
                    stopReason: "toolUse",
                    content: [{ type: "toolCall", id: "write-1", name: "write", arguments: {} }],
                  }),
                  {
                    role: "toolResult",
                    toolCallId: "write-1",
                    toolName: "write",
                    content: [{ type: "text", text: "written" }],
                    isError: false,
                    timestamp: 2,
                  },
                  assistant,
                ],
                lastAssistant: assistant,
                currentAttemptAssistant: assistant,
                toolMetas: [{ toolCallId: "write-1", toolName: "write", replaySafe: false }],
                itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
              });
            });

            await expect(
              runEmbeddedEntryFallback({
                agentDir,
                workspaceDir,
                runId: `run:prepare-failed:${boundary}:${providerRetryMaxRetries}`,
                sessionKey: `agent:test:prepare-failed:${boundary}:${providerRetryMaxRetries}`,
              }),
            ).rejects.toThrow("HTTP 502 Bad Gateway");
            expect(preparationFailure).toHaveBeenCalledOnce();
            expectAttemptOrder([{ provider: "openai", authProfileId: "openai:p1" }]);
          } finally {
            restoreWait?.();
            factorySpy.mockRestore();
          }
        });
      },
    );
  });
}
