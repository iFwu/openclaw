import { AsyncLocalStorage } from "node:async_hooks";
import type { ApprovalOrigin } from "../agents/admitted-run-approval-origin.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type Snapshot = Readonly<{ sessionKey: string; origin: ApprovalOrigin }>;
type Binding = Readonly<{ snapshot: Snapshot; assertCurrent: () => void }>;
const storage = resolveGlobalSingleton<AsyncLocalStorage<Binding | undefined>>(
  Symbol.for("openclaw.continuationApprovalOrigin"),
  () => new AsyncLocalStorage(),
);

export function captureContinuationApprovalOrigin(
  caller: (ApprovalOrigin & { sessionKey: string }) | undefined,
): Snapshot | undefined {
  if (!caller?.sessionKey.trim()) {
    return undefined;
  }
  // Absence and local posture are facts too; delivery metadata must not fill them.
  return Object.freeze({
    sessionKey: caller.sessionKey.trim(),
    origin: Object.freeze({
      turnSourceChannel: caller.turnSourceChannel,
      turnSourceLocal: caller.turnSourceLocal,
      turnSourceTo: caller.turnSourceTo,
      turnSourceAccountId: caller.turnSourceAccountId,
      turnSourceThreadId: caller.turnSourceThreadId,
    }),
  });
}

export function withContinuationApprovalOrigin<T>(
  snapshot: Snapshot | undefined,
  assertCurrent: () => void,
  run: () => T,
): T {
  assertCurrent();
  return storage.run(snapshot ? Object.freeze({ snapshot, assertCurrent }) : undefined, run);
}

export function readContinuationApprovalOrigin(targetSessionKey: string): Binding | undefined {
  const binding = storage.getStore();
  if (!binding) {
    return undefined;
  }
  binding.assertCurrent();
  return binding.snapshot.sessionKey === targetSessionKey ? binding : undefined;
}
