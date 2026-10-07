import type { AssistantErrorTranscript } from "../assistant-error-transcript.js";
import type { ContextEngineLogicalTurnLease } from "../harness/context-engine-logical-turn.js";
import type { ContextEngineTurnAttemptFacts } from "../harness/context-engine-turn-attempt.js";
import type { ModelFallbackResultClassification } from "../model-fallback-attempt.js";
import type { ModelFallbackAttemptProvenance } from "../model-fallback.types.js";
import type { AuthProfileFailurePolicy } from "./run/auth-profile-failure-policy.types.js";
import type { ModelContinuationState } from "./run/model-continuation.js";
import type { EmbeddedAgentRunResult } from "./types.js";

export type RunEntryCandidateOptions = {
  agentHarnessRuntimeOverride: string | undefined;
  assistantErrorTranscript: AssistantErrorTranscript;
  authProfileFailurePolicy?: AuthProfileFailurePolicy;
  classifyResult: (result: EmbeddedAgentRunResult) => ModelFallbackResultClassification;
  allowTransientCooldownProbe?: boolean;
  isFinalFallbackAttempt?: boolean;
  isFallbackRetry: boolean;
  modelContinuation?: ModelContinuationState;
  modelRoutingProvenance: ModelFallbackAttemptProvenance;
  contextEngineLogicalTurnLease: ContextEngineLogicalTurnLease;
  onContextEngineTurnCandidate: (facts: ContextEngineTurnAttemptFacts) => void;
};

export type RunEntryHarnessPreparation =
  | { kind: "direct" }
  | {
      kind: "measured";
      run: (prepare: () => Promise<void>) => Promise<void>;
    };

export type RunEntrySessionOverride =
  | { kind: "preserve" }
  | {
      kind: "reconcile-completed";
      reconcile: (candidate: { provider: string; model: string }) => Promise<void>;
    };
