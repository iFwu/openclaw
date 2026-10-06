import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ReplyPayload } from "../auto-reply/types.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import {
  getLoadedChannelPlugin,
  resolveChannelApprovalAdapter,
} from "../channels/plugins/index.js";
import { getRuntimeConfig } from "../config/config.js";
import type {
  ExecApprovalForwardingConfig,
  ExecApprovalForwardTarget,
} from "../config/types.approvals.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runWithRetainedGatewayRootWork } from "../process/gateway-work-admission.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { createPendingApprovalRegistry } from "../shared/pending-approval-registry.js";
import { isDeliverableMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";
import { canChannelEnforcePluginReviewerPolicy } from "./approval-channel-policy-support.js";
import {
  hasActiveNativeApprovalRoute,
  type ApprovalNativeRouteCoordinator,
  type ApprovalNativeDeliveryOutcome,
} from "./approval-native-route-coordinator.js";
import { matchesApprovalRequestFilters } from "./approval-request-filters.js";
import {
  resolveApprovalRequestKind,
  type ApprovalRequestInput,
  type ChannelApprovalKind,
} from "./approval-types.js";
import {
  buildTargetKey,
  deliverToTargets,
  type DeliverApprovalPayloads,
  type ForwardTarget,
} from "./exec-approval-forwarder.delivery.js";
import {
  buildForwardedExecApprovalExpired,
  buildForwardedExecPendingPayload,
  buildForwardedExecResolvedPayload,
  buildForwardedPluginPendingPayload,
  buildForwardedPluginResolvedPayload,
  buildForwardedSystemAgentPendingPayload,
  buildForwardedSystemAgentResolvedPayload,
} from "./exec-approval-forwarder.messages.js";
import type { ExecApprovalRequest, ExecApprovalResolved } from "./exec-approvals.js";
import {
  buildPluginApprovalExpiredMessage,
  type PluginApprovalRequest,
  type PluginApprovalResolved,
} from "./plugin-approvals.js";
import type {
  SystemAgentApprovalRequest,
  SystemAgentApprovalResolved,
} from "./system-agent-approvals.js";

// Approval forwarding mirrors foreground approvals into chat targets, then sends
// resolution/expiry notices to the same targets.
const log = createSubsystemLogger("gateway/exec-approvals");
type MaybePromise<T> = T | Promise<T>;
type ResolveSessionTargetFn = (params: {
  cfg: OpenClawConfig;
  request: ExecApprovalRequest;
}) => MaybePromise<ExecApprovalForwardTarget | null>;

type ApprovalRouteRequest = {
  agentId?: string | null;
  sessionKey?: string | null;
  turnSourceChannel?: string | null;
  turnSourceTo?: string | null;
  turnSourceAccountId?: string | null;
  turnSourceThreadId?: string | number | null;
};

type PendingApproval = {
  routeRequest: ApprovalRouteRequest;
  targets: ForwardTarget[];
};

type ApprovalRenderContext = {
  cfg: OpenClawConfig;
  target: ForwardTarget;
};

type ApprovalStrategy<TRequest, TResolved> = {
  kind: ChannelApprovalKind;
  config: (cfg: OpenClawConfig) => ExecApprovalForwardingConfig | undefined;
  /** Omitted when the durable terminal publication owns expiry; no local timer runs. */
  buildExpiredText?: (request: TRequest) => string;
  buildPendingPayload: (
    params: ApprovalRenderContext & { request: TRequest; nowMs: number },
  ) => ReplyPayload;
  buildResolvedPayload: (params: ApprovalRenderContext & { resolved: TResolved }) => ReplyPayload;
  /**
   * Answer only the live messaging chat that made the request: no saved session
   * route, and no terminal notice without this forwarder's own pending entry.
   */
  liveOriginOnly?: boolean;
};

export type ExecApprovalForwarder = {
  handleRequested: (request: ExecApprovalRequest) => Promise<boolean>;
  handleResolved: (resolved: ExecApprovalResolved) => Promise<void>;
  handlePluginApprovalRequested?: (request: PluginApprovalRequest) => Promise<boolean>;
  handlePluginApprovalResolved?: (resolved: PluginApprovalResolved) => Promise<void>;
  handleSystemAgentApprovalRequested?: (request: SystemAgentApprovalRequest) => Promise<boolean>;
  handleSystemAgentApprovalResolved?: (resolved: SystemAgentApprovalResolved) => Promise<void>;
  stop: () => Promise<void>;
};

type ExecApprovalForwarderDeps = {
  getConfig?: () => OpenClawConfig;
  deliver?: DeliverApprovalPayloads;
  nowMs?: () => number;
  resolveSessionTarget?: ResolveSessionTargetFn;
  /** The owning Gateway's coordinator, where its channel accounts register native handlers. */
  getNativeApprovalRouteCoordinator?: () => ApprovalNativeRouteCoordinator | undefined;
  waitForNativeDelivery?: (
    request: ApprovalRequestInput,
    approvalKind: ChannelApprovalKind,
  ) => Promise<ApprovalNativeDeliveryOutcome>;
};

const SYNTHETIC_APPROVAL_REQUEST_ID = "__approval-routing__";

const loadExecApprovalForwarderRuntime = createLazyRuntimeModule(
  () => import("./exec-approval-forwarder.runtime.js"),
);

function shouldForwardRoute(params: {
  config?: {
    enabled?: boolean;
    agentFilter?: string[];
    sessionFilter?: string[];
  };
  routeRequest: ApprovalRouteRequest;
}): boolean {
  const config = params.config;
  if (!config?.enabled) {
    return false;
  }
  return matchesApprovalRequestFilters({
    request: params.routeRequest,
    agentFilter: config.agentFilter,
    sessionFilter: config.sessionFilter,
    fallbackAgentIdFromSessionKey: true,
  });
}

function buildSyntheticApprovalRequest(routeRequest: ApprovalRouteRequest): ExecApprovalRequest {
  return {
    approvalKind: "exec",
    id: SYNTHETIC_APPROVAL_REQUEST_ID,
    request: {
      command: "",
      agentId: routeRequest.agentId ?? null,
      sessionKey: routeRequest.sessionKey ?? null,
      turnSourceChannel: routeRequest.turnSourceChannel ?? null,
      turnSourceTo: routeRequest.turnSourceTo ?? null,
      turnSourceAccountId: routeRequest.turnSourceAccountId ?? null,
      turnSourceThreadId: routeRequest.turnSourceThreadId ?? null,
    },
    createdAtMs: 0,
    expiresAtMs: 0,
  };
}

function restoreApprovalRequestForSuppression(params: {
  approvalKind: ChannelApprovalKind;
  id: string;
  request?: ApprovalRouteRequest | null;
}): ApprovalRequestInput | undefined {
  if (!params.request) {
    return undefined;
  }
  // The resolved snapshot retains its original payload; reconstruct only its
  // owner so a cache-miss notice cannot route through an exec-shaped placeholder.
  const restored = {
    id: params.id,
    request: params.request,
    createdAtMs: 0,
    expiresAtMs: 0,
  };
  try {
    if (resolveApprovalRequestKind(restored) !== params.approvalKind) {
      return undefined;
    }
    // SAFETY: resolved.request retains the typed approval payload; the derived owner matches it.
    return restored as ApprovalRequestInput;
  } catch {
    return undefined;
  }
}

function shouldSkipForwardingFallback(params: {
  approvalKind: ChannelApprovalKind;
  target: ExecApprovalForwardTarget;
  cfg: OpenClawConfig;
  routeRequest: ApprovalRouteRequest;
  approvalRequest?: ApprovalRequestInput;
  nativeRouteCoordinator: ApprovalNativeRouteCoordinator | undefined;
}): boolean {
  const channel = normalizeMessageChannel(params.target.channel) ?? params.target.channel;
  if (!channel) {
    return false;
  }
  // Channel adapters can suppress generic fallback delivery when they already
  // own native approval UX for the same target.
  const plugin = getLoadedChannelPlugin(channel);
  if (
    params.approvalKind === "plugin" &&
    !canChannelEnforcePluginReviewerPolicy(params.cfg, channel, plugin?.approvalCapability)
  ) {
    return true;
  }
  const adapter = resolveChannelApprovalAdapter(plugin);
  const fallbackInput = {
    cfg: params.cfg,
    approvalKind: params.approvalKind,
    target: params.target,
    request: params.approvalRequest ?? buildSyntheticApprovalRequest(params.routeRequest),
  };
  if (adapter?.delivery?.shouldBlockForwardingFallback?.(fallbackInput)) {
    return true;
  }
  const suppress = adapter?.delivery?.shouldSuppressForwardingFallback?.(fallbackInput) ?? false;
  if (!suppress || !plugin) {
    return false;
  }
  // Suppression hands the chat to the native handler, so it holds only while the handler
  // for the destination account runs; a target without one is delivered by the default.
  return hasActiveNativeApprovalRoute(params.nativeRouteCoordinator, {
    channel,
    accountId:
      normalizeOptionalString(params.target.accountId) ??
      resolveChannelDefaultAccountId({ plugin, cfg: params.cfg }),
    approvalKind: params.approvalKind,
  });
}

function normalizeTurnSourceChannel(value?: string | null): string | undefined {
  const normalized = value ? normalizeMessageChannel(value) : undefined;
  if (
    !normalized ||
    (!isDeliverableMessageChannel(normalized) && normalized !== "webchat" && normalized !== "tui")
  ) {
    return undefined;
  }
  return normalized;
}

function normalizeForwardingTurnSourceChannel(
  value: string | null | undefined,
  approvalKind: ChannelApprovalKind,
): string | undefined {
  const normalized = normalizeTurnSourceChannel(value);
  if (approvalKind === "exec" && normalized && !isDeliverableMessageChannel(normalized)) {
    return undefined;
  }
  return normalized;
}

function extractApprovalRouteRequest(
  request: ApprovalRouteRequest | null | undefined,
): ApprovalRouteRequest | null {
  if (!request) {
    return null;
  }
  return {
    agentId: request.agentId ?? null,
    sessionKey: request.sessionKey ?? null,
    turnSourceChannel: request.turnSourceChannel ?? null,
    turnSourceTo: request.turnSourceTo ?? null,
    turnSourceAccountId: request.turnSourceAccountId ?? null,
    turnSourceThreadId: request.turnSourceThreadId ?? null,
  };
}

function defaultResolveSessionTarget(params: {
  cfg: OpenClawConfig;
  request: ExecApprovalRequest;
}): Promise<ExecApprovalForwardTarget | null> {
  return loadExecApprovalForwarderRuntime().then(({ resolveExecApprovalSessionTarget }) => {
    const resolvedTarget = resolveExecApprovalSessionTarget({
      cfg: params.cfg,
      request: params.request,
      turnSourceChannel: normalizeTurnSourceChannel(params.request.request.turnSourceChannel),
      turnSourceTo: normalizeOptionalString(params.request.request.turnSourceTo),
      turnSourceAccountId: normalizeOptionalString(params.request.request.turnSourceAccountId),
      turnSourceThreadId: params.request.request.turnSourceThreadId ?? undefined,
    });
    if (!resolvedTarget?.channel || !resolvedTarget.to) {
      return null;
    }
    const channel = resolvedTarget.channel;
    if (!isDeliverableMessageChannel(channel)) {
      return null;
    }
    return {
      channel,
      to: resolvedTarget.to,
      accountId: resolvedTarget.accountId,
      threadId: resolvedTarget.threadId,
    };
  });
}

async function resolveForwardTargets(params: {
  cfg: OpenClawConfig;
  config?: ExecApprovalForwardingConfig;
  approvalKind: ChannelApprovalKind;
  routeRequest: ApprovalRouteRequest;
  resolveSessionTarget: ResolveSessionTargetFn;
}): Promise<ForwardTarget[]> {
  const mode = params.config?.mode ?? "session";
  const targets: ForwardTarget[] = [];
  const seen = new Set<string>();

  if (mode === "session" || mode === "both") {
    const sessionRouteRequest = {
      ...params.routeRequest,
      turnSourceChannel: normalizeForwardingTurnSourceChannel(
        params.routeRequest.turnSourceChannel,
        params.approvalKind,
      ),
    };
    const sessionTarget = await params.resolveSessionTarget({
      cfg: params.cfg,
      request: buildSyntheticApprovalRequest(sessionRouteRequest),
    });
    if (sessionTarget) {
      const key = buildTargetKey(params.cfg, sessionTarget);
      if (!seen.has(key)) {
        seen.add(key);
        targets.push({ ...sessionTarget, source: "session" });
      }
    }
  }

  if (mode === "targets" || mode === "both") {
    const explicitTargets = params.config?.targets ?? [];
    for (const target of explicitTargets) {
      const key = buildTargetKey(params.cfg, target);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      targets.push({ ...target, source: "target" });
    }
  }

  return targets;
}

function createApprovalHandlers<
  TRequest extends ApprovalRequestInput,
  TResolved extends { id: string; request?: ApprovalRouteRequest | null },
>(params: {
  strategy: ApprovalStrategy<TRequest, TResolved>;
  getConfig: () => OpenClawConfig;
  deliver: DeliverApprovalPayloads;
  nowMs: () => number;
  resolveSessionTarget: ResolveSessionTargetFn;
  getNativeApprovalRouteCoordinator: () => ApprovalNativeRouteCoordinator | undefined;
  waitForNativeDelivery?: ExecApprovalForwarderDeps["waitForNativeDelivery"];
}) {
  const pending = createPendingApprovalRegistry<PendingApproval>();
  const work = new AsyncWorkScope();
  let stopped = false;
  let stopPromise: Promise<void> | undefined;
  const trackDelivery = <T>(run: () => Promise<T>) =>
    work.track(() => runWithRetainedGatewayRootWork(run));

  const resolveTargets = async (paramsForRoute: {
    cfg: OpenClawConfig;
    config?: ExecApprovalForwardingConfig;
    routeRequest: ApprovalRouteRequest;
    approvalRequest?: ApprovalRequestInput;
  }): Promise<ForwardTarget[]> => {
    if (!shouldForwardRoute(paramsForRoute)) {
      return [];
    }
    if (params.strategy.liveOriginOnly) {
      const origin = normalizeMessageChannel(paramsForRoute.routeRequest.turnSourceChannel ?? "");
      if (
        !origin ||
        !isDeliverableMessageChannel(origin) ||
        !normalizeOptionalString(paramsForRoute.routeRequest.turnSourceTo)
      ) {
        return [];
      }
    }
    const targets = await resolveForwardTargets({
      ...paramsForRoute,
      approvalKind: params.strategy.kind,
      resolveSessionTarget: params.resolveSessionTarget,
    });
    const nativeRouteCoordinator = params.getNativeApprovalRouteCoordinator();
    return targets.filter(
      (target) =>
        !shouldSkipForwardingFallback({
          approvalKind: params.strategy.kind,
          target,
          cfg: paramsForRoute.cfg,
          routeRequest: paramsForRoute.routeRequest,
          approvalRequest: paramsForRoute.approvalRequest,
          nativeRouteCoordinator,
        }),
    );
  };

  const deliverResolved = async (resolved: TResolved, entry?: PendingApproval): Promise<void> => {
    const cfg = params.getConfig();
    const routeRequest = entry?.routeRequest ?? extractApprovalRouteRequest(resolved.request);
    const targets =
      entry?.targets ??
      (routeRequest
        ? await resolveTargets({
            cfg,
            config: params.strategy.config(cfg),
            routeRequest,
            approvalRequest: restoreApprovalRequestForSuppression({
              approvalKind: params.strategy.kind,
              id: resolved.id,
              request: resolved.request,
            }),
          })
        : []);
    if (!targets.length) {
      return;
    }
    await deliverToTargets({
      cfg,
      targets,
      buildPayload: (target) =>
        params.strategy.buildResolvedPayload({
          cfg,
          resolved,
          target,
        }),
      deliver: params.deliver,
    });
  };

  const handleRequested = async (request: TRequest): Promise<boolean> => {
    const cfg = params.getConfig();
    const config = params.strategy.config(cfg);
    const requestId = request.id;
    const routeRequest = extractApprovalRouteRequest(request.request) ?? {};
    // Register before route lookup so a fast resolution cannot overtake and resurrect delivery.
    const pendingEntry = pending.begin(requestId, { routeRequest, targets: [] });
    let filteredTargets: ForwardTarget[];
    try {
      filteredTargets = await resolveTargets({
        cfg,
        config,
        routeRequest,
        approvalRequest: request,
      });
    } catch (error) {
      pending.remove(requestId, pendingEntry);
      throw error;
    }
    const fallbackTargets: ForwardTarget[] =
      !params.strategy.liveOriginOnly && shouldForwardRoute({ config, routeRequest })
        ? (config?.fallbackTargets ?? [])
            .filter((target) => {
              const channel = normalizeMessageChannel(target.channel) ?? target.channel;
              const plugin = getLoadedChannelPlugin(channel);
              if (
                params.strategy.kind === "plugin" &&
                !canChannelEnforcePluginReviewerPolicy(cfg, channel, plugin?.approvalCapability)
              ) {
                return false;
              }
              return !resolveChannelApprovalAdapter(
                plugin,
              )?.delivery?.shouldBlockForwardingFallback?.({
                cfg,
                approvalKind: params.strategy.kind,
                target,
                request,
              });
            })
            .map((target) =>
              Object.assign({}, target, {
                source: "fallback" as const,
                fallback: true,
              }),
            )
        : [];
    if (filteredTargets.length === 0 && fallbackTargets.length === 0) {
      pending.remove(requestId, pendingEntry);
      return false;
    }

    pendingEntry.value = { routeRequest, targets: filteredTargets };
    const buildExpiredText = params.strategy.buildExpiredText;
    if (buildExpiredText) {
      const expiresInMs = Math.max(0, request.expiresAtMs - params.nowMs());
      pending.scheduleExpiry(pendingEntry, expiresInMs, (expired) =>
        trackDelivery(() =>
          deliverToTargets({
            cfg,
            targets: expired.value.targets,
            buildPayload: () => ({ text: buildExpiredText(request) }),
            deliver: params.deliver,
          }),
        )
          .then(() => undefined)
          .catch((err: unknown) => {
            log.error(
              `${params.strategy.kind} approvals: failed to deliver expiry notification for ${requestId}: ${String(err)}`,
            );
          }),
      );
    }

    void trackDelivery(async () => {
      const buildPayload = (target: ForwardTarget) => {
        const payload = params.strategy.buildPendingPayload({
          cfg,
          request,
          target,
          nowMs: params.nowMs(),
        });
        if (!target.fallback) {
          return payload;
        }
        const warning =
          target.source === "fallback"
            ? "⚠️ 审批兜底：原审批卡投递未确认，已转到备用会话。"
            : "⚠️ Fallback approval: no trusted deliverable origin was resolved. Original delivery is not confirmed.";
        return {
          ...payload,
          text: [
            warning,
            `Original session: ${routeRequest.sessionKey?.trim() || "unknown"}`,
            `Source: ${routeRequest.turnSourceChannel?.trim() || "unknown"} / ${routeRequest.turnSourceTo?.trim() || "unknown"}`,
            payload.text,
          ]
            .filter(Boolean)
            .join("\n"),
        };
      };
      const beforeDeliver = async (target: ForwardTarget, payload: ReplyPayload) => {
        const channel = normalizeMessageChannel(target.channel) ?? target.channel;
        if (!channel) {
          return;
        }
        await getLoadedChannelPlugin(channel)?.outbound?.beforeDeliverPayload?.({
          cfg,
          target,
          payload,
          hint: { kind: "approval-pending", approvalKind: params.strategy.kind },
        });
      };
      const owningCoordinator = params.getNativeApprovalRouteCoordinator();
      const canSendPending = () =>
        (!owningCoordinator || owningCoordinator.isActive()) &&
        !stopped &&
        pending.isCurrent(pendingEntry) &&
        !pendingEntry.queued &&
        request.expiresAtMs > params.nowMs();
      const primary = await deliverToTargets({
        cfg,
        targets: filteredTargets,
        buildPayload,
        beforeDeliver,
        deliver: params.deliver,
        shouldSend: canSendPending,
      });
      if (fallbackTargets.length > 0) {
        pendingEntry.value.targets = primary.confirmed;
        const outcome =
          primary.confirmed.length > 0
            ? undefined
            : await params.waitForNativeDelivery?.(request, params.strategy.kind);
        if (
          primary.confirmed.length === 0 &&
          outcome?.kind !== "confirmed" &&
          outcome?.kind !== "cancelled" &&
          canSendPending()
        ) {
          const attempted = new Set(
            [...primary.attempted, ...(outcome?.attemptedTargets ?? [])].map((target) =>
              buildTargetKey(cfg, target),
            ),
          );
          const backups = fallbackTargets.filter((target) => {
            const key = buildTargetKey(cfg, target);
            if (attempted.has(key)) {
              return false;
            }
            attempted.add(key);
            return true;
          });
          const delivered = await deliverToTargets({
            cfg,
            targets: backups,
            buildPayload,
            beforeDeliver,
            deliver: params.deliver,
            shouldSend: canSendPending,
          });
          pendingEntry.value.targets.push(...delivered.confirmed);
        }
      }
      await pending.completeDelivery(pendingEntry, pendingEntry.value);
    }).catch((err: unknown) => {
      log.error(
        `${params.strategy.kind} approvals: failed to deliver request ${requestId}: ${String(err)}`,
      );
    });
    return true;
  };

  const handleResolved = async (resolved: TResolved) => {
    const settled = pending.settle(resolved.id, (entry) => deliverResolved(resolved, entry.value));
    if (settled.status === "queued") {
      return;
    }
    if (settled.status === "taken") {
      await settled.terminal(settled.entry);
      return;
    }
    // Only this forwarder's own entry proves the chat was asked; without it the
    // request went to a native card or had no live chat to answer.
    if (!params.strategy.liveOriginOnly) {
      await deliverResolved(resolved);
    }
  };

  return {
    handleRequested: (request: TRequest) =>
      stopped ? Promise.resolve(false) : trackDelivery(() => handleRequested(request)),
    handleResolved: (resolved: TResolved) =>
      stopped ? Promise.resolve() : trackDelivery(() => handleResolved(resolved)),
    stop: () => {
      if (!stopPromise) {
        stopped = true;
        // Stop future expiry, but retain a genuine terminal queued behind an active delivery.
        pending.stopExpiryTimers();
        stopPromise = work.drain().then(() => pending.clear());
      }
      return stopPromise;
    },
  };
}

const execApprovalStrategy = {
  kind: "exec",
  config: (cfg) => cfg.approvals?.exec,
  buildExpiredText: buildForwardedExecApprovalExpired,
  buildPendingPayload: buildForwardedExecPendingPayload,
  buildResolvedPayload: buildForwardedExecResolvedPayload,
} satisfies ApprovalStrategy<ExecApprovalRequest, ExecApprovalResolved>;

const pluginApprovalStrategy = {
  kind: "plugin",
  config: (cfg) => cfg.approvals?.plugin,
  buildExpiredText: buildPluginApprovalExpiredMessage,
  buildPendingPayload: buildForwardedPluginPendingPayload,
  buildResolvedPayload: buildForwardedPluginResolvedPayload,
} satisfies ApprovalStrategy<PluginApprovalRequest, PluginApprovalResolved>;

// A delegated OpenClaw change blocks the requesting tool until someone decides,
// so the requesting messaging chat always gets a reply path. A native card for
// the same target suppresses this text through the shared fallback check.
const SYSTEM_AGENT_FORWARDING: ExecApprovalForwardingConfig = { enabled: true, mode: "session" };

const systemAgentApprovalStrategy = {
  kind: "system-agent",
  config: () => SYSTEM_AGENT_FORWARDING,
  // No local expiry timer: an approved change may still be applying at the
  // deadline, so only the Gateway's recorded expiry reports a lapse.
  buildPendingPayload: buildForwardedSystemAgentPendingPayload,
  buildResolvedPayload: buildForwardedSystemAgentResolvedPayload,
  liveOriginOnly: true,
} satisfies ApprovalStrategy<SystemAgentApprovalRequest, SystemAgentApprovalResolved>;

export function createExecApprovalForwarder(
  deps: ExecApprovalForwarderDeps = {},
): ExecApprovalForwarder {
  const getConfig = deps.getConfig ?? getRuntimeConfig;
  const deliver =
    deps.deliver ??
    (async (params) => {
      const { sendDurableMessageBatchCore } = await loadExecApprovalForwarderRuntime();
      return sendDurableMessageBatchCore(params);
    });
  const nowMs = deps.nowMs ?? Date.now;
  const resolveSessionTarget = deps.resolveSessionTarget ?? defaultResolveSessionTarget;
  const getNativeApprovalRouteCoordinator =
    deps.getNativeApprovalRouteCoordinator ?? (() => undefined);

  const handlerDeps = {
    getConfig,
    deliver,
    nowMs,
    resolveSessionTarget,
    getNativeApprovalRouteCoordinator,
    waitForNativeDelivery:
      deps.waitForNativeDelivery ??
      (async (request: ApprovalRequestInput, approvalKind: ChannelApprovalKind) =>
        (await getNativeApprovalRouteCoordinator()?.waitForDelivery({ request, approvalKind })) ?? {
          kind: "unconfirmed" as const,
          attemptedTargets: [],
        }),
  };
  const execHandlers = createApprovalHandlers({
    ...handlerDeps,
    strategy: execApprovalStrategy,
  });
  const pluginHandlers = createApprovalHandlers({
    ...handlerDeps,
    strategy: pluginApprovalStrategy,
  });
  const systemAgentHandlers = createApprovalHandlers({
    ...handlerDeps,
    strategy: systemAgentApprovalStrategy,
  });

  return {
    handleRequested: execHandlers.handleRequested,
    handleResolved: execHandlers.handleResolved,
    handlePluginApprovalRequested: pluginHandlers.handleRequested,
    handlePluginApprovalResolved: pluginHandlers.handleResolved,
    handleSystemAgentApprovalRequested: systemAgentHandlers.handleRequested,
    handleSystemAgentApprovalResolved: systemAgentHandlers.handleResolved,
    stop: async () => {
      await Promise.all([execHandlers.stop(), pluginHandlers.stop(), systemAgentHandlers.stop()]);
    },
  };
}
