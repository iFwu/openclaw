import { describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { syncWorkboardSubagentEnded } from "./lifecycle-sync.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

describe("Workboard dispatch model selection", () => {
  it("reselects the agent default on a new dispatch after the board selection is cleared", async () => {
    const store = createWorkboardSqliteTestStore();
    await store.upsertBoard({ id: "reused", defaultModel: "fixture/board-b" });
    const card = await store.create({
      title: "Reusable worker",
      boardId: "reused",
      status: "ready",
      agentId: "main",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "first-run" });
    const options = {
      now: Date.now(),
      maxStarts: 1,
      boardId: "reused",
    };
    await dispatchAndStartWorkboardCards({ store, subagent: { run }, options });
    expect(run.mock.calls[0]?.[0]).toMatchObject({ model: "fixture/board-b", persistModel: true });
    const active = await store.get(card.id);
    await syncWorkboardSubagentEnded({
      store,
      event: {
        targetSessionKey: active!.sessionKey!,
        runId: "first-run",
        outcome: "ok",
        endedAt: active!.updatedAt + 1,
      },
      now: active!.updatedAt + 1,
    });
    const ended = await store.get(card.id);
    expect(ended).toMatchObject({ status: "review", execution: { status: "review" } });
    await store.releaseClaim(card.id, { token: active!.metadata!.claim!.token });
    await store.move(card.id, "ready", undefined);
    await store.upsertBoard({ id: "reused", defaultModel: null });
    run.mockResolvedValueOnce({ runId: "second-run" });
    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { ...options, now: Date.now() + 10 },
    });
    expect(run.mock.calls[1]?.[0]).toMatchObject({
      model: null,
      persistModel: true,
      sessionKey: run.mock.calls[0]?.[0]?.sessionKey,
    });
  });
  it.each([
    {
      dispatchModel: "dispatch-choice",
      label: "model:card-choice",
      board: "board-choice",
      expected: "dispatch-choice",
    },
    {
      dispatchModel: undefined,
      label: "Model: KeepAlias",
      board: "board-choice",
      expected: "KeepAlias",
    },
    { dispatchModel: undefined, label: undefined, board: "board-choice", expected: "board-choice" },
    { dispatchModel: undefined, label: undefined, board: undefined, expected: null },
  ])(
    "resolves dispatch then card then board model without rewriting aliases (%j)",
    async (choice) => {
      const store = createWorkboardSqliteTestStore();
      if (choice.board) {
        await store.upsertBoard({ id: "model-routing", defaultModel: choice.board });
      }
      await store.create({
        title: "Model routing",
        status: "ready",
        agentId: "main",
        boardId: "model-routing",
        labels: choice.label ? [choice.label] : [],
        workspaceAccess: { unrestricted: true },
      });
      const run = vi.fn().mockResolvedValue({ runId: "routed-worker" });
      await dispatchAndStartWorkboardCards({
        store,
        subagent: { run },
        options: { now: 10, maxStarts: 1, boardId: "model-routing", model: choice.dispatchModel },
      });
      expect(run).toHaveBeenCalledOnce();
      const request = run.mock.calls[0]?.[0];
      if (choice.expected) {
        expect(request).toMatchObject({ model: choice.expected, persistModel: true });
      } else {
        expect(request).toMatchObject({ model: null, persistModel: true });
      }
    },
  );
});
