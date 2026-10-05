import type { WorkboardClaim } from "@openclaw/workboard-contract";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { WorkboardMutationScope } from "./store-inputs.js";

/** Pure claim fencing; persistence and association normalization stay with the caller. */
export function assertWorkboardClaimScope(
  claim: WorkboardClaim | undefined,
  scope: WorkboardMutationScope,
  association: { sessionKey?: string; runId?: string },
) {
  const captured = scope.capturedClaim;
  if (
    captured &&
    (!claim ||
      !safeEqualSecret(captured.token, claim.token) ||
      captured.sessionKey !== association.sessionKey ||
      captured.runId !== association.runId)
  ) {
    throw new Error("Workboard claim or execution changed before mutation.");
  }
  if (!claim) {
    return;
  }
  const ownerId = normalizeOptionalString(scope.ownerId);
  const token = normalizeOptionalString(scope.token);
  if (claim.ownerId !== ownerId && !safeEqualSecret(token, claim.token)) {
    throw new Error(`card is claimed by ${claim.ownerId}.`);
  }
}
