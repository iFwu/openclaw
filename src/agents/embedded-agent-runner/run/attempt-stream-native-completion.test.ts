import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerSubagentCompletionToolHandoff,
  consumeSubagentCompletionToolHandoff,
} from "../../../gateway/subagent-completion-tool-handoff.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../admitted-run-context.js";
import { isAgentRunSupersededAbortReason } from "../../run-termination.js";
import { registerAgentSessionLoopTestLifecycle } from "../../sessions/agent-session-loop-correctness.test-support.js";
import { ACTIVE_EMBEDDED_RUNS } from "../run-state.js";

const mocks = vi.hoisted(() => ({
  clearActiveRun: vi.fn(),
  setActiveRun: vi.fn(),
  subscribe: vi.fn(),
  notifyToolActivity: vi.fn(),
  runBeforeFinalizeHook: vi.fn(),
}));
vi.mock("../../embedded-agent-subscribe.js", () => ({
  subscribeEmbeddedAgentSession: mocks.subscribe,
}));
vi.mock("../runs.js", () => ({
  clearActiveEmbeddedRun: mocks.clearActiveRun,
  setActiveEmbeddedRun: mocks.setActiveRun,
}));
vi.mock("./tool-activity-heartbeat.js", () => ({ notifyToolActivity: mocks.notifyToolActivity }));
vi.mock("../../harness/lifecycle-hook-helpers.js", () => ({
  runAgentHarnessBeforeAgentFinalizeHook: mocks.runBeforeFinalizeHook,
}));
import {
  createCatalogSubscription,
  prepareCatalogExecutor,
} from "./attempt-stream-prepare.test-support.js";

registerAgentSessionLoopTestLifecycle();
describe("native completion producer", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    ACTIVE_EMBEDDED_RUNS.clear();
    const runs = await vi.importActual<typeof import("../runs.js")>("../runs.js");
    mocks.setActiveRun.mockImplementation(runs.setActiveEmbeddedRun);
    mocks.clearActiveRun.mockImplementation(runs.clearActiveEmbeddedRun);
    mocks.subscribe.mockReturnValue(createCatalogSubscription());
    mocks.runBeforeFinalizeHook.mockResolvedValue({ action: "continue" });
  });
  afterEach(async () => {
    const { testing } = await import("../runs.test-support.js");
    testing.resetActiveEmbeddedRuns();
    vi.restoreAllMocks();
  });
  it.each(["subagent_announce", "subagent_settle"] as const)(
    "publishes exact native %s preemption without an injection operation",
    async (sourceTool) => {
      const sourceSessionKey = "agent:main:subagent:completion-child";
      const targetSessionKey = "agent:main:main";
      const targetSessionId = "session-output-schema";
      const handoffId = registerSubagentCompletionToolHandoff({
        sourceSessionKey,
        ...(sourceTool === "subagent_announce" ? { sourceSessionId: "child-instance" } : {}),
        targetSessionKey,
        targetSessionId,
        idempotencyKey: sourceTool,
        ...(sourceTool === "subagent_settle"
          ? {
              settleBatch: { sourceSessionKeys: [sourceSessionKey], isCurrent: () => true },
            }
          : {}),
      });
      const trustedInternalHandoff = consumeSubagentCompletionToolHandoff({
        handoffId,
        sourceTool,
        sourceSessionKey,
        ...(sourceTool === "subagent_announce" ? { sourceSessionId: "child-instance" } : {}),
        targetSessionKey,
        targetSessionId,
        idempotencyKey: sourceTool,
        provider: "test-provider",
        model: "test-model",
      });
      expect(trustedInternalHandoff).toBeDefined();
      const admission = prepareAgentRunAdmission({
        cfg: {},
        operationalRunInstance: createOperationalRunInstanceRef("run-output-schema"),
        facts: {
          agentId: "main",
          runId: "run-output-schema",
          ingress: { kind: "system", state: "present", boundary: "completion-fixture" },
        },
      });
      try {
        const admittedRunContext = await admission.admit("embedded", "completion-fixture");
        const cleanup = createDeferredCore();
        const abortRun = vi.fn();
        const prepared = prepareCatalogExecutor([], {
          abortRun,
          attempt: {
            admittedRunContext,
            trustedInternalHandoff,
            provider: "test-provider",
            modelId: "test-model",
            inputProvenance: { kind: "inter_session", sourceTool, sourceSessionKey },
            waitForOwnerCleanup: () => cleanup.promise,
          } as never,
        });
        expect(prepared.queueHandle.preemptByVisibleTurn).toBeTypeOf("function");
        const settled = vi.fn();
        const physical = prepared.queueHandle.waitForVisibleTurnCleanup?.().then(settled);
        expect(physical).toBeDefined();
        expect(prepared.queueHandle.preemptByVisibleTurn?.()).toBe(true);
        expect(prepared.queueHandle.preemptByVisibleTurn?.()).toBe(false);
        expect(abortRun).toHaveBeenCalledOnce();
        expect(isAgentRunSupersededAbortReason(abortRun.mock.calls[0]?.[1])).toBe(true);
        await Promise.resolve();
        expect(settled).not.toHaveBeenCalled();
        cleanup.resolve();
        await physical;
        expect(settled).toHaveBeenCalledOnce();
      } finally {
        admission.close();
      }
    },
  );
});
