import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

/** Gateway-owned metadata stays separate from the plugin's arbitrary result shape. */
export function createGatewayMessageActionReceipt(
  payload: unknown,
  requestId: string,
): Record<string, unknown> {
  return {
    ...asOptionalRecord(payload),
    messageActionReceipt: { sessionRouteOwner: "gateway", requestId, payload },
  };
}

export function readGatewayMessageActionReceipt(
  payload: unknown,
  requestId: string,
): {
  payload: unknown;
  sessionRouteOwner?: "gateway";
} {
  const receipt = asOptionalRecord(asOptionalRecord(payload)?.messageActionReceipt);
  return receipt?.sessionRouteOwner === "gateway" &&
    receipt.requestId === requestId &&
    Object.hasOwn(receipt, "payload")
    ? { payload: receipt.payload, sessionRouteOwner: "gateway" }
    : { payload };
}
