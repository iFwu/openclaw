import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import * as harnessRuntime from "../harness/runtime-plugin.js";
import { loadManifestModelCatalog } from "../model-catalog.js";
import type { ModelCatalogEntry } from "../model-catalog.types.js";
import { buildConfiguredModelCatalog } from "../model-selection-shared.js";
import * as sessionPersistence from "./attempt-execution.shared.js";
import { resolveEmbeddedModelSelection } from "./model-selection.js";
import * as runtimeLoaders from "./runtime-loaders.js";

export const sessionKey = "agent:main:subagent:configured-selection";

export function configuredModel(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    maxTokens: 1024,
  };
}

export function catalogEntry(provider: string, id: string): ModelCatalogEntry {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl: `https://${provider}.invalid/v1`,
    reasoning: false,
    input: ["text"],
  };
}

export function automaticEntry(model = "child"): SessionEntry {
  return {
    sessionId: "configured-child",
    updatedAt: 1,
    providerOverride: "custom",
    modelOverride: model,
    modelOverrideSource: "auto",
    modelOverrideRouteResolution: "resolved",
    modelOverrideFallbackOriginProvider: "custom",
    modelOverrideFallbackOriginModel: model,
  };
}

export function setupConfiguredModelSelectionTests() {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    vi.spyOn(harnessRuntime, "ensureSelectedAgentHarnessPlugin").mockResolvedValue(undefined);
    vi.spyOn(runtimeLoaders, "loadTranscriptResolveRuntime").mockResolvedValue({
      resolveSessionTranscriptFile: async (params) => ({
        sessionFile: path.join(
          path.dirname(params.storePath ?? "/unused/sessions.json"),
          "turn.jsonl",
        ),
        sessionEntry: params.sessionEntry,
      }),
    });
    // Only the persistence boundary is substituted; the selector decides every patch.
    vi.spyOn(sessionPersistence, "persistAgentSession").mockImplementation(async (params) => {
      const saved = structuredClone(params.entry);
      params.sessionStore[params.sessionKey] = saved;
      return saved;
    });
  });

  afterEach(() => vi.restoreAllMocks());

  function createFixture(options: { manifestOwner?: boolean } = {}) {
    const workspaceDir = tempDirs.make("command-configured-selection-");
    const target = {
      agentId: "main",
      sessionKey,
      storePath: path.join(workspaceDir, "sessions.json"),
    };
    const defaults: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> = {
      model: { primary: "custom/base" },
      modelPolicy: { allow: ["custom/manual"] },
    };
    const custom: ModelProviderConfig = {
      api: "openai-completions",
      baseUrl: "https://custom.invalid/v1",
      agentRuntime: { id: "openclaw" },
      models: [configuredModel("base"), configuredModel("child"), configuredModel("manual")],
    };
    const cfg: OpenClawConfig = {
      agents: {
        entries: { main: { workspace: workspaceDir } },
        defaults,
      },
      models: { providers: { custom } },
    };
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: options.manifestOwner
        ? [
            {
              id: "custom-catalog",
              providers: ["custom"],
              modelCatalog: {
                providers: { custom: { models: [{ id: "child", name: "Manifest child" }] } },
              },
            },
          ]
        : [],
    });
    const registry = createEmptyPluginRegistry();
    const store: Record<string, SessionEntry> = { [sessionKey]: automaticEntry() };
    const entry = () => expectDefined(store[sessionKey], "configured selection fixture session");
    const inventory = vi.mocked(loadManifestModelCatalog).mockImplementation(() => {
      throw new Error("Configured selection must not require unrelated manifest inventory");
    });
    const select = (overrides: Partial<Parameters<typeof resolveEmbeddedModelSelection>[0]> = {}) =>
      withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry: registry }, () =>
        resolveEmbeddedModelSelection({
          cfg,
          opts: { message: "Select the configured child", allowModelOverride: false },
          sessionEntry: entry(),
          sessionStore: store,
          sessionKey,
          sessionId: entry().sessionId,
          storePath: target.storePath,
          sessionAgentId: "main",
          workspaceDir,
          pluginsEnabled: true,
          manifestMetadataSnapshot: metadataSnapshot,
          modelManifestContext: { manifestPlugins: metadataSnapshot },
          configuredThinkingCatalog: buildConfiguredModelCatalog({
            cfg,
            manifestPlugins: metadataSnapshot,
          }),
          isSubagentLane: true,
          suppressVisibleSessionEffects: false,
          runContext: {},
          ...overrides,
        }),
      );
    return { cfg, defaults, custom, store, entry, inventory, registry, select, target };
  }

  return createFixture;
}
