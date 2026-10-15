import { expect, it, vi, type Mock } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type { dispatchChannelMessageAction } from "../../channels/plugins/message-action-dispatch.js";
import { createChannelPartialDeliveryError } from "../../channels/turn/partial-delivery-error.js";
import { createGatewayMessageActionReceipt } from "../../infra/outbound/message-action-receipt.js";
import type {
  ensureOutboundSessionEntry,
  resolveOutboundSessionRoute,
} from "../../infra/outbound/outbound-session.js";
import { directCliClientForTests, firstRespondCall } from "./send.test-helpers.js";
import type {
  createMessageMethodPluginFixtures,
  createMessageMethodTestDriver,
} from "./send.test-support.js";
import { makeContext } from "./send.test-support.js";

type RouteTestHarness = Pick<
  ReturnType<typeof createMessageMethodTestDriver>,
  "runMessageActionRequest" | "runSend"
> &
  Pick<ReturnType<typeof createMessageMethodPluginFixtures>, "registerMessageActionPlugin"> & {
    mockDeliverySuccess: (messageId: string) => void;
    mocks: {
      getRuntimeConfigSnapshot: Mock;
      getRuntimeConfigSourceSnapshot: Mock;
      resolveOutboundSessionRoute: Mock<typeof resolveOutboundSessionRoute>;
      ensureOutboundSessionEntry: Mock<typeof ensureOutboundSessionEntry>;
      dispatchChannelMessageAction: Mock<typeof dispatchChannelMessageAction>;
      appendAssistantMessageToSessionTranscript: Mock<() => Promise<unknown>>;
    };
  };

export function registerMessageActionSessionRouteTests({
  mocks,
  runMessageActionRequest,
  registerMessageActionPlugin,
  runSend,
  mockDeliverySuccess,
}: RouteTestHarness) {
  it("does not read the runtime config snapshot for send requests", async () => {
    mockDeliverySuccess("m-no-runtime-config-read");

    await runSend({
      to: "channel:C1",
      message: "hi",
      channel: "slack",
      idempotencyKey: "idem-send-no-runtime-config-read",
    });

    expect(mocks.getRuntimeConfigSnapshot).not.toHaveBeenCalled();
    expect(mocks.getRuntimeConfigSourceSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    { name: "accepted", payload: { ok: true, messageId: "route-send" }, writes: 1 },
    {
      name: "partial",
      payload: { ok: false, sentBeforeError: true, messageId: "route-part" },
      writes: 1,
    },
    { name: "failed", payload: { ok: false, error: "not sent" }, writes: 0 },
    { name: "suppressed", payload: { status: "suppressed" }, writes: 0 },
    { name: "primitive", payload: "sent", writes: 1 },
    { name: "array", payload: ["sent"], writes: 1 },
  ])("owns CLI send route persistence for $name delivery", async ({ payload, writes }) => {
    registerMessageActionPlugin({ registrySuffix: "cli-route-owner", chatType: "group" });
    const route = {
      sessionKey: "agent:main:telegram:group:-123:topic:456",
      baseSessionKey: "agent:main:telegram:group:-123",
      peer: { kind: "group" as const, id: "-123" },
      chatType: "group" as const,
      from: "telegram:group:-123:topic:456",
      to: "-123",
      threadId: "456",
    };
    mocks.resolveOutboundSessionRoute.mockResolvedValue(route);
    mocks.dispatchChannelMessageAction.mockImplementationOnce(async () => {
      expect(mocks.ensureOutboundSessionEntry).not.toHaveBeenCalled();
      return jsonResult(payload);
    });
    const { respond } = await runMessageActionRequest(
      {
        channel: "telegram",
        action: "send",
        params: {
          to: "-123",
          threadId: "456",
          message: "hello",
          __sessionRouteOwner: "cli-route-receipt",
        },
        agentId: "main",
        idempotencyKey: "cli-route-receipt",
      },
      directCliClientForTests(),
    );
    expect(firstRespondCall(respond)[0]).toBe(true);
    expect(firstRespondCall(respond)[1]).toEqual(
      createGatewayMessageActionReceipt(payload, "cli-route-receipt"),
    );
    expect(mocks.ensureOutboundSessionEntry).toHaveBeenCalledTimes(writes);
    if (writes) {
      expect(mocks.ensureOutboundSessionEntry.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          route,
          channel: "telegram",
          sourceSessionKey: undefined,
        }),
      );
    }
    expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
  });
  it.each([
    { name: "numeric", fields: { threadId: 456 } },
    { name: "native alias", fields: { messageThreadId: 456 } },
    { name: "canonical", fields: { threadId: "456" } },
  ])("keeps the send account and $name thread in the route", async ({ fields }) => {
    const plugin = registerMessageActionPlugin({ registrySuffix: "account-thread-route" });
    plugin.config.listAccountIds = () => ["primary", "secondary"];
    plugin.config.defaultAccountId = () => "secondary";
    mocks.dispatchChannelMessageAction.mockResolvedValueOnce(
      jsonResult({ ok: true, messageId: "thread-send" }),
    );
    const { respond } = await runMessageActionRequest(
      {
        channel: "telegram",
        action: "send",
        agentId: "main",
        params: {
          to: "-123",
          message: "hello",
          ...fields,
          __sessionRouteOwner: "thread-account-route",
        },
        idempotencyKey: "thread-account-route",
      },
      directCliClientForTests(),
    );
    expect(firstRespondCall(respond)[0]).toBe(true);
    expect(mocks.dispatchChannelMessageAction).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "secondary",
        params: expect.objectContaining({ threadId: "456", accountId: "secondary" }),
      }),
    );
    expect(mocks.resolveOutboundSessionRoute).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "secondary", threadId: "456", target: "-123" }),
    );
    expect(mocks.ensureOutboundSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "secondary" }),
    );
  });

  it("retains route ownership on a thrown partial-delivery error and its replay", async () => {
    registerMessageActionPlugin({ registrySuffix: "partial-route-owner" });
    mocks.dispatchChannelMessageAction.mockRejectedValueOnce(
      createChannelPartialDeliveryError(new Error("second part failed"), {
        visibleReplySent: true,
        messageIds: ["partial-id"],
      }),
    );
    const context = makeContext();
    const request = {
      channel: "telegram",
      action: "send",
      agentId: "main",
      params: { to: "-123", message: "hello", __sessionRouteOwner: "partial-route-owner" },
      idempotencyKey: "partial-route-owner",
    };
    const first = await runMessageActionRequest(
      structuredClone(request),
      directCliClientForTests(),
      context,
    );
    const replay = await runMessageActionRequest(
      structuredClone(request),
      directCliClientForTests(),
      context,
    );
    const response = firstRespondCall(first.respond);
    expect(response[0]).toBe(false);
    expect(response[2]?.details).toMatchObject({
      messageActionReceipt: { sessionRouteOwner: "gateway" },
      partialDelivery: { visibleReplySent: true },
    });
    expect(firstRespondCall(replay.respond)[2]).toEqual(response[2]);
    expect(mocks.ensureOutboundSessionEntry).toHaveBeenCalledOnce();
    expect(mocks.dispatchChannelMessageAction).toHaveBeenCalledOnce();
  });
}
