// Covers Telegram question delivery capture and native final edit.
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as TelegramSend from "./send.js";

const hoisted = vi.hoisted(() => ({
  edit: vi.fn(),
  editMarkup: vi.fn(),
  registration: undefined as
    | { finalize: (statusLine: string) => void | Promise<void>; deliveryId: string }
    | undefined,
}));
vi.mock("openclaw/plugin-sdk/question-gateway-runtime", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("openclaw/plugin-sdk/question-gateway-runtime")>();
  return {
    ...original,
    questionGatewayRuntime: {
      ...original.questionGatewayRuntime,
      registerChannelDelivery: (registration: typeof hoisted.registration) => {
        hoisted.registration = registration;
      },
    },
  };
});
vi.mock("./send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof TelegramSend>()),
  editMessageReplyMarkupTelegram: hoisted.editMarkup,
  editMessageTelegram: hoisted.edit,
}));

import { deliverStructuredReplies } from "./bot/delivery.js";
import { telegramCaptionDeliveryMetadata } from "./caption.js";
import { createTelegramOutboundAdapter } from "./outbound-adapter.js";
import { sendMessageTelegram } from "./send.js";
import { useTelegramHttpFixture } from "./send.telegram-http.test-support.js";

describe("Telegram question finalization", () => {
  const fixture = useTelegramHttpFixture();
  beforeEach(() => {
    hoisted.edit.mockReset();
    hoisted.editMarkup.mockReset();
    hoisted.registration = undefined;
  });

  const questionData = {
    askUser: { questionId: "ask_0123456789abcdef0123456789abcdef" },
  };
  const sendQuestion = (
    text: string,
    options: { rich: boolean; buttons: boolean; media?: boolean; textLimit?: number },
  ) =>
    deliverStructuredReplies({
      cfg: fixture.cfg,
      bot: fixture.bot,
      runtime: fixture.runtime,
      chatId: "123",
      token: fixture.cfg.channels.telegram.botToken,
      replyToMode: "off",
      textLimit: options.textLimit ?? 256,
      richMessages: options.rich,
      silent: false,
      mediaLocalRoots: [fixture.mediaDir],
      replies: [
        {
          text,
          ...(options.media ? { mediaUrl: fixture.photoPath } : {}),
          channelData: {
            ...questionData,
            ...(options.buttons ? { telegram: { buttons: fixture.buttons } } : {}),
          },
        },
      ],
    });

  it.each([
    { rich: false, buttons: false },
    { rich: false, buttons: true },
    { rich: true, buttons: false },
    { rich: true, buttons: true },
  ])(
    "annotates only an accepted long-question part (rich: $rich, buttons: $buttons)",
    async (options) => {
      const send = await vi.importActual<typeof TelegramSend>("./send.js");
      hoisted.edit.mockImplementation(send.editMessageTelegram);
      hoisted.editMarkup.mockImplementation(send.editMessageReplyMarkupTelegram);
      const result = await sendQuestion(
        `${"A".repeat(256)}${"B".repeat(256)}${"C".repeat(80)}`,
        options,
      );
      expect(result.delivered).toBe(true);
      expect(result.receipt?.platformMessageIds).toHaveLength(3);
      const ids = result.receipt!.platformMessageIds;
      const chosenId = options.buttons ? ids[0] : ids[2];
      expect(hoisted.registration?.deliveryId).toBe(`telegram:default:123:${chosenId}`);
      const sends = fixture.requests.slice();
      expect(sends).toHaveLength(3);
      expect(sends.every(({ fields }) => fields.disable_notification !== true)).toBe(true);
      expect(sends.map(({ method }) => method)).toEqual(
        Array(3).fill(options.rich ? "sendRichMessage" : "sendMessage"),
      );

      await hoisted.registration?.finalize("Answered: yes");

      const edits = fixture.requests.slice(sends.length);
      expect(edits.map(({ method }) => method)).toEqual(
        options.buttons ? ["editMessageReplyMarkup", "editMessageText"] : ["editMessageText"],
      );
      expect(edits.every(({ fields }) => String(fields.message_id) === chosenId)).toBe(true);
      expect(edits.at(-1)?.fields.text).toBe(
        `${options.buttons ? "A".repeat(256) : "C".repeat(80)}\n\nAnswered: yes`,
      );
      expect(fixture.requests.filter(({ method }) => method === "deleteMessage")).toEqual([]);
    },
  );

  it.each([false, true])(
    "uses the physical rich-to-plain fallback part (buttons: %s)",
    async (buttons) => {
      fixture.rejections.push("Bad Request: RICH_MESSAGE_TEXT_TOO_LONG");
      const result = await sendQuestion(`${"A".repeat(4000)}${"B".repeat(80)}`, {
        rich: true,
        buttons,
        textLimit: 8192,
      });
      expect(fixture.requests.map(({ method }) => method)).toEqual([
        "sendRichMessage",
        "sendMessage",
        "sendMessage",
      ]);
      expect(result.receipt?.platformMessageIds).toEqual(["2", "3"]);
      expect(hoisted.registration?.deliveryId).toBe("telegram:default:123:3");
      await hoisted.registration?.finalize("Answered: yes");
      expect(hoisted.edit).toHaveBeenCalledExactlyOnceWith(
        "123",
        3,
        `${"B".repeat(80)}\n\nAnswered: yes`,
        expect.objectContaining({ textMode: "html" }),
      );
      if (buttons) {
        expect(hoisted.editMarkup).toHaveBeenCalledExactlyOnceWith(
          "123",
          3,
          [],
          expect.any(Object),
        );
      } else {
        expect(hoisted.editMarkup).not.toHaveBeenCalled();
      }
    },
  );

  it.each([false, true])(
    "uses the accepted media caption, not a text edit (buttons: %s)",
    async (buttons) => {
      const send = await vi.importActual<typeof TelegramSend>("./send.js");
      hoisted.edit.mockImplementation(send.editMessageTelegram);
      hoisted.editMarkup.mockImplementation(send.editMessageReplyMarkupTelegram);
      const result = await sendQuestion("Choose <literal> *value*", {
        rich: false,
        buttons,
        media: true,
      });
      expect(result.receipt?.platformMessageIds).toHaveLength(1);
      const id = result.receipt!.platformMessageIds[0];
      await hoisted.registration?.finalize("Answered: yes");
      expect(fixture.requests.map(({ method }) => method)).toEqual(
        buttons
          ? ["sendPhoto", "editMessageReplyMarkup", "editMessageCaption"]
          : ["sendPhoto", "editMessageCaption"],
      );
      expect(fixture.requests.at(-1)?.fields).toMatchObject({
        message_id: Number(id),
        caption: "Choose &lt;literal&gt; value\n\nAnswered: yes",
        parse_mode: "HTML",
      });
    },
  );

  it("annotates the accepted text after captionless media without editing the media", async () => {
    const result = await sendQuestion("Q".repeat(1200), {
      rich: false,
      buttons: false,
      media: true,
    });
    expect(fixture.requests[0]?.method).toBe("sendPhoto");
    expect(fixture.requests[0]?.fields.caption).toBeUndefined();
    const id = result.receipt?.platformMessageIds.at(-1);
    expect(hoisted.registration?.deliveryId).toBe(`telegram:default:123:${id}`);
    await hoisted.registration?.finalize("Expired");
    expect(hoisted.editMarkup).not.toHaveBeenCalled();
    expect(hoisted.edit).toHaveBeenCalledWith(
      "123",
      Number(id),
      `${"Q".repeat(176)}\n\nExpired`,
      expect.objectContaining({ textMode: "html" }),
    );
    expect(hoisted.edit.mock.calls[0]?.[3]).not.toHaveProperty("editMode");
  });

  it("retains accepted custody on a rejected chunk without clearing an earlier unrelated reply", async () => {
    fixture.responseFor = (method, fields) => {
      if (method === "sendMessage" && String(fields.text).startsWith("A")) {
        fixture.rejections.push("Bad Request: BUTTON_DATA_INVALID");
      }
      return undefined;
    };
    const failure: unknown = await deliverStructuredReplies({
      cfg: fixture.cfg,
      bot: fixture.bot,
      runtime: fixture.runtime,
      chatId: "123",
      token: fixture.cfg.channels.telegram.botToken,
      replyToMode: "off",
      textLimit: 256,
      richMessages: false,
      replies: [
        { text: "Unrelated", channelData: { telegram: { buttons: fixture.buttons } } },
        {
          text: `${"A".repeat(256)}${"B".repeat(256)}${"C".repeat(80)}`,
          channelData: { ...questionData, telegram: { buttons: fixture.buttons } },
        },
      ],
    }).catch((error: unknown) => error);
    expect(isChannelPartialDeliveryError(failure)).toBe(true);
    if (!isChannelPartialDeliveryError(failure)) {
      throw new Error("Expected a real partial delivery error");
    }
    expect(failure.deliveryResult.receipt?.platformMessageIds).toEqual(["1", "2", "4"]);
    expect(hoisted.registration?.deliveryId).toBe("telegram:default:123:2");
    await hoisted.registration?.finalize("Expired");
    expect(hoisted.editMarkup).toHaveBeenCalledExactlyOnceWith("123", 2, [], expect.any(Object));
    expect(hoisted.edit).toHaveBeenCalledExactlyOnceWith(
      "123",
      2,
      `${"A".repeat(256)}\n\nExpired`,
      expect.any(Object),
    );
  });

  it("does not invent annotation custody when Telegram rejected the only question part", async () => {
    fixture.rejections.push("Bad Request: BUTTON_DATA_INVALID");
    await expect(sendQuestion("Choose one", { rich: false, buttons: true })).rejects.toThrow();
    expect(hoisted.registration).toBeUndefined();
    expect(hoisted.edit).not.toHaveBeenCalled();
    expect(hoisted.editMarkup).not.toHaveBeenCalled();
  });

  it("does not annotate captionless accepted media using the authored question", async () => {
    fixture.rejections.push("Bad Request: message text is empty");
    const result = await sendQuestion("Choose one", { rich: false, buttons: true, media: true });
    expect(result.delivered).toBe(true);
    expect(result.receipt?.platformMessageIds).toEqual(["2"]);
    expect(hoisted.registration?.deliveryId).toBe("telegram:default:123:2");
    await hoisted.registration?.finalize("Expired");
    expect(hoisted.editMarkup).toHaveBeenCalledExactlyOnceWith("123", 2, [], expect.any(Object));
    expect(hoisted.edit).not.toHaveBeenCalled();
  });

  it("keeps durable captionless question finalization cleanup-only", async () => {
    fixture.rejections.push("Bad Request: message text is empty");
    const result = await sendMessageTelegram("123", "Choose one", {
      cfg: fixture.cfg,
      api: fixture.bot.api,
      mediaUrl: fixture.photoPath,
      mediaLocalRoots: [fixture.mediaDir],
      buttons: fixture.buttons,
    });
    expect(result.messageId).toBe("2");
    expect(result.meta?.telegramDeliveredText).toBeUndefined();
    await createTelegramOutboundAdapter().afterDeliverPayload?.({
      cfg: fixture.cfg,
      target: { channel: "telegram", to: "123" },
      payload: { text: "Choose one", mediaUrls: [fixture.photoPath], channelData: questionData },
      results: [{ channel: "telegram", ...result }],
    });
    expect(hoisted.registration?.deliveryId).toBe("telegram:default:123:2");
    await hoisted.registration?.finalize("Expired");
    expect(hoisted.editMarkup).toHaveBeenCalledOnce();
    expect(hoisted.edit).not.toHaveBeenCalled();
  });

  it("removes buttons and appends terminal status", async () => {
    const deliveredText = "x".repeat(5000);
    const statusLine = `Answered: ${"y".repeat(600)}`;
    const deliveredMeta = {
      telegramDeliveredText: deliveredText,
      telegramHasInlineKeyboard: true,
    };
    telegramCaptionDeliveryMetadata.add(deliveredMeta);
    const outbound = createTelegramOutboundAdapter();
    await outbound.afterDeliverPayload?.({
      cfg: {},
      target: { channel: "telegram", to: "123", accountId: "default" },
      payload: {
        text: "Long preface\n\nPick one",
        mediaUrls: ["https://example.com/photo.jpg"],
        channelData: {
          askUser: { questionId: "ask_0123456789abcdef0123456789abcdef" },
        },
      },
      results: [
        {
          channel: "telegram",
          messageId: "54",
          target: { kind: "chat", id: "123" },
          meta: { telegramDeliveredText: "Long preface", telegramHasInlineKeyboard: false },
        },
        {
          channel: "telegram",
          messageId: "55",
          target: { kind: "chat", id: "123" },
          meta: deliveredMeta,
          receipt: {
            primaryPlatformMessageId: "55",
            platformMessageIds: ["54", "55"],
            parts: [
              { platformMessageId: "54", index: 0, kind: "media" },
              { platformMessageId: "55", index: 1, kind: "text" },
            ],
            sentAt: 0,
          },
        },
      ],
    });

    await hoisted.registration?.finalize(statusLine);
    expect(hoisted.editMarkup).toHaveBeenCalledWith("123", "55", [], {
      cfg: {},
      accountId: "default",
      verbose: false,
    });
    const annotatedText = hoisted.edit.mock.calls[0]?.[2] as string;
    expect(annotatedText.length).toBeLessThanOrEqual(4000);
    expect(annotatedText).toContain("\n\nAnswered: ");
    expect(hoisted.edit.mock.calls[0]?.[3]).not.toHaveProperty("editMode");
    expect(hoisted.editMarkup.mock.invocationCallOrder[0]).toBeLessThan(
      hoisted.edit.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it("finalizes an accepted unthreaded media question by editing its caption", async () => {
    const send = await vi.importActual<typeof TelegramSend>("./send.js");
    hoisted.edit.mockImplementation(send.editMessageTelegram);
    hoisted.editMarkup.mockImplementation(send.editMessageReplyMarkupTelegram);
    const result = await sendMessageTelegram("123", "Choose one", {
      cfg: fixture.cfg,
      api: fixture.bot.api,
      mediaUrl: fixture.photoPath,
      mediaLocalRoots: [fixture.mediaDir],
      buttons: fixture.buttons,
    });
    const outbound = createTelegramOutboundAdapter();

    await outbound.afterDeliverPayload?.({
      cfg: fixture.cfg,
      target: { channel: "telegram", to: "123" },
      payload: {
        text: "Choose one",
        mediaUrls: [fixture.photoPath],
        channelData: {
          askUser: { questionId: "ask_0123456789abcdef0123456789abcdef" },
        },
      },
      results: [{ channel: "telegram", ...result }],
    });

    await hoisted.registration?.finalize("Answered: yes");

    expect(fixture.requests.map(({ method }) => method)).toEqual([
      "sendPhoto",
      "editMessageReplyMarkup",
      "editMessageCaption",
    ]);
    expect(fixture.requests[1]?.fields).toMatchObject({
      chat_id: "123",
      message_id: Number(result.messageId),
      reply_markup: { inline_keyboard: [] },
    });
    expect(fixture.requests[2]?.fields).toMatchObject({
      chat_id: "123",
      message_id: Number(result.messageId),
      caption: "Choose one\n\nAnswered: yes",
    });
  });

  it("finalizes media-receipt questions as bounded captions", async () => {
    const deliveredText = "Q".repeat(1000);
    const statusLine = `Answered: ${"A".repeat(190)}`;
    const outbound = createTelegramOutboundAdapter();

    await outbound.afterDeliverPayload?.({
      cfg: {},
      target: { channel: "telegram", to: "-100123:topic:77", accountId: "default" },
      payload: {
        text: deliveredText,
        mediaUrls: ["https://example.com/photo.jpg"],
        channelData: {
          askUser: { questionId: "ask_0123456789abcdef0123456789abcdef" },
        },
      },
      results: [
        {
          channel: "telegram",
          messageId: "70",
          target: { kind: "chat", id: "-100123" },
          meta: { telegramDeliveredText: deliveredText, telegramHasInlineKeyboard: true },
          receipt: {
            primaryPlatformMessageId: "70",
            platformMessageIds: ["70"],
            parts: [{ platformMessageId: "70", index: 0, kind: "media", threadId: "77" }],
            threadId: "77",
            sentAt: 0,
          },
        },
      ],
    });

    await hoisted.registration?.finalize(statusLine);

    expect(hoisted.editMarkup).toHaveBeenCalledWith("-100123", "70", [], {
      cfg: {},
      accountId: "default",
      verbose: false,
    });
    expect(hoisted.edit).toHaveBeenCalledWith(
      "-100123",
      "70",
      expect.any(String),
      expect.objectContaining({ editMode: "caption" }),
    );
    const annotatedCaption = hoisted.edit.mock.calls[0]?.[2] as string;
    expect(annotatedCaption.length).toBeLessThanOrEqual(1024);
    expect(annotatedCaption).toContain(`\n\n${statusLine}`);
    expect(hoisted.editMarkup.mock.invocationCallOrder[0]).toBeLessThan(
      hoisted.edit.mock.invocationCallOrder[0] ?? Infinity,
    );
  });
});
