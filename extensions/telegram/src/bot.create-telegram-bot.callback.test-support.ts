import { registerPluginInteractiveHandler } from "openclaw/plugin-sdk/plugin-runtime";
import { expect, it, vi } from "vitest";
import {
  makeCallbackRetryContext,
  telegramBotInfoForTest,
} from "./bot.create-telegram-bot.test-support.js";
import type { TelegramTestContext } from "./bot.test-helpers.js";
import type { TelegramBotOptions } from "./bot.types.js";
import { buildTelegramOpaqueCallbackData } from "./native-command-callback-data.js";

type Harness = typeof import("./bot.create-telegram-bot.test-harness.js");
type TelegramTypedCallbackCaseDependencies = {
  createTelegramBot: (options: TelegramBotOptions) => Promise<unknown>;
  getCallbackHandler: () => (context: TelegramTestContext) => Promise<void>;
  configureOpenDm: () => void;
  loadConfig: ReturnType<Harness["getLoadConfigMock"]>;
  requireValue: <T>(value: T | null | undefined, label: string) => T;
  harness: Pick<
    Harness,
    "replySpy" | "editMessageReplyMarkupSpy" | "answerCallbackQuerySpy" | "sendMessageSpy"
  >;
};

export function registerTelegramOrdinaryTypedCallbackCases({
  createTelegramBot,
  getCallbackHandler,
  loadConfig,
  requireValue,
  harness: { replySpy, editMessageReplyMarkupSpy, answerCallbackQuerySpy, sendMessageSpy },
}: TelegramTypedCallbackCaseDependencies) {
  it.each([
    {
      value: "archive_previous_recovery_fixture",
      label: "Archive previous recovery",
      expectedValue: "archive_previous_recovery_fixture",
    },
    {
      value: "keep_previous_recovery_fixture",
      label: "Keep previous recovery",
      expectedValue: "keep_previous_recovery_fixture",
    },
    { value: "env|prod ", label: "Production", expectedValue: '"env|prod "' },
  ])(
    "submits unowned typed callback $value with its bot-authored button label",
    async ({ value, label, expectedValue }) => {
      const data = buildTelegramOpaqueCallbackData(value);
      await createTelegramBot({ token: "tok" });
      const ctx = makeCallbackRetryContext({
        id: "cbq-ordinary-typed",
        data,
        messageId: 10,
        text: "Choose an option",
        message: {
          from: telegramBotInfoForTest,
          reply_markup: { inline_keyboard: [[{ text: label, callback_data: data }]] },
        },
      });
      ctx.me = telegramBotInfoForTest;
      await getCallbackHandler()(ctx);

      expect(replySpy).toHaveBeenCalledOnce();
      expect(requireValue(replySpy.mock.calls.at(0), "replySpy call")[0].RawBody).toBe(
        `callback_label: ${label}\ncallback_data: ${expectedValue}`,
      );
      expect(editMessageReplyMarkupSpy).toHaveBeenCalledWith(1234, 10, {
        reply_markup: { inline_keyboard: [] },
      });
      expect(sendMessageSpy).not.toHaveBeenCalledWith(
        1234,
        "This action is no longer available.",
        undefined,
      );
      expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-ordinary-typed");
    },
  );

  it("submits unowned typed slash values as text rather than synthetic commands", async () => {
    await createTelegramBot({ token: "tok" });
    await getCallbackHandler()(
      makeCallbackRetryContext({
        id: "cbq-opaque-1",
        data: buildTelegramOpaqueCallbackData("/codex permissions yolo"),
        messageId: 10,
      }),
    );

    expect(replySpy).toHaveBeenCalledOnce();
    const payload = requireValue(replySpy.mock.calls.at(0), "replySpy call")[0];
    expect(payload.RawBody).toBe("callback_data: /codex permissions yolo");
    expect(payload.CommandSource).not.toBe("native");
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-opaque-1");
  });

  it("does not guess a typed callback label from ambiguous button matches", async () => {
    const data = buildTelegramOpaqueCallbackData("continue_fixture");
    await createTelegramBot({ token: "tok" });
    const ctx = makeCallbackRetryContext({
      id: "cbq-ambiguous-label",
      data,
      messageId: 10,
      message: {
        from: telegramBotInfoForTest,
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Continue first", callback_data: data },
              { text: "Continue second", callback_data: data },
            ],
          ],
        },
      },
    });
    ctx.me = telegramBotInfoForTest;
    await getCallbackHandler()(ctx);

    expect(replySpy).toHaveBeenCalledOnce();
    expect(requireValue(replySpy.mock.calls.at(0), "replySpy call")[0].RawBody).toBe(
      "callback_data: continue_fixture",
    );
  });

  it("terminalizes an owned typed callback when its registered handler declines", async () => {
    const pluginHandler = vi.fn(async () => ({ handled: false, submitText: "Do not submit" }));
    expect(
      registerPluginInteractiveHandler("recovery-fixture", {
        channel: "telegram",
        namespace: "recovery-fixture",
        handler: pluginHandler,
      }),
    ).toEqual({ ok: true });
    const data = buildTelegramOpaqueCallbackData("recovery-fixture:archive");
    await createTelegramBot({ token: "tok" });
    await getCallbackHandler()(
      makeCallbackRetryContext({
        id: "cbq-owned-declined",
        data,
        messageId: 10,
        message: {
          reply_markup: { inline_keyboard: [[{ text: "Archive", callback_data: data }]] },
        },
      }),
    );

    expect(pluginHandler).toHaveBeenCalledOnce();
    expect(replySpy).not.toHaveBeenCalled();
    expect(editMessageReplyMarkupSpy).toHaveBeenCalledWith(1234, 10, {
      reply_markup: { inline_keyboard: [] },
    });
    expect(sendMessageSpy).toHaveBeenCalledWith(
      1234,
      "This action is no longer available.",
      undefined,
    );
  });

  it("does not submit unowned typed callbacks from a denied sender", async () => {
    loadConfig.mockReturnValue({
      messages: { inbound: { debounceMs: 0 } },
      channels: {
        telegram: {
          dmPolicy: "allowlist",
          allowFrom: ["55"],
          capabilities: { inlineButtons: "allowlist" },
        },
      },
    });
    const data = buildTelegramOpaqueCallbackData("archive_previous_recovery_fixture");
    await createTelegramBot({ token: "tok" });
    await getCallbackHandler()(
      makeCallbackRetryContext({
        id: "cbq-typed-denied",
        data,
        messageId: 10,
        from: { id: 9, is_bot: false, first_name: "Reader" },
        message: {
          reply_markup: { inline_keyboard: [[{ text: "Archive", callback_data: data }]] },
        },
      }),
    );

    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-typed-denied");
    expect(replySpy).not.toHaveBeenCalled();
    expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });
}

export function registerTelegramMalformedTypedCallbackCases({
  createTelegramBot,
  getCallbackHandler,
  configureOpenDm,
  harness: { replySpy, editMessageReplyMarkupSpy, sendMessageSpy },
}: TelegramTypedCallbackCaseDependencies) {
  it.each(["tgcb1:invalid", "tgcb1:!bad!:archive_previous_recovery_fixture"])(
    "terminalizes malformed typed callback %s without raw-text fallthrough",
    async (data) => {
      const pluginHandler = vi.fn(async () => ({ handled: true }));
      registerPluginInteractiveHandler("typed-owner-fixture", {
        channel: "telegram",
        namespace: "missing-plugin",
        handler: pluginHandler,
      });
      configureOpenDm();
      await createTelegramBot({ token: "tok" });
      await getCallbackHandler()(
        makeCallbackRetryContext({
          id: "cbq-opaque-malformed",
          data,
          messageId: 10,
          message: {
            reply_markup: { inline_keyboard: [[{ text: "Approve", callback_data: data }]] },
          },
        }),
      );

      expect(pluginHandler).not.toHaveBeenCalled();
      expect(replySpy).not.toHaveBeenCalled();
      expect(editMessageReplyMarkupSpy).toHaveBeenCalledWith(1234, 10, {
        reply_markup: { inline_keyboard: [] },
      });
      expect(sendMessageSpy).toHaveBeenCalledWith(
        1234,
        "This action is no longer available.",
        undefined,
      );
    },
  );
}
