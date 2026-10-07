import { hasOnlyAssistantReasoningContent } from "@openclaw/ai/internal/shared";
import type { AssistantMessage } from "../../../llm/types.js";
import { isRetryableAssistantError } from "../../../llm/utils/retry.js";
import { isFailoverError } from "../../failover-error.js";
import { AgentHarnessPreflightError } from "../../harness/errors.js";
import { selectAgentHarness } from "../../harness/selection.js";
import { isCliProvider } from "../../model-selection-cli.js";
import { hasAttemptTerminalState } from "./attempt-terminal-evidence.js";
import { resolveSettledToolBatchEvidence } from "./incomplete-turn-recovery.js";
import type { RunEmbeddedAgentParamsWithSessionFile } from "./internal-params.js";
import type { prepareEmbeddedRunRuntime } from "./runtime-preparation.js";
import type { createEmbeddedRunSessionPromptState } from "./session-prompt-state.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

export type ModelContinuationState = {
  runId: string;
  /** Recovery crossed unproven effects or failed to checkpoint settled work. */
  crossModelBlocked?: true;
  checkpoint?: {
    sessionId: string;
    sessionFile: string;
    toolCallIds: string[];
    includeToolFailureInstruction: boolean;
  };
  /** Only this exact proven failure may cross prior delivery evidence. */
  fallbackError?: unknown;
};

export function createModelContinuationState(runId: string): ModelContinuationState {
  return { runId };
}

export function createModelContinuationFallbackGuard(
  state: ModelContinuationState,
  canFallback?: () => boolean,
) {
  return ({ error }: { error: unknown }) => {
    // A checkpoint cannot override newer live delivery custody.
    if (canFallback?.() === false || state.crossModelBlocked) {
      return false;
    }
    return (
      !state.checkpoint || (state.fallbackError !== undefined && error === state.fallbackError)
    );
  };
}

export function assertModelContinuationRuntime(input: Parameters<typeof selectAgentHarness>[0]) {
  if (isCliProvider(input.provider, input.config) || selectAgentHarness(input).id !== "openclaw") {
    throw new AgentHarnessPreflightError(
      "The selected runtime cannot continue the settled embedded transcript.",
    );
  }
}

export function prepareModelContinuationParams(
  params: RunEmbeddedAgentParamsWithSessionFile,
  runtime: Pick<
    Awaited<ReturnType<typeof prepareEmbeddedRunRuntime>>,
    "admittedRunContext" | "snapshot"
  >,
) {
  const modelContinuation = params.modelContinuation ?? createModelContinuationState(params.runId);
  if (modelContinuation.runId !== params.runId) {
    throw new Error("Model continuation belongs to a different run");
  }
  const snapshot = runtime.snapshot();
  if (
    modelContinuation.checkpoint &&
    (snapshot.agentHarness.id !== "openclaw" || snapshot.pluginHarnessOwnsTransport)
  ) {
    throw new AgentHarnessPreflightError(
      "The selected runtime cannot continue the settled embedded transcript.",
    );
  }
  return { ...params, admittedRunContext: runtime.admittedRunContext, modelContinuation };
}

export function createModelContinuationCallbacks(input: {
  state: ModelContinuationState;
  sessionPromptState: Awaited<ReturnType<typeof createEmbeddedRunSessionPromptState>>;
  assertActive: () => void;
  throwIfAborted: () => void;
  abortSignal?: AbortSignal;
}) {
  let prepared = false;
  const { state, sessionPromptState, assertActive, throwIfAborted, abortSignal } = input;
  return {
    prepare: async (
      evidence: Pick<
        NonNullable<ModelContinuationState["checkpoint"]>,
        "toolCallIds" | "includeToolFailureInstruction"
      >,
    ) => {
      try {
        assertActive();
        throwIfAborted();
        await sessionPromptState.waitForCurrentUserMessagePersistence();
        assertActive();
        throwIfAborted();
        sessionPromptState.markOwnedTranscriptRetry();
        await sessionPromptState.settleOwnedTranscriptProjection(
          sessionPromptState.sessionTarget,
          abortSignal,
        );
        assertActive();
        throwIfAborted();
        state.checkpoint = {
          sessionId: sessionPromptState.sessionId,
          sessionFile: sessionPromptState.sessionFile,
          ...evidence,
        };
        sessionPromptState.continueFromCurrentTranscript(evidence);
        prepared = true;
      } catch (error) {
        state.crossModelBlocked = true;
        throw error;
      }
    },
    captureFailure: (error: unknown): never => {
      if (prepared && isFailoverError(error)) {
        assertActive();
        throwIfAborted();
        state.fallbackError = error;
      }
      throw error;
    },
  };
}

function findRecordedToolResult(
  snapshot: EmbeddedRunAttemptResult["messagesSnapshot"],
  toolCallId: string,
  toolName: string,
) {
  const assistantIndex = snapshot.findLastIndex(
    (message) =>
      message.role === "assistant" &&
      message.content.some(
        (block) => block.type === "toolCall" && block.id === toolCallId && block.name === toolName,
      ),
  );
  if (assistantIndex < 0) {
    return undefined;
  }
  return snapshot
    .slice(assistantIndex + 1)
    .find(
      (message) =>
        message.role === "toolResult" &&
        message.toolCallId === toolCallId &&
        message.toolName === toolName,
    );
}

export function resolveModelContinuationEvidence(input: {
  attempt: EmbeddedRunAttemptResult;
  currentAttemptAssistant?: AssistantMessage;
  state?: ModelContinuationState;
}) {
  const { attempt, state } = input;
  const assistant = input.currentAttemptAssistant;
  if (
    state?.crossModelBlocked ||
    !assistant ||
    !isRetryableAssistantError(assistant) ||
    attempt.runtimeContinuationStarted ||
    // Native transport recovery owns its own continuation and side-effect evidence.
    assistant.diagnostics?.some((diagnostic) => diagnostic.type === "provider_transport_failure") ||
    (assistant.content.length > 0 && !hasOnlyAssistantReasoningContent(assistant)) ||
    hasAttemptTerminalState({
      ...attempt,
      lastToolError: undefined,
      // Completed message-tool deliveries are settled writes, not pending work.
      didSendViaMessagingTool: false,
      messagingToolSentTexts: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
      didDeliverSourceReplyViaMessageTool: false,
      messagingToolSourceReplyPayloads: [],
    })
  ) {
    return undefined;
  }
  const previous = state?.checkpoint;
  const noNewToolActivity =
    attempt.itemLifecycle.startedCount === 0 &&
    attempt.itemLifecycle.completedCount === 0 &&
    attempt.itemLifecycle.activeCount === 0 &&
    attempt.toolMetas.length === 0;
  const evidence = resolveSettledToolBatchEvidence(
    attempt,
    noNewToolActivity ? previous?.toolCallIds : undefined,
  );
  const toolCallIds =
    evidence.assistant?.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : [])) ??
    [];
  const unchangedSettledBatch = previous && evidence.allToolCallsRecorded && noNewToolActivity;
  const lastToolError = attempt.lastToolError;
  const failedResult = lastToolError?.toolCallId
    ? findRecordedToolResult(
        attempt.messagesSnapshot,
        lastToolError.toolCallId,
        lastToolError.toolName,
      )
    : undefined;
  if (
    (!evidence.allToolsProvenSettled && !unchangedSettledBatch) ||
    toolCallIds.some((id) => !id.trim()) ||
    new Set(toolCallIds).size !== toolCallIds.length ||
    (lastToolError && (failedResult?.role !== "toolResult" || !failedResult.isError)) ||
    evidence.intentionalTermination
  ) {
    return undefined;
  }
  return {
    toolCallIds,
    includeToolFailureInstruction:
      evidence.failedToolNames.size > 0 ||
      Boolean(lastToolError) ||
      Boolean(unchangedSettledBatch && previous?.includeToolFailureInstruction),
  };
}
