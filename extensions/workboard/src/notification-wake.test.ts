import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { createWorkboardSqliteTestHarness } from "./test/sqlite-store.js";

describe("Workboard notification wake persistence", () => {
  it("round-trips the wake destination independently of the worker-session filter", async () => {
    const { stores } = createWorkboardSqliteTestHarness();
    const subscription = {
      id: "wake-roundtrip",
      boardId: "ops",
      sessionKey: "agent:worker:subagent:card",
      wakeSessionKey: "agent:main:telegram:group:operator",
      target: "session:operator",
      createdAt: 10,
      updatedAt: 10,
    };
    await stores.subscriptions.register(subscription.id, { version: 1, subscription });
    expect((await stores.subscriptions.lookup(subscription.id))?.subscription).toMatchObject({
      sessionKey: subscription.sessionKey,
      wakeSessionKey: subscription.wakeSessionKey,
    });
  });

  it("allows a board subscription with an explicit wake destination", async () => {
    const { store } = createWorkboardSqliteTestHarness();
    const input = { boardId: "ops", wakeSessionKey: "agent:main:telegram:group:operator" };
    await expect(store.subscribeNotifications(input)).resolves.toMatchObject(input);
  });

  it("does not erase successful wake records when the polling cursor advances", async () => {
    const { store, stores } = createWorkboardSqliteTestHarness();
    const card = await store.create({ title: "Wake and poll have separate state", boardId: "ops" });
    const subscription = await store.subscribeNotifications({
      boardId: "ops",
      cardId: card.id,
      target: "session:operator",
      eventKinds: ["completed"],
    });
    await stores.subscriptions.register(subscription.id, {
      version: 1,
      subscription: { ...subscription, deliveredEventIds: ["prior-successful-wake"] },
    });
    await store.complete(card.id, { summary: "Done" });
    const advanced = await store.advanceNotificationEvents({ subscriptionId: subscription.id });
    expect(advanced.events).toHaveLength(1);
    const stored = await stores.subscriptions.lookup(subscription.id);
    expect(stored?.subscription).toMatchObject({
      lastEventId: advanced.events[0]?.id,
      deliveredEventIds: ["prior-successful-wake"],
    });
    expect((await store.notificationEvents({ subscriptionId: subscription.id })).events).toEqual(
      [],
    );
  });

  it.each(["delete", "replace", "wake-success"] as const)(
    "does not overwrite a subscription changed outside the mutation queue (%s)",
    async (change) => {
      const { store, stores } = createWorkboardSqliteTestHarness();
      const card = await store.create({ title: "Cursor CAS", boardId: "ops" });
      const subscription = await store.subscribeNotifications({
        cardId: card.id,
        target: "session:operator",
      });
      await store.complete(card.id, { summary: "Done" });
      const lookup = stores.subscriptions.lookup.bind(stores.subscriptions);
      const reached = createDeferred<void>();
      const release = createDeferred<void>();
      vi.spyOn(stores.subscriptions, "lookup").mockImplementationOnce(async (id) => {
        const captured = await lookup(id);
        reached.resolve();
        await release.promise;
        return captured;
      });
      const advancing = store.advanceNotificationEvents({ subscriptionId: subscription.id });
      try {
        await reached.promise;
        if (change === "delete") {
          await stores.subscriptions.delete(subscription.id);
        } else {
          await stores.subscriptions.register(subscription.id, {
            version: 1,
            subscription: {
              ...subscription,
              updatedAt: subscription.updatedAt + 1,
              ...(change === "replace"
                ? { target: "session:replacement" }
                : { deliveredEventIds: ["concurrent-wake-success"] }),
            },
          });
        }
      } finally {
        release.resolve();
      }
      await advancing;
      const stored = await lookup(subscription.id);
      if (change === "delete") {
        expect(stored).toBeUndefined();
      } else if (change === "replace") {
        expect(stored?.subscription.target).toBe("session:replacement");
      } else {
        expect(stored?.subscription.deliveredEventIds).toEqual(["concurrent-wake-success"]);
      }
    },
  );

  it("retains ordinary polling-only subscriptions", async () => {
    const { store } = createWorkboardSqliteTestHarness();
    const subscription = await store.subscribeNotifications({
      boardId: "ops",
      target: "session:operator",
    });
    expect(subscription).not.toHaveProperty("wakeSessionKey");
    expect((await store.listNotificationSubscriptions({ boardId: "ops" })).subscriptions).toEqual([
      subscription,
    ]);
  });
});
