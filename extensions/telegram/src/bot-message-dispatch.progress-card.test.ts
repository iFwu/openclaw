import { projectProgressCardChannelUpdate } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  buildChannelProgressDraftLine,
  createChannelProgressDraftCompositor,
} from "openclaw/plugin-sdk/channel-outbound";
import { expect, it, vi } from "vitest";
import {
  createBot,
  createContext,
  createDirectSessionPayload,
  createTelegramDraftStream,
  deliverReplies,
  describeTelegramDispatch,
  emitToolStart,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  editMessageTelegram,
} from "./bot-message-dispatch.test-harness.js";
import type { DispatchReplyWithBufferedBlockDispatcherArgs } from "./bot-message-dispatch.test-harness.js";
import type * as TelegramDeliveryModule from "./bot/delivery.replies.js";
import type { TelegramDraftStream } from "./draft-stream.js";
import type * as TelegramDraftModule from "./draft-stream.js";
import { renderTelegramProgressDraftPreview } from "./progress-draft-preview.js";
import type * as TelegramEditModule from "./send-edit.js";

describeTelegramDispatch("dispatchTelegramMessage progress cards", () => {
  it.each([false, true])(
    "shows a card note beside its checklist and removes only the footer when the note is cleared (rich: %s)",
    async (richMessages) => {
      const progress = createChannelProgressDraftCompositor({
        entry: { streaming: { progress: { label: false } } },
        mode: "progress",
        active: true,
        seed: "checklist-note",
      });
      const plan = [
        { step: "Inspect", status: "completed" },
        { step: "Repair", status: "completed" },
        { step: "Verify", status: "completed" },
      ];
      const render = () =>
        renderTelegramProgressDraftPreview(progress.getSnapshot(), {
          richMessages,
          toolProgress: false,
          maxLines: 8,
          maxLineChars: 300,
        });
      try {
        const note = projectProgressCardChannelUpdate({
          markdown: "**Deployment verified**; configuration unchanged.",
          plan,
        })!;
        await progress.pushPlanProgress(note.steps, note);
        const preview = render();
        expect(preview.text).toContain("Inspect");
        expect(preview.text).toContain("Repair");
        expect(preview.text).toContain("Verify");
        expect(preview.text).toContain("🏷 Deployment verified; configuration unchanged.");
        expect(preview.text).not.toContain("3/3 complete");
        if (richMessages) {
          expect(preview.richMessage?.blocks.at(-1)).toEqual({
            type: "paragraph",
            text: "🏷 Deployment verified; configuration unchanged.",
          });
        }
        const checklistOnly = projectProgressCardChannelUpdate({ plan })!;
        await progress.pushPlanProgress(checklistOnly.steps, checklistOnly);
        const cleared = render();
        expect(cleared.text).toContain("Inspect");
        expect(cleared.text).toContain("Repair");
        expect(cleared.text).toContain("Verify");
        expect(cleared.text).not.toContain("🏷");
        expect(cleared.text).not.toContain("Deployment verified");
      } finally {
        progress.cancel();
      }
    },
  );

  it.each([false, true])(
    "keeps a full plan and recent activity after failed named tool items (rich: %s)",
    (richMessages) => {
      const commandLines = Array.from({ length: 8 }, (_, index) =>
        buildChannelProgressDraftLine(
          {
            event: "item",
            itemKind: "command",
            itemId: `command-${index}`,
            name: "exec",
            status: "failed",
            meta: `command ${index}`,
          },
          { commandText: "raw" },
        ),
      ).filter((line) => line !== undefined);
      const preview = renderTelegramProgressDraftPreview(
        {
          lines: [
            ...["automations", "read", "browser", "custom_command_runner"].map((name) =>
              buildChannelProgressDraftLine({
                event: "item",
                itemKind: "tool",
                itemId: `failed-${name}`,
                name,
                status: "failed",
              })!,
            ),
            ...commandLines,
          ],
          plan: [
            { step: "Inspect", status: "completed" },
            { step: "Repair", status: "in_progress" },
            { step: "Verify", status: "pending" },
          ],
        },
        { richMessages, toolProgress: true, maxLines: 5, maxLineChars: 300 },
      );
      expect(preview.text).toContain("Inspect");
      expect(preview.text).toContain("Repair");
      expect(preview.text).toContain("Verify");
      expect(preview.text).toContain("command 7");
      expect(preview.text).not.toContain("command 0");
      expect(preview.text).not.toContain("Automations");
      expect(preview.text).not.toContain("Browser");
      expect(preview.text).not.toContain("Custom Command Runner");
    },
  );

  it.each([false, true])(
    "shows a fresh named failure before newer activity replaces it (rich: %s)",
    (richMessages) => {
      const failed = buildChannelProgressDraftLine({
        event: "item",
        itemKind: "tool",
        name: "read",
        status: "failed",
      })!;
      const plan = [
        { step: "Inspect", status: "completed" as const },
        { step: "Repair", status: "in_progress" as const },
        { step: "Verify", status: "pending" as const },
      ];
      const options = { richMessages, toolProgress: true, maxLines: 3, maxLineChars: 300 };
      const initial = renderTelegramProgressDraftPreview({ lines: [failed], plan }, options);
      expect(initial.text).toContain("Read");
      expect(initial.text).toContain("Repair");

      const after = renderTelegramProgressDraftPreview(
        {
          lines: [failed, buildChannelProgressDraftLine({ event: "tool", name: "browser" })!],
          plan,
        },
        options,
      );
      expect(after.text).not.toContain("Read");
      expect(after.text).toContain("Browser");
      expect(after.text).toContain("Repair");
    },
  );

  it.each([false, true])(
    "keeps the latest status below commentary and diff stats without treating final markers as a renderer collapse signal (rich: %s)",
    async (richMessages) => {
      const progress = createChannelProgressDraftCompositor({
        preparedItems: true,
        entry: { streaming: { progress: { commentary: true, label: false } } },
        mode: "progress",
        active: true,
        seed: "status-footer",
        commentaryItalics: false,
        commentaryLinePrefix: "💬 ",
      });
      const render = () =>
        renderTelegramProgressDraftPreview(
          { ...progress.getSnapshot(), diffStat: { files: 2, added: 13, removed: 5 } },
          { richMessages, toolProgress: true, maxLines: 4, maxLineChars: 300 },
        );
      try {
        await progress.pushItemEvent({
          kind: "preamble",
          itemId: "inspect",
          phase: "end",
          progressText: "Checking the existing routes.",
        });
        await progress.pushPlanProgress([], {
          explanation: "Inspecting configuration.",
          explanationFormat: "plain",
        });
        expect(render().text).toContain("Inspecting configuration.");
        await progress.pushItemEvent({
          kind: "preamble",
          itemId: "verify",
          phase: "end",
          progressText: "Routes saved; checking the outer fallback.",
        });
        const status = "Configuration verified; waiting for restart authorization.";
        await progress.pushPlanProgress([], { explanation: status, explanationFormat: "plain" });
        const preview = render();
        const text = preview.text;
        expect(text).not.toContain("Inspecting configuration.");
        expect(text).toContain("Checking the existing routes.");
        expect(text.indexOf("Checking the existing routes.")).toBeLessThan(
          text.indexOf("Routes saved; checking the outer fallback."),
        );
        expect(text.indexOf("Routes saved; checking the outer fallback.")).toBeLessThan(
          text.indexOf("📝 2 files +13 −5"),
        );
        expect(text.indexOf("📝 2 files +13 −5")).toBeLessThan(text.indexOf(`🏷 ${status}`));
        if (richMessages) {
          expect(preview.richMessage?.blocks.at(-1)).toEqual({
            type: "paragraph",
            text: `🏷 ${status}`,
          });
        } else {
          expect(text.endsWith(`<br>🏷 ${status}`)).toBe(true);
        }
        progress.markFinalReplyStarted();
        progress.markFinalReplyDelivered();
        expect(render()).toEqual(preview);
        const collapsed = renderTelegramProgressDraftPreview(
          { ...progress.getSnapshot(), diffStat: { files: 2, added: 13, removed: 5 } },
          {
            richMessages,
            toolProgress: true,
            maxLines: 4,
            maxLineChars: 300,
            collapseStatus: true,
          },
        );
        if (richMessages) {
          expect(collapsed.richMessage?.blocks.slice(0, -1)).toEqual(
            preview.richMessage?.blocks.slice(0, -1),
          );
          expect(collapsed.richMessage?.blocks.at(-1)).toEqual({
            type: "details",
            summary: "🏷",
            blocks: [{ type: "paragraph", text: `🏷 ${status}` }],
          });
        } else {
          expect(collapsed.text).toBe(
            text.replace(`🏷 ${status}`, `<blockquote expandable>🏷 ${status}</blockquote>`),
          );
        }
      } finally {
        progress.cancel();
      }
    },
  );

  it("characterizes the original two-commentary/two-exit-1 card at native capacity", async () => {
    const progress = createChannelProgressDraftCompositor({
      preparedItems: true,
      entry: {
        streaming: {
          mode: "progress",
          progress: { commentary: true, toolProgress: true, maxLines: 4, label: false },
        },
      },
      mode: "progress",
      active: true,
      seed: "overflow-fixture",
      commentaryItalics: false,
      commentaryLinePrefix: "💬 ",
    });
    try {
      await progress.pushItemEvent({
        kind: "preamble",
        itemId: "jev",
        phase: "end",
        progressText: "Checking Jev.",
      });
      await progress.pushItemEvent({
        kind: "preamble",
        itemId: "upgrade",
        phase: "end",
        progressText: "Checking the upgrade.",
      });
      for (let index = 0; index < 2; index++) {
        await progress.pushItemEvent({
          kind: "command",
          itemId: `exit-${index}`,
          name: "exec",
          status: "failed",
          meta: "exit 1",
        });
      }
      const preview = renderTelegramProgressDraftPreview(progress.getSnapshot(), {
        richMessages: false,
        toolProgress: true,
        maxLines: 4,
        maxLineChars: 300,
      });
      expect(preview.text).toContain("Checking Jev.");
      expect(preview.text).toContain("Checking the upgrade.");
      expect(progress.getSnapshot().lines).toHaveLength(4);
      // More failures still roll older commentary out: shared capacity is a separate owner gap.
      await progress.pushItemEvent({
        kind: "command",
        itemId: "exit-2",
        name: "exec",
        status: "failed",
        meta: "exit 1",
      });
      expect(
        progress
          .getSnapshot()
          .lines.some((line) => typeof line !== "string" && line.id === "commentary:jev"),
      ).toBe(false);
    } finally {
      progress.cancel();
    }
  });

  // The real compositor, renderer and transport expose short sends, stopped
  // streams and lifecycle resets at Telegram's stubbed network boundary.
  it.each([
    { mode: "progress", finalDelivery: "dispatcher", persist: false },
    { mode: "progress", finalDelivery: "message-tool", persist: false },
    { mode: "progress", finalDelivery: "dispatcher", persist: true },
    { mode: "progress", finalDelivery: "message-tool", persist: true },
  ] as const)(
    "keeps cards and accepted answers across tool, final and queued transitions ($mode, $finalDelivery, persist $persist)",
    async ({ mode, finalDelivery, persist }) => {
      vi.useFakeTimers();
      try {
        let queuedReplyOptions: DispatchReplyWithBufferedBlockDispatcherArgs["replyOptions"];
        const actualDraft = await vi.importActual<typeof TelegramDraftModule>("./draft-stream.js");
        const actualDelivery = await vi.importActual<typeof TelegramDeliveryModule>(
          "./bot/delivery.replies.js",
        );
        const actualEdit = await vi.importActual<typeof TelegramEditModule>("./send-edit.js");
        deliverReplies.mockImplementation(actualDelivery.deliverStructuredReplies);
        editMessageTelegram.mockImplementation(actualEdit.editMessageTelegram);
        let draft: TelegramDraftStream | undefined;
        createTelegramDraftStream.mockImplementation((params) => {
          const stream = actualDraft.createTelegramDraftStream(params);
          draft ??= stream;
          return stream;
        });
        const bot = createBot();
        let nextMessageId = 1001;
        const visible = new Map<number, string>();
        const send = vi.spyOn(bot.api, "sendMessage").mockImplementation(async (_chatId, text) => {
          const message_id = nextMessageId++;
          visible.set(message_id, text);
          return {
            message_id,
            date: 0,
            chat: { id: 123, type: "private", first_name: "Fixture" },
            text,
          };
        });
        const edit = vi
          .spyOn(bot.api, "editMessageText")
          .mockImplementation(async (_chatId, messageId, text) => {
            if (typeof text !== "string") {
              throw new Error("Expected a plain-text Telegram edit");
            }
            visible.set(messageId, text);
            return true;
          });
        vi.spyOn(bot.api, "deleteMessage").mockImplementation(async (_chatId, messageId) => {
          visible.delete(messageId);
          return true;
        });
        dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
          async ({ dispatcherOptions, replyOptions }) => {
            queuedReplyOptions = replyOptions;
            await replyOptions?.onAssistantMessageStart?.();
            await replyOptions?.onPlanUpdate?.({ phase: "update", steps: [] });
            await draft?.flush();
            expect(send).not.toHaveBeenCalled();

            await replyOptions?.onAssistantMessageStart?.();
            await replyOptions?.onPlanUpdate?.({
              phase: "update",
              explanation: "Working",
              steps: [],
            });
            await draft?.flush();
            expect(send).toHaveBeenCalledOnce();
            expect([...visible.values()]).toEqual(["<b>Working</b>"]);

            await replyOptions?.onAssistantMessageStart?.();
            await replyOptions?.onPlanUpdate?.({
              phase: "update",
              explanation: "1/2 complete",
              steps: [
                { step: "Inspect", status: "completed" },
                { step: "Repair", status: "in_progress" },
              ],
            });
            await draft?.flush();
            expect(send).toHaveBeenCalledOnce();
            expect([...visible.values()][0]).toContain("[x] Inspect");
            expect([...visible.values()][0]).not.toContain("Working");

            await replyOptions?.onAssistantMessageStart?.();
            await replyOptions?.onPlanUpdate?.({ phase: "update", steps: [] });
            await vi.advanceTimersByTimeAsync(4_000);
            expect(visible.size).toBe(0);

            await replyOptions?.onAssistantMessageStart?.();
            await replyOptions?.onPlanUpdate?.({
              phase: "update",
              explanation: "Resumed",
              steps: [{ step: "Resume work", status: "in_progress" }],
            });
            await draft?.flush();
            expect(send).toHaveBeenCalledTimes(2);
            expect([...visible.values()][0]).toContain("🏷 Resumed");
            expect([...visible.values()][0]).toContain("Resume work (in progress)");

            await replyOptions?.onAssistantMessageStart?.();
            await replyOptions?.onItemEvent?.({
              kind: "tool",
              name: "progress_card",
              itemId: "blocked-card",
              status: "blocked",
            });
            await draft?.flush();
            expect([...visible.values()][0]).toContain("Resume work (in progress)");
            expect([...visible.values()][0]).toContain("Progress Card");
            expect([...visible.values()][0]).toContain("blocked");

            await replyOptions?.onBlockReplyQueued?.({ text: "Checking the result" });
            await dispatcherOptions.deliver({ text: "Checking the result" }, { kind: "block" });

            await replyOptions?.onAssistantMessageStart?.();
            await replyOptions?.onToolStart?.({
              phase: "start",
              name: "exec",
              toolCallId: "exec-proof",
              args: { command: "printf proof" },
            });
            await replyOptions?.onItemEvent?.({
              itemId: "tool:exec-proof",
              toolCallId: "exec-proof",
              name: "exec",
              kind: "tool",
              phase: "start",
              status: "running",
              title: "Exec",
            });
            await replyOptions?.onReasoningEnd?.();
            await draft?.flush();
            const resumedCard = [...visible.values()].find((text) => text.includes("Exec"));
            expect(resumedCard).toContain("Resume work (in progress)");
            expect(resumedCard).toContain("blocked");

            await replyOptions?.onAssistantMessageStart?.();
            await replyOptions?.onPlanUpdate?.({ phase: "update", steps: [] });
            await draft?.flush();
            const toolCard = [...visible.values()].find((text) => text.includes("Exec"));
            expect(toolCard).not.toContain("Resumed");
            expect(toolCard).not.toContain("Resume work");

            await replyOptions?.onAssistantMessageStart?.();
            if (finalDelivery === "message-tool") {
              await bot.api.sendMessage(123, "Done");
              await replyOptions?.onObservedReplyDelivery?.();
              await vi.advanceTimersByTimeAsync(4_000);
              // NO_REPLY never enters the final dispatcher; retire before turn settlement.
              if (persist) {
                expect([...visible.values()]).toContain("Done");
                expect([...visible.values()].some((text) => text.includes("Exec"))).toBe(true);
              } else {
                expect.soft([...visible.values()]).toEqual(["Checking the result", "Done"]);
              }
            } else {
              await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
            }
            expect([...visible.values()]).toContain("Done");
            const finalMessages = [...visible.entries()];
            const sendsAfterFinal = send.mock.calls.length;
            const editsAfterFinal = edit.mock.calls.length;
            await replyOptions?.onAssistantMessageStart?.();
            await replyOptions?.onPlanUpdate?.({
              phase: "update",
              explanation: "Late card",
              steps: [],
            });
            await replyOptions?.onToolStart?.({
              name: "exec",
              phase: "start",
              toolCallId: "late-raw",
            });
            await replyOptions?.onItemEvent?.({
              itemId: "tool:late-prepared",
              toolCallId: "late-prepared",
              kind: "tool",
              name: "exec",
              title: "Late prepared tool",
              phase: "start",
              status: "running",
            });
            await draft?.flush();
            expect(send).toHaveBeenCalledTimes(sendsAfterFinal);
            expect(edit).toHaveBeenCalledTimes(editsAfterFinal);
            expect([...visible.entries()]).toEqual(finalMessages);
            return { queuedFinal: finalDelivery === "dispatcher" };
          },
        );

        await dispatchWithContext({
          bot,
          cfg: {
            agents: { defaults: { reasoningDefault: "stream" } },
            channels: { telegram: { botToken: "test-token" } },
          },
          context: createContext({
            ctxPayload: createDirectSessionPayload(),
            threadSpec: { id: undefined, scope: "none" },
            replyThreadId: undefined,
          }),
          streamMode: mode,
          telegramCfg: {
            streaming: {
              mode,
              progress: { toolProgress: true, persist },
              preview: { toolProgress: true },
            },
          },
        });
        await vi.runOnlyPendingTimersAsync();
        expect([...visible.values()]).toContain("Done");
        if (persist) {
          expect([...visible.values()].some((text) => text.includes("Exec"))).toBe(true);
        } else {
          expect([...visible.values()]).toEqual(["Checking the result", "Done"]);
        }
        if (finalDelivery === "dispatcher") {
          const finalMessageId = [...visible.entries()].find(([, text]) => text === "Done")?.[0];
          const settledMessages = [...visible.entries()];
          const settledIds = new Set(visible.keys());
          await queuedReplyOptions?.onQueuedFollowupAdmitted?.();
          await emitToolStart(queuedReplyOptions, {
            name: "exec",
            toolCallId: "followup",
            phase: "start",
          });
          await vi.advanceTimersByTimeAsync(1500);
          await draft?.flush();
          expect(visible.get(finalMessageId ?? -1)).toBe("Done");
          expect([...visible.entries()].filter(([id]) => settledIds.has(id))).toEqual(
            settledMessages,
          );
          const followupMessages = [...visible.entries()].filter(([id]) => !settledIds.has(id));
          expect(followupMessages).toEqual([[expect.any(Number), expect.stringContaining("Exec")]]);
          await queuedReplyOptions?.onQueuedFollowupSettled?.();
          await vi.runOnlyPendingTimersAsync();
          expect([...visible.entries()]).toEqual(
            persist ? [...settledMessages, ...followupMessages] : settledMessages,
          );
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
