import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import {
  projectPublicSessionEntry,
  SESSION_ENTRY_PRIVATE_CLEAR_PATCH,
} from "../config/sessions/session-entry-projection.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import {
  clearContinuationModelSelection,
  persistContinuationModelSelection,
  resolveContinuationModelSelection,
  withContinuationModelSelectionAdmission,
  type ContinuationModelSelection,
} from "./continuation-model-selection.js";
import { applyModelOverrideToSessionEntry } from "./model-overrides.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const assertCurrent = () => {};
const selection: ContinuationModelSelection = {
  runId: "original-turn",
  ownerRunId: "original-turn",
  sourceTurnId: "source-message",
  sessionId: "session",
  lifecycleRevision: "generation",
  provider: "selected",
  model: "primary",
  thinking: "high",
  fastMode: false,
  fallbacks: ["backup/model"],
};
async function fixture() {
  const target = {
    agentId: "main",
    sessionKey: "agent:main:continuation-test",
    storePath: path.join(dirs.make("continuation-model-"), "sessions.json"),
  };
  await replaceSessionEntry(target, {
    sessionId: "session",
    lifecycleRevision: "generation",
    updatedAt: 1,
    activeWriterRunId: "original-turn",
  });
  const read = () => loadSessionEntry(target) as InternalSessionEntry;
  const save = (value: ContinuationModelSelection = selection, continuation = false) =>
    persistContinuationModelSelection({
      ...target,
      selection: value,
      expectedWriterRunId: value.ownerRunId ?? value.runId,
      continuation,
      assertCurrent,
    });
  return { target, read, save };
}

describe("continuation model selection", () => {
  it("persists the selected primary privately and retains original correlation across successors", async () => {
    const f = await fixture();
    await f.save();
    const original = f.read().continuationModelSelection!;
    expect(original).toMatchObject(selection);
    expect(original.turnRevision).toBeTypeOf("string");
    expect(
      resolveContinuationModelSelection({
        selection: original,
        entry: f.read(),
        sourceRunId: "source-message",
      }),
    ).toEqual(original);
    await patchSessionEntryCore(f.target, () => ({
      activeWriterRunId: "successor",
      modelProvider: "backup",
      model: "model",
    }));
    await f.save({ ...original, ownerRunId: "successor" }, true);
    const successor = f.read().continuationModelSelection!;
    expect(successor).toMatchObject({
      provider: "selected",
      model: "primary",
      runId: "original-turn",
      ownerRunId: "successor",
      turnRevision: original.turnRevision,
    });
    expect(
      resolveContinuationModelSelection({
        selection: successor,
        entry: f.read(),
        sourceRunId: "successor",
      }),
    ).toEqual(successor);
    expect(
      resolveContinuationModelSelection({
        selection: successor,
        entry: f.read(),
        sourceRunId: "unrelated",
      }),
    ).toBeUndefined();
    expect(projectPublicSessionEntry(f.read())).not.toHaveProperty("continuationModelSelection");
    expect(projectPublicSessionEntry(f.read())).not.toHaveProperty("continuationTurnRevision");
    expect(SESSION_ENTRY_PRIVATE_CLEAR_PATCH).toHaveProperty(
      "continuationModelSelection",
      undefined,
    );
    expect(SESSION_ENTRY_PRIVATE_CLEAR_PATCH).toHaveProperty("continuationTurnRevision", undefined);
  });

  it("invalidates retained child carriers on a new ordinary turn and fences late teardown", async () => {
    const f = await fixture();
    await f.save();
    const carrier = f.read().continuationModelSelection!;
    await patchSessionEntryCore(f.target, () => ({ activeWriterRunId: "new-turn" }));
    await f.save({
      ...carrier,
      runId: "new-turn",
      ownerRunId: "new-turn",
      provider: "default",
      model: "new",
    });
    expect(
      resolveContinuationModelSelection({ selection: carrier, entry: f.read() }),
    ).toBeUndefined();
    await clearContinuationModelSelection({
      ...f.target,
      runId: "original-turn",
      sessionId: "session",
      assertCurrent,
    });
    expect(f.read().continuationModelSelection?.model).toBe("new");
    await clearContinuationModelSelection({
      ...f.target,
      runId: "new-turn",
      sessionId: "session",
      assertCurrent,
    });
    expect(f.read().continuationModelSelection).toBeUndefined();
    expect(f.read().continuationTurnRevision).not.toBe(carrier.turnRevision);
    expect(
      resolveContinuationModelSelection({ selection: carrier, entry: f.read() }),
    ).toBeUndefined();
  });

  it.each([false, true])(
    "explicit selection invalidates detached carriers after terminal cleanup (Default=%s)",
    async (isDefault) => {
      const f = await fixture();
      await f.save();
      const carrier = f.read().continuationModelSelection!;
      await clearContinuationModelSelection({
        ...f.target,
        runId: "original-turn",
        sessionId: "session",
        assertCurrent,
      });
      await patchSessionEntryCore(f.target, (entry) => {
        applyModelOverrideToSessionEntry({
          entry,
          selection: { provider: "new", model: "selected", isDefault },
          explicitDefaultSelection: isDefault,
        });
        return entry;
      });
      expect(
        resolveContinuationModelSelection({ selection: carrier, entry: f.read() }),
      ).toBeUndefined();
    },
  );

  it.each(["writer", "generation", "selection"])(
    "rejects stale %s before committing a snapshot",
    async (kind) => {
      const f = await fixture();
      await patchSessionEntryCore(f.target, () =>
        kind === "writer"
          ? { activeWriterRunId: "new" }
          : kind === "generation"
            ? { lifecycleRevision: "new" }
            : { modelSelectionRevision: "new" },
      );
      await expect(f.save()).rejects.toThrow("no longer owns");
      expect(f.read().continuationModelSelection).toBeUndefined();
    },
  );

  it("captures an admitted CLI turn with no native transcript writer without claiming that writer", async () => {
    const f = await fixture();
    await patchSessionEntryCore(f.target, () => ({ activeWriterRunId: undefined }));
    await f.save();
    expect(f.read().continuationModelSelection).toMatchObject(selection);
    expect(f.read().activeWriterRunId).toBeUndefined();
  });

  it("requires parent identity and model revision, not unrelated activity timestamps", () => {
    const parent: InternalSessionEntry = {
      sessionId: "parent",
      lifecycleRevision: "parent-gen",
      modelSelectionRevision: "parent-selection",
      updatedAt: 1,
    };
    const child: InternalSessionEntry = {
      sessionId: "session",
      lifecycleRevision: "generation",
      updatedAt: 1,
    };
    const value = {
      ...selection,
      parentSessionKey: "agent:main:parent",
      parentSessionId: "parent",
      parentLifecycleRevision: "parent-gen",
      parentModelSelectionRevision: "parent-selection",
    };
    expect(
      resolveContinuationModelSelection({
        selection: value,
        entry: child,
        parentEntry: { ...parent, updatedAt: 999 },
      }),
    ).toEqual(value);
    for (const replacement of [
      undefined,
      { ...parent, sessionId: "new" },
      { ...parent, lifecycleRevision: "new" },
      { ...parent, modelSelectionRevision: "new" },
    ]) {
      expect(
        resolveContinuationModelSelection({
          selection: value,
          entry: child,
          parentEntry: replacement,
        }),
      ).toBeUndefined();
    }
  });

  it("captures exactly once after real runtime admission, never on queue preparation", async () => {
    const admission = prepareAgentRunAdmission({
      cfg: {},
      operationalRunInstance: createOperationalRunInstanceRef("admitted"),
      facts: {
        runId: "admitted",
        agentId: "main",
        ingress: { kind: "system", boundary: "test", state: "present" },
      },
    });
    const capture = vi.fn(async () => {});
    const wrapped = withContinuationModelSelectionAdmission(admission, capture);
    expect(capture).not.toHaveBeenCalled();
    const context = await wrapped.admit("embedded");
    expect(await wrapped.admit("plugin-harness")).toBe(context);
    expect(capture).toHaveBeenCalledOnce();
    wrapped.close();
    await expect(wrapped.admit("embedded")).rejects.toThrow();
  });
});
