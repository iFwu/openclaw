import path from "node:path";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { listOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.test-support.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import type { resolveEmbeddedModelSelection } from "./model-selection.js";

export function createCliModelSelectionFixture(
  sessionEntry: SessionEntry,
  workspaceDir: string,
): Awaited<ReturnType<typeof resolveEmbeddedModelSelection>> {
  return {
    sessionEntry,
    provider: "claude-cli",
    model: "sonnet",
    requestedRouteResolution: "resolved",
    defaultProvider: "claude-cli",
    defaultModel: "sonnet",
    configuredDefaultAuthProfileId: undefined,
    providerForAuthProfileValidation: "claude-cli",
    hasExplicitRunOverride: false,
    storedProviderOverride: undefined,
    storedModelOverride: undefined,
    storedModelOverrideSource: undefined,
    hasStoredAutoFallbackProvenance: false,
    autoFallbackPrimaryProbe: undefined,
    sessionEntryForAttempt: sessionEntry,
    thinkingCatalog: [],
    immutableThinkLevel: "off",
    effectiveTurnThinkLevel: "off",
    continuationSelection: undefined,
    modelSelectionParent: undefined,
    sessionFile: path.join(workspaceDir, "session.jsonl"),
  };
}

export function resetCliAttemptFixtureDatabases(suiteRoot: string): void {
  for (const database of listOpenClawAgentDatabasesForTest()) {
    if (!database.path.startsWith(`${suiteRoot}${path.sep}`)) {
      continue;
    }
    runOpenClawAgentWriteTransaction(
      (fixture) => {
        fixture.db.exec(`
          DELETE FROM session_transcript_fts;
          DELETE FROM session_transcript_fts_rows;
          DELETE FROM session_nodes;
          DELETE FROM conversations;
          DELETE FROM auth_profile_store;
          DELETE FROM auth_profile_state;
          DELETE FROM cache_entries;
        `);
      },
      database,
      { operationLabel: "test.attempt-execution.reset" },
    );
  }
}

/** Model capability and channel discovery fixtures for CLI fallback tests. */
export function createCliImageCapabilityPlugins(model: string) {
  // MCP still builds message schemas before applying the read-only grant.
  // Keep this capability test independent of bundled Discord action discovery.
  const pluginRegistry = createTestRegistry([
    {
      pluginId: "discord",
      source: "test",
      plugin: {
        ...createChannelTestPluginBase({ id: "discord" }),
        actions: { describeMessageTool: () => null },
      } satisfies ChannelPlugin,
    },
  ]);
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "anthropic",
        providers: ["anthropic"],
        cliBackends: ["claude-cli"],
        modelCatalog: {
          providers: {
            anthropic: {
              models: [{ id: model, name: model, reasoning: true, input: ["text", "image"] }],
            },
          },
        },
      },
    ],
  });
  return { metadataSnapshot, pluginRegistry };
}
