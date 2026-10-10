import { describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { resolveSessionLane } from "../../agents/embedded-agent-runner/lanes.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAssistantMessageFixture } from "../../agents/test-helpers/assistant-message-fixtures.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { useTempSessionsFixture } from "../../config/sessions/test-helpers.js";
import { runBeforeAgentReplyForTurn } from "../../plugins/before-agent-reply.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { executePreparedReplyAgentRun } from "./agent-runner-execute.js";
import type { AgentTurnExecutionResult, AgentTurnParams } from "./agent-runner-execution.types.js";
import { createTestFollowupRun } from "./agent-runner.test-fixtures.js";
import { createReplyOperation } from "./reply-run-registry.js";
import { createReplyRestartRecoveryClaimController } from "./restart-recovery-claim.js";
import { createMockTypingController } from "./test-helpers.js";
import { createTypingSignaler } from "./typing-mode.js";

const runtime = vi.hoisted(() => ({
  execute: vi.fn<(params: AgentTurnParams) => Promise<AgentTurnExecutionResult>>(),
}));
vi.mock("./agent-runner-execution.js", () => ({ executeAgentTurn: runtime.execute }));
vi.mock("./agent-runner-memory.js", () => ({
  runSessionCompactionIfNeeded: async (params: { sessionEntry: unknown }) => params.sessionEntry,
  runMemoryFlushIfNeeded: vi.fn(),
}));
vi.mock("./followup-runner.js", () => ({ createFollowupRunner: () => async () => {} }));
vi.mock("./agent-runner-result.js", () => ({
  finalizeReplyAgentRun: async () => ({ text: "second answer" }),
}));
vi.mock("../../plugins/hook-runner-global.js", () => ({ getGlobalHookRunner: () => undefined }));

const fixture = useTempSessionsFixture("reply-input-order-");

describe("reply input promotion at the runtime boundary", () => {
  it.each([false, true])(
    "preserves both requests and promotes the second only after the first completes (channel recovery=%s)",
    async (channelRecovery) => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:input-order",
        sessionId: "input-order",
        storePath: fixture.storePath(),
      };
      await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const lane = resolveSessionLane(scope.sessionKey);
      const firstStarted = createDeferred();
      const releaseFirst = createDeferred();
      const secondQueued = createDeferred();
      const completed: string[] = [];
      const first = enqueueCommandInLane(lane, async () => {
        const manager = SessionManager.open(scope, fixture.sessionsDir());
        manager.appendMessage({ role: "user", content: "first input", timestamp: 1 });
        firstStarted.resolve();
        await releaseFirst.promise;
        manager.appendMessage(
          makeAssistantMessageFixture({ content: [{ type: "text", text: "first answer" }] }),
        );
        completed.push("first");
      });
      await firstStarted.promise;
      const recorder = createUserTurnTranscriptRecorder({
        input: { text: "second input", idempotencyKey: "second-run:user" },
        target: { ...scope, expectedSessionId: scope.sessionId, sessionEntry: undefined },
      });
      await recorder.stageApproved?.({ runId: "second-run", assertCurrent: () => {} });
      const followupRun = createTestFollowupRun({
        ...scope,
        config: {},
        sessionFile: scope.sessionKey,
        workspaceDir: fixture.sessionsDir(),
        messageProvider: "webchat",
      });
      followupRun.userTurnTranscriptRecorder = recorder;
      followupRun.prompt = "second input";
      const operation = createReplyOperation({
        sessionId: scope.sessionId,
        sessionKey: scope.sessionKey,
        resetTriggered: false,
      });
      const controller = createReplyRestartRecoveryClaimController({
        ...scope,
        lifecycleGeneration: operation.lifecycleGeneration,
        getEntry: () => loadSessionEntry(scope),
        getSessionId: () => scope.sessionId,
        setEntry: () => {},
        isRestartAbort: () => false,
        sourceTurnId: channelRecovery ? "second-run:user" : undefined,
        resolveDeliveryContext: () =>
          channelRecovery ? { channel: "telegram", to: "synthetic-target" } : undefined,
      });
      runtime.execute.mockImplementationOnce((params) =>
        enqueueCommandInLane(
          lane,
          async () => {
            const hook = await runBeforeAgentReplyForTurn({
              runId: "second-run",
              trigger: "user",
              event: { cleanedBody: params.commandBody },
              context: { runId: "second-run", trigger: "user" },
            });
            expect(hook?.handled).not.toBe(true);
            const manager = SessionManager.open(scope, fixture.sessionsDir());
            manager.appendMessage(
              makeAssistantMessageFixture({ content: [{ type: "text", text: "second answer" }] }),
            );
            completed.push("second");
            return {
              runId: "second-run",
              outcome: {
                kind: "settled",
                status: "ok",
                result: { payloads: [{ text: "second answer" }], meta: { durationMs: 0 } },
                resolved: { provider: "synthetic", model: "synthetic" },
                fallback: { exhausted: false, attempts: [] },
                autoCompactionCount: 0,
                didLogHeartbeatStrip: false,
              },
            };
          },
          { onQueued: () => secondQueued.resolve() },
        ),
      );
      const typing = createMockTypingController();
      const onAdopted = vi.fn();
      const input = {
        ...scope,
        activeIsNewSession: false,
        activeSessionStore: undefined,
        blockReplyPipeline: null,
        blockStreamingEnabled: false,
        cfg: {},
        commandBody: "second input",
        opts: { runId: "second-run" },
        defaultModel: "synthetic",
        followupRun,
        isHeartbeat: false,
        pendingToolTasks: new Set<Promise<void>>(),
        queueKey: scope.sessionKey,
        replyMediaContext: {} as Parameters<
          typeof executePreparedReplyAgentRun
        >[0]["replyMediaContext"],
        replyOperation: operation,
        replyRouteThreadId: undefined,
        replyToChannel: undefined,
        replyToMode: "off" as const,
        resolvedBlockStreamingBreak: "message_end" as const,
        resolvedQueue: { mode: "followup" as const },
        resolvedVerboseLevel: "off" as const,
        returnWithQueuedFollowupDrain: <T>(value: T) => value,
        sessionCtx: { Provider: "webchat" },
        shouldInjectGroupIntro: false,
        typing,
        typingMode: "never" as const,
        typingSignals: createTypingSignaler({ typing, mode: "never", isHeartbeat: false }),
        admitUserTurn: controller.admitUserTurn,
        beginBeforeAgentReply: controller.beginBeforeAgentReply,
        checkpointBeforeAgentReply: controller.checkpointBeforeAgentReply,
        isRestartRecoveryArmed: controller.isArmed,
        getActiveSessionEntry: () => loadSessionEntry(scope),
        setActiveSessionEntry: () => {},
        runFollowupTurn: async () => {},
        setRunFollowupTurn: () => {},
        shouldEmitToolResult: () => false,
        shouldEmitToolOutput: () => false,
        applyReplyToMode: <T>(value: T) => value,
        traceAgentPhase: async <T>(_name: string, run: () => T | Promise<T>) => await run(),
        resolveVisibleReplyDelivery: async () => false,
        sendDirectCompactionNotice: undefined,
        turnAdoptionLifecycle: { onAdopted },
      } satisfies Parameters<typeof executePreparedReplyAgentRun>[0];
      const second = recorder.withPendingInput!(() => executePreparedReplyAgentRun(input));
      void second.catch(() => {});
      try {
        await withTestTimeout(
          Promise.race([
            secondQueued.promise,
            second.then(() => {
              throw new Error("second input ended before reaching its lane");
            }),
          ]),
          5_000,
          "second input did not reach the runtime lane",
        );
        expect(recorder.hasPersisted()).toBe(false);
        expect(onAdopted).not.toHaveBeenCalled();
        expect(
          SessionManager.open(scope, fixture.sessionsDir())
            .buildSessionContext()
            .messages.filter((message) => message.role === "user"),
        ).toMatchObject([{ content: "first input" }]);
        releaseFirst.resolve();
        await first;
        await expect(second).resolves.toEqual({ text: "second answer" });
        expect(onAdopted).toHaveBeenCalledOnce();
        expect(completed).toEqual(["first", "second"]);
        const messages = SessionManager.open(scope, fixture.sessionsDir()).buildSessionContext()
          .messages;
        expect(messages.map((message) => message.role)).toEqual([
          "user",
          "assistant",
          "user",
          "assistant",
        ]);
        expect(messages.filter((message) => message.role === "user")).toMatchObject([
          { content: "first input" },
          { content: "second input" },
        ]);
      } finally {
        releaseFirst.resolve();
        await Promise.allSettled([first, second]);
        recorder.finishPendingInput?.("interrupted");
        await controller.clear();
        operation.complete();
      }
    },
  );
});
