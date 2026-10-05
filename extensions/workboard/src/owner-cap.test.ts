import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { workboardSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
import { WorkboardStore } from "./store.js";
import { createWorkboardSqliteTestHarness } from "./test/sqlite-store.js";

const workerModuleUrl = resolveRuntimeWorkerUrl(workboardSqliteBackendEntrypoint);

function configuredHarness(maxRunningPerOwner: number) {
  return createWorkboardSqliteTestHarness({
    createStores: (dbPath) => ({
      ...createWorkboardSqliteStores({ dbPath, workerModuleUrl }),
      maxRunningPerOwner,
    }),
  });
}

async function readyCards(store: WorkboardStore, owners = ["shared", "shared", "shared"]) {
  return await Promise.all(
    owners.map((agentId, index) =>
      store.create({
        title: `Owner capacity ${index}`,
        status: "ready",
        agentId,
        boardId: `board-${index}`,
        position: index * 1000,
        workspaceAccess: { unrestricted: true },
      }),
    ),
  );
}

function mockRun() {
  let sequence = 0;
  return vi.fn().mockImplementation(async () => ({ runId: `run-${++sequence}` }));
}

describe("Workboard configured owner capacity", () => {
  it("claims two cards across boards at capacity two and refuses the third", async () => {
    const { store } = configuredHarness(2);
    const [first, second, third] = await readyCards(store);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(third).toBeDefined();
    await store.claim(first!.id, { ownerId: "shared" });
    await store.claim(second!.id, { ownerId: "shared" });
    await expect(store.claim(third!.id, { ownerId: "shared" })).rejects.toThrow(
      "already has active Workboard work",
    );
    await expect(store.get(third!.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("defaults to one slot without a configured override", async () => {
    const { store } = createWorkboardSqliteTestHarness();
    const [first, second] = await readyCards(store, ["shared", "shared"]);
    await store.claim(first!.id, { ownerId: "shared" });
    await expect(store.claim(second!.id, { ownerId: "shared" })).rejects.toThrow(
      "already has active Workboard work",
    );
  });

  it("starts two cards across boards at capacity two and refuses an exact third start", async () => {
    const { store } = configuredHarness(2);
    const cards = await readyCards(store);
    const run = mockRun();
    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { maxStarts: 3 },
    });
    expect(result.started).toHaveLength(2);
    expect(run).toHaveBeenCalledTimes(2);
    const queued = (await store.list()).find((card) => card.status === "ready");
    expect(queued).toBeDefined();
    const third = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { cardId: queued!.id, maxStarts: 1 },
    });
    expect(third.started).toEqual([]);
    expect(third.startFailures).toEqual([
      expect.objectContaining({
        cardId: queued!.id,
        error: expect.stringContaining("Owner shared"),
      }),
    ]);
    expect(run).toHaveBeenCalledTimes(2);
    for (const started of result.started) {
      expect(cards.map((card) => card.id)).toContain(started.cardId);
      await expect(store.get(started.cardId)).resolves.toMatchObject({
        status: "running",
        metadata: { claim: { ownerId: "shared" }, automation: { launch: { phase: "accepted" } } },
      });
    }
  });

  it("counts an existing direct claim before filling the remaining dispatch slot", async () => {
    const { store } = configuredHarness(2);
    const [first, second, third] = await readyCards(store);
    await store.claim(first!.id, { ownerId: "shared" });
    const run = mockRun();
    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { maxStarts: 3 },
    });
    expect(result.started.map((card) => card.cardId)).toEqual([second!.id]);
    expect(run).toHaveBeenCalledOnce();
    await expect(store.get(third!.id)).resolves.toMatchObject({ status: "ready" });
    expect((await store.list()).filter((card) => card.metadata?.claim)).toHaveLength(2);
  });

  it("blocks new work after a capacity decrease without cancelling existing claims", async () => {
    const { store, dbPath } = configuredHarness(2);
    const [first, second, third] = await readyCards(store);
    const a = await store.claim(first!.id, { ownerId: "shared" });
    const b = await store.claim(second!.id, { ownerId: "shared" });
    const persistence = createWorkboardSqliteStores({ dbPath, workerModuleUrl });
    const lower = new WorkboardStore(persistence.cards, { ...persistence, maxRunningPerOwner: 1 });
    try {
      await expect(lower.claim(third!.id, { ownerId: "shared" })).rejects.toThrow(
        "already has active Workboard work",
      );
      const run = mockRun();
      expect(
        (
          await dispatchAndStartWorkboardCards({
            store: lower,
            subagent: { run },
            options: { cardId: third!.id },
          })
        ).started,
      ).toEqual([]);
      expect(run).not.toHaveBeenCalled();
      expect((await lower.get(first!.id))?.metadata?.claim?.token).toBe(a.token);
      expect((await lower.get(second!.id))?.metadata?.claim?.token).toBe(b.token);
    } finally {
      await lower.close();
    }
  });

  it("gives each owner a first turn before filling a second slot", async () => {
    const { store } = configuredHarness(2);
    const cards = await readyCards(store, ["shared", "shared", "other"]);
    const run = mockRun();
    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { maxStarts: 3 },
    });
    expect(result.started.map((card) => card.cardId)).toEqual([
      cards[0]!.id,
      cards[2]!.id,
      cards[1]!.id,
    ]);
  });

  it.each([1, 2])(
    "shares capacity %i across concurrent store connections and boards",
    async (cap) => {
      const { store, dbPath } = configuredHarness(cap);
      const persistence = createWorkboardSqliteStores({ dbPath, workerModuleUrl });
      const options = { ...persistence, maxRunningPerOwner: cap };
      const other = new WorkboardStore(persistence.cards, options);
      try {
        const cards = await readyCards(store, ["shared", "shared", "shared", "shared"]);
        const results = await Promise.allSettled(
          cards.map((card, index) =>
            (index % 2 ? other : store).claim(card.id, { ownerId: "shared" }),
          ),
        );
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(cap);
        for (const result of results) {
          if (result.status === "rejected") {
            const error: unknown = result.reason;
            expect(error).toBeInstanceOf(Error);
            if (!(error instanceof Error)) {
              throw new Error("claim rejection was not an Error");
            }
            expect(error.message).toContain("already has active Workboard work");
          }
        }
        expect((await store.list()).filter((card) => card.metadata?.claim)).toHaveLength(cap);
      } finally {
        await other.close();
      }
    },
  );

  it("shares capacity between concurrent direct claims and exact dispatch on another connection", async () => {
    const { store, dbPath } = configuredHarness(2);
    const persistence = createWorkboardSqliteStores({ dbPath, workerModuleUrl });
    const options = { ...persistence, maxRunningPerOwner: 2 };
    const other = new WorkboardStore(persistence.cards, options);
    try {
      const [first, direct, launch] = await readyCards(store);
      await store.claim(first!.id, { ownerId: "shared" });
      const run = mockRun();
      const results = await Promise.allSettled([
        store.claim(direct!.id, { ownerId: "shared" }),
        dispatchAndStartWorkboardCards({
          store: other,
          subagent: { run },
          options: { cardId: launch!.id, maxStarts: 1 },
        }),
      ]);
      expect((await store.list()).filter((card) => card.metadata?.claim)).toHaveLength(2);
      const directAccepted = results[0]?.status === "fulfilled" ? 1 : 0;
      expect(directAccepted + run.mock.calls.length).toBe(1);
    } finally {
      await other.close();
    }
  });

  it("does not allow per-dispatch parameters to raise the configured capacity", async () => {
    const { store } = createWorkboardSqliteTestHarness();
    await readyCards(store);
    const run = mockRun();
    const options = { maxStarts: 3, maxRunningPerOwner: 99 };
    const result = await dispatchAndStartWorkboardCards({ store, subagent: { run }, options });
    expect(result.started).toHaveLength(1);
    expect(run).toHaveBeenCalledOnce();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid store capacity %s before any claims",
    (maxRunningPerOwner) => {
      const { stores } = createWorkboardSqliteTestHarness();
      const options = { ...stores, maxRunningPerOwner };
      expect(() => new WorkboardStore(stores.cards, options)).toThrow("positive integer");
    },
  );
});
