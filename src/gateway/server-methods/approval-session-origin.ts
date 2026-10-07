import { deliveryContextFromConversation } from "../../channels/route-projection.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";

type ApprovalTurnSource = Pick<
  AgentRuntimeIdentity,
  "turnSourceChannel" | "turnSourceTo" | "turnSourceAccountId" | "turnSourceThreadId"
>;

/** Called only after validating the host-owned runtime's live approval authority. */
export function resolveAgentRuntimeApprovalOrigin(
  runtime: AgentRuntimeIdentity,
): ApprovalTurnSource {
  const sessionKey = runtime.sessionKey.trim();
  if (!/^agent:[^:]+:subagent:workboard-[^:]+$/.test(sessionKey)) {
    return runtime;
  }
  // Binding may happen after admission. Read its owner at request creation, not
  // delivery.origin or plugin arguments, and freeze the result on this approval.
  const now = Date.now();
  const bindings = getSessionBindingService()
    .listBySession(sessionKey)
    .filter(
      (binding) =>
        binding.targetSessionKey === sessionKey &&
        binding.status === "active" &&
        (binding.expiresAt === undefined || binding.expiresAt > now) &&
        binding.conversation.channel === "telegram" &&
        Boolean(binding.conversation.conversationId.trim()),
    );
  // Multiple task rooms are ambiguous; never pick an unrelated room by recency.
  if (bindings.length !== 1) {
    return runtime;
  }
  const conversation = bindings[0]!.conversation;
  // The channel owns topic parsing; conversation-scoped lookups compare the thread field.
  const threadId = deliveryContextFromConversation(conversation)?.threadId;
  return {
    turnSourceChannel: conversation.channel,
    turnSourceTo: conversation.conversationId,
    turnSourceAccountId: conversation.accountId,
    turnSourceThreadId: threadId == null ? undefined : String(threadId),
  };
}
