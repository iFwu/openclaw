import { isDeepStrictEqual } from "node:util";
import type { Message } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  stageChannelInputSource,
  retainCancelledChannelInputSource,
  type UserTurnTranscriptRecorder,
} from "openclaw/plugin-sdk/reply-runtime";
import { getSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import type { TelegramSessionState } from "./bot-handlers.message-context.js";
import {
  getTelegramTextParts,
  resolveTelegramPrimaryMedia,
  buildSenderName,
} from "./bot/helpers.js";
import { normalizeMessageNode } from "./message-cache-codec.js";

/** Original ingress facts survive synthetic text/album assembly without becoming model authority. */
export type TelegramInputSource = {
  retain: () => Promise<void>;
  resolveDisposition: () => Promise<"execution" | "retained">;
  recorder?: UserTurnTranscriptRecorder;
};

const sources = new WeakMap<Message, TelegramInputSource>();

export async function prepareTelegramInputSource(params: {
  msg: Message;
  cfg: OpenClawConfig;
  accountId: string;
  state: TelegramSessionState;
  resolveState: () => Promise<TelegramSessionState>;
  assertOwnerCurrent: () => void;
  onRetained: () => Promise<void>;
}): Promise<UserTurnTranscriptRecorder | undefined> {
  const capturedState = structuredClone(params.state);
  const raw = structuredClone(params.msg);
  let retained = false;
  let retention: Promise<void> | undefined;
  const originalSessionId = capturedState.sessionEntry?.sessionId;
  const assertSessionCurrent = () => {
    const entry = getSessionEntry({
      storePath: capturedState.storePath,
      sessionKey: capturedState.sessionKey,
    });
    if (!originalSessionId || entry?.sessionId !== originalSessionId) {
      throw new Error("Telegram original input session changed before retention");
    }
  };
  const assertTargetCurrent = () => {
    params.assertOwnerCurrent();
    assertSessionCurrent();
  };
  const isStopped = (entry: TelegramSessionState["sessionEntry"]) => {
    const cutoff = entry?.abortCutoffMessageSid;
    return cutoff && /^\d+$/.test(cutoff)
      ? BigInt(raw.message_id) <= BigInt(cutoff)
      : entry?.abortCutoffTimestamp != null && raw.date * 1000 <= entry.abortCutoffTimestamp;
  };
  const assertExecutionCurrent = () => {
    assertTargetCurrent();
    if (
      isStopped(
        getSessionEntry({
          storePath: capturedState.storePath,
          sessionKey: capturedState.sessionKey,
        }),
      )
    ) {
      throw new Error("Telegram original input cutoff changed before execution");
    }
  };
  const readTarget = async () => {
    const current = await params.resolveState();
    if (
      current.agentId !== capturedState.agentId ||
      current.sessionKey !== capturedState.sessionKey ||
      current.storePath !== capturedState.storePath ||
      !isDeepStrictEqual(current.bindingMode, capturedState.bindingMode) ||
      current.sessionEntry?.sessionId !== originalSessionId
    ) {
      throw new Error("Telegram original input route changed before retention");
    }
    assertTargetCurrent();
    return current;
  };
  if (!originalSessionId) {
    throw new Error("Telegram input source has no captured session");
  }
  const nativeMedia = resolveTelegramPrimaryMedia(raw);
  const input = {
    text: getTelegramTextParts(raw).text || normalizeMessageNode(raw, {}).body || "",
    idempotencyKey: `telegram-retained:${params.accountId}:${raw.chat.id}:${raw.message_thread_id ?? "main"}:${raw.message_id}`,
    timestamp: raw.date * 1000,
    media: nativeMedia?.fileRef.file_id
      ? [
          {
            url: `telegram:file/${nativeMedia.fileRef.file_id}`,
            kind: nativeMedia.kind,
            messageId: String(raw.message_id),
            hydrationSuppressed: true,
          },
        ]
      : [],
    sender: {
      id: raw.from?.id == null ? undefined : String(raw.from.id),
      name: buildSenderName(raw),
      username: raw.from?.username,
    },
    transport: {
      channel: "telegram",
      conversationRef: `${raw.chat.id}`,
      messageId: String(raw.message_id),
      threadId: raw.message_thread_id == null ? undefined : String(raw.message_thread_id),
    },
  };
  // Hydration belongs to collected execution, not the immutable original receipt.
  const recorder = await stageChannelInputSource({
    input,
    target: {
      agentId: capturedState.agentId,
      sessionKey: capturedState.sessionKey,
      sessionId: originalSessionId,
      storePath: capturedState.storePath,
      sessionEntry: capturedState.sessionEntry,
      config: params.cfg,
    },
    assertCurrent: assertTargetCurrent,
    assertAdmittedCurrent: assertExecutionCurrent,
    assertRetainedCurrent: assertSessionCurrent,
  });
  const retain = async () => {
    if (retained) {
      return;
    }
    if (retention) {
      return await retention;
    }
    retention = (async () => {
      await readTarget();
      if (recorder && !(await retainCancelledChannelInputSource(recorder))) {
        throw new Error("Telegram original input cancellation was not confirmed");
      }
      await readTarget();
      await params.onRetained();
      retained = true;
    })();
    try {
      await retention;
    } finally {
      if (!retained) {
        retention = undefined;
      }
    }
  };
  sources.set(params.msg, {
    retain,
    recorder,
    resolveDisposition: async () => {
      if (retained) {
        return "retained";
      }
      if (!originalSessionId) {
        return "execution";
      }
      const current = await readTarget();
      const stopped = isStopped(current.sessionEntry);
      if (!stopped && recorder) {
        return "execution";
      }
      await retain();
      return "retained";
    },
  });
  return recorder;
}

export function readTelegramInputSource(message: Message): TelegramInputSource | undefined {
  return sources.get(message);
}
