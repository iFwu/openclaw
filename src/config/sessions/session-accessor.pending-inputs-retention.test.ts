import { beforeEach, afterEach, describe, it, expect } from "vitest";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import {
  openOpenClawAgentDatabase,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { upsertSessionEntryCore, readSessionSubmittedInput } from "./session-accessor.js";
import {
  bindSessionPendingInputSources,
  retainCancelledSessionPendingInput,
  listSessionPendingInputs,
  stageSessionPendingInput,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { useTempSessionsFixture } from "./test-helpers.js";

describe("native retained source settlement", () => {
  const fixture = useTempSessionsFixture("native-retained-input-");
  const sessionKey = "agent:main:retained-input";
  const sessionId = "retained-input-session";
  const receipts: SessionPendingInputReceipt[] = [];
  const scope = () => ({ agentId: "main", sessionKey, sessionId, storePath: fixture.storePath() });
  const database = () => openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope())));
  const message = (runId: string): PersistedUserTurnMessage => ({
    role: "user",
    content: "Continue the task",
    timestamp: 100,
    idempotencyKey: `${runId}:user`,
  });
  const stage = async (runId: string) => {
    const receipt = await stageSessionPendingInput(scope(), {
      runId,
      message: message(runId),
      assertCurrent: () => {},
    });
    if (!receipt) {
      throw new Error("Missing native receipt");
    }
    receipts.push(receipt);
    return receipt;
  };
  beforeEach(async () => {
    await upsertSessionEntryCore(scope(), { sessionId, updatedAt: 1 });
  });
  afterEach(() => {
    for (const receipt of receipts.splice(0)) {
      receipt.finish("interrupted");
    }
    closeOpenClawAgentDatabasesForTest();
  });
  it("reads a retained source without treating queued custody as confirmed cancellation", async () => {
    const receipt = await stage("retained-reader");
    expect(
      readSessionSubmittedInput(scope(), "retained-reader:user", { retainedOnly: true }),
    ).toBeUndefined();
    receipt.finish("cancelled");
    expect(
      readSessionSubmittedInput(scope(), "retained-reader:user", { retainedOnly: true }),
    ).toMatchObject({ role: "user", content: "Continue the task" });
    expect(() => receipt.run(() => {})).toThrow();
  });

  it("retires every aggregate source when one retained cancellation write fails", async () => {
    const first = await stage("retain-failure-a");
    const second = await stage("retain-failure-b");
    const aggregate = bindSessionPendingInputSources([first, second], message("retain-failure-c"))!;
    receipts.push(aggregate);
    database().db.exec(
      "CREATE TEMP TRIGGER reject_retained_cancel BEFORE UPDATE OF state ON session_pending_inputs WHEN OLD.run_id = 'retain-failure-a' AND NEW.state = 'cancelled' BEGIN SELECT RAISE(ABORT, 'retained cancellation failed'); END",
    );
    try {
      expect(() => retainCancelledSessionPendingInput(aggregate)).toThrow(
        "Failed to retain cancelled input sources",
      );
      expect(listSessionPendingInputs(scope()).items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ runId: "retain-failure-b", state: "cancelled" }),
        ]),
      );
      expect(() => second.run(() => {})).toThrow();
    } finally {
      database().db.exec("DROP TRIGGER reject_retained_cancel");
    }
  });
});
