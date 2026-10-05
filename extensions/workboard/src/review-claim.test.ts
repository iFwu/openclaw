import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncWorkboardSubagentEnded } from "./lifecycle-sync.js";
import { createDeferred } from "./lifecycle-sync.test-support.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

afterEach(() => vi.restoreAllMocks());

async function runningCard() {
  const store = createWorkboardSqliteTestStore();
  const sessionKey = "agent:main:subagent:workboard-review-contract";
  const runId = "run-review-contract";
  const card = await store.create({
    title: "Review handoff",
    status: "todo",
    sessionKey,
    runId,
  });
  const claim = await store.claim(card.id, { ownerId: "main" });
  await store.update(card.id, {
    execution: {
      id: "exec-review-contract",
      kind: "agent-session",
      mode: "autonomous",
      status: "running",
      sessionKey,
      runId,
      startedAt: claim.card.updatedAt,
      updatedAt: claim.card.updatedAt,
    },
  });
  const latest = expectDefined(await store.get(card.id), "running card");
  const tools = new Map(
    createWorkboardTools({ store, context: { agentId: "main", sessionKey } }).map((tool) => [
      tool.name,
      tool,
    ]),
  );
  return { store, card: latest, claim, sessionKey, runId, tools };
}

async function deliverReview(f: Awaited<ReturnType<typeof runningCard>>) {
  await syncWorkboardSubagentEnded({
    store: f.store,
    event: {
      targetSessionKey: f.sessionKey,
      runId: f.runId,
      outcome: "ok",
      endedAt: f.card.updatedAt + 1,
    },
  });
}

describe("Workboard claim and user acceptance separation", () => {
  it("releases a successful review claim with its execution and attempt, retaining the session", async () => {
    const f = await runningCard();
    await deliverReview(f);
    const review = expectDefined(await f.store.get(f.card.id), "review card");
    expect(review).toMatchObject({
      status: "review",
      sessionKey: f.sessionKey,
      runId: f.runId,
      execution: { status: "review" },
    });
    expect(review.metadata?.claim).toBeUndefined();
    expect(review.metadata?.attempts?.at(-1)).toMatchObject({
      status: "succeeded",
      runId: f.runId,
    });
    expect(review.metadata?.attempts?.at(-1)?.endedAt).toBeDefined();
    const next = await f.store.create({ title: "Next owner task", status: "todo" });
    await expect(f.store.claim(next.id, { ownerId: "main" })).resolves.toMatchObject({
      card: { status: "running" },
    });
  });

  it("allows management acceptance an hour after review without a worker token or session deletion", async () => {
    const f = await runningCard();
    await deliverReview(f);
    vi.spyOn(Date, "now").mockReturnValue(f.card.updatedAt + 3_600_000);
    const done = await f.store.complete(f.card.id, { summary: "User accepted the result." }, null);
    expect(done).toMatchObject({ status: "done", sessionKey: f.sessionKey, runId: f.runId });
    expect(done.metadata?.claim).toBeUndefined();
    expect(done.metadata?.comments?.at(-1)?.body).toBe("User accepted the result.");
  });

  it("makes duplicate management acceptance a no-op instead of appending receipts", async () => {
    const f = await runningCard();
    await deliverReview(f);
    const first = await f.store.complete(f.card.id, { summary: "Accepted once." }, null);
    const second = await f.store.complete(f.card.id, { summary: "Accepted once." }, null);
    expect(second).toEqual(first);
    await expect(f.store.complete(f.card.id, { proofId: "" }, null)).rejects.toThrow(/non-empty/);
    await expect(f.store.complete(f.card.id, { proofId: "missing-proof" }, null)).rejects.toThrow(
      /proof not found/,
    );
    await expect(f.store.get(f.card.id)).resolves.toEqual(first);
  });

  it("rejects an old completion paused after the tool claim check when management has completed", async () => {
    const f = await runningCard();
    const reached = createDeferred<void>();
    const resume = createDeferred<void>();
    const nativeComplete = f.store.complete.bind(f.store);
    vi.spyOn(f.store, "complete").mockImplementationOnce(async (...args) => {
      reached.resolve();
      await resume.promise;
      return nativeComplete(...args);
    });
    const old = Promise.resolve(
      expectDefined(f.tools.get("workboard_complete"), "complete tool").execute("old-worker", {
        id: f.card.id,
        token: f.claim.token,
        summary: "Delayed worker result.",
      }),
    );
    await reached.promise;
    try {
      const done = await nativeComplete(f.card.id, { summary: "User accepted." }, null);
      const rejected = expect(old).rejects.toThrow(/claim|execution|terminal|changed/i);
      resume.resolve();
      await rejected;
      await expect(f.store.get(f.card.id)).resolves.toEqual(done);
    } finally {
      resume.resolve();
      await old.catch(() => undefined);
    }
  });

  it("rejects an old block paused after the tool claim check when management has completed", async () => {
    const f = await runningCard();
    const reached = createDeferred<void>();
    const resume = createDeferred<void>();
    const nativeBlock = f.store.block.bind(f.store);
    vi.spyOn(f.store, "block").mockImplementationOnce(async (...args) => {
      reached.resolve();
      await resume.promise;
      return nativeBlock(...args);
    });
    const old = Promise.resolve(
      expectDefined(f.tools.get("workboard_block"), "block tool").execute("old-worker", {
        id: f.card.id,
        token: f.claim.token,
        reason: "Delayed worker failure.",
      }),
    );
    await reached.promise;
    try {
      const done = await f.store.complete(f.card.id, { summary: "User accepted." }, null);
      const rejected = expect(old).rejects.toThrow(/claim|execution|terminal|changed/i);
      resume.resolve();
      await rejected;
      await expect(f.store.get(f.card.id)).resolves.toEqual(done);
    } finally {
      resume.resolve();
      await old.catch(() => undefined);
    }
  });

  it.each(["claim", "run"] as const)(
    "rejects an old completion after the same owner's %s identity changes",
    async (replacement) => {
      const f = await runningCard();
      const reached = createDeferred<void>();
      const resume = createDeferred<void>();
      const nativeComplete = f.store.complete.bind(f.store);
      vi.spyOn(f.store, "complete").mockImplementationOnce(async (...args) => {
        reached.resolve();
        await resume.promise;
        return nativeComplete(...args);
      });
      const old = Promise.resolve(
        expectDefined(f.tools.get("workboard_complete"), "complete tool").execute("old-worker", {
          id: f.card.id,
          token: f.claim.token,
          summary: "Old execution result.",
        }),
      );
      await reached.promise;
      try {
        if (replacement === "claim") {
          await f.store.releaseClaim(f.card.id, { token: f.claim.token, status: "todo" });
          await f.store.claim(f.card.id, { ownerId: "main" });
        } else {
          await f.store.update(f.card.id, {
            runId: "successor-run",
            execution: { ...expectDefined(f.card.execution, "execution"), runId: "successor-run" },
          });
        }
        const successor = expectDefined(await f.store.get(f.card.id), "successor card");
        const rejected = expect(old).rejects.toThrow(/claim|execution|changed/i);
        resume.resolve();
        await rejected;
        await expect(f.store.get(f.card.id)).resolves.toEqual(successor);
      } finally {
        resume.resolve();
        await old.catch(() => undefined);
      }
    },
  );

  it("keeps ordinary claimed automatic completion as done rather than forcing human review", async () => {
    const f = await runningCard();
    await expectDefined(f.tools.get("workboard_complete"), "complete tool").execute("automatic", {
      id: f.card.id,
      token: f.claim.token,
      summary: "Automatically completed.",
    });
    const done = expectDefined(await f.store.get(f.card.id), "automatically completed card");
    expect(done.status).toBe("done");
    expect(done.metadata?.claim).toBeUndefined();
    expect(done.sessionKey).toBe(f.sessionKey);
  });
});
