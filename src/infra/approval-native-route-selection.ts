import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "../../packages/gateway-client/src/timeouts.js";
import type { ExecApprovalForwardTarget } from "../config/types.approvals.js";
import type { ChannelApprovalNativePlannedTarget } from "./approval-native-delivery.js";
import type { ApprovalRequestInput, ApprovalRequestChannelRouteClass } from "./approval-types.js";

export type ApprovalRouteSelectionVerdict =
  | { kind: "selected" | "ambiguous-owner" | "ineligible" | "owner-unavailable" }
  | { kind: "selector-error"; error: unknown };
export type ApprovalNativeDeliveryOutcome = {
  kind: "confirmed" | "unconfirmed" | "cancelled";
  attemptedTargets: ExecApprovalForwardTarget[];
};

type SelectionRuntime = {
  runtimeId: string;
  channel?: string;
  shouldHandle: (request: ApprovalRequestInput) => boolean;
  classifyRoute: (request: ApprovalRequestInput) => ApprovalRequestChannelRouteClass;
};

export function selectNativeApprovalRouteVerdicts(
  runtimes: readonly SelectionRuntime[],
  request: ApprovalRequestInput,
): Map<string, ApprovalRouteSelectionVerdict> {
  const verdicts = new Map<string, ApprovalRouteSelectionVerdict>();
  const groups = new Map<string, SelectionRuntime[]>();
  for (const runtime of runtimes) {
    const key = normalizeLowercaseStringOrEmpty(runtime.channel) || runtime.runtimeId;
    groups.set(key, [...(groups.get(key) ?? []), runtime]);
  }

  const selectedRuntimeIds = new Set<string>();
  for (const group of groups.values()) {
    const candidates: SelectionRuntime[] = [];
    for (const runtime of group) {
      try {
        if (runtime.shouldHandle(request)) {
          candidates.push(runtime);
        }
      } catch (error) {
        verdicts.set(runtime.runtimeId, { kind: "selector-error", error });
      }
    }
    let routeClass: ApprovalRequestChannelRouteClass;
    try {
      routeClass = group[0]?.classifyRoute(request) ?? "unbound";
    } catch (error) {
      for (const runtime of group) {
        verdicts.set(runtime.runtimeId, { kind: "selector-error", error });
      }
      continue;
    }
    if (routeClass === "bound-or-explicit") {
      if (candidates.length === 0) {
        for (const runtime of group) {
          if (!verdicts.has(runtime.runtimeId)) {
            verdicts.set(runtime.runtimeId, { kind: "owner-unavailable" });
          }
        }
        continue;
      }
      for (const runtime of candidates) {
        selectedRuntimeIds.add(runtime.runtimeId);
      }
    } else if (routeClass === "unbound" && candidates.length === 1) {
      const [candidate] = candidates;
      if (candidate) {
        selectedRuntimeIds.add(candidate.runtimeId);
      }
    } else if (routeClass === "unbound" && candidates.length > 1) {
      for (const runtime of candidates) {
        verdicts.set(runtime.runtimeId, { kind: "ambiguous-owner" });
      }
    }
  }

  for (const runtime of runtimes) {
    if (selectedRuntimeIds.has(runtime.runtimeId)) {
      verdicts.set(runtime.runtimeId, { kind: "selected" });
    } else if (!verdicts.has(runtime.runtimeId)) {
      verdicts.set(runtime.runtimeId, { kind: "ineligible" });
    }
  }

  return verdicts;
}

type DeliverySelection = {
  verdicts: ReadonlyMap<string, ApprovalRouteSelectionVerdict>;
  reports: ReadonlyMap<
    string,
    {
      channel?: string;
      accountId?: string | null;
      deliveredTargets: readonly ChannelApprovalNativePlannedTarget[];
      attemptedTargets?: readonly ChannelApprovalNativePlannedTarget[];
    }
  >;
  attempts: ReadonlyMap<string, ExecApprovalForwardTarget[]>;
  delivery: { promise: Promise<ApprovalNativeDeliveryOutcome> };
};

export function readNativeDeliveryOutcome(
  selection: DeliverySelection,
  force = false,
): ApprovalNativeDeliveryOutcome | undefined {
  const selectedIds = Array.from(selection.verdicts)
    .filter(([, verdict]) => verdict.kind === "selected")
    .map(([id]) => id);
  const reports = selectedIds.flatMap((id) => {
    const report = selection.reports.get(id);
    return report ? [report] : [];
  });
  const confirmed = reports.some((report) => report.deliveredTargets.length > 0);
  if (!confirmed && !force && reports.length !== selectedIds.length) {
    return undefined;
  }
  const attemptedTargets = Array.from(selection.attempts.values()).flat();
  for (const report of reports) {
    const channel = report.channel;
    if (!channel) {
      continue;
    }
    for (const { target } of report.attemptedTargets ?? report.deliveredTargets) {
      const attempted: ExecApprovalForwardTarget = { channel, to: target.to };
      if (report.accountId) {
        attempted.accountId = report.accountId;
      }
      if (target.threadId != null) {
        attempted.threadId = target.threadId;
      }
      attemptedTargets.push(attempted);
    }
  }
  return { kind: confirmed ? "confirmed" : "unconfirmed", attemptedTargets };
}

export async function waitForNativeDeliveryOutcome(
  selection: DeliverySelection,
  params: { expiresAtMs: number; timeoutMs?: number; onTimeout: () => void },
): Promise<ApprovalNativeDeliveryOutcome> {
  const known = readNativeDeliveryOutcome(selection);
  if (known) {
    return known;
  }
  const timeoutMs = Math.min(
    Math.max(0, params.expiresAtMs - Date.now()),
    params.timeoutMs ?? DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ApprovalNativeDeliveryOutcome>((resolve) => {
    timer = setTimeout(() => {
      params.onTimeout();
      const outcome = readNativeDeliveryOutcome(selection, true);
      if (outcome) {
        resolve(outcome);
      }
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([selection.delivery.promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
