import { Worker } from "node:worker_threads";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkboardChangeEventService } from "./change-events.js";
import { workboardSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
import { createWorkboardSqliteTestHarness } from "./test/sqlite-store.js";

const destination = "agent:main:telegram:group:wake-test";
const workerSession = "agent:worker:subagent:card-test";

function context() {
  return {
    config: {},
    stateDir: "/unused-workboard-native-wake-test",
    gatewayEvents: { emit: vi.fn(), onSessionsChanged: () => () => {} },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

function system() {
  return { enqueueSystemEvent: vi.fn(() => true), requestHeartbeat: vi.fn() };
}

afterEach(() => vi.useRealTimers());

describe("Workboard native notification wake integration", () => {
  it("wakes the destination independently of the worker-session filter and records success once", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { store, stores } = createWorkboardSqliteTestHarness();
    const wake = system();
    const service = createWorkboardChangeEventService(store, wake);
    const card = await store.create({
      title: "Native wake",
      boardId: "ops",
      sessionKey: workerSession,
    });
    const subscription = await store.subscribeNotifications({
      boardId: "ops",
      sessionKey: workerSession,
      wakeSessionKey: destination,
      eventKinds: ["completed"],
    });
    await service.start(context());
    try {
      await store.complete(card.id, { summary: "Native done" });
      await vi.waitFor(() => expect(wake.requestHeartbeat).toHaveBeenCalledOnce(), {
        timeout: 2500,
      });
      expect(wake.enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("Native done"),
        expect.objectContaining({
          sessionKey: destination,
          contextKey: expect.stringContaining(subscription.id),
        }),
      );
      expect(wake.requestHeartbeat).toHaveBeenCalledWith(
        expect.objectContaining({ sessionKey: destination, source: "other", intent: "event" }),
      );
      const persisted = await stores.subscriptions.lookup(subscription.id);
      expect(persisted?.subscription.deliveredEventIds).toHaveLength(1);
      expect(persisted?.subscription.lastEventId).toBeUndefined();
      await vi.advanceTimersByTimeAsync(2000);
      await service.stop();
      expect(wake.enqueueSystemEvent).toHaveBeenCalledOnce();
    } finally {
      await service.stop();
    }
  });

  it("retries a failed enqueue after polling advances and without another card change", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { store, stores } = createWorkboardSqliteTestHarness();
    const wake = system();
    wake.enqueueSystemEvent.mockImplementationOnce(() => {
      throw new Error("queue unavailable");
    });
    const service = createWorkboardChangeEventService(store, wake);
    const card = await store.create({ title: "Retry independently", boardId: "ops" });
    const subscription = await store.subscribeNotifications({
      cardId: card.id,
      wakeSessionKey: destination,
      eventKinds: ["completed"],
    });
    await service.start(context());
    try {
      await store.complete(card.id, { summary: "Retry me" });
      await vi.waitFor(() => expect(wake.enqueueSystemEvent).toHaveBeenCalledOnce(), {
        timeout: 2500,
      });
      await store.advanceNotificationEvents({ subscriptionId: subscription.id });
      expect(
        (await stores.subscriptions.lookup(subscription.id))?.subscription.deliveredEventIds ?? [],
      ).toEqual([]);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(wake.requestHeartbeat).toHaveBeenCalledOnce(), {
        timeout: 2500,
      });
      expect(wake.enqueueSystemEvent).toHaveBeenCalledTimes(2);
      expect(
        (await stores.subscriptions.lookup(subscription.id))?.subscription.deliveredEventIds,
      ).toHaveLength(1);
    } finally {
      await service.stop();
    }
  });

  it("treats an already queued context as success and does not advance the pull cursor", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { store, stores } = createWorkboardSqliteTestHarness();
    const wake = system();
    wake.enqueueSystemEvent.mockReturnValue(false);
    const service = createWorkboardChangeEventService(store, wake);
    const card = await store.create({ title: "Already queued", boardId: "ops" });
    const subscription = await store.subscribeNotifications({
      cardId: card.id,
      wakeSessionKey: destination,
    });
    await service.start(context());
    try {
      await store.complete(card.id, { summary: "Queued once" });
      await vi.waitFor(() => expect(wake.requestHeartbeat).toHaveBeenCalledOnce(), {
        timeout: 2500,
      });
      expect(
        (await stores.subscriptions.lookup(subscription.id))?.subscription.lastEventId,
      ).toBeUndefined();
      expect(
        (await store.notificationEvents({ subscriptionId: subscription.id })).events,
      ).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2000);
      await service.stop();
      expect(wake.enqueueSystemEvent).toHaveBeenCalledOnce();
    } finally {
      await service.stop();
    }
  });

  it("does not replay historical notifications when the service starts", async () => {
    const { store } = createWorkboardSqliteTestHarness();
    const card = await store.create({ title: "Historical", boardId: "ops" });
    await store.complete(card.id, { summary: "Before start" });
    await store.subscribeNotifications({ cardId: card.id, wakeSessionKey: destination });
    const wake = system();
    const service = createWorkboardChangeEventService(store, wake);
    await service.start(context());
    await service.stop();
    expect(wake.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(wake.requestHeartbeat).not.toHaveBeenCalled();
  });

  it("keeps stopped generations from sending later card notifications", async () => {
    const { store } = createWorkboardSqliteTestHarness();
    const card = await store.create({ title: "Stopped", boardId: "ops" });
    await store.subscribeNotifications({ cardId: card.id, wakeSessionKey: destination });
    const wake = system();
    const service = createWorkboardChangeEventService(store, wake);
    await service.start(context());
    await service.stop();
    await store.complete(card.id, { summary: "After stop" });
    expect(wake.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(wake.requestHeartbeat).not.toHaveBeenCalled();
  });
});

it.each(["delete", "replace"] as const)(
  "does not wake a subscription changed by another connection before native CAS (%s)",
  async (mode) => {
    const { store, stores, dbPath } = createWorkboardSqliteTestHarness();
    const other = createWorkboardSqliteStores({
      dbPath,
      workerModuleUrl: resolveRuntimeWorkerUrl(workboardSqliteBackendEntrypoint),
    });
    const card = await store.create({ title: "CAS fence", boardId: "ops" });
    const subscription = await store.subscribeNotifications({
      cardId: card.id,
      wakeSessionKey: destination,
    });
    await store.complete(card.id, { summary: "Pending event" });
    const deliver = vi.fn(() => true);
    const original = stores.subscriptions.deliverWakesIfCurrent.bind(stores.subscriptions);
    stores.subscriptions.deliverWakesIfCurrent = async (batch) => {
      if (mode === "delete") {
        await other.subscriptions.delete(subscription.id);
      } else {
        await other.subscriptions.register(subscription.id, {
          version: 1,
          subscription: { ...subscription, wakeSessionKey: "agent:main:replacement" },
        });
      }
      return await original(batch);
    };
    try {
      await store.deliverNotificationWakes(deliver, new Set(), () => {});
      expect(deliver).not.toHaveBeenCalled();
      const persisted = await other.subscriptions.lookup(subscription.id);
      if (mode === "delete") {
        expect(persisted).toBeUndefined();
      } else {
        expect(persisted?.subscription.wakeSessionKey).toBe("agent:main:replacement");
      }
    } finally {
      await other.close();
    }
  },
);

it("holds the real SQLite IMMEDIATE lock until its synchronous host effect finishes", async () => {
  const { store, dbPath } = createWorkboardSqliteTestHarness();
  const card = await store.create({ title: "Lock held", boardId: "ops" });
  await store.subscribeNotifications({ cardId: card.id, wakeSessionKey: destination });
  await store.complete(card.id, { summary: "Lock witness" });
  let witness: Worker | undefined;
  let joined: Promise<number> | undefined;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const deliver = vi.fn(() => {
    witness = new Worker(
      `
      const {workerData,parentPort}=require("node:worker_threads");
      const {DatabaseSync}=require("node:sqlite");
      const signal=new Int32Array(workerData.signal);
      const db=new DatabaseSync(workerData.dbPath,{timeout:0});
      let state=3;
      try {db.exec("BEGIN IMMEDIATE"); state=2; db.exec("ROLLBACK");}
      catch(error) {if(error.errcode===5 || /locked|busy/i.test(error.message)){state=1;}}
      finally {db.close();}
      Atomics.store(signal,0,state); Atomics.notify(signal,0); parentPort.close();
    `,
      { eval: true, workerData: { dbPath, signal: signal.buffer } },
    );
    joined = new Promise<number>((resolve, reject) => {
      witness?.once("exit", resolve);
      witness?.once("error", reject);
    });
    if (Atomics.load(signal, 0) === 0) {
      Atomics.wait(signal, 0, 0, 5000);
    }
    expect(Atomics.load(signal, 0)).toBe(1);
    return true;
  });
  try {
    await store.deliverNotificationWakes(deliver, new Set(), () => {});
    expect(deliver).toHaveBeenCalledOnce();
    expect(await joined).toBe(0);
  } finally {
    await witness?.terminate();
    await joined?.catch(() => {});
  }
});
