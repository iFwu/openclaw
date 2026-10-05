import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  consumeSubagentCompletionToolHandoff,
  registerSubagentCompletionToolHandoff,
} from "../../../gateway/subagent-completion-tool-handoff.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";

const observed = vi.hoisted(() => ({
  rejectPersistence: false,
  write: vi.fn(),
  flush: vi.fn(),
  physicalClosed: vi.fn(),
}));

const tempPaths: string[] = [];

beforeAll(async () => {
  vi.doMock("../../../trajectory/runtime.js", async () => {
    const actual = await vi.importActual<typeof import("../../../trajectory/runtime.js")>(
      "../../../trajectory/runtime.js",
    );
    return {
      ...actual,
      createTrajectoryRuntimeRecorder: (
        params: Parameters<typeof actual.createTrajectoryRuntimeRecorder>[0],
      ) =>
        actual.createTrajectoryRuntimeRecorder({
          ...params,
          writer: {
            filePath: "synthetic-trajectory-writer",
            write: observed.write,
            flush: async () => {
              observed.flush();
              if (observed.rejectPersistence) {
                throw new Error("synthetic settled trajectory persistence rejection");
              }
            },
          },
        }),
    };
  });
  vi.doMock("../../../shared/async-work-resources.js", async () => {
    const actual = await vi.importActual<typeof import("../../../shared/async-work-resources.js")>(
      "../../../shared/async-work-resources.js",
    );
    const runWithAsyncWorkResources: typeof actual.runWithAsyncWorkResources = (run, options) =>
      actual.runWithAsyncWorkResources(run, {
        ...options,
        onClosed: (error) => {
          options?.onClosed?.(error);
          if (options && Object.hasOwn(options, "onClosed")) {
            observed.physicalClosed(error);
          }
        },
      });
    return { ...actual, runWithAsyncWorkResources };
  });
  await preloadRunEmbeddedAttemptForTests();
});

beforeEach(() => {
  resetEmbeddedAttemptHarness();
  observed.write.mockClear();
  observed.flush.mockClear();
  observed.physicalClosed.mockReset();
});
afterEach(async () => cleanupTempPaths(tempPaths));

describe("actual native attempt after settled trajectory persistence", () => {
  it.each([
    { native: false, fail: true },
    { native: true, fail: false },
    { native: true, fail: true },
  ])(
    "returns after real resource closure (native=$native, failure=$fail)",
    async ({ native, fail }) => {
      observed.rejectPersistence = fail;
      const sessionKey = "agent:main:native-trajectory-owner";
      const sourceSessionKey = "agent:main:subagent:synthetic-completed-source";
      const sourceSessionId = "synthetic-child-incarnation";
      const registration = {
        sourceSessionKey,
        sourceSessionId,
        targetSessionKey: sessionKey,
        targetSessionId: "embedded-session",
        idempotencyKey: `trajectory-${native}-${fail}`,
      };
      const trustedInternalHandoff = native
        ? consumeSubagentCompletionToolHandoff({
            ...registration,
            handoffId: registerSubagentCompletionToolHandoff(registration),
            sourceTool: "subagent_announce",
            provider: "openai",
            model: "gpt-test",
          })
        : undefined;
      if (native) {
        expect(trustedInternalHandoff).toBeDefined();
      }
      const closed = createDeferred();
      observed.physicalClosed.mockImplementation((error) => {
        expect(error).toBeUndefined();
        closed.resolve();
      });
      let settled = false;
      const attempt = createContextEngineAttemptRunner({
        contextEngine: createContextEngineBootstrapAndAssemble(),
        sessionKey,
        tempPaths,
        trajectory: true,
        sessionPrompt: async (session) => {
          session.messages.push(
            makeAgentAssistantMessage({
              model: "gpt-test",
              content: [{ type: "text", text: "done" }],
            }),
          );
        },
        attemptOverrides: {
          trustedInternalHandoff,
          ...(native
            ? {
                inputProvenance: {
                  kind: "inter_session",
                  sourceSessionKey,
                  sourceTool: "subagent_announce",
                },
              }
            : {}),
        },
      }).then(
        (result) => {
          settled = true;
          return result;
        },
        (error: unknown) => {
          settled = true;
          throw error;
        },
      );
      void attempt.catch(() => {});
      await closed.promise;
      await nextTurn();
      expect(observed.flush).toHaveBeenCalled();
      expect(observed.physicalClosed).toHaveBeenCalledOnce();
      expect(settled).toBe(true);
      await attempt;
    },
  );
});
