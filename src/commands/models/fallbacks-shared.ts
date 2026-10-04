/** Shared command implementation for text and image model fallback lists. */
import { formatCliCommand } from "../../cli/command-format.js";
import { logConfigUpdated } from "../../config/logging.js";
import {
  resolveAgentModelFallbackChainsValue,
  resolveAgentModelFallbackValues,
  toAgentModelListLike,
} from "../../config/model-input.js";
import type { AgentModelEntryConfig } from "../../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { type RuntimeEnv, writeRuntimeJson, writeRuntimeStdout } from "../../runtime.js";
import { loadModelsConfig } from "./load-config.js";
import {
  ensureFlagCompatibility,
  mergePrimaryFallbackConfig,
  modelKey,
  resolveModelTarget,
  resolveModelKeysFromEntries,
  resolveModelRefsFromEntries,
  upsertCanonicalModelConfigEntry,
  updateConfig,
} from "./shared.js";

type DefaultsFallbackKey = "model" | "imageModel";

function resolveFallbackModelKey(cfg: OpenClawConfig, raw?: string): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!raw.trim()) {
    throw new Error("--model must not be blank");
  }
  const resolved = resolveModelTarget({ raw, cfg });
  const canonicalKey = modelKey(resolved.provider, resolved.model);
  const chains = resolveAgentModelFallbackChainsValue(cfg.agents?.defaults?.model) ?? {};
  return !Object.hasOwn(chains, canonicalKey) && Object.hasOwn(chains, resolved.model)
    ? resolved.model
    : canonicalKey;
}

function listCommandForFallbackKey(key: DefaultsFallbackKey): string {
  return key === "imageModel" ? "models image-fallbacks list" : "models fallbacks list";
}

function getFallbacks(cfg: OpenClawConfig, key: DefaultsFallbackKey, model?: string): string[] {
  if (model !== undefined) {
    return resolveAgentModelFallbackChainsValue(cfg.agents?.defaults?.model)?.[model] ?? [];
  }
  return resolveAgentModelFallbackValues(cfg.agents?.defaults?.[key]);
}

function patchDefaultsFallbacks(
  cfg: OpenClawConfig,
  params: {
    key: DefaultsFallbackKey;
    model?: string;
    fallbacks: string[];
    models?: Record<string, AgentModelEntryConfig>;
  },
): OpenClawConfig {
  const existing = toAgentModelListLike(cfg.agents?.defaults?.[params.key]);
  let patch: Parameters<typeof mergePrimaryFallbackConfig>[1] = { fallbacks: params.fallbacks };
  if (params.model !== undefined) {
    const fallbackChains = {
      ...resolveAgentModelFallbackChainsValue(cfg.agents?.defaults?.model),
    };
    if (params.fallbacks.length === 0) {
      delete fallbackChains[params.model];
    } else {
      fallbackChains[params.model] = params.fallbacks;
    }
    patch = { fallbackChains };
  }
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        [params.key]: mergePrimaryFallbackConfig(existing, patch),
        ...(params.models ? { models: params.models } : undefined),
      },
    },
  };
}

/** Lists fallback model refs for the selected defaults key. */
export async function listFallbacksCommand(
  params: { label: string; key: DefaultsFallbackKey },
  opts: { json?: boolean; plain?: boolean; model?: string },
  runtime: RuntimeEnv,
) {
  ensureFlagCompatibility(opts);
  const cfg = await loadModelsConfig({
    commandName: listCommandForFallbackKey(params.key),
    runtime,
  });
  const model = resolveFallbackModelKey(cfg, opts.model);
  const fallbacks = getFallbacks(cfg, params.key, model);
  const label = model === undefined ? params.label : `${params.label} for ${model}`;

  if (opts.json) {
    writeRuntimeJson(runtime, { ...(model === undefined ? {} : { model }), fallbacks });
    return;
  }
  if (opts.plain) {
    for (const entry of fallbacks) {
      writeRuntimeStdout(runtime, entry);
    }
    return;
  }

  runtime.log(`${label} (${fallbacks.length}):`);
  if (fallbacks.length === 0) {
    runtime.log("- none");
    return;
  }
  for (const entry of fallbacks) {
    runtime.log(`- ${entry}`);
  }
}

/** Adds a fallback model, creating the canonical model entry when needed. */
export async function addFallbackCommand(
  params: {
    label: string;
    key: DefaultsFallbackKey;
    model?: string;
  },
  modelRaw: string,
  runtime: RuntimeEnv,
) {
  let selectedModelKey: string | undefined;
  const updated = await updateConfig(
    (cfg, context) => {
      const { runtimeConfig } = context;
      const model = resolveFallbackModelKey(runtimeConfig, params.model);
      selectedModelKey = model;
      const resolved = resolveModelTarget({ raw: modelRaw, cfg: runtimeConfig });
      const nextModels = { ...cfg.agents?.defaults?.models };
      const targetKey = upsertCanonicalModelConfigEntry(nextModels, resolved, context);
      const existing = getFallbacks(cfg, params.key, model);
      const existingKeys = resolveModelKeysFromEntries({
        cfg: runtimeConfig,
        entries: getFallbacks(runtimeConfig, params.key, model),
      });
      return patchDefaultsFallbacks(cfg, {
        key: params.key,
        model,
        fallbacks: existingKeys.includes(targetKey) ? existing : [...existing, targetKey],
        models: nextModels,
      });
    },
    (_, { runtimeConfig }) => {
      const model = resolveFallbackModelKey(runtimeConfig, params.model);
      return [
        ...(params.model === undefined
          ? []
          : [resolveModelTarget({ raw: params.model, cfg: runtimeConfig })]),
        resolveModelTarget({ raw: modelRaw, cfg: runtimeConfig }),
        ...resolveModelRefsFromEntries({
          cfg: runtimeConfig,
          entries: getFallbacks(runtimeConfig, params.key, model),
        }),
      ];
    },
  );

  logConfigUpdated(runtime);
  const label =
    selectedModelKey === undefined ? params.label : `${params.label} for ${selectedModelKey}`;
  runtime.log(`${label}: ${getFallbacks(updated, params.key, selectedModelKey).join(", ")}`);
}

/** Removes a fallback model by resolving aliases to the canonical provider/model key. */
export async function removeFallbackCommand(
  params: {
    label: string;
    key: DefaultsFallbackKey;
    notFoundLabel: string;
    model?: string;
  },
  modelRaw: string,
  runtime: RuntimeEnv,
) {
  let selectedModelKey: string | undefined;
  const updated = await updateConfig(
    (cfg, { runtimeConfig }) => {
      const model = resolveFallbackModelKey(runtimeConfig, params.model);
      selectedModelKey = model;
      const resolved = resolveModelTarget({ raw: modelRaw, cfg: runtimeConfig });
      const targetKey = modelKey(resolved.provider, resolved.model);
      const existing = getFallbacks(cfg, params.key, model);
      const existingKeys = resolveModelKeysFromEntries({
        cfg: runtimeConfig,
        entries: getFallbacks(runtimeConfig, params.key, model),
      });
      // Compare effective refs, but filter their source positions so unrelated
      // placeholders and source-authored values survive the config write.
      const filtered = existing.filter((_, index) => existingKeys[index] !== targetKey);

      if (filtered.length === existing.length) {
        const listCommand = `${listCommandForFallbackKey(params.key)}${model === undefined ? "" : ` --model ${model}`}`;
        throw new Error(
          `${params.notFoundLabel} not found: ${targetKey}. Run ${formatCliCommand(`openclaw ${listCommand}`)} to see configured fallbacks.`,
        );
      }

      return patchDefaultsFallbacks(cfg, { key: params.key, model, fallbacks: filtered });
    },
    (_, { runtimeConfig }) => {
      const model = resolveFallbackModelKey(runtimeConfig, params.model);
      return [
        ...(params.model === undefined
          ? []
          : [resolveModelTarget({ raw: params.model, cfg: runtimeConfig })]),
        resolveModelTarget({ raw: modelRaw, cfg: runtimeConfig }),
        ...resolveModelRefsFromEntries({
          cfg: runtimeConfig,
          entries: getFallbacks(runtimeConfig, params.key, model),
        }),
      ];
    },
  );

  logConfigUpdated(runtime);
  const label =
    selectedModelKey === undefined ? params.label : `${params.label} for ${selectedModelKey}`;
  runtime.log(`${label}: ${getFallbacks(updated, params.key, selectedModelKey).join(", ")}`);
}

/** Clears all fallback model refs for the selected defaults key. */
export async function clearFallbacksCommand(
  params: { key: DefaultsFallbackKey; clearedMessage: string; model?: string },
  runtime: RuntimeEnv,
) {
  await updateConfig(
    (cfg, { runtimeConfig }) => {
      const model = resolveFallbackModelKey(runtimeConfig, params.model);
      return patchDefaultsFallbacks(cfg, { key: params.key, model, fallbacks: [] });
    },
    (_, { runtimeConfig }) => {
      resolveFallbackModelKey(runtimeConfig, params.model);
      return params.model === undefined
        ? []
        : [resolveModelTarget({ raw: params.model, cfg: runtimeConfig })];
    },
  );

  logConfigUpdated(runtime);
  runtime.log(
    params.model === undefined
      ? params.clearedMessage
      : `Per-model fallback chain for ${params.model} cleared.`,
  );
}

export async function listFallbackChainsCommand(
  opts: { json?: boolean; plain?: boolean },
  runtime: RuntimeEnv,
) {
  ensureFlagCompatibility(opts);
  const cfg = await loadModelsConfig({ commandName: "models fallbacks chains", runtime });
  const chains = resolveAgentModelFallbackChainsValue(cfg.agents?.defaults?.model) ?? {};
  const entries = Object.entries(chains).toSorted(([a], [b]) => a.localeCompare(b));
  if (opts.json) {
    writeRuntimeJson(runtime, { chains: Object.fromEntries(entries) });
    return;
  }
  if (opts.plain) {
    for (const [model, fallbacks] of entries) {
      writeRuntimeStdout(runtime, `${model}: ${fallbacks.join(", ")}`);
    }
    return;
  }
  runtime.log(`Per-model fallback chains (${entries.length}):`);
  if (entries.length === 0) {
    runtime.log("- none");
  }
  for (const [model, fallbacks] of entries) {
    runtime.log(`- ${model}: ${fallbacks.length === 0 ? "(empty)" : fallbacks.join(", ")}`);
  }
}
