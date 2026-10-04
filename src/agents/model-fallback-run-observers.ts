import { emitFailoverEvent } from "../infra/diagnostic-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { describeFailoverError } from "./failover-error.js";
import {
  appendFailedCandidateAttempt,
  recordFailedCandidateAttempt,
  type ModelFallbackStepHandler,
} from "./model-fallback-attempt.js";
import {
  isModelFallbackDecisionLogEnabled,
  logModelFallbackDecision,
  type ModelFallbackDecisionParams,
} from "./model-fallback-observation.js";

const log = createSubsystemLogger("model-fallback");

/** Observe a run without acquiring routing, retry, or authority ownership. */
export function createModelFallbackRunObservers(params: {
  sessionId?: string;
  sessionKey?: string;
  lane?: string;
  onFallbackStep?: ModelFallbackStepHandler;
}) {
  const notifyFallbackStep: ModelFallbackStepHandler = async (step) => {
    // Observations cannot replace candidate outcomes or stop a usable fallback.
    // Policy-bearing callbacks such as onError retain their own failure semantics.
    try {
      await params.onFallbackStep?.(step);
    } catch {
      log.warn("Model fallback observer failed; preserving execution outcome.");
    }
  };
  const observeDecision = async (decision: ModelFallbackDecisionParams) => {
    if (!params.onFallbackStep && !isModelFallbackDecisionLogEnabled()) {
      return;
    }
    const fallbackStep = logModelFallbackDecision(decision);
    if (fallbackStep) {
      await notifyFallbackStep(fallbackStep);
    }
  };
  const observeFailedCandidate = async (
    failedAttempt: Parameters<typeof recordFailedCandidateAttempt>[0],
  ) => {
    if (!params.onFallbackStep && !isModelFallbackDecisionLogEnabled()) {
      appendFailedCandidateAttempt(failedAttempt);
    } else {
      const fallbackStep = recordFailedCandidateAttempt(failedAttempt);
      if (fallbackStep) {
        await notifyFallbackStep(fallbackStep);
      }
    }
    // Emit only real candidate-to-candidate transitions. Terminal candidates
    // have no destination; cooldown suspension has its own diagnostic path.
    if (params.sessionId && failedAttempt.nextCandidate) {
      const described = describeFailoverError(failedAttempt.error);
      emitFailoverEvent({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        lane: params.lane,
        fromProvider: failedAttempt.candidate.provider,
        fromModel: failedAttempt.candidate.model,
        toProvider: failedAttempt.nextCandidate.provider,
        toModel: failedAttempt.nextCandidate.model,
        reason: described.reason ?? "unknown",
        cascadeDepth: failedAttempt.attempt - 1,
        suspended: false,
      });
    }
  };

  return { observeDecision, observeFailedCandidate };
}
