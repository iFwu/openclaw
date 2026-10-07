import type { SessionOrigin } from "../config/sessions/types.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../utils/message-channel.js";
import {
  getAdmittedRunDelegatedAuthority,
  type AdmittedRunContext,
} from "./admitted-run-context.js";

export type ApprovalOrigin = Readonly<{
  turnSourceChannel?: string;
  turnSourceLocal?: true;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
}>;
const origins = new WeakMap<
  AdmittedRunContext,
  { origin: ApprovalOrigin; assertCurrent: () => void }
>();

export function captureApprovalOrigin(
  origin: SessionOrigin | undefined,
): ApprovalOrigin | undefined {
  const channel = normalizeMessageChannel(origin?.provider);
  const to = origin?.to?.trim();
  if (!channel || channel === INTERNAL_MESSAGE_CHANNEL || !to) {
    return undefined;
  }
  return Object.freeze({
    turnSourceChannel: channel,
    turnSourceTo: to,
    ...(origin?.accountId?.trim() ? { turnSourceAccountId: origin.accountId.trim() } : {}),
    ...(origin?.threadId != null ? { turnSourceThreadId: origin.threadId } : {}),
  });
}

/** Only the host admission owner may attach a target's immutable approval route. */
export function bindAdmittedRunApprovalOrigin(
  context: AdmittedRunContext,
  origin: ApprovalOrigin,
  assertCurrent: () => void,
): void {
  assertCurrent();
  if (!getAdmittedRunDelegatedAuthority(context)) {
    throw new Error("Approval origin requires an active admitted run");
  }
  if (origins.has(context)) {
    throw new Error("Admitted approval origin is already bound");
  }
  origins.set(context, { origin, assertCurrent });
}

export function readAdmittedRunApprovalOrigin(
  context: AdmittedRunContext,
): ApprovalOrigin | undefined {
  const binding = origins.get(context);
  if (!binding || !getAdmittedRunDelegatedAuthority(context)) {
    return undefined;
  }
  binding.assertCurrent();
  return binding.origin;
}
