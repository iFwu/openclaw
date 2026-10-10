import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerAgentRunContext,
  clearAgentRunContext,
} from "../../../infra/agent-run-registry.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../admitted-run-context.js";
import { withPreparedEmbeddedRunToolAuthority } from "../../harness/tool-authority.runtime.js";
import { isAgentRunSupersededAbortReason } from "../../run-termination.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { testing as embeddedTesting } from "../runs.test-support.js";
import { prepareCatalogExecutor } from "./attempt-stream-prepare.test-support.js";

registerAgentSessionLoopTestLifecycle();
afterEach(() => {
  embeddedTesting.resetActiveEmbeddedRuns();
  vi.restoreAllMocks();
});

describe("peer continuation handoff at a model boundary", () => {
  it.each([
    "plain",
    "queued-input",
    "withdrawn",
    "replaced-request",
    "hidden",
    "unprojected",
  ] as const)(
    "finishes and persists an already-started tool without replay (%s)",
    async (scenario) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const tool = vi.fn(async () => {
        entered.resolve();
        await release.promise;
        return { content: [{ type: "text" as const, text: "Committed once." }], details: {} };
      });
      const { session, sessionManager } = await createTestSession({
        customTools: [
          {
            name: "commit_fixture",
            label: "Commit fixture",
            description: "Commit a synthetic test effect",
            parameters: Type.Object({}),
            execute: tool,
          },
        ],
      });
      streamMocks.streamSimple
        .mockImplementation((model) =>
          createAssistantResultStream(
            createAssistant(model, [{ type: "text", text: "Required answer completed." }]),
          ),
        )
        .mockImplementationOnce((model) =>
          createAssistantResultStream(
            createAssistant(
              model,
              [{ type: "toolCall", id: "commit-call", name: "commit_fixture", arguments: {} }],
              "toolUse",
            ),
          ),
        );
      if (scenario === "queued-input") {
        streamMocks.streamSimple.mockImplementationOnce((model) =>
          createAssistantResultStream(
            createAssistant(
              model,
              [{ type: "toolCall", id: "answer-call", name: "commit_fixture", arguments: {} }],
              "toolUse",
            ),
          ),
        );
      }
      const runId = "run-output-schema";
      if (scenario === "unprojected") {
        registerAgentRunContext(runId, {
          isControlUiVisible: false,
          projectSessionMessages: false,
        });
      }
      const attempt = {
        runId,
        agentId: "main",
        sessionId: "session-output-schema",
        sessionKey: "agent:main:telegram:group:peer-handoff",
        sessionFile: "/tmp/peer-handoff-session",
        workspaceDir: "/tmp/peer-handoff-workspace",
        config: {},
        provider: "test-provider",
        modelId: "test-model",
        messageProvider: "webchat",
        inputProvenance: {
          kind: "inter_session" as const,
          sourceTool: "sessions_send",
          ...(scenario === "hidden" ? { sourceRole: "subagent" as const } : {}),
        },
      };
      const admission = prepareAgentRunAdmission({
        cfg: {},
        operationalRunInstance: createOperationalRunInstanceRef(runId),
        facts: {
          agentId: "main",
          runId,
          ingress: { kind: "system", state: "present", boundary: "peer-handoff-fixture" },
        },
      });
      try {
        const admittedRunContext = await admission.admit("embedded", "peer-handoff-fixture");
        await withPreparedEmbeddedRunToolAuthority(
          { admittedRunContext },
          attempt,
          undefined,
          async (preparedAttempt) => {
            const controller = new AbortController();
            const cleanup = createDeferredCore();
            const previous = session.agent.prepareNextTurnWithContext;
            const permissionCheckpoint = session.agent.prepareNextTurn;
            const abortRun = vi.fn((_timeout: unknown, reason: unknown) => {
              controller.abort(reason);
              session.agent.abort(reason);
            });
            const prepared = prepareCatalogExecutor([], {
              activeSession: session,
              sessionKey: attempt.sessionKey,
              runAbortController: controller,
              abortRun,
              getRunState: () => ({
                aborted: controller.signal.aborted,
                timedOut: false,
                promptError: undefined,
                yieldDetected: false,
              }),
              attempt: {
                ...preparedAttempt,
                admittedRunContext,
                waitForOwnerCleanup: () => cleanup.promise,
              },
            });
            const prompt = session.prompt("Continue the synthetic task.");
            let acceptedInput: Promise<unknown> | undefined;
            try {
              await entered.promise;
              let sourceCurrent = true;
              if (scenario === "queued-input") {
                const accepted = createDeferredCore();
                acceptedInput = prepared.queueHandle.queueMessage(
                  "accepted correction before handoff",
                  {
                    isInboundUserMessage: true,
                    queueIdentity: "accepted-correction",
                    waitForTranscriptCommit: true,
                    onQueueAccepted: (value) => {
                      if (value) {
                        accepted.resolve();
                      }
                    },
                  },
                );
                await accepted.promise;
              }
              if (scenario === "hidden" || scenario === "unprojected") {
                expect(prepared.queueHandle.requestYieldToVisibleTurn).toBeUndefined();
              } else {
                expect(prepared.queueHandle.requestYieldToVisibleTurn?.(() => sourceCurrent)).toBe(
                  scenario !== "queued-input",
                );
              }
              if (scenario === "withdrawn" || scenario === "replaced-request") {
                sourceCurrent = false;
              }
              if (scenario === "replaced-request") {
                expect(prepared.queueHandle.requestYieldToVisibleTurn?.(() => true)).toBe(true);
              }
              expect(abortRun).not.toHaveBeenCalled();
              expect(tool).toHaveBeenCalledOnce();
              release.resolve();
              await prompt;
              await acceptedInput;
              expect(tool).toHaveBeenCalledTimes(scenario === "queued-input" ? 2 : 1);
              expect(streamMocks.streamSimple).toHaveBeenCalledTimes(
                scenario === "queued-input"
                  ? 3
                  : scenario === "plain" || scenario === "replaced-request"
                    ? 1
                    : 2,
              );
              if (scenario === "queued-input") {
                expect(JSON.stringify(streamMocks.streamSimple.mock.calls[1]?.[1])).toContain(
                  "accepted correction before handoff",
                );
              }
              expect(
                sessionManager
                  .getBranch()
                  .some(
                    (entry) =>
                      entry.type === "message" &&
                      entry.message.role === "toolResult" &&
                      entry.message.toolCallId === "commit-call",
                  ),
              ).toBe(true);
              if (
                scenario === "withdrawn" ||
                scenario === "hidden" ||
                scenario === "unprojected" ||
                scenario === "queued-input"
              ) {
                expect(abortRun).not.toHaveBeenCalled();
              } else {
                expect(abortRun).toHaveBeenCalledOnce();
                expect(isAgentRunSupersededAbortReason(controller.signal.reason)).toBe(true);
                expect(controller.signal.reason).toMatchObject({ turnHandoff: true });
              }
              prepared.subscription.unsubscribe();
              expect(session.agent.prepareNextTurnWithContext).toBe(previous);
              expect(session.agent.prepareNextTurn).toBe(permissionCheckpoint);
              if (scenario !== "hidden" && scenario !== "unprojected") {
                expect(prepared.queueHandle.requestYieldToVisibleTurn?.(() => true)).toBe(false);
              }
            } finally {
              release.resolve();
              cleanup.resolve();
              await prompt;
              await acceptedInput;
              prepared.subscription.unsubscribe();
            }
          },
        );
      } finally {
        admission.close();
        clearAgentRunContext(runId);
      }
    },
  );
});
