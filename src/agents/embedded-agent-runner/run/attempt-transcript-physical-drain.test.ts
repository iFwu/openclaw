import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle.js";

type Lifecycle = ReturnType<typeof createEmbeddedAttemptTranscriptLifecycle>;

// The legacy owner can only await bounded dispose. Keep that real fallback in
// the RED fixture; a reporting timeout must not certify accepted writes closed.
function physicalDrain(lifecycle: Lifecycle): Promise<void> {
  const exact = (lifecycle as Lifecycle & { waitForDrain?: () => Promise<void> }).waitForDrain;
  return exact ? exact.call(lifecycle) : lifecycle.dispose();
}

afterEach(() => vi.useRealTimers());

describe("native transcript physical-drain evidence", () => {
  it("keeps the existing bounded dispose behavior", async () => {
    vi.useFakeTimers();
    const release = createDeferred();
    const entered = createDeferred();
    const lifecycle = createEmbeddedAttemptTranscriptLifecycle({});
    const write = lifecycle.withTranscriptWrite(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    try {
      const dispose = lifecycle.dispose();
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(dispose).resolves.toBeUndefined();
      await expect(lifecycle.withTranscriptWrite(() => {})).rejects.toThrow("attempt disposed");
    } finally {
      release.resolve();
      await write;
    }
  });

  it("does not publish physical closure when only the teardown budget elapsed", async () => {
    vi.useFakeTimers();
    const release = createDeferred();
    const entered = createDeferred();
    const lifecycle = createEmbeddedAttemptTranscriptLifecycle({});
    const write = lifecycle.withTranscriptWrite(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const closed = vi.fn();
    const drain = physicalDrain(lifecycle).then(closed);
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(closed).not.toHaveBeenCalled();
      release.resolve();
      await write;
      await drain;
      expect(closed).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await Promise.all([write, drain]);
    }
  });

  it("includes a late admitted descendant before releasing the captured writer", async () => {
    vi.useFakeTimers();
    const outer = createDeferred();
    const nested = createDeferred();
    const entered = createDeferred();
    const nestedEntered = createDeferred();
    const lifecycle = createEmbeddedAttemptTranscriptLifecycle({});
    const write = lifecycle.withTranscriptWrite(async () => {
      entered.resolve();
      await outer.promise;
      void lifecycle.withTranscriptWrite(async () => {
        nestedEntered.resolve();
        await nested.promise;
      });
    });
    await entered.promise;
    const closed = vi.fn();
    const drain = physicalDrain(lifecycle).then(closed);
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      outer.resolve();
      await nestedEntered.promise;
      expect(closed).not.toHaveBeenCalled();
      nested.resolve();
      await write;
      await drain;
      expect(closed).toHaveBeenCalledOnce();
    } finally {
      outer.resolve();
      nested.resolve();
      await Promise.all([write, drain]);
    }
  });

  it("closes an idle captured lifecycle without borrowing another instance", async () => {
    const first = createEmbeddedAttemptTranscriptLifecycle({ sessionId: "same-session" });
    const next = createEmbeddedAttemptTranscriptLifecycle({ sessionId: "same-session" });
    await physicalDrain(first);
    await expect(next.withTranscriptWrite(() => "next-instance")).resolves.toBe("next-instance");
    await next.dispose();
  });
});
