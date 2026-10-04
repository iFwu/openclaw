import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { resolveCronModelSelection } from "./model-selection.js";

const provider = "cron-owner";
function registry(model?: string) {
  const pluginRegistry = createEmptyPluginRegistry();
  const normalize = vi.fn(({ modelId }: { modelId: string }) =>
    modelId === "latest" ? model : undefined,
  );
  if (model) {
    pluginRegistry.providers.push({
      pluginId: provider,
      source: "test",
      provider: { id: provider, label: "Owner", auth: [], normalizeModelId: normalize },
    });
  }
  return { pluginRegistry, normalize };
}
describe("cron raw selection captured owner", () => {
  it.each(["default", "payload", "session"] as const)(
    "uses captured empty owner, never ambient B: %s",
    async (source) => {
      const config: OpenClawConfig = {
        agents: { defaults: { model: { primary: `${provider}/latest` } } },
      };
      const metadataSnapshot = createPluginMetadataSnapshotFixture({
        plugins: [{ id: provider, providers: [provider] }],
      });
      const a = registry();
      const b = registry("release-b");
      const entries = ["latest", "release-a", "release-b"].map((id) => ({
        provider,
        id,
        name: id,
      }));
      const owner = {
        config,
        agentId: "main",
        agentDir: "/tmp/cron-owner-agent",
        workspaceDir: "/tmp/cron-owner-workspace",
        metadataSnapshot,
        pluginRegistry: a.pluginRegistry,
        modelCatalog: { entries, routeVariants: entries },
      };
      await withPluginRuntimeGenerationScope(
        { metadataSnapshot, pluginRegistry: b.pluginRegistry },
        async () => {
          const selected = await resolveCronModelSelection({
            cfg: config,
            owner,
            agentId: "main",
            agentDir: owner.agentDir,
            workspaceDir: owner.workspaceDir,
            sessionEntry:
              source === "session" ? { providerOverride: provider, modelOverride: "latest" } : {},
            isGmailHook: false,
            payload: {
              kind: "agentTurn",
              message: "test",
              ...(source === "payload" ? { model: `${provider}/latest` } : {}),
            },
          });
          expect(selected).toMatchObject({
            ok: true,
            provider,
            model: "latest",
            modelSource: source,
          });
          expect(b.normalize).not.toHaveBeenCalled();
        },
      );
    },
  );
  it("uses captured A's executable identity instead of ambient B", async () => {
    const config: OpenClawConfig = {
      agents: { defaults: { model: { primary: `${provider}/latest` } } },
    };
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [{ id: provider, providers: [provider] }],
    });
    const a = registry("release-a");
    const b = registry("release-b");
    const entries = ["latest", "release-a", "release-b"].map((id) => ({ provider, id, name: id }));
    const owner = {
      config,
      agentId: "main",
      agentDir: "/tmp/cron-owner-agent",
      workspaceDir: "/tmp/cron-owner-workspace",
      metadataSnapshot,
      pluginRegistry: a.pluginRegistry,
      modelCatalog: { entries, routeVariants: entries },
    };
    await withPluginRuntimeGenerationScope(
      { metadataSnapshot, pluginRegistry: b.pluginRegistry },
      async () => {
        expect(
          await resolveCronModelSelection({
            cfg: config,
            owner,
            agentId: "main",
            agentDir: owner.agentDir,
            workspaceDir: owner.workspaceDir,
            sessionEntry: {},
            isGmailHook: false,
            payload: { kind: "agentTurn", message: "test" },
          }),
        ).toMatchObject({ ok: true, provider, model: "release-a" });
        expect(b.normalize).not.toHaveBeenCalled();
      },
    );
  });
});
