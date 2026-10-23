import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";
import {
  createCommandBot,
  createNativeCommandTestParams,
  createPrivateCommandContext,
  deliverReplies,
  resetNativeCommandMenuMocks,
} from "./bot-native-commands.menu-test-support.js";
import { isDmTopicManuallyNamed } from "./dm-topic-name.js";
import { setTelegramPluginStateRuntimeForTests } from "./runtime-state.test-support.js";
import {
  clearTelegramRuntimeForTest,
  resetTelegramTopicNameCacheForTest,
} from "./runtime.test-support.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({
    prefix: "telegram-rename-command-",
    layout: "state-only",
    applyEnv: true,
  });
  resetNativeCommandMenuMocks();
  resetTelegramTopicNameCacheForTest();
});
afterEach(async () => {
  resetTelegramTopicNameCacheForTest();
  clearTelegramRuntimeForTest();
  resetPluginStateStoreForTests();
  await state.cleanup();
});

function setup(
  options: {
    authorized?: boolean;
    enabled?: boolean;
    native?: boolean;
    skip?: boolean;
    fail?: boolean;
    named?: boolean;
  } = {},
) {
  const cfg: OpenClawConfig = {
    channels: {
      telegram: {
        dmPolicy: "allowlist",
        allowFrom: [options.authorized === false ? "999" : "200"],
        actions: { editForumTopic: options.enabled !== false },
        ...(options.named ? { accounts: { work: { actions: { reactions: true } } } } : {}),
      },
    },
  };
  const editForumTopic = options.fail
    ? vi.fn().mockRejectedValue(new Error("Telegram rejected the edit"))
    : vi.fn().mockResolvedValue(true);
  const fixture = createCommandBot({ api: { editForumTopic } });
  const params = createNativeCommandTestParams(cfg, {
    bot: fixture.bot,
    accountId: options.named ? "work" : "default",
    allowFrom: cfg.channels!.telegram!.allowFrom,
    nativeSkillsEnabled: false,
    nativeEnabled: options.native !== false,
    shouldSkipUpdate: () => options.skip === true,
    telegramCfg: cfg.channels!.telegram!,
  });
  setTelegramPluginStateRuntimeForTests();
  registerTelegramNativeCommands(params);
  return { ...fixture, editForumTopic };
}

it("advertises and executes rename on the current DM topic without agent delivery", async () => {
  const { bot, commandHandlers, setMyCommands, editForumTopic, sendMessage } = setup();
  expect(setMyCommands.mock.calls[0]?.[0]).toContainEqual(
    expect.objectContaining({ command: "rename" }),
  );
  await commandHandlers.get("rename")!({
    ...createPrivateCommandContext({ match: "  中文 topic 🫠  ", threadId: 99 }),
    me: {
      id: 123,
      is_bot: true,
      first_name: "Test",
      username: "test_bot",
      has_topics_enabled: true,
    },
  });
  expect(editForumTopic.mock.calls).toEqual([[100, 99, { name: "中文 topic 🫠" }]]);
  expect(sendMessage).toHaveBeenCalledWith(100, "Topic renamed to “中文 topic 🫠”.", {
    message_thread_id: 99,
  });
  expect(deliverReplies).not.toHaveBeenCalled();
  await expect(isDmTopicManuallyNamed(bot, 100, 99)).resolves.toBe(true);
});

it.each([
  { match: "", threadId: 99, expected: "Usage:" },
  { match: "😀".repeat(129), threadId: 99, expected: "128" },
  { match: "Name", threadId: undefined, expected: "inside the private-chat topic" },
  { match: "Name", threadId: 99, enabled: false, expected: "disabled" },
  { match: "Name", threadId: 99, authorized: false, expected: "not authorized" },
  { match: "Name", threadId: 99, enabled: false, named: true, expected: "disabled" },
])(
  "rejects invalid rename or authority: $expected",
  async ({ match, threadId, enabled, authorized, named, expected }) => {
    const { commandHandlers, editForumTopic, sendMessage } = setup({ enabled, authorized, named });
    await commandHandlers.get("rename")!({
      ...createPrivateCommandContext({ match, threadId }),
      me: { id: 123, is_bot: true, first_name: "Test", has_topics_enabled: true },
    });
    expect(editForumTopic).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      100,
      expect.stringContaining(expected),
      threadId ? { message_thread_id: threadId } : {},
    );
    expect(deliverReplies).not.toHaveBeenCalled();
  },
);

it("reports API failure without claiming success or marking a manual name", async () => {
  const { bot, commandHandlers, sendMessage } = setup({ fail: true });
  await commandHandlers.get("rename")!({
    ...createPrivateCommandContext({ match: "Name", threadId: 99 }),
    me: { id: 123, is_bot: true, first_name: "Test", has_topics_enabled: true },
  });
  expect(sendMessage).toHaveBeenCalledWith(100, expect.stringContaining("Couldn't complete"), {
    message_thread_id: 99,
  });
  await expect(isDmTopicManuallyNamed(bot, 100, 99)).resolves.toBe(false);
});

it("does not register rename when native commands are disabled", () => {
  const { commandHandlers } = setup({ native: false });
  expect(commandHandlers.has("rename")).toBe(false);
});

it("does not replay a skipped update", async () => {
  const { commandHandlers, editForumTopic, sendMessage } = setup({ skip: true });
  await commandHandlers.get("rename")!(
    createPrivateCommandContext({ match: "Name", threadId: 99 }),
  );
  expect(editForumTopic).not.toHaveBeenCalled();
  expect(sendMessage).not.toHaveBeenCalled();
});
