import { describe, expect, it } from "vitest";
import {
  createGatewayMessageActionReceipt,
  readGatewayMessageActionReceipt,
} from "./message-action-receipt.js";

describe("Gateway message action receipts", () => {
  it.each([
    "sent",
    ["sent"],
    null,
    { ok: true, messageId: "sent" },
    { messageActionReceipt: { payload: "plugin field" } },
  ])("preserves the plugin payload %j", (payload) => {
    const receipt = createGatewayMessageActionReceipt(payload, "request");
    expect(readGatewayMessageActionReceipt(receipt, "request")).toEqual({
      payload,
      sessionRouteOwner: "gateway",
    });
  });
  it("does not treat a plugin route field as Gateway ownership", () => {
    const payload = {
      ok: true,
      messageActionReceipt: {
        sessionRouteOwner: "gateway",
        payload: "plugin-data",
        requestId: "not-this-request",
      },
    };
    expect(readGatewayMessageActionReceipt(payload, "request")).toEqual({ payload });
  });
});
