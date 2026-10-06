// Creates channel-native approval runtimes and delivery flows.
import type { ChannelApprovalNativeAdapter } from "../channels/plugins/approval-native.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { getGatewayNativeApprovalRuntime } from "./approval-gateway-runtime-context.js";
import {
  resolveChannelNativeApprovalDeliveryPlan,
  type ChannelApprovalNativePlannedTarget,
  type ChannelApprovalNativeDeliveryPlan,
} from "./approval-native-delivery.js";
import { createApprovalNativeRouteReporter } from "./approval-native-route-coordinator.js";
import type {
  ChannelNativeApprovalDeliveryCallbacks,
  ChannelNativeApprovalTransportSpec,
  PreparedChannelNativeApprovalTarget,
} from "./approval-native-runtime-types.js";
import { buildChannelApprovalNativeTargetKey } from "./approval-native-target-key.js";
import { classifyApprovalRequestChannelRoute } from "./approval-request-account-binding.js";
import type {
  ApprovalRequestInput,
  ApprovalResolved,
  ChannelApprovalKind,
  NormalizedApprovalRequest,
} from "./approval-types.js";
import {
  createExecApprovalChannelRuntime,
  type ExecApprovalChannelRuntime,
  type ExecApprovalChannelRuntimeAdapter,
} from "./exec-approval-channel-runtime.js";

type ApprovalRequest = ApprovalRequestInput;

export type { PreparedChannelNativeApprovalTarget } from "./approval-native-runtime-types.js";

type ChannelNativeApprovalPlanDeliveryResult<TPendingEntry> = {
  entries: TPendingEntry[];
  deliveryPlan: ChannelApprovalNativeDeliveryPlan;
  deliveredTargets: ChannelApprovalNativePlannedTarget[];
  attemptedTargets: ChannelApprovalNativePlannedTarget[];
};

/** Delivers an approval request to the adapter-planned native targets and returns pending entries. */
export async function deliverApprovalRequestViaChannelNativePlan<
  TPreparedTarget,
  TPendingEntry,
  TRequest extends ApprovalRequest = ApprovalRequest,
>(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind: ChannelApprovalKind;
  request: TRequest;
  adapter?: ChannelApprovalNativeAdapter | null;
  shouldSend?: () => boolean;
  onAttempt?: (target: ChannelApprovalNativePlannedTarget) => boolean | void;
  prepareTarget: (params: {
    plannedTarget: ChannelApprovalNativePlannedTarget;
    request: TRequest;
  }) =>
    | PreparedChannelNativeApprovalTarget<TPreparedTarget>
    | null
    | Promise<PreparedChannelNativeApprovalTarget<TPreparedTarget> | null>;
  deliverTarget: (params: {
    plannedTarget: ChannelApprovalNativePlannedTarget;
    preparedTarget: TPreparedTarget;
    shouldSend?: () => boolean;
    request: TRequest;
  }) => TPendingEntry | null | Promise<TPendingEntry | null>;
  onDeliveryError?: (params: {
    error: unknown;
    plannedTarget: ChannelApprovalNativePlannedTarget;
    request: TRequest;
  }) => void;
  onDuplicateSkipped?: (params: {
    plannedTarget: ChannelApprovalNativePlannedTarget;
    preparedTarget: PreparedChannelNativeApprovalTarget<TPreparedTarget>;
    request: TRequest;
  }) => void;
  onDelivered?: (params: {
    plannedTarget: ChannelApprovalNativePlannedTarget;
    preparedTarget: PreparedChannelNativeApprovalTarget<TPreparedTarget>;
    request: TRequest;
    entry: TPendingEntry;
  }) => void;
}): Promise<ChannelNativeApprovalPlanDeliveryResult<TPendingEntry>> {
  const deliveryPlan = await resolveChannelNativeApprovalDeliveryPlan({
    cfg: params.cfg,
    accountId: params.accountId,
    approvalKind: params.approvalKind,
    request: params.request,
    adapter: params.adapter,
  });

  const attemptedKeys = new Set<string>();
  const originKeys = new Set<string>();
  const pendingEntries: TPendingEntry[] = [];
  const deliveredTargets: ChannelApprovalNativePlannedTarget[] = [];
  const attemptedTargets: ChannelApprovalNativePlannedTarget[] = [];
  const canSend = () => params.shouldSend?.() ?? true;
  const deliver = async (plannedTarget: ChannelApprovalNativePlannedTarget) => {
    if (!canSend()) {
      return;
    }
    try {
      const preparedTarget = await params.prepareTarget({
        plannedTarget,
        request: params.request,
      });
      if (!preparedTarget || !canSend()) {
        return;
      }
      // A fallback must be a different surface, not a retry of the unconfirmed origin.
      if (plannedTarget.surface === "origin") {
        originKeys.add(preparedTarget.dedupeKey);
      }
      // Dedupe after preparation because different surfaces can converge on the same message target.
      if (
        attemptedKeys.has(preparedTarget.dedupeKey) ||
        (plannedTarget.reason === "fallback" && originKeys.has(preparedTarget.dedupeKey))
      ) {
        params.onDuplicateSkipped?.({
          plannedTarget,
          preparedTarget,
          request: params.request,
        });
        return;
      }

      if (params.onAttempt?.(plannedTarget) === false) {
        return;
      }
      attemptedKeys.add(preparedTarget.dedupeKey);
      attemptedTargets.push(plannedTarget);
      const entry = await params.deliverTarget({
        plannedTarget,
        preparedTarget: preparedTarget.target,
        // Awaiting transports must revalidate coordinator custody at the effect boundary.
        shouldSend: () => canSend() && params.onAttempt?.(plannedTarget) !== false,
        request: params.request,
      });
      if (!entry) {
        return;
      }

      pendingEntries.push(entry);
      deliveredTargets.push(plannedTarget);
      params.onDelivered?.({
        plannedTarget,
        preparedTarget,
        request: params.request,
        entry,
      });
    } catch (error) {
      params.onDeliveryError?.({
        error,
        plannedTarget,
        request: params.request,
      });
    }
  };
  for (const plannedTarget of deliveryPlan.targets) {
    await deliver(plannedTarget);
  }

  // A configured origin is not proof of delivery. Retry only on adapter-owned
  // DM surfaces after an origin-only plan returned no confirmed entry.
  if (
    params.approvalKind !== "system-agent" &&
    canSend() &&
    deliveryPlan.targets.some((target) => target.surface === "origin") &&
    deliveryPlan.targets.every((target) => target.surface === "origin") &&
    deliveredTargets.length === 0 &&
    params.adapter?.resolveApproverDmTargets
  ) {
    const capabilities = params.adapter.describeDeliveryCapabilities(params);
    if (
      capabilities.enabled &&
      capabilities.preferredSurface === "origin" &&
      capabilities.supportsApproverDmSurface
    ) {
      const fallbackTargets = await params.adapter.resolveApproverDmTargets(params);
      const normalizeTarget = (target: ChannelApprovalNativePlannedTarget["target"]) =>
        params.adapter?.normalizeTarget
          ? params.adapter.normalizeTarget({
              cfg: params.cfg,
              accountId: params.accountId,
              target,
            })
          : target;
      const normalizedOrigin = deliveryPlan.originTarget
        ? normalizeTarget(deliveryPlan.originTarget)
        : null;
      const originKey = normalizedOrigin
        ? buildChannelApprovalNativeTargetKey(normalizedOrigin)
        : null;
      const plannedKeys = new Set(
        deliveryPlan.targets.flatMap((plannedTarget) => {
          const target = normalizeTarget(plannedTarget.target);
          return target ? [buildChannelApprovalNativeTargetKey(target)] : [];
        }),
      );
      for (const fallbackTarget of fallbackTargets) {
        if (!canSend()) {
          break;
        }
        const target = normalizeTarget(fallbackTarget);
        if (!target) {
          continue;
        }
        const key = buildChannelApprovalNativeTargetKey(target);
        if (key === originKey || plannedKeys.has(key)) {
          continue;
        }
        plannedKeys.add(key);
        const plannedTarget: ChannelApprovalNativePlannedTarget = {
          surface: "approver-dm",
          target,
          reason: "fallback",
        };
        deliveryPlan.targets.push(plannedTarget);
        await deliver(plannedTarget);
      }
    }
  }

  return {
    entries: pendingEntries,
    deliveryPlan,
    deliveredTargets,
    attemptedTargets,
  };
}

type ChannelNativeApprovalRuntimeAdapter<
  TPendingEntry,
  TPreparedTarget,
  TPendingContent,
  TRequest extends ApprovalRequest = ApprovalRequest,
  TResolved extends ApprovalResolved = ApprovalResolved,
> = Omit<
  ExecApprovalChannelRuntimeAdapter<TPendingEntry, TRequest, TResolved>,
  "deliverRequested"
> &
  ChannelNativeApprovalTransportSpec<TPendingEntry, TPreparedTarget, TPendingContent, TRequest> &
  ChannelNativeApprovalDeliveryCallbacks<
    TPendingEntry,
    TPreparedTarget,
    TPendingContent,
    TRequest
  > & {
    channel?: string;
    channelLabel?: string;
    accountId?: string | null;
    nativeAdapter?: ChannelApprovalNativeAdapter | null;
    /** @deprecated Trusted compatibility override; omit to derive ownership from the payload. */
    resolveApprovalKind?: (request: TRequest) => ChannelApprovalKind;
    buildPendingContent: (params: {
      request: TRequest;
      approvalKind: ChannelApprovalKind;
      nowMs: number;
    }) => TPendingContent | Promise<TPendingContent>;
    onStopped?: () => Promise<void> | void;
  };

/** Creates the shared gateway approval runtime backed by channel-native delivery hooks. */
export function createChannelNativeApprovalRuntime<
  TPendingEntry,
  TPreparedTarget,
  TPendingContent,
  TRequest extends ApprovalRequest = ApprovalRequest,
  TResolved extends ApprovalResolved = ApprovalResolved,
>(
  adapter: ChannelNativeApprovalRuntimeAdapter<
    TPendingEntry,
    TPreparedTarget,
    TPendingContent,
    TRequest,
    TResolved
  >,
): ExecApprovalChannelRuntime<TRequest, TResolved> {
  const nowMs = adapter.nowMs ?? Date.now;
  const handledEventKinds = new Set<ChannelApprovalKind>(adapter.eventKinds ?? ["exec"]);
  const gatewayRuntime = getGatewayNativeApprovalRuntime();
  const createRouteReporter =
    gatewayRuntime?.routeCoordinator.createReporter ?? createApprovalNativeRouteReporter;
  const routeReporter = createRouteReporter({
    handledKinds: handledEventKinds,
    channel: adapter.channel,
    channelLabel: adapter.channelLabel,
    accountId: adapter.accountId,
    // SAFETY: the route coordinator receives only normalized requests from this runtime.
    shouldHandle: (request) => adapter.shouldHandle(request as NormalizedApprovalRequest<TRequest>),
    classifyRoute: (request) =>
      classifyApprovalRequestChannelRoute({
        cfg: adapter.cfg,
        request,
        channel: adapter.channel ?? "",
      }),
    requestGateway: async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      if (gatewayRuntime) {
        if (method !== "send") {
          throw new Error(`native approval route cannot dispatch ${method}`);
        }
        return await gatewayRuntime.requestRoute<T>(method, params);
      }
      const { callGatewayLeastPrivilege } = await import("../gateway/call.js");
      return await callGatewayLeastPrivilege<T>({
        config: adapter.cfg,
        ...(adapter.gatewayUrl ? { url: adapter.gatewayUrl } : {}),
        method,
        params,
        clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      });
    },
  });

  const runtime = createExecApprovalChannelRuntime<TPendingEntry, TRequest, TResolved>({
    label: adapter.label,
    clientDisplayName: adapter.clientDisplayName,
    cfg: adapter.cfg,
    gatewayUrl: adapter.gatewayUrl,
    eventKinds: adapter.eventKinds,
    isConfigured: adapter.isConfigured,
    shouldHandle: (request) => {
      const approvalKind = adapter.resolveApprovalKind?.(request) ?? request.approvalKind;
      const selection = routeReporter.selectRequest({
        approvalKind,
        request,
      });
      if (selection.kind === "selected") {
        return true;
      }
      if (selection.kind === "selector-error") {
        void routeReporter.reportSkipped({
          approvalKind,
          request,
          reason: "ineligible",
        });
        throw selection.error;
      }
      void routeReporter.reportSkipped({
        approvalKind,
        request,
        reason: selection.kind,
      });
      return false;
    },
    finalizeResolved: async (params) => {
      try {
        await adapter.finalizeResolved(params);
      } finally {
        routeReporter.completeRequest(params.request.id);
      }
    },
    finalizeExpired: adapter.finalizeExpired
      ? async (params) => {
          try {
            await adapter.finalizeExpired?.(params);
          } finally {
            routeReporter.completeRequest(params.request.id);
          }
        }
      : undefined,
    onStopped: adapter.onStopped,
    beforeGatewayClientStart: () => {
      routeReporter.start();
    },
    nowMs,
    deliverRequested: async (request, context) => {
      const shouldSend = () => context?.shouldSend() === true && routeReporter.isActive();
      const approvalKind = adapter.resolveApprovalKind?.(request) ?? request.approvalKind;
      let deliveryPlan: ChannelApprovalNativeDeliveryPlan = {
        targets: [],
        originTarget: null,
        notifyOriginWhenDmOnly: false,
      };
      let deliveredTargets: ChannelApprovalNativePlannedTarget[] = [];
      let attemptedTargets: ChannelApprovalNativePlannedTarget[] = [];
      try {
        const pendingContent = await adapter.buildPendingContent({
          request,
          approvalKind,
          nowMs: nowMs(),
        });
        const deliveryResult = await deliverApprovalRequestViaChannelNativePlan({
          cfg: adapter.cfg,
          accountId: adapter.accountId,
          approvalKind,
          request,
          adapter: adapter.nativeAdapter,
          shouldSend,
          onAttempt: (plannedTarget) =>
            routeReporter.reportAttempt({ request, approvalKind, plannedTarget }),
          prepareTarget: async (target) =>
            await adapter.prepareTarget({
              ...target,
              approvalKind,
              pendingContent,
            }),
          deliverTarget: async (target) =>
            await adapter.deliverTarget({
              ...target,
              approvalKind,
              pendingContent,
            }),
          onDeliveryError: adapter.onDeliveryError
            ? (result) => {
                adapter.onDeliveryError?.({
                  ...result,
                  approvalKind,
                  pendingContent,
                });
              }
            : undefined,
          onDuplicateSkipped: adapter.onDuplicateSkipped
            ? (result) => {
                adapter.onDuplicateSkipped?.({
                  ...result,
                  approvalKind,
                  pendingContent,
                });
              }
            : undefined,
          onDelivered: adapter.onDelivered
            ? (result) => {
                adapter.onDelivered?.({
                  ...result,
                  approvalKind,
                  pendingContent,
                });
              }
            : undefined,
        });
        deliveryPlan = deliveryResult.deliveryPlan;
        deliveredTargets = deliveryResult.deliveredTargets;
        attemptedTargets = deliveryResult.attemptedTargets;
        return deliveryResult.entries;
      } finally {
        if (shouldSend()) {
          await routeReporter.reportDelivery({
            approvalKind,
            request,
            deliveryPlan,
            deliveredTargets,
            attemptedTargets,
          });
        } else {
          routeReporter.completeRequest(request.id);
        }
      }
    },
  });

  return {
    ...runtime,
    async start() {
      try {
        await runtime.start();
      } catch (error) {
        await routeReporter.stop();
        throw error;
      }
    },
    async stop() {
      await runtime.stop();
      await routeReporter.stop();
    },
  };
}
