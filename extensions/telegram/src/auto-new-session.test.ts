import { describe, expect, it } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";
import { TelegramConfigSchema } from "./config-schema.js";
import { resolveTelegramScopedGroupConfig } from "./group-config-helpers.js";

function groupMessage(text = "start the daily report") {
  return {
    message_id: 10,
    chat: { id: -1001234567890, type: "supergroup" as const, title: "Notifications" },
    date: 1_700_000_000,
    text,
    from: { id: 42, first_name: "Alice" },
  };
}

describe("Telegram Jev automatic new session opt-in", () => {
  it("accepts explicit DM/topic opt-in but rejects wildcard DM opt-in", () => {
    expect(
      TelegramConfigSchema.safeParse({
        direct: { "42": { autoNewSession: true, topics: { "7": { autoNewSession: false } } } },
      }).success,
    ).toBe(true);
    for (const direct of [
      { "*": { autoNewSession: true } },
      { "*": { topics: { "7": { autoNewSession: true } } } },
    ]) {
      expect(TelegramConfigSchema.safeParse({ direct }).success).toBe(false);
      expect(TelegramConfigSchema.safeParse({ accounts: { secondary: { direct } } }).success).toBe(
        false,
      );
    }
  });

  it.each([undefined, false] as const)(
    "projects explicit DM opt-in with topic override %s",
    async (override) => {
      const result = await buildTelegramMessageContextForTest({
        message: { chat: { id: 42, type: "private" }, text: "hello" },
        resolveTelegramGroupConfig: () =>
          resolveTelegramScopedGroupConfig(
            {
              direct: {
                "42": { autoNewSession: true, topics: { "7": { autoNewSession: override } } },
              },
            },
            42,
            7,
          ),
      });
      expect(result).toBeDefined();
      expect(result?.ctxPayload.AutoNewSession).toBe(override === false ? undefined : "jev");
    },
  );

  it("accepts group and topic configuration", () => {
    expect(
      TelegramConfigSchema.safeParse({
        groups: {
          "-1001234567890": {
            autoNewSession: true,
            topics: { "7": { autoNewSession: false } },
          },
        },
      }).success,
    ).toBe(true);
    expect(
      TelegramConfigSchema.safeParse({
        groups: { "-1001234567890": { autoNewSession: "yes" } },
      }).success,
    ).toBe(false);
    expect(
      TelegramConfigSchema.safeParse({
        groups: { "*": { autoNewSession: true } },
      }).success,
    ).toBe(false);
    expect(
      TelegramConfigSchema.safeParse({
        groups: { "*": { topics: { "7": { autoNewSession: true } } } },
      }).success,
    ).toBe(false);
    expect(
      TelegramConfigSchema.safeParse({
        accounts: {
          secondary: { groups: { "*": { topics: { "*": { autoNewSession: true } } } } },
        },
      }).success,
    ).toBe(false);
  });

  it("does not enable a DM through a group setting", async () => {
    const result = await buildTelegramMessageContextForTest({
      message: { chat: { id: 42, type: "private" }, text: "hello" },
      resolveTelegramGroupConfig: (id, topicId) =>
        resolveTelegramScopedGroupConfig(
          {
            groups: { "-1001234567890": { autoNewSession: true } },
          },
          id,
          topicId,
        ),
    });
    expect(result).toBeDefined();
    expect(result?.ctxPayload.AutoNewSession).toBeUndefined();
  });

  it("projects an explicit group opt-in into trusted inbound context", async () => {
    const result = await buildTelegramMessageContextForTest({
      message: groupMessage(),
      options: { forceWasMentioned: true },
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false, autoNewSession: true },
      }),
    });

    expect(result?.ctxPayload.AutoNewSession).toBe("jev");
  });

  it("lets a topic disable the inherited group opt-in", async () => {
    const result = await buildTelegramMessageContextForTest({
      message: {
        ...groupMessage(),
        is_topic_message: true,
        message_thread_id: 7,
      },
      options: { forceWasMentioned: true },
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false, autoNewSession: true },
        topicConfig: { autoNewSession: false },
      }),
    });

    expect(result).toBeDefined();
    expect(result?.ctxPayload.AutoNewSession).toBeUndefined();
  });

  it("does not opt commands into evaluation", async () => {
    const result = await buildTelegramMessageContextForTest({
      message: groupMessage("/status"),
      options: { forceWasMentioned: true },
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false, autoNewSession: true },
      }),
    });

    expect(result).toBeDefined();
    expect(result?.ctxPayload.AutoNewSession).toBeUndefined();
  });
});
