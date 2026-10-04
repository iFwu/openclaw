import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronPreflightCandidates } from "../cron/isolated-agent/run-fallback-policy.js";
import type { CronJob } from "../cron/types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { resolveModelCandidateChain } from "./model-fallback-candidates.js";
import { resolveSelectedModelFallbackChain } from "./model-fallback-policy.js";

const provider = "owned-policy";
const cfg: OpenClawConfig = {
  agents: {
    defaults: {
      model: {
        primary: `${provider}/latest`,
        fallbacks: ["global/tail"],
        fallbackChains: { [`${provider}/latest`]: ["own/backup"] },
      },
    },
  },
};
function runtimeOwner() {
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [{ id: provider, providers: [provider] }],
  });
  const pluginRegistry = createEmptyPluginRegistry();
  const normalize = vi.fn(({ modelId }: { modelId: string }) => {
    if (modelId === "release") {
      throw new Error("resolved tuple was normalized twice");
    }
    return modelId === "latest" ? "release" : undefined;
  });
  pluginRegistry.providers.push({
    pluginId: provider,
    source: "test",
    provider: { id: provider, label: "Policy", auth: [], normalizeModelId: normalize },
  });
  return { metadataSnapshot, pluginRegistry, normalize };
}
describe("selected policy captured executable owner", () => {
  it.each(["raw", "resolved"] as const)(
    "preserves authored chain and global tail for a runtime-only alias: %s",
    (resolution) => {
      const owner = runtimeOwner();
      withPluginRuntimeGenerationScope(owner, () => {
        expect(
          resolveModelCandidateChain({
            cfg,
            provider,
            model: resolution === "raw" ? "latest" : "release",
            requestedRouteResolution: resolution,
          }).map(({ provider: candidateProvider, model }) => `${candidateProvider}/${model}`),
        ).toEqual([`${provider}/release`, "own/backup", "global/tail"]);
        expect(owner.normalize.mock.calls.every(([context]) => context.modelId === "latest")).toBe(
          true,
        );
      });
    },
  );
  it("keeps static Doctor/display policy reading out of executable hooks", () => {
    const owner = runtimeOwner();
    withPluginRuntimeGenerationScope(owner, () => {
      expect(
        resolveSelectedModelFallbackChain({
          cfg,
          provider,
          model: "latest",
          manifestPlugins: owner.metadataSnapshot.plugins,
        }),
      ).toEqual(["own/backup", "global/tail"]);
      expect(owner.normalize).not.toHaveBeenCalled();
    });
  });
  it("keeps preflight on selection owner A while ambient metadata belongs to B", () => {
    const metadata = (model: string) =>
      createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: provider,
            providers: [provider],
            modelIdNormalization: { providers: { [provider]: { aliases: { latest: model } } } },
          },
        ],
      });
    const selected = metadata("release-a");
    const ambient = metadata("release-b");
    const job: CronJob = {
      id: "owner-test",
      name: "Owner",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "at", at: "2026-10-03T00:00:00Z" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "test" },
      state: {},
    };
    withPluginRuntimeGenerationScope(
      { metadataSnapshot: ambient, pluginRegistry: createEmptyPluginRegistry() },
      () => {
        expect(
          resolveCronPreflightCandidates({
            cfg,
            job,
            agentId: "main",
            provider,
            model: "release-a",
            manifestPlugins: selected.plugins,
            policyRegistry: null,
          }).map(({ provider: candidateProvider, model }) => `${candidateProvider}/${model}`),
        ).toEqual([`${provider}/release-a`, "own/backup", "global/tail"]);
      },
    );
  });
});

describe("authored fallback execution identity", () => {
  it("normalizes an authored fallback value through the captured owner without reopening a resolved selection", () => {
    const source = "source-values";
    const target = "target-values";
    const registry = createEmptyPluginRegistry();
    for (const id of [source, target]) {
      registry.providers.push({
        pluginId: id,
        source: "test",
        provider: {
          id,
          label: id,
          auth: [],
          normalizeModelId: ({ modelId }) => {
            if (id === source && modelId === "release") {
              throw new Error("resolved selection normalized twice");
            }
            return modelId === "latest" ? "release" : undefined;
          },
        },
      });
    }
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: `${source}/latest`,
            fallbackChains: { [`${source}/latest`]: [`${target}/latest`] },
          },
        },
      },
    };
    expect(
      resolveModelCandidateChain({
        cfg: config,
        provider: source,
        model: "release",
        requestedRouteResolution: "resolved",
        allowPluginNormalization: false,
        policyRegistry: registry,
        manifestPlugins: [],
      }).map((ref) => `${ref.provider}/${ref.model}`),
    ).toEqual([`${source}/release`, `${target}/release`]);
  });
});
