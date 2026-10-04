import {
  resolveAgentModelFallbackChainsValue,
  resolveAgentModelFallbackValues,
} from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { getPluginRegistryForContext } from "../plugins/runtime/gateway-request-scope.js";
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-state.js";
import { resolveAgentConfig, resolveAgentModelConfigForRuntime } from "./agent-scope-config.js";
import { allowsPluginModelNormalization } from "./configured-provider-model.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import type { ModelRef, ModelManifestNormalizationContext } from "./model-ref-shared.js";
import {
  buildModelAliasIndex,
  resolveModelRefFromString,
  resolveConfiguredModelRef,
} from "./model-selection-shared.js";
import { normalizeProviderModelIdWithRuntime } from "./provider-model-normalization.runtime.js";

/** Pure readers omit the registry; executable callers retain their already-prepared owner. */
export type ModelFallbackPolicyContext = ModelManifestNormalizationContext & {
  policyRegistry?: PluginRegistry | null;
};

/** Capture existing facts only. This never discovers or activates provider plugins. */
export function captureModelFallbackPolicyContext(
  params: ModelFallbackPolicyContext & { cfg?: OpenClawConfig },
): ModelFallbackPolicyContext {
  return {
    manifestPlugins:
      params.manifestPlugins ??
      getCurrentPluginMetadataSnapshot({
        config: params.cfg,
        env: process.env,
        allowWorkspaceScopedSnapshot: true,
        requireDefaultDiscoveryContext: params.cfg === undefined,
      }) ??
      undefined,
    policyRegistry:
      params.policyRegistry === undefined
        ? (getPluginRuntimeGenerationRegistry() ?? getPluginRegistryForContext() ?? null)
        : params.policyRegistry,
  };
}

export function resolveSelectedModelFallbackChain(
  params: {
    cfg: OpenClawConfig;
    agentId?: string;
    provider?: string;
    model?: string;
  } & ModelFallbackPolicyContext,
): string[] {
  const agentModel = params.agentId
    ? resolveAgentModelConfigForRuntime(resolveAgentConfig(params.cfg, params.agentId))
    : undefined;
  const chains =
    resolveAgentModelFallbackChainsValue(agentModel) ??
    resolveAgentModelFallbackChainsValue(params.cfg.agents?.defaults?.model) ??
    {};
  const selected =
    params.provider && params.model
      ? { provider: params.provider, model: params.model }
      : resolveConfiguredModelRef({
          cfg: params.cfg,
          agentId: params.agentId,
          defaultProvider: DEFAULT_PROVIDER,
          defaultModel: DEFAULT_MODEL,
          allowPluginNormalization: false,
          manifestPlugins: params.manifestPlugins,
        });
  const identities = new Map<string, ModelRef>();
  const authoredIdentity = (ref: ModelRef): ModelRef => {
    // Selected executable tuples are not input aliases. Never normalize them again.
    if (
      (ref.provider === selected.provider && ref.model === selected.model) ||
      !params.policyRegistry ||
      params.cfg.plugins?.enabled === false ||
      !allowsPluginModelNormalization({ cfg: params.cfg, ...ref })
    ) {
      return ref;
    }
    const key = `${ref.provider}/${ref.model}`;
    const cached = identities.get(key);
    if (cached) {
      return cached;
    }
    const model = normalizeProviderModelIdWithRuntime({
      provider: ref.provider,
      context: { provider: ref.provider, modelId: ref.model },
      registry: params.policyRegistry,
    });
    const identity = model ? { provider: ref.provider, model } : ref;
    identities.set(key, identity);
    return identity;
  };
  const context = {
    cfg: params.cfg,
    agentId: params.agentId,
    defaultProvider: selected.provider,
    allowPluginNormalization: false,
    manifestPlugins: params.manifestPlugins,
  };
  const key = `${selected.provider}/${selected.model}`;
  const matches = (ref: ModelRef | undefined) =>
    ref?.provider === selected.provider && ref.model === selected.model;
  const findAuthoredChain = (full: boolean) => {
    const aliasIndex = buildModelAliasIndex(context);
    for (const [authoredKey, authoredChain] of Object.entries(chains)) {
      if (authoredKey.includes("/") !== full) {
        continue;
      }
      const parsed = resolveModelRefFromString({ ...context, raw: authoredKey, aliasIndex })?.ref;
      if (parsed && matches(authoredIdentity(parsed))) {
        return authoredChain;
      }
    }
    return undefined;
  };
  const chain = Object.hasOwn(chains, key)
    ? (chains[key] ?? [])
    : (findAuthoredChain(true) ??
      (Object.hasOwn(chains, selected.model) ? chains[selected.model] : undefined) ??
      findAuthoredChain(false) ??
      []);
  const globalPrimary = authoredIdentity(
    resolveConfiguredModelRef({
      cfg: params.cfg,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
      allowPluginNormalization: false,
      manifestPlugins: params.manifestPlugins,
    }),
  );
  // Only the global primary inherits the global tail; fallback attempts never become new roots.
  return selected.provider === globalPrimary.provider && selected.model === globalPrimary.model
    ? [
        ...new Set([
          ...chain,
          ...resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model),
        ]),
      ]
    : chain;
}
