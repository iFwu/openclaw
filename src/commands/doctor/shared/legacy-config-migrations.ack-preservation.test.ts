import { describe, expect, it } from "vitest";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_CRON } from "./legacy-config-migrations.runtime.cron.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_GATEWAY } from "./legacy-config-migrations.runtime.gateway.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_MCP } from "./legacy-config-migrations.runtime.mcp.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS } from "./legacy-config-migrations.runtime.models.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED } from "./legacy-config-migrations.runtime.retired.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_SESSION } from "./legacy-config-migrations.runtime.session.js";

function applyAll(raw: Record<string, unknown>) {
  const changes: string[] = [];
  for (const migration of [
    ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_GATEWAY,
    ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_MCP,
    ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_CRON,
    ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS.filter(
      (modelMigration) => modelMigration.id === "defaultModel->agents.defaults.model",
    ),
    ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_SESSION,
    ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED,
  ]) {
    migration.apply(raw, changes);
  }
  return { raw, changes };
}

describe("fork ACK Doctor preservation", () => {
  it.each([true, false])("preserves removeAckAfterReply=%s during other migrations", (value) => {
    const raw = {
      messages: {
        removeAckAfterReply: value,
        statusReactions: { enabled: true, emojis: { done: "✅" } },
      },
    };
    const result = applyAll(raw);
    expect(result.raw).toHaveProperty("messages.removeAckAfterReply", value);
    expect(result.raw).not.toHaveProperty("messages.statusReactions.emojis");
    expect(result.changes).not.toContain(
      "Removed messages.removeAckAfterReply; acknowledgements are retained.",
    );
    expect(applyAll(raw)).toEqual({ raw, changes: [] });
  });
});
