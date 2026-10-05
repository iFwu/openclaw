import type {
  WorkboardNotification,
  WorkboardCard,
  WorkboardNotificationSubscription,
} from "@openclaw/workboard-contract";
import type { PersistedWorkboardNotificationSubscription } from "./persistence-types.js";
import {
  cardRunId,
  cardSessionKey,
  compareNotifications,
  notificationSequence,
  notificationDeliveryKey,
  notificationDeliveryKeys,
  cardBoardId,
} from "./store-card-helpers.js";
import type {
  WorkboardNotificationEventsInput,
  WorkboardNotificationListOptions,
  WorkboardNotificationSubscribeInput,
} from "./store-inputs.js";
import {
  normalizeBoardId,
  normalizeBoundedString,
  normalizeNotificationSubscription,
} from "./store-normalizers.js";
import { WorkboardWorkflowStore } from "./store-workflow.js";

export class WorkboardNotificationStore extends WorkboardWorkflowStore {
  private readonly unknownWakeKeys = new Set<string>();
  async subscribeNotifications(
    input: WorkboardNotificationSubscribeInput,
  ): Promise<WorkboardNotificationSubscription> {
    return await this.enqueueMutation(async () => {
      const subscription = normalizeNotificationSubscription(input);
      await this.subscriptionStore.register(subscription.id, { version: 1, subscription });
      return subscription;
    });
  }

  async listNotificationSubscriptions(
    input: WorkboardNotificationListOptions = {},
  ): Promise<{ subscriptions: WorkboardNotificationSubscription[] }> {
    const boardId = normalizeBoardId(input.boardId);
    const cardId = normalizeBoundedString(input.cardId, undefined, 120, "card id");
    const subscriptions = (await this.subscriptionStore.entries({ boardId, cardId }))
      .map((entry) => entry.value)
      .filter(
        (entry): entry is PersistedWorkboardNotificationSubscription =>
          entry?.version === 1 && Boolean(entry.subscription?.id),
      )
      .map((entry) => entry.subscription)
      .filter((subscription) => !boardId || subscription.boardId === boardId)
      .filter((subscription) => !cardId || subscription.cardId === cardId)
      .toSorted((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    return { subscriptions };
  }

  async deleteNotificationSubscription(id: string): Promise<{ deleted: boolean }> {
    return await this.enqueueMutation(async () => ({
      deleted: await this.subscriptionStore.delete(id.trim()),
    }));
  }

  private async collectNotificationEvents(
    input: WorkboardNotificationEventsInput = {},
    snapshot?: WorkboardCard[],
    wake = false,
  ): Promise<{
    subscription?: WorkboardNotificationSubscription;
    events: WorkboardNotification[];
  }> {
    const subscriptionId = normalizeBoundedString(
      input.subscriptionId,
      undefined,
      120,
      "subscription id",
    );
    const boardId = normalizeBoardId(input.boardId);
    const cardId = normalizeBoundedString(input.cardId, undefined, 120, "card id");
    const limit =
      typeof input.limit === "number" && Number.isFinite(input.limit)
        ? Math.max(1, Math.min(200, Math.trunc(input.limit)))
        : 50;
    const subscriptionEntry = subscriptionId
      ? await this.subscriptionStore.lookup(subscriptionId)
      : undefined;
    if (subscriptionId && !subscriptionEntry?.subscription) {
      throw new Error(`notification subscription not found: ${subscriptionId}`);
    }
    const subscription = subscriptionEntry?.subscription;
    const effectiveCardId = subscription?.cardId ?? cardId;
    const effectiveBoardId = effectiveCardId ? undefined : (subscription?.boardId ?? boardId);
    const effectiveSessionKey = subscription?.sessionKey;
    const effectiveRunId = subscription?.runId;
    const events: WorkboardNotification[] = [];
    const selectedCard = !snapshot && effectiveCardId ? await this.get(effectiveCardId) : undefined;
    const cards = snapshot
      ? snapshot.filter((card) =>
          effectiveCardId
            ? card.id === effectiveCardId
            : !effectiveBoardId || cardBoardId(card) === effectiveBoardId,
        )
      : effectiveCardId
        ? selectedCard
          ? [selectedCard]
          : []
        : await this.list({ boardId: effectiveBoardId });
    for (const card of cards) {
      if (card.metadata?.archivedAt || (effectiveCardId && card.id !== effectiveCardId)) {
        continue;
      }
      const stale = card.metadata?.stale;
      const notifications = [
        ...(card.metadata?.notifications ?? []),
        ...(stale
          ? [
              {
                id: `stale:${card.id}:${stale.detectedAt}`,
                kind: "stale" as const,
                createdAt: stale.detectedAt,
                sequence: stale.detectedAt * 1000,
                message: stale.reason,
                ...(cardSessionKey(card) ? { sessionKey: cardSessionKey(card) } : {}),
                ...(cardRunId(card) ? { runId: cardRunId(card) } : {}),
              },
            ]
          : []),
      ];
      for (const event of notifications) {
        const eventSessionKey = event.sessionKey ?? cardSessionKey(card);
        const eventRunId = event.runId ?? cardRunId(card);
        if (effectiveSessionKey && eventSessionKey !== effectiveSessionKey) {
          continue;
        }
        if (effectiveRunId && eventRunId !== effectiveRunId) {
          continue;
        }
        if (subscription?.eventKinds?.length && !subscription.eventKinds.includes(event.kind)) {
          continue;
        }
        // Cursor advancement must use the same mixed-sequence ordering as
        // event delivery or valid same-millisecond notifications disappear.
        if (
          !wake &&
          subscription?.lastEventAt !== undefined &&
          compareNotifications(event, {
            id: subscription.lastEventId ?? "",
            kind: event.kind,
            createdAt: subscription.lastEventAt,
            ...(subscription.lastEventSequence !== undefined
              ? { sequence: subscription.lastEventSequence }
              : {}),
            message: "",
          }) <= 0
        ) {
          continue;
        }
        events.push(event);
      }
    }
    const sorted = events.toSorted(compareNotifications);
    return {
      ...(subscription ? { subscription } : {}),
      events: wake ? sorted : sorted.slice(0, limit),
    };
  }

  async notificationEvents(input: WorkboardNotificationEventsInput = {}) {
    return await this.collectNotificationEvents(input);
  }

  async notificationWakeBaseline(): Promise<ReadonlySet<string>> {
    return notificationDeliveryKeys(await this.list());
  }

  async deliverNotificationWakes(
    deliver: (
      subscription: WorkboardNotificationSubscription,
      event: WorkboardNotification,
    ) => boolean,
    historicalEventKeys: ReadonlySet<string>,
    assertCurrent: () => void,
  ): Promise<{ unknownEventCount: number }> {
    if (!this.runWithNotificationWake) {
      throw new Error("Notification wakes require their atomic worker effect owner.");
    }
    return await this.runWithNotificationWake(assertCurrent, deliver, () =>
      this.enqueueMutation(async () => {
        const subscriptions = (await this.listNotificationSubscriptions()).subscriptions.filter(
          (entry) => entry.wakeSessionKey,
        );
        if (!subscriptions.length) {
          return { unknownEventCount: 0 };
        }
        const cards = await this.list();
        const retainedEventKeys = [...notificationDeliveryKeys(cards)];
        let unknownEventCount = 0;
        for (const subscription of subscriptions) {
          assertCurrent();
          const result = await this.collectNotificationEvents(
            { subscriptionId: subscription.id },
            cards,
            true,
          );
          if (!result.subscription?.wakeSessionKey) {
            continue;
          }
          const expected = result.subscription;
          const delivered = new Set(expected.deliveredEventIds ?? []);
          const unique = new Set<string>();
          const scopeKey = (key: string) =>
            JSON.stringify([expected.id, expected.wakeSessionKey, key]);
          const events = result.events
            .map((notification) => ({ key: notificationDeliveryKey(notification), notification }))
            .filter(({ key }) => {
              if (
                unique.has(key) ||
                historicalEventKeys.has(key) ||
                delivered.has(key) ||
                this.unknownWakeKeys.has(scopeKey(key))
              ) {
                return false;
              }
              unique.add(key);
              return true;
            })
            .slice(0, 200);
          if (!events.length) {
            continue;
          }
          const outcome = await this.subscriptionStore.deliverWakesIfCurrent({
            expected,
            events,
            retainedEventKeys,
          });
          for (const key of outcome.unknownEventIds) {
            this.unknownWakeKeys.add(scopeKey(key));
            unknownEventCount += 1;
          }
        }
        return { unknownEventCount };
      }),
    );
  }

  async advanceNotificationEvents(input: WorkboardNotificationEventsInput = {}): Promise<{
    subscription?: WorkboardNotificationSubscription;
    events: WorkboardNotification[];
  }> {
    const subscriptionId = normalizeBoundedString(
      input.subscriptionId,
      undefined,
      120,
      "subscription id",
    );
    if (!subscriptionId) {
      throw new Error("subscriptionId is required to advance notification events.");
    }
    return await this.enqueueMutation(async () => {
      const result = await this.notificationEvents({ ...input, subscriptionId });
      if (!result.subscription || !result.events.length) {
        return result;
      }
      const last = result.events.at(-1)!;
      const lastSequence = notificationSequence(last);
      const subscription = await this.subscriptionStore.advanceCursorIfCurrent(
        result.subscription,
        {
          lastEventAt: last.createdAt,
          lastEventId: last.id,
          ...(lastSequence !== undefined ? { lastEventSequence: lastSequence } : {}),
        },
      );
      if (!subscription) {
        return { events: [] };
      }
      return { subscription, events: result.events };
    });
  }
}
