import type { Message } from "grammy/types";
import { createStructuredOutboundPayloadPlan } from "openclaw/plugin-sdk/channel-outbound";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { projectPayloadForDelivery } from "./bot-message-dispatch-payload.js";
import type {
  TelegramDispatchTurn as Turn,
  CurrentTurnTranscriptFinal,
} from "./bot-message-dispatch.types.js";
import { recordOutboundMessageForPromptContext } from "./outbound-message-context.js";
import {
  createTelegramPromptContextProjectionSequence,
  resolveTelegramPromptContextDeliverySignature,
  type TelegramPromptContextProjection,
  type TelegramPromptContextProjectionSequence,
  type TelegramPromptContextSource,
} from "./prompt-context-projection.js";

const promptContextDeliverySignature = (payload: ReplyPayload): string | undefined => {
  const projected = createStructuredOutboundPayloadPlan([payload])[0]?.payload;
  return projected ? resolveTelegramPromptContextDeliverySignature(projected) : undefined;
};

export function resolvePromptContextSource(
  turn: Turn,
  final: CurrentTurnTranscriptFinal | undefined,
  ...payloads: ReplyPayload[]
): TelegramPromptContextSource | undefined {
  const finalPayload = final
    ? projectPayloadForDelivery(turn, { text: final.text }, final.openclawDelivery)
    : undefined;
  const finalSignature = finalPayload ? promptContextDeliverySignature(finalPayload) : undefined;
  if (!final?.messageId || !finalSignature) {
    return undefined;
  }
  return payloads.some((payload) => promptContextDeliverySignature(payload) === finalSignature)
    ? { transcriptMessageId: final.messageId }
    : undefined;
}

async function recordPromptContextMessage(
  turn: Turn,
  record: {
    messageId: number;
    message?: Message;
    text?: string;
    projection?: TelegramPromptContextProjection;
  },
): Promise<boolean> {
  const { context } = turn;
  return await (
    turn.telegramDeps.recordOutboundMessageForPromptContext ?? recordOutboundMessageForPromptContext
  )({
    cfg: turn.cfg,
    ownerAgentId: turn.opts.ownerAgentId,
    account: {
      accountId: context.route.accountId,
      ...(turn.telegramCfg.name !== undefined ? { name: turn.telegramCfg.name } : {}),
      ...(context.primaryCtx.me ? { bot: context.primaryCtx.me } : {}),
    },
    ...(context.primaryCtx.me?.id !== undefined ? { botUserId: context.primaryCtx.me.id } : {}),
    chatId: String(context.chatId),
    message: record.message ?? { message_id: record.messageId },
    messageId: record.messageId,
    ...(record.text ? { text: record.text } : {}),
    ...(record.projection ? { promptContextProjection: record.projection } : {}),
    ...(turn.context.threadSpec.id !== undefined
      ? { messageThreadId: turn.context.threadSpec.id }
      : {}),
    successfulSendThread: turn.context.threadSpec,
  });
}

export const createPromptContextSequence = (
  turn: Turn,
  source?: TelegramPromptContextSource,
): TelegramPromptContextProjectionSequence =>
  createTelegramPromptContextProjectionSequence({
    ...(source ? { source } : {}),
    record: async (record) => await recordPromptContextMessage(turn, record),
  });
