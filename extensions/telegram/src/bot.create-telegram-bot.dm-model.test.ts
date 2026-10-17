import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { expect, it, vi } from "vitest";
import {
  apiCalls,
  chat,
  createBot,
  from,
  harness,
} from "./bot.create-telegram-bot.native-pipeline.test-support.js";

vi.mock("openclaw/plugin-sdk/agent-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-runtime")>()),
  loadPreparedModelCatalog: vi.fn(async () => []),
}));

it("the registered DM picker remembers a manual selection and reports the actual scope", async () => {
  const storePath = harness.telegramBotDepsForTest.resolveStorePath(undefined, { agentId: "main" });
  const cfg: OpenClawConfig = {
    agents: { defaults: { model: "openai/gpt-4o" } },
    session: { store: storePath, dmScope: "per-channel-peer" },
    channels: { telegram: { dmPolicy: "open", allowFrom: ["*"], autoTopicLabel: false } },
  };
  const parentKey = `agent:main:telegram:direct:${chat.id}`;
  const sessionKey = `${parentKey}:thread:${chat.id}:99`;
  await upsertSessionEntry({
    storePath,
    sessionKey,
    entry: { sessionId: "picker-topic", updatedAt: 1 },
  });
  vi.mocked(harness.telegramBotDepsForTest.buildModelsProviderData).mockResolvedValue({
    byProvider: new Map([["openai", new Set(["gpt-4o", "gpt-5"])]]),
    providers: ["openai"],
    resolvedDefault: { provider: "openai", model: "gpt-4o" },
    modelNames: new Map(),
    modelCatalog: [
      { provider: "openai", id: "gpt-4o", name: "Original", reasoning: false },
      { provider: "openai", id: "gpt-5", name: "Selected", reasoning: false },
    ],
  });
  const bot = await createBot(false, true, cfg, true);
  for (const [index, model] of ["gpt-5", "gpt-4o"].entries()) {
    await bot.handleUpdate({
      update_id: 9000 + index,
      callback_query: {
        id: `dm-picker-${index}`,
        chat_instance: "dm-picker-chat",
        from,
        data: `mdl_sel_openai/${model}`,
        message: {
          message_id: 300 + index,
          date: 1736380800,
          chat,
          message_thread_id: 99,
          is_topic_message: true,
        },
      },
    });
    const parent = getSessionEntry({ storePath, sessionKey: parentKey });
    if (model === "gpt-5") {
      expect(parent?.modelOverride).toBe("gpt-5");
    } else {
      expect(parent?.modelOverrideSource).toBe("default");
    }
  }
  const edits = apiCalls.mock.calls.filter(([method]) => method === "editMessageText");
  expect(edits).toHaveLength(2);
  for (const [, payload] of edits) {
    expect(payload).toMatchObject({
      text: expect.stringContaining("new topics in this private chat"),
    });
  }
  expect(cfg.agents?.defaults?.model).toBe("openai/gpt-4o");
  expect(harness.replySpy).not.toHaveBeenCalled();
});
