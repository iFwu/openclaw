import { expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import { ApprovalRequesterAuthorityChangedError } from "../infra/approval-errors.js";
import { unwrapGatewayMethodDispatchResponse } from "./server-in-process-dispatch.js";
import { handleGatewayRequest } from "./server-methods.js";
import { createClient, createContext } from "./server-methods/approval.test-support.js";

it("preserves approval authority failure across the shared RPC and client response boundary", async () => {
  const error = new ApprovalRequesterAuthorityChangedError(
    ["access_revision_changed"],
    { phase: "post-decision", approvalId: "plugin:fixture" },
    { captured: { gateway: 1, profileAlias: 0 }, current: { gateway: 2, profileAlias: 0 } },
    ["synthetic-field"],
  );
  const respond = vi.fn();
  await handleGatewayRequest({
    req: {
      type: "req",
      id: "req-approval",
      method: "plugin.approval.waitDecision",
      params: { id: "plugin:fixture" },
    },
    respond,
    client: createClient({ internal: true }),
    isWebchatConnect: () => false,
    context: createContext(),
    extraHandlers: {
      "plugin.approval.waitDecision": () => {
        throw error;
      },
    },
  });
  const response = {
    code: "FORBIDDEN",
    message: error.message,
    details: {
      reason: "APPROVAL_REQUESTER_AUTHORITY_CHANGED",
      failures: ["access_revision_changed"],
      phase: "post-decision",
      approvalId: "plugin:fixture",
    },
  };
  expect(respond).toHaveBeenCalledExactlyOnceWith(false, undefined, response);
  expect(JSON.stringify(response)).not.toContain("accessRevision");
  expect(JSON.stringify(response)).not.toContain("synthetic-field");
  expect(() =>
    unwrapGatewayMethodDispatchResponse("plugin.approval.waitDecision", {
      ok: false,
      error: response,
    }),
  ).toThrow(GatewayClientRequestError);
  try {
    unwrapGatewayMethodDispatchResponse("plugin.approval.waitDecision", {
      ok: false,
      error: response,
    });
  } catch (caught) {
    expect(caught).toMatchObject({ gatewayCode: "FORBIDDEN", details: response.details });
  }
});
