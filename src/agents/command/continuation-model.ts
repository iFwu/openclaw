import { applyModelRuntimeDirective } from "../../auto-reply/reply/directive-handling.model-runtime.js";
import { normalizeThinkLevel, type ThinkLevel } from "../../auto-reply/thinking.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import {
  resolveContinuationModelSelection,
  persistContinuationModelSelection,
  withContinuationModelSelectionAdmission,
  type ContinuationModelSelection,
} from "../../sessions/continuation-model-selection.js";
import {
  isModelSelectionLocked,
  ModelSelectionLockedError,
} from "../../sessions/model-overrides.js";
import {
  resolveDirectStoredModelOverride,
  resolveStoredModelParentSessionKey,
} from "../../sessions/stored-model-overrides.js";
import { assertOperatorModelAllowed } from "../admitted-run-context.js";
import { resolveAgentConfig } from "../agent-scope.js";
import { isHeartbeatLifecycleRunKind } from "../bootstrap-mode.js";
import { resolveFastModeState } from "../fast-mode.js";
import type { LiveSessionModelSwitchError } from "../live-model-switch-error.js";
import type { ModelManifestNormalizationContext } from "../model-ref-shared.js";
import {
  createModelVisibilityPolicy,
  type ModelVisibilityPolicy,
} from "../model-visibility-policy.js";
import { isNativeCompletionOwnerForRun } from "../subagents/announce/subagent-announce-handoff.js";
import type { RunEmbeddedAgentAttemptParams } from "./run-embedded-attempt.types.js";
import type { AgentCommandOpts } from "./types.js";

type CommandModelContext = {
  opts: AgentCommandOpts;
  sessionKey?: string;
  sessionEntry?: InternalSessionEntry;
  sessionStore?: Record<string, InternalSessionEntry>;
  storePath: string;
  sessionAgentId: string;
};

export async function resolveCommandModelParent(
  params: CommandModelContext & {
    defaultProvider: string;
    pluginsEnabled: boolean;
    modelManifestContext: ModelManifestNormalizationContext;
    hasLegacyAutoFallbackOverrideWithoutOrigin: boolean;
  },
) {
  const { sessionEntry } = params;
  const key =
    sessionEntry?.continuationModelSelection?.parentSessionKey ??
    params.opts.trustedInternalHandoff?.modelSelection?.parentSessionKey ??
    (!params.hasLegacyAutoFallbackOverrideWithoutOrigin &&
    sessionEntry?.modelOverrideSource !== "default" &&
    !resolveDirectStoredModelOverride({
      sessionEntry,
      defaultProvider: params.defaultProvider,
      allowPluginNormalization: params.pluginsEnabled,
      ...params.modelManifestContext,
    })
      ? resolveStoredModelParentSessionKey({
          sessionKey: params.sessionKey,
          parentSessionKey: sessionEntry?.parentSessionKey,
        })
      : null);
  let entry = key ? params.sessionStore?.[key] : undefined;
  if (key && !entry) {
    entry = await withSessionEntryReadOnlyInWorker(
      { agentId: params.sessionAgentId, sessionKey: key, storePath: params.storePath },
      () => {
        params.opts.abortSignal?.throwIfAborted();
        params.opts.assertSourceCurrent?.();
        params.opts.operatorAuthority?.assertCurrent();
      },
      async (read) => {
        if (!read.ok) throw read.error;
        return read.value;
      },
    );
  }
  return { key, entry };
}

export function resolveCommandContinuationSelection(params: {
  opts: AgentCommandOpts;
  entry?: InternalSessionEntry;
  parentEntry?: InternalSessionEntry;
  sessionKey?: string;
  sessionId: string;
  hasExplicitRunOverride: boolean;
  provider: string;
  model: string;
  visibilityPolicy: ModelVisibilityPolicy;
}) {
  const handoff = params.opts.trustedInternalHandoff;
  const nativeCompletion = isNativeCompletionOwnerForRun({
    handoff,
    inputProvenance: params.opts.inputProvenance,
    internalEvents: params.opts.internalEvents,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    provider: handoff?.provider,
    model: handoff?.model,
  });
  const selection = !params.hasExplicitRunOverride
    ? resolveContinuationModelSelection({
        selection: nativeCompletion
          ? handoff?.modelSelection
          : params.opts.mainRestartRecoveryAdmitted
            ? params.entry?.continuationModelSelection
            : undefined,
        entry: params.entry,
        parentEntry: params.parentEntry,
        sourceRunId: params.opts.mainRestartRecoveryAdmitted
          ? params.entry?.restartRecoveryDeliverySourceRunId
          : undefined,
      })
    : undefined;
  if (selection) {
    if (
      isModelSelectionLocked(params.entry) &&
      (selection.provider !== params.provider || selection.model !== params.model)
    )
      throw new ModelSelectionLockedError();
    assertOperatorModelAllowed(params.opts.operatorAuthority, selection);
    if (!params.visibilityPolicy.allows(selection))
      throw new Error(
        "The interrupted turn's model is no longer allowed. Select a permitted model to continue.",
      );
    // Keep the redeemed object and its private approval/source owner bound to the validated primary.
    if (nativeCompletion && handoff) {
      handoff.provider = selection.provider;
      handoff.model = selection.model;
    }
  }
  return selection;
}

export function prepareCommandContinuationAdmission(
  command: RunEmbeddedAgentAttemptParams,
  state: {
    entry?: InternalSessionEntry;
    provider: string;
    model: string;
    getThinking: () => ThinkLevel;
    fallbacks?: string[];
    selection?: ContinuationModelSelection;
    getLifecycleGeneration: () => string;
    onSaved: (entry: InternalSessionEntry) => void;
  },
) {
  const { sessionKey, storePath, sessionAgentId, runId, cfg } = command.prepared;
  const entry = state.entry;
  if (
    !sessionKey ||
    !entry ||
    command.suppressVisibleSessionEffects ||
    (command.preserveUserFacingSessionModelState &&
      !command.modelSelection.continuationSelection) ||
    isHeartbeatLifecycleRunKind(command.opts.bootstrapContextRunKind)
  )
    return command.preparedRunAdmission;
  const params = {
    ...state,
    entry,
    sessionKey,
    storePath,
    agentId: sessionAgentId,
    runId,
    cfg,
    admission: command.preparedRunAdmission,
    opts: command.opts,
    parent: command.modelSelection.modelSelectionParent,
    assertCurrent: () => {
      command.opts.abortSignal?.throwIfAborted();
      command.opts.assertSourceCurrent?.();
      command.opts.operatorAuthority?.assertCurrent();
      assertAgentRunLifecycleGenerationCurrent(state.getLifecycleGeneration());
    },
  };
  return withContinuationModelSelectionAdmission(params.admission, async () => {
    const { selection, entry, parent } = params;
    const saved = await persistContinuationModelSelection({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      expectedWriterRunId: params.runId,
      continuation: Boolean(selection),
      selection: {
        ...selection,
        runId: selection?.runId ?? params.runId,
        ownerRunId: params.runId,
        sourceTurnId: selection?.sourceTurnId ?? entry.restartRecoveryDeliverySourceRunId,
        sessionId: entry.sessionId,
        lifecycleRevision: entry.lifecycleRevision,
        modelSelectionRevision: entry.modelSelectionRevision,
        ...(parent?.entry
          ? {
              parentSessionKey: parent.key,
              parentSessionId: parent.entry.sessionId,
              parentLifecycleRevision: parent.entry.lifecycleRevision,
              parentModelSelectionRevision: parent.entry.modelSelectionRevision,
            }
          : {}),
        provider: params.provider,
        model: params.model,
        thinking: params.getThinking(),
        fastMode:
          params.opts.fastMode ??
          selection?.fastMode ??
          resolveFastModeState({
            cfg: params.cfg,
            provider: params.provider,
            model: params.model,
            agentId: params.agentId,
            sessionEntry: entry,
          }).mode,
        fallbacks: params.fallbacks,
      },
      assertCurrent: params.assertCurrent,
    });
    if (saved) params.onSaved(saved);
  });
}

export async function refreshCommandLiveModelSelection(
  command: RunEmbeddedAgentAttemptParams,
  sessionEntry: InternalSessionEntry | undefined,
  selection: LiveSessionModelSwitchError,
) {
  const params = {
    ...command.prepared,
    ...command.modelSelection,
    opts: command.opts,
    sessionEntry,
    provider: selection.provider,
    model: selection.model,
    catalog: command.modelSelection.thinkingCatalog,
  };
  assertOperatorModelAllowed(params.opts.operatorAuthority, params);
  const visibility = createModelVisibilityPolicy({
    cfg: params.cfg,
    catalog: params.catalog ?? [],
    agentId: params.sessionAgentId,
    defaultProvider: params.defaultProvider,
    defaultModel: { provider: params.defaultProvider, model: params.defaultModel },
    ...params.modelManifestContext,
  });
  if (!visibility.allows(params)) throw new Error("The selected model is no longer allowed.");
  const handoff = params.opts.trustedInternalHandoff;
  if (
    handoff &&
    isNativeCompletionOwnerForRun({
      handoff,
      inputProvenance: params.opts.inputProvenance,
      internalEvents: params.opts.internalEvents,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      provider: handoff.provider,
      model: handoff.model,
    })
  ) {
    handoff.provider = params.provider;
    handoff.model = params.model;
  }
  if (!params.sessionKey || !params.sessionEntry) return params.sessionEntry;
  const fresh = await withSessionEntryReadOnlyInWorker(
    { agentId: params.sessionAgentId, sessionKey: params.sessionKey, storePath: params.storePath },
    () => {
      params.opts.abortSignal?.throwIfAborted();
      params.opts.assertSourceCurrent?.();
      params.opts.operatorAuthority?.assertCurrent();
    },
    async (read) => {
      if (!read.ok) throw read.error;
      return read.value;
    },
  );
  if (!fresh || fresh.sessionId !== params.sessionEntry.sessionId)
    throw new Error("Live model switch session changed");
  if (params.sessionStore) params.sessionStore[params.sessionKey] = fresh;
  const next = { ...fresh };
  applyModelRuntimeDirective(
    next,
    selection.agentRuntimeOverride
      ? { kind: "set", runtime: selection.agentRuntimeOverride }
      : { kind: "clear" },
  );
  next.authProfileOverride = selection.authProfileId;
  next.authProfileOverrideSource = selection.authProfileId
    ? selection.authProfileIdSource
    : undefined;
  next.authProfileOverrideCompactionCount = undefined;
  return next;
}

export function resolveCommandContinuationThinking(
  params: {
    cfg: OpenClawConfig;
    sessionAgentId: string;
    thinkOnce?: ThinkLevel;
    thinkOverride?: ThinkLevel;
    requestedThinkLevel?: ThinkLevel;
  },
  selection: ContinuationModelSelection | undefined,
) {
  return (
    params.thinkOnce ??
    params.thinkOverride ??
    selection?.thinking ??
    params.requestedThinkLevel ??
    normalizeThinkLevel(resolveAgentConfig(params.cfg, params.sessionAgentId)?.thinkingDefault)
  );
}
