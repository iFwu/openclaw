import type { LivePreviewDeliveryResult } from "openclaw/plugin-sdk/channel-outbound";
import type { TelegramDispatchTurn as Turn } from "./bot-message-dispatch.types.js";

export function toTelegramReplyDeliveryResult(
  turn: Turn,
  visibleReplySent: boolean,
  finalization?: Promise<LivePreviewDeliveryResult>,
  deliveryResult?: LivePreviewDeliveryResult,
): LivePreviewDeliveryResult {
  if (deliveryResult) {
    return {
      ...deliveryResult,
      visibleReplySent: visibleReplySent || deliveryResult.visibleReplySent,
      ...(finalization ? { finalization } : {}),
    };
  }
  if (finalization) {
    return { visibleReplySent, finalization };
  }
  return visibleReplySent
    ? { visibleReplySent: true }
    : {
        visibleReplySent: false,
        suppression: {
          reason: turn.previewLifecycle.finalSuppressed ? "channel_transform" : "no_visible_result",
        },
      };
}
