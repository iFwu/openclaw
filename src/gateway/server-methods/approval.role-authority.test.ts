import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as profileSelectionOwner from "../../state/user-channel-identity-operations.js";
import {
  ensureProfileForEmail,
  mergeProfiles,
  setUserProfileRole,
} from "../../state/user-profiles.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { invalidateOperatorRolePolicy } from "../operator-role-policy.js";
import { createApprovalRequestAuthority } from "./approval-request-authority.js";
import { createClient, createContext } from "./approval.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
beforeAll(async () => {
  state = await createOpenClawTestState({ label: "approval-profile-custody" });
});
beforeEach(() => state.applyEnv());
afterEach(() => vi.restoreAllMocks());
afterAll(async () => state.cleanup());

it.each([true, false])(
  "retains only related role changes during canonical preparation: %s",
  async (related) => {
    const reference = ensureProfileForEmail(`prepare-${related}-reference@example.test`);
    const principal = ensureProfileForEmail(`prepare-${related}-principal@example.test`);
    const other = ensureProfileForEmail(`prepare-${related}-other@example.test`);
    mergeProfiles(reference.id, principal.id);
    const client = createClient({ deviceId: "preparation-reviewer" });
    client.authenticatedUserProfile = {
      profileId: reference.id,
      displayName: null,
      hasAvatar: false,
      updatedAt: 1,
    };
    const parked = createDeferred();
    const release = createDeferred();
    const prepare = profileSelectionOwner.prepareUserProfileSelectionAuthority;
    vi.spyOn(profileSelectionOwner, "prepareUserProfileSelectionAuthority").mockImplementationOnce(
      async (...args) => {
        const selection = await prepare(...args);
        parked.resolve();
        await release.promise;
        return selection;
      },
    );
    const options = {
      req: { type: "req", id: "prepare-request", method: "plugin.approval.waitDecision" },
      client,
      context: createContext(),
    } as GatewayRequestHandlerOptions;
    const pending = createApprovalRequestAuthority(options);
    try {
      await parked.promise;
      const affected = related ? principal.id : other.id;
      setUserProfileRole(affected, "blocked");
      invalidateOperatorRolePolicy(affected);
      setUserProfileRole(affected, "approver");
      invalidateOperatorRolePolicy(affected);
      release.resolve();
      if (related) {
        await expect(pending).rejects.toThrow("scope_forbidden");
      } else {
        using authority = await pending;
        expect(() => authority.assertCurrent()).not.toThrow();
      }
    } finally {
      release.resolve();
      await pending.then(
        (authority) => authority[Symbol.dispose](),
        () => {},
      );
    }
  },
);

it.each(["other-role", "own-role", "own-role-restored", "other-merge", "own-merge"] as const)(
  "binds native approval to its own canonical principal: %s",
  async (change) => {
    const reference = ensureProfileForEmail(`${change}-reference@example.test`);
    const principal = ensureProfileForEmail(`${change}-principal@example.test`);
    const other = ensureProfileForEmail(`${change}-other@example.test`);
    const target = ensureProfileForEmail(`${change}-target@example.test`);
    setUserProfileRole(principal.id, "approver");
    mergeProfiles(reference.id, principal.id);
    const client = createClient({ deviceId: "role-reviewer", scopes: ["operator.approvals"] });
    client.authenticatedUserProfile = {
      profileId: reference.id,
      displayName: null,
      hasAvatar: false,
      updatedAt: 1,
    };
    client.preparedSessionProfile = {
      profileId: principal.id,
      aliases: new Set([reference.id, principal.id]),
      role: "approver",
    };
    const definition = (scopes: string[]) => ({
      agents: "*" as const,
      scopes,
      sessions: { others: "none" as const },
    });
    const config: OpenClawConfig = {
      gateway: {
        roles: {
          default: "blocked",
          definitions: {
            approver: definition(["operator.approvals"]),
            blocked: definition([]),
          },
        },
      },
    };
    const context = createContext();
    context.getRuntimeConfig = () => config;
    // Native compatibility has no router-selected profile binding; the profile owner must supply it.
    const options = {
      req: { type: "req", id: "profile-request", method: "plugin.approval.waitDecision" },
      client,
      context,
    } as GatewayRequestHandlerOptions;
    using authority = await createApprovalRequestAuthority(options);
    authority.setCheckpoint({ phase: "post-decision", approvalId: "plugin:profile-fixture" });
    authority.assertCurrent();
    if (change === "other-role" || change === "own-role" || change === "own-role-restored") {
      const profile = change === "other-role" ? other.id : principal.id;
      setUserProfileRole(profile, "blocked");
      invalidateOperatorRolePolicy(profile);
      if (change === "own-role-restored") {
        setUserProfileRole(profile, "approver");
        invalidateOperatorRolePolicy(profile);
      }
    } else {
      mergeProfiles(change === "other-merge" ? other.id : principal.id, target.id);
    }
    if (change === "own-role" || change === "own-role-restored") {
      expect(() => authority.assertCurrent()).toThrow("scope_forbidden");
    } else if (change === "own-merge") {
      expect(() => authority.assertCurrent()).toThrow("identity_changed");
      expect(context.logGateway.warn).toHaveBeenCalledWith(
        expect.stringContaining('"profileSelection"'),
      );
    } else {
      expect(() => authority.assertCurrent()).not.toThrow();
      expect(context.logGateway.warn).not.toHaveBeenCalled();
    }
  },
);
