import { retryAsync } from "openclaw/plugin-sdk/retry-runtime";
import {
  isRecoverableTelegramNetworkError,
  isTelegramRateLimitError,
  isTelegramServerError,
} from "./network-errors.js";

export async function clearTelegramReaction(clear: () => Promise<unknown>): Promise<void> {
  await retryAsync(clear, {
    attempts: 2,
    minDelayMs: 300,
    maxDelayMs: 300,
    jitter: 0,
    // Flood waits remain owned by the token-scoped account limiter.
    shouldRetry: (err) =>
      !isTelegramRateLimitError(err) &&
      (isRecoverableTelegramNetworkError(err, { context: "react" }) || isTelegramServerError(err)),
  });
}
