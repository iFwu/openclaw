import { runAuthorizedTelegramRequest } from "./account-throttler.js";
import { createTelegramActionGate } from "./accounts.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import {
  prepareTelegramCommandAuthorization,
  type TelegramCommandExecutorParams,
} from "./bot-native-command-dispatch.js";
import { buildTelegramThreadParams } from "./bot/helpers.js";
import { setDmTopicName } from "./dm-topic-name.js";

export async function executeTelegramRenameCommand(params: TelegramCommandExecutorParams) {
  const auth = await prepareTelegramCommandAuthorization({ ...params, requireAuth: true });
  if (!auth) {
    return;
  }
  const reply = (text: string) =>
    runAuthorizedTelegramRequest(auth.assertOwnerCurrent, () => {
      auth.assertOwnerCurrent?.();
      return params.bot.api.sendMessage(
        auth.chatId,
        text,
        buildTelegramThreadParams(auth.threadSpec) ?? {},
      );
    });
  if (params.msg.chat.type !== "private" || auth.threadSpec.scope !== "dm" || !auth.threadSpec.id) {
    await reply("Use /rename <new title> inside the private-chat topic you want to rename.");
    return;
  }
  const threadId = auth.threadSpec.id;
  const name = params.rawText.trim();
  if (!name) {
    await reply("Usage: /rename <new topic title>");
    return;
  }
  if (Array.from(name).length > 128) {
    await reply("Topic titles must be 1–128 characters long.");
    return;
  }
  if (
    !createTelegramActionGate({ cfg: auth.runtimeCfg, accountId: params.accountId })(
      "editForumTopic",
    )
  ) {
    await reply("Topic renaming is disabled (actions.editForumTopic).");
    return;
  }
  try {
    await withTelegramApiErrorLogging({
      operation: "renameTopic",
      runtime: params.runtime,
      fn: () =>
        setDmTopicName({
          bot: params.bot,
          chatId: auth.chatId,
          threadId,
          name,
          manual: true,
          assertCurrent: () => {
            params.opts.accountAbortSignal?.throwIfAborted();
            auth.assertOwnerCurrent?.();
          },
        }),
    });
  } catch {
    await reply("Couldn't complete the topic rename. Check the topic title and try again.");
    return;
  }
  await reply(`Topic renamed to “${name}”.`);
}
