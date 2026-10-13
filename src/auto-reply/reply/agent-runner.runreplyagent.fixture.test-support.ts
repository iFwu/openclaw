import { join } from "node:path";
import { afterEach } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import {
  withSessionPlacementTurnAdmission,
  type SessionPlacementTurnParams,
} from "../../agents/session-placement-admission.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  buildHandledBeforeAgentReplyPayloads,
  runBeforeAgentReplyForTurn,
} from "../../plugins/before-agent-reply.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { waitForReplyRunSuccessorAdmission } from "./reply-run-registry.js";

export function createReplyAgentSessionFixture() {
  const sessionKeys = new Set<string>();
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      // Reply completion starts asynchronous recovery-owner release. Join it before
      // deleting stores so late cleanup cannot recreate a previous case's database.
      await Promise.all(
        [...sessionKeys].map((sessionKey) => waitForReplyRunSuccessorAdmission(sessionKey, null)),
      );
      for (const dir of tempDirs.dirs) {
        await closeOpenClawAgentDatabasesAsync(dir);
      }
      sessionKeys.clear();
      cleanup();
    }),
  );
  return {
    sessionKeys,
    tempDirs,
    async createSessionStoreFile(
      this: void,
      entry: SessionEntry,
      sessionKey = "main",
    ): Promise<string> {
      sessionKeys.add(sessionKey);
      const dir = tempDirs.make("openclaw-agent-runner-");
      const storePath = join(dir, "sessions.json");
      await replaceSessionEntry({ storePath, sessionKey }, entry);
      return storePath;
    },
  };
}

/** Keep native input admission real while replacing only the embedded execution. */
export function runReplyFixtureEmbeddedAgent(
  params: SessionPlacementTurnParams,
  task: () => Promise<EmbeddedAgentRunResult>,
): Promise<EmbeddedAgentRunResult> {
  return withSessionPlacementTurnAdmission(
    {
      runId: params.runId,
      sessionId: params.sessionId,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
    },
    params,
    task,
  );
}

export async function runHookBackedEmbeddedAgent(params: {
  agentId?: string;
  prompt: string;
  runId: string;
  sessionId: string;
  sessionKey?: string;
  trigger?: string;
  workspaceDir: string;
}) {
  const hookResult = await runBeforeAgentReplyForTurn({
    runId: params.runId,
    trigger: params.trigger,
    event: { cleanedBody: params.prompt },
    context: {
      runId: params.runId,
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      trigger: params.trigger,
      workspaceDir: params.workspaceDir,
    },
  });
  return hookResult?.handled
    ? {
        payloads: buildHandledBeforeAgentReplyPayloads(hookResult.reply),
        meta: { agentMeta: {} },
      }
    : {
        payloads: [{ text: "model reply" }],
        meta: { agentMeta: {} },
      };
}
