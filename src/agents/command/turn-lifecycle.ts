import { resolveCommandRecoveryOptions } from "../agent-command-restart-recovery.js";
import { createCompactionSessionIdReporter } from "./post-run.js";
import type { PreparedAgentCommandExecution } from "./prepare.js";
import type { AgentCommandOpts } from "./types.js";

export function prepareCommandTurnLifecycle(prepared: PreparedAgentCommandExecution) {
  const lifecycleAbortController = new AbortController();
  const preparedOpts = resolveCommandRecoveryOptions(prepared);
  const compactionSessionIdReporter = createCompactionSessionIdReporter(
    prepared.sessionId,
    preparedOpts.onSessionIdChanged,
  );
  const opts: AgentCommandOpts = {
    ...preparedOpts,
    onSessionIdChanged: compactionSessionIdReporter.onSessionIdChanged,
    abortSignal: preparedOpts.abortSignal
      ? AbortSignal.any([preparedOpts.abortSignal, lifecycleAbortController.signal])
      : lifecycleAbortController.signal,
  };
  return { lifecycleAbortController, compactionSessionIdReporter, opts };
}
