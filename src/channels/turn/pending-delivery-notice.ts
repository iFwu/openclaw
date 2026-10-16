import { updateSessionEntry } from "../../config/sessions/session-accessor.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";
import { getGatewayRecoveryRuntime } from "../../gateway/server-recovery-runtime-context.js";
import { findDeliveryIntentOwner } from "../../infra/outbound/delivery-queue-storage.js";
import {
  sessionChanges,
  isSessionStoreTopologyChange,
} from "../../sessions/session-row-changes.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.read.js";
import {
  deliveryContextKey,
  normalizeDeliveryContext,
} from "../../utils/delivery-context.shared.js";

const PENDING_DELIVERY_NOTICE =
  "I couldn’t confirm whether my previous reply reached this chat, so I won’t resend it automatically. Please ask for any missing remainder.";

function noticeId(intentId: string): string {
  return `main-session-restart-recovery:pending-final:${intentId}`;
}

export async function deliverPendingDeliveryNotice(
  sessionKey: string,
  storePath: string,
): Promise<void> {
  const runtime = getGatewayRecoveryRuntime();
  if (!runtime) {
    return;
  }
  let entryChanged = false;
  const unsubscribe = sessionChanges.subscribeFacts((change) => {
    if (
      isSessionStoreTopologyChange(change) ||
      (!("all" in change) && change.sessionKey === sessionKey)
    ) {
      entryChanged = true;
    }
  });
  try {
    return await withSessionEntryReadOnlyInWorker(
      { sessionKey, storePath, readConsistency: "latest", hydrateSkillPromptRefs: false },
      () => {},
      async (read, owner) => {
        if (!read.ok) {
          throw read.error;
        }
        const entry = read.value;
        const notice = entry?.pendingDeliveryNotice;
        const context = normalizeDeliveryContext(notice?.context);
        if (
          !entry ||
          !notice ||
          notice.state !== "owed" ||
          !context?.channel ||
          !context.to ||
          deliveryContextKey(context) !== deliveryContextKey(deliveryContextFromSession(entry))
        ) {
          return;
        }
        const pending = entry.pendingFinalDelivery;
        const replayText =
          context.channel === "telegram" &&
          pending?.kind === "replayable" &&
          pending.intentId === notice.intentId &&
          deliveryContextKey(normalizeDeliveryContext(pending.context)) ===
            deliveryContextKey(context) &&
          pending.deliveries?.some((delivery) => delivery.state === "unknown") &&
          pending.text.trim()
            ? pending.text
            : undefined;
        const text = replayText
          ? `补发上一条回复（之前未确认送达，可能重复；未重新执行任务）：\n\n${replayText}`
          : context.channel === "telegram"
            ? "上条回复未确认送达。请在当前话题要求补发缺失内容，不要重新执行原任务。"
            : PENDING_DELIVERY_NOTICE;
        const idempotencyKey = `${noticeId(notice.intentId)}${replayText ? ":replay" : ""}`;
        await owner.refreshBeforeDispatch?.(() => owner.assertCurrent());
        owner.assertCurrent();
        if (entryChanged) {
          return;
        }
        let delivered: boolean;
        try {
          const outcome = await runtime.sendRecoveryNotice({
            channel: context.channel,
            to: context.to,
            accountId: context.accountId,
            threadId: context.threadId,
            text,
            idempotencyKey,
            isCurrent: () => {
              owner.assertCurrent();
              return !entryChanged;
            },
          });
          delivered = !outcome.suppressed;
        } catch {
          const intentOwner = await findDeliveryIntentOwner(idempotencyKey);
          if (intentOwner?.status !== "completed" && intentOwner?.status !== "failed") {
            return;
          }
          delivered = intentOwner.status === "completed";
        }
        if (
          delivered &&
          !(
            await appendAssistantMessageToSessionTranscript({
              sessionKey,
              storePath,
              expectedSessionId: entry.sessionId,
              text,
              idempotencyKey,
            })
          ).ok
        ) {
          return;
        }
        await updateSessionEntry(
          { sessionKey, storePath },
          (current) =>
            current.sessionId === entry.sessionId &&
            current.pendingDeliveryNotice?.intentId === notice.intentId &&
            current.pendingDeliveryNotice.state !== "acknowledged"
              ? {
                  // Retain the terminal fact: queue settlement may replay after this
                  // acknowledgment, and one intent must never owe its notice again.
                  pendingDeliveryNotice: {
                    ...current.pendingDeliveryNotice,
                    state: delivered ? "acknowledged" : "unresolved",
                  },
                  updatedAt: Date.now(),
                }
              : null,
          { skipMaintenance: true, takeCacheOwnership: true },
        );
      },
    );
  } finally {
    unsubscribe();
  }
}
