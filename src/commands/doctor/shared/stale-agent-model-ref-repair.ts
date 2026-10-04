import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  listAgentEntries,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  tryResolveDefaultAgentId,
} from "../../../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../../agents/defaults.js";
import { normalizeProviderId } from "../../../agents/model-selection.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { hasIncompletePluginDiscovery } from "../../../plugins/discovery-availability.js";
import { resolvePluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.types.js";
import { resolveProviderInstallCatalogEntries } from "../../../plugins/provider-install-catalog.js";
import { listMutableCodexRouteAgentEntries } from "./codex-route-agent-entries.js";
import { collectConfiguredProviderSelectionIds } from "./configured-provider-selection-ids.js";
import {
  createRetiredModelRefRepairResolver,
  modelRefIdentityForRepair,
  repairRetiredConfigModelRefs,
} from "./retired-model-ref-repair.js";
import {
  filterFallbacks,
  filterFallbackChains,
  findChangedGlobalFallbackTailOwners,
} from "./stale-model-fallback-policy.js";

type StaleAgentModelRefRepair = {
  config: OpenClawConfig;
  changes: string[];
  warnings: string[];
  retiredModelRefConfig?: Pick<OpenClawConfig, "agents" | "models">;
};

type RepairOptions = {
  env?: NodeJS.ProcessEnv;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  /** Test seam for the provider ids supplied by bundled or installed plugins. */
  pluginProviderIds?: ReadonlySet<string>;
  /** Test seam for provider ids already present in each agent's models.json. */
  persistedProviderIdsByAgentId?: ReadonlyMap<string, ReadonlySet<string>>;
};

const DEFAULT_MODEL_REF = `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`;

function providerFromModelRef(ref: string): string | undefined {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return undefined;
  }
  const provider = normalizeProviderId(trimmed.slice(0, slash));
  return provider || undefined;
}

function collectPluginProviderIds(
  cfg: OpenClawConfig,
  options: RepairOptions,
): { providerIds?: Set<string>; warnings: string[] } {
  let providerIds: Set<string>;
  if (options.pluginProviderIds) {
    providerIds = new Set([...options.pluginProviderIds].map(normalizeProviderId).filter(Boolean));
  } else {
    const defaultAgentId = tryResolveDefaultAgentId(cfg);
    const workspaceDir = defaultAgentId ? resolveAgentWorkspaceDir(cfg, defaultAgentId) : undefined;
    const snapshot =
      options.pluginMetadataSnapshot ??
      resolvePluginMetadataSnapshot({
        config: cfg,
        workspaceDir: workspaceDir ?? undefined,
        env: options.env ?? process.env,
        allowWorkspaceScopedCurrent: true,
      });
    if (hasIncompletePluginDiscovery(snapshot.diagnostics)) {
      return {
        warnings: [
          "Skipped stale agent model reference repair because plugin discovery is incomplete; uninspected configuration is preserved.",
        ],
      };
    }

    providerIds = new Set<string>();
    for (const owners of [
      snapshot.owners.providers,
      snapshot.owners.modelCatalogProviders,
      snapshot.owners.setupProviders,
      snapshot.owners.cliBackends,
    ]) {
      for (const providerId of owners.keys()) {
        const normalized = normalizeProviderId(providerId);
        if (normalized) {
          providerIds.add(normalized);
        }
      }
    }
  }
  const selectedProviderIds = collectConfiguredProviderSelectionIds(cfg);
  for (const entry of resolveProviderInstallCatalogEntries({
    config: cfg,
    env: options.env ?? process.env,
    includeUntrustedWorkspacePlugins: false,
  })) {
    const entryProviderIds = [entry.providerId, ...(entry.providerAliases ?? [])];
    if (!entryProviderIds.some((providerId) => selectedProviderIds.has(providerId.toLowerCase()))) {
      continue;
    }
    for (const providerId of entryProviderIds) {
      const normalized = normalizeProviderId(providerId);
      if (normalized) {
        providerIds.add(normalized);
      }
    }
  }
  return { providerIds, warnings: [] };
}

function collectPersistedProviderIds(params: {
  cfg: OpenClawConfig;
  agentId: string;
  env: NodeJS.ProcessEnv;
  injected?: ReadonlyMap<string, ReadonlySet<string>>;
}): { providerIds?: Set<string>; warning?: string } {
  const injected = params.injected?.get(params.agentId);
  if (injected) {
    return {
      providerIds: new Set([...injected].map(normalizeProviderId).filter(Boolean)),
    };
  }
  if (params.injected) {
    return { providerIds: new Set() };
  }

  const modelsPath = path.join(
    resolveAgentDir(params.cfg, params.agentId, params.env),
    "models.json",
  );
  let raw: string;
  try {
    raw = fs.readFileSync(modelsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { providerIds: new Set() };
    }
    return {
      warning: `Skipped stale model reference repair for agent "${params.agentId}" because ${modelsPath} could not be read.`,
    };
  }
  try {
    const parsed = JSON.parse(raw) as { providers?: unknown };
    if (
      !parsed.providers ||
      typeof parsed.providers !== "object" ||
      Array.isArray(parsed.providers)
    ) {
      return { providerIds: new Set() };
    }
    return {
      providerIds: new Set(Object.keys(parsed.providers).map(normalizeProviderId).filter(Boolean)),
    };
  } catch {
    return {
      warning: `Skipped stale model reference repair for agent "${params.agentId}" because ${modelsPath} is invalid JSON.`,
    };
  }
}

function repairModelMap(params: {
  models: Record<string, unknown> | undefined;
  path: string;
  isStale: (ref: string) => string | undefined;
  replacementRef?: string;
  ensureReplacement?: boolean;
  changes: string[];
  warnings: string[];
}): void {
  if (!isRecord(params.models)) {
    return;
  }
  const refs = Object.keys(params.models);
  const staleRefs = refs.filter((ref) => params.isStale(ref));
  if (staleRefs.length === refs.length && staleRefs.length > 0 && !params.replacementRef) {
    params.warnings.push(
      `Skipped clearing ${params.path} because no available replacement model could keep the allowlist restrictive.`,
    );
    return;
  }
  for (const ref of staleRefs) {
    const provider = params.isStale(ref);
    delete params.models[ref];
    params.changes.push(
      `Removed stale ${params.path} entry "${ref}" (provider "${provider}" is unavailable).`,
    );
  }
  if (
    refs.length > 0 &&
    (staleRefs.length > 0 || params.ensureReplacement === true) &&
    params.replacementRef &&
    !Object.hasOwn(params.models, params.replacementRef)
  ) {
    params.models[params.replacementRef] = {};
    params.changes.push(
      `Added ${params.path} entry "${params.replacementRef}" to keep the repaired allowlist restrictive.`,
    );
  }
}

function firstExplicitModelRef(cfg: OpenClawConfig): string | undefined {
  if (!isRecord(cfg.models?.providers)) {
    return undefined;
  }
  for (const [providerId, provider] of Object.entries(cfg.models.providers)) {
    if (!isRecord(provider) || !Array.isArray(provider.models)) {
      continue;
    }
    const normalizedProvider = normalizeProviderId(providerId);
    const modelId = provider.models
      .map((model) => (isRecord(model) && typeof model.id === "string" ? model.id.trim() : ""))
      .find(Boolean);
    if (normalizedProvider && modelId) {
      return `${normalizedProvider}/${modelId}`;
    }
  }
  return undefined;
}

function modelPrimaryRef(model: unknown): string | undefined {
  if (typeof model === "string") {
    return model;
  }
  return isRecord(model) && typeof model.primary === "string" ? model.primary : undefined;
}

export function repairStaleAgentModelRefs(
  cfg: OpenClawConfig,
  options: RepairOptions = {},
): StaleAgentModelRefRepair {
  const replaceMode = cfg.models?.mode === "replace";
  const pluginProviders = replaceMode
    ? { providerIds: new Set<string>(), warnings: [] }
    : collectPluginProviderIds(cfg, options);
  if (!pluginProviders.providerIds) {
    return { config: cfg, changes: [], warnings: pluginProviders.warnings };
  }

  // Bundled core providers declare provider ownership in their plugin manifests,
  // so the metadata snapshot is the canonical inventory for both core and plugins.
  const baseAvailableProviders = pluginProviders.providerIds;
  if (!replaceMode) {
    baseAvailableProviders.add(normalizeProviderId(DEFAULT_PROVIDER));
  }
  for (const providerId of Object.keys(cfg.models?.providers ?? {})) {
    const normalized = normalizeProviderId(providerId);
    if (normalized) {
      baseAvailableProviders.add(normalized);
    }
  }
  const config = structuredClone(cfg);
  const changes: string[] = [];
  const warnings = [...pluginProviders.warnings];
  const env = options.env ?? process.env;
  const persistedForAgent = (agentId: string): Set<string> | undefined => {
    const persisted = collectPersistedProviderIds({
      cfg,
      agentId,
      env,
      injected: options.persistedProviderIdsByAgentId,
    });
    if (!persisted.providerIds) {
      if (persisted.warning) {
        warnings.push(persisted.warning);
      }
      return undefined;
    }
    return persisted.providerIds;
  };
  const availabilityForAgent = (agentId: string): Set<string> | undefined => {
    const available = new Set(baseAvailableProviders);
    if (replaceMode) {
      return available;
    }
    const persisted = persistedForAgent(agentId);
    if (!persisted) {
      return undefined;
    }
    for (const providerId of persisted) {
      available.add(providerId);
    }
    return available;
  };
  const availabilityForDefaults = (): Set<string> | undefined => {
    const available = new Set(baseAvailableProviders);
    if (replaceMode) {
      return available;
    }
    const inheritingAgentIds: string[] = [];
    for (const agent of listAgentEntries(cfg)) {
      if (typeof agent.id !== "string") {
        continue;
      }
      const explicitPrimary = modelPrimaryRef(agent.model);
      if (!explicitPrimary) {
        inheritingAgentIds.push(agent.id);
        continue;
      }
      const agentAvailability = availabilityForAgent(agent.id);
      const provider = providerFromModelRef(explicitPrimary);
      if (agentAvailability && provider && !agentAvailability.has(provider)) {
        // This stale override will be removed or replaced later in the same repair.
        inheritingAgentIds.push(agent.id);
      }
    }
    if (inheritingAgentIds.length === 0) {
      const defaultAgentId = tryResolveDefaultAgentId(cfg);
      if (defaultAgentId) {
        inheritingAgentIds.push(defaultAgentId);
      }
    }
    let commonPersisted: Set<string> | undefined;
    for (const agentId of inheritingAgentIds) {
      const persisted = persistedForAgent(agentId);
      if (!persisted) {
        return undefined;
      }
      commonPersisted = commonPersisted
        ? new Set([...commonPersisted].filter((providerId) => persisted.has(providerId)))
        : new Set(persisted);
    }
    for (const providerId of commonPersisted ?? []) {
      available.add(providerId);
    }
    return available;
  };
  const availabilityForDefaultModelMap = (): Set<string> | undefined => {
    const available = new Set(baseAvailableProviders);
    if (replaceMode) {
      return available;
    }
    const inheritingAgentIds = listAgentEntries(cfg)
      .filter((agent) => isRecord(agent) && typeof agent.id === "string" && !isRecord(agent.models))
      .map((agent) => agent.id as string);
    if (inheritingAgentIds.length === 0) {
      const defaultAgentId = tryResolveDefaultAgentId(cfg);
      if (defaultAgentId) {
        inheritingAgentIds.push(defaultAgentId);
      }
    }
    for (const agentId of inheritingAgentIds) {
      const persisted = persistedForAgent(agentId);
      if (!persisted) {
        return undefined;
      }
      for (const providerId of persisted) {
        available.add(providerId);
      }
    }
    return available;
  };
  const availabilityForDefaultFallbackPolicy = (
    kind: "fallbacks" | "fallbackChains",
  ): Set<string> | undefined => {
    const entries = listAgentEntries(cfg);
    const inheritingAgentIds = entries
      .filter((agent) => {
        const model = isRecord(agent.model) ? agent.model : undefined;
        return (
          !Array.isArray(model?.fallbacks) &&
          (kind === "fallbacks" || !isRecord(model?.fallbackChains))
        );
      })
      .map((agent) => agent.id);
    if (entries.length === 0) {
      const defaultAgentId = tryResolveDefaultAgentId(cfg);
      if (defaultAgentId) {
        inheritingAgentIds.push(defaultAgentId);
      }
    }
    if (inheritingAgentIds.length === 0) {
      return undefined;
    }
    const available = new Set(baseAvailableProviders);
    for (const agentId of inheritingAgentIds) {
      const agentAvailability = availabilityForAgent(agentId);
      if (!agentAvailability) {
        return undefined;
      }
      for (const providerId of agentAvailability) {
        available.add(providerId);
      }
    }
    return available;
  };
  const makeStaleChecker = (available: ReadonlySet<string>) => (ref: string) => {
    const provider = providerFromModelRef(ref);
    return provider && !available.has(provider) ? provider : undefined;
  };

  const defaults = config.agents?.defaults;
  const defaultAvailability = availabilityForDefaults();
  const configuredDefaultPrimary = modelPrimaryRef(defaults?.model);
  let repairedDefaultPrimary =
    configuredDefaultPrimary ?? (replaceMode ? firstExplicitModelRef(cfg) : DEFAULT_MODEL_REF);
  let defaultPrimaryChanged = false;
  let preserveDefaultModelSelector = false;
  const shouldPreserveDefaultModelSelector = (replacement: string | undefined): boolean => {
    const affectedOwners = findChangedGlobalFallbackTailOwners({
      config,
      replacement,
      availabilityForAgent,
      makeStaleChecker,
      modelPrimaryRef,
    });
    if (affectedOwners.length === 0) {
      return false;
    }
    warnings.push(
      `Retained stale agents.defaults.model and its model policy: replacing primary "${modelPrimaryRef(defaults?.model)}" would change which per-model selections inherit global fallbacks (${affectedOwners.join(", ")}). Choose an available default with openclaw models set and rerun openclaw doctor --fix.`,
    );
    return true;
  };
  if (defaults && defaultAvailability) {
    const isStale = makeStaleChecker(defaultAvailability);
    const configuredReplacement = replaceMode ? firstExplicitModelRef(cfg) : DEFAULT_MODEL_REF;
    if (defaults.model) {
      if (typeof defaults.model === "string") {
        const provider = isStale(defaults.model);
        if (provider) {
          const staleRef = defaults.model;
          if (configuredReplacement) {
            defaults.model = configuredReplacement;
            defaultPrimaryChanged = true;
            changes.push(
              `Replaced stale agents.defaults.model "${staleRef}" with default "${configuredReplacement}" (provider "${provider}" is unavailable).`,
            );
          } else {
            delete defaults.model;
            defaultPrimaryChanged = true;
            changes.push(
              `Removed stale agents.defaults.model "${staleRef}" because provider "${provider}" is unavailable and no replacement model is configured.`,
            );
          }
        }
      } else if (isRecord(defaults.model)) {
        const provider =
          typeof defaults.model.primary === "string" ? isStale(defaults.model.primary) : undefined;
        let replacement: string | undefined;
        if (provider && typeof defaults.model.primary === "string") {
          const staleRef = defaults.model.primary;
          replacement = replaceMode
            ? ((Array.isArray(defaults.model.fallbacks)
                ? defaults.model.fallbacks.find(
                    (fallback) => typeof fallback === "string" && !isStale(fallback),
                  )
                : undefined) ?? configuredReplacement)
            : configuredReplacement;
          preserveDefaultModelSelector = shouldPreserveDefaultModelSelector(replacement);
          if (preserveDefaultModelSelector) {
            replacement = undefined;
          } else if (replacement) {
            defaults.model.primary = replacement;
            defaultPrimaryChanged = true;
            changes.push(
              `Replaced stale agents.defaults.model primary "${staleRef}" with default "${replacement}" (provider "${provider}" is unavailable).`,
            );
          } else {
            delete defaults.model.primary;
            defaultPrimaryChanged = true;
            changes.push(
              `Removed stale agents.defaults.model primary "${staleRef}" because provider "${provider}" is unavailable and no replacement model is configured.`,
            );
          }
        }
        if (!preserveDefaultModelSelector) {
          const fallbackAvailability = Array.isArray(defaults.model.fallbacks)
            ? availabilityForDefaultFallbackPolicy("fallbacks")
            : undefined;
          if (fallbackAvailability) {
            filterFallbacks({
              model: defaults.model,
              path: "agents.defaults.model",
              isStale: makeStaleChecker(fallbackAvailability),
              changes,
            });
          }
          const chainAvailability = isRecord(defaults.model.fallbackChains)
            ? availabilityForDefaultFallbackPolicy("fallbackChains")
            : undefined;
          if (chainAvailability) {
            filterFallbackChains({
              model: defaults.model,
              path: "agents.defaults.model",
              isStale: makeStaleChecker(chainAvailability),
              changes,
            });
          }
          if (
            replacement &&
            Array.isArray(defaults.model.fallbacks) &&
            defaults.model.fallbacks.includes(replacement)
          ) {
            defaults.model.fallbacks = defaults.model.fallbacks.filter(
              (fallback) => fallback !== replacement,
            );
            changes.push(
              `Removed duplicate agents.defaults.model fallback "${replacement}" after selecting it as the default primary.`,
            );
          }
          if (
            !defaults.model.primary &&
            !defaults.model.fallbacks &&
            !Object.hasOwn(defaults.model, "fallbackChains")
          ) {
            delete defaults.model;
          }
        }
      }
    }
    repairedDefaultPrimary =
      modelPrimaryRef(defaults?.model) ??
      (replaceMode ? firstExplicitModelRef(cfg) : DEFAULT_MODEL_REF);
    const modelMapAvailability = preserveDefaultModelSelector
      ? undefined
      : availabilityForDefaultModelMap();
    if (modelMapAvailability) {
      repairModelMap({
        models: defaults.models,
        path: "agents.defaults.models",
        isStale: makeStaleChecker(modelMapAvailability),
        replacementRef: repairedDefaultPrimary,
        ensureReplacement: defaultPrimaryChanged,
        changes,
        warnings,
      });
    }
  }

  for (const entry of listMutableCodexRouteAgentEntries(config)) {
    const agent = entry.agent;
    const available = availabilityForAgent(entry.agentId);
    if (!available) {
      continue;
    }
    const isStale = makeStaleChecker(available);
    const modelPath = `${entry.path}.model`;
    const inheritedDefaultAvailable = Boolean(
      defaultAvailability &&
      repairedDefaultPrimary &&
      (!replaceMode || modelPrimaryRef(defaults?.model)) &&
      !isStale(repairedDefaultPrimary),
    );
    const canInheritDefault = inheritedDefaultAvailable;
    const ownPrimary = modelPrimaryRef(agent.model);
    const ownModel = isRecord(agent.model) ? agent.model : undefined;
    const defaultModel = isRecord(defaults?.model) ? defaults.model : undefined;
    if (
      ownPrimary &&
      isStale(ownPrimary) &&
      repairedDefaultPrimary &&
      !isStale(repairedDefaultPrimary) &&
      !Array.isArray(ownModel?.fallbacks) &&
      Array.isArray(defaultModel?.fallbacks) &&
      defaultModel.fallbacks.length > 0
    ) {
      const originalGlobalRef = modelPrimaryRef(cfg.agents?.defaults?.model);
      const before = modelRefIdentityForRepair(cfg, ownPrimary, entry.agentId);
      const beforeGlobal = modelRefIdentityForRepair(cfg, originalGlobalRef);
      const after = modelRefIdentityForRepair(config, repairedDefaultPrimary, entry.agentId);
      const afterGlobal = modelRefIdentityForRepair(config, modelPrimaryRef(defaults?.model));
      if (
        !before ||
        !beforeGlobal ||
        !after ||
        !afterGlobal ||
        (before === beforeGlobal) !== (after === afterGlobal)
      ) {
        warnings.push(
          `Retained stale ${modelPath} and its model policy: replacing primary "${ownPrimary}" would change its per-model global fallback tail. Choose an available model explicitly and rerun openclaw doctor --fix.`,
        );
        continue;
      }
    }
    let agentPrimaryChanged = false;
    if (typeof agent.model === "string") {
      const provider = isStale(agent.model);
      if (provider) {
        const staleRef = agent.model;
        if (canInheritDefault) {
          delete agent.model;
          agentPrimaryChanged = true;
          changes.push(
            `Removed stale ${modelPath} "${staleRef}" so agent "${entry.agentId}" inherits the default model (provider "${provider}" is unavailable).`,
          );
        } else if (repairedDefaultPrimary && !isStale(repairedDefaultPrimary)) {
          agent.model = repairedDefaultPrimary;
          agentPrimaryChanged = true;
          changes.push(
            `Replaced stale ${modelPath} "${staleRef}" with "${repairedDefaultPrimary}" (provider "${provider}" is unavailable).`,
          );
        } else {
          warnings.push(
            `Skipped stale ${modelPath} repair because no available inherited or replacement model is configured.`,
          );
        }
      }
    } else if (isRecord(agent.model)) {
      const model = agent.model;
      const provider = typeof model.primary === "string" ? isStale(model.primary) : undefined;
      let agentReplacement: string | undefined;
      if (provider && typeof model.primary === "string") {
        const staleRef = model.primary;
        if (canInheritDefault) {
          delete model.primary;
          agentPrimaryChanged = true;
          agentReplacement = repairedDefaultPrimary;
          changes.push(
            `Removed stale ${modelPath} primary "${staleRef}" so agent "${entry.agentId}" inherits the default model (provider "${provider}" is unavailable).`,
          );
        } else if (
          (agentReplacement =
            (Array.isArray(model.fallbacks)
              ? model.fallbacks.find(
                  (fallback) => typeof fallback === "string" && !isStale(fallback),
                )
              : undefined) ??
            (repairedDefaultPrimary && !isStale(repairedDefaultPrimary)
              ? repairedDefaultPrimary
              : undefined))
        ) {
          model.primary = agentReplacement;
          agentPrimaryChanged = true;
          changes.push(
            `Replaced stale ${modelPath} primary "${staleRef}" with "${agentReplacement}" (provider "${provider}" is unavailable).`,
          );
        } else {
          warnings.push(
            `Skipped stale ${modelPath} primary repair because no available inherited or replacement model is configured.`,
          );
        }
      }
      filterFallbacks({ model, path: modelPath, isStale, changes });
      filterFallbackChains({ model, path: modelPath, isStale, changes });
      if (
        agentReplacement &&
        Array.isArray(model.fallbacks) &&
        model.fallbacks.includes(agentReplacement)
      ) {
        const filteredFallbacks = model.fallbacks.filter(
          (fallback) => fallback !== agentReplacement,
        );
        model.fallbacks = filteredFallbacks;
        changes.push(
          `Removed duplicate ${modelPath} fallback "${agentReplacement}" after selecting it as the primary.`,
        );
      }
      if (!model.primary && !model.fallbacks && !Object.hasOwn(model, "fallbackChains")) {
        delete agent.model;
      }
    }
    const effectiveAgentPrimary = modelPrimaryRef(agent.model) ?? repairedDefaultPrimary;
    repairModelMap({
      models: isRecord(agent.models) ? agent.models : undefined,
      path: `${entry.path}.models`,
      isStale,
      replacementRef:
        effectiveAgentPrimary && !isStale(effectiveAgentPrimary)
          ? effectiveAgentPrimary
          : undefined,
      ensureReplacement:
        agentPrimaryChanged || (!modelPrimaryRef(agent.model) && defaultPrimaryChanged),
      changes,
      warnings,
    });
  }

  const retired = repairRetiredConfigModelRefs(
    config,
    createRetiredModelRefRepairResolver({
      cfg: config,
      env,
      metadataSnapshot: options.pluginMetadataSnapshot,
      warnings,
    }),
    warnings,
  );
  changes.push(...retired.changes);
  return {
    config: changes.length > 0 ? retired.config : cfg,
    changes,
    warnings,
    ...(retired.changes.length > 0
      ? { retiredModelRefConfig: { agents: config.agents, models: config.models } }
      : {}),
  };
}
