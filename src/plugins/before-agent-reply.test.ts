import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAgentEventLifecycleGeneration,
  withAgentRunLifecycleGeneration,
} from "../infra/agent-events.js";
import {
  buildHandledBeforeAgentReplyPayloads,
  runBeforeAgentReplyForTurn,
  withBeforeAgentReplyObserver,
} from "./before-agent-reply.js";

const hookRunner = vi.hoisted(() => ({
  hasHooks: vi.fn(),
  runBeforeAgentReply: vi.fn(),
}));

vi.mock("./hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookRunner,
}));

function runHook(runId: string) {
  return runBeforeAgentReplyForTurn({
    runId,
    trigger: "user",
    event: { cleanedBody: runId },
    context: { runId, trigger: "user" },
  });
}

describe("before_agent_reply runner boundary", () => {
  beforeEach(() => {
    hookRunner.hasHooks.mockReset().mockReturnValue(true);
    hookRunner.runBeforeAgentReply.mockReset().mockResolvedValue(undefined);
  });

  it("preserves the complete reply payload", () => {
    const reply = {
      text: "claimed",
      channelData: { native: true },
      sensitiveMedia: true,
      videoAsNote: true,
    };

    expect(buildHandledBeforeAgentReplyPayloads(reply)).toEqual([reply]);
  });

  it("uses the validated turn trigger when context disagrees", async () => {
    const runId = "mismatch";
    const context = { runId, trigger: "heartbeat" };
    await runBeforeAgentReplyForTurn({
      runId,
      trigger: "user",
      event: { cleanedBody: runId },
      context,
    });

    const expectedContext = { ...context, trigger: "user" };
    expect(hookRunner.hasHooks).toHaveBeenCalledWith("before_agent_reply", expectedContext);
    expect(hookRunner.runBeforeAgentReply).toHaveBeenCalledWith(
      { cleanedBody: runId },
      expectedContext,
    );
  });

  it("does not dispatch for internal triggers", async () => {
    const trigger = "manual";
    await expect(
      runBeforeAgentReplyForTurn({
        runId: trigger,
        trigger,
        event: { cleanedBody: trigger },
        context: { runId: trigger, trigger },
      }),
    ).resolves.toBeUndefined();

    expect(hookRunner.hasHooks).not.toHaveBeenCalled();
    expect(hookRunner.runBeforeAgentReply).not.toHaveBeenCalled();
  });

  it("keeps a nested run from checkpointing its parent admission", async () => {
    const beforeDispatch = vi.fn(async () => undefined);
    const afterDispatch = vi.fn(async (result) => result);
    hookRunner.runBeforeAgentReply.mockImplementation(async (_event, context) => {
      if (context.runId === "parent") {
        await runHook("child");
      }
      return undefined;
    });

    await withBeforeAgentReplyObserver({ beforeDispatch, afterDispatch }, () => runHook("parent"));

    expect(hookRunner.runBeforeAgentReply).toHaveBeenCalledTimes(2);
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(afterDispatch).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "admits the foreground turn once even without hooks (hooks=%s)",
    async (hooks) => {
      hookRunner.hasHooks.mockReturnValue(hooks);
      const beforeExecution = vi.fn(async () => undefined);
      const beforeDispatch = vi.fn(async () => undefined);
      const afterDispatch = vi.fn(async (result) => result);
      await withAgentRunLifecycleGeneration(getAgentEventLifecycleGeneration(), () =>
        withBeforeAgentReplyObserver(
          { beforeExecution, beforeDispatch, afterDispatch },
          async () => {
            await runHook(`admit-${hooks}`);
            await runHook(`admit-${hooks}`);
          },
        ),
      );
      expect(beforeExecution).toHaveBeenCalledOnce();
      expect(beforeDispatch).toHaveBeenCalledTimes(hooks ? 1 : 0);
    },
  );

  it("does not dispatch a plugin or model for an already handled input", async () => {
    const beforeDispatch = vi.fn(async () => undefined);
    const afterDispatch = vi.fn(async (result) => result);
    const result = await withBeforeAgentReplyObserver(
      {
        beforeExecution: async () => ({ handled: true, reply: { text: "NO_REPLY" } }),
        beforeDispatch,
        afterDispatch,
      },
      () => runHook("already-handled"),
    );
    expect(result).toEqual({ handled: true, reply: { text: "NO_REPLY" } });
    expect(beforeDispatch).not.toHaveBeenCalled();
    expect(hookRunner.runBeforeAgentReply).not.toHaveBeenCalled();
  });

  it("does not let an earlier nested run consume the foreground admission", async () => {
    hookRunner.hasHooks.mockReturnValue(false);
    const beforeExecution = vi.fn(async () => undefined);
    await withBeforeAgentReplyObserver(
      {
        runId: "foreground-admission",
        beforeExecution,
        beforeDispatch: async () => undefined,
        afterDispatch: async (result) => result,
      },
      async () => {
        await runHook("nested-before-foreground");
        expect(beforeExecution).not.toHaveBeenCalled();
        await runHook("foreground-admission");
        expect(beforeExecution).toHaveBeenCalledOnce();
      },
    );
  });
});
