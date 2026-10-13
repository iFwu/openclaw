import { assertAgentRunLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { clearContinuationModelSelection } from "../../sessions/continuation-model-selection.js";
import type { SessionWorkAdmissionLease } from "../../sessions/session-lifecycle-admission.js";
import type { prepareAgentCommandExecutionIdentity } from "../agent-command-execution-identity.js";
import { createInternalSessionEffectsCleanup } from "../internal-session-effects.js";
import { clearCommandRecoveryClaim } from "./post-run.js";
import type { PreparedAgentCommandExecution } from "./prepare.js";
import type { AgentCommandOpts } from "./types.js";

/** Finishes durable cleanup before releasing the command's transient run owners. */
export async function finishAgentCommandCleanup(
  params: Parameters<typeof clearCommandRecoveryClaim>[0] & {
    lifecycleGeneration: string;
    preserveContinuationSelection: boolean;
    beforeTerminalDelivery: AgentCommandOpts["beforeTerminalDelivery"];
    reportCommitted: () => void;
    preparedRunAdmission: ReturnType<typeof prepareAgentCommandExecutionIdentity> | undefined;
    sessionWorkAdmission: SessionWorkAdmissionLease | undefined;
    cleanupInternalModelRunTargets: () => Promise<void>;
    releaseForeground: (() => void) | undefined;
  },
): Promise<void> {
  try {
    params.reportCommitted();
    await params.preparedRunAdmission?.finish();
    params.sessionWorkAdmission?.release();
    await params.cleanupInternalModelRunTargets();
    await clearCommandRecoveryClaim(params);
    const { sessionKey, storePath, runId, sessionAgentId } = params.prepared;
    if (sessionKey && !params.sessionReboundDuringRun && !params.preserveContinuationSelection) {
      await clearContinuationModelSelection({
        agentId: sessionAgentId,
        sessionKey,
        storePath,
        runId,
        sessionId: params.runOwnedSessionId,
        assertCurrent: () => assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration),
      });
    }
  } finally {
    try {
      await params.beforeTerminalDelivery?.();
    } finally {
      clearAgentRunContext(params.prepared.runId, params.lifecycleGeneration);
      params.sessionWorkAdmission?.release();
      params.releaseForeground?.();
    }
  }
}

export function prepareCommandInternalEffectsCleanup(
  prepared: PreparedAgentCommandExecution,
  opts: AgentCommandOpts,
  onError: (error: unknown) => void,
) {
  return createInternalSessionEffectsCleanup({
    enabled: opts.modelRun === true && opts.sessionEffects === "internal",
    agentId: prepared.sessionAgentId,
    runId: prepared.runId,
    storePath: prepared.storePath,
    onError,
  });
}
