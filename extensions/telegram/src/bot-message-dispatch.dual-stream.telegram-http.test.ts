import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import { describe, expect, it } from "vitest";
import { defaultTelegramBotDeps } from "./bot-deps.js";
import { createTelegramDispatchHttpFixture } from "./bot-message-dispatch.telegram-http.test-support.js";
import { createTelegramDraftStream, type TelegramDraftStream } from "./draft-stream.js";

const answer = "An independently streamed answer with enough text for the first preview.";
const commentary = "Checking the independently observed evidence before answering.";

describe("Telegram independent progress and answer streams through HTTP", () => {
  const http = createTelegramDispatchHttpFixture();
  const { acceptedCalls, visibleMessages, dispatchProgressTurn } = http;

  it.each([3, 4])(
    "preserves commentary before failed-tool overflow at maxLines=%s",
    async (maxLines) => {
      const first = "Checking Jev before the upgrade.";
      const second = "Checking the upgrade contract.";
      await dispatchProgressTurn(
        async (options) => {
          await options?.onItemEvent?.({
            kind: "preamble",
            itemId: "overflow-jev",
            phase: "end",
            progressText: first,
          });
          await options?.onItemEvent?.({
            kind: "preamble",
            itemId: "overflow-upgrade",
            phase: "end",
            progressText: second,
          });
          for (let index = 0; index < maxLines - 1; index++) {
            await options?.onItemEvent?.({
              kind: "command",
              itemId: `overflow-exit-${index}`,
              name: "exec",
              status: "failed",
              meta: "exit 1",
            });
          }
        },
        {
          mode: "progress",
          toolProgress: true,
          telegramCfg: {
            streaming: {
              mode: "progress",
              progress: { commentary: true, toolProgress: true, maxLines, persist: true },
            },
          },
          finalReply: { text: "Overflow proof finished." },
        },
      );
      const cards = [...visibleMessages.values()].filter(
        (text) => text !== "Overflow proof finished.",
      );
      expect(cards).toHaveLength(1);
      expect(cards[0]).toContain(first);
      expect(cards[0]).toContain(second);
      expect(cards[0]).toMatch(/failed|exit 1/);
    },
  );

  it.each([false, true])(
    "keeps pending approval above overflow commentary (plan %s)",
    async (withPlan) => {
      const title = "Confirm before continuing";
      await dispatchProgressTurn(
        async (options) => {
          if (withPlan) {
            await options?.onPlanUpdate?.({
              phase: "update",
              steps: [
                { step: "Inspect", status: "completed" },
                { step: "Patch", status: "in_progress" },
                { step: "Verify", status: "pending" },
              ],
            });
          }
          await options?.onApprovalEvent?.({
            phase: "requested",
            approvalId: "overflow-approval",
            title,
          });
          await options?.onItemEvent?.({
            kind: "preamble",
            itemId: "newer-commentary",
            phase: "end",
            progressText: "This commentary must not erase an approval.",
          });
          for (let index = 0; index < 3; index++) {
            await options?.onItemEvent?.({
              kind: "command",
              itemId: `approval-exit-${index}`,
              name: "exec",
              status: "failed",
              meta: "exit 1",
            });
          }
        },
        {
          mode: "progress",
          toolProgress: true,
          telegramCfg: {
            streaming: {
              mode: "progress",
              progress: {
                commentary: true,
                toolProgress: true,
                maxLines: withPlan ? 3 : 1,
                persist: true,
              },
            },
          },
          finalReply: { text: "Approval priority proof finished." },
        },
      );
      const cards = [...visibleMessages.values()].filter(
        (text) => text !== "Approval priority proof finished.",
      );
      expect(cards).toHaveLength(1);
      expect(cards[0]).toContain(title);
      if (withPlan) {
        expect(cards[0]).toContain("Patch");
      }
    },
  );

  function captureStreams() {
    const streams: TelegramDraftStream[] = [];
    return {
      streams,
      telegramDeps: {
        ...defaultTelegramBotDeps,
        createTelegramDraftStream: (params: Parameters<typeof createTelegramDraftStream>[0]) => {
          const stream = createTelegramDraftStream(params);
          streams.push(stream);
          return stream;
        },
      },
    };
  }

  it.each([false, true])(
    "finalizes the cumulative answer in place (persist %s)",
    async (persist) => {
      const { streams, telegramDeps } = captureStreams();
      let answerId: number | undefined;
      let progressId: number | undefined;
      await dispatchProgressTurn(
        async (options) => {
          await options?.onPartialReply?.({ text: answer });
          await streams[1]?.flush();
          progressId = streams[0]?.messageId();
          answerId = streams[1]?.messageId();
          expect(progressId).toEqual(expect.any(Number));
          expect(answerId).toEqual(expect.any(Number));
          expect(answerId).not.toBe(progressId);
          expect(acceptedCalls.find((call) => call.method === "sendMessage")?.fields.text).toBe(
            "<b>Working</b>",
          );
          await options?.onPartialReply?.({ text: `${answer} Complete.`, delta: " Complete." });
          await streams[1]?.flush();
          expect(visibleMessages.get(answerId!)).toBe(`${answer} Complete.`);
        },
        {
          mode: "progress",
          toolProgress: false,
          telegramDeps,
          telegramCfg: { streaming: { mode: "progress", progress: { persist } } },
          finalReply: { text: `${answer} Complete.` },
        },
      );
      expect(visibleMessages.get(answerId!)).toBe(`${answer} Complete.`);
      expect(visibleMessages.has(progressId!)).toBe(persist);
      expect(acceptedCalls.filter((call) => call.method === "sendMessage")).toHaveLength(2);
      expect(
        acceptedCalls.some(
          (call) => call.method === "deleteMessage" && Number(call.fields.message_id) === answerId,
        ),
      ).toBe(false);
    },
  );

  it.each(["confirmed", "rejected", "unrelated"] as const)(
    "retires late-classified commentary only after its card accepts it (%s)",
    async (handoff) => {
      const { streams, telegramDeps } = captureStreams();
      let commentaryId: number | undefined;
      if (handoff === "rejected") {
        http.respondToCall = (call) =>
          call.method === "editMessageText" && String(call.fields.text).includes(commentary)
            ? { error_code: 400, description: "Bad Request: fixture card rejected" }
            : undefined;
      }
      await dispatchProgressTurn(
        async (options) => {
          await options?.onPartialReply?.({ text: commentary });
          await streams[1]?.flush();
          commentaryId = streams[1]?.messageId();
          await options?.onItemEvent?.({
            kind: "preamble",
            itemId: "late-commentary",
            phase: "end",
            progressText: handoff === "unrelated" ? "An unrelated preamble." : commentary,
          });
          if (handoff !== "unrelated") {
            expect(streams[1]?.messageId()).toBeUndefined();
          } else {
            expect(streams[1]?.messageId()).toBe(commentaryId);
          }
          await options?.onPartialReply?.({ text: answer });
          await streams[1]?.flush();
        },
        {
          mode: "progress",
          toolProgress: true,
          telegramDeps,
          telegramCfg: { streaming: { mode: "progress", progress: { persist: true } } },
          finalReply: { text: answer },
        },
      );
      expect([...visibleMessages.values()]).toContain(answer);
      if (handoff !== "unrelated") {
        expect(visibleMessages.has(commentaryId!)).toBe(handoff !== "confirmed");
      }
      if (handoff === "confirmed") {
        const cardEdit = acceptedCalls.findIndex(
          (call) =>
            call.method === "editMessageText" && String(call.fields.text).includes(commentary),
        );
        const retirement = acceptedCalls.findIndex(
          (call) =>
            call.method === "deleteMessage" && Number(call.fields.message_id) === commentaryId,
        );
        expect(cardEdit).toBeGreaterThanOrEqual(0);
        expect(retirement).toBeGreaterThan(cardEdit);
      }
    },
  );

  it.each(
    ["first", "batched", "all", "off"].flatMap((replyToMode) =>
      [false, true].flatMap((richMessages) =>
        [false, true].map((directTopic) => ({
          replyToMode: replyToMode as "first" | "batched" | "all" | "off",
          richMessages,
          directTopic,
        })),
      ),
    ),
  )(
    "consumes quotes across both lanes ($replyToMode, rich $richMessages, direct topic $directTopic)",
    async ({ replyToMode, richMessages, directTopic }) => {
      const { streams, telegramDeps } = captureStreams();
      const context = http.createContext();
      context.msg.text = "Original inbound text for native quotation.";
      if (directTopic) {
        context.threadSpec = { id: 77, scope: "direct-messages" };
      }
      await dispatchProgressTurn(
        async (options) => {
          await options?.onPartialReply?.({ text: answer });
          await streams[1]?.flush();
        },
        {
          mode: "progress",
          toolProgress: false,
          telegramDeps,
          context,
          replyToMode,
          telegramCfg: { richMessages },
          finalReply: { text: answer },
        },
      );
      const sends = acceptedCalls.filter(
        (call) => call.method === "sendMessage" || call.method === "sendRichMessage",
      );
      expect(sends).toHaveLength(2);
      if (directTopic) {
        expect(sends.every((call) => Number(call.fields.direct_messages_topic_id) === 77)).toBe(
          true,
        );
        expect(sends.every((call) => call.fields.message_thread_id === undefined)).toBe(true);
      }
      expect(sends.filter((call) => call.fields.reply_parameters !== undefined)).toHaveLength(
        replyToMode === "all" ? 2 : replyToMode === "off" ? 0 : 1,
      );
    },
  );

  it("preserves each accepted answer across assistant boundaries", async () => {
    const { streams, telegramDeps } = captureStreams();
    const first = "First accepted answer with its own independent preview.";
    let firstId: number | undefined;
    await dispatchProgressTurn(async () => undefined, {
      mode: "progress",
      toolProgress: false,
      telegramDeps,
      producer: async ({ dispatcher, replyOptions }) => {
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onPartialReply?.({ text: first });
        await streams[1]?.flush();
        firstId = streams[1]?.messageId();
        dispatcher.sendBlockReply({ text: first });
        const accepted = await dispatcher.waitForIdle();
        expect(accepted?.counts.block.delivered).toBe(1);
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onPartialReply?.({ text: answer });
        await streams[1]?.flush();
        expect(streams[1]?.messageId()).not.toBe(firstId);
        expect(visibleMessages.get(firstId!)).toBe(first);
        dispatcher.sendFinalReply({ text: answer });
        const counts = dispatcher.getQueuedCounts();
        return { queuedFinal: counts.final > 0, counts };
      },
    });
    expect([...visibleMessages.values()]).toEqual([first, answer]);
    expect(
      acceptedCalls.filter((call) => call.method === "sendMessage" && call.fields.text === first),
    ).toHaveLength(1);
  });
  it("keeps indexed queued answers and the final preview distinct", async () => {
    const first = setReplyPayloadMetadata(
      { text: "First queued assistant answer." },
      { assistantMessageIndex: 0 },
    );
    const second = setReplyPayloadMetadata(
      { text: "Second queued assistant answer." },
      { assistantMessageIndex: 1 },
    );
    await dispatchProgressTurn(async () => undefined, {
      mode: "progress",
      toolProgress: false,
      producer: async ({ dispatcher, replyOptions }) => {
        await replyOptions?.onBlockReplyQueued?.(first, { assistantMessageIndex: 0 });
        await replyOptions?.onBlockReplyQueued?.(second, { assistantMessageIndex: 1 });
        dispatcher.sendBlockReply(first);
        await http.waitForBotApiCall(
          (call) => call.method === "sendMessage" && call.fields.text === first.text,
        );
        dispatcher.sendBlockReply(second);
        dispatcher.sendFinalReply(second);
        const counts = dispatcher.getQueuedCounts();
        return { queuedFinal: counts.final > 0, counts };
      },
    });
    expect([...visibleMessages.values()]).toEqual([first.text, second.text]);
    expect(
      acceptedCalls.filter((call) => call.method === "sendMessage").map((call) => call.fields.text),
    ).toEqual([first.text, second.text]);
  });
});
