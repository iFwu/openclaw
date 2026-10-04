import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentModelConfig } from "../../../config/types.agents-shared.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { listMutableCodexRouteAgentEntries } from "./codex-route-agent-entries.js";
import { modelRefIdentityForRepair } from "./retired-model-ref-repair.js";

export function filterFallbacks(params: {
  model: Exclude<AgentModelConfig, string>;
  path: string;
  isStale: (ref: string) => string | undefined;
  changes: string[];
}): void {
  if (!Array.isArray(params.model.fallbacks)) {
    return;
  }
  // An empty array disables inherited fallbacks, including after stale refs are removed.
  params.model.fallbacks = params.model.fallbacks.filter((ref) => {
    if (typeof ref !== "string") {
      return true;
    }
    const provider = params.isStale(ref);
    if (!provider) {
      return true;
    }
    params.changes.push(
      `Removed stale ${params.path} fallback "${ref}" (provider "${provider}" is unavailable).`,
    );
    return false;
  });
}

export function filterFallbackChains(params: {
  model: Exclude<AgentModelConfig, string>;
  path: string;
  isStale: (ref: string) => string | undefined;
  changes: string[];
}): void {
  const chains = params.model.fallbackChains;
  if (!isRecord(chains)) {
    return;
  }
  for (const [key, chain] of Object.entries(chains)) {
    const chainPath = `${params.path}.fallbackChains.${key}`;
    const provider = params.isStale(key);
    if (provider) {
      delete chains[key];
      params.changes.push(
        `Removed stale ${chainPath} chain (provider "${provider}" is unavailable).`,
      );
      continue;
    }
    if (!Array.isArray(chain)) {
      continue;
    }
    chains[key] = chain.filter((ref) => {
      if (typeof ref !== "string") {
        return true;
      }
      const fallbackProvider = params.isStale(ref);
      if (!fallbackProvider) {
        return true;
      }
      params.changes.push(
        `Removed stale ${chainPath} fallback "${ref}" (provider "${fallbackProvider}" is unavailable).`,
      );
      return false;
    });
  }
}

/** Compare a planned replacement without mutating the config or assigning a new policy owner. */
export function findChangedGlobalFallbackTailOwners(params: {
  config: OpenClawConfig;
  replacement?: string;
  availabilityForAgent: (agentId: string) => ReadonlySet<string> | undefined;
  makeStaleChecker: (available: ReadonlySet<string>) => (ref: string) => string | undefined;
  modelPrimaryRef: (model: unknown) => string | undefined;
}): string[] {
  const { config, replacement, availabilityForAgent, makeStaleChecker, modelPrimaryRef } = params;
  const defaults = config.agents?.defaults;
  if (
    !isRecord(defaults?.model) ||
    !Array.isArray(defaults.model.fallbacks) ||
    defaults.model.fallbacks.length === 0
  ) {
    return [];
  }
  const plannedConfig = structuredClone(config);
  const plannedModel = plannedConfig.agents?.defaults?.model;
  if (!isRecord(plannedModel)) {
    return [];
  }
  if (replacement) {
    plannedModel.primary = replacement;
    plannedModel.fallbacks = plannedModel.fallbacks?.filter((ref) => ref !== replacement);
  } else {
    delete plannedModel.primary;
  }
  const beforeGlobal = modelRefIdentityForRepair(config, modelPrimaryRef(defaults.model));
  const afterGlobal = modelRefIdentityForRepair(plannedConfig, replacement);
  const hasRemainingTail =
    Array.isArray(plannedModel.fallbacks) && plannedModel.fallbacks.length > 0;
  const affectedOwners: string[] = [];
  for (const { agent, agentId, path: ownerPath } of listMutableCodexRouteAgentEntries(config)) {
    const ownModel = isRecord(agent.model) ? agent.model : undefined;
    // Global-tail ownership applies even when no per-model map was authored.
    if (Array.isArray(ownModel?.fallbacks)) {
      continue;
    }
    const ownPrimary = modelPrimaryRef(agent.model);
    const available = availabilityForAgent(agentId);
    const staleOwnPrimary = ownPrimary && available && makeStaleChecker(available)(ownPrimary);
    const nextPrimary = !ownPrimary || staleOwnPrimary ? replacement : ownPrimary;
    const before = modelRefIdentityForRepair(
      config,
      ownPrimary ?? modelPrimaryRef(defaults.model),
      agentId,
    );
    const after = modelRefIdentityForRepair(plannedConfig, nextPrimary, agentId);
    if (
      !before ||
      !beforeGlobal ||
      !after ||
      !afterGlobal ||
      ((before === beforeGlobal) !== (after === afterGlobal) &&
        (before === beforeGlobal || hasRemainingTail))
    ) {
      affectedOwners.push(`${ownerPath}.model`);
    }
  }
  return affectedOwners;
}
