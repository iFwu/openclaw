import path from "node:path";
import { MAIN_SESSION_RECOVERY_CLEAR_PATCH } from "../agents/main-session-recovery/main-session-recovery-clear.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import type { SessionAccessScope } from "../config/sessions/session-accessor.js";
import {
  projectPublicSessionEntry,
  projectPublicSessionEntryPatch,
  SESSION_ENTRY_PRIVATE_CLEAR_PATCH,
} from "../config/sessions/session-entry-projection.js";
import type { InternalSessionEntry, SessionEntry } from "../config/sessions/types.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type ModelSelectionSnapshot = {
  scope: string;
  sessionId: string;
  lifecycleRevision?: string;
  fields: Pick<
    InternalSessionEntry,
    "modelSelectionRevision" | "continuationTurnRevision" | "continuationModelSelection"
  >;
};

// Keep the read's CAS epoch host-private without another database read or public metadata.
const modelSelectionSnapshots = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginModelSelectionSnapshots"),
  () => ({ entries: new WeakMap<SessionEntry, ModelSelectionSnapshot>() }),
  (state) => {
    state.entries = new WeakMap();
  },
  "close-only",
);

function modelSelectionScope(params: SessionStoreReadParams): string {
  const agentId = params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey);
  const storePath =
    params.storePath ??
    resolveSessionStorePathCore(undefined, {
      agentId,
      env: params.env,
    });
  return JSON.stringify([path.resolve(storePath), agentId, params.sessionKey]);
}

export function capturePluginModelSelectionSnapshot(
  entry: InternalSessionEntry,
  projected: SessionEntry,
  scope: SessionStoreReadParams,
): void {
  modelSelectionSnapshots.entries.set(projected, {
    scope: modelSelectionScope(scope),
    sessionId: entry.sessionId,
    lifecycleRevision: entry.lifecycleRevision,
    fields: structuredClone({
      modelSelectionRevision: entry.modelSelectionRevision,
      continuationTurnRevision: entry.continuationTurnRevision,
      continuationModelSelection: entry.continuationModelSelection,
    }),
  });
}

export function restorePluginModelSelectionSnapshot(
  entry: SessionEntry,
  scope: SessionStoreReadParams,
): InternalSessionEntry | undefined {
  const snapshot = modelSelectionSnapshots.entries.get(entry);
  if (!snapshot) {
    return { ...entry };
  }
  if (
    snapshot.scope !== modelSelectionScope(scope) ||
    snapshot.sessionId !== entry.sessionId ||
    snapshot.lifecycleRevision !== entry.lifecycleRevision
  ) {
    return undefined;
  }
  return { ...snapshot.fields, ...entry };
}

export type SessionStoreReadParams = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  hydrateSkillPromptRefs?: boolean;
  readConsistency?: "latest";
  sessionKey: string;
  storePath?: string;
};

export function toSessionAccessScope(params: SessionStoreReadParams): SessionAccessScope {
  // Keep plugin-facing options separate from internal accessor-only controls.
  return {
    sessionKey: params.sessionKey,
    ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
    ...(params.env !== undefined ? { env: params.env } : {}),
    ...(params.hydrateSkillPromptRefs !== undefined
      ? { hydrateSkillPromptRefs: params.hydrateSkillPromptRefs }
      : {}),
    ...(params.readConsistency !== undefined ? { readConsistency: params.readConsistency } : {}),
    ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
  };
}

export function projectPluginSessionEntry(entry: InternalSessionEntry): SessionEntry {
  const publicEntry = projectPublicSessionEntry(entry);
  return {
    ...publicEntry,
    ...(entry.restartRecoveryRuns
      ? { restartRecoveryRuns: entry.restartRecoveryRuns.map((run) => ({ ...run })) }
      : {}),
  };
}

export function projectPluginSessionEntryPatch(
  patch: Partial<InternalSessionEntry>,
): Partial<SessionEntry> {
  return projectPublicSessionEntryPatch(patch);
}

export function generationValidPrivateFieldsForSameSession(
  existingEntry: InternalSessionEntry | undefined,
  nextSessionId: string | undefined,
  nextLifecycleRevision: string | undefined,
): Partial<InternalSessionEntry> | undefined {
  if (
    !existingEntry ||
    existingEntry.sessionId !== nextSessionId ||
    existingEntry.lifecycleRevision !== nextLifecycleRevision
  ) {
    return undefined;
  }
  const state: Partial<InternalSessionEntry> = {
    ...(existingEntry.modelSelectionRevision !== undefined
      ? { modelSelectionRevision: existingEntry.modelSelectionRevision }
      : {}),
    ...(existingEntry.continuationTurnRevision !== undefined
      ? { continuationTurnRevision: existingEntry.continuationTurnRevision }
      : {}),
    ...(existingEntry.continuationModelSelection
      ? { continuationModelSelection: existingEntry.continuationModelSelection }
      : {}),
    ...(existingEntry.cliHistoryBoundary
      ? { cliHistoryBoundary: existingEntry.cliHistoryBoundary }
      : {}),
    ...(existingEntry.activeWriterRunId !== undefined
      ? { activeWriterRunId: existingEntry.activeWriterRunId }
      : {}),
    ...(existingEntry.lifecycleRunId !== undefined
      ? { lifecycleRunId: existingEntry.lifecycleRunId }
      : {}),
    ...(existingEntry.pendingProjectGitUrl !== undefined
      ? { pendingProjectGitUrl: existingEntry.pendingProjectGitUrl }
      : {}),
    ...(existingEntry.transcriptByteCompactionLatch
      ? { transcriptByteCompactionLatch: existingEntry.transcriptByteCompactionLatch }
      : {}),
    ...(existingEntry.sessionDiffBaselineCapture
      ? { sessionDiffBaselineCapture: existingEntry.sessionDiffBaselineCapture }
      : {}),
    ...(existingEntry.mainRestartRecovery
      ? {
          abortedLastRun: existingEntry.abortedLastRun,
          restartRecoveryRuns: existingEntry.restartRecoveryRuns,
          mainRestartRecovery: existingEntry.mainRestartRecovery,
        }
      : {}),
  };
  return Object.keys(state).length > 0 ? state : undefined;
}

export function clearGenerationPrivateFieldsForRotatedSessionPatch(
  existingEntry: InternalSessionEntry,
  publicPatch: Partial<SessionEntry>,
): Partial<InternalSessionEntry> {
  return (Object.hasOwn(publicPatch, "sessionId") &&
    publicPatch.sessionId !== existingEntry.sessionId) ||
    (Object.hasOwn(publicPatch, "lifecycleRevision") &&
      publicPatch.lifecycleRevision !== existingEntry.lifecycleRevision)
    ? {
        ...publicPatch,
        ...SESSION_ENTRY_PRIVATE_CLEAR_PATCH,
        ...MAIN_SESSION_RECOVERY_CLEAR_PATCH,
      }
    : publicPatch;
}
