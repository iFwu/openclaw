import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
/** Resolves model fallback chains for isolated cron runs and preflight. */
import { resolveModelCandidateChain } from "../../agents/model-fallback-candidates.js";
import {
  captureModelFallbackPolicyContext,
  type ModelFallbackPolicyContext,
} from "../../agents/model-fallback-policy.js";
import type { ModelCandidate } from "../../agents/model-fallback.types.js";
import { resolveModelRefFromString } from "../../agents/model-selection-resolve.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { CronJob } from "../types.js";
import {
  resolveModelFallbackAvailability,
  modelFallbackOverrideFromAvailability,
  resolveSubagentModelFallbacksOverride,
} from "./run-execution.runtime.js";
import { logWarn } from "./run.runtime.js";

const cronModelPreflightRuntimeLoader = createLazyImportLoader(
  () => import("./model-preflight.runtime.js"),
);

type CronFallbackPolicyParams = ModelFallbackPolicyContext & {
  cfg: OpenClawConfig;
  job: CronJob;
  agentId: string;
  provider?: string;
  model?: string;
  useSubagentFallbacks?: boolean;
};

/** Resolve one selected-model policy without treating prepared defaults as its source. */
export function resolveCronFallbackPolicy(params: CronFallbackPolicyParams) {
  const payload = params.job.payload.kind === "agentTurn" ? params.job.payload : undefined;
  if (Array.isArray(payload?.fallbacks)) {
    return { fallbacksOverride: payload.fallbacks, fallbackPolicyRoot: undefined };
  }
  const hasPayloadModel = Boolean(payload?.model?.trim());
  if (params.useSubagentFallbacks === true && !hasPayloadModel) {
    const explicit = resolveSubagentModelFallbacksOverride(params.cfg, params.agentId);
    if (explicit !== undefined) {
      return { fallbacksOverride: explicit, fallbackPolicyRoot: undefined };
    }
  }
  const payloadSelection =
    hasPayloadModel && payload?.model
      ? resolveModelRefFromString({
          cfg: params.cfg,
          agentId: params.agentId,
          raw: payload.model,
          defaultProvider: params.provider ?? DEFAULT_PROVIDER,
          allowPluginNormalization: false,
        })?.ref
      : undefined;
  const provider = params.provider ?? payloadSelection?.provider;
  const model = params.model ?? payloadSelection?.model;
  const availability = resolveModelFallbackAvailability({
    cfg: params.cfg,
    agentId: params.agentId,
    provider,
    model,
    hasSessionModelOverride: hasPayloadModel,
    modelOverrideSource: hasPayloadModel ? "auto" : undefined,
    ...captureModelFallbackPolicyContext(params),
  });
  const fallbackPolicyRoot: ModelCandidate | undefined =
    availability.kind !== "disabled_by_model_selection_lock" &&
    availability.source === "per-model" &&
    provider &&
    model
      ? { provider, model }
      : undefined;
  return {
    fallbacksOverride: modelFallbackOverrideFromAvailability(availability),
    fallbackPolicyRoot,
  };
}

/** Explicit payload and subagent lists retain precedence over the selected-model policy. */
export function resolveCronFallbacksOverride(
  params: CronFallbackPolicyParams,
): string[] | undefined {
  return resolveCronFallbackPolicy(params).fallbacksOverride;
}

/** Builds the ordered model candidates used by cron preflight checks. */
export function resolveCronPreflightCandidates(
  params: {
    cfg: OpenClawConfig;
    job: CronJob;
    agentId: string;
    provider: string;
    model: string;
    useSubagentFallbacks?: boolean;
  } & ModelFallbackPolicyContext,
): ModelCandidate[] {
  const fallbacksOverride = resolveCronFallbacksOverride(params);
  return resolveModelCandidateChain({
    cfg: params.cfg,
    agentId: params.agentId,
    provider: params.provider,
    model: params.model,
    requestedRouteResolution: "resolved",
    fallbacksOverride,
    ...captureModelFallbackPolicyContext(params),
  });
}

/** Selects the reachable candidate and retains only its remaining fallback chain. */
export async function resolveCronPreflight(
  params: Parameters<typeof resolveCronPreflightCandidates>[0],
) {
  const modelPreflightRuntime = await cronModelPreflightRuntimeLoader.load();
  const policy = resolveCronFallbackPolicy(params);
  const preflightCandidates = resolveCronPreflightCandidates(params);
  let firstUnavailableReason: string | undefined;
  for (const [index, candidate] of preflightCandidates.entries()) {
    const candidatePreflight = await modelPreflightRuntime.preflightCronModelProvider({
      cfg: params.cfg,
      provider: candidate.provider,
      model: candidate.model,
    });
    if (candidatePreflight.status === "unavailable") {
      firstUnavailableReason ??= candidatePreflight.reason;
      continue;
    }
    const modelFallbacksOverride =
      candidate.provider !== params.provider || candidate.model !== params.model
        ? preflightCandidates
            .slice(index + 1)
            .map((remaining) => `${remaining.provider}/${remaining.model}`)
        : undefined;
    if (modelFallbacksOverride && firstUnavailableReason !== undefined) {
      logWarn(
        `[cron:${params.job.id}] ${firstUnavailableReason}; continuing with fallback ${candidate.provider}/${candidate.model}.`,
      );
    }
    return {
      ok: true as const,
      provider: candidate.provider,
      model: candidate.model,
      modelFallbacksOverride,
      fallbackPolicyRoot: policy.fallbackPolicyRoot,
      runtimePluginCandidates: preflightCandidates.slice(index),
    };
  }
  if (firstUnavailableReason !== undefined) {
    return { ok: false as const, reason: firstUnavailableReason };
  }
  return {
    ok: true as const,
    provider: params.provider,
    model: params.model,
    modelFallbacksOverride: undefined,
    fallbackPolicyRoot: policy.fallbackPolicyRoot,
    runtimePluginCandidates: preflightCandidates,
  };
}
