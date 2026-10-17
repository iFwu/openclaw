import { expectDefined } from "@openclaw/normalization-core/expect";
import type { SessionsPatchParams } from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import type { SessionEntryCommitContext } from "../../config/sessions/session-accessor.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { disableCronJobsBoundToSessions } from "../../cron/job-session-bindings.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { rememberTelegramDmModelSelection } from "../../sessions/telegram-dm-model-selection.js";
import {
  isAgentSessionModelPatchOrigin,
  isSessionStatusModelPatchOrigin,
} from "../session-model-patch-origin.js";
import { triggerSessionPatchHook } from "../session-patch-hooks.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { registerCommittedSessionCategory } from "./session-create-category.js";
import { persistSessionPatchModelSelection } from "./sessions-patch-model-selection.js";
import type {
  GroupAdmissionResult,
  PreparedPatchTarget,
  MutationOutcome,
  MutationTarget,
} from "./sessions-patch-types.js";
import { sessionLog } from "./sessions-shared.js";
import type { GatewayRequestContext } from "./types.js";

/** Publish committed patch effects even when active-runtime application later reports an error. */
export async function publishSessionPatchEffects(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  callerScopes: readonly string[];
  callerCanManageCron: boolean;
  targets: readonly PreparedPatchTarget[];
  outcomes: readonly (MutationOutcome | undefined)[];
  operatorAuthority?: { assertCurrent: () => void };
  mutationTargets: readonly MutationTarget[];
  storage: ReadonlyMap<number, { assertCurrent: () => void }>;
}): Promise<void> {
  const archivedSessionKeys = new Set<string>();
  for (const target of params.targets) {
    const outcome = params.outcomes[target.index];
    if (!outcome?.ok || !outcome.applied) {
      continue;
    }
    const { entry, accessChanged } = outcome;
    const assertCurrent = () => {
      params.operatorAuthority?.assertCurrent();
      const guard = expectDefined(
        params.mutationTargets[target.index],
        "patch authority",
      ).commitGuard;
      const error = guard();
      if (error) {
        throw new SessionMutationAuthorizationChangedError(error);
      }
      params.storage.get(target.index)?.assertCurrent();
    };
    triggerSessionPatchHook({
      cfg: params.cfg,
      sessionEntry: entry,
      sessionKey: target.canonicalKey,
      patch: target.fullPatch,
    });
    persistSessionPatchModelSelection({
      cfg: params.cfg,
      callerScopes: params.callerScopes,
      entry,
      patch: target.fullPatch,
      sessionKey: target.canonicalKey,
      targetAgentId: target.targetAgentId,
    });
    emitSessionsChanged(
      params.context,
      {
        sessionKey: target.canonicalKey,
        ...(target.requestedAgentId ? { agentId: target.requestedAgentId } : {}),
        reason: "patch",
        ...(target.fullPatch.model !== undefined || target.fullPatch.agentRuntime !== undefined
          ? { catalogChanged: true }
          : {}),
      },
      { accessChanged },
    );
    if (
      params.callerScopes.includes("operator.admin") &&
      target.fullPatch.model !== undefined &&
      target.fullPatch.modelSelectionScope !== "session" &&
      !isAgentSessionModelPatchOrigin() &&
      !isSessionStatusModelPatchOrigin()
    ) {
      await rememberTelegramDmModelSelection({
        agentId: target.targetAgentId,
        sessionKey: target.canonicalKey,
        storePath: target.storePath,
        assertCurrent,
        selection: {
          ...resolveSessionModelRef(params.cfg, entry, target.targetAgentId),
          isDefault: entry.modelOverrideSource === "default",
        },
      });
    }
    if (typeof target.fullPatch.archived === "boolean") {
      params.context.sessionActivitySummaries?.handleLifecycle({
        sessionKey: target.canonicalKey,
        agentId: target.targetAgentId,
        reason: target.fullPatch.archived ? "archive" : "unarchive",
      });
    }
    if (target.fullPatch.archived === true) {
      archivedSessionKeys.add(target.canonicalKey);
    }
  }

  if (params.callerCanManageCron && archivedSessionKeys.size > 0) {
    try {
      const disabledBySession = await disableCronJobsBoundToSessions({
        cron: params.context.cron,
        cfg: params.cfg,
        sessionKeys: [...archivedSessionKeys],
      });
      for (const [sessionKey, disabledJobIds] of disabledBySession) {
        if (disabledJobIds.length > 0) {
          sessionLog.info(
            `sessions.patch: disabled cron jobs bound to archived session ${sessionKey}: ${disabledJobIds.join(", ")}`,
          );
        }
      }
    } catch (error) {
      sessionLog.warn(
        `sessions.patch: failed to disable cron jobs for archived sessions: ${formatErrorMessage(error)}`,
      );
    }
  }
}

/** Only applied assignments may repair the catalog; detached and status-model no-ops cannot. */
export function createSessionPatchCategoryRegistration(params: {
  patch: { category?: SessionsPatchParams["category"] };
  context: GatewayRequestContext;
}) {
  const category = params.patch.category;
  return async (result: GroupAdmissionResult, source: SessionEntryCommitContext): Promise<void> => {
    if (
      typeof category === "string" &&
      result.kind === "complete" &&
      result.outcomes.some(
        (outcome) => outcome.ok && outcome.applied && outcome.entry.category === category.trim(),
      )
    ) {
      await registerCommittedSessionCategory(category, params.context, source);
    }
  };
}
