import { isDeepStrictEqual } from "node:util";
import {
  listAgentIds,
  tryResolveLegacyCompatibilityAgentId,
} from "../../agents/agent-scope-config.js";
import { resolveSessionStoreCompatibilityAgentId } from "../../config/legacy.default-agent-owner.js";
import { resolveSessionRoutingContract } from "../../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { isPerAgentSessionStoreConfig } from "../../config/sessions/session-store-config.js";
import { resolvePersistedSessionStoreOwner } from "../../config/sessions/session-store-owner.js";
import { listConfiguredSessionStoreAgentIds } from "../../config/sessions/targets-configured-agents.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  ApprovalRequesterAuthorityChangedError,
  type ApprovalAuthorityCheckpoint,
  type ApprovalAuthorityFailure,
} from "../../infra/approval-errors.js";
import { prepareUserProfileSelectionAuthority } from "../../state/user-channel-identity-operations.js";
import { captureGatewayAuthPolicy, isGatewayAuthPolicyCurrent } from "../auth-policy.js";
import { readGatewayAccessRevisionState } from "../gateway-access-revision.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import {
  canResolveOperatorApproval,
  canReviewOperatorApproval,
} from "../operator-approval-authorization.js";
import type { OperatorApprovalStoreGuard } from "../operator-approval-store.types.js";
import {
  onOperatorRolePolicyChanged,
  resolveGatewayOperatorRoleActor,
} from "../operator-role-policy.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** Pure policy/locator facts used by approval visibility; no row or registry discovery. */
function captureApprovalConfigPolicy(config: OpenClawConfig) {
  const agents = listAgentIds(config).toSorted();
  const configuredStores = listConfiguredSessionStoreAgentIds(config).toSorted();
  const compatibilityAgent = resolveSessionStoreCompatibilityAgentId(config);
  const storeAgents = [...new Set([...configuredStores, compatibilityAgent])].toSorted();
  return {
    routing: resolveSessionRoutingContract(config),
    storeOwner: resolvePersistedSessionStoreOwner(config),
    compatibilityAgent,
    legacyAgent: tryResolveLegacyCompatibilityAgentId(config),
    agents,
    configuredStores,
    perAgentStore: isPerAgentSessionStoreConfig(config.session?.store),
    stores: storeAgents.map((agentId) => ({
      agentId,
      path: resolveSessionStorePathCore(config.session?.store, { agentId }),
    })),
  };
}

/** Retain the original invocation; copying options loses its request-owner binding. */
export async function createApprovalRequestAuthority(options: GatewayRequestHandlerOptions) {
  const authority = readGatewayRequestMutationAuthority(options);
  const { client } = options;
  const method = options.req.method;
  const profileId = client?.authenticatedUserProfile?.profileId;
  const userId = client?.authenticatedUserId;
  const canonicalProfileId = client?.preparedSessionProfile?.profileId;
  const role = client?.connect.role;
  const deviceId = client?.connect.device?.id;
  const approvalRuntime = client?.internal?.approvalRuntime;
  const runtimeIdentity = client?.internal?.agentRuntimeIdentity;
  const actor = resolveGatewayOperatorRoleActor(client);
  const actorKind = actor?.kind;
  const actorProfileId = actor?.kind === "operator" ? actor.profileId : undefined;
  const readRuntimeConfig = options.context.getRuntimeConfig;
  const readCommittedConfig = options.context.getCommittedRuntimeConfig;
  const resolveGatewayContext = options.context.resolveGatewayContext;
  const gatewayContext = resolveGatewayContext?.() ?? options.context;
  const getConfig = readCommittedConfig ?? readRuntimeConfig;
  const config = getConfig();
  const authPolicy = client?.authPolicy ?? captureGatewayAuthPolicy(config, null);
  const configPolicy = captureApprovalConfigPolicy(config);
  const accessRevision = readGatewayAccessRevisionState();
  let checkpoint: ApprovalAuthorityCheckpoint = { phase: "authority-check" };
  let failureLogged = false;
  const profileSelectionReference =
    (!authority.expectedProfileBinding || !canonicalProfileId) &&
    !client?.internal?.operatorRunAuthority
      ? profileId
      : undefined;
  let profileSelection: Awaited<ReturnType<typeof prepareUserProfileSelectionAuthority>>;
  let preparingRoleAssignments = profileSelectionReference ? new Set<string>() : undefined;
  let configRevoked = false;
  let roleRevoked = false;
  let closed = false;
  const releaseConfig = onOperatorRolePolicyChanged((change) => {
    if (change.kind === "assignment") {
      preparingRoleAssignments?.add(change.profileId);
      if (
        [profileId, actorProfileId, canonicalProfileId, profileSelection?.profileId].includes(
          change.profileId,
        )
      ) {
        // An assigned-role transition retires this principal's old grant, including revoke/restore.
        roleRevoked = true;
      }
      return;
    }
    if (change.context !== gatewayContext || configRevoked) {
      return;
    }
    try {
      // Observe every committed transition, including revoke/restore between two checks.
      const current = getConfig();
      configRevoked =
        !isGatewayAuthPolicyCurrent(authPolicy, current) ||
        !isDeepStrictEqual(configPolicy, captureApprovalConfigPolicy(current));
    } catch {
      configRevoked = true;
    }
  });
  const assertPolicyCurrent = () => {
    const currentActor = resolveGatewayOperatorRoleActor(client);
    const legacy = method.startsWith("exec.approval.") || method.startsWith("plugin.approval.");
    const allowed = legacy
      ? authority.family === "native-compatibility" ||
        authorizeOperatorScopesForMethod(method, client?.connect.scopes ?? []).allowed
      : method === "approval.resolve"
        ? canResolveOperatorApproval(client)
        : method === "approval.history"
          ? authorizeOperatorScopesForMethod(method, client?.connect.scopes ?? []).allowed
          : canReviewOperatorApproval(client);
    const currentRevision = readGatewayAccessRevisionState();
    // Global access revisions refresh discovery; only this request's authority can revoke approval.
    const failure: { reason: ApprovalAuthorityFailure; field?: string } | false | undefined =
      (closed && { reason: "authority_closed" }) ||
      ((!allowed || roleRevoked) && { reason: "scope_forbidden" }) ||
      (client?.invalidated && { reason: "requester_invalidated" }) ||
      (client?.connect.role !== role && { reason: "identity_changed", field: "role" }) ||
      (client?.connect.device?.id !== deviceId && {
        reason: "identity_changed",
        field: "device",
      }) ||
      (client?.internal?.approvalRuntime !== approvalRuntime && {
        reason: "identity_changed",
        field: "approvalRuntime",
      }) ||
      (client?.internal?.agentRuntimeIdentity !== runtimeIdentity && {
        reason: "identity_changed",
        field: "runtimeIdentity",
      }) ||
      (currentActor?.kind !== actorKind && { reason: "identity_changed", field: "actorKind" }) ||
      ((currentActor?.kind === "operator" ? currentActor.profileId : undefined) !==
        actorProfileId && { reason: "identity_changed", field: "actorProfile" }) ||
      (client?.authenticatedUserProfile?.profileId !== profileId && {
        reason: "identity_changed",
        field: "profile",
      }) ||
      (client?.authenticatedUserId !== userId && { reason: "identity_changed", field: "user" }) ||
      (client?.preparedSessionProfile?.profileId !== canonicalProfileId && {
        reason: "identity_changed",
        field: "canonicalProfile",
      }) ||
      (profileSelection &&
        !profileSelection.isCurrent() && {
          reason: "identity_changed",
          field: "profileSelection",
        }) ||
      (options.context.getRuntimeConfig !== readRuntimeConfig && {
        reason: "context_changed",
        field: "runtimeConfigReader",
      }) ||
      (options.context.getCommittedRuntimeConfig !== readCommittedConfig && {
        reason: "context_changed",
        field: "committedConfigReader",
      }) ||
      (options.context.resolveGatewayContext !== resolveGatewayContext && {
        reason: "context_changed",
        field: "contextResolver",
      }) ||
      ((resolveGatewayContext?.() ?? options.context) !== gatewayContext && {
        reason: "context_changed",
        field: "gatewayContext",
      }) ||
      (configRevoked && { reason: "config_policy_revoked" });
    if (failure) {
      const error = new ApprovalRequesterAuthorityChangedError(
        [failure.reason],
        checkpoint,
        {
          captured: accessRevision,
          current: currentRevision,
        },
        failure.field ? [failure.field] : [],
      );
      if (!failureLogged) {
        failureLogged = true;
        options.context.logGateway.warn(
          `approval requester authority changed ${JSON.stringify({ method, ...error.details })}`,
        );
      }
      throw error;
    }
  };
  const setCheckpoint = (at: ApprovalAuthorityCheckpoint) => {
    checkpoint = at;
  };
  const assertCurrent = () => {
    authority.assertCurrent();
    authority.assertOperatorCurrent?.();
    authority.expectedProfileBinding?.assertCurrent();
    assertPolicyCurrent();
  };
  const guard: OperatorApprovalStoreGuard = {
    family: authority.family,
    assertCurrent:
      authority.family === "native-compatibility"
        ? assertCurrent
        : () => {
            authority.assertWorkerCurrent();
            authority.assertOperatorCurrent?.();
            authority.expectedProfileBinding?.assertCurrent();
            assertPolicyCurrent();
          },
  };
  try {
    if (profileSelectionReference) {
      assertCurrent();
      profileSelection = await prepareUserProfileSelectionAuthority(profileSelectionReference);
      if (profileSelection && preparingRoleAssignments?.has(profileSelection.profileId)) {
        roleRevoked = true;
      }
      preparingRoleAssignments = undefined;
      assertCurrent();
      if (
        !profileSelection ||
        (canonicalProfileId && profileSelection.profileId !== canonicalProfileId)
      ) {
        throw new Error("Gateway requester profile changed or is unavailable");
      }
    }
  } catch (error) {
    closed = true;
    releaseConfig();
    throw error;
  }
  return {
    guard,
    setCheckpoint,
    assertCurrent,
    assertCommitCurrent: guard.assertCurrent,
    isCurrent: () => {
      try {
        assertCurrent();
        return true;
      } catch {
        return false;
      }
    },
    [Symbol.dispose]() {
      closed = true;
      releaseConfig();
    },
  };
}

export type ApprovalRequestAuthority = Awaited<ReturnType<typeof createApprovalRequestAuthority>>;
