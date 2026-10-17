import { resolveAvailableAgentHarnessPolicy } from "../agents/harness/availability.js";
import { resolveSessionRuntimeOverrideForProvider } from "../agents/session-runtime-compat.js";
import type { InternalSessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Model admission uses executable availability, not the thinking projection's implicit choice. */
export function resolveSessionPatchHarnessSelection(input: {
  cfg: OpenClawConfig;
  entry: InternalSessionEntry;
  selection: { provider: string; model: string };
  agentId: string;
  sessionKey: string;
  preparedRuntime?: string;
  fallbackRuntime: (provider: string, model: string) => string;
}) {
  const sessionRuntime = resolveSessionRuntimeOverrideForProvider({
    provider: input.selection.provider,
    entry: input.entry,
    cfg: input.cfg,
  });
  const availableRuntime =
    input.preparedRuntime ??
    resolveAvailableAgentHarnessPolicy({
      config: input.cfg,
      provider: input.selection.provider,
      modelId: input.selection.model,
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      mode: "execution",
      agentHarnessId: input.entry.modelSelectionLocked ? sessionRuntime : undefined,
      agentHarnessRuntimeOverride: sessionRuntime,
    }).runtime;
  return {
    provider: input.selection.provider,
    modelId: input.selection.model,
    runtime:
      availableRuntime === "auto"
        ? input.fallbackRuntime(input.selection.provider, input.selection.model)
        : availableRuntime,
    agentId: input.agentId,
  };
}
