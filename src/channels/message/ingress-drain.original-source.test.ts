import { beforeEach, describe, expect, it } from "vitest";
import { stageChannelInputSource } from "../../auto-reply/reply/abort-cutoff-retention.js";
import {
  listSessionPendingInputs,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { useTempSessionsFixture } from "../../config/sessions/test-helpers.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createChannelIngressDrain } from "./ingress-drain.js";
import {
  createTestIngressQueue,
  withTempState,
  type IngressDrainTestPayload,
} from "./ingress-drain.test-helpers.js";

const fixture = useTempSessionsFixture("ingress-original-source-");
const target = () => ({
  agentId: "main",
  sessionKey: "agent:main:telegram:original",
  sessionId: "original-session",
  sessionEntry: { sessionId: "original-session", updatedAt: 1 },
  storePath: fixture.storePath(),
});
beforeEach(async () => {
  await upsertSessionEntryCore(target(), target().sessionEntry);
});

const stage = () =>
  stageChannelInputSource({
    input: {
      text: "untouched caption",
      idempotencyKey: "telegram-raw-original:user",
      media: [{ url: "telegram:file/original-photo", kind: "image", hydrationSuppressed: true }],
    },
    target: target(),
    assertCurrent: () => {},
    assertAdmittedCurrent: () => {},
    assertRetainedCurrent: () => {},
  });

describe("ingress original-source custody", () => {
  it("waits for canonical original admission before superseding a media owner and tombstoning it", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("old", { text: "untouched caption" }, { laneKey: "same-chat" });
      const admission = createDeferredCore<UserTurnTranscriptRecorder | undefined>();
      const delivered = createDeferredCore();
      let signal: AbortSignal | undefined;
      const drain = createChannelIngressDrain<IngressDrainTestPayload>({
        queue,
        shouldSupersedePending: (candidate) => candidate.payload.text === "/think high",
        dispatchClaimedEvent: async (event, lifecycle) => {
          if (event.id === "old") {
            lifecycle.registerPendingInputSource?.(admission.promise);
            signal = lifecycle.abortSignal;
            signal.addEventListener(
              "abort",
              () => {
                expect(listSessionPendingInputs(target()).items).toMatchObject([
                  { state: "cancelled", message: { content: "untouched caption" } },
                ]);
              },
              { once: true },
            );
            delivered.resolve();
            return { kind: "deferred" };
          }
          await lifecycle.onAdopted();
          return { kind: "completed" };
        },
      });
      try {
        await drain.drainOnce();
        await delivered.promise;
        await queue.enqueue("command", { text: "/think high" }, { laneKey: "same-chat" });
        let finished = false;
        const superseding = drain.drainOnce().then((result) => {
          finished = true;
          return result;
        });
        await Promise.resolve();
        expect(finished).toBe(false);
        expect(signal?.aborted).toBe(false);
        expect(await queue.listClaims()).toHaveLength(1);
        admission.resolve(await stage());
        expect(await superseding).toEqual({ started: 1 });
        await drain.waitForIdle();
        expect(signal?.aborted).toBe(true);
        expect((await queue.enqueue("old", { text: "untouched caption" })).kind).toBe("completed");
        expect(listSessionPendingInputs(target()).items).toMatchObject([{ state: "cancelled" }]);
      } finally {
        drain.dispose();
      }
    });
  });

  it("does not tombstone or abort when a copied recorder cannot attest canonical retention", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("old", { text: "old" }, { laneKey: "same-chat" });
      const delivered = createDeferredCore();
      let signal: AbortSignal | undefined;
      const real = await stage();
      const drain = createChannelIngressDrain<IngressDrainTestPayload>({
        queue,
        shouldSupersedePending: () => true,
        dispatchClaimedEvent: async (_event, lifecycle) => {
          lifecycle.registerPendingInputSource?.(Promise.resolve({ ...real! }));
          signal = lifecycle.abortSignal;
          delivered.resolve();
          return { kind: "deferred" };
        },
      });
      try {
        await drain.drainOnce();
        await delivered.promise;
        await queue.enqueue("command", { text: "/think high" }, { laneKey: "same-chat" });
        await expect(drain.drainOnce()).rejects.toThrow("original sources were not retained");
        expect(signal?.aborted).toBe(false);
        expect((await queue.enqueue("old", { text: "old" })).kind).toBe("claimed");
        expect(listSessionPendingInputs(target()).items).toMatchObject([{ state: "queued" }]);
      } finally {
        real?.finishPendingInput?.("interrupted");
        drain.dispose();
      }
    });
  });

  it("releases a failed hydrated dispatch while the same canonical original can be retried", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("old", { text: "old" }, { laneKey: "same-chat" });
      const drain = createChannelIngressDrain<IngressDrainTestPayload>({
        queue,
        dispatchClaimedEvent: async (_event, lifecycle) => {
          lifecycle.registerPendingInputSource?.(stage());
          return { kind: "failed-retryable", error: new Error("temporary media download failure") };
        },
      });
      try {
        await drain.drainOnce();
        await drain.waitForIdle();
        expect(listSessionPendingInputs(target()).items).toMatchObject([{ state: "interrupted" }]);
        expect(await queue.listClaims()).toEqual([]);
        const retry = await stage();
        expect(retry).toBeDefined();
        expect(listSessionPendingInputs(target()).items).toMatchObject([{ state: "queued" }]);
        retry?.finishPendingInput?.("interrupted");
      } finally {
        drain.dispose();
      }
    });
  });
  it("does not interrupt a successfully adopted raw source through late cancellation callbacks", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("old", { text: "original" }, { laneKey: "same-chat" });
      const source = await stage();
      let cancel: (() => void | Promise<void>) | undefined;
      let abandon: (() => void | Promise<void>) | undefined;
      const drain = createChannelIngressDrain<IngressDrainTestPayload>({
        queue,
        dispatchClaimedEvent: async (_event, lifecycle) => {
          lifecycle.registerPendingInputSource?.(Promise.resolve(source));
          cancel = lifecycle.onCancelled;
          abandon = lifecycle.onAbandoned;
          await lifecycle.onAdopted();
          return { kind: "completed" };
        },
      });
      try {
        await drain.drainOnce();
        await drain.waitForIdle();
        await cancel?.();
        await abandon?.();
        expect(listSessionPendingInputs(target()).items).toMatchObject([{ state: "queued" }]);
        const aggregate = createUserTurnTranscriptRecorder({
          input: { text: "normal original", idempotencyKey: "late-cancel-aggregate:user" },
          target: target(),
          pendingInputSources: [source!],
        });
        expect((await aggregate.persistApproved())?.appended).toBe(true);
        expect(listSessionPendingInputs(target()).total).toBe(0);
        aggregate.finishPendingInput?.("interrupted");
      } finally {
        source?.finishPendingInput?.("interrupted");
        drain.dispose();
      }
    });
  });
});
