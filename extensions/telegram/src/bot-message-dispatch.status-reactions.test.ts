import { createStatusReactionController as createReactionController } from "openclaw/plugin-sdk/channel-feedback";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";
import { createTelegramDispatchStatus } from "./bot-message-dispatch-status.js";
import {
  describeTelegramDispatch,
  createContext,
  deliverReplies,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  type TelegramMessageContext,
} from "./bot-message-dispatch.test-harness.js";

describeTelegramDispatch("dispatchTelegramMessage room-event failure policy", () => {
  it("does not send visible error fallbacks for room events", async () => {
    const reactionApi = vi.fn(async () => true);
    dispatchReplyWithBufferedBlockDispatcher.mockRejectedValue(new Error("provider down"));

    await dispatchWithContext({
      cfg: { messages: { removeAckAfterReply: true } },
      context: createContext({
        reactionApi,
        ackReactionPromise: Promise.resolve(true),
        ctxPayload: {
          InboundEventKind: "room_event",
          SessionKey: "agent:main:telegram:group:-100123",
          ChatType: "group",
          MessageSid: "101",
          RawBody: "ambient failure",
          BodyForAgent: "ambient failure",
          CommandBody: "ambient failure",
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -100123, type: "supergroup" },
          message_id: 101,
        } as unknown as TelegramMessageContext["msg"],
        chatId: -100123,
        isGroup: true,
        historyKey: "telegram:group:-100123",
        historyLimit: 10,
        threadSpec: { id: undefined, scope: "none" },
      }),
      streamMode: "partial",
    });

    expect(deliverReplies).not.toHaveBeenCalled();
    expect(reactionApi).not.toHaveBeenCalled();
  });
});

describeTelegramDispatch("fork ACK removal contract", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });
  it.each([
    { remove: true, sent: true },
    { remove: true, sent: false },
    { remove: false, sent: true },
  ])(
    "fork ACK waits for acknowledgement settlement before cleanup ($remove, $sent)",
    async ({ remove, sent }) => {
      const reactionApi = vi.fn(async () => true);
      const ack = createDeferred<boolean>();
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
        return { queuedFinal: true };
      });
      deliverReplies.mockResolvedValue({ delivered: true });
      await dispatchWithContext({
        cfg: { messages: { removeAckAfterReply: remove } },
        context: createContext({ reactionApi, ackReactionPromise: ack.promise }),
        streamMode: "off",
      });
      expect(reactionApi).not.toHaveBeenCalled();
      ack.resolve(sent);
      await ack.promise;
      await vi.runAllTimersAsync();
      expect(reactionApi).toHaveBeenCalledTimes(remove ? 1 : 0);
      if (remove) {
        expect(reactionApi).toHaveBeenLastCalledWith(123, 456, []);
      }
    },
  );

  it.each([
    { remove: true, outcome: "done" },
    { remove: false, outcome: "done" },
    { remove: true, outcome: "error" },
    { remove: false, outcome: "error" },
    { remove: true, outcome: "cancelled" },
    { remove: false, outcome: "cancelled" },
  ] as const)(
    "fork ACK finalizes reactions for $outcome with cleanup=$remove",
    async ({ remove, outcome }) => {
      const reactions: string[] = [];
      const controller = createReactionController({
        enabled: true,
        initialEmoji: "ack",
        emojis: { done: "done", error: "error" },
        adapter: {
          setReaction: async (emoji) => {
            reactions.push(emoji);
          },
          clearReaction: async () => {
            reactions.push("");
          },
        },
        timing: { doneHoldMs: 0, errorHoldMs: 0 },
      });
      await controller.setQueued();
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
        if (outcome === "error") {
          throw new Error("provider unavailable");
        }
        await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
        return { queuedFinal: true };
      });
      deliverReplies.mockResolvedValue({ delivered: true });
      await dispatchWithContext({
        cfg: { messages: { removeAckAfterReply: remove } },
        context: createContext({ statusReactionController: controller }),
        streamMode: "off",
        ...(outcome === "cancelled"
          ? { turnAdoptionLifecycle: { onAdopted: () => {}, abortSignal: AbortSignal.abort() } }
          : {}),
      });
      await vi.runAllTimersAsync();
      if (outcome !== "cancelled") {
        expect(reactions).toContain(outcome);
      }
      expect(reactions.at(-1)).toBe(remove ? "" : "ack");
      if (outcome === "cancelled") {
        expect(reactions).not.toContain("done");
        expect(reactions).not.toContain("error");
        expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
      }
    },
  );
  it.each(["done", "error", "cancelled"] as const)(
    "fork ACK clears an ambiguously applied acknowledgement after %s",
    async (outcome) => {
      let visibleReaction = false;
      const reactionApi = vi.fn<NonNullable<TelegramMessageContext["reactionApi"]>>(
        async (_chatId, _messageId, reactions) => {
          visibleReaction = reactions.length > 0;
          if (visibleReaction) {
            throw new Error("Network request for 'setMessageReaction' failed!");
          }
          return true;
        },
      );
      const context = await buildTelegramMessageContextForTest({
        message: { chat: { id: 123, type: "private" }, message_id: 456 },
        cfg: {
          channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
          messages: { ackReaction: "👀", removeAckAfterReply: true },
        },
        ackReactionScope: "direct",
        botApi: { setMessageReaction: reactionApi },
      });
      if (!context) {
        throw new Error("Expected an admitted Telegram context");
      }
      expect(await context.ackReactionPromise).toBe(false);
      expect(visibleReaction).toBe(true);
      createTelegramDispatchStatus({ cfg: context.cfg, context }).finalizeInBackground(
        { outcome },
        "ambiguous acknowledgement cleanup",
      );
      await vi.runAllTimersAsync();
      expect(visibleReaction).toBe(false);
      expect(reactionApi).toHaveBeenLastCalledWith(123, 456, []);
    },
  );
  it.each<{ controller: boolean; error: unknown; attempts: number; persistent?: boolean }>([
    {
      controller: false,
      error: new Error("Network request for 'setMessageReaction' failed!"),
      attempts: 2,
    },
    {
      controller: true,
      error: new Error("Network request for 'setMessageReaction' failed!"),
      attempts: 2,
    },
    { controller: false, error: { error_code: 403, description: "Forbidden" }, attempts: 1 },
    { controller: true, error: { error_code: 403, description: "Forbidden" }, attempts: 1 },
    { controller: false, error: { error_code: 429, parameters: { retry_after: 5 } }, attempts: 1 },
    { controller: true, error: { error_code: 429, parameters: { retry_after: 5 } }, attempts: 1 },
    { controller: false, error: { error_code: 503 }, attempts: 2 },
    {
      controller: false,
      error: new Error("Network request for 'setMessageReaction' failed!"),
      attempts: 2,
      persistent: true,
    },
  ])(
    "fork ACK cleanup bounds retries with lifecycle=$controller and attempts=$attempts",
    async ({ controller, error, attempts, persistent }) => {
      let clearAttempts = 0;
      const reactionApi = vi.fn<NonNullable<TelegramMessageContext["reactionApi"]>>(
        async (_chatId, _messageId, reactions) => {
          if (!reactions.length && (++clearAttempts === 1 || persistent)) {
            throw error;
          }
          return true;
        },
      );
      const context = await buildTelegramMessageContextForTest({
        message: { chat: { id: 123, type: "private" }, message_id: 456 },
        cfg: {
          channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
          messages: {
            ackReaction: "👀",
            removeAckAfterReply: true,
            statusReactions: { enabled: controller },
          },
        },
        ackReactionScope: "direct",
        botApi: { setMessageReaction: reactionApi },
      });
      if (!context) {
        throw new Error("Expected an admitted Telegram context");
      }
      await context.ackReactionPromise;
      createTelegramDispatchStatus({ cfg: context.cfg, context }).finalizeInBackground(
        { outcome: "cancelled" },
        "bounded cleanup",
      );
      await vi.runAllTimersAsync();
      expect(clearAttempts).toBe(attempts);
    },
  );
  it("does not clear reactions when acknowledgement was never attempted", async () => {
    const reactionApi = vi.fn(async () => true);
    const context = createContext({ reactionApi, ackReactionPromise: null });
    createTelegramDispatchStatus({
      cfg: { messages: { removeAckAfterReply: true } },
      context,
    }).finalizeInBackground({ outcome: "done" }, "no acknowledgement");
    await vi.runAllTimersAsync();
    expect(reactionApi).not.toHaveBeenCalled();
  });
  it.each(["done", "error", "cancelled"] as const)(
    "fork ACK clears the production context adapter after %s",
    async (outcome) => {
      const reactionApi = vi.fn(async () => true);
      const cfg = {
        agents: { defaults: { model: "fixture/test", workspace: "/tmp/openclaw" } },
        channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
        messages: {
          ackReaction: "👀",
          removeAckAfterReply: true,
          statusReactions: { enabled: true },
        },
      };
      const context = await buildTelegramMessageContextForTest({
        message: { chat: { id: 123, type: "private" }, message_id: 456 },
        cfg,
        ackReactionScope: "direct",
        botApi: { setMessageReaction: reactionApi },
      });
      expect(context?.statusReactionController).toBeTruthy();
      if (!context) {
        throw new Error("Expected an admitted Telegram context");
      }
      await context.ackReactionPromise;
      const status = createTelegramDispatchStatus({ cfg: context.cfg, context });
      status.finalizeInBackground({ outcome }, "production context cleanup");
      await vi.runAllTimersAsync();
      expect(reactionApi).toHaveBeenLastCalledWith(123, 456, []);
    },
  );
});
