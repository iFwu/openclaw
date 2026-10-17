/**
 * Runtime SDK subpath for model overrides and agent concurrency session helpers.
 */
import { adoptPersistedSessionSnapshot } from "../config/sessions/session-snapshot-merge.js";
import {
  applySessionModelSelectionInternal,
  type ApplySessionModelSelectionParams,
  type ApplySessionModelSelectionResult,
} from "../model-picker/apply-session-model-selection.js";
import {
  capturePluginModelSelectionSnapshot,
  projectPluginSessionEntry,
  restorePluginModelSelectionSnapshot,
} from "./session-store-runtime-internal.js";

export { resolveChannelModelOverride } from "../channels/model-overrides.js";
export { resolveAgentMaxConcurrent } from "../config/agent-limits.js";
export { resolvePersistedSessionRuntimeId } from "../agents/session-runtime-compat.js";
export { resolveSessionModelRef } from "../agents/session-model-ref.js";
export async function applySessionModelSelection(
  params: ApplySessionModelSelectionParams,
): Promise<ApplySessionModelSelectionResult> {
  if (!params.storePath) {
    return applySessionModelSelectionInternal(params);
  }
  // Restore the exact SDK read epoch before the core FIFO or metadata preparation can yield.
  const sessionEntry = restorePluginModelSelectionSnapshot(params.sessionEntry, params);
  if (!sessionEntry) {
    return {
      status: "conflict",
      message: "Model change was not applied because the session changed. Retry.",
    };
  }
  const sharedAtStart = { ...params.sessionStore };
  const localAtStart = { ...sharedAtStart, [params.sessionKey]: sessionEntry };
  const sessionStore = { ...localAtStart };
  try {
    return await applySessionModelSelectionInternal({ ...params, sessionEntry, sessionStore });
  } finally {
    for (const [key, entry] of Object.entries(sessionStore)) {
      if (entry === localAtStart[key] || params.sessionStore[key] !== sharedAtStart[key]) {
        continue;
      }
      const projected = projectPluginSessionEntry(entry);
      capturePluginModelSelectionSnapshot(entry, projected, { ...params, sessionKey: key });
      params.sessionStore[key] = projected;
      if (key === params.sessionKey) {
        adoptPersistedSessionSnapshot(params.sessionEntry, projected);
        capturePluginModelSelectionSnapshot(entry, params.sessionEntry, params);
      }
    }
  }
}
export type {
  ApplySessionModelSelectionParams,
  ApplySessionModelSelectionResult,
  SessionModelSelectionRequest,
} from "../model-picker/apply-session-model-selection.js";
export {
  applyModelOverrideToSessionEntry,
  isModelSelectionLocked,
  MODEL_SELECTION_LOCKED_MESSAGE,
  ModelSelectionLockedError,
} from "../sessions/model-overrides.js";
export { applyModelOverrideWithAuthProfileCompatibility } from "../sessions/auth-profile-preservation.js";
