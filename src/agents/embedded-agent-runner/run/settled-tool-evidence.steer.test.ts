import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { subscribeEmbeddedAgentSession } from "../../embedded-agent-subscribe.js";
import {
  createTestSession,
  createAssistant,
  createAssistantResultStream,
  streamMocks,
  registerAgentSessionLoopTestLifecycle,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { findCurrentAttemptAssistantMessage } from "./attempt-context-engine-helpers.js";
import { buildAttemptReplayMetadata } from "./attempt-terminal-evidence.js";
import { removeTrailingMidTurnPrecheckAssistantError } from "./attempt-transcript-helpers.js";
import { resolveSettledToolBatchEvidence } from "./incomplete-turn-recovery.js";
import { MidTurnPrecheckSignal } from "./midturn-precheck.js";

const request = {
  route: "compact_only",
  estimatedPromptTokens: 201_000,
  promptBudgetBeforeReserve: 200_000,
  overflowTokens: 1_000,
  toolResultReducibleChars: 0,
  effectiveReserveTokens: 0,
} as const;

registerAgentSessionLoopTestLifecycle();

async function runSteeredToolBatch(source: "precheck" | "provider" = "precheck") {
  const execute = vi.fn(async () => {
    await session.steer("also check the result");
    return { content: [{ type: "text" as const, text: "write completed" }], details: {} };
  });
  const { session, sessionManager } = await createTestSession({
    contextOverflowRecoveryOwner: "caller",
    customTools: [
      {
        name: "record_effect",
        label: "record effect",
        description: "record a synthetic effect",
        parameters: Type.Object({}),
        execute,
      },
    ],
  });
  const subscription = subscribeEmbeddedAgentSession({ session, runId: "steer-compaction-test" });
  streamMocks.streamSimple.mockImplementationOnce((model) =>
    createAssistantResultStream(
      createAssistant(
        model,
        [{ type: "toolCall", id: "write-once", name: "record_effect", arguments: {} }],
        "toolUse",
      ),
    ),
  );
  if (source === "precheck") {
    const originalTransform = session.agent.transformContext;
    session.agent.transformContext = async (messages, signal) => {
      if (messages.some((message) => message.role === "toolResult")) {
        throw new MidTurnPrecheckSignal(request);
      }
      return originalTransform ? originalTransform(messages, signal) : messages;
    };
  } else {
    streamMocks.streamSimple.mockImplementationOnce((model) =>
      createAssistantResultStream({
        ...createAssistant(model, [], "error"),
        errorMessage: "Context overflow: prompt too large for the model",
      }),
    );
  }
  try {
    await session.prompt("write once");
    expect(execute, JSON.stringify(session.messages)).toHaveBeenCalledOnce();
    expect(streamMocks.streamSimple).toHaveBeenCalledTimes(source === "precheck" ? 1 : 2);
    if (source === "precheck") {
      removeTrailingMidTurnPrecheckAssistantError({ activeSession: session, sessionManager });
    }
    const messagesSnapshot = session.messages.slice();
    expect(messagesSnapshot.filter((message) => message.role === "user").at(-1)).toMatchObject({
      content: expect.arrayContaining([expect.objectContaining({ text: "also check the result" })]),
    });
    const attempt = makeEmbeddedRunnerAttempt({
      messagesSnapshot,
      currentAttemptAssistant: findCurrentAttemptAssistantMessage({
        messagesSnapshot,
        prePromptMessageCount: 0,
      }),
      itemLifecycle: subscription.getItemLifecycle(),
      toolMetas: subscription.toolMetas.map((entry) => ({
        ...entry,
        toolName: entry.toolName ?? "",
      })),
    });
    attempt.currentAttemptReplayMetadata = buildAttemptReplayMetadata(attempt);
    expect(attempt.itemLifecycle).toEqual({ startedCount: 1, completedCount: 1, activeCount: 0 });
    expect(attempt.currentAttemptReplayMetadata.replaySafe).toBe(false);
    return attempt;
  } finally {
    subscription.unsubscribe();
  }
}

describe("settled tool evidence across live steering", () => {
  it.each(["precheck", "provider"] as const)(
    "preserves the actual loop and subscription batch for %s recovery, not terminal finalization",
    async (source) => {
      const attempt = await runSteeredToolBatch(source);
      expect(resolveSettledToolBatchEvidence(attempt).allToolsProvenSettled).toBe(false);
      expect(
        resolveSettledToolBatchEvidence(attempt, undefined, "current-attempt")
          .allToolsProvenSettled,
      ).toBe(true);
    },
  );

  it.each(["new-attempt", "wrong-name", "missing-result", "active-tool", "newer-batch"] as const)(
    "does not recover an unproven batch: %s",
    async (boundary) => {
      const attempt = await runSteeredToolBatch();
      if (boundary === "new-attempt") {
        attempt.toolMetas = [];
      } else if (boundary === "wrong-name") {
        attempt.toolMetas = [{ toolName: "read", toolCallId: "write-once", replaySafe: false }];
      } else if (boundary === "missing-result") {
        attempt.messagesSnapshot = attempt.messagesSnapshot.filter(
          (message) => message.role !== "toolResult",
        );
      } else if (boundary === "active-tool") {
        attempt.itemLifecycle.activeCount = 1;
        attempt.itemLifecycle.completedCount = 0;
      } else {
        attempt.messagesSnapshot.push(
          buildEmbeddedRunnerAssistant({
            stopReason: "toolUse",
            content: [
              { type: "toolCall", id: "new-unsettled", name: "record_effect", arguments: {} },
            ],
          }),
        );
        attempt.messagesSnapshot.push({ role: "user", content: "continue", timestamp: 3 });
      }
      expect(
        resolveSettledToolBatchEvidence(attempt, undefined, "current-attempt")
          .allToolsProvenSettled,
      ).toBe(false);
    },
  );
});
