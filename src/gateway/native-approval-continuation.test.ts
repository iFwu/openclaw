import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindAdmittedRunApprovalRequesterSource,
  createApprovalRequesterSource,
} from "../agents/admitted-run-approval-origin.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { callGatewayTool } from "../agents/tools/gateway.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { canResolveOperatorApproval } from "./operator-approval-authorization.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import {
  createContext,
  createOperatorClient,
} from "./server-plugin-in-process-dispatch.test-support.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

vi.mock("./call.js", () => ({
  callGateway: () => {
    throw new Error("Network forbidden in approval continuation test");
  },
}));
const owners: PreparedAgentRunAdmission[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.close();
});

async function fixture(options: { qualified?: boolean; operator?: boolean } = {}) {
  const context = createContext();
  context.resolveGatewayContext = () => context;
  const connections: Array<string | undefined> = [];
  const handler = vi.fn(({ client, respond }: GatewayRequestHandlerOptions) => {
    expect(canResolveOperatorApproval(client)).toBe(false);
    expect(client?.internal?.approvalRuntime).not.toBe(true);
    expect(client?.internal?.agentRuntimeIdentity).toBeDefined();
    connections.push(client?.connId);
    respond(true, { id: "isolated-request" });
  });
  const resolve = vi.fn(({ respond }: GatewayRequestHandlerOptions) => respond(true, {}));
  context.getGatewayMethodRegistry = () =>
    createGatewayMethodRegistry([
      ...[
        "plugin.approval.request",
        "plugin.approval.waitDecision",
        "exec.approval.request",
        "exec.approval.waitDecision",
      ].map((name) => ({
        name,
        scope: "operator.approvals" as const,
        owner: { kind: "core" as const, area: "approval-continuation-test" },
        handler,
      })),
      ...["plugin.approval.resolve", "exec.approval.resolve", "approval.resolve"].map((name) => ({
        name,
        scope: "operator.approvals" as const,
        owner: { kind: "core" as const, area: "approval-continuation-test" },
        handler: resolve,
      })),
    ]);
  let current = true;
  const owner = prepareAgentRunAdmission({
    cfg: {},
    operationalRunInstance: createOperationalRunInstanceRef("native-approval-continuation"),
    facts: {
      runId: "native-approval-continuation",
      agentId: "main",
      ingress: { kind: "system", boundary: "retained-user-completion", state: "present" },
    },
    assertSourceCurrent: () => {
      if (!current) throw new Error("requester stopped");
    },
  });
  owners.push(owner);
  const admitted = await owner.admit("embedded");
  bindGatewayContextResolver(admitted, () => context);
  if (options.qualified !== false) {
    bindAdmittedRunApprovalRequesterSource(
      admitted,
      createApprovalRequesterSource(() => {
        if (!current) throw new Error("requester stopped");
      }),
    );
  }
  const caller = createAdmittedGatewayToolCallerIdentity({
    admittedRunContext: admitted,
    agentId: "main",
    sessionKey: "agent:main:requester",
  });
  const client = options.operator
    ? createOperatorClient({ profileName: "write-only-requester", scopes: ["operator.write"] })
    : createSyntheticPluginRuntimeClient({ operatorRoleActor: { kind: "system" } });
  const invoke = (method: string) =>
    withPluginRuntimeGatewayRequestScope(
      { client, context, resolveGatewayContext: () => context, isWebchatConnect: () => false },
      () =>
        withGatewayToolCallerIdentity(caller, () =>
          callGatewayTool(method, {}, { title: "Synthetic only", description: "No live receiver" }),
        ),
    );
  return {
    invoke,
    handler,
    resolve,
    owner,
    connections,
    stop: () => {
      current = false;
    },
  };
}

describe("native approval requester continuation", () => {
  it("requests and waits with the same exact run identity without becoming a reviewer", async () => {
    const test = await fixture();
    for (const method of [
      "plugin.approval.request",
      "plugin.approval.waitDecision",
      "exec.approval.request",
      "exec.approval.waitDecision",
    ]) {
      await expect(test.invoke(method)).resolves.toEqual({ id: "isolated-request" });
    }
    expect(test.handler).toHaveBeenCalledTimes(4);
    expect(test.connections[0]).toMatch(/^agent-runtime:/u);
    expect(new Set(test.connections).size).toBe(1);
    for (const method of ["plugin.approval.resolve", "exec.approval.resolve", "approval.resolve"]) {
      await expect(test.invoke(method)).rejects.toThrow("missing scope: operator.approvals");
    }
    expect(test.resolve).not.toHaveBeenCalled();
  });

  it.each(["unqualified", "write-only-operator", "stopped", "closed"] as const)(
    "does not grant request capability to a %s source",
    async (kind) => {
      const test = await fixture({
        qualified: kind !== "unqualified",
        operator: kind === "write-only-operator",
      });
      if (kind === "stopped") test.stop();
      if (kind === "closed") test.owner.close();
      await expect(test.invoke("plugin.approval.request")).rejects.toThrow();
      expect(test.handler).not.toHaveBeenCalled();
    },
  );
});
