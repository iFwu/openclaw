import crypto from "node:crypto";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import {
  captureAgentRunLifecycleGeneration,
  assertAgentRunLifecycleGenerationCurrent,
} from "../../infra/agent-events.js";
import { clearContinuationModelSelection } from "../../sessions/continuation-model-selection.js";
import { recordAgentTurnExecutionOutcome } from "./agent-runner-execution-outcome.js";
import type { AgentTurnParams, AgentTurnExecutionResult } from "./agent-runner-execution.types.js";
import { resolveReplyOperationAbortReason } from "./reply-operation-abort.js";
import { retainReplyOperationUntilComplete } from "./reply-run-registry.js";

export async function refreshReplyLiveModelSelection(
  params: AgentTurnParams,
  assertCurrent: () => void,
) {
  if (params.sessionKey && params.storePath) {
    const fresh = await withSessionEntryReadOnlyInWorker(
      {
        agentId: params.followupRun.run.agentId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      },
      assertCurrent,
      async (read) => {
        if (!read.ok) {
          throw read.error;
        }
        return read.value;
      },
    );
    if (fresh) {
      if (fresh.sessionId !== params.followupRun.run.sessionId) {
        throw new Error("Live model switch session changed");
      }
      params.activeSessionStore ??= {};
      params.activeSessionStore[params.sessionKey] = fresh;
      params.followupRun.run.fastMode = fresh.fastMode ?? params.followupRun.run.fastMode;
      params.followupRun.run.hasSessionModelOverride = Boolean(
        fresh.providerOverride || fresh.modelOverride,
      );
      params.followupRun.run.modelOverrideSource =
        fresh.modelOverrideSource === "default" ? undefined : fresh.modelOverrideSource;
      params.followupRun.run.hasAutoFallbackProvenance = false;
    }
  }
}

/** Runs the agent turn and records its execution and message-tool delivery outcomes. */
export async function executeAgentTurnWithCleanup(
  params: AgentTurnParams,
  executeAgentTurnOutcome: (params: AgentTurnParams) => Promise<AgentTurnExecutionResult>,
): Promise<AgentTurnExecutionResult> {
  params.opts?.onRunVerbosityResolved?.({
    verboseLevelOverride: params.followupRun.run.verboseLevelOverride,
    resolvedVerboseLevel: params.resolvedVerboseLevel,
  });
  if (params.replyOperation) {
    // Cancellation stops execution, but the exact owner must finish committed accounting first.
    retainReplyOperationUntilComplete(params.replyOperation);
  }
  const runId = params.opts?.runId ?? crypto.randomUUID();
  const executionParams =
    params.opts?.runId === runId ? params : { ...params, opts: { ...params.opts, runId } };
  let preserveContinuationSelection = false;
  const lifecycleGeneration = captureAgentRunLifecycleGeneration(runId);
  try {
    const result = await executeAgentTurnOutcome(executionParams);
    preserveContinuationSelection =
      result.outcome.kind === "aborted" && result.outcome.reason === "restart";
    recordAgentTurnExecutionOutcome(executionParams, result);
    return result;
  } catch (error) {
    preserveContinuationSelection =
      resolveReplyOperationAbortReason(
        executionParams.replyOperation,
        error,
        executionParams.opts?.abortSignal,
      ) === "restart";
    recordAgentTurnExecutionOutcome(executionParams, undefined);
    throw error;
  } finally {
    if (
      !preserveContinuationSelection &&
      !params.isHeartbeat &&
      params.sessionKey &&
      params.storePath
    ) {
      const entry =
        params.activeSessionStore?.[params.sessionKey] ?? params.getActiveSessionEntry();
      if (entry) {
        await clearContinuationModelSelection({
          agentId: params.followupRun.run.agentId,
          sessionKey: params.sessionKey,
          storePath: params.storePath,
          sessionId: entry.sessionId,
          runId,
          assertCurrent: () => assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration),
        });
      }
    }
  }
}
