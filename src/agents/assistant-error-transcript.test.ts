import path from "node:path";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createAssistantErrorTranscript } from "./assistant-error-transcript.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawAgentDatabasesForTest());

async function setupTranscript() {
  const root = tempDirs.make("openclaw-terminal-error-");
  const target = {
    agentId: "main",
    sessionId: "session-test",
    sessionKey: "agent:main:session-test",
    storePath: path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"),
  };
  await upsertSessionEntry({ ...target, entry: { sessionId: target.sessionId, updatedAt: 1 } });
  const failure = makeAgentAssistantMessage({
    content: [],
    stopReason: "error",
    errorMessage: "provider rate limit",
    timestamp: 1,
  });
  const settle = async (message: typeof failure, runId = "run-test") => {
    const owner = createAssistantErrorTranscript({ runId });
    owner.record(message, target);
    await owner.settle(true);
  };
  const messages = () => SessionManager.open(target).buildSessionContext().messages;
  return { failure, settle, messages };
}

describe("terminal assistant error persistence", () => {
  it.each([
    {
      name: "timestamp",
      replay: (message: ReturnType<typeof makeAgentAssistantMessage>) => ({
        ...message,
        timestamp: 99,
      }),
    },
    {
      name: "top-level field order",
      replay: (message: ReturnType<typeof makeAgentAssistantMessage>) => {
        const { usage, ...rest } = message;
        return { usage, ...rest };
      },
    },
    {
      name: "nested field order",
      replay: (message: ReturnType<typeof makeAgentAssistantMessage>) => {
        const { cost, ...counts } = message.usage;
        const { total, ...amounts } = cost;
        return { ...message, usage: { cost: { total, ...amounts }, ...counts } };
      },
    },
    {
      name: "an absent optional field",
      replay: (message: ReturnType<typeof makeAgentAssistantMessage>) => ({
        ...message,
        errorType: undefined,
      }),
    },
  ])("deduplicates the same persisted error after changing $name", async ({ replay }) => {
    const { failure, settle, messages } = await setupTranscript();
    await settle(failure);
    await settle(replay(failure));
    expect(messages()).toHaveLength(1);
    expect(messages()[0]).toMatchObject({
      stopReason: "error",
      errorMessage: failure.errorMessage,
    });
  });

  it.each([
    {
      name: "a different error in the same run",
      errorMessage: "provider unavailable",
      runId: "run-test",
    },
    {
      name: "the same error in a different run",
      errorMessage: "provider rate limit",
      runId: "run-other",
    },
  ])("persists $name without a transcript conflict", async ({ errorMessage, runId }) => {
    const { failure, settle, messages } = await setupTranscript();
    await settle(failure);
    await settle({ ...failure, errorMessage }, runId);
    expect(messages()).toHaveLength(2);
    expect(messages()[1]).toMatchObject({ errorMessage, __openclaw: { runId } });
  });
});
