import { describe, expect, it } from "vitest";
import { createHarness } from "./lane-delivery.test-support.js";

describe("Telegram visible answer finalization without new preview authority", () => {
  it("finalizes the same visible message when new streaming is disabled", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    harness.lanes.answer.hasStreamedMessage = true;
    harness.answer?.update("Visible answer preview");
    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "Accepted answer final",
      payload: { text: "Accepted answer final" },
      infoKind: "final",
      allowStream: false,
    });
    expect(result).toMatchObject({
      kind: "preview-finalized",
      delivery: { messageId: 999, content: "Accepted answer final" },
    });
    expect(harness.sendPayload).not.toHaveBeenCalled();
    expect(harness.clearDraftLane).not.toHaveBeenCalled();
  });

  it("does not repurpose a visible preview for another explicit native reply target", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    harness.lanes.answer.hasStreamedMessage = true;
    harness.answer?.update("Visible answer preview");
    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "A separate quoted answer",
      payload: { text: "A separate quoted answer", replyToId: "456", replyToTag: true },
      infoKind: "final",
      allowStream: false,
    });
    expect(result.kind).toBe("sent");
    expect(harness.sendPayload).toHaveBeenCalledWith(
      expect.objectContaining({ replyToId: "456", replyToTag: true }),
      expect.objectContaining({ durable: true }),
    );
    expect(harness.editStreamMessage).not.toHaveBeenCalled();
  });
});
