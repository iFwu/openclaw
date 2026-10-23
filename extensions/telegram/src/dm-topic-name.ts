import { GrammyError, type Bot } from "grammy";
import { runAuthorizedTelegramRequest } from "./account-throttler.js";
import { resolveTelegramBotUserIdFromToken } from "./token-fingerprint.js";
import { isTopicManuallyNamed, updateTopicName } from "./topic-name-cache.js";

const pendingEdits = new Map<string, Promise<unknown>>();

function topicScope(bot: Bot): string {
  return `telegram-dm-topics:${resolveTelegramBotUserIdFromToken(bot.token)}`;
}

export function isDmTopicManuallyNamed(bot: Bot, chatId: number, threadId: number) {
  return isTopicManuallyNamed(chatId, threadId, topicScope(bot));
}

export async function setDmTopicName(params: {
  bot: Bot;
  chatId: number;
  threadId: number;
  name: string;
  manual: boolean;
  assertCurrent?: () => void;
}): Promise<boolean> {
  const { bot, chatId, threadId, name, manual, assertCurrent } = params;
  const scope = topicScope(bot);
  const key = `${scope}:${chatId}:${threadId}`;
  const previous = pendingEdits.get(key);
  // Serialize only API writes, not label generation. A manual edit queued behind
  // an already-submitted automatic edit must be the last write to Telegram.
  const edit = (async () => {
    await previous?.catch(() => undefined);
    if (!manual && (await isTopicManuallyNamed(chatId, threadId, scope))) {
      return false;
    }
    try {
      await runAuthorizedTelegramRequest(assertCurrent, () => {
        assertCurrent?.();
        return bot.api.editForumTopic(chatId, threadId, { name });
      });
    } catch (error) {
      if (
        !(
          error instanceof GrammyError &&
          error.error_code === 400 &&
          error.description.includes("TOPIC_NOT_MODIFIED")
        )
      ) {
        throw error;
      }
    }
    await updateTopicName(
      chatId,
      threadId,
      { name, ...(manual ? { manuallyNamed: true } : {}) },
      scope,
    );
    return true;
  })();
  pendingEdits.set(key, edit);
  try {
    return await edit;
  } finally {
    if (pendingEdits.get(key) === edit) {
      pendingEdits.delete(key);
    }
  }
}
