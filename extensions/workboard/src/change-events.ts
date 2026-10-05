import type { WorkboardChange } from "@openclaw/workboard-contract";
import type { OpenClawPluginApi, OpenClawPluginService } from "../api.js";
import type { WorkboardStore } from "./store.js";

const WORKBOARD_EXTERNAL_CHANGE_CHECK_MS = 1000;

type ChangeStore = Pick<
  WorkboardStore,
  "ready" | "subscribeChanges" | "announceChangeEpoch" | "reconcileExternalChanges"
> &
  Partial<Pick<WorkboardStore, "notificationWakeBaseline" | "deliverNotificationWakes">>;

export function createWorkboardChangeEventService(
  store: ChangeStore,
  wake?: Pick<OpenClawPluginApi["runtime"]["system"], "enqueueSystemEvent" | "requestHeartbeat">,
): OpenClawPluginService & { stop: () => Promise<void> } {
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let generation = 0;
  let starting: { generation: number; promise: Promise<void> } | undefined;
  let polling: Promise<void> | undefined;
  let delivery: Promise<void> | undefined;
  let deliveryQueued = false;

  return {
    id: "workboard-change-events",
    start(ctx) {
      const gatewayEvents = ctx.gatewayEvents;
      const deliverNotifications = store.deliverNotificationWakes?.bind(store);
      if ((!gatewayEvents && !wake) || unsubscribe) {
        return Promise.resolve();
      }
      if (starting?.generation === generation) {
        return starting.promise;
      }
      const currentGeneration = generation;
      const previous = starting?.promise;
      const pending = (async () => {
        await previous?.catch(() => undefined);
        await store.ready();
        if (currentGeneration !== generation) {
          return;
        }
        const historicalEventKeys = wake ? await store.notificationWakeBaseline?.() : undefined;
        if (wake && (!historicalEventKeys || !deliverNotifications)) {
          throw new Error("Workboard wake requires its notification store.");
        }
        if (currentGeneration !== generation) {
          return;
        }
        const assertCurrent = () => {
          if (currentGeneration !== generation) {
            throw new Error("Workboard notification generation is stopped.");
          }
        };
        const scheduleDelivery = (): Promise<void> => {
          if (
            !wake ||
            !historicalEventKeys ||
            currentGeneration !== generation ||
            !deliverNotifications
          ) {
            return Promise.resolve();
          }
          deliveryQueued = true;
          if (delivery) {
            return delivery;
          }
          const operation = (async () => {
            do {
              deliveryQueued = false;
              const outcome = await deliverNotifications(
                (subscription, event) => {
                  assertCurrent();
                  if (!subscription.wakeSessionKey) {
                    return false;
                  }
                  const sessionKey = subscription.wakeSessionKey;
                  try {
                    wake.enqueueSystemEvent(
                      `Workboard notification (${subscription.id}): ${event.kind}\n${event.message.slice(0, 400)}`,
                      {
                        sessionKey,
                        contextKey: `workboard:${subscription.id}:${event.id}:${event.sequence ?? event.createdAt}`,
                      },
                    );
                    assertCurrent();
                    wake.requestHeartbeat({
                      source: "other",
                      intent: "event",
                      reason: "workboard:notification",
                      sessionKey,
                      coalesceMs: 0,
                    });
                    return true;
                  } catch (error) {
                    ctx.logger.warn(`workboard notification wake failed: ${String(error)}`);
                    return false;
                  }
                },
                historicalEventKeys,
                assertCurrent,
              );
              if (outcome.unknownEventCount > 0) {
                ctx.logger.warn(
                  "workboard notification outcome unknown; attempted events will not be replayed.",
                );
              }
              if (currentGeneration !== generation) {
                break;
              }
            } while (deliveryQueued);
          })()
            .catch((error: unknown) => {
              if (currentGeneration === generation) {
                ctx.logger.warn(`workboard notification delivery failed: ${String(error)}`);
              }
            })
            .finally(() => {
              if (delivery === operation) {
                delivery = undefined;
              }
            });
          delivery = operation;
          return operation;
        };
        const emit = (change: WorkboardChange) => {
          if (currentGeneration !== generation) {
            return;
          }
          gatewayEvents?.emit("changed", change, { scope: "operator.read" });
          void scheduleDelivery();
        };
        unsubscribe = store.subscribeChanges(emit);
        store.announceChangeEpoch();
        await delivery;
        if (currentGeneration !== generation) {
          return;
        }
        timer = setInterval(() => {
          if (polling) {
            return;
          }
          polling = store
            .reconcileExternalChanges()
            .then(
              async () => {
                await scheduleDelivery();
              },
              (error: unknown) => {
                ctx.logger.warn(`workboard external change check failed: ${String(error)}`);
              },
            )
            .finally(() => {
              polling = undefined;
            });
        }, WORKBOARD_EXTERNAL_CHANGE_CHECK_MS);
        timer.unref?.();
      })().finally(() => {
        if (starting?.promise === pending) {
          starting = undefined;
        }
      });
      starting = { generation: currentGeneration, promise: pending };
      return pending;
    },
    stop() {
      generation += 1;
      unsubscribe?.();
      unsubscribe = undefined;
      deliveryQueued = false;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      return Promise.allSettled([starting?.promise, polling, delivery]).then(() => undefined);
    },
  };
}
