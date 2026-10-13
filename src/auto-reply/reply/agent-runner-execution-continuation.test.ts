import { describe, expect, it } from "vitest";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import {
  createFollowupRun,
  createRunAgentTurnParams,
  getExecuteAgentTurnForTest,
  makeTestSessionStorePath,
  setupAgentRunnerExecutionTestState,
} from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();

describe("reply continuation selection lifecycle", () => {
  it.each([false, true])(
    "captures selected primary after admission and preserves only restart interruption (restart=%s)",
    async (restart) => {
      const storePath = makeTestSessionStorePath();
      const sessionKey = "agent:main:reply-continuation";
      const entry: InternalSessionEntry = {
        sessionId: "reply-session",
        updatedAt: 1,
        lifecycleRevision: "reply-generation",
      };
      const target = { agentId: "main", sessionKey, storePath };
      await replaceSessionEntry(target, entry);
      const followup = createFollowupRun();
      followup.run.sessionId = entry.sessionId;
      followup.run.sessionKey = sessionKey;
      followup.run.agentId = "main";
      followup.run.provider = "anthropic";
      followup.run.model = "claude";
      followup.run.thinkLevel = "low";
      followup.run.fastMode = true;
      const params = createRunAgentTurnParams(followup);
      params.sessionKey = sessionKey;
      params.storePath = storePath;
      params.activeSessionStore = { [sessionKey]: entry };
      params.getActiveSessionEntry = () => params.activeSessionStore?.[sessionKey];
      params.opts = { runId: "reply-owner" };
      let captured: InternalSessionEntry | undefined;
      let admissionError: unknown;
      state.runEmbeddedAgentEntryMock.mockImplementation(async (run, delegate) => {
        expect(
          (loadSessionEntry(target) as InternalSessionEntry).continuationModelSelection,
        ).toBeUndefined();
        await patchSessionEntryCore(target, () => ({ activeWriterRunId: "reply-owner" }));
        try {
          await run.preparedRunAdmission.admit("embedded");
        } catch (error) {
          admissionError = error;
          throw error;
        }
        captured = loadSessionEntry(target) as InternalSessionEntry;
        return delegate(run);
      });
      state.runEmbeddedAgentMock.mockImplementation(async () => {
        if (restart) {
          throw createAgentRunRestartAbortError();
        }
        return {
          payloads: [{ text: "done" }],
          meta: {
            agentMeta: { sessionId: entry.sessionId, provider: "backup", model: "fallback" },
          },
        };
      });
      const execute = await getExecuteAgentTurnForTest();
      const result = await execute(params);
      expect(state.runEmbeddedAgentEntryMock, JSON.stringify(result)).toHaveBeenCalled();
      expect(admissionError).toBeUndefined();
      expect(captured?.continuationModelSelection).toMatchObject({
        provider: "anthropic",
        model: "claude",
        thinking: "low",
        fastMode: true,
        ownerRunId: "reply-owner",
      });
      const retained = (loadSessionEntry(target) as InternalSessionEntry)
        .continuationModelSelection;
      if (restart) {
        expect(retained).toEqual(captured?.continuationModelSelection);
      } else {
        expect(retained).toBeUndefined();
      }
    },
  );
});
