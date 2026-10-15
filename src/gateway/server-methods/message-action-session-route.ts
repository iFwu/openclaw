import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { readStringOrNumberParam } from "../../agents/tools/common.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import type {
  ChannelId,
  ChannelPlugin,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeMessageActionInput } from "../../infra/outbound/message-action-normalization.js";
import { prepareOutboundMirrorRoute } from "../../infra/outbound/message-action-threading.js";
import {
  ensureOutboundSessionEntry,
  resolveOutboundSessionRoute,
} from "../../infra/outbound/outbound-session.js";

/** Prepare route identity before dispatch; persist only after platform acceptance. */
export async function prepareMessageActionSessionRoute(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  plugin: ChannelPlugin;
  accountId?: string;
  agentId?: string;
  actionParams: Record<string, unknown>;
  toolContext?: ChannelThreadingToolContext;
  sourceSessionKey?: string;
  creation?: MsgContext["SessionCreation"];
  replyToIsExplicit?: boolean;
  assertCommitAllowed?: () => void;
}): Promise<() => Promise<void>> {
  const resolvedTo = normalizeOptionalString(params.actionParams.to);
  const args = normalizeMessageActionInput({
    action: "send",
    args: params.actionParams,
    toolContext: params.toolContext,
    targetAliasSpec: params.plugin.actions?.messageActionTargetAliases?.send,
  });
  const to = resolvedTo ?? normalizeOptionalString(args.to);
  if (!to || !params.agentId) {
    return async () => {};
  }
  const threadId =
    readStringOrNumberParam(args, "messageThreadId") ?? readStringOrNumberParam(args, "threadId");
  if (threadId) {
    args.threadId = threadId;
  }
  const replyTo =
    readStringOrNumberParam(args, "replyToMessageId") ?? readStringOrNumberParam(args, "replyTo");
  if (replyTo) {
    args.replyTo = replyTo;
  }
  const { outboundRoute } = await prepareOutboundMirrorRoute({
    cfg: params.cfg,
    channel: params.channel,
    to,
    actionParams: args,
    accountId: params.accountId,
    toolContext: params.toolContext,
    agentId: params.agentId,
    currentSessionKey: params.sourceSessionKey,
    replyToIsExplicit: params.replyToIsExplicit,
    resolveAutoThreadId: params.plugin.threading?.resolveAutoThreadId,
    resolveReplyTransport: params.plugin.threading?.resolveReplyTransport,
    resolveOutboundSessionRoute: (routeParams) =>
      resolveOutboundSessionRoute({ ...routeParams, plugin: params.plugin }),
  });
  // Dispatch and persistence consume the same prepared thread and reply facts.
  for (const key of ["threadId", "replyTo"] as const) {
    if (args[key] !== undefined) {
      params.actionParams[key] = args[key];
    }
  }
  let committed = false;
  return async () => {
    if (committed || !outboundRoute) {
      return;
    }
    committed = true;
    await ensureOutboundSessionEntry({
      cfg: params.cfg,
      channel: params.channel,
      accountId: params.accountId,
      route: outboundRoute,
      creation: params.creation,
      sourceSessionKey: params.sourceSessionKey,
      assertCommitAllowed: params.assertCommitAllowed,
    });
  };
}
