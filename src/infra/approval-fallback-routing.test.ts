import { afterEach, describe, expect, it, vi } from "vitest";
import { createMessageReceiptFromOutboundResults } from "../channels/message/receipt.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createApprovalNativeRouteCoordinator } from "./approval-native-route-coordinator.js";
import { createExecApprovalForwarder } from "./exec-approval-forwarder.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
  vi.useRealTimers();
});

function fixture() {
  setActivePluginRegistry(createTestRegistry([]));
  const coordinator = createApprovalNativeRouteCoordinator();
  cleanups.push(() => coordinator.close());
  const request: PluginApprovalRequest = {
    approvalKind: "plugin",
    id: "plugin:conditional-fallback",
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
    request: {
      title: "Synthetic approval",
      description: "echo safe",
      sessionKey: "agent:main:telegram:group:-42",
      agentId: "main",
      turnSourceChannel: "telegram",
      turnSourceTo: "-42",
      turnSourceAccountId: "ops",
      allowedDecisions: ["allow-once", "deny"],
    },
  };
  const cfg: OpenClawConfig = {
    approvals: {
      plugin: {
        enabled: true,
        mode: "session",
        fallbackTargets: [{ channel: "telegram", accountId: "default", to: "123" }],
      },
    },
  };
  const deliver = vi.fn(
    async (
      _params: Parameters<
        NonNullable<NonNullable<Parameters<typeof createExecApprovalForwarder>[0]>["deliver"]>
      >[0],
    ) => ({
      status: "sent" as const,
      results: [{ channel: "telegram", messageId: "fallback-message" }],
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ channel: "telegram", messageId: "fallback-message" }],
      }),
    }),
  );
  const forwarder = createExecApprovalForwarder({
    getConfig: () => cfg,
    deliver,
    resolveSessionTarget: async () => null,
    getNativeApprovalRouteCoordinator: () => coordinator,
    waitForNativeDelivery: (candidateRequest, approvalKind) =>
      coordinator.waitForDelivery({ request: candidateRequest, approvalKind, timeoutMs: 100 }),
  });
  cleanups.push(() => forwarder.stop());
  const reporter = () => {
    const item = coordinator.createReporter({
      handledKinds: new Set(["plugin"]),
      channel: "telegram",
      accountId: "ops",
      requestGateway: vi.fn().mockResolvedValue({}),
      shouldHandle: () => true,
      classifyRoute: () => "bound-or-explicit",
    });
    item.start();
    return item;
  };
  const origin = {
    surface: "origin" as const,
    reason: "preferred" as const,
    target: { to: "-42" },
  };
  const plan = { originTarget: origin.target, targets: [origin], notifyOriginWhenDmOnly: false };
  return { coordinator, request, cfg, deliver, forwarder, reporter, origin, plan };
}

describe("conditional approval fallback", () => {
  it("does not DM after a native primary card was confirmed", async () => {
    const f = fixture();
    const reporter = f.reporter();
    await f.forwarder.handlePluginApprovalRequested!(f.request);
    await reporter.reportDelivery({
      request: f.request,
      approvalKind: "plugin",
      deliveryPlan: f.plan,
      deliveredTargets: [f.origin],
    });
    await f.forwarder.stop();
    expect(f.deliver).not.toHaveBeenCalled();
  });
  it("waits for native outcome, then sends a warned explicit fallback after an unconfirmed origin", async () => {
    const f = fixture();
    const reporter = f.reporter();
    await f.forwarder.handlePluginApprovalRequested!(f.request);
    await Promise.resolve();
    expect(f.deliver).not.toHaveBeenCalled();
    await reporter.reportDelivery({
      request: f.request,
      approvalKind: "plugin",
      deliveryPlan: f.plan,
      deliveredTargets: [],
    });
    await vi.waitFor(() => expect(f.deliver).toHaveBeenCalledOnce());
    const args = f.deliver.mock.calls[0]?.[0];
    expect(args).toMatchObject({ channel: "telegram", accountId: "default", to: "123" });
    expect(args?.payloads[0]?.text).toMatch(/^⚠️/);
    expect(args?.payloads[0]?.presentation).toBeDefined();
  });
  it("uses the explicit fallback when the source is webchat and no native owner is available", async () => {
    const f = fixture();
    f.request.request.turnSourceChannel = "webchat";
    f.request.request.turnSourceTo = null;
    await f.forwarder.handlePluginApprovalRequested!(f.request);
    await vi.waitFor(() => expect(f.deliver).toHaveBeenCalledOnce());
    expect(f.deliver.mock.calls[0]?.[0]).toMatchObject({ accountId: "default", to: "123" });
  });
  it("does not resend a fallback DM already attempted by the native owner", async () => {
    const f = fixture();
    const reporter = f.reporter();
    f.cfg.approvals!.plugin!.fallbackTargets![0]!.accountId = "ops";
    const dm = {
      surface: "approver-dm" as const,
      reason: "fallback" as const,
      target: { to: "123" },
    };
    await f.forwarder.handlePluginApprovalRequested!(f.request);
    await reporter.reportDelivery({
      request: f.request,
      approvalKind: "plugin",
      deliveryPlan: { ...f.plan, targets: [f.origin, dm] },
      deliveredTargets: [],
      attemptedTargets: [f.origin, dm],
    });
    await f.forwarder.stop();
    expect(f.deliver).not.toHaveBeenCalled();
  });
  it("does not send a pending fallback after resolution overtakes its native wait", async () => {
    const f = fixture();
    const reporter = f.reporter();
    await f.forwarder.handlePluginApprovalRequested!(f.request);
    await f.forwarder.handlePluginApprovalResolved!({
      id: f.request.id,
      decision: "deny",
      resolvedBy: null,
      ts: Date.now(),
      request: f.request.request,
    });
    await reporter.reportDelivery({
      request: f.request,
      approvalKind: "plugin",
      deliveryPlan: f.plan,
      deliveredTargets: [],
    });
    await f.forwarder.stop();
    expect(f.deliver).not.toHaveBeenCalled();
  });
  it("does not resurrect fallback delivery after Gateway retirement", async () => {
    const f = fixture();
    f.reporter();
    await f.forwarder.handlePluginApprovalRequested!(f.request);
    f.coordinator.close();
    await f.forwarder.stop();
    expect(f.deliver).not.toHaveBeenCalled();
  });
  it("falls back after a bounded missing native confirmation, without poll loops", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.reporter();
    await f.forwarder.handlePluginApprovalRequested!(f.request);
    await vi.advanceTimersByTimeAsync(101);
    expect(f.deliver).toHaveBeenCalledOnce();
  });
  it("does not treat configured native enablement as delivery success when the owner is offline", async () => {
    const f = fixture();
    f.cfg.channels = {
      telegram: {
        botToken: "synthetic",
        execApprovals: { enabled: true, approvers: ["123"], target: "channel" },
      },
    };
    await f.forwarder.handlePluginApprovalRequested!(f.request);
    await vi.waitFor(() => expect(f.deliver).toHaveBeenCalledOnce());
  });
});

describe("approval fallback review regressions", () => {
  it.each(["resolved", "expired", "stopped", "retired"] as const)(
    "fences physical fallback handoff after outbound preparation (%s)",
    async (terminal) => {
      const f = fixture();
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const physical = vi.fn();
      f.deliver.mockImplementation(async (args) => {
        entered.resolve();
        await release.promise;
        await args.onPlatformSendDispatch?.();
        args.assertDirectAdapterHandoff?.();
        physical();
        return {
          status: "sent",
          results: [{ channel: "telegram", messageId: "physical" }],
          receipt: createMessageReceiptFromOutboundResults({
            results: [{ channel: "telegram", messageId: "physical" }],
          }),
        };
      });
      await f.forwarder.handlePluginApprovalRequested!(f.request);
      await entered.promise;
      let stopping: Promise<void> | undefined;
      if (terminal === "resolved") {
        await f.forwarder.handlePluginApprovalResolved!({
          id: f.request.id,
          decision: "deny",
          ts: Date.now(),
          request: f.request.request,
        });
      }
      if (terminal === "expired") {
        f.request.expiresAtMs = Date.now() - 1;
      }
      if (terminal === "stopped") {
        stopping = f.forwarder.stop();
      }
      if (terminal === "retired") {
        f.coordinator.close();
      }
      release.resolve();
      await (stopping ?? f.forwarder.stop());
      expect(physical).not.toHaveBeenCalled();
    },
  );

  it("does not bypass scoped plugin reviewers through an unsupported fallback channel", async () => {
    const f = fixture();
    f.cfg.approvals!.plugin!.slack = { approvers: ["U11111111"] };
    f.cfg.approvals!.plugin!.fallbackTargets = [{ channel: "slack", to: "owner" }];
    const plugin = createChannelTestPluginBase({ id: "slack" });
    setActivePluginRegistry(createTestRegistry([{ pluginId: "slack", plugin, source: "test" }]));
    await f.forwarder.handlePluginApprovalRequested!(f.request);
    await f.forwarder.stop();
    expect(f.deliver).not.toHaveBeenCalled();
  });

  it("does not finalize an in-flight native attempt as a completed report", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const reporter = f.reporter();
    f.cfg.approvals!.plugin!.fallbackTargets![0]!.accountId = "ops";
    await f.forwarder.handlePluginApprovalRequested!(f.request);
    reporter.reportAttempt({
      request: f.request,
      approvalKind: "plugin",
      plannedTarget: { surface: "approver-dm", reason: "fallback", target: { to: "123" } },
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(f.deliver).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(51);
    await f.forwarder.stop();
    expect(f.deliver).not.toHaveBeenCalled();
  });

  it.each(["resolved", "stopped", "expired"])(
    "does not send primary after an async channel hook is overtaken (%s)",
    async (terminal) => {
      const f = fixture();
      f.cfg.approvals!.plugin!.mode = "targets";
      f.cfg.approvals!.plugin!.targets = [{ channel: "telegram", to: "primary" }];
      const gate = createDeferredCore();
      const entered = createDeferredCore();
      const plugin = {
        ...createChannelTestPluginBase({ id: "telegram" }),
        outbound: {
          deliveryMode: "direct" as const,
          beforeDeliverPayload: async () => {
            entered.resolve();
            await gate.promise;
          },
        },
      };
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "telegram", plugin, source: "test" }]),
      );
      await f.forwarder.handlePluginApprovalRequested!(f.request);
      await entered.promise;
      let stopping: Promise<void> | undefined;
      if (terminal === "resolved") {
        await f.forwarder.handlePluginApprovalResolved!({
          id: f.request.id,
          decision: "deny",
          resolvedBy: null,
          ts: Date.now(),
          request: f.request.request,
        });
      }
      if (terminal === "stopped") {
        stopping = f.forwarder.stop();
      }
      if (terminal === "expired") {
        f.request.expiresAtMs = Date.now() - 1;
      }
      gate.resolve();
      await (stopping ?? f.forwarder.stop());
      expect(
        f.deliver.mock.calls.filter(([args]) =>
          args.payloads.some((payload) => payload.presentation),
        ),
      ).toEqual([]);
    },
  );

  it("does not count a primary hook failure as an attempted fallback destination", async () => {
    const f = fixture();
    f.cfg.approvals!.plugin!.mode = "targets";
    f.cfg.approvals!.plugin!.targets = [...f.cfg.approvals!.plugin!.fallbackTargets!];
    const plugin = {
      ...createChannelTestPluginBase({ id: "telegram" }),
      outbound: {
        deliveryMode: "direct" as const,
        beforeDeliverPayload: vi.fn().mockRejectedValueOnce(new Error("pre-send hook failed")),
      },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "telegram", plugin, source: "test" }]));
    await f.forwarder.handlePluginApprovalRequested!(f.request);
    await vi.waitFor(() => expect(f.deliver).toHaveBeenCalledOnce());
    expect(f.deliver.mock.calls[0]?.[0].payloads[0]?.text).toMatch(/^⚠️/);
  });

  it("dedupes Telegram prefixes, effective default account and encoded topic against native attempts", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const { telegramPlugin } = await loadBundledPluginFacade<{ telegramPlugin: ChannelPlugin }>({
      pluginId: "telegram",
      artifactBasename: "channel-plugin-api.ts",
    });
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", plugin: telegramPlugin, source: "test" }]),
    );
    f.cfg.channels = {
      telegram: { defaultAccount: "ops", accounts: { ops: { botToken: "synthetic" } } },
    };
    f.cfg.approvals!.plugin!.fallbackTargets = [{ channel: "telegram", to: "tg:-42:topic:17" }];
    const reporter = f.reporter();
    await f.forwarder.handlePluginApprovalRequested!(f.request);
    await reporter.reportDelivery({
      request: f.request,
      approvalKind: "plugin",
      deliveryPlan: f.plan,
      deliveredTargets: [],
      attemptedTargets: [
        { surface: "approver-dm", reason: "fallback", target: { to: "-42", threadId: 17 } },
      ],
    });
    await vi.advanceTimersByTimeAsync(101);
    await f.forwarder.stop();
    expect(f.deliver).not.toHaveBeenCalled();
  });
});

describe("native fallback phase handoff", () => {
  it("does not start a late native backup after generic fallback takes ownership", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const reporter = f.reporter();
    await f.forwarder.handlePluginApprovalRequested!(f.request);
    await vi.advanceTimersByTimeAsync(101);
    expect(f.deliver).toHaveBeenCalledOnce();
    expect(
      reporter.reportAttempt({
        request: f.request,
        approvalKind: "plugin",
        plannedTarget: { surface: "approver-dm", reason: "fallback", target: { to: "123" } },
      }),
    ).toBe(false);
  });
});
