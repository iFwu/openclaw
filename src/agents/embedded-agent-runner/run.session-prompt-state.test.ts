import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import {
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../admitted-run-context.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import { FailoverError } from "../failover-error.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import type { PreparedEmbeddedRunInput } from "./run/execution-context.js";
import {
  createModelContinuationCallbacks,
  createModelContinuationState,
} from "./run/model-continuation.js";
import { createEmbeddedRunSessionPromptState } from "./run/session-prompt-state.js";
import { resolveEmbeddedRunTerminal } from "./run/terminal-resolution.js";
import { makeTerminalInput } from "./run/terminal-resolution.test-support.js";
import { createEmbeddedRunTerminalRetryState } from "./run/terminal-retry-state.js";

const assertActive = () => {};

const CONTINUE_FROM_TRANSCRIPT_PROMPT =
  "Continue the current task from the existing transcript, preserving completed work. If an action was interrupted, inspect its state before deciding whether to retry it. Do not restart the task or repeat completed actions.";
const CONTINUE_AFTER_TOOL_FAILURE_PROMPT = `${CONTINUE_FROM_TRANSCRIPT_PROMPT} If a tool failed, say so; never claim completion or success.`;

const BASE_RUN_PARAMS = {
  admittedRunContext: createTestAdmittedRunContext("run-1"),
  agentId: "main",
  sessionId: "test-session",
  sessionKey: "agent:main:test-key",
  sessionFile: "agent:main:test-key",
  sessionTarget: {
    agentId: "main",
    sessionId: "test-session",
    sessionKey: "agent:main:test-key",
    storePath: "/tmp/openclaw-test.sqlite",
  },
  workspaceDir: "/tmp/workspace",
  prompt: "hello",
  timeoutMs: 30_000,
  runId: "run-1",
} satisfies PreparedEmbeddedRunInput["runParams"];

const TEST_ADMISSION = {
  agentId: "main",
  sessionId: BASE_RUN_PARAMS.sessionId,
  sessionKey: BASE_RUN_PARAMS.sessionKey,
  storePath: BASE_RUN_PARAMS.sessionTarget.storePath,
  generation: "test-generation",
  entryId: "msg-user-1",
  rawSeq: 1,
  effectiveParentId: null,
  activeMessagePosition: 0,
  logicalTurnId: "test-logical-turn",
  role: "user" as const,
};

function makeUserMessage(content = BASE_RUN_PARAMS.prompt) {
  return { role: "user" as const, content, timestamp: 1 };
}

function createRecorder(
  overrides: Partial<UserTurnTranscriptRecorder> = {},
): UserTurnTranscriptRecorder {
  let pendingPersistence: Promise<void> | undefined;
  return {
    message: makeUserMessage(),
    resolveMessage: vi.fn(async () => makeUserMessage()),
    getAdmissionReceipt: () => TEST_ADMISSION,
    markRuntimePersistencePending: vi.fn((pending) => {
      pendingPersistence = pending;
    }),
    markRuntimePersisted: vi.fn(),
    markBlocked: vi.fn(),
    hasPersisted: vi.fn(() => false),
    isBlocked: vi.fn(() => false),
    hasRuntimePersistencePending: vi.fn(() => pendingPersistence !== undefined),
    waitForRuntimePersistence: vi.fn(async () => {
      await pendingPersistence;
    }),
    persistApproved: vi.fn(async () => undefined),
    persistBlocked: vi.fn(async () => undefined),
    persistFallback: vi.fn(async () => undefined),
    ...overrides,
  };
}

function createState(overrides: Partial<PreparedEmbeddedRunInput["runParams"]> = {}) {
  return createEmbeddedRunSessionPromptState({
    runParams: { ...BASE_RUN_PARAMS, ...overrides },
    sessionAgentId: "main",
    resolvedSessionKey: BASE_RUN_PARAMS.sessionKey,
    lifecycleGeneration: "test-generation",
    onInterrupt: () => {},
  });
}

describe("embedded run session prompt state", () => {
  it("resumes a settled checkpoint as internal context without repeating the user request", async () => {
    await using state = await createState({
      modelContinuation: {
        runId: BASE_RUN_PARAMS.runId,
        checkpoint: {
          sessionId: BASE_RUN_PARAMS.sessionId,
          sessionFile: BASE_RUN_PARAMS.sessionFile,
          toolCallIds: ["write-1"],
          includeToolFailureInstruction: true,
        },
      },
    });

    expect(state.activePrompt).toEqual({
      override: CONTINUE_AFTER_TOOL_FAILURE_PROMPT,
      persisted: true,
      internal: true,
    });
    expect(state.suppressNextUserMessagePersistence).toBe(true);
  });

  it.each(["run", "session", "file"])(
    "rejects a checkpoint from a different %s",
    async (identity) => {
      await expect(
        createState({
          modelContinuation: {
            runId: identity === "run" ? "other-run" : BASE_RUN_PARAMS.runId,
            checkpoint: {
              sessionId: identity === "session" ? "other-session" : BASE_RUN_PARAMS.sessionId,
              sessionFile: identity === "file" ? "/tmp/other.jsonl" : BASE_RUN_PARAMS.sessionFile,
              toolCallIds: ["write-1"],
              includeToolFailureInstruction: false,
            },
          },
        }),
      ).rejects.toThrow("Model continuation no longer owns the current session transcript");
    },
  );

  it.each([
    ["persistence", "abort"],
    ["persistence", "authority"],
    ["projection", "abort"],
    ["projection", "authority"],
  ] as const)("rejects %s checkpoint preparation after %s revocation", async (stage, revoke) => {
    const runId = `run:checkpoint-${stage}-${revoke}`;
    const admission = prepareSystemAgentRunAdmission({}, runId, "main", "checkpoint-test");
    const controller = new AbortController();
    const entered = createDeferred();
    const release = createDeferred();
    try {
      const admittedRunContext = await admission.admit("embedded");
      const assertRunActive = resolveAdmittedRunActiveAssertion(
        admittedRunContext,
        controller.signal,
      );
      if (!assertRunActive) {
        throw new Error("test admission has no active authority");
      }
      await using state = await createState({
        runId,
        admittedRunContext,
        sessionPersistence: "detached",
      });
      state.sessionTarget = undefined;
      vi.spyOn(
        state,
        stage === "persistence"
          ? "waitForCurrentUserMessagePersistence"
          : "settleOwnedTranscriptProjection",
      ).mockImplementation(async () => {
        entered.resolve();
        await release.promise;
      });
      const modelContinuation = createModelContinuationState(runId);
      const callbacks = createModelContinuationCallbacks({
        state: modelContinuation,
        sessionPromptState: state,
        assertActive: assertRunActive,
        throwIfAborted: () => controller.signal.throwIfAborted(),
        abortSignal: controller.signal,
      });
      const pending = callbacks.prepare({
        toolCallIds: ["write-1"],
        includeToolFailureInstruction: false,
      });
      const rejected = expect(pending).rejects.toThrow(
        "admitted run authority is no longer active",
      );
      await entered.promise;
      if (revoke === "abort") {
        controller.abort(new Error("checkpoint cancelled"));
      } else {
        admission.close();
      }
      release.resolve();
      await rejected;
      expect(modelContinuation.checkpoint).toBeUndefined();
      expect(state.activePrompt.internal).toBe(false);
    } finally {
      release.resolve();
      admission.close();
    }
  });

  it("does not authorize fallback after its prepared run loses authority", async () => {
    const runId = "run:checkpoint-capture";
    const admission = prepareSystemAgentRunAdmission({}, runId, "main", "checkpoint-test");
    try {
      const admittedRunContext = await admission.admit("embedded");
      const assertRunActive = resolveAdmittedRunActiveAssertion(admittedRunContext);
      if (!assertRunActive) {
        throw new Error("test admission has no active authority");
      }
      const modelContinuation = createModelContinuationState(runId);
      await using state = await createState({
        runId,
        admittedRunContext,
        sessionPersistence: "detached",
      });
      state.sessionTarget = undefined;
      const callbacks = createModelContinuationCallbacks({
        state: modelContinuation,
        sessionPromptState: state,
        assertActive: assertRunActive,
        throwIfAborted: () => {},
      });
      await callbacks.prepare({ toolCallIds: ["write-1"], includeToolFailureInstruction: false });
      admission.close();
      expect(() =>
        callbacks.captureFailure(new FailoverError("429", { reason: "rate_limit" })),
      ).toThrow("admitted run authority is no longer active");
      expect(modelContinuation.fallbackError).toBeUndefined();
    } finally {
      admission.close();
    }
  });

  it("keeps a compound internal prompt across a missing-assistant retry", async () => {
    await using state = await createState();
    state.activateInternalPrompt("  finish the reasoning exactly  ");
    state.activateCompactionContinuation("continue after compaction");
    const activePrompt = {
      override: "  finish the reasoning exactly  \n\ncontinue after compaction",
      persisted: true,
      internal: true,
    };
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      lastAssistant: undefined,
      currentAttemptAssistant: undefined,
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });

    const resolved = await resolveEmbeddedRunTerminal(
      makeTerminalInput({
        attempt,
        attemptAssistant: undefined,
        activePromptPersisted: state.activePrompt.persisted,
        activateInternalPrompt: state.activateInternalPrompt,
        activateCompactionContinuation: state.activateCompactionContinuation,
        setSuppressNextUserMessagePersistence: (value) => {
          state.suppressNextUserMessagePersistence = value;
        },
      }),
    );

    expect(resolved).toEqual({ action: "retry" });
    expect(state.activePrompt).toEqual(activePrompt);
    expect(state.suppressNextUserMessagePersistence).toBe(true);
  });

  it("retains compaction continuation across reasoning and empty retries", async () => {
    await using state = await createState();
    const retryState = createEmbeddedRunTerminalRetryState();
    const compactionAssistant = buildEmbeddedRunnerAssistant({
      stopReason: "length",
      providerReplay: {
        v: 1,
        type: "openai-responses-compaction",
        id: "cmp-shared-state",
        data: "opaque-compaction",
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.6-luna",
        baseUrlHash: "base-url-hash",
      },
    });
    const compactionAttempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      lastAssistant: compactionAssistant,
      currentAttemptAssistant: compactionAssistant,
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
    const terminalInput = {
      retryState,
      activePromptPersisted: state.activePrompt.persisted,
      activateInternalPrompt: state.activateInternalPrompt,
      activateCompactionContinuation: state.activateCompactionContinuation,
      clearCompactionContinuation: state.clearCompactionContinuation,
      setSuppressNextUserMessagePersistence: (value: boolean) => {
        state.suppressNextUserMessagePersistence = value;
      },
    };

    await expect(
      resolveEmbeddedRunTerminal(
        makeTerminalInput({
          ...terminalInput,
          attempt: compactionAttempt,
          attemptAssistant: compactionAssistant,
        }),
      ),
    ).resolves.toEqual({ action: "retry" });

    const reasoningAssistant = buildEmbeddedRunnerAssistant({
      content: [
        {
          type: "thinking",
          thinking: "internal reasoning",
          thinkingSignature: JSON.stringify({ id: "rs-shared-state", type: "reasoning" }),
        },
      ],
    });
    const reasoningAttempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      lastAssistant: reasoningAssistant,
      currentAttemptAssistant: reasoningAssistant,
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
    await expect(
      resolveEmbeddedRunTerminal(
        makeTerminalInput({
          ...terminalInput,
          attempt: reasoningAttempt,
          attemptAssistant: reasoningAssistant,
        }),
      ),
    ).resolves.toEqual({ action: "retry" });

    const emptyResponseAssistant = buildEmbeddedRunnerAssistant({
      content: [{ type: "text", text: "" }],
    });
    await expect(
      resolveEmbeddedRunTerminal(
        makeTerminalInput({
          ...terminalInput,
          attempt: makeEmbeddedRunnerAttempt({
            assistantTexts: [],
            lastAssistant: emptyResponseAssistant,
            currentAttemptAssistant: emptyResponseAssistant,
            currentAttemptReplayMetadata: {
              hadPotentialSideEffects: false,
              replaySafe: true,
            },
          }),
        }),
      ),
    ).resolves.toEqual({ action: "retry" });

    const prompt = state.activePrompt.override ?? "";
    expect(prompt).toContain("The previous attempt did not produce a user-visible answer.");
    expect(prompt).not.toContain("recorded reasoning");
    expect(prompt.match(/Continue from the compacted transcript/gu)).toHaveLength(1);
  });

  it("keeps a draft revision pending until its owned projection is ready", async () => {
    const reconcile = await import("../../config/sessions/session-transcript-reconcile.js");
    const projection = createDeferred();
    const projectionStarted = createDeferred();
    const waitForProjection = vi
      .spyOn(reconcile, "waitForSessionTranscriptProjection")
      .mockImplementation(async () => {
        projectionStarted.resolve();
        await projection.promise;
      });
    await using state = await createState();
    try {
      state.activateCompactionContinuation("continue after compaction");
      const assistant = buildEmbeddedRunnerAssistant({
        content: [{ type: "text", text: "Visible draft." }],
      });
      const attempt = makeEmbeddedRunnerAttempt({
        assistantTexts: ["Visible draft."],
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
        beforeAgentFinalizeRevisionReason: "Tighten the final wording.",
        currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
      });

      await expect(
        resolveEmbeddedRunTerminal(
          makeTerminalInput({
            attempt,
            attemptAssistant: assistant,
            payloadsWithToolMedia: [{ text: "Visible draft." }],
            finalAssistantVisibleText: "Visible draft.",
            activePromptPersisted: state.activePrompt.persisted,
            activateInternalPrompt: state.activateInternalPrompt,
            markOwnedTranscriptRetry: state.markOwnedTranscriptRetry,
            activateCompactionContinuation: state.activateCompactionContinuation,
            clearCompactionContinuation: state.clearCompactionContinuation,
          }),
        ),
      ).resolves.toEqual({ action: "retry" });

      expect(state.activePrompt.override).toContain("Tighten the final wording.");
      expect(state.activePrompt.override).not.toContain("continue after compaction");
      let resumed = false;
      const retryReady = state
        .settleOwnedTranscriptProjection(BASE_RUN_PARAMS.sessionTarget)
        .then(() => {
          resumed = true;
        });
      await expect(
        Promise.race([
          projectionStarted.promise.then(() => "projection"),
          retryReady.then(() => "retry"),
        ]),
      ).resolves.toBe("projection");
      await Promise.resolve();
      expect(resumed).toBe(false);
      projection.resolve();
      await retryReady;
      expect(resumed).toBe(true);
    } finally {
      projection.resolve();
      waitForProjection.mockRestore();
    }
  });

  it("retains a model-only task across repeated transient continuation without persisting it", async () => {
    const task = "FIRST perform the boot health callback, then inspect the receipt.";
    await using state = await createState({
      prompt: task,
      promptIsModelOnly: true,
      suppressNextUserMessagePersistence: true,
    });
    state.continueFromCurrentTranscript();
    expect(state.activePrompt.override).toBe(`${task}\n\n${CONTINUE_FROM_TRANSCRIPT_PROMPT}`);
    state.continueFromCurrentTranscript({ includeToolFailureInstruction: true });
    expect(state.activePrompt.override).toBe(`${task}\n\n${CONTINUE_AFTER_TOOL_FAILURE_PROMPT}`);
    expect(state.activePrompt.internal).toBe(true);
    expect(state.suppressNextUserMessagePersistence).toBe(true);
  });

  it("does not reinsert an already persisted user request just because persistence is suppressed", async () => {
    await using state = await createState({ suppressNextUserMessagePersistence: true });
    state.continueFromCurrentTranscript();
    expect(state.activePrompt.override).toBe(CONTINUE_FROM_TRANSCRIPT_PROMPT);
  });

  it("adds failed-tool guidance to current-transcript continuation", async () => {
    await using state = await createState();

    state.continueFromCurrentTranscript({ includeToolFailureInstruction: true });

    expect(state.activePrompt).toEqual({
      override: CONTINUE_AFTER_TOOL_FAILURE_PROMPT,
      persisted: true,
      internal: true,
    });
  });

  it.each([{ modelRun: true }, { promptMode: "none" as const }])(
    "keeps the original prompt for a raw model run retry (%o)",
    async (rawRun) => {
      await using state = await createState(rawRun);

      state.continueFromCurrentTranscript();

      // Raw runs load no transcript history, so a continuation prompt would drop the task.
      expect(state.activePrompt.override).toBeUndefined();
      expect(state.activePrompt.internal).toBe(false);
    },
  );

  it("continues from the transcript after compaction when the runtime persisted the user turn", async () => {
    const runtimeMessage = makeUserMessage();
    const persistApproved = vi.fn(async () => undefined);
    const recorder = createRecorder({
      hasPersisted: vi.fn(() => true),
      persistApproved,
    });
    const onUserMessagePersisted = vi.fn();
    await using state = await createState({
      userTurnTranscriptRecorder: recorder,
      onUserMessagePersisted,
    });

    state.onUserMessagePersisted(runtimeMessage);
    await state.prepareCompactedTranscriptRetry(assertActive);

    expect(persistApproved).toHaveBeenCalledOnce();
    expect(onUserMessagePersisted).toHaveBeenCalledWith(runtimeMessage);
    expect(state.activePrompt).toEqual({
      override: CONTINUE_FROM_TRANSCRIPT_PROMPT,
      persisted: true,
      internal: true,
    });
    expect(state.suppressNextUserMessagePersistence).toBe(true);
  });

  it("persists before_agent_run block markers through the blocked path", async () => {
    const blockedMessage = {
      ...makeUserMessage("[blocked by before_agent_run]"),
      __openclaw: {
        beforeAgentRunBlocked: {
          blockedBy: "before_agent_run",
          blockedAt: 123,
        },
      },
    };
    const persistApproved = vi.fn(async () => undefined);
    const persistBlocked = vi.fn(async () => ({
      admission: TEST_ADMISSION,
      sessionFile: BASE_RUN_PARAMS.sessionFile,
      sessionEntry: undefined,
      messageId: "msg-user-blocked",
      message: blockedMessage,
    }));
    const recorder = createRecorder({ persistApproved, persistBlocked });
    const onUserMessagePersisted = vi.fn();
    await using state = await createState({
      userTurnTranscriptRecorder: recorder,
      onUserMessagePersisted,
    });

    state.onUserMessagePersisted(blockedMessage);
    await state.waitForCurrentUserMessagePersistence();

    expect(persistApproved).not.toHaveBeenCalled();
    expect(persistBlocked).toHaveBeenCalledWith(blockedMessage);
    expect(recorder.markRuntimePersistencePending).toHaveBeenCalledOnce();
    expect(recorder.markBlocked).not.toHaveBeenCalled();
    expect(recorder.markRuntimePersisted).not.toHaveBeenCalled();
    expect(onUserMessagePersisted).toHaveBeenCalledWith(blockedMessage);
    expect(state.activePrompt.persisted).toBe(true);
  });

  it("keeps the original prompt when canonical persistence appends nothing", async () => {
    const persistApproved = vi.fn(async () => undefined);
    const recorder = createRecorder({ persistApproved });
    const onUserMessagePersisted = vi.fn();
    await using state = await createState({
      userTurnTranscriptRecorder: recorder,
      onUserMessagePersisted,
    });

    state.onUserMessagePersisted(makeUserMessage());
    await state.prepareCompactedTranscriptRetry(assertActive);

    expect(persistApproved).toHaveBeenCalledOnce();
    expect(onUserMessagePersisted).not.toHaveBeenCalled();
    expect(state.activePrompt).toEqual({ persisted: false, internal: false });
    expect(state.suppressNextUserMessagePersistence).toBe(false);
  });

  it.each(["active", "closed"] as const)(
    "revalidates the %s owner after pending canonical persistence before retry",
    async (owner) => {
      const persistedMessage = makeUserMessage();
      const callerError = new Error("caller stopped while user persistence was pending");
      let closed = false;
      const assertPersistenceOwnerActive = () => {
        if (closed) {
          throw callerError;
        }
      };
      const persistence =
        createDeferred<Awaited<ReturnType<UserTurnTranscriptRecorder["persistApproved"]>>>();
      const persistApproved = vi.fn(() => persistence.promise);
      const recorder = createRecorder({ persistApproved });
      const onUserMessagePersisted = vi.fn();
      await using state = await createState({
        userTurnTranscriptRecorder: recorder,
        onUserMessagePersisted,
      });

      state.onUserMessagePersisted(persistedMessage);
      let retryPrepared = false;
      const retryPromise = state
        .prepareCompactedTranscriptRetry(assertPersistenceOwnerActive)
        .then(() => {
          retryPrepared = true;
        });
      await Promise.resolve();

      expect(recorder.waitForRuntimePersistence).toHaveBeenCalledOnce();
      expect(retryPrepared).toBe(false);
      expect(state.suppressNextUserMessagePersistence).toBe(false);

      closed = owner === "closed";
      persistence.resolve({
        admission: TEST_ADMISSION,
        sessionFile: BASE_RUN_PARAMS.sessionFile,
        sessionEntry: undefined,
        messageId: "msg-user-delayed",
        message: persistedMessage,
      });
      if (closed) {
        await expect(retryPromise).rejects.toBe(callerError);
        expect(retryPrepared).toBe(false);
        expect(state.activePrompt.override).toBeUndefined();
        expect(state.suppressNextUserMessagePersistence).toBe(false);
      } else {
        await retryPromise;
        expect(state.activePrompt.override).toBe(CONTINUE_FROM_TRANSCRIPT_PROMPT);
        expect(state.suppressNextUserMessagePersistence).toBe(true);
      }
      expect(persistApproved).toHaveBeenCalledOnce();
      expect(recorder.markRuntimePersistencePending).toHaveBeenCalledOnce();
      expect(recorder.markRuntimePersisted).not.toHaveBeenCalled();
      expect(onUserMessagePersisted).toHaveBeenCalledWith(persistedMessage);
    },
  );

  it("keeps an internal reasoning continuation hidden across precheck compaction", async () => {
    const reasoningContinuation =
      "The previous assistant turn recorded reasoning; continue to the visible answer.";
    await using state = await createState();
    state.activateInternalPrompt(reasoningContinuation);

    await state.prepareCompactedTranscriptRetry(assertActive);

    expect(state.activePrompt).toEqual({
      override: reasoningContinuation,
      persisted: true,
      internal: true,
    });
    expect(state.suppressNextUserMessagePersistence).toBe(true);
  });
});
