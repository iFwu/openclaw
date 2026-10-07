import type { Message } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import { prepareTelegramInputSource } from "./bot-handlers.input-source.js";
import type { TelegramSessionState } from "./bot-handlers.message-context.js";
import {
  holdTelegramMediaTimeouts,
  flushChannelPostMediaGroup,
} from "./bot-media-timers.test-support.js";
import { setNextSavedMediaPath } from "./bot.media.e2e.test-harness.js";
import {
  createBotHandler,
  createTelegramPhotoForTest,
  mockTelegramPngDownload,
  TELEGRAM_TEST_TIMINGS,
} from "./bot.media.test-utils.js";
import { withResolvedTelegramForumFlag } from "./bot/helpers.js";

const { readCapturedEntry } = vi.hoisted(() => ({ readCapturedEntry: vi.fn() }));
vi.mock("openclaw/plugin-sdk/reply-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/reply-runtime")>()),
  stageChannelInputSource: async () => ({
    resolveMessage: async () => undefined,
    message: undefined,
  }),
  retainCancelledChannelInputSource: async () => true,
}));
vi.mock("openclaw/plugin-sdk/session-store-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/session-store-runtime")>();
  return {
    ...actual,
    getSessionEntry: (params: Parameters<typeof actual.getSessionEntry>[0]) =>
      params.storePath === "/tmp/album-original-source"
        ? readCapturedEntry()
        : actual.getSessionEntry(params),
  };
});

describe("Telegram album original source isolation", () => {
  it.each(["before-download", "after-download"] as const)(
    "excludes a retained caption and media from the successor prompt (%s)",
    async (cutoffAt) => {
      const { handler, replySpy, runtimeError } = await createBotHandler();
      const fetch = mockTelegramPngDownload();
      const timers = holdTelegramMediaTimeouts(TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs);
      const state: TelegramSessionState = {
        agentId: "main",
        sessionKey: "agent:main:telegram:album",
        storePath: "/tmp/album-original-source",
        sessionEntry: { sessionId: "album-original", updatedAt: 1 },
        bindingMode: { kind: "none" },
        model: undefined,
      };
      let stopped = false;
      const current = () => ({
        ...state,
        sessionEntry: {
          ...state.sessionEntry!,
          ...(stopped ? { abortCutoffMessageSid: "701" } : {}),
        },
      });
      readCapturedEntry.mockImplementation(() => current().sessionEntry);
      const original: Message = withResolvedTelegramForumFlag(
        {
          chat: { id: 42, type: "private" },
          from: { id: 777, is_bot: false, first_name: "Ada" },
          message_id: 701,
          caption: "CANCELLED ORIGINAL CAPTION",
          date: 1736380800,
          media_group_id: "original-retained-album",
          photo: [createTelegramPhotoForTest("stopped-photo")],
        } as Message,
        false,
      );
      const successor: Message = {
        ...original,
        message_id: 703,
        caption: "FRESH SURVIVING CAPTION",
        date: 1736380801,
        photo: [createTelegramPhotoForTest("fresh-photo")],
      };
      const retained = vi.fn().mockResolvedValue(undefined);
      try {
        for (const msg of [original, successor]) {
          await prepareTelegramInputSource({
            msg,
            cfg: {},
            accountId: "default",
            state,
            resolveState: async () => current(),
            assertOwnerCurrent: () => {},
            onRetained: retained,
          });
        }
        setNextSavedMediaPath({ path: "/tmp/media/stopped.png", contentType: "image/png" });
        setNextSavedMediaPath({ path: "/tmp/media/fresh.png", contentType: "image/png" });
        for (const msg of [original, successor]) {
          await handler({
            message: msg,
            me: { username: "openclaw_bot" },
            getFile: async () => {
              if (cutoffAt === "after-download" && msg.message_id === 703) {
                stopped = true;
              }
              return { file_path: `photos/${msg.message_id}.png` };
            },
          });
        }
        if (cutoffAt === "before-download") {
          stopped = true;
        }
        await flushChannelPostMediaGroup(timers, 20_000, TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs);
        await vi.waitFor(() => expect(replySpy).toHaveBeenCalledOnce());
        expect(runtimeError).not.toHaveBeenCalled();
        expect(retained).toHaveBeenCalledOnce();
        const payload = replySpy.mock.calls[0]?.[0] as {
          Body: string;
          ChannelStructuredContext?: unknown;
          MediaPaths?: string[];
        };
        expect(payload.Body).toContain("FRESH SURVIVING CAPTION");
        expect(payload.Body).not.toContain("CANCELLED ORIGINAL CAPTION");
        expect(JSON.stringify(payload.ChannelStructuredContext ?? [])).not.toContain(
          "CANCELLED ORIGINAL CAPTION",
        );
        expect(payload.MediaPaths).toHaveLength(1);
        if (cutoffAt === "after-download") {
          expect(payload.MediaPaths).toEqual(["/tmp/media/fresh.png"]);
        }
      } finally {
        fetch.mockRestore();
        timers.mockRestore();
      }
    },
    30_000,
  );
});
