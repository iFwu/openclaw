import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { TelegramMessageContext } from "./bot-message-context.js";
import { clearTelegramReaction } from "./status-reaction-clear.js";

export function createTelegramDispatchStatus(params: {
  cfg: TelegramMessageContext["cfg"];
  context: TelegramMessageContext;
}) {
  const { cfg, context } = params;
  const controller =
    context.ctxPayload.InboundEventKind === "room_event" ? null : context.statusReactionController;
  const finalize = async (final: { outcome: "done" | "error" | "cancelled" }) => {
    if (context.ctxPayload.InboundEventKind === "room_event") {
      return;
    }
    if (!controller) {
      if (cfg.messages?.removeAckAfterReply && context.ackReactionPromise) {
        // A failed response cannot prove that Telegram did not apply the acknowledgement.
        await context.ackReactionPromise;
        await clearTelegramReaction(async () =>
          context.reactionApi?.(context.chatId, context.msg.message_id, []),
        );
      }
      return;
    }
    if (final.outcome === "done") {
      await controller.setDone();
    } else if (final.outcome === "error") {
      await controller.setError();
    }
    if (cfg.messages?.removeAckAfterReply) {
      await controller.clear();
    } else {
      await controller.restoreInitial();
    }
  };

  const finalizeInBackground = (
    final: { outcome: "done" | "error" | "cancelled" },
    label: string,
  ) => {
    void finalize(final).catch((err: unknown) => {
      logVerbose(`telegram: status reaction ${label} failed: ${String(err)}`);
    });
  };

  return { controller, finalizeInBackground };
}
