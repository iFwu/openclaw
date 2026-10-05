import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import {
  captureEmbeddedVisibleTurnOwner,
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import {
  createEmbeddedRunHandle,
  testing as embeddedTesting,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import { bindCommandOwnerAuthority, getCommandOwnerAuthority } from "../command-owner-authority.js";
import { runActiveReplySteer } from "./agent-runner-steer-adoption.js";
import { captureUninjectableOwnerGrace } from "./agent-runner-uninjectable-owner.js";
import { clearSessionQueues, type FollowupRun } from "./queue.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { testing as replyTesting } from "./reply-run-registry.test-support.js";
import { createMockTypingController } from "./test-helpers.js";
import { createTypingSignaler } from "./typing-mode.js";

// Real process-local registries and the shipped steer entry, not a replacement
// queue implementation or a claim that an unregister proves physical cleanup.
const key = "agent:main:telegram:group:owner-grace";
const sessionId = "owner-grace-session";
let nextInputId = 0;

afterEach(() => {
  clearSessionQueues([key]);
  embeddedTesting.resetActiveEmbeddedRuns();
  replyTesting.resetReplyRunRegistry();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function incoming(owner = true) {
  const run = createQueueTestRun({
    prompt: "Please report progress.",
    messageId: `current-user-${++nextInputId}`,
    currentInboundEventKind: "user_request",
  });
  run.run.sessionId = sessionId;
  run.run.sessionKey = key;
  run.run.inputProvenance = { kind: "external_user" };
  const sessionCtx: Parameters<typeof runActiveReplySteer>[0]["sessionCtx"] = {};
  if (owner) {
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "owner",
      scopes: ["operator.write"],
      source: {},
      assertCurrent: () => {},
    });
    run.operatorAuthority = authority;
    bindCommandOwnerAuthority(sessionCtx, { isCurrent: () => true, operatorAuthority: authority });
  }
  return { run, sessionCtx };
}

function steer(
  input: ReturnType<typeof incoming>,
  followup = vi.fn(async (_run: FollowupRun) => {}),
) {
  const typing = createMockTypingController();
  return runActiveReplySteer({
    followupRun: input.run,
    opts: undefined,
    providedReplyOperation: undefined,
    queueKey: key,
    releaseAdmissionTicket: () => {},
    replyOperationRunState: {},
    resolvedQueue: { mode: "steer", debounceMs: 0 },
    restartRecoverySourceTurnId: input.run.messageId,
    runFollowup: followup,
    sessionCtx: input.sessionCtx,
    sessionKey: key,
    touchActiveSessionEntry: async () => {},
    typing,
    typingSignals: createTypingSignaler({ typing, mode: "never", isHeartbeat: false }),
    toolAuthorityFingerprint: "owner-grace-fixture",
  });
}

function rawOwner(preemptable = true) {
  const supersede = vi.fn(() => true);
  const handle = {
    ...createEmbeddedRunHandle({ runId: "captured-internal-run" }),
    ...(preemptable ? { preemptByVisibleTurn: supersede } : {}),
  };
  setActiveEmbeddedRun(sessionId, handle, key);
  return { handle, supersede };
}

describe("trusted user input while an exact raw owner has no injection target", () => {
  it("observes native handle grace on the same mocked clock", async () => {
    vi.useFakeTimers();
    const { handle, supersede } = rawOwner();
    const input = incoming();
    const grace = captureUninjectableOwnerGrace({
      sessionId,
      sessionKey: key,
      followupRun: input.run,
      sessionCtx: input.sessionCtx,
    });
    expect(grace).toBeTypeOf("function");
    const work = grace?.();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(supersede).toHaveBeenCalledOnce();
    clearActiveEmbeddedRun(sessionId, handle);
    await vi.advanceTimersByTimeAsync(10_000);
    await work;
  });

  it("reaches the same native capability through the entry on a real clock", async () => {
    const { handle, supersede } = rawOwner();
    supersede.mockImplementation(() => {
      clearActiveEmbeddedRun(sessionId, handle);
      return true;
    });
    try {
      await steer(incoming());
      expect(supersede).toHaveBeenCalledOnce();
    } finally {
      clearActiveEmbeddedRun(sessionId, handle);
    }
  }, 15_000);

  it("gives short ownership a grace window without superseding it", async () => {
    vi.useFakeTimers();
    const { handle, supersede } = rawOwner();
    const work = steer(incoming());
    await vi.advanceTimersByTimeAsync(500);
    expect(supersede).not.toHaveBeenCalled();
    clearActiveEmbeddedRun(sessionId, handle);
    await vi.advanceTimersByTimeAsync(10_000);
    await work;
    expect(supersede).not.toHaveBeenCalled();
  });

  it("takes over only the captured preemptable owner after a bounded grace", async () => {
    vi.useFakeTimers();
    const { handle, supersede } = rawOwner();
    const input = incoming();
    expect(getCommandOwnerAuthority(input.sessionCtx)?.operatorAuthority).toBe(
      input.run.operatorAuthority,
    );
    expect(captureEmbeddedVisibleTurnOwner(sessionId)?.sessionKey).toBe(key);
    expect(
      captureUninjectableOwnerGrace({
        sessionId,
        sessionKey: key,
        followupRun: input.run,
        sessionCtx: input.sessionCtx,
      }),
    ).toBeTypeOf("function");
    const work = steer(input);
    // Complete the predecessor admission before advancing the grace clock.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(supersede).toHaveBeenCalledOnce();
    clearActiveEmbeddedRun(sessionId, handle);
    await vi.advanceTimersByTimeAsync(10_000);
    await work;
  });

  it("does not substitute a same-key successor for its captured owner", async () => {
    vi.useFakeTimers();
    const first = rawOwner();
    const work = steer(incoming());
    await vi.advanceTimersByTimeAsync(500);
    const next = createEmbeddedRunHandle({ runId: "successor" });
    const nextSupersede = vi.fn(() => true);
    const successor = { ...next, preemptByVisibleTurn: nextSupersede };
    setActiveEmbeddedRun(sessionId, successor, key);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(first.supersede).not.toHaveBeenCalled();
    expect(nextSupersede).not.toHaveBeenCalled();
    clearActiveEmbeddedRun(sessionId, successor);
    await vi.advanceTimersByTimeAsync(10_000);
    await work;
  });

  it.each(["no-owner", "room-event", "ordinary-run"] as const)(
    "keeps %s outside supersession eligibility",
    async (kind) => {
      vi.useFakeTimers();
      const { handle, supersede } = rawOwner(kind !== "ordinary-run");
      const input = incoming(kind !== "no-owner");
      if (kind === "room-event") {
        input.run.currentInboundEventKind = "room_event";
      }
      const work = steer(input);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(supersede).not.toHaveBeenCalled();
      clearActiveEmbeddedRun(sessionId, handle);
      await vi.advanceTimersByTimeAsync(10_000);
      await work;
    },
  );
});
