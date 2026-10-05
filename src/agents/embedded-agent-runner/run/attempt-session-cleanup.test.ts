import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  cleanupEmbeddedAttemptResources: vi.fn(),
  clearToolSearchCatalog: vi.fn(),
  flushEmbeddedAttemptTrajectoryRecorder: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../tool-search.js", () => ({
  clearToolSearchCatalog: hoisted.clearToolSearchCatalog,
}));
vi.mock("../logger.js", () => ({
  log: { warn: hoisted.warn, error: hoisted.error },
}));
vi.mock("./attempt-trajectory-flush.js", () => ({
  flushEmbeddedAttemptTrajectoryRecorder: hoisted.flushEmbeddedAttemptTrajectoryRecorder,
}));
vi.mock("./attempt-subscription-cleanup.js", () => ({
  cleanupEmbeddedAttemptResources: hoisted.cleanupEmbeddedAttemptResources,
}));

import { createDeferred } from "../../../../test/helpers/promise.js";
import type { AgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import { SessionManager } from "../../sessions/session-manager.js";
import {
  cleanupEmbeddedAttemptSessionPhase,
  createEmbeddedAttemptSessionSettleTracker,
} from "./attempt-session-settle.js";
import { createEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle.js";

const attempt = {
  runId: "run-1",
  sessionId: "session-1",
  sessionFile: "/tmp/session.jsonl",
} as never;

function createInput(overrides: Record<string, unknown> = {}) {
  const transcriptLifecycle = {
    beginCleanup: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  };
  const emitDiagnosticRunCompleted = vi.fn();
  const trajectoryRecorder = {
    recordEvent: vi.fn(),
    describeFlushState: vi.fn(),
    flush: vi.fn(),
  };
  const state: { terminal: AgentRunAttemptTerminal; beforeAgentRunBlockedBy?: string } = {
    terminal: { kind: "ok" },
  };
  return {
    attempt,
    transcriptLifecycle,
    sessionAgentId: "main",
    buildAbortSettlePromise: () => null,
    trajectoryRecorder,
    trajectoryEndRecorded: false,
    emitDiagnosticRunCompleted,
    state,
    ...overrides,
  };
}

describe("cleanupEmbeddedAttemptSessionPhase", () => {
  afterEach(() => vi.useRealTimers());

  it("joins actual accepted writes, prompt settlement and retained runtime disposal", async () => {
    vi.useFakeTimers();
    const actual = await vi.importActual<typeof import("./attempt-subscription-cleanup.js")>(
      "./attempt-subscription-cleanup.js",
    );
    hoisted.cleanupEmbeddedAttemptResources.mockImplementation(
      actual.cleanupEmbeddedAttemptResources,
    );
    const transcriptLifecycle = createEmbeddedAttemptTranscriptLifecycle({});
    const writeGate = createDeferred();
    const writeEntered = createDeferred();
    const promptGate = createDeferred();
    const runtimeGate = createDeferred();
    const runtimeEntered = createDeferred();
    const dispose = vi.fn();
    const tracker = createEmbeddedAttemptSessionSettleTracker({ abort: async () => {} });
    const prompt = tracker.trackPromptSettlePromise(promptGate.promise);
    const write = transcriptLifecycle.withTranscriptWrite(async () => {
      writeEntered.resolve();
      await writeGate.promise;
    });
    await writeEntered.promise;
    const input = createInput({
      transcriptLifecycle,
      requirePhysicalDrain: true,
      session: { dispose },
      sessionManager: SessionManager.inMemory(),
      buildAbortSettlePromise: tracker.buildAbortSettlePromise,
      bundleMcpRuntime: {
        dispose: async () => {
          runtimeEntered.resolve();
          await runtimeGate.promise;
        },
      },
    });
    const complete = vi.fn();
    const cleanup = cleanupEmbeddedAttemptSessionPhase(input as never).then(complete);
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(dispose).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      writeGate.resolve();
      await write;
      await vi.advanceTimersByTimeAsync(0);
      expect(dispose).not.toHaveBeenCalled();
      promptGate.resolve();
      await prompt;
      await runtimeEntered.promise;
      expect(dispose).toHaveBeenCalledOnce();
      expect(complete).not.toHaveBeenCalled();
      runtimeGate.resolve();
      await cleanup;
      expect(complete).toHaveBeenCalledOnce();
    } finally {
      writeGate.resolve();
      promptGate.resolve();
      runtimeGate.resolve();
      await Promise.allSettled([write, prompt, cleanup]);
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.cleanupEmbeddedAttemptResources.mockResolvedValue(undefined);
    hoisted.flushEmbeddedAttemptTrajectoryRecorder.mockResolvedValue(undefined);
  });

  it("records the terminal event before transcript-safe resource cleanup", async () => {
    const input = createInput();

    await cleanupEmbeddedAttemptSessionPhase(input as never);

    expect(input.trajectoryRecorder.recordEvent).toHaveBeenCalledWith(
      "session.ended",
      expect.objectContaining({ status: "cleanup", aborted: false }),
    );
    expect(hoisted.flushEmbeddedAttemptTrajectoryRecorder).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        sessionId: "session-1",
        trajectoryRecorder: input.trajectoryRecorder,
      }),
    );
    expect(hoisted.clearToolSearchCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", sessionId: "session-1", agentId: "main" }),
    );
    expect(hoisted.cleanupEmbeddedAttemptResources).toHaveBeenCalledWith(
      expect.objectContaining({ aborted: false }),
    );
    expect(input.transcriptLifecycle.beginCleanup).toHaveBeenCalledOnce();
    expect(input.transcriptLifecycle.dispose).toHaveBeenCalledOnce();
    expect(input.emitDiagnosticRunCompleted).toHaveBeenCalledWith("completed", null, undefined);
  });

  it("keeps compaction timeout observations abort-like only for cleanup", async () => {
    const input = createInput();
    input.state.terminal = { kind: "timeout", phase: "compaction", source: "observation" };

    await cleanupEmbeddedAttemptSessionPhase(input as never);

    expect(hoisted.cleanupEmbeddedAttemptResources).toHaveBeenCalledWith(
      expect.objectContaining({ aborted: true }),
    );
    expect(input.emitDiagnosticRunCompleted).toHaveBeenCalledWith("completed", null, undefined);
  });

  it("emits the before-agent blocked status and owner", async () => {
    const input = createInput();
    input.state.beforeAgentRunBlockedBy = "before_agent";

    await cleanupEmbeddedAttemptSessionPhase(input as never);

    expect(input.emitDiagnosticRunCompleted).toHaveBeenCalledWith("blocked", null, {
      blockedBy: "before_agent",
    });
  });

  it("re-reads cancellation after draining transcript writes before resource cleanup", async () => {
    const controller = new AbortController();
    const drain = createDeferred();
    const draining = createDeferred();
    const abortSettle = createDeferred();
    const buildAbortSettlePromise = vi.fn(() => abortSettle.promise);
    const input = createInput({
      attempt: { runId: "run-1", sessionId: "session-1", abortSignal: controller.signal },
      buildAbortSettlePromise,
    });
    input.transcriptLifecycle.beginCleanup.mockImplementation(async () => {
      draining.resolve();
      await drain.promise;
    });
    const cleanup = cleanupEmbeddedAttemptSessionPhase(input as never);
    await draining.promise;
    controller.abort();
    expect(hoisted.cleanupEmbeddedAttemptResources).not.toHaveBeenCalled();
    drain.resolve();
    await cleanup;
    expect(hoisted.cleanupEmbeddedAttemptResources).toHaveBeenCalledWith(
      expect.objectContaining({
        aborted: true,
        abortSignal: controller.signal,
        abortSettlePromise: abortSettle.promise,
      }),
    );
    expect(buildAbortSettlePromise).toHaveBeenCalledOnce();
    expect(input.transcriptLifecycle.dispose).toHaveBeenCalledOnce();
    expect(input.emitDiagnosticRunCompleted).toHaveBeenCalledOnce();
    abortSettle.resolve();
  });

  it("re-reads abort state after trajectory flushing", async () => {
    const input = createInput();
    hoisted.flushEmbeddedAttemptTrajectoryRecorder.mockImplementation(async () => {
      input.state.terminal = {
        kind: "timeout",
        source: "external",
        phase: "prompt",
        aborted: true,
        failure: { source: "prompt", error: new Error("request aborted") },
      };
    });

    await cleanupEmbeddedAttemptSessionPhase(input as never);

    expect(hoisted.cleanupEmbeddedAttemptResources).toHaveBeenCalledWith(
      expect.objectContaining({ aborted: true }),
    );
    expect(input.emitDiagnosticRunCompleted).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({ message: "request aborted" }),
      undefined,
    );
  });
});
