import { describe, expect, it, vi } from "vitest";
import { telegramApprovalNativeRuntime } from "./approval-handler.runtime.js";

describe("Telegram fallback approval delivery", () => {
  it.each(["preferred", "fallback"] as const)(
    "decorates only %s delivery and preserves callback buttons/account",
    async (reason) => {
      const sendMessage = vi
        .fn()
        .mockResolvedValue({ chatId: "123", messageId: "synthetic-message" });
      const buttons = [
        [
          { text: "Allow Once", callback_data: "tga1:p:o:plugin:fallback" },
          { text: "Deny", callback_data: "tga1:p:d:plugin:fallback" },
        ],
      ];
      await telegramApprovalNativeRuntime.transport.deliverPending({
        cfg: {},
        accountId: "secondary",
        context: {
          token: "synthetic",
          deps: { sendMessage, sendTyping: vi.fn().mockResolvedValue(undefined) },
        },
        plannedTarget: { surface: "approver-dm", target: { to: "123" }, reason },
        preparedTarget: { chatId: "123" },
        pendingPayload: { text: "Sensitive operation", buttons },
        approvalKind: "plugin",
        request: {
          approvalKind: "plugin",
          id: "plugin:fallback",
          request: {
            title: "Sensitive operation",
            description: "Synthetic",
            sessionKey: "agent:main:telegram:group:-42",
            turnSourceChannel: "telegram",
            turnSourceTo: "-42",
          },
          createdAtMs: 0,
          expiresAtMs: 60_000,
        },
        view: {
          approvalKind: "plugin",
          phase: "pending",
          severity: "info",
          approvalId: "plugin:fallback",
          title: "Sensitive operation",
          description: "Synthetic",
          metadata: [],
          actions: [],
          expiresAtMs: 60_000,
        },
      });
      expect(sendMessage).toHaveBeenCalledWith(
        "123",
        reason === "preferred"
          ? "Sensitive operation"
          : expect.stringMatching(/^⚠️ 审批兜底到私聊：/),
        expect.objectContaining({ accountId: "secondary", buttons }),
      );
      if (reason === "fallback") {
        const text = sendMessage.mock.calls[0]?.[1];
        if (typeof text !== "string") {
          throw new Error("missing fallback text");
        }
        expect(text).toContain("原会话：agent:main:telegram:group:-42");
        expect(text).toContain("原来源：telegram / -42");
        expect(text).toContain("投递未确认");
        expect(text).not.toContain("failed");
      }
    },
  );
});

describe("Telegram pending send boundary", () => {
  it("does not send a card after a typing await loses host approval validity", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ chatId: "123", messageId: "unexpected" });
    let active = true;
    const reason = "fallback" as const;
    await telegramApprovalNativeRuntime.transport.deliverPending({
      cfg: {},
      shouldSend: () => active,
      accountId: "secondary",
      context: {
        token: "synthetic",
        deps: {
          sendMessage,
          sendTyping: async () => {
            active = false;
          },
        },
      },
      plannedTarget: { surface: "approver-dm", target: { to: "123" }, reason },
      preparedTarget: { chatId: "123" },
      pendingPayload: { text: "Sensitive operation", buttons: [] },
      approvalKind: "plugin",
      request: {
        approvalKind: "plugin",
        id: "plugin:fallback",
        request: {
          title: "Sensitive operation",
          description: "Synthetic",
          sessionKey: "agent:main:telegram:group:-42",
          turnSourceChannel: "telegram",
          turnSourceTo: "-42",
        },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      view: {
        approvalKind: "plugin",
        phase: "pending",
        severity: "info",
        approvalId: "plugin:fallback",
        title: "Sensitive operation",
        description: "Synthetic",
        metadata: [],
        actions: [],
        expiresAtMs: 60_000,
      },
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("Telegram prepared approval targets", () => {
  it("dedupes encoded forum topics and keeps direct-message topics distinct", async () => {
    const prepare = (to: string, threadId?: string) =>
      telegramApprovalNativeRuntime.transport.prepareTarget({
        cfg: {},
        approvalKind: "exec",
        request: {
          id: "topic",
          request: { command: "echo topic" },
          createdAtMs: 0,
          expiresAtMs: 60_000,
        },
        view: {} as never,
        pendingPayload: { text: "pending", buttons: [] },
        plannedTarget: { surface: "origin", reason: "preferred", target: { to, threadId } },
      });
    const encoded = await prepare("telegram:-42:topic:17");
    const separate = await prepare("-42", "-42:17");
    const direct = await prepare("-42:direct-topic:17", "99");
    expect(encoded?.target).toEqual({
      chatId: "-42",
      messageThreadId: 17,
      directMessagesTopicId: undefined,
    });
    expect(separate?.dedupeKey).toBe(encoded?.dedupeKey);
    expect(direct?.target).toEqual({
      chatId: "-42",
      messageThreadId: undefined,
      directMessagesTopicId: 17,
    });
    expect(direct?.dedupeKey).not.toBe(encoded?.dedupeKey);
  });
});
