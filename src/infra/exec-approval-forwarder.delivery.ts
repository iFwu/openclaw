import type { ReplyPayload } from "../auto-reply/types.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import {
  getLoadedChannelPlugin,
  resolveChannelApprovalAdapter,
} from "../channels/plugins/index.js";
import type { ExecApprovalForwardTarget } from "../config/types.approvals.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { channelRouteDedupeKey } from "../plugin-sdk/channel-route.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { isDeliverableMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";
const log = createSubsystemLogger("gateway/exec-approvals");

export type DeliverApprovalPayloads =
  typeof import("../channels/message/runtime.js").sendDurableMessageBatchCore;
export type ForwardTarget = ExecApprovalForwardTarget & {
  source: "session" | "target" | "fallback";
  fallback?: boolean;
};

export function buildTargetKey(cfg: OpenClawConfig, target: ExecApprovalForwardTarget): string {
  const channel = normalizeMessageChannel(target.channel) ?? target.channel;
  const plugin = getLoadedChannelPlugin(channel);
  const accountId = normalizeAccountId(
    target.accountId ?? (plugin ? resolveChannelDefaultAccountId({ plugin, cfg }) : undefined),
  );
  const canonical = resolveChannelApprovalAdapter(plugin)?.native?.normalizeTarget?.({
    cfg,
    accountId,
    target,
  }) ?? {
    to: plugin?.messaging?.normalizeTarget?.(target.to) ?? target.to,
    threadId: target.threadId,
  };
  return channelRouteDedupeKey({
    channel,
    to: canonical.to,
    accountId,
    threadId: canonical.threadId,
  });
}

export async function deliverToTargets(params: {
  cfg: OpenClawConfig;
  targets: ForwardTarget[];
  buildPayload: (target: ForwardTarget) => ReplyPayload;
  deliver: DeliverApprovalPayloads;
  beforeDeliver?: (target: ForwardTarget, payload: ReplyPayload) => Promise<void> | void;
  shouldSend?: () => boolean;
}) {
  const confirmed: ForwardTarget[] = [];
  const attempted: ForwardTarget[] = [];
  const deliveries = params.targets.map(async (target) => {
    if (params.shouldSend && !params.shouldSend()) {
      return;
    }
    const channel = normalizeMessageChannel(target.channel) ?? target.channel;
    if (!isDeliverableMessageChannel(channel)) {
      return;
    }
    try {
      const payload = params.buildPayload(target);
      await params.beforeDeliver?.(target, payload);
      if (params.shouldSend && !params.shouldSend()) {
        return;
      }
      const assertCurrent = () => {
        if (params.shouldSend && !params.shouldSend()) {
          const error = new Error("Approval pending delivery is no longer current");
          error.name = "AbortError";
          throw error;
        }
      };
      attempted.push(target);
      const send = await params.deliver({
        cfg: params.cfg,
        channel,
        to: target.to,
        accountId: target.accountId,
        threadId: target.threadId,
        payloads: [payload],
        ...(params.shouldSend
          ? {
              onPlatformSendDispatch: async () => assertCurrent(),
              assertDirectAdapterHandoff: assertCurrent,
            }
          : {}),
      });
      if (send.status === "sent" && send.results.length > 0) {
        confirmed.push(target);
      }
      if (send.status === "failed" || send.status === "partial_failed") {
        throw send.error;
      }
    } catch (err) {
      log.error(`exec approvals: failed to deliver to ${channel}:${target.to}: ${String(err)}`);
    }
  });
  await Promise.allSettled(deliveries);
  return { confirmed, attempted };
}
