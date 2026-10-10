import type { ReplyBackendCancelReason } from "../../../auto-reply/reply/reply-run-registry.contracts.js";
import { createApprovalDeniedAbortError } from "../../approval-denied-abort.js";
import {
  createAgentRunRestartAbortError,
  createAgentRunSupersededAbortError,
} from "../../run-termination.js";

/** Preserve cancellation classification; only cooperative supersession skips interruption guidance. */
export function createAttemptStreamAbortReason(
  reason: ReplyBackendCancelReason | undefined,
  turnHandoff: boolean,
): Error | undefined {
  if (reason === "approval-denied") {
    return createApprovalDeniedAbortError();
  }
  if (reason === "restart") {
    return createAgentRunRestartAbortError();
  }
  if (reason === "superseded") {
    const error = createAgentRunSupersededAbortError();
    return turnHandoff ? Object.assign(error, { turnHandoff: true }) : error;
  }
  return undefined;
}
