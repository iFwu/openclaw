import { Bot, GrammyError } from "grammy";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isDmTopicManuallyNamed, setDmTopicName } from "./dm-topic-name.js";
import { setTelegramPluginStateRuntimeForTests } from "./runtime-state.test-support.js";
import {
  clearTelegramRuntimeForTest,
  resetTelegramTopicNameCacheForTest,
} from "./runtime.test-support.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({
    prefix: "telegram-dm-rename-",
    layout: "state-only",
    applyEnv: true,
  });
  setTelegramPluginStateRuntimeForTests();
  resetTelegramTopicNameCacheForTest();
});
afterEach(async () => {
  resetTelegramTopicNameCacheForTest();
  clearTelegramRuntimeForTest();
  resetPluginStateStoreForTests();
  await state.cleanup();
});

it("writes the manual title last when an automatic API request is already in flight", async () => {
  const bot = new Bot("123:synthetic-test-token");
  const started = createDeferred<void>();
  const finish = createDeferred<true>();
  const edit = vi
    .spyOn(bot.api, "editForumTopic")
    .mockImplementationOnce(() => {
      started.resolve();
      return finish.promise;
    })
    .mockResolvedValue(true);
  const target = { bot, chatId: 42, threadId: 99 };
  const automatic = setDmTopicName({ ...target, name: "Auto", manual: false });
  await started.promise;
  const manual = setDmTopicName({ ...target, name: "Manual", manual: true });
  expect(edit).toHaveBeenCalledTimes(1);
  finish.resolve(true);
  await Promise.all([automatic, manual]);
  expect(edit.mock.calls).toEqual([
    [42, 99, { name: "Auto" }],
    [42, 99, { name: "Manual" }],
  ]);
  resetTelegramTopicNameCacheForTest();
  resetPluginStateStoreForTests();
  await expect(setDmTopicName({ ...target, name: "Late auto", manual: false })).resolves.toBe(
    false,
  );
  expect(edit).toHaveBeenCalledTimes(2);
  await expect(isDmTopicManuallyNamed(new Bot("124:synthetic-test-token"), 42, 99)).resolves.toBe(
    false,
  );
});

it("does not mark a failed manual API edit as successful or block later edits", async () => {
  const bot = new Bot("123:synthetic-test-token");
  const edit = vi
    .spyOn(bot.api, "editForumTopic")
    .mockRejectedValueOnce(new Error("Denied"))
    .mockResolvedValue(true);
  const target = { bot, chatId: 42, threadId: 99 };
  await expect(setDmTopicName({ ...target, name: "Manual", manual: true })).rejects.toThrow(
    "Denied",
  );
  await expect(isDmTopicManuallyNamed(bot, 42, 99)).resolves.toBe(false);
  await expect(setDmTopicName({ ...target, name: "Auto", manual: false })).resolves.toBe(true);
  expect(edit).toHaveBeenCalledTimes(2);
});

it("rechecks authority after waiting for an earlier topic edit", async () => {
  const bot = new Bot("123:synthetic-test-token");
  const started = createDeferred<void>();
  const finish = createDeferred<true>();
  const edit = vi.spyOn(bot.api, "editForumTopic").mockImplementationOnce(() => {
    started.resolve();
    return finish.promise;
  });
  const target = { bot, chatId: 42, threadId: 99 };
  const automatic = setDmTopicName({ ...target, name: "Auto", manual: false });
  await started.promise;
  let active = true;
  const manual = setDmTopicName({
    ...target,
    name: "Manual",
    manual: true,
    assertCurrent: () => {
      if (!active) {
        throw new Error("Revoked");
      }
    },
  });
  const rejected = expect(manual).rejects.toThrow("Revoked");
  active = false;
  finish.resolve(true);
  await automatic;
  await rejected;
  expect(edit).toHaveBeenCalledTimes(1);
});

it("treats an unchanged title as a successful manual choice", async () => {
  const bot = new Bot("123:synthetic-test-token");
  vi.spyOn(bot.api, "editForumTopic").mockRejectedValue(
    new GrammyError(
      "unchanged",
      {
        ok: false,
        error_code: 400,
        description: "Bad Request: TOPIC_NOT_MODIFIED",
      },
      "editForumTopic",
      {},
    ),
  );
  await expect(
    setDmTopicName({ bot, chatId: 42, threadId: 99, name: "Same", manual: true }),
  ).resolves.toBe(true);
  await expect(isDmTopicManuallyNamed(bot, 42, 99)).resolves.toBe(true);
});
