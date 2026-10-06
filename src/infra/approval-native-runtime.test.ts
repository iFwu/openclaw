// Covers native approval runtime delivery and resolution.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelApprovalNativeAdapter } from "../channels/plugins/types.adapters.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withGatewayNativeApprovalRuntime } from "./approval-gateway-runtime-context.js";
import { createApprovalNativeRouteCoordinator } from "./approval-native-route-coordinator.js";
import {
  createChannelNativeApprovalRuntime as createChannelNativeApprovalRuntimeRaw,
  deliverApprovalRequestViaChannelNativePlan,
} from "./approval-native-runtime.js";

const hoisted = vi.hoisted(() => ({
  callGatewayLeastPrivilege: vi.fn(async () => ({ ok: true })),
  createOperatorApprovalsGatewayClient: vi.fn(
    async (params: { onHelloOk?: (hello: unknown) => void }) => {
      queueMicrotask(() => params.onHelloOk?.({ type: "hello-ok" }));
      return {
        request: vi.fn(async () => ({ ok: true })),
        stop: vi.fn(),
      };
    },
  ),
  startGatewayClientWhenEventLoopReady: vi.fn(async () => ({
    ready: true,
    aborted: false,
  })),
}));

vi.mock("../gateway/call.js", () => ({
  callGatewayLeastPrivilege: hoisted.callGatewayLeastPrivilege,
}));

vi.mock("../gateway/operator-approvals-client.js", () => ({
  createOperatorApprovalsGatewayClient: hoisted.createOperatorApprovalsGatewayClient,
}));

vi.mock("../../packages/gateway-client/src/readiness.js", () => ({
  startGatewayClientWhenEventLoopReady: hoisted.startGatewayClientWhenEventLoopReady,
}));

const execRequest = {
  id: "approval-1",
  request: {
    command: "uname -a",
  },
  createdAtMs: 0,
  expiresAtMs: 120_000,
};

const approvalRuntimes: Array<ReturnType<typeof createChannelNativeApprovalRuntimeRaw>> = [];

function createChannelNativeApprovalRuntime(
  params: Parameters<typeof createChannelNativeApprovalRuntimeRaw>[0],
) {
  const runtime = createChannelNativeApprovalRuntimeRaw(params);
  approvalRuntimes.push(runtime);
  return runtime;
}

afterEach(async () => {
  await Promise.all(approvalRuntimes.splice(0).map((runtime) => runtime.stop()));
  hoisted.callGatewayLeastPrivilege.mockClear();
  hoisted.createOperatorApprovalsGatewayClient.mockClear();
  hoisted.startGatewayClientWhenEventLoopReady.mockClear();
  vi.useRealTimers();
});

const requireRecord = createRequireRecord("record", "expected-non-array-record");

function mockCallArg(mock: ReturnType<typeof vi.fn>, index = 0): Record<string, unknown> {
  const arg = mock.mock.calls[index]?.[0];
  return requireRecord(arg);
}

describe("deliverApprovalRequestViaChannelNativePlan", () => {
  it.each(["throw", "null", "prepare-null"] as const)(
    "does not add an implicit system-agent DM backup after origin failure (%s)",
    async (outcome) => {
      const resolveApproverDmTargets = vi.fn(() => [{ to: "owner" }]);
      const physical = vi.fn(({ plannedTarget }: { plannedTarget: { surface: string } }) => {
        if (plannedTarget.surface === "origin") {
          if (outcome === "null") {
            return null;
          }
          throw new Error("Origin failed");
        }
        return { to: "owner" };
      });
      const result = await deliverApprovalRequestViaChannelNativePlan({
        cfg: {},
        accountId: "ops",
        approvalKind: "system-agent",
        request: {
          id: "system-agent:origin-only",
          request: { title: "Change", description: "Bounded", proposalHash: "a".repeat(64) },
          createdAtMs: 0,
          expiresAtMs: 120000,
        },
        adapter: {
          describeDeliveryCapabilities: () => ({
            enabled: true,
            preferredSurface: "origin",
            supportsOriginSurface: true,
            supportsApproverDmSurface: true,
          }),
          resolveOriginTarget: () => ({ to: "origin" }),
          resolveApproverDmTargets,
        },
        prepareTarget: ({ plannedTarget }) =>
          plannedTarget.surface === "origin" && outcome === "prepare-null"
            ? null
            : { dedupeKey: plannedTarget.target.to, target: plannedTarget.target },
        deliverTarget: physical,
      });
      expect(result.entries).toEqual([]);
      expect(
        physical.mock.calls.some(([args]) => args.plannedTarget.surface === "approver-dm"),
      ).toBe(false);
      expect(result.deliveryPlan.targets.some((target) => target.reason === "fallback")).toBe(
        false,
      );
      expect(resolveApproverDmTargets).toHaveBeenCalledOnce();
    },
  );

  it.each(["throw", "null", "prepare-null", "success", "dm-failure"])(
    "uses same-account fallback DMs only after unconfirmed origin delivery (%s)",
    async (outcome) => {
      const resolveApproverDmTargets = vi.fn(({ accountId }: { accountId?: string | null }) => [
        { to: `${accountId}:owner` },
      ]);
      const onDeliveryError = vi.fn();
      const delivered: Array<{ to: string; reason: string }> = [];
      const result = await deliverApprovalRequestViaChannelNativePlan({
        cfg: {},
        accountId: "secondary",
        approvalKind: "exec",
        request: execRequest,
        adapter: {
          describeDeliveryCapabilities: () => ({
            enabled: true,
            preferredSurface: "origin",
            supportsOriginSurface: true,
            supportsApproverDmSurface: true,
          }),
          resolveOriginTarget: () => ({ to: "origin-room", threadId: 17 }),
          resolveApproverDmTargets,
        },
        prepareTarget: ({ plannedTarget }) =>
          plannedTarget.surface === "origin" && outcome === "prepare-null"
            ? null
            : { dedupeKey: plannedTarget.target.to, target: plannedTarget.target.to },
        deliverTarget: ({ plannedTarget, preparedTarget }) => {
          delivered.push({ to: preparedTarget, reason: plannedTarget.reason });
          if (plannedTarget.surface === "origin" && outcome !== "success") {
            if (outcome === "null") {
              return null;
            }
            throw new Error("origin send unconfirmed");
          }
          if (outcome === "dm-failure") {
            throw new Error("DM send unconfirmed");
          }
          return { to: preparedTarget };
        },
        onDeliveryError,
      });
      expect(result.entries).toEqual(
        outcome === "dm-failure"
          ? []
          : [{ to: outcome === "success" ? "origin-room" : "secondary:owner" }],
      );
      expect(delivered.filter((entry) => entry.to === "secondary:owner")).toEqual(
        outcome === "success" ? [] : [{ to: "secondary:owner", reason: "fallback" }],
      );
      expect(
        resolveApproverDmTargets.mock.calls.every(([params]) => params.accountId === "secondary"),
      ).toBe(true);
      if (outcome === "dm-failure") {
        expect(onDeliveryError).toHaveBeenCalledTimes(2);
      }
      expect(result.deliveredTargets.map((target) => target.target.to)).toEqual(
        result.entries.map((entry) => entry.to),
      );
    },
  );

  it("does not retry an unconfirmed origin as a fallback DM, including prepared convergence", async () => {
    const deliverTarget = vi.fn().mockRejectedValue(new Error("unconfirmed"));
    const result = await deliverApprovalRequestViaChannelNativePlan({
      cfg: {},
      approvalKind: "exec",
      request: execRequest,
      adapter: {
        describeDeliveryCapabilities: () => ({
          enabled: true,
          preferredSurface: "origin",
          supportsOriginSurface: true,
          supportsApproverDmSurface: true,
        }),
        resolveOriginTarget: () => ({ to: "origin" }),
        resolveApproverDmTargets: () => [
          { to: "origin" },
          { to: "alias" },
          { to: "backup" },
          { to: "backup" },
        ],
      },
      prepareTarget: ({ plannedTarget }) => ({
        dedupeKey: plannedTarget.target.to === "alias" ? "origin" : plannedTarget.target.to,
        target: plannedTarget.target.to,
      }),
      deliverTarget,
    });
    expect(deliverTarget.mock.calls.map(([params]) => params.preparedTarget)).toEqual([
      "origin",
      "backup",
    ]);
    expect(result.deliveredTargets).toEqual([]);
    expect(result.entries).toEqual([]);
  });

  it("does not retry already-attempted converged DMs after an unconfirmed send", async () => {
    const deliverTarget = vi.fn().mockRejectedValue(new Error("unconfirmed"));
    const result = await deliverApprovalRequestViaChannelNativePlan({
      cfg: {},
      approvalKind: "exec",
      request: execRequest,
      adapter: {
        describeDeliveryCapabilities: () => ({
          enabled: true,
          preferredSurface: "approver-dm",
          supportsOriginSurface: false,
          supportsApproverDmSurface: true,
        }),
        resolveApproverDmTargets: () => [{ to: "owner" }, { to: "owner-alias" }],
      },
      prepareTarget: () => ({ dedupeKey: "same-dm", target: "owner" }),
      deliverTarget,
    });
    expect(deliverTarget).toHaveBeenCalledTimes(1);
    expect(result.attemptedTargets.map((target) => target.target.to)).toEqual(["owner"]);
    expect(result.deliveredTargets).toEqual([]);
  });

  it("does not send fallback DMs when the coordinator declines their custody", async () => {
    const deliverTarget = vi.fn().mockRejectedValue(new Error("origin unconfirmed"));
    const result = await deliverApprovalRequestViaChannelNativePlan({
      cfg: {},
      approvalKind: "exec",
      request: execRequest,
      adapter: {
        describeDeliveryCapabilities: () => ({
          enabled: true,
          preferredSurface: "origin",
          supportsOriginSurface: true,
          supportsApproverDmSurface: true,
        }),
        resolveOriginTarget: () => ({ to: "origin" }),
        resolveApproverDmTargets: () => [{ to: "backup" }],
      },
      prepareTarget: ({ plannedTarget }) => ({
        dedupeKey: plannedTarget.target.to,
        target: plannedTarget.target.to,
      }),
      onAttempt: (target) => target.surface === "origin",
      deliverTarget,
    });
    expect(deliverTarget).toHaveBeenCalledTimes(1);
    expect(result.attemptedTargets.map((target) => target.target.to)).toEqual(["origin"]);
    expect(result.entries).toEqual([]);
  });

  it("rechecks coordinator custody after a transport await", async () => {
    const entered = createDeferredCore();
    const gate = createDeferredCore();
    const send = vi.fn();
    let active = true;
    const delivery = deliverApprovalRequestViaChannelNativePlan({
      cfg: {},
      approvalKind: "exec",
      request: execRequest,
      adapter: {
        describeDeliveryCapabilities: () => ({
          enabled: true,
          preferredSurface: "approver-dm",
          supportsOriginSurface: false,
          supportsApproverDmSurface: true,
        }),
        resolveApproverDmTargets: () => [{ to: "backup" }],
      },
      prepareTarget: () => ({ dedupeKey: "backup", target: "backup" }),
      onAttempt: () => active,
      deliverTarget: async ({ shouldSend }) => {
        entered.resolve();
        await gate.promise;
        if (!shouldSend?.()) {
          return null;
        }
        send();
        return { messageId: "unexpected" };
      },
    });
    await entered.promise;
    active = false;
    gate.resolve();
    const result = await delivery;
    expect(send).not.toHaveBeenCalled();
    expect(result.entries).toEqual([]);
    expect(result.attemptedTargets).toHaveLength(1);
  });

  it("dedupes converged prepared targets", async () => {
    const adapter: ChannelApprovalNativeAdapter = {
      describeDeliveryCapabilities: () => ({
        enabled: true,
        preferredSurface: "approver-dm",
        supportsOriginSurface: true,
        supportsApproverDmSurface: true,
        notifyOriginWhenDmOnly: true,
      }),
      resolveOriginTarget: async () => ({ to: "origin-room" }),
      resolveApproverDmTargets: async () => [{ to: "approver-1" }, { to: "approver-2" }],
    };
    const prepareTarget = vi
      .fn()
      .mockImplementation(
        async ({ plannedTarget }: { plannedTarget: { target: { to: string } } }) =>
          plannedTarget.target.to === "approver-1"
            ? {
                dedupeKey: "shared-dm",
                target: { channelId: "shared-dm", recipientId: "approver-1" },
              }
            : {
                dedupeKey: "shared-dm",
                target: { channelId: "shared-dm", recipientId: "approver-2" },
              },
      );
    const deliverTarget = vi
      .fn()
      .mockImplementation(
        async ({ preparedTarget }: { preparedTarget: { channelId: string } }) => ({
          channelId: preparedTarget.channelId,
        }),
      );
    const onDuplicateSkipped = vi.fn();

    const result = await deliverApprovalRequestViaChannelNativePlan({
      cfg: {} as never,
      approvalKind: "exec",
      request: execRequest,
      adapter,
      prepareTarget,
      deliverTarget,
      onDuplicateSkipped,
    });

    expect(prepareTarget).toHaveBeenCalledTimes(2);
    expect(deliverTarget).toHaveBeenCalledTimes(1);
    expect(onDuplicateSkipped).toHaveBeenCalledTimes(1);
    expect(result.entries).toEqual([{ channelId: "shared-dm" }]);
    expect(result.deliveryPlan.notifyOriginWhenDmOnly).toBe(true);
  });

  it("continues after per-target delivery failures", async () => {
    const adapter: ChannelApprovalNativeAdapter = {
      describeDeliveryCapabilities: () => ({
        enabled: true,
        preferredSurface: "approver-dm",
        supportsOriginSurface: false,
        supportsApproverDmSurface: true,
      }),
      resolveApproverDmTargets: async () => [{ to: "approver-1" }, { to: "approver-2" }],
    };
    const onDeliveryError = vi.fn();

    const result = await deliverApprovalRequestViaChannelNativePlan({
      cfg: {} as never,
      approvalKind: "exec",
      request: execRequest,
      adapter,
      prepareTarget: ({ plannedTarget }) => ({
        dedupeKey: plannedTarget.target.to,
        target: { channelId: plannedTarget.target.to },
      }),
      deliverTarget: async ({ preparedTarget }) => {
        if (preparedTarget.channelId === "approver-1") {
          throw new Error("boom");
        }
        return { channelId: preparedTarget.channelId };
      },
      onDeliveryError,
    });

    expect(onDeliveryError).toHaveBeenCalledTimes(1);
    expect(result.entries).toEqual([{ channelId: "approver-2" }]);
  });
});

describe("createChannelNativeApprovalRuntime", () => {
  it("selects and expires system-agent approval targets through the native lifecycle", async () => {
    const deliverTarget = vi.fn().mockResolvedValue({ chatId: "123", messageId: "m1" });
    const finalizeExpired = vi.fn().mockResolvedValue(undefined);
    const runtime = createChannelNativeApprovalRuntime({
      label: "test/system-agent-native-runtime",
      nowMs: () => 0,
      clientDisplayName: "Test",
      channel: "telegram",
      channelLabel: "Telegram",
      cfg: {} as never,
      accountId: "default",
      eventKinds: ["system-agent"],
      nativeAdapter: {
        describeDeliveryCapabilities: () => ({
          enabled: true,
          preferredSurface: "origin",
          supportsOriginSurface: true,
          supportsApproverDmSurface: false,
        }),
        resolveOriginTarget: () => ({ to: "123" }),
      },
      isConfigured: () => true,
      shouldHandle: vi.fn().mockReturnValue(true),
      buildPendingContent: vi.fn().mockResolvedValue({ text: "pending" }),
      prepareTarget: ({ plannedTarget }) => ({
        dedupeKey: plannedTarget.target.to,
        target: { chatId: plannedTarget.target.to },
      }),
      deliverTarget,
      finalizeResolved: vi.fn().mockResolvedValue(undefined),
      finalizeExpired,
    });

    await runtime.handleRequested({
      id: "system-agent:native-1",
      request: {
        title: "OpenClaw change",
        description: "restart the Gateway",
        command: "restart the Gateway",
        proposalHash: "a".repeat(64),
        allowedDecisions: ["allow-once", "deny"],
        sessionId: "delegation-1",
      },
      createdAtMs: 0,
      expiresAtMs: 2_000,
    });

    expect(deliverTarget).toHaveBeenCalledWith(
      expect.objectContaining({ approvalKind: "system-agent" }),
    );
    await runtime.handleExpired("system-agent:native-1");
    expect(finalizeExpired).toHaveBeenCalledOnce();
  });

  it("passes the resolved approval kind and pending content through native delivery hooks", async () => {
    const describeDeliveryCapabilities = vi.fn().mockReturnValue({
      enabled: true,
      preferredSurface: "approver-dm",
      supportsOriginSurface: false,
      supportsApproverDmSurface: true,
    });
    const resolveApproverDmTargets = vi
      .fn()
      .mockImplementation(({ approvalKind, accountId }) => [
        { to: `${approvalKind}:${accountId}` },
      ]);
    const buildPendingContent = vi.fn().mockResolvedValue("pending plugin");
    const prepareTarget = vi.fn().mockReturnValue({
      dedupeKey: "dm:plugin:secondary",
      target: { chatId: "plugin:secondary" },
    });
    const deliverTarget = vi
      .fn()
      .mockResolvedValue({ chatId: "plugin:secondary", messageId: "m1" });
    const finalizeResolved = vi.fn().mockResolvedValue(undefined);
    const runtime = createChannelNativeApprovalRuntime({
      label: "test/native-runtime",
      nowMs: () => 0,
      clientDisplayName: "Test",
      channel: "telegram",
      channelLabel: "Telegram",
      cfg: {} as never,
      accountId: "secondary",
      eventKinds: ["exec", "plugin"] as const,
      nativeAdapter: {
        describeDeliveryCapabilities,
        resolveApproverDmTargets,
      },
      isConfigured: () => true,
      shouldHandle: () => true,
      buildPendingContent,
      prepareTarget,
      deliverTarget,
      finalizeResolved,
    });

    await runtime.handleRequested({
      id: "opaque-request-1",
      request: {
        title: "Plugin approval",
        description: "Allow access",
      },
      createdAtMs: 0,
      expiresAtMs: 60_000,
    });
    await runtime.handleResolved({
      id: "opaque-request-1",
      decision: "allow-once",
      ts: 1,
    });

    const pendingCall = mockCallArg(buildPendingContent);
    expect(requireRecord(pendingCall.request).id).toBe("opaque-request-1");
    expect(pendingCall.approvalKind).toBe("plugin");
    expect(typeof pendingCall.nowMs).toBe("number");

    const prepareCall = mockCallArg(prepareTarget);
    expect(prepareCall.plannedTarget).toEqual({
      surface: "approver-dm",
      target: { to: "plugin:secondary" },
      reason: "preferred",
    });
    expect(requireRecord(prepareCall.request).id).toBe("opaque-request-1");
    expect(prepareCall.approvalKind).toBe("plugin");
    expect(prepareCall.pendingContent).toBe("pending plugin");

    const deliverCall = mockCallArg(deliverTarget);
    expect(deliverCall.plannedTarget).toEqual({
      surface: "approver-dm",
      target: { to: "plugin:secondary" },
      reason: "preferred",
    });
    expect(deliverCall.preparedTarget).toEqual({ chatId: "plugin:secondary" });
    expect(requireRecord(deliverCall.request).id).toBe("opaque-request-1");
    expect(deliverCall.approvalKind).toBe("plugin");
    expect(deliverCall.pendingContent).toBe("pending plugin");

    const capabilitiesCall = mockCallArg(describeDeliveryCapabilities);
    expect(capabilitiesCall.cfg).toEqual({});
    expect(capabilitiesCall.accountId).toBe("secondary");
    expect(capabilitiesCall.approvalKind).toBe("plugin");
    expect(requireRecord(capabilitiesCall.request).id).toBe("opaque-request-1");

    const dmTargetsCall = mockCallArg(resolveApproverDmTargets);
    expect(dmTargetsCall.cfg).toEqual({});
    expect(dmTargetsCall.accountId).toBe("secondary");
    expect(dmTargetsCall.approvalKind).toBe("plugin");
    expect(requireRecord(dmTargetsCall.request).id).toBe("opaque-request-1");

    const resolvedCall = mockCallArg(finalizeResolved);
    expect(requireRecord(resolvedCall.request).id).toBe("opaque-request-1");
    expect(requireRecord(resolvedCall.resolved)).toEqual({
      id: "opaque-request-1",
      decision: "allow-once",
      ts: 1,
    });
    expect(resolvedCall.entries).toEqual([{ chatId: "plugin:secondary", messageId: "m1" }]);
  });

  it("honors the deprecated approval kind compatibility override", async () => {
    const resolveApprovalKind = vi.fn().mockReturnValue("exec");
    const buildPendingContent = vi.fn().mockResolvedValue("pending");
    const runtime = createChannelNativeApprovalRuntime({
      label: "test/native-runtime-legacy-kind",
      nowMs: () => 0,
      clientDisplayName: "Test",
      cfg: {} as never,
      resolveApprovalKind,
      isConfigured: () => true,
      shouldHandle: () => true,
      buildPendingContent,
      prepareTarget: async () => null,
      deliverTarget: async () => null,
      finalizeResolved: async () => {},
    });

    const request = {
      id: "legacy-owned-id",
      request: {
        title: "Plugin approval",
        description: "Allow access",
      },
      createdAtMs: 0,
      expiresAtMs: 60_000,
    } as const;
    const normalizedRequest = { ...request, approvalKind: "plugin" as const };
    await runtime.handleRequested(request);

    expect(resolveApprovalKind).toHaveBeenCalledWith(normalizedRequest);
    expect(buildPendingContent).toHaveBeenCalledWith(
      expect.objectContaining({ request: normalizedRequest, approvalKind: "exec" }),
    );
  });

  it("sends route notices over least-privilege gateway calls", async () => {
    const runtime = createChannelNativeApprovalRuntime({
      label: "test/native-runtime-route-notice",
      clientDisplayName: "Test",
      channel: "slack",
      channelLabel: "Slack",
      cfg: { gateway: { auth: { token: "configured-token" } } } as never,
      accountId: "default",
      nativeAdapter: {
        describeDeliveryCapabilities: () => ({
          enabled: true,
          preferredSurface: "approver-dm",
          supportsOriginSurface: true,
          supportsApproverDmSurface: true,
          notifyOriginWhenDmOnly: true,
        }),
        resolveOriginTarget: async () => ({
          to: "channel:C123",
          threadId: "1712345678.123456",
        }),
        resolveApproverDmTargets: async () => [{ to: "user:owner" }],
      },
      isConfigured: () => true,
      shouldHandle: () => true,
      buildPendingContent: async () => "pending exec",
      prepareTarget: async ({ plannedTarget }) => ({
        dedupeKey: plannedTarget.target.to,
        target: { chatId: plannedTarget.target.to },
      }),
      deliverTarget: async () => ({ chatId: "user:owner", messageId: "m1" }),
      finalizeResolved: async () => {},
    });

    await runtime.start();
    try {
      await runtime.handleRequested({
        id: "approval-route-notice",
        request: {
          command: "echo hi",
          turnSourceChannel: "slack",
          turnSourceTo: "channel:C123",
          turnSourceAccountId: "default",
          turnSourceThreadId: "1712345678.123456",
        },
        createdAtMs: 0,
        expiresAtMs: Date.now() + 60_000,
      });
    } finally {
      await runtime.stop();
    }

    expect(hoisted.callGatewayLeastPrivilege).toHaveBeenCalledWith(
      expect.objectContaining({
        config: { gateway: { auth: { token: "configured-token" } } },
        method: "send",
        clientName: "gateway-client",
        mode: "backend",
        params: {
          channel: "slack",
          to: "channel:C123",
          accountId: "default",
          threadId: "1712345678.123456",
          message: "Approval required. I sent the approval request to Slack DMs, not this chat.",
          idempotencyKey: "approval-route-notice:approval-route-notice",
        },
      }),
    );
  });

  it("runs expiration through the shared runtime factory", async () => {
    vi.useFakeTimers();
    const finalizeExpired = vi.fn().mockResolvedValue(undefined);
    const runtime = createChannelNativeApprovalRuntime({
      label: "test/native-runtime-expiry",
      clientDisplayName: "Test",
      channel: "telegram",
      channelLabel: "Telegram",
      cfg: {} as never,
      nowMs: Date.now,
      nativeAdapter: {
        describeDeliveryCapabilities: () => ({
          enabled: true,
          preferredSurface: "approver-dm",
          supportsOriginSurface: false,
          supportsApproverDmSurface: true,
        }),
        resolveApproverDmTargets: async () => [{ to: "owner" }],
      },
      isConfigured: () => true,
      shouldHandle: () => true,
      buildPendingContent: async () => "pending exec",
      prepareTarget: async () => ({
        dedupeKey: "dm:owner",
        target: { chatId: "owner" },
      }),
      deliverTarget: async () => ({ chatId: "owner", messageId: "m1" }),
      finalizeResolved: async () => {},
      finalizeExpired,
    });

    await runtime.handleRequested({
      id: "req-1",
      request: {
        command: "echo hi",
      },
      createdAtMs: 0,
      expiresAtMs: Date.now() + 60_000,
    });

    await vi.advanceTimersByTimeAsync(60_000);

    const expiredCall = mockCallArg(finalizeExpired);
    expect(requireRecord(expiredCall.request).id).toBe("req-1");
    expect(expiredCall.entries).toEqual([{ chatId: "owner", messageId: "m1" }]);
    vi.useRealTimers();
  });
});

describe("native approval delivery validity", () => {
  it.each(["resolved", "stopped", "expired"])(
    "does not start a fallback after original send loses validity (%s)",
    async (terminal) => {
      const gate = createDeferredCore<null>();
      const entered = createDeferredCore();
      const delivered: string[] = [];
      let now = Date.now();
      const request = { ...execRequest, expiresAtMs: now + 60_000 };
      const runtime = createChannelNativeApprovalRuntime({
        label: "test/native-validity",
        clientDisplayName: "Test",
        cfg: {},
        nowMs: () => now,
        isConfigured: () => true,
        shouldHandle: () => true,
        nativeAdapter: {
          describeDeliveryCapabilities: () => ({
            enabled: true,
            preferredSurface: "origin",
            supportsOriginSurface: true,
            supportsApproverDmSurface: true,
          }),
          resolveOriginTarget: () => ({ to: "origin" }),
          resolveApproverDmTargets: () => [{ to: "backup" }],
        },
        buildPendingContent: () => "pending",
        prepareTarget: ({ plannedTarget }) => ({
          dedupeKey: plannedTarget.target.to,
          target: plannedTarget.target.to,
        }),
        deliverTarget: async ({ preparedTarget }) => {
          if (typeof preparedTarget !== "string") {
            throw new Error("unexpected prepared target");
          }
          delivered.push(preparedTarget);
          if (preparedTarget === "origin") {
            entered.resolve();
            return await gate.promise;
          }
          return { messageId: "unexpected" };
        },
        finalizeResolved: async () => {},
      });
      const sending = runtime.handleRequested(request);
      await entered.promise;
      if (terminal === "resolved") {
        await runtime.handleResolved({ id: request.id, decision: "deny", ts: Date.now() });
      }
      if (terminal === "stopped") {
        await runtime.stop();
      }
      if (terminal === "expired") {
        now = request.expiresAtMs + 1;
      }
      gate.resolve(null);
      await sending;
      expect(delivered).toEqual(["origin"]);
    },
  );

  it("rechecks pending authority after an asynchronous target preparation", async () => {
    const gate = createDeferredCore();
    const entered = createDeferredCore();
    const deliverTarget = vi.fn().mockResolvedValue({ messageId: "unexpected" });
    const runtime = createChannelNativeApprovalRuntime({
      label: "test/prepare-validity",
      clientDisplayName: "Test",
      cfg: {},
      isConfigured: () => true,
      shouldHandle: () => true,
      nativeAdapter: {
        describeDeliveryCapabilities: () => ({
          enabled: true,
          preferredSurface: "approver-dm",
          supportsOriginSurface: false,
          supportsApproverDmSurface: true,
        }),
        resolveApproverDmTargets: () => [{ to: "backup" }],
      },
      buildPendingContent: () => "pending",
      prepareTarget: async () => {
        entered.resolve();
        await gate.promise;
        return { dedupeKey: "backup", target: "backup" };
      },
      deliverTarget,
      finalizeResolved: async () => {},
    });
    const request = { ...execRequest, expiresAtMs: Date.now() + 60_000 };
    const sending = runtime.handleRequested(request);
    await entered.promise;
    await runtime.handleResolved({ id: request.id, decision: "deny", ts: Date.now() });
    gate.resolve();
    await sending;
    expect(deliverTarget).not.toHaveBeenCalled();
  });
});

describe("native Gateway lifetime", () => {
  it("cancels delivery if the owning Gateway retires during preparation", async () => {
    const coordinator = createApprovalNativeRouteCoordinator();
    const gate = createDeferredCore();
    const entered = createDeferredCore();
    const deliverTarget = vi.fn().mockResolvedValue({ messageId: "unexpected" });
    const runtime = withGatewayNativeApprovalRuntime(
      {
        routeCoordinator: coordinator,
        subscribe: () => () => {},
        request: async () => {
          throw new Error("unused");
        },
        requestRoute: async () => {
          throw new Error("unused");
        },
      },
      () =>
        createChannelNativeApprovalRuntime({
          label: "test/gateway-validity",
          clientDisplayName: "Test",
          cfg: {},
          isConfigured: () => true,
          shouldHandle: () => true,
          nativeAdapter: {
            describeDeliveryCapabilities: () => ({
              enabled: true,
              preferredSurface: "approver-dm",
              supportsOriginSurface: false,
              supportsApproverDmSurface: true,
            }),
            resolveApproverDmTargets: () => [{ to: "backup" }],
          },
          buildPendingContent: () => "pending",
          prepareTarget: async () => {
            entered.resolve();
            await gate.promise;
            return { dedupeKey: "backup", target: "backup" };
          },
          deliverTarget,
          finalizeResolved: async () => {},
        }),
    );
    const sending = runtime.handleRequested({ ...execRequest, expiresAtMs: Date.now() + 60_000 });
    await entered.promise;
    coordinator.close();
    gate.resolve();
    await sending;
    expect(deliverTarget).not.toHaveBeenCalled();
  });
});
