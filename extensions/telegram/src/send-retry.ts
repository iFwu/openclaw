import { setTimeout as sleep } from "node:timers/promises";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import {
  createChannelApiRetryRunner,
  retryAsync,
  type RetryConfig,
} from "openclaw/plugin-sdk/retry-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  isRecoverableTelegramNetworkError,
  isSafeToRetrySendError,
  isTelegramClientRejection,
  isTelegramServerError,
} from "./network-errors.js";
import { findTelegramRequestAuthorityError } from "./request-authority.js";

const log = createSubsystemLogger("telegram/send-retry");

// Text delivery favors another visible copy over losing a reply to a lost ACK.
// Keep no-send custody classification separate: ambiguity is not proof of omission.
export function createTelegramSendRetryRunner(
  options: {
    retry?: RetryConfig;
    verbose?: boolean;
    signal?: AbortSignal;
  } = {},
) {
  const safeRetry = createChannelApiRetryRunner({
    ...options,
    shouldRetry: isSafeToRetrySendError,
    strictShouldRetry: true,
  });
  const textRetry = <T>(send: () => Promise<T>, operation?: string) =>
    retryAsync(
      () => {
        options.signal?.throwIfAborted();
        return send();
      },
      {
        attempts: 8,
        minDelayMs: 1_000,
        maxDelayMs: 30_000,
        jitter: 0.1,
        ...options.retry,
        label: operation,
        ...(options.signal
          ? { sleep: (ms: number) => sleep(ms, undefined, { signal: options.signal }) }
          : {}),
        shouldRetry: (error) =>
          !options.signal?.aborted &&
          !findTelegramRequestAuthorityError(error) &&
          !(error instanceof PlatformMessageNotDispatchedError && !error.retryable) &&
          !isTelegramClientRejection(error) &&
          (isSafeToRetrySendError(error) ||
            isRecoverableTelegramNetworkError(error, { context: "send" }) ||
            isTelegramServerError(error)),
        onRetry:
          options.verbose === false
            ? undefined
            : ({ attempt, maxAttempts, delayMs }) =>
                log.warn(
                  `telegram ${operation ?? "text"} retry ${attempt}/${maxAttempts - 1} in ${delayMs}ms; delivery may be duplicated`,
                ),
      },
    );
  return <T>(send: () => Promise<T>, operation?: string): Promise<T> =>
    /^(?:sendMessage|sendRichMessage)(?:\b|$)/.test(operation ?? "")
      ? textRetry(send, operation)
      : safeRetry(send, operation);
}
