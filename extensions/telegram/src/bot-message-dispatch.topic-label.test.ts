import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import { prepareTelegramTopicLabel, runTelegramTopicLabelOnce } from "./auto-topic-label.js";
import {
  createBot,
  createContext,
  describeTelegramDispatch,
  dispatchWithContext,
  generateTopicLabel,
  loadSessionStore,
} from "./bot-message-dispatch.test-harness.js";

describeTelegramDispatch("DM topic labels", () => {
  it("does not restart naming from a second message prepared before the first label settled", async () => {
    const params = {
      key: "overlapping-topic",
      sessionId: "generation",
      firstTurn: true,
      userMessage: "First content",
    };
    expect(await prepareTelegramTopicLabel(params)).toBe(true);
    const entered = createDeferred<void>();
    const completion = createDeferred<boolean>();
    const first = runTelegramTopicLabelOnce({
      ...params,
      isCurrent: () => true,
      run: async () => {
        entered.resolve();
        return await completion.promise;
      },
    });
    await entered.promise;
    expect(
      await prepareTelegramTopicLabel({
        ...params,
        firstTurn: false,
        userMessage: "Second content",
      }),
    ).toBe(true);
    completion.resolve(true);
    await first;
    const second = vi.fn(async () => true);
    await runTelegramTopicLabelOnce({ ...params, isCurrent: () => true, run: second });
    expect(second).not.toHaveBeenCalled();
    expect(await prepareTelegramTopicLabel({ ...params, firstTurn: false })).toBe(false);
  });
  it("retains pending state after failure and refuses an obsolete generation", async () => {
    const params = {
      key: "deferred-topic",
      sessionId: "original",
      firstTurn: true,
      userMessage: "/model example",
    };
    expect(await prepareTelegramTopicLabel(params)).toBe(false);
    const content = { ...params, firstTurn: false, userMessage: "Real content" };
    expect(await prepareTelegramTopicLabel(content)).toBe(true);
    await expect(
      runTelegramTopicLabelOnce({
        ...params,
        isCurrent: () => true,
        run: async () => {
          throw new Error("temporary naming failure");
        },
      }),
    ).rejects.toThrow("temporary naming failure");
    expect(await prepareTelegramTopicLabel(content)).toBe(true);
    const stale = vi.fn(async () => true);
    await runTelegramTopicLabelOnce({ ...params, isCurrent: () => false, run: stale });
    expect(stale).not.toHaveBeenCalled();
    expect(await prepareTelegramTopicLabel({ ...content, sessionId: "replacement" })).toBe(false);
    await runTelegramTopicLabelOnce({ ...params, isCurrent: () => true, run: async () => true });
    expect(await prepareTelegramTopicLabel(content)).toBe(false);
  });

  it("defers slash-prefixed input until real content even after a command ran a turn", async () => {
    const bot = createBot();
    const context = createContext();
    const sessionKey = "agent:main:telegram:direct:123:thread:123:777";
    context.ctxPayload = {
      SessionKey: sessionKey,
      RawBody: "  /unknown arguments",
    };
    loadSessionStore.mockReturnValue({
      [sessionKey]: { sessionId: "command-first" },
    });
    await dispatchWithContext({
      bot,
      context,
      streamMode: "off",
      telegramCfg: { autoTopicLabel: true },
    });
    expect(generateTopicLabel).not.toHaveBeenCalled();
    expect(bot.api.editForumTopic).not.toHaveBeenCalled();

    loadSessionStore.mockReturnValue({
      [sessionKey]: { sessionId: "command-first", systemSent: true },
    });
    context.ctxPayload.RawBody = "/model openai/example";
    await dispatchWithContext({
      bot,
      context,
      streamMode: "off",
      telegramCfg: { autoTopicLabel: true },
    });
    expect(generateTopicLabel).not.toHaveBeenCalled();

    const renamed = createDeferred<void>();
    vi.mocked(bot.api.editForumTopic).mockImplementation(async () => {
      renamed.resolve();
      return true;
    });
    context.ctxPayload.RawBody = "Investigate invoice processing";
    await dispatchWithContext({
      bot,
      context,
      streamMode: "off",
      telegramCfg: { autoTopicLabel: true },
    });
    await renamed.promise;
    expect(generateTopicLabel).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ userMessage: "Investigate invoice processing" }),
    );
    context.ctxPayload.RawBody = "Continue investigating";
    await dispatchWithContext({
      bot,
      context,
      streamMode: "off",
      telegramCfg: { autoTopicLabel: true },
    });
    expect(generateTopicLabel).toHaveBeenCalledOnce();
  });
});
