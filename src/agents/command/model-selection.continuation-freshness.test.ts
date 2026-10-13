import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import {
  consumeSubagentCompletionToolHandoff,
  registerSubagentCompletionToolHandoff,
} from "../../gateway/subagent-completion-tool-handoff.js";
import {
  clearContinuationModelSelection,
  persistContinuationModelSelection,
  type ContinuationModelSelection,
} from "../../sessions/continuation-model-selection.js";
import { isNativeCompletionOwnerForRun } from "../subagents/announce/subagent-announce-handoff.js";
import { readSharedBatchState } from "../subagents/announce/subagent-announce.requester-settle-state.js";
import { settleRequesterTurnAfterSessionSpawns } from "../subagents/registry/subagent-registry-requester-yield.js";
import { createSubagentRegistrationRecord } from "../subagents/registry/subagent-registry-run-launch-record.js";
import {
  bindSubagentRunRecord,
  rowToSubagentRunRecord,
} from "../subagents/registry/subagent-registry.store.codec.js";
import {
  catalogEntry,
  sessionKey,
  setupConfiguredModelSelectionTests,
} from "./model-selection.configured.test-support.js";

vi.mock("../model-catalog.js", { spy: true });

const createFixture = setupConfiguredModelSelectionTests();

function redeemSelection(
  selection: ContinuationModelSelection,
  sourceTool: "subagent_announce" | "subagent_settle" = "subagent_announce",
) {
  const registration = {
    sourceSessionKey: "agent:main:subagent:completion-child",
    sourceSessionId: "completion-child",
    targetSessionKey: sessionKey,
    targetSessionId: selection.sessionId,
    idempotencyKey: `completion-${sourceTool}`,
  };
  const handoffId = expectDefined(
    registerSubagentCompletionToolHandoff({
      ...registration,
      modelSelection: selection,
      isCurrent: () => true,
      ...(sourceTool === "subagent_settle"
        ? {
            settleBatch: {
              sourceSessionKeys: [registration.sourceSessionKey],
              isCurrent: () => true,
            },
          }
        : {}),
    }),
    "native completion registration",
  );
  const handoff = expectDefined(
    consumeSubagentCompletionToolHandoff({
      ...registration,
      handoffId,
      sourceTool,
      provider: "custom",
      model: "base",
    }),
    "native completion redemption",
  );
  const inputProvenance = {
    kind: "inter_session" as const,
    sourceTool,
    sourceSessionKey: registration.sourceSessionKey,
  };
  expect(
    isNativeCompletionOwnerForRun({
      handoff,
      inputProvenance,
      sessionKey,
      sessionId: selection.sessionId,
      provider: "custom",
      model: "base",
    }),
  ).toBe(true);
  return { message: "Resume completion", trustedInternalHandoff: handoff, inputProvenance };
}

describe("command continuation selection freshness", () => {
  it.each(["subagent_announce", "subagent_settle"] as const)(
    "rejects codec-reloaded A after ordinary B finishes through native %s redemption",
    async (sourceTool) => {
      const fixture = createFixture();
      fixture.defaults.modelPolicy = { allow: ["custom/*"] };
      fixture.inventory.mockReturnValue([
        catalogEntry("custom", "base"),
        catalogEntry("custom", "child"),
        catalogEntry("custom", "manual"),
      ]);
      await replaceSessionEntry(fixture.target, {
        sessionId: "configured-child",
        lifecycleRevision: "generation",
        activeWriterRunId: "turn-A",
        updatedAt: 1,
      });
      const savedA = expectDefined(
        await persistContinuationModelSelection({
          ...fixture.target,
          expectedWriterRunId: "turn-A",
          selection: {
            runId: "turn-A",
            sessionId: "configured-child",
            lifecycleRevision: "generation",
            provider: "custom",
            model: "manual",
          },
          assertCurrent: () => {},
        }),
        "captured turn A",
      );
      const original = expectDefined(savedA.continuationModelSelection, "turn A primary");
      fixture.store[sessionKey] = savedA;
      expect(await fixture.select({ opts: redeemSelection(original, sourceTool) })).toMatchObject({
        provider: "custom",
        model: "manual",
        continuationSelection: original,
      });
      const child = createSubagentRegistrationRecord(
        {
          runId: "child-A",
          requesterTurnRunId: "turn-A",
          requesterModelSelection: original,
          childSessionKey: "agent:main:subagent:completion-child",
          requesterSessionKey: sessionKey,
          requesterDisplayKey: "configured-selection",
          completionRequesterSessionId: original.sessionId,
          completionRequesterLifecycleRevision: original.lifecycleRevision,
          task: "finish A child",
          cleanup: "keep",
          expectsCompletionMessage: true,
        },
        { now: 1, generation: 1, lifecycleGeneration: "child-generation" },
      );
      if (sourceTool === "subagent_settle") {
        child.requesterTurnYielded = true;
        expect(
          settleRequesterTurnAfterSessionSpawns({
            requesterSessionKey: sessionKey,
            requesterTurnRunId: "turn-A",
            requesterYielded: true,
            acceptedSessionSpawns: [
              {
                runId: child.runId,
                childSessionKey: child.childSessionKey,
                expectsCompletionMessage: true,
              },
            ],
            runs: new Map([[child.runId, child]]),
            persistOrThrow: () => {},
            schedule: () => {},
          }),
        ).toBe(true);
      }
      const bound = bindSubagentRunRecord(child);
      await patchSessionEntryCore(fixture.target, () => ({ activeWriterRunId: "turn-B" }));
      const savedB = expectDefined(
        await persistContinuationModelSelection({
          ...fixture.target,
          expectedWriterRunId: "turn-B",
          selection: { ...original, runId: "turn-B", provider: "custom", model: "base" },
          assertCurrent: () => {},
        }),
        "captured ordinary turn B",
      );
      await clearContinuationModelSelection({
        ...fixture.target,
        runId: "turn-B",
        sessionId: savedB.sessionId,
        assertCurrent: () => {},
      });
      fixture.store[sessionKey] = expectDefined(
        loadSessionEntry(fixture.target),
        "completed B row",
      );
      expect(fixture.entry()).toMatchObject({
        sessionId: original.sessionId,
        lifecycleRevision: original.lifecycleRevision,
      });
      expect(fixture.entry().continuationModelSelection).toBeUndefined();
      expect(fixture.entry().continuationTurnRevision).not.toBe(original.turnRevision);
      expect(fixture.entry().modelSelectionRevision).toBe(original.modelSelectionRevision);
      const restored = expectDefined(
        rowToSubagentRunRecord({
          run_id: child.runId,
          child_session_key: child.childSessionKey,
          requester_session_key: child.requesterSessionKey,
          controller_session_key: child.controllerSessionKey ?? null,
          requester_store_path: null,
          controller_store_path: null,
          created_at: child.createdAt,
          payload_json: String(bound.payload_json),
        }),
        "reloaded A child",
      );
      const carrier = expectDefined(
        sourceTool === "subagent_settle"
          ? readSharedBatchState([restored]).requesterModelSelection
          : restored.requesterModelSelection,
        "reloaded A primary",
      );
      expect(carrier).toEqual(original);
      expect(await fixture.select({ opts: redeemSelection(carrier, sourceTool) })).toMatchObject({
        provider: "custom",
        model: "base",
        continuationSelection: undefined,
      });
      await patchSessionEntryCore(fixture.target, () => ({
        providerOverride: "custom",
        modelOverride: "child",
        modelOverrideSource: "user",
      }));
      fixture.store[sessionKey] = expectDefined(
        loadSessionEntry(fixture.target),
        "current override",
      );
      expect(await fixture.select({ opts: redeemSelection(carrier, sourceTool) })).toMatchObject({
        provider: "custom",
        model: "child",
        continuationSelection: undefined,
      });
    },
  );

  it.each(["missing", "wrong-key", "recreated"] as const)(
    "rejects a %s parent through command lookup when both parent model revisions are undefined",
    async (kind) => {
      const fixture = createFixture();
      fixture.defaults.modelPolicy = { allow: ["custom/*"] };
      fixture.inventory.mockReturnValue([
        catalogEntry("custom", "base"),
        catalogEntry("custom", "manual"),
      ]);
      const parentKey = "agent:main:selection-parent";
      const parent: SessionEntry = {
        sessionId: "parent-session",
        lifecycleRevision: "parent-generation",
        updatedAt: 1,
      };
      const selection: ContinuationModelSelection = {
        runId: "turn-A",
        sessionId: "configured-child",
        lifecycleRevision: "generation",
        parentSessionKey: parentKey,
        parentSessionId: parent.sessionId,
        parentLifecycleRevision: parent.lifecycleRevision,
        provider: "custom",
        model: "manual",
      };
      await replaceSessionEntry(fixture.target, {
        sessionId: selection.sessionId,
        lifecycleRevision: selection.lifecycleRevision,
        updatedAt: 1,
      });
      fixture.store[sessionKey] = expectDefined(loadSessionEntry(fixture.target), "child row");
      if (kind !== "missing") {
        await replaceSessionEntry({ ...fixture.target, sessionKey: parentKey }, parent);
        expect(await fixture.select({ opts: redeemSelection(selection) })).toMatchObject({
          provider: "custom",
          model: "manual",
          continuationSelection: selection,
        });
        if (kind === "wrong-key") {
          selection.parentSessionKey = "agent:main:wrong-parent";
          await replaceSessionEntry(
            { ...fixture.target, sessionKey: selection.parentSessionKey },
            { ...parent, sessionId: "unrelated-parent" },
          );
        } else {
          await replaceSessionEntry(
            { ...fixture.target, sessionKey: parentKey },
            { ...parent, lifecycleRevision: "recreated-parent-generation" },
          );
        }
      }
      const lookupKey = expectDefined(selection.parentSessionKey, "retained parent key");
      const currentParent = loadSessionEntry({ ...fixture.target, sessionKey: lookupKey });
      if (kind === "missing") {
        expect(currentParent).toBeUndefined();
      } else {
        expect(
          expectDefined(currentParent, "current parent row").modelSelectionRevision,
        ).toBeUndefined();
      }
      expect(selection.parentModelSelectionRevision).toBeUndefined();
      expect(fixture.store[lookupKey]).toBeUndefined();
      expect(await fixture.select({ opts: redeemSelection(selection) })).toMatchObject({
        provider: "custom",
        model: "base",
        continuationSelection: undefined,
      });
    },
  );
});
