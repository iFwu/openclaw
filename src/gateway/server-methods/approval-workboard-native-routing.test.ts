import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
const { telegramPlugin } = await loadBundledPluginFacade<{ telegramPlugin: ChannelPlugin }>({
  pluginId: "telegram",
  artifactBasename: "channel-plugin-api.ts",
});
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createChannelApprovalHandlerFromCapability } from "../../infra/approval-handler-runtime.js";
import { resolveChannelNativeApprovalDeliveryPlan } from "../../infra/approval-native-delivery.js";
import {
  getSessionBindingService,
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import { upsertSessionEntry } from "../../plugin-sdk/session-store-runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../../plugin-sdk/sqlite-runtime-testing.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import { resolveAgentRuntimeApprovalOrigin } from "./approval-session-origin.js";

const cfg: OpenClawConfig = {
  channels: {
    telegram: {
      botToken: "test-token",
      execApprovals: { enabled: true, approvers: ["123456789"], target: "channel" },
    },
  },
};
const sessionKey = "agent:main:subagent:workboard-default-card";
const operationalRunInstance = { instanceId: "instance-1", runId: "run-1" };
const runtime: AgentRuntimeIdentity = {
  kind: "agentRuntime",
  agentId: "main",
  sessionKey,
  operationalRunInstance,
  delegatedAuthority: {
    kind: "local",
    operationalRunInstance,
    lifecycleGeneration: "generation-1",
    claimId: "claim-1",
  },
};
afterEach(() => vi.restoreAllMocks());
describe("Workboard binding to Telegram native approval plan", () => {
  it.each(["exec", "plugin"] as const)(
    "plans exactly one topic card and no DM for %s after bind",
    async (kind) => {
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "telegram", source: "test", plugin: telegramPlugin }]),
      );
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "approval-bound-worker-"));
      const storePath = path.join(dir, "sessions.json");
      const config = { ...cfg, session: { store: storePath } };
      onTestFinished(() => {
        closeOpenClawAgentDatabasesForTest();
        fs.rmSync(dir, { recursive: true, force: true });
      });
      let bound: SessionBindingRecord | null = null;
      const adapter = {
        channel: "telegram",
        accountId: "default",
        bind: async () =>
          (bound = {
            bindingId: "task-topic",
            targetSessionKey: sessionKey,
            targetKind: "session" as const,
            conversation: {
              channel: "telegram",
              accountId: "default",
              conversationId: "-100123:topic:42",
            },
            status: "active" as const,
            boundAt: Date.now(),
          }),
        listBySession: (key: string) => (bound && key === sessionKey ? [bound] : []),
        resolveByConversation: () => bound,
      };
      registerSessionBindingAdapter(adapter);
      onTestFinished(() => unregisterSessionBindingAdapter({ ...adapter, adapter }));
      const makeRequest = (id = "approval-1") => {
        const origin = resolveAgentRuntimeApprovalOrigin(runtime);
        const common = {
          id,
          createdAtMs: Date.now(),
          expiresAtMs: Date.now() + 60000,
        };
        return kind === "exec"
          ? { ...common, request: { command: "echo synthetic", sessionKey, ...origin } }
          : {
              ...common,
              request: {
                title: "Synthetic approval",
                description: "D",
                pluginId: "approval-guard",
                sessionKey,
                ...origin,
              },
            };
      };
      const plan = async () => {
        return resolveChannelNativeApprovalDeliveryPlan({
          cfg: config,
          accountId: "default",
          approvalKind: kind,
          request: makeRequest(),
          adapter: telegramPlugin.approvalCapability?.native,
        });
      };
      expect((await plan()).targets).toEqual([
        { surface: "approver-dm", target: { to: "123456789" }, reason: "fallback" },
      ]);
      await getSessionBindingService().bind({
        targetSessionKey: sessionKey,
        targetKind: "session",
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "-100123:topic:42",
        },
        placement: "current",
      });
      // Inbound Telegram messages persist the full target as well as the thread.
      await upsertSessionEntry({
        storePath,
        sessionKey,
        entry: {
          sessionId: "old-worker",
          updatedAt: Date.now(),
          delivery: normalizeSessionDeliveryState({
            context: {
              channel: "telegram",
              to: "telegram:-100123:topic:42",
              accountId: "default",
              threadId: 42,
            },
          }),
        },
      });
      const sendMessage = vi.fn(async () => ({ chatId: "-100123", messageId: "sent-card" }));
      const editMessage = vi.fn(async () => {});
      const handler = await createChannelApprovalHandlerFromCapability({
        capability: telegramPlugin.approvalCapability,
        label: "test/workboard-approval",
        clientDisplayName: "Workboard test",
        channel: "telegram",
        channelLabel: "Telegram",
        accountId: "default",
        cfg: config,
        context: {
          token: "test-token",
          deps: { sendTyping: vi.fn(async () => {}), sendMessage, editMessage },
        },
      });
      if (!handler) {
        throw new Error("Telegram approval handler unavailable");
      }
      onTestFinished(async () => {
        await handler.stop();
      });
      for (let round = 0; round < 2; round++) {
        const result = await plan();
        expect(result.targets).toEqual([
          { surface: "origin", target: { to: "-100123", threadId: 42 }, reason: "preferred" },
        ]);
        expect(result.notifyOriginWhenDmOnly).toBe(false);
        const request = makeRequest(`${kind}:round-${round}`);
        await handler.handleRequested(request);
        expect(sendMessage).toHaveBeenCalledTimes(round + 1);
        expect(sendMessage).toHaveBeenLastCalledWith(
          "-100123",
          expect.any(String),
          expect.objectContaining({
            accountId: "default",
            messageThreadId: 42,
            buttons: expect.any(Array),
          }),
        );
        await handler.handleResolved({
          id: request.id,
          decision: round === 0 ? "allow-once" : "deny",
          ts: Date.now(),
        });
      }
    },
  );
});
