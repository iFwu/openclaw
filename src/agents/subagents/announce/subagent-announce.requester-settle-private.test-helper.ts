import { expect, it } from "vitest";
import {
  registryRuntimeMock,
  wakeParams,
} from "./subagent-announce.requester-settle-fixture.test-support.js";
import type { maybeWakeRequesterAfterAllChildrenSettled as WakeRequester } from "./subagent-announce.requester-settle-wake.js";
import {
  completeBatchSpy,
  deliverSpy,
  deliveredCallArg,
  makeSettledChild,
  transitionBatchSpy,
} from "./subagent-announce.requester-settle-wake.test-support.js";

export function registerPrivateRequesterSettleCompletionTests(
  maybeWakeRequesterAfterAllChildrenSettled: typeof WakeRequester,
) {
  it.each([
    { name: "delivered private pair", mixed: false, yielded: false, single: false },
    { name: "delivered mixed pair", mixed: true, yielded: false, single: false },
    { name: "yielded private child", mixed: false, yielded: true, single: true },
    { name: "yielded mixed pair", mixed: true, yielded: true, single: false },
  ])("keeps settled private results internal: $name", async ({ mixed, yielded, single }) => {
    const requesterModelSelection = {
      runId: "original-requester-turn",
      sessionId: "sess-main",
      provider: "selected-provider",
      model: "selected-primary",
      fallbacks: ["fallback-provider/fallback-model"],
    };
    const children = (single ? ["run-b"] : ["run-a", "run-b"]).map((runId, index) =>
      makeSettledChild({
        runId,
        requesterModelSelection,
        ...(!mixed || index === 0
          ? { completionTarget: "parent" as const, completionRequesterSessionId: "sess-main" }
          : {}),
        completion: {
          required: true,
          resultText: index === 0 ? "private marker" : "public sibling",
        },
        requesterSettleWake: {
          status: "pending",
          attemptCount: 0,
          ...(yielded
            ? { afterRequesterYield: true, requesterYieldBatch: true, rearmGeneration: 1 }
            : {}),
        },
      }),
    );
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);
    expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(true);
    expect(deliverSpy).toHaveBeenCalledOnce();
    expect(deliveredCallArg()).toMatchObject({
      completionTarget: "parent",
      completionRequesterSessionId: "sess-main",
      requireDirectDelivery: true,
      requesterModelSelection,
    });
    expect(transitionBatchSpy.mock.calls[0]?.[1]).toMatchObject({ requesterModelSelection });
    expect(deliveredCallArg().requireVisibleReply).toBeUndefined();
    expect(String(deliveredCallArg().triggerMessage)).toContain("private marker");
    expect(String(deliveredCallArg().triggerMessage)).toContain(
      "send it through an available, permitted messaging tool",
    );
    expect(String(deliveredCallArg().triggerMessage)).toContain(
      "briefly record the reviewed outcome and any remaining work",
    );
    expect(String(deliveredCallArg().triggerMessage)).not.toContain("NO_REPLY");
    expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(false);
    expect(deliverSpy).toHaveBeenCalledOnce();
    expect(completeBatchSpy.mock.calls[0]?.[2]).not.toHaveProperty(
      "requesterVisibleFinalDelivered",
    );
  });
}
