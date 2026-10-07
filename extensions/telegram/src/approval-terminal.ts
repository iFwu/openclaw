// Telegram plugin module renders terminal operator approval receipts.
import type { ApprovalResolveResult } from "openclaw/plugin-sdk/approval-gateway-runtime";
import type {
  ExpiredApprovalView,
  ResolvedApprovalView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  buildSystemAgentApprovalResolvedText,
  formatApprovalDecisionLabel,
} from "openclaw/plugin-sdk/approval-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

const TELEGRAM_APPROVAL_DETAIL_MAX_CHARS = 2_800;
const TELEGRAM_APPROVAL_ID_MAX_CHARS = 512;
const TELEGRAM_APPROVAL_TERMINAL_MAX_CHARS = 4_000;
/**
 * Terminal receipts are scrollback, not content.
 *
 * A resolved card repeated its full title *and* description, so every
 * approval left a six-line block in the chat forever. The decision, the
 * subject in one glance, the time, and the id are what a human needs to find
 * the event again; the full command and description stay in the logs.
 */
const TELEGRAM_APPROVAL_SUBJECT_MAX_CHARS = 72;

/** Local wall-clock `HH:MM` for the moment the approval reached its terminal state. */
function formatTerminalTime(now: Date = new Date()): string {
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** Collapse a subject to a single short line; newlines would reintroduce bulk. */
function formatTerminalSubject(value: string | null | undefined): string {
  const collapsed = (value ?? "").replace(/\s+/gu, " ").trim();
  if (!collapsed) {
    return "";
  }
  if (collapsed.length <= TELEGRAM_APPROVAL_SUBJECT_MAX_CHARS) {
    return collapsed;
  }
  return `${truncateUtf16Safe(collapsed, TELEGRAM_APPROVAL_SUBJECT_MAX_CHARS - 1).trimEnd()}…`;
}

/** Second line of every terminal receipt: when it happened and how to find it. */
function formatTerminalTrailer(approvalId: string): string {
  return `${formatTerminalTime()} · ${truncateApprovalId(approvalId)}`;
}

/** Assemble `<icon> <result> · <subject>` without leaving a dangling separator. */
function formatTerminalHeadline(icon: string, result: string, subject: string): string {
  return subject ? `${icon} ${result} · ${subject}` : `${icon} ${result}`;
}

/**
 * Icon for a terminal outcome.
 *
 * A denial reported with ✅ is actively misleading: the receipt is the only
 * durable record left in the chat once the card's buttons are gone.
 */
function iconForDecision(decision: ResolvedApprovalView["decision"] | undefined): string {
  return decision === "deny" ? "❌" : "✅";
}

/** Same, for a canonical snapshot that carries a status rather than a decision. */
function iconForCanonicalStatus(approval: ApprovalResolveResult["approval"]): string {
  if (approval.status === "denied") {
    return "❌";
  }
  if (approval.status === "expired") {
    return "⏱️";
  }
  if (approval.status === "cancelled") {
    return "⚠️";
  }
  return iconForDecision(approval.decision);
}

function formatApprovalDecision(decision: ResolvedApprovalView["decision"] | undefined): string {
  return decision ? formatApprovalDecisionLabel(decision) : "Resolved";
}

function formatCanonicalResult(approval: ApprovalResolveResult["approval"]): string {
  if (approval.status === "allowed" || approval.status === "denied") {
    return formatApprovalDecision(approval.decision);
  }
  return approval.status === "expired" ? "Expired" : "Cancelled";
}

function truncateDetail(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= TELEGRAM_APPROVAL_DETAIL_MAX_CHARS) {
    return trimmed;
  }
  return `${truncateUtf16Safe(trimmed, TELEGRAM_APPROVAL_DETAIL_MAX_CHARS - 1).trimEnd()}…`;
}

function truncateApprovalId(value: string): string {
  // Approval ids may contain path-safe Unicode that is still unsafe as a chat line.
  // JSON escaping keeps the receipt single-line without changing ordinary ids.
  const escaped = JSON.stringify(value).slice(1, -1);
  if (escaped.length <= TELEGRAM_APPROVAL_ID_MAX_CHARS) {
    return escaped;
  }
  return `${truncateUtf16Safe(escaped, TELEGRAM_APPROVAL_ID_MAX_CHARS - 1)}…`;
}

function formatResolvedBy(value: string): string {
  return truncateDetail(value.replace(/\s+/gu, " "));
}

function finalizeTerminalText(lines: string[]): string {
  const text = lines.join("\n");
  if (text.length <= TELEGRAM_APPROVAL_TERMINAL_MAX_CHARS) {
    return text;
  }
  return `${truncateUtf16Safe(text, TELEGRAM_APPROVAL_TERMINAL_MAX_CHARS - 1).trimEnd()}…`;
}

function appendCanonicalSubject(
  presentation: ApprovalResolveResult["approval"]["presentation"],
): string {
  if (presentation.kind === "exec") {
    return formatTerminalSubject(presentation.commandPreview ?? presentation.commandText);
  }
  return formatTerminalSubject(presentation.title);
}

/** Guard previews are bounded after host sanitization, which can expand control escapes. */
export function compactGuardPreview(value: string | undefined): string {
  const chars = Array.from((value ?? "").replace(/\s+/gu, " ").trim());
  return chars.length <= 100 ? chars.join("") : `${chars.slice(0, 99).join("")}…`;
}

export function formatGuardApprovalId(id: string): string {
  return id.replace(/^plugin:/, "").slice(0, 8);
}

function guardTerminalText(
  headline: string,
  approvalId: string,
  description: string | undefined,
  allowWindow = false,
): string {
  const lines = description?.split("\n") ?? [];
  const risk = lines.find((line) => line.startsWith("风险："));
  const window = allowWindow ? lines.find((line) => line.startsWith("限时放行：")) : undefined;
  const preview = compactGuardPreview(
    lines.filter((line) => !line.startsWith("风险：") && !line.startsWith("限时放行：")).join(" "),
  );
  return finalizeTerminalText(
    [
      [headline, `ID：${formatGuardApprovalId(approvalId)}`, risk].filter(Boolean).join(" · "),
      preview,
      [window, "Control UI 查看详情"].filter(Boolean).join(" · "),
    ].filter(Boolean),
  );
}

/** Render the canonical first-answer result returned to a Telegram callback surface. */
export function buildTelegramCanonicalApprovalTerminalText(params: {
  result: ApprovalResolveResult;
  fallbackApprovalId: string;
}): string {
  const approval = params.result.approval;
  if (approval.presentation?.kind === "system-agent" && params.result.applied) {
    if (approval.status === "allowed") {
      return `✅ OpenClaw change approved. Applying: ${truncateDetail(approval.presentation.description)}`;
    }
    if (approval.status === "cancelled") {
      return "⚠️ OpenClaw change was cancelled because its run ended. No change was made. Retry.";
    }
    if (approval.status === "denied") {
      return "❌ OpenClaw change denied. No change was made.";
    }
    if (approval.status === "expired") {
      return "⏱️ OpenClaw change expired. No change was made.";
    }
  }
  const approvalId = approval.id || params.fallbackApprovalId;
  if (
    approval.presentation?.kind === "plugin" &&
    approval.presentation.pluginId === "approval-guard"
  ) {
    const result = {
      allowed:
        approval.status === "allowed" && approval.decision === "allow-always"
          ? "已限时放行"
          : "已允许",
      denied: "已拒绝",
      expired: "已过期（未执行）",
      cancelled: "已取消",
    }[approval.status];
    return guardTerminalText(
      formatTerminalHeadline(
        iconForCanonicalStatus(approval),
        result,
        appendCanonicalSubject(approval.presentation),
      ),
      approvalId,
      approval.presentation.description,
      approval.status === "allowed" && approval.decision === "allow-always",
    );
  }
  const lines = [
    formatTerminalHeadline(
      iconForCanonicalStatus(approval),
      params.result.applied
        ? formatCanonicalResult(approval)
        : `Already resolved: ${formatCanonicalResult(approval)}`,
      approval.presentation ? appendCanonicalSubject(approval.presentation) : "",
    ),
    formatTerminalTrailer(approvalId),
  ];
  return finalizeTerminalText(lines);
}

/** Render a truthful receipt for a legacy callback without a canonical snapshot. */
export function buildTelegramLegacyApprovalTerminalText(params: {
  approvalId: string;
  decision?: "allow-once" | "allow-always" | "deny";
  outcome: "resolved-here" | "no-longer-pending" | "not-actionable";
}): string {
  const headline =
    params.outcome === "resolved-here"
      ? `${iconForDecision(params.decision)} ${formatApprovalDecision(params.decision)}`
      : params.outcome === "no-longer-pending"
        ? "ℹ️ No longer pending · already resolved or expired"
        : "ℹ️ Not actionable from this button";
  return finalizeTerminalText([headline, formatTerminalTrailer(params.approvalId)]);
}

/** Render a neutral terminal receipt for malformed callbacks in the reserved namespace. */
export function buildTelegramInvalidApprovalTerminalText(): string {
  return "ℹ️ Approval action unavailable\nThis button is invalid or no longer actionable.";
}

function appendViewSubject(view: ResolvedApprovalView | ExpiredApprovalView): string {
  if (view.approvalKind === "exec") {
    return formatTerminalSubject(view.commandPreview ?? view.commandText);
  }
  return formatTerminalSubject(view.title);
}

/** Render a canonical native resolved event while retaining safe request context. */
export function buildTelegramNativeResolvedApprovalText(view: ResolvedApprovalView): string {
  if (view.approvalKind === "system-agent") {
    return buildSystemAgentApprovalResolvedText({
      ...view,
      operationSummary: truncateDetail(view.operationSummary),
    });
  }
  if (view.approvalKind === "plugin" && view.pluginId === "approval-guard") {
    return guardTerminalText(
      formatTerminalHeadline(
        iconForDecision(view.decision),
        view.decision === "deny"
          ? "已拒绝"
          : view.decision === "allow-always"
            ? "已限时放行"
            : "已允许",
        appendViewSubject(view),
      ),
      view.approvalId,
      view.description ?? undefined,
      view.decision === "allow-always",
    );
  }
  const label = view.approvalKind === "exec" ? "Exec" : "Plugin";
  const resolvedBy = view.resolvedBy?.trim() ? ` · by ${formatResolvedBy(view.resolvedBy)}` : "";
  const lines = [
    formatTerminalHeadline(
      iconForDecision(view.decision),
      `${label} ${formatApprovalDecision(view.decision)}`,
      appendViewSubject(view),
    ),
    `${formatTerminalTrailer(view.approvalId)}${resolvedBy}`,
  ];
  return finalizeTerminalText(lines);
}

/** Render a canonical native expiration event while retaining safe request context. */
export function buildTelegramNativeExpiredApprovalText(view: ExpiredApprovalView): string {
  if (view.approvalKind === "system-agent") {
    return "⏱️ OpenClaw change expired. No change was made.";
  }
  if (view.approvalKind === "plugin" && view.pluginId === "approval-guard") {
    // Local card timers can precede a late gateway resolution; do not infer execution here.
    return guardTerminalText(
      formatTerminalHeadline("⏱️", "此卡已到期", appendViewSubject(view)),
      view.approvalId,
      view.description ?? undefined,
    );
  }
  const label = view.approvalKind === "exec" ? "Exec" : "Plugin";
  const lines = [
    formatTerminalHeadline("⏱️", `${label} expired`, appendViewSubject(view)),
    formatTerminalTrailer(view.approvalId),
  ];
  return finalizeTerminalText(lines);
}
