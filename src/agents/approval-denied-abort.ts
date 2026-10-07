/** Explicit onDeny cancellation: the canonical approval receipt owns the result. */
export function createApprovalDeniedAbortError(): Error {
  return Object.assign(
    new Error("Approval denied; the approval receipt owns the user-visible result"),
    {
      name: "AbortError",
      code: "APPROVAL_DENIED",
    },
  );
}

export function isApprovalDeniedAbort(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    if ("code" in current && current.code === "APPROVAL_DENIED") {
      return true;
    }
    current = current.cause;
  }
  return false;
}
