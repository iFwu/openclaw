// Shared agent/reply runtime helpers for channel plugins. Keep channel plugins
// off direct src/auto-reply imports by routing common reply primitives here.

export {
  chunkMarkdownText,
  chunkMarkdownTextWithMode,
  chunkText,
  chunkTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "../auto-reply/chunk.js";
export type { ChunkMode } from "../auto-reply/chunk.js";
export {
  dispatchInboundMessage,
  dispatchInboundMessageWithBufferedDispatcher,
  dispatchInboundMessageWithDispatcher,
  settleReplyDispatcher,
} from "../auto-reply/dispatch.js";
export {
  normalizeGroupActivation,
  parseActivationCommand,
} from "../auto-reply/group-activation.js";
export {
  HEARTBEAT_PROMPT,
  DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  resolveHeartbeatPromptCore,
  stripHeartbeatToken,
} from "../auto-reply/heartbeat.js";
export { resolveHeartbeatReplyPayload } from "../auto-reply/heartbeat-reply-payload.js";
export { getReplyFromConfig } from "../auto-reply/reply/get-reply.js";
export { HEARTBEAT_TOKEN, isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
export { isAbortRequestText } from "../auto-reply/reply/abort-primitives.js";
export { isBtwRequestText } from "../auto-reply/reply/btw-command.js";
export { resetInboundDedupe } from "../auto-reply/reply/inbound-dedupe.js";
export { finalizeInboundContextForSdk as finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
export {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../auto-reply/inbound-debounce.js";
export {
  dispatchReplyWithBufferedBlockDispatcherCore as dispatchReplyWithBufferedBlockDispatcher,
  dispatchReplyWithDispatcherCore as dispatchReplyWithDispatcher,
} from "../auto-reply/reply/provider-dispatcher.js";
export {
  createReplyDispatcher,
  createReplyDispatcherWithTyping,
} from "../auto-reply/reply/reply-dispatcher.js";
export type {
  ReplyDispatchBeforeDeliverOptions,
  ReplyDispatchKind,
  ReplyDispatchRuntimeInfo,
  ReplyDispatcher,
  ReplyFollowupAdmissionBarrierTimeoutPolicy,
} from "../auto-reply/reply/reply-dispatcher.types.js";
export type {
  ReplyDispatcherOptions,
  ReplyDispatcherWithTypingOptions,
} from "../auto-reply/reply/reply-dispatcher.js";
export { createReplyReferencePlanner } from "../auto-reply/reply/reply-reference.js";
export type {
  GetReplyOptions,
  BlockReplyContext,
  SourceReplyDeliveryMode,
} from "../auto-reply/get-reply-options.types.js";
export type { ReplyPayload } from "./reply-payload.js";
export type {
  ChannelStructuredContextEntry,
  FinalizedMsgContext,
  MsgContext,
  UntrustedStructuredContextEntry,
} from "../auto-reply/templating.js";
export type { CommandTurnContext } from "../auto-reply/command-turn-context.js";
export { generateConversationLabel } from "../auto-reply/reply/conversation-label-generator.js";
export type { ConversationLabelParams } from "../auto-reply/reply/conversation-label-generator.js";

/** Captures only recovery storage authority; never schedules a provider turn. */
export async function prepareCancelledChannelInputTarget(
  params: Parameters<
    typeof import("../auto-reply/reply/abort-cutoff-retention.js").prepareCancelledChannelInputTarget
  >[0],
): Promise<
  ReturnType<
    typeof import("../auto-reply/reply/abort-cutoff-retention.js").prepareCancelledChannelInputTarget
  >
> {
  const runtime = await import("../auto-reply/reply/abort-cutoff-retention.js");
  return runtime.prepareCancelledChannelInputTarget(params);
}

export type { UserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.types.js";

/** Stage original input through the native factory, never channel-owned persistence. */
export async function stageChannelInputSource(
  params: Parameters<
    typeof import("../auto-reply/reply/abort-cutoff-retention.js").stageChannelInputSource
  >[0],
) {
  const runtime = await import("../auto-reply/reply/abort-cutoff-retention.js");
  return await runtime.stageChannelInputSource(params);
}

export async function retainCancelledChannelInputSource(
  recorder: import("../sessions/user-turn-transcript.types.js").UserTurnTranscriptRecorder,
): Promise<boolean> {
  const runtime = await import("../auto-reply/reply/abort-cutoff-retention.js");
  return runtime.retainCancelledUserTurnInput(recorder);
}
