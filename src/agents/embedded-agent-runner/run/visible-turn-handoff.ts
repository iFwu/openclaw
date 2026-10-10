import { getAgentRunContext } from "../../../infra/agent-run-registry.js";
import { isSubagentSessionKey } from "../../../routing/session-key.js";
import { isSubagentCoordinationInputProvenance } from "../../../sessions/input-provenance.js";
import type { OperationalRunInstanceRef } from "../../admitted-run-context.js";
import type { AgentSession } from "../../sessions/agent-session.js";
import type { EmbeddedAgentQueueMessageOptions } from "../run-state.js";
import type { EmbeddedRunAttemptInternalParams } from "./internal-params.js";

// Retries share this exact logical owner; accepting input cannot reopen peer-only preemption.
const humanAnswerOwners = new WeakSet<OperationalRunInstanceRef>();

/** A peer wake owns no human answer or reply-operation slot to transfer. */
export function isPeerSessionContinuation(
  attempt: Pick<
    EmbeddedRunAttemptInternalParams,
    "runId" | "sessionKey" | "inputProvenance" | "replyOperation"
  >,
): boolean {
  const context = getAgentRunContext(attempt.runId);
  return (
    attempt.replyOperation === undefined &&
    Boolean(attempt.sessionKey) &&
    !isSubagentSessionKey(attempt.sessionKey) &&
    context?.isControlUiVisible !== false &&
    context?.projectSessionMessages !== false &&
    attempt.inputProvenance?.kind === "inter_session" &&
    attempt.inputProvenance.sourceTool === "sessions_send" &&
    !isSubagentCoordinationInputProvenance(attempt.inputProvenance)
  );
}

/** Own one attempt's cooperative handoff and restore only its exact checkpoint hook. */
export function preparePeerSessionVisibleTurnHandoff(params: {
  attempt: Pick<
    EmbeddedRunAttemptInternalParams,
    | "runId"
    | "sessionKey"
    | "inputProvenance"
    | "replyOperation"
    | "waitForOwnerCleanup"
    | "admittedRunContext"
  >;
  agent: AgentSession["agent"];
  isCurrent: () => boolean;
  canRelinquish: () => boolean;
  handoff: () => void;
}) {
  if (
    params.attempt.waitForOwnerCleanup === undefined ||
    !isPeerSessionContinuation(params.attempt)
  ) {
    return undefined;
  }
  const instance = params.attempt.admittedRunContext?.operationalRunInstance;
  if (!instance) {
    return undefined;
  }
  const { agent } = params;
  const previous = agent.prepareNextTurnWithContext;
  const requests = new Set<() => boolean>();
  const pruneRequests = () => {
    for (const request of requests) {
      try {
        if (request()) {
          continue;
        }
      } catch {
        // A revoked requesting source cannot authorize a later handoff.
      }
      requests.delete(request);
    }
  };
  const checkpoint: NonNullable<typeof previous> = async (context, signal) => {
    const snapshot = previous
      ? await previous.call(agent, context, signal)
      : await agent.prepareNextTurn?.(signal);
    pruneRequests();
    if (
      requests.size > 0 &&
      !humanAnswerOwners.has(instance) &&
      params.isCurrent() &&
      params.canRelinquish()
    ) {
      // This checkpoint runs after tool-result persistence, not during tool execution.
      params.handoff();
      return { ...snapshot, stop: true };
    }
    return snapshot;
  };
  agent.prepareNextTurnWithContext = checkpoint;
  return {
    get requested() {
      return requests.size > 0;
    },
    request: (isSourceCurrent: () => boolean) => {
      if (humanAnswerOwners.has(instance) || !params.isCurrent() || !isSourceCurrent()) {
        return false;
      }
      pruneRequests();
      requests.add(isSourceCurrent);
      return true;
    },
    observeQueueOptions: (options: EmbeddedAgentQueueMessageOptions | undefined) =>
      options?.isInboundUserMessage
        ? {
            ...options,
            onQueueAccepted: (accepted: boolean) => {
              if (accepted) {
                humanAnswerOwners.add(instance);
                requests.clear();
              }
              options.onQueueAccepted?.(accepted);
            },
          }
        : options,
    restore: () => {
      requests.clear();
      if (agent.prepareNextTurnWithContext === checkpoint) {
        agent.prepareNextTurnWithContext = previous;
      }
    },
  };
}
