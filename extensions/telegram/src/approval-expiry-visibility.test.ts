import { describe, expect, it } from "vitest";
import { telegramApprovalNativeRuntime } from "./approval-handler.runtime.js";
import {
  buildTelegramCanonicalApprovalTerminalText,
  buildTelegramNativeExpiredApprovalText,
} from "./approval-terminal.js";

const createdAtMs = Date.parse("2026-10-05T10:11:03.544Z");
const expiresAtMs = createdAtMs + 600_000;

function pendingGuard(timeZone = "Asia/Shanghai", nowMs = createdAtMs) {
  return {
    cfg: { agents: { defaults: { userTimezone: timeZone } } },
    accountId: "default",
    context: { token: "synthetic-token" },
    approvalKind: "plugin",
    nowMs,
    request: {
      id: "plugin:guard-clock",
      createdAtMs,
      expiresAtMs,
      request: {
        pluginId: "approval-guard",
        title: "风险操作待确认",
        description: "命令：echo synthetic",
      },
    },
    view: {
      approvalKind: "plugin",
      phase: "pending",
      pluginId: "approval-guard",
      approvalId: "plugin:guard-clock",
      title: "风险操作待确认",
      description: "命令：echo synthetic",
      severity: "warning",
      metadata: [],
      expiresAtMs,
      actions: (["allow-once", "deny"] as const).map((decision) => ({
        decision,
        label: decision,
        style: decision === "deny" ? ("danger" as const) : ("success" as const),
        command: `/approve plugin:guard-clock ${decision}`,
        action: {
          type: "approval" as const,
          approvalKind: "plugin" as const,
          approvalId: "plugin:guard-clock",
          decision,
        },
      })),
    },
  } satisfies Parameters<typeof telegramApprovalNativeRuntime.presentation.buildPendingPayload>[0];
}

describe("Telegram guard approval expiry visibility", () => {
  it.each([
    ["Asia/Shanghai", "2026-10-05 18:21:03 GMT+8"],
    ["UTC", "2026-10-05 10:21:03 UTC"],
    ["invalid-timezone", "2026-10-05T10:21:03Z"],
  ])("shows an absolute deadline for %s without changing decisions", async (zone, deadline) => {
    const payload = await telegramApprovalNativeRuntime.presentation.buildPendingPayload(
      pendingGuard(zone),
    );
    expect(payload).toMatchObject({ text: expect.stringContaining(`截止：${deadline}`) });
    expect(payload).toMatchObject({ text: expect.stringContaining("10 分钟内有效") });
    expect(payload).toMatchObject({
      buttons: [
        [
          { callback_data: "tga1:p:o:plugin:guard-clock" },
          { callback_data: "tga1:p:d:plugin:guard-clock" },
        ],
      ],
    });
  });

  it("does not render live approval buttons after the card deadline", async () => {
    const payload = await telegramApprovalNativeRuntime.presentation.buildPendingPayload(
      pendingGuard("Asia/Shanghai", expiresAtMs),
    );
    expect(payload).toMatchObject({ text: expect.stringContaining("已到期"), buttons: [] });
    expect(payload).toMatchObject({
      text: expect.stringContaining("2026-10-05 18:21:03 GMT+8"),
    });
  });

  it("keeps a local card deadline distinct from the authoritative execution outcome", () => {
    const text = buildTelegramNativeExpiredApprovalText({
      approvalKind: "plugin",
      pluginId: "approval-guard",
      approvalId: "plugin:guard-clock",
      phase: "expired",
      title: "风险操作待确认",
      description: "命令：echo synthetic",
      severity: "warning",
      metadata: [],
    });
    expect(text).toContain("此卡已到期");
    expect(text).not.toMatch(/未执行|已拒绝/);
  });

  it("states non-execution only for a canonical expired guard request", () => {
    const text = buildTelegramCanonicalApprovalTerminalText({
      result: {
        applied: false,
        approval: {
          id: "plugin:guard-clock",
          status: "expired",
          reason: "timeout",
          createdAtMs,
          expiresAtMs,
          resolvedAtMs: expiresAtMs,
          urlPath: "/approve/plugin:guard-clock",
          presentation: {
            kind: "plugin",
            pluginId: "approval-guard",
            title: "风险操作待确认",
            description: "命令：echo synthetic",
            severity: "warning",
            allowedDecisions: ["allow-once", "deny"],
          },
        },
      },
      fallbackApprovalId: "plugin:guard-clock",
    });
    expect(text).toContain("已过期（未执行）");
  });
});
