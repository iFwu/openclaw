import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE } from "../../../llm/types.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { createToolTerminalObserver } from "../../tool-terminal-outcome.js";
import { handleEmbeddedAssistantFailure } from "./assistant-failure.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./terminal-outcome.js";

const providerRuntimeMocks = vi.hoisted(() => ({
  classifyProviderFailoverSignalWithPlugin: vi.fn(),
}));
vi.mock("../../../plugins/provider-failover.js", () => providerRuntimeMocks);

type AssistantFailureInput = Parameters<typeof handleEmbeddedAssistantFailure>[0];

function makeSettledModelFailureInput(errorMessage: string) {
  const assistant = buildEmbeddedRunnerAssistant({
    provider: "anthropic",
    model: "mock-1",
    stopReason: "error",
    content: [],
    errorMessage,
  });
  const toolAssistant = buildEmbeddedRunnerAssistant({
    stopReason: "toolUse",
    content: [{ type: "toolCall", id: "write-1", name: "write", arguments: {} }],
  });
  const attempt = makeEmbeddedRunnerAttempt({
    messagesSnapshot: [
      { role: "user", content: "update the file", timestamp: 1 },
      toolAssistant,
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
    assistantTexts: ["Checking the result."],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    toolMetas: [{ toolCallId: "write-1", toolName: "write", replaySafe: false }],
    itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
  });
  const modelContinuation: NonNullable<AssistantFailureInput["runParams"]["modelContinuation"]> = {
    runId: "run:settled-tools",
  };
  const input: AssistantFailureInput = {
    runParams: {
      runId: modelContinuation.runId,
      sessionId: "session:settled-tools",
      workspaceDir: "/tmp/settled-tools-test",
      prompt: "update the file",
      timeoutMs: 30_000,
      modelContinuation,
    },
    attempt,
    attemptAssistant: assistant,
    currentAttemptAssistant: assistant,
    terminalState: resolveEmbeddedRunAttemptTerminalState({ attempt, assistant }),
    activeErrorContext: { provider: "anthropic", model: "mock-1" },
    provider: "anthropic",
    providerOwner: undefined,
    modelId: "mock-1",
    model: "mock-1",
    thinkLevel: "off",
    getThinkLevel: () => "off",
    attemptedThinking: new Set(["off"]),
    fallbackConfigured: true,
    pluginHarnessOwnsTransport: false,
    authProfileStore: { version: 1, profiles: {} },
    runtimeAuthRetry: false,
    maybeRefreshRuntimeAuthForAuthError: vi.fn(async () => false),
    emptyErrorRetries: 3,
    overloadProfileRotations: 0,
    previousRetryFailoverReason: null,
    failover: {
      resolveAuthProfileFailureReason: () => null,
      overloadProfileRotationLimit: 1,
      maybeMarkAuthProfileFailure: vi.fn(async () => {}),
      transientRetryCount: 0,
      advanceAuthProfile: vi.fn(async () => true),
      advanceRateLimitAuthProfile: vi.fn(async () => true),
    },
    traceAttempts: [],
    suspendForFailure: vi.fn(),
    suspensionSessionId: "session:settled-tools",
    agentDir: "/tmp/settled-tools-test",
    isProbeSession: false,
    prepareModelContinuation: vi.fn(async (evidence) => {
      modelContinuation.checkpoint = {
        sessionId: "session:settled-tools",
        sessionFile: "/tmp/settled-transcript.jsonl",
        ...evidence,
      };
    }),
  };
  return { input };
}

describe("settled tools after assistant failure", () => {
  beforeEach(() => {
    providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin.mockReset();
  });

  it.each(["HTTP 429 Too Many Requests; retry after 2 seconds", "HTTP 502 Bad Gateway"])(
    "checkpoints a settled write before authorized profile rotation: %s",
    async (errorMessage) => {
      const { input } = makeSettledModelFailureInput(errorMessage);
      const rotate = vi.fn(async () => {
        expect(input.runParams.modelContinuation?.checkpoint?.toolCallIds).toEqual(["write-1"]);
        return true;
      });
      input.failover.advanceAuthProfile = rotate;
      input.failover.advanceRateLimitAuthProfile = rotate;

      const outcome = await handleEmbeddedAssistantFailure(input);

      expect(outcome.action).toBe("retry");
      expect(rotate).toHaveBeenCalledTimes(1);
      expect(input.attempt.replayMetadata.replaySafe).toBe(false);
    },
  );

  it("escalates a settled 429 to configured fallback when retry and profile budgets are exhausted", async () => {
    const { input } = makeSettledModelFailureInput("HTTP 429 Too Many Requests");
    input.failover.advanceRateLimitAuthProfile = vi.fn(async () => false);

    await expect(handleEmbeddedAssistantFailure(input)).rejects.toMatchObject({
      name: "FailoverError",
      reason: "rate_limit",
    });
    expect(input.runParams.modelContinuation?.checkpoint?.toolCallIds).toEqual(["write-1"]);
  });

  it("allows a settled message delivery before a silent provider failure", async () => {
    const { input } = makeSettledModelFailureInput("HTTP 502 Bad Gateway");
    input.attempt.didSendViaMessagingTool = true;
    input.attempt.sourceReplyDelivered = true;
    input.attempt.didDeliverSourceReplyViaMessageTool = true;
    input.attempt.messagingToolSentTexts = ["Checking the result."];

    expect((await handleEmbeddedAssistantFailure(input)).action).toBe("retry");
  });

  it.each([true, false])(
    "continues after an earlier failed tool and a later successful tool (profile available: %s)",
    async (profileAvailable) => {
      const { input } = makeSettledModelFailureInput("HTTP 429 Too Many Requests");
      const observe = createToolTerminalObserver(input.runParams.runId);
      observe({
        toolCallId: "exec-1",
        toolName: "exec",
        outcome: "failure",
        failure: { error: "Command aborted by signal SIGTERM" },
      });
      input.attempt.lastToolError = observe({
        toolCallId: "write-1",
        toolName: "write",
        outcome: "success",
      }).lastToolError;
      input.attempt.messagesSnapshot.splice(
        1,
        0,
        buildEmbeddedRunnerAssistant({
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: "exec-1", name: "exec", arguments: {} }],
        }),
        {
          role: "toolResult",
          toolCallId: "exec-1",
          toolName: "exec",
          content: [{ type: "text", text: "Command aborted by signal SIGTERM" }],
          isError: true,
          timestamp: 1,
        },
      );
      input.attempt.toolMetas.unshift({
        toolCallId: "exec-1",
        toolName: "exec",
        replaySafe: false,
        isError: true,
      });
      input.attempt.itemLifecycle = { startedCount: 2, completedCount: 2, activeCount: 0 };
      input.failover.advanceRateLimitAuthProfile = vi.fn(async () => profileAvailable);

      if (profileAvailable) {
        expect((await handleEmbeddedAssistantFailure(input)).action).toBe("retry");
      } else {
        await expect(handleEmbeddedAssistantFailure(input)).rejects.toMatchObject({
          name: "FailoverError",
          reason: "rate_limit",
        });
      }
      expect(input.runParams.modelContinuation?.checkpoint).toMatchObject({
        toolCallIds: ["write-1"],
        includeToolFailureInstruction: true,
      });
      expect(input.attempt.lastToolError).toMatchObject({ toolName: "exec" });
    },
  );

  it("keeps the settled checkpoint through another silent model-only failure", async () => {
    const { input } = makeSettledModelFailureInput("HTTP 502 Bad Gateway");
    expect((await handleEmbeddedAssistantFailure(input)).action).toBe("retry");
    input.attempt.messagesSnapshot.push(
      { role: "user", content: "Continue from the current transcript.", timestamp: 3 },
      input.currentAttemptAssistant!,
    );
    input.attempt.toolMetas = [];
    input.attempt.itemLifecycle = { startedCount: 0, completedCount: 0, activeCount: 0 };
    input.attempt.currentAttemptReplayMetadata = {
      replaySafe: true,
      hadPotentialSideEffects: false,
    };

    expect((await handleEmbeddedAssistantFailure(input)).action).toBe("retry");
    expect(input.runParams.modelContinuation?.checkpoint?.toolCallIds).toEqual(["write-1"]);
  });

  it("does not reuse a checkpoint when its tool result is no longer in the transcript", async () => {
    const { input } = makeSettledModelFailureInput("HTTP 502 Bad Gateway");
    expect((await handleEmbeddedAssistantFailure(input)).action).toBe("retry");
    input.attempt.messagesSnapshot = input.attempt.messagesSnapshot.filter(
      (message) => message.role !== "toolResult",
    );
    input.attempt.messagesSnapshot.push(
      { role: "user", content: "Continue from the current transcript.", timestamp: 3 },
      input.currentAttemptAssistant!,
    );
    input.attempt.toolMetas = [];
    input.attempt.itemLifecycle = { startedCount: 0, completedCount: 0, activeCount: 0 };
    input.attempt.currentAttemptReplayMetadata = {
      replaySafe: true,
      hadPotentialSideEffects: false,
    };
    vi.mocked(input.failover.advanceAuthProfile).mockClear();

    expect((await handleEmbeddedAssistantFailure(input)).action).toBe("proceed");
    expect(input.failover.advanceAuthProfile).not.toHaveBeenCalled();
  });

  it.each([
    [
      "unproven effects from an earlier same-model retry",
      (input: AssistantFailureInput) => {
        input.runParams.modelContinuation!.crossModelBlocked = true;
        input.attempt.currentAttemptReplayMetadata = {
          replaySafe: true,
          hadPotentialSideEffects: false,
        };
      },
    ],
    [
      "partial output",
      (input: AssistantFailureInput) => {
        input.currentAttemptAssistant!.content = [{ type: "text", text: "Partly sent" }];
      },
    ],
    [
      "new tool call",
      (input: AssistantFailureInput) => {
        input.currentAttemptAssistant!.content = [
          { type: "toolCall", id: "new", name: "write", arguments: {} },
        ];
      },
    ],
    [
      "duplicate tool call identity",
      (input: AssistantFailureInput) => {
        const assistant = input.attempt.messagesSnapshot[1];
        if (assistant?.role !== "assistant") {
          throw new Error("settled-tool fixture has no tool-call assistant");
        }
        assistant.content.push({ type: "toolCall", id: "write-1", name: "write", arguments: {} });
      },
    ],
    [
      "tool result before its call",
      (input: AssistantFailureInput) => {
        const result = input.attempt.messagesSnapshot.splice(2, 1)[0]!;
        input.attempt.messagesSnapshot.splice(1, 0, result);
      },
    ],
    [
      "retained error without a matching failed result",
      (input: AssistantFailureInput) => {
        input.attempt.lastToolError = {
          toolName: "write",
          toolCallId: "different-call",
          error: "write failed",
        };
      },
    ],
    [
      "retained error without call identity",
      (input: AssistantFailureInput) => {
        input.attempt.lastToolError = { toolName: "write", error: "write failed" };
      },
    ],
    [
      "native transport failure",
      (input: AssistantFailureInput) => {
        input.currentAttemptAssistant!.diagnostics = [
          {
            type: "provider_transport_failure",
            timestamp: 3,
            error: { message: "WebSocket closed" },
            details: { phase: "after_message_stream_start" },
          },
        ];
      },
    ],
    [
      "transport-owning harness",
      (input: AssistantFailureInput) => {
        input.pluginHarnessOwnsTransport = true;
      },
    ],
    [
      "active tool",
      (input: AssistantFailureInput) => {
        input.attempt.itemLifecycle.activeCount = 1;
      },
    ],
    [
      "missing tool result",
      (input: AssistantFailureInput) => {
        input.attempt.messagesSnapshot = input.attempt.messagesSnapshot.filter(
          (message) => message.role !== "toolResult",
        );
      },
    ],
    [
      "async work",
      (input: AssistantFailureInput) => {
        input.attempt.toolMetas = input.attempt.toolMetas.map((tool) => ({
          ...tool,
          asyncStarted: true,
        }));
      },
    ],
    [
      "yield",
      (input: AssistantFailureInput) => {
        input.attempt.yieldDetected = true;
      },
    ],
    [
      "pending approval",
      (input: AssistantFailureInput) => {
        input.attempt.didSendDeterministicApprovalPrompt = true;
      },
    ],
    [
      "run deadline",
      (input: AssistantFailureInput) => {
        input.attempt.terminal = { kind: "timeout", phase: "prompt", source: "external" };
      },
    ],
    [
      "prompt exception",
      (input: AssistantFailureInput) => {
        input.attempt.terminal = {
          kind: "failed",
          source: "prompt",
          error: new Error("HTTP 502 Bad Gateway"),
        };
      },
    ],
    [
      "interruption",
      (input: AssistantFailureInput) => {
        input.terminalState.signalOwnedInterruption = true;
      },
    ],
    [
      "runtime continuation",
      (input: AssistantFailureInput) => {
        input.attempt.runtimeContinuationStarted = true;
      },
    ],
    [
      "ambiguous dispatch",
      (input: AssistantFailureInput) => {
        input.currentAttemptAssistant!.errorCode = PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE;
      },
    ],
  ] as const)("does not continue after %s", async (_label, mutate) => {
    const { input } = makeSettledModelFailureInput("HTTP 502 Bad Gateway");
    mutate(input);

    expect((await handleEmbeddedAssistantFailure(input)).action).toBe("proceed");
    expect(input.prepareModelContinuation).not.toHaveBeenCalled();
    expect(input.failover.advanceAuthProfile).not.toHaveBeenCalled();
  });
});
