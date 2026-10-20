/** Custody refusal must not release already accepted input for another dispatch. */
export class SessionPendingInputCustodyError extends Error {}

/** A collected input cannot be retried with the same invalid source identities. */
export class SessionPendingInputCollectionError extends Error {
  readonly code = "collected-input-identity";

  constructor(
    message = "Collected input requires one exact session and a distinct aggregate identity",
  ) {
    super(message);
  }
}

export function assertCollectedInputSourceCount(staged: number, total: number): void {
  if (staged > 0 && staged !== total) {
    throw new SessionPendingInputCollectionError(
      "Collected input cannot mix staged and unstaged source approval",
    );
  }
}
