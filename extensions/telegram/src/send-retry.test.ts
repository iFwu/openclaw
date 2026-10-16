import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeTelegramNetworkError } from "./network-errors.js";
import { createTelegramSendRetryRunner } from "./send-retry.js";

afterEach(() => vi.useRealTimers());

describe("Telegram text delivery retry policy", () => {
  it("bounds lost-response retries and retains the original ambiguous error", async () => {
    vi.useFakeTimers();
    const error = Object.assign(new Error("socket closed"), { code: "UND_ERR_SOCKET" });
    const send = vi.fn().mockRejectedValue(error);
    const result = createTelegramSendRetryRunner({ verbose: false })(send, "sendRichMessage").catch(
      (caught: unknown) => caught,
    );
    await vi.runAllTimersAsync();
    expect(await result).toBe(error);
    expect(send).toHaveBeenCalledTimes(8);
  });

  it("cancels a backoff without waiting for its timer or another attempt", async () => {
    const controller = new AbortController();
    const failed = Promise.withResolvers<void>();
    const send = vi.fn(async () => {
      failed.resolve();
      throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    });
    const result = createTelegramSendRetryRunner({ signal: controller.signal, verbose: false })(
      send,
      "sendMessage",
    ).catch((error: unknown) => error);
    await failed.promise;
    await Promise.resolve();
    controller.abort();
    expect(await result).toMatchObject({ name: "AbortError" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 403, 429])(
    "does not retry Telegram rejection %s outside its owner",
    async (error_code) => {
      const error = Object.assign(new Error("rejected"), { error_code });
      const send = vi.fn().mockRejectedValue(error);
      await expect(
        createTelegramSendRetryRunner({ verbose: false })(send, "sendMessage"),
      ).rejects.toBe(error);
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it("leaves uncertain non-text operations and retired authority alone", async () => {
    for (const [operation, error] of [
      ["sendPhoto", Object.assign(new Error("socket closed"), { code: "ECONNRESET" })],
      [
        "sendMessage",
        new PlatformMessageNotDispatchedError("writer retired", { retryable: false }),
      ],
    ] as const) {
      const send = vi.fn().mockRejectedValue(error);
      await expect(createTelegramSendRetryRunner({ verbose: false })(send, operation)).rejects.toBe(
        error,
      );
      expect(send).toHaveBeenCalledTimes(1);
    }
  });

  it("logs nested network codes without request contents or secret-bearing messages", () => {
    const error = Object.assign(new Error("outer"), {
      name: "HttpError",
      error: new TypeError("https://private.invalid/secret", {
        cause: Object.assign(new Error("authorization: secret"), {
          name: "SocketError",
          code: "UND_ERR_SOCKET",
        }),
      }),
    });
    expect(describeTelegramNetworkError(error)).toBe(
      "errorTypes=HttpError>TypeError>SocketError codes=UND_ERR_SOCKET",
    );
  });
});
