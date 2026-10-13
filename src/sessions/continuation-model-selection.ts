import { randomUUID } from "node:crypto";
import type { FastMode } from "@openclaw/normalization-core/string-coerce";
import type { PreparedAgentRunAdmission } from "../agents/admitted-run-context.js";
import type { ThinkLevel } from "../auto-reply/thinking.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";

/** Selected primary for one admitted logical turn, never a fallback candidate. */
export type ContinuationModelSelection = {
  runId: string;
  /** Successor custody is separate from the original turn correlation. */
  ownerRunId?: string;
  /** Channel source correlation can differ from the backend run identity. */
  sourceTurnId?: string;
  sessionId: string;
  lifecycleRevision?: string;
  modelSelectionRevision?: string;
  turnRevision?: string;
  parentSessionKey?: string;
  parentSessionId?: string;
  parentLifecycleRevision?: string;
  parentModelSelectionRevision?: string;
  provider: string;
  model: string;
  thinking?: ThinkLevel;
  fastMode?: FastMode;
  fallbacks?: string[];
};

export function resolveContinuationModelSelection(params: {
  selection?: ContinuationModelSelection;
  entry?: InternalSessionEntry;
  parentEntry?: InternalSessionEntry;
  sourceRunId?: string;
}): ContinuationModelSelection | undefined {
  const { selection, entry } = params;
  if (
    !selection ||
    !entry ||
    selection.sessionId !== entry.sessionId ||
    selection.lifecycleRevision !== entry.lifecycleRevision ||
    selection.modelSelectionRevision !== entry.modelSelectionRevision ||
    selection.turnRevision !== entry.continuationTurnRevision ||
    (params.sourceRunId !== undefined &&
      selection.runId !== params.sourceRunId &&
      selection.ownerRunId !== params.sourceRunId &&
      selection.sourceTurnId !== params.sourceRunId) ||
    (selection.parentSessionKey !== undefined &&
      (!params.parentEntry ||
        selection.parentSessionId !== params.parentEntry.sessionId ||
        selection.parentLifecycleRevision !== params.parentEntry.lifecycleRevision ||
        selection.parentModelSelectionRevision !== params.parentEntry.modelSelectionRevision))
  ) {
    return undefined;
  }
  return selection;
}

/** Admitted CLI turns may have no transcript writer; an existing foreign writer always rejects. */
export async function persistContinuationModelSelection(params: {
  agentId: string;
  sessionKey: string;
  storePath?: string;
  selection: ContinuationModelSelection;
  expectedWriterRunId: string;
  continuation?: boolean;
  assertCurrent: () => void;
}): Promise<InternalSessionEntry | undefined> {
  params.assertCurrent();
  let captured = false;
  const entry = await patchSessionEntryCore(
    { agentId: params.agentId, sessionKey: params.sessionKey, storePath: params.storePath },
    (current) => {
      if (
        current.sessionId !== params.selection.sessionId ||
        current.lifecycleRevision !== params.selection.lifecycleRevision ||
        current.modelSelectionRevision !== params.selection.modelSelectionRevision ||
        (params.continuation &&
          current.continuationTurnRevision !== params.selection.turnRevision) ||
        (current.activeWriterRunId !== undefined &&
          current.activeWriterRunId !== params.expectedWriterRunId)
      ) {
        throw new Error("Continuation selection no longer owns the admitted session");
      }
      captured = true;
      const turnRevision = params.continuation ? params.selection.turnRevision : randomUUID();
      const modelSelectionRevision = current.modelSelectionRevision ?? randomUUID();
      return {
        continuationTurnRevision: turnRevision,
        modelSelectionRevision,
        continuationModelSelection: {
          ...structuredClone(params.selection),
          turnRevision,
          modelSelectionRevision,
        },
      };
    },
    { assertCommitAllowed: params.assertCurrent, requireWriteSuccess: true, skipMaintenance: true },
  );
  params.assertCurrent();
  return captured ? (entry ?? undefined) : undefined;
}

/** Runtime admission, not queue preparation, owns the durable selection. */
export function withContinuationModelSelectionAdmission<T extends PreparedAgentRunAdmission>(
  admission: T,
  capture: () => Promise<void>,
): T {
  let captured: Promise<void> | undefined;
  return {
    ...admission,
    admit: async (...args) => {
      const context = await admission.admit(...args);
      await (captured ??= capture());
      admission.assertSourceCurrent();
      return context;
    },
  };
}

/** Late teardown cannot clear a newer admitted turn's selection. */
export async function clearContinuationModelSelection(params: {
  agentId: string;
  sessionKey: string;
  storePath?: string;
  runId: string;
  sessionId: string;
  assertCurrent: () => void;
}): Promise<void> {
  await patchSessionEntryCore(
    { agentId: params.agentId, sessionKey: params.sessionKey, storePath: params.storePath },
    (entry) =>
      entry.sessionId === params.sessionId &&
      (entry.continuationModelSelection?.ownerRunId ?? entry.continuationModelSelection?.runId) ===
        params.runId
        ? { continuationModelSelection: undefined }
        : null,
    { assertCommitAllowed: params.assertCurrent, skipMaintenance: true },
  );
}
