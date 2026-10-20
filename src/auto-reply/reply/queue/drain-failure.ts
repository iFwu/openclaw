import { SessionPendingInputCollectionError } from "../../../config/sessions/session-pending-input-custody-error.js";
import { defaultRuntime } from "../../../runtime.js";
import { retainCancelledUserTurnInput } from "../../../sessions/user-turn-transcript-admission.js";
import { resolveGlobalMap } from "../../../shared/global-singleton.js";
import { removeQueuedItemsByRef } from "../../../utils/queue-helpers.js";
import { resolveFollowupRetrySource } from "./delivery-context.js";
import { completeFollowupRunLifecycle } from "./lifecycle.js";
import { followupQueueSources, type FOLLOWUP_QUEUES } from "./state.js";
import { consumeQueueSummaryDelivery } from "./summary-consumption.js";
import type { FollowupRun } from "./types.js";

type Queue = NonNullable<ReturnType<typeof FOLLOWUP_QUEUES.get>>;
const failedQueues = resolveGlobalMap<string, true>(Symbol.for("openclaw.failedFollowupQueues"));
const MAX_DRAIN_ATTEMPTS = 3;

export function recordFollowupDrainSuccess(key: string, queue: Queue): void {
  queue.drainFailureCount = 0;
  if (failedQueues.delete(key)) {
    defaultRuntime.log?.(`followup queue drain recovered for ${key}`);
  }
}

/** Retire only the failed batch; source owners retain durable cancellation and settlement. */
export function recordFollowupDrainFailure(params: {
  key: string;
  queue: Queue;
  error: unknown;
  attemptedSources: readonly FollowupRun[];
}): number | undefined {
  const { key, queue, error, attemptedSources } = params;
  const attempts = (queue.drainFailureCount ?? 0) + 1;
  queue.drainFailureCount = attempts;
  failedQueues.set(key, true);
  if (failedQueues.size > 1000) {
    const oldest = failedQueues.keys().next().value;
    if (oldest !== undefined) {
      failedQueues.delete(oldest);
    }
  }
  const permanent = error instanceof SessionPendingInputCollectionError;
  if (!permanent && attempts < MAX_DRAIN_ATTEMPTS) {
    return 1000 * 2 ** (attempts - 1);
  }
  // Overflow retries replace display carriers but keep the original recorder/run identity.
  const attemptedOwners = new Set(attemptedSources.map(resolveFollowupRetrySource));
  const sources = [...new Set(followupQueueSources(queue))].filter((source) =>
    attemptedOwners.has(resolveFollowupRetrySource(source)),
  );
  for (const attempted of attemptedSources) {
    queue.inFlight.delete(attempted);
    queue.activeSummarySources.delete(attempted);
  }
  removeQueuedItemsByRef(queue.items, sources);
  consumeQueueSummaryDelivery(queue, { sources, droppedCount: sources.length }, false);
  for (const source of sources) {
    let retained = false;
    try {
      retained = retainCancelledUserTurnInput(source.userTurnTranscriptRecorder);
    } catch {
      defaultRuntime.error?.(`followup queue input retention failed for ${key}`);
    }
    try {
      source.userTurnTranscriptRecorder?.finishPendingInput?.("interrupted");
    } catch {
      defaultRuntime.error?.(`followup queue input interruption failed for ${key}`);
    }
    try {
      completeFollowupRunLifecycle(source, retained ? "retained" : undefined);
    } catch {
      defaultRuntime.error?.(`followup queue failure settlement failed for ${key}`);
    }
  }
  queue.drainFailureCount = 0;
  defaultRuntime.error?.(
    `followup queue drain stopped for ${key}: reason=${permanent ? "collected-input-identity" : "retry-exhausted"} attempts=${attempts}`,
  );
  // An unowned preparation failure parks automatic drain rather than guessing a victim.
  return attemptedSources.length === 0 ? undefined : 0;
}
