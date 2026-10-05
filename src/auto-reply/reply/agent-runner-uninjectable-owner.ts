import { assertAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { captureEmbeddedVisibleTurnOwner } from "../../agents/embedded-agent-runner/runs.js";
import { operatorScopeSatisfied } from "../../shared/operator-scope-compat.js";
import { getCommandOwnerAuthority } from "../command-owner-authority.js";
import type { RunReplyAgentParams } from "./agent-runner-core.js";
import { resolveFollowupAbortSignal, type FollowupRun } from "./queue.js";

const UNINJECTABLE_OWNER_GRACE_MS = 5_000;

/** Consumer of a producer-owned native preemption capability, never generic Stop.
 * This connects bounded grace only. Registry end is not certified physical cleanup;
 * source/delivery/actual writer-release obligations remain with the native producer.
 */
export function captureUninjectableOwnerGrace(params: {
  sessionId: string;
  sessionKey: string;
  followupRun: FollowupRun;
  sessionCtx: RunReplyAgentParams["sessionCtx"];
}): (() => Promise<void>) | undefined {
  const input = params.followupRun;
  const kind = input.run.inputProvenance?.kind;
  const source = getCommandOwnerAuthority(params.sessionCtx);
  const authority = input.operatorAuthority;
  const signal = resolveFollowupAbortSignal(input);
  if (
    input.currentInboundEventKind !== "user_request" ||
    (kind !== undefined && kind !== "external_user") ||
    !source ||
    !authority ||
    source.operatorAuthority !== authority ||
    !operatorScopeSatisfied("operator.write", authority.scopes)
  ) {
    return undefined;
  }
  const isCurrentInput = () => {
    if (signal?.aborted) {
      return false;
    }
    try {
      if (!source.isCurrent()) {
        return false;
      }
      assertAdmittedRunOperatorAuthority(authority);
      authority.assertCurrent();
      return true;
    } catch {
      return false;
    }
  };
  if (!isCurrentInput()) {
    return undefined;
  }
  const owner = captureEmbeddedVisibleTurnOwner(params.sessionId);
  if (!owner || owner.sessionKey !== params.sessionKey) {
    return undefined;
  }
  return async () => {
    if (await owner.waitForEnd(UNINJECTABLE_OWNER_GRACE_MS)) {
      return;
    }
    if (!isCurrentInput()) {
      return;
    }
    if (!owner.preempt()) {
      return;
    }
    // Observe the same handle, never wait on or abort a rediscovered successor.
    // A timeout does not certify cleanup or release another owner's write fence.
    await owner.waitForEnd(15_000);
  };
}
