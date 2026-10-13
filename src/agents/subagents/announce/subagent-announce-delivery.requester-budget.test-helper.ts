import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { callGateway } from "../../../gateway/call.js";
import type { dispatchGatewayMethodInProcess } from "../../../gateway/server-plugins.js";
import {
  expectDeliveryPath,
  mockCallArg,
  taskCompletionEvents,
} from "../../subagent-test-fixtures.test-helpers.js";
import { deliverSubagentAnnouncement, testing } from "./subagent-announce-delivery.test-support.js";
import type { DeliveryContext } from "./subagent-announce-origin.js";

export function registerDormantCompletionRequesterBudgetTests(params: {
  createGatewayMock: () => typeof callGateway;
  createRoleRestrictedInProcessGatewayMock: (response: Record<string, unknown>) => {
    cfg: OpenClawConfig;
    dispatchGatewayMethodInProcess: typeof dispatchGatewayMethodInProcess;
  };
  expectInProcessAgentParams: (
    dispatch: typeof dispatchGatewayMethodInProcess,
    expected: Record<string, unknown>,
  ) => unknown;
  sentDeliveryStatus: { readonly status: "sent"; readonly resultCount: number };
  slackThreadOrigin: DeliveryContext;
}) {
  const {
    createGatewayMock,
    createRoleRestrictedInProcessGatewayMock,
    expectInProcessAgentParams,
    sentDeliveryStatus,
    slackThreadOrigin,
  } = params;
  it.each([undefined, 0, 600])(
    "delivers dormant child completion with requester budget %s under restrictive gateway roles",
    async (requesterRunTimeoutSeconds) => {
      const requesterModelSelection = {
        runId: "original-requester-turn",
        sessionId: "requester-session-local",
        provider: "selected-provider",
        model: "selected-primary",
        fallbacks: ["fallback-provider/fallback-model"],
      };
      const callGateway = createGatewayMock();
      const { cfg, dispatchGatewayMethodInProcess } = createRoleRestrictedInProcessGatewayMock({
        result: {
          deliveryStatus: sentDeliveryStatus,
          payloads: [{ text: "requester voice completion" }],
          meta: { finalAssistantVisibleText: "requester voice completion" },
        },
      });
      testing.setDepsForTest({
        callGateway,
        dispatchGatewayMethodInProcess,
        getRequesterSessionActivity: () => ({
          sessionId: "requester-session-local",
          isActive: false,
        }),
        getRuntimeConfig: () => cfg,
        loadSessionEntry: () => ({ sessionId: "requester-session-local", updatedAt: 1 }),
      });

      const ownerContext = { owner: "gateway-a" } as never;
      const resolveGatewayContext = () => ownerContext;
      const signal = new AbortController().signal;
      const result = await deliverSubagentAnnouncement({
        requesterSessionKey: "agent:main:slack:channel:C123:thread:171.222",
        targetRequesterSessionKey: "agent:main:slack:channel:C123:thread:171.222",
        requesterRunTimeoutSeconds,
        triggerMessage: "child done",
        steerMessage: "child done",
        requesterSessionOrigin: slackThreadOrigin,
        completionDirectOrigin: slackThreadOrigin,
        directOrigin: slackThreadOrigin,
        sourceSessionKey: "agent:main:subagent:child",
        internalEvents: taskCompletionEvents({
          childSessionKey: "agent:main:subagent:child",
          childSessionId: "child-session-local",
        }),
        requesterIsSubagent: false,
        expectsCompletionMessage: true,
        bestEffortDeliver: true,
        directIdempotencyKey: "announce-local-dispatch",
        requesterModelSelection,
        resolveGatewayContext,
        signal,
      });

      expectDeliveryPath(result, "direct");
      expect(result).toMatchObject({
        requesterVisibleFinalDelivered: true,
        finalAssistantVisibleText: "requester voice completion",
      });
      expect(callGateway).not.toHaveBeenCalled();
      expectInProcessAgentParams(dispatchGatewayMethodInProcess, {
        deliver: true,
        timeout: requesterRunTimeoutSeconds,
        channel: "slack",
        accountId: "acct-1",
        to: "channel:C123",
        threadId: "171.222",
        bestEffortDeliver: true,
      });
      const dispatchOptions = mockCallArg(dispatchGatewayMethodInProcess, 0, 2);
      expect(dispatchOptions).toMatchObject({
        cancelOnDeadline: true,
        expectFinal: true,
        forceSyntheticClient: true,
        operatorRoleActor: { kind: "system" },
        delegatedToolPolicyHandoff: {
          sourceSessionKey: "agent:main:subagent:child",
          sourceSessionId: "child-session-local",
          targetSessionKey: "agent:main:slack:channel:C123:thread:171.222",
          targetSessionId: "requester-session-local",
          idempotencyKey: "announce-local-dispatch",
          modelSelection: requesterModelSelection,
        },
        resolveGatewayContext,
        signal: expect.any(AbortSignal),
      });
    },
  );
}
