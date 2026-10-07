import { isDeepStrictEqual } from "node:util";
import {
  loadSessionEntry,
  readSessionSubmittedInput,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { redactTranscriptMessageForStorage } from "../../config/sessions/session-accessor.sqlite-transcript-store.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  getAgentEventLifecycleGeneration,
  assertAgentRunLifecycleGenerationCurrent,
} from "../../infra/agent-events.js";
import {
  readDatabasePathIdentitySync,
  assertExistingDatabaseIdentity,
} from "../../infra/sqlite-worker-identity.js";
import { normalizeMediaFacts } from "../../media/media-facts.js";
import { retainCancelledUserTurnInput } from "../../sessions/user-turn-transcript-admission.js";
import {
  createUserTurnTranscriptRecorder,
  buildPersistedUserTurnMessage,
} from "../../sessions/user-turn-transcript.js";
import type {
  UserTurnInput,
  UserTurnTranscriptTarget,
} from "../../sessions/user-turn-transcript.types.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { MsgContext } from "../templating.js";
import {
  readAbortCutoffFromSessionEntry,
  shouldSkipMessageByAbortCutoff,
  resolveAbortCutoffFromContext,
} from "./abort-cutoff.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { buildChannelSourceTurnId, readChannelSourceTurnId } from "./source-turn-id.js";

/** The source captures its physical session store before buffering or asynchronous media work. */
export function prepareCancelledChannelInputTarget(params: {
  target: UserTurnTranscriptTarget;
  assertCurrent: () => void;
}): (input: UserTurnInput & { idempotencyKey: string }) => Promise<void> {
  params.assertCurrent();
  const path = resolveOpenClawAgentSqlitePath(
    toDatabaseOptions(resolveSqliteTranscriptScope(params.target)),
  );
  const identity = readDatabasePathIdentitySync(path);
  const assertCurrent = () => {
    params.assertCurrent();
    assertExistingDatabaseIdentity(identity.canonicalPath, identity.key, identity.birthtime);
  };
  return (input) => retainCancelledChannelInput({ input, target: params.target, assertCurrent });
}

/** Admit the immutable original once; collected execution consumes this factory receipt. */
export async function stageChannelInputSource(params: {
  input: UserTurnInput & { idempotencyKey: string };
  target: UserTurnTranscriptTarget;
  assertCurrent: () => void;
  assertAdmittedCurrent: () => void;
  assertRetainedCurrent: () => void;
}) {
  params.assertCurrent();
  const path = resolveOpenClawAgentSqlitePath(
    toDatabaseOptions(resolveSqliteTranscriptScope(params.target)),
  );
  const identity = readDatabasePathIdentitySync(path);
  const assertPhysicalCurrent = () =>
    assertExistingDatabaseIdentity(identity.canonicalPath, identity.key, identity.birthtime);
  const generation = getAgentEventLifecycleGeneration();
  const assertRetainedCurrent = () => {
    params.assertRetainedCurrent();
    assertPhysicalCurrent();
    assertAgentRunLifecycleGenerationCurrent(generation);
  };
  if (
    readSessionSubmittedInput(params.target, params.input.idempotencyKey, { retainedOnly: true })
  ) {
    await retainCancelledChannelInput({
      input: params.input,
      target: params.target,
      assertCurrent: assertRetainedCurrent,
    });
    return undefined;
  }
  const recorder = createUserTurnTranscriptRecorder({
    input: params.input,
    target: params.target,
    updateMode: "none",
    assertRetainedInputCurrent: assertRetainedCurrent,
    trackInputCompletion: true,
  });
  if (
    !(await recorder.stageApproved?.({
      runId: params.input.idempotencyKey,
      assertCurrent: () => {
        params.assertCurrent();
        assertPhysicalCurrent();
      },
      assertAdmittedCurrent: () => {
        params.assertAdmittedCurrent();
        assertPhysicalCurrent();
        assertAgentRunLifecycleGenerationCurrent(generation);
      },
    }))
  ) {
    throw new Error("Original input stage was not confirmed");
  }
  return recorder;
}

export { retainCancelledUserTurnInput } from "../../sessions/user-turn-transcript-admission.js";

/** Retains approved source bytes without reopening a stopped execution or its provider boundary. */
export async function retainCancelledChannelInput(params: {
  input: UserTurnInput & { idempotencyKey: string };
  target: UserTurnTranscriptTarget;
  assertCurrent: () => void;
}): Promise<void> {
  params.assertCurrent();
  const previous = readSessionSubmittedInput(params.target, params.input.idempotencyKey, {
    retainedOnly: true,
  });
  if (previous) {
    const candidate = redactTranscriptMessageForStorage(
      buildPersistedUserTurnMessage({ ...params.input, timestamp: previous.timestamp }),
      { config: params.target.config as OpenClawConfig | undefined },
    );
    if (!isDeepStrictEqual(previous, candidate)) {
      throw new Error("Retained input identity conflicts with the original source bytes");
    }
  } else {
    const recorder = createUserTurnTranscriptRecorder({
      input: params.input,
      target: params.target,
      updateMode: "none",
    });
    if (
      !(await recorder.stageApproved?.({
        runId: params.input.idempotencyKey,
        assertCurrent: params.assertCurrent,
      })) ||
      !retainCancelledUserTurnInput(recorder)
    ) {
      throw new Error("Stopped input retention was not confirmed");
    }
  }
  params.assertCurrent();
}

/** A cutoff suppresses execution, but durable ingress may settle only after retaining its input. */
export async function retainAbortCutoffInput(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  storePath?: string;
  entry: SessionEntry;
  workspaceDir: string;
  opts?: InternalGetReplyOptions;
}): Promise<void> {
  const { ctx, entry } = params;
  const sourceId =
    readChannelSourceTurnId(ctx) ??
    buildChannelSourceTurnId({
      provider: ctx.OriginatingChannel ?? ctx.Provider ?? ctx.Surface,
      accountId: ctx.AccountId,
      conversationId: ctx.OriginatingTo ?? ctx.To ?? ctx.From,
      messageId: ctx.MessageSidFull ?? ctx.MessageSid,
    });
  if (!sourceId || !entry.sessionId) {
    throw new Error("Stopped input has no captured channel and session identity");
  }
  const scope = {
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: entry.sessionId,
    storePath: params.storePath,
  };
  const assertCurrent = () => {
    params.opts?.abortSignal?.throwIfAborted();
    if (params.opts?.isCommandTargetCurrent?.() === false) {
      throw new Error("Stopped input target changed before retention");
    }
    const current = loadSessionEntry(scope);
    const cutoff = readAbortCutoffFromSessionEntry(current);
    const incoming = resolveAbortCutoffFromContext(ctx);
    if (
      current?.sessionId !== entry.sessionId ||
      !cutoff ||
      !shouldSkipMessageByAbortCutoff({
        cutoffMessageSid: cutoff.messageSid,
        cutoffTimestamp: cutoff.timestamp,
        messageSid: incoming?.messageSid,
        timestamp: incoming?.timestamp,
      })
    ) {
      throw new Error("Stopped input no longer owns its captured cutoff");
    }
  };
  assertCurrent();
  const idempotencyKey = `retained-cutoff:${sourceId}`;
  if (!readSessionSubmittedInput(scope, idempotencyKey, { retainedOnly: true })) {
    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: ctx.rawText ?? ctx.RawBody ?? ctx.CommandBody ?? ctx.Body ?? "",
        idempotencyKey,
        timestamp: ctx.Timestamp,
        media: [...normalizeMediaFacts(ctx.media), ...(params.opts?.media ?? [])],
        sender: { id: ctx.SenderId, name: ctx.SenderName, username: ctx.SenderUsername },
        transport: {
          channel: ctx.OriginatingChannel ?? ctx.Provider ?? ctx.Surface,
          conversationRef: ctx.OriginatingTo ?? ctx.To,
          messageId: ctx.MessageSidFull ?? ctx.MessageSid,
          threadId: ctx.MessageThreadId == null ? undefined : String(ctx.MessageThreadId),
        },
      },
      target: { ...scope, sessionEntry: entry, cwd: params.workspaceDir, config: params.cfg },
      updateMode: "none",
    });
    if (
      !(await recorder.stageApproved?.({ runId: sourceId, assertCurrent })) ||
      !retainCancelledUserTurnInput(recorder)
    ) {
      throw new Error("Stopped input retention was not confirmed");
    }
  }
  assertCurrent();
  await params.opts?.turnAdoptionLifecycle?.onAdopted();
}
