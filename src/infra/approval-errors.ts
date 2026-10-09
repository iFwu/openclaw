// Detects approval-not-found errors across gateway response shapes.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

export type ApprovalAuthorityFailure =
  | "authority_closed"
  | "scope_forbidden"
  | "requester_invalidated"
  | "identity_changed"
  | "context_changed"
  | "config_policy_revoked"
  | "access_revision_changed";

export type ApprovalAuthorityCheckpoint = {
  approvalId?: string;
  phase: "authority-check" | "snapshot" | "post-decision" | "terminal-snapshot";
};

export class ApprovalRequesterAuthorityChangedError extends Error {
  readonly details;

  constructor(
    failures: readonly ApprovalAuthorityFailure[],
    checkpoint: ApprovalAuthorityCheckpoint,
    accessRevision: {
      captured: { gateway: number; profileAlias: number };
      current: { gateway: number; profileAlias: number };
    },
    changedFields: readonly string[] = [],
  ) {
    super(`Approval requester authority changed (${failures.join(", ")})`);
    this.name = "ApprovalRequesterAuthorityChangedError";
    this.details = {
      reason: "APPROVAL_REQUESTER_AUTHORITY_CHANGED" as const,
      failures,
      ...checkpoint,
      accessRevision,
      changedFields,
    };
  }
}

export function isApprovalRequesterAuthorityChangedError(err: unknown): boolean {
  return (
    err instanceof ApprovalRequesterAuthorityChangedError ||
    (err instanceof Error &&
      readApprovalErrorDetailsReason((err as { details?: unknown }).details) ===
        "APPROVAL_REQUESTER_AUTHORITY_CHANGED")
  );
}

const INVALID_REQUEST = "INVALID_REQUEST";
const APPROVAL_NOT_FOUND = "APPROVAL_NOT_FOUND";
const APPROVAL_ALREADY_RESOLVED = "APPROVAL_ALREADY_RESOLVED";
const LEGACY_APPROVAL_NOT_FOUND_RE =
  /\b(?:unknown or expired approval id|approval expired or not found)\b/i;

function readErrorCode(value: unknown): string | null {
  return typeof value === "string" ? (normalizeOptionalString(value) ?? null) : null;
}

function readApprovalErrorDetailsReason(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const reason = (value as { reason?: unknown }).reason;
  return typeof reason === "string" ? (normalizeOptionalString(reason) ?? null) : null;
}

/**
 * Detects approval-not-found failures across gateway error shapes.
 * Kept broad enough for legacy message-only errors emitted before structured codes.
 */
export function isApprovalNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const gatewayCode = readErrorCode((err as { gatewayCode?: unknown }).gatewayCode);
  if (gatewayCode === APPROVAL_NOT_FOUND) {
    return true;
  }
  const detailsReason = readApprovalErrorDetailsReason((err as { details?: unknown }).details);
  if (gatewayCode === INVALID_REQUEST && detailsReason === APPROVAL_NOT_FOUND) {
    return true;
  }
  return LEGACY_APPROVAL_NOT_FOUND_RE.test(err.message);
}

/** Detects approval failures that mean a pending prompt is no longer actionable. */
export function isApprovalStaleError(err: unknown): boolean {
  if (isApprovalNotFoundError(err)) {
    return true;
  }
  if (!(err instanceof Error)) {
    return false;
  }
  const gatewayCode = readErrorCode((err as { gatewayCode?: unknown }).gatewayCode);
  const detailsReason = readApprovalErrorDetailsReason((err as { details?: unknown }).details);
  return (
    (gatewayCode === INVALID_REQUEST && detailsReason === APPROVAL_ALREADY_RESOLVED) ||
    /approval already resolved/i.test(err.message)
  );
}
