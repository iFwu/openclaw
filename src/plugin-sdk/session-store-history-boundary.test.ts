import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadSessionEntry, patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { closeOpenClawAgentDatabaseByPath } from "../state/openclaw-agent-db.js";
import {
  getSessionEntry,
  listSessionEntries,
  patchSessionEntry,
  upsertSessionEntry,
} from "./session-store-runtime.js";

const databases = new Set<string>();
afterEach(() => {
  for (const database of databases) {
    closeOpenClawAgentDatabaseByPath(database);
  }
  databases.clear();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["upsert", "patch"] as const)(
  "preserves private history and continuation state across a public %s without accepting injection",
  async (operation) => {
    const storePath = path.join(tempDirs.make("sdk-cli-history-"), "openclaw-agent.sqlite");
    databases.add(storePath);
    const sessionKey = "agent:main:history";
    const scope = { sessionKey, storePath };
    const initial: InternalSessionEntry = {
      sessionId: "history-session",
      lifecycleRevision: "history-lifecycle",
      updatedAt: 1,
      modelSelectionRevision: "model-revision",
      continuationTurnRevision: "turn-revision",
      continuationModelSelection: {
        runId: "selection-owner",
        sessionId: "history-session",
        lifecycleRevision: "history-lifecycle",
        modelSelectionRevision: "model-revision",
        turnRevision: "turn-revision",
        provider: "custom",
        model: "selected",
      },
      cliHistoryBoundary: {
        version: 1,
        sessionId: "history-session",
        state: "known",
        authFingerprint: "1".repeat(64),
        generation: "history-generation",
        maxSeq: 7,
        writerRunId: "history-owner",
      },
    };
    await patchSessionEntryCore(scope, () => initial, {
      fallbackEntry: initial,
      replaceEntry: true,
      skipMaintenance: true,
    });
    const publicEntry = getSessionEntry(scope);
    if (!publicEntry) {
      throw new Error("Missing seeded session");
    }
    const privateKeys = [
      "cliHistoryBoundary",
      "modelSelectionRevision",
      "continuationTurnRevision",
      "continuationModelSelection",
    ] as const;
    for (const key of privateKeys) {
      expect(publicEntry).not.toHaveProperty(key);
      expect(listSessionEntries({ storePath })[0]?.entry).not.toHaveProperty(key);
    }
    const candidate = {
      ...publicEntry,
      label: "updated",
      cliHistoryBoundary: { ...initial.cliHistoryBoundary, authFingerprint: "2".repeat(64) },
      modelSelectionRevision: "injected-revision",
      continuationTurnRevision: "injected-turn",
      continuationModelSelection: { ...initial.continuationModelSelection, model: "injected" },
    };
    if (operation === "upsert") {
      await upsertSessionEntry({ ...scope, entry: candidate });
    } else {
      await patchSessionEntry({ ...scope, update: () => candidate });
    }
    expect(getSessionEntry(scope)?.label).toBe("updated");
    const persisted: InternalSessionEntry | undefined = loadSessionEntry(scope);
    for (const key of privateKeys) {
      expect(getSessionEntry(scope)).not.toHaveProperty(key);
      expect.soft(persisted?.[key]).toEqual(initial[key]);
    }

    if (operation === "upsert") {
      await upsertSessionEntry({ ...scope, entry: { ...candidate, sessionId: "rotated-session" } });
    } else {
      await patchSessionEntry({
        ...scope,
        update: () => ({ ...candidate, lifecycleRevision: "rotated-lifecycle" }),
      });
    }
    const rotated: InternalSessionEntry | undefined = loadSessionEntry(scope);
    for (const key of privateKeys.slice(1)) {
      expect(rotated?.[key]).toBeUndefined();
    }
  },
);
