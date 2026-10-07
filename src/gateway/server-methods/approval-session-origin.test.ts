import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
const { telegramPlugin } = await loadBundledPluginFacade<{ telegramPlugin: ChannelPlugin }>({
  pluginId: "telegram",
  artifactBasename: "channel-plugin-api.ts",
});
import {
  getSessionBindingService,
  type SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import { resolveAgentRuntimeApprovalOrigin } from "./approval-session-origin.js";

const workerKey = "agent:main:subagent:workboard-default-card";
const operationalRunInstance = { instanceId: "instance-1", runId: "run-1" };
const runtime: AgentRuntimeIdentity = {
  kind: "agentRuntime",
  agentId: "main",
  sessionKey: workerKey,
  operationalRunInstance,
  delegatedAuthority: {
    kind: "local",
    operationalRunInstance,
    lifecycleGeneration: "generation-1",
    claimId: "claim-1",
  },
  turnSourceChannel: "telegram",
  turnSourceTo: "-100456",
  turnSourceAccountId: "default",
  turnSourceThreadId: "7",
};
function binding(overrides: Partial<SessionBindingRecord> = {}): SessionBindingRecord {
  return {
    bindingId: "task-room",
    targetSessionKey: workerKey,
    targetKind: "session",
    status: "active",
    boundAt: Date.now(),
    conversation: { channel: "telegram", accountId: "work", conversationId: "-100123:topic:42" },
    ...overrides,
  };
}
afterEach(() => vi.restoreAllMocks());
describe("host-owned Workboard approval origin", () => {
  beforeEach(() =>
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", source: "test", plugin: telegramPlugin }]),
    ),
  );
  it("captures a pre-bound worker route without mutating its admitted identity", () => {
    vi.spyOn(getSessionBindingService(), "listBySession").mockReturnValue([binding()]);
    expect(resolveAgentRuntimeApprovalOrigin(runtime)).toEqual({
      turnSourceChannel: "telegram",
      turnSourceTo: "-100123:topic:42",
      turnSourceAccountId: "work",
      turnSourceThreadId: "42",
    });
    expect(runtime.turnSourceThreadId).toBe("7");
  });
  it.each([
    ["unbound", []],
    ["ending", [binding({ status: "ending" })]],
    ["ended", [binding({ status: "ended" })]],
    ["expired", [binding({ expiresAt: 1 })]],
    ["wrong worker", [binding({ targetSessionKey: "agent:main:subagent:workboard-other-card" })]],
    [
      "non-Telegram",
      [
        binding({
          conversation: { channel: "slack", accountId: "default", conversationId: "C123" },
        }),
      ],
    ],
    [
      "missing destination",
      [
        binding({
          conversation: { channel: "telegram", accountId: "default", conversationId: " " },
        }),
      ],
    ],
    [
      "ambiguous",
      [
        binding(),
        binding({
          bindingId: "other",
          conversation: {
            channel: "telegram",
            accountId: "other",
            conversationId: "-100789:topic:8",
          },
        }),
      ],
    ],
  ] as const)("preserves the existing route for %s bindings", (_name, records) => {
    vi.spyOn(getSessionBindingService(), "listBySession").mockReturnValue([...records]);
    expect(resolveAgentRuntimeApprovalOrigin(runtime)).toBe(runtime);
  });
  it.each([
    "agent:main:subagent:visible-child",
    "agent:main:telegram:group:-100456:topic:7",
    "agent:main:subagent:workboard-default-card:nested",
    "agent:main:session-1",
  ])("does not change frozen origins or consult bindings for %s", (sessionKey) => {
    const lookup = vi
      .spyOn(getSessionBindingService(), "listBySession")
      .mockReturnValue([binding()]);
    const child = { ...runtime, sessionKey };
    expect(resolveAgentRuntimeApprovalOrigin(child)).toBe(child);
    expect(lookup).not.toHaveBeenCalled();
  });
  it("leaves non-Telegram unbound worker origins unchanged", () => {
    vi.spyOn(getSessionBindingService(), "listBySession").mockReturnValue([]);
    const worker = { ...runtime, turnSourceChannel: "slack", turnSourceTo: "C123" };
    expect(resolveAgentRuntimeApprovalOrigin(worker)).toBe(worker);
  });
});
