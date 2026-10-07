import {
  isTelegramEditTargetMissingError,
  isTelegramMessageHasNoTextError,
  isTelegramMessageNotModifiedError,
} from "./network-errors.js";

const deliveries = new Map<string, Promise<void>>();
/** Callback and event delivery share one card owner, including the fallback send. */
export async function deliverGuardTerminal(params: {
  key: string;
  edit: () => Promise<unknown>;
  fallback: () => Promise<unknown>;
}): Promise<void> {
  const previous = deliveries.get(params.key);
  if (previous) {
    return previous;
  }
  const delivery = Promise.resolve().then(async () => {
    try {
      await params.edit();
    } catch (error) {
      if (isTelegramMessageNotModifiedError(error)) {
        return;
      }
      if (!isTelegramEditTargetMissingError(error) && !isTelegramMessageHasNoTextError(error)) {
        throw error;
      }
      await params.fallback();
    }
  });
  if (deliveries.size >= 2_000) {
    const oldest = deliveries.keys().next().value;
    if (oldest !== undefined) {
      deliveries.delete(oldest);
    }
  }
  deliveries.set(params.key, delivery);
  // Retain unknown transport outcomes so a later callback cannot send a duplicate.
  await delivery;
}
