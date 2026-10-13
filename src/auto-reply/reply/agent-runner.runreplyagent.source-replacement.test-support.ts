import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import type { SessionEntry } from "../../config/sessions.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type { TemplateContext } from "../templating.js";
import { createReplyAgentRestartRecoveryController } from "./agent-runner-execute.js";
import type { FollowupRun } from "./queue.js";
import {
  clearReplyRunForResetBySessionId,
  createReplyOperation,
  replyRunRegistry,
  type ReplyOperation,
} from "./reply-run-registry.js";

type SourceReplacementFixture = {
  createMinimalRun: (params: { sessionCtx: Partial<TemplateContext> }) => {
    followupRun: FollowupRun;
  };
  makeSessionEntry: (overrides?: Partial<SessionEntry>) => SessionEntry;
  makeSessionFixture: () => Promise<{
    sessionEntry: SessionEntry;
    sessionStore: Record<string, SessionEntry>;
    storePath: string;
  }>;
  attachSourceTurnRecorder: (params: {
    followupRun: FollowupRun;
    sessionEntry: SessionEntry;
    sessionStore: Record<string, SessionEntry>;
    sourceTurnId: string | undefined;
    storePath: string;
    text: string;
  }) => void;
  requireStoredSessionEntry: (storePath: string) => SessionEntry;
};

export function registerSourceReplacementSteeringCase({
  createMinimalRun,
  makeSessionEntry,
  makeSessionFixture,
  attachSourceTurnRecorder,
  requireStoredSessionEntry,
}: SourceReplacementFixture): void {
  it("keeps the replacement source when retired admission completes", async ({ signal }) => {
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture();
    const sourceContext = {
      Provider: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "channel:24680",
      MessageSid: "first-source-message",
    };
    const { followupRun } = createMinimalRun({ sessionCtx: sourceContext });
    const first = createReplyOperation({
      sessionKey: "main",
      sessionId: "session",
      resetTriggered: false,
    });
    first.setPhase("running");
    const createController = (
      operation: ReplyOperation,
      initialEntry: SessionEntry,
      sourceTurnId: string,
    ) => {
      let entry = initialEntry;
      return createReplyAgentRestartRecoveryController({
        activeSessionStore: sessionStore,
        cfg: {},
        followupRun: {
          ...followupRun,
          run: { ...followupRun.run, sessionId: operation.sessionId },
        },
        getActiveSessionEntry: () => entry,
        opts: undefined,
        replyOperation: operation,
        restartRecoverySourceTurnId: sourceTurnId,
        runtimePolicySessionKey: undefined,
        sessionCtx: sourceContext,
        sessionKey: "main",
        setActiveSessionEntry: (nextEntry) => {
          entry = nextEntry;
        },
        storePath,
      });
    };
    const firstController = createController(first, sessionEntry, "source-first");
    attachSourceTurnRecorder({
      followupRun,
      sessionEntry,
      sessionStore,
      sourceTurnId: "source-first",
      storePath,
      text: "first source input",
    });
    const recorder = followupRun.userTurnTranscriptRecorder;
    if (!recorder) {
      throw new Error("expected the source recorder");
    }
    const committed = createDeferred();
    const returnAdmission = createDeferred();
    const persistApproved = recorder.persistApproved.bind(recorder);
    const persistence = vi
      .spyOn(recorder, "persistApproved")
      .mockImplementation(async (...args) => {
        const result = await persistApproved(...args);
        committed.resolve();
        await returnAdmission.promise;
        return result;
      });
    const firstAdmission = firstController.admitUserTurn(recorder);
    // A retired admission may reject; its successor must keep the same source either way.
    const firstSettled = firstAdmission.then(
      () => undefined,
      (error: unknown) => committed.reject(error),
    );
    let replacement: ReplyOperation | undefined;
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          committed.promise,
          firstAdmission,
          "first source admission did not persist",
        ),
        signal,
      );
      expect(requireStoredSessionEntry(storePath).restartRecoveryDeliverySourceRunId).toBe(
        "source-first",
      );
      clearReplyRunForResetBySessionId("session");
      const replacementEntry = makeSessionEntry({ sessionId: "replacement-session" });
      await replaceSessionEntry({ storePath, sessionKey: "main" }, replacementEntry);
      sessionStore.main = replacementEntry;
      replacement = createReplyOperation({
        sessionKey: "main",
        sessionId: "replacement-session",
        resetTriggered: true,
      });
      replacement.setPhase("running");
      replacement.attachBackend({
        kind: "embedded",
        runId: "replacement-backend",
        cancel: vi.fn(),
        messageInjection: {
          isAvailable: () => true,
          queueMessage: async () => {},
        },
      });
      const replacementRecorder = createUserTurnTranscriptRecorder({
        input: { text: "replacement source input", idempotencyKey: "source-replacement" },
        target: {
          agentId: "main",
          config: {},
          cwd: "/tmp",
          sessionEntry: replacementEntry,
          sessionId: "replacement-session",
          sessionKey: "main",
          sessionStore,
          storePath,
        },
      });
      await createController(replacement, replacementEntry, "source-replacement").admitUserTurn(
        replacementRecorder,
      );
      expect(replyRunRegistry.resolveCurrentMessageInjectionTarget("main")).toMatchObject({
        sourceTurnId: "source-replacement",
      });

      returnAdmission.resolve();
      await firstSettled;

      expect(replyRunRegistry.get("main")).toBe(replacement);
      expect(replyRunRegistry.resolveCurrentMessageInjectionTarget("main")).toMatchObject({
        sourceTurnId: "source-replacement",
      });
    } finally {
      returnAdmission.resolve();
      await firstSettled;
      persistence.mockRestore();
      first.complete();
      replacement?.complete();
    }
  });
}
