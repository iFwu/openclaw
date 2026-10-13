import { describe, expect, it } from "vitest";
import type { ContinuationModelSelection } from "../../../sessions/continuation-model-selection.js";
import { createSubagentRegistrationRecord } from "./subagent-registry-run-launch-record.js";
import { bindSubagentRunRecord, rowToSubagentRunRecord } from "./subagent-registry.store.codec.js";

const requesterModelSelection: ContinuationModelSelection = {
  runId: "original-requester-turn",
  ownerRunId: "requester-continuation",
  sessionId: "requester-session",
  lifecycleRevision: "requester-lifecycle",
  modelSelectionRevision: "model-selection-revision",
  provider: "selected-provider",
  model: "selected-primary",
  thinking: "high",
  fastMode: true,
  fallbacks: ["fallback-provider/fallback-model"],
};

function register(selection = requesterModelSelection) {
  return createSubagentRegistrationRecord(
    {
      runId: "child-run",
      requesterTurnRunId: "requester-continuation",
      requesterModelSelection: selection,
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      completionRequesterSessionId: "requester-session",
      completionRequesterLifecycleRevision: "requester-lifecycle",
      task: "finish child task",
      model: "child-provider/child-model",
      cleanup: "keep",
      expectsCompletionMessage: true,
    },
    { now: 1_000, generation: 1, lifecycleGeneration: "child-lifecycle" },
  );
}

describe("subagent requester model selection carrier", () => {
  it("copies successor-owned primary selection and round-trips it through the registry codec", () => {
    const source = structuredClone(requesterModelSelection);
    const record = register(source);
    source.model = "later-primary";
    source.fallbacks?.push("later/fallback");
    expect(record.requesterModelSelection).toEqual(requesterModelSelection);
    expect(record.model).toBe("child-provider/child-model");
    const bound = bindSubagentRunRecord(record);
    const restored = rowToSubagentRunRecord({
      run_id: record.runId,
      child_session_key: record.childSessionKey,
      requester_session_key: record.requesterSessionKey,
      controller_session_key: record.controllerSessionKey ?? null,
      requester_store_path: null,
      controller_store_path: null,
      created_at: record.createdAt,
      payload_json: String(bound.payload_json),
    });
    expect(restored?.requesterModelSelection).toEqual(requesterModelSelection);
  });

  it("accepts the original requester turn when no successor owns the selection", () => {
    const { ownerRunId: _ownerRunId, ...selection } = requesterModelSelection;
    expect(
      register({ ...selection, runId: "requester-continuation" }).requesterModelSelection,
    ).toMatchObject({ runId: "requester-continuation", model: "selected-primary" });
  });

  it.each([
    { ownerRunId: "stale-requester-turn" },
    { sessionId: "replaced-requester-session" },
    { lifecycleRevision: "replaced-lifecycle" },
  ])("does not grant a stale requester selection: %j", (overrides) => {
    expect(
      register({ ...requesterModelSelection, ...overrides }).requesterModelSelection,
    ).toBeUndefined();
  });
});
