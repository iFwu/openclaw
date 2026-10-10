import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { mockPinnedHostnameResolution } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi } from "vitest";
import type { TelegramBotDeps } from "./bot-deps.js";
import {
  runWithTelegramSpooledReplayUpdate,
  runWithTelegramUpdateProcessingFrame,
} from "./bot-processing-outcome.js";
import { makeDirectTelegramConfig } from "./bot.config.test-support.js";
import type {
  getFileSpy,
  replySpy,
  telegramBotDepsForTest,
} from "./bot.create-telegram-bot.test-harness.js";
import { createReplyPhotoMessage } from "./bot.test-helpers.js";
import type { TelegramBotOptions } from "./bot.types.js";

type TelegramMessageHandler = (ctx: Record<string, unknown>) => Promise<void>;

export function registerTelegramSpooledMediaAbortCases(harness: {
  createMessageHandler: (
    options?: Omit<TelegramBotOptions, "token">,
  ) => Promise<TelegramMessageHandler>;
  createTelegramTestStorePath: (label: string) => string;
  loadConfig: { mockReturnValue: (config: OpenClawConfig) => unknown };
  telegramBotDepsForTest: typeof telegramBotDepsForTest;
  getSessionEntry: NonNullable<TelegramBotDeps["getSessionEntry"]>;
  getFileSpy: typeof getFileSpy;
  replySpy: typeof replySpy;
  makeTelegramTransport: (
    fetch: typeof globalThis.fetch,
  ) => NonNullable<TelegramBotOptions["telegramTransport"]>;
  pngResponse: () => Response;
}) {
  const {
    createMessageHandler,
    createTelegramTestStorePath,
    loadConfig,
    telegramBotDepsForTest,
    getSessionEntry,
    getFileSpy,
    replySpy,
    makeTelegramTransport,
    pngResponse,
  } = harness;

  it("durably retries a spooled reply when its claim owner aborts reply media", async () => {
    const claimOwner = new AbortController();
    let replyMediaAborted: boolean | undefined;
    getFileSpy.mockImplementationOnce(async (_fileId, signal) => {
      claimOwner.abort(new Error("claim adoption stalled"));
      replyMediaAborted = signal instanceof AbortSignal ? signal.aborted : undefined;
      throw new Error("Bad Request: file is too big");
    });

    const config = makeDirectTelegramConfig(createTelegramTestStorePath("reply-media-abort"));
    loadConfig.mockReturnValue(config);
    const handler = await createMessageHandler({
      config,
      telegramDeps: { ...telegramBotDepsForTest, getSessionEntry },
    });
    const update = {
      update_id: 98081,
      message: {
        ...createReplyPhotoMessage("keep the old image"),
        message_id: 9002,
        from: { id: 42, first_name: "Ada" },
      },
    };

    const { result } = await runWithTelegramUpdateProcessingFrame(() =>
      runWithTelegramSpooledReplayUpdate(
        update,
        () =>
          handler({
            update,
            message: update.message,
            me: { username: "openclaw_bot" },
            getFile: async () => ({}),
          }),
        {
          abortSignal: claimOwner.signal,
          onAdopted: vi.fn(),
          onDeferred: vi.fn(),
          onAdoptionFinalizing: vi.fn(),
          onAbandoned: vi.fn(),
        },
      ),
    );

    expect(replyMediaAborted).toBe(true);
    expect(result).toEqual({ kind: "failed-retryable", error: expect.any(Error) });
    expect(getFileSpy).toHaveBeenCalledWith("reply-photo-1", expect.any(AbortSignal));
    expect(replySpy).not.toHaveBeenCalled();
  });

  it("durably retries when primary media hydration outlives its claim owner", async () => {
    const claimOwner = new AbortController();
    const timeoutError = new Error("claim adoption stalled");
    let mediaAborted: boolean | undefined;
    const mediaFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      claimOwner.abort(timeoutError);
      mediaAborted = init?.signal?.aborted;
      return pngResponse();
    });
    const ssrfMock = mockPinnedHostnameResolution();

    try {
      const config = makeDirectTelegramConfig(createTelegramTestStorePath("primary-media-abort"));
      loadConfig.mockReturnValue(config);
      const handler = await createMessageHandler({
        config,
        telegramTransport: makeTelegramTransport(mediaFetch as typeof fetch),
        telegramDeps: { ...telegramBotDepsForTest, getSessionEntry },
      });
      const update = {
        update_id: 98083,
        message: {
          chat: { id: 7, type: "private" },
          message_id: 9002,
          caption: "inspect this image",
          date: 1_736_380_800,
          from: { id: 42, first_name: "Ada" },
          photo: [{ file_id: "primary-photo-1" }],
        },
      };

      const { result } = await runWithTelegramUpdateProcessingFrame(() =>
        runWithTelegramSpooledReplayUpdate(
          update,
          () =>
            handler({
              update,
              message: update.message,
              me: { username: "openclaw_bot" },
              getFile: async () => ({ file_path: "media/primary-photo.jpg" }),
            }),
          {
            abortSignal: claimOwner.signal,
            onAdopted: vi.fn(),
            onDeferred: vi.fn(),
            onAdoptionFinalizing: vi.fn(),
            onAbandoned: vi.fn(),
          },
        ),
      );

      expect(mediaFetch).toHaveBeenCalledTimes(1);
      expect(mediaAborted).toBe(true);
      expect(result).toEqual({ kind: "failed-retryable", error: timeoutError });
      expect(replySpy).not.toHaveBeenCalled();
    } finally {
      ssrfMock.mockRestore();
    }
  });
}
