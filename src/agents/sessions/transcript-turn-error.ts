/** Native agent and Gateway error surfaces can retain only the assertion text. */
export function isSessionTranscriptTurnMismatchErrorMessage(
  message: string | undefined,
): message is string {
  return /^(?:Error: )?(?:Session transcript keyed user is outside the current turn: \S|Pending input is no longer active in its admitted transcript$)/.test(
    message ?? "",
  );
}
