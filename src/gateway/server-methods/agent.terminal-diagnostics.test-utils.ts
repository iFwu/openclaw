// Register terminal publication cases in the existing mocked agent.test.ts graph.
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordAgentRunTerminalOutcome } from "../../channels/turn/agent-run-terminal-outcome.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { waitForAgentJob } from "../agent-turn/agent-job.js";
import { dispatchAgentRunFromGateway } from "../agent-turn/agent-run-dispatch.js";
import { createAgentTurnIo } from "../agent-turn/io.js";
import {
  describe0AfterEach0,
  getAgentTestMocks,
  makeContext,
  primeMainAgentRun,
  useTestStateDir,
} from "./agent.test-harness.js";

const mocks = getAgentTestMocks();

describe("gateway terminal diagnostics", () => {
  afterEach(describe0AfterEach0);

  it.each([
    {
      name: "resolved failure",
      timeout: false,
      recordedError: undefined,
      expectedError: "Provider rejected this request.",
    },
    {
      name: "resolved timeout",
      timeout: true,
      recordedError: undefined,
      expectedError: "Request timed out before a response was generated.",
    },
    {
      name: "context overflow",
      timeout: false,
      recordedError: undefined,
      expectedError: "Context overflow: prompt too large for the model (mid-turn precheck).",
    },
    {
      name: "producer lifecycle guidance",
      timeout: false,
      recordedError: "Reconnect the selected provider, then try again.",
      expectedError: "Reconnect the selected provider, then try again.",
    },
  ])(
    "retains the $name diagnostic through terminal publication and agent.wait",
    async (scenario) => {
      await withTestDir({ prefix: "openclaw-agent-task-diagnostic-" }, async (root) => {
        useTestStateDir(root);
        primeMainAgentRun();
        const runId = `task-diagnostic-${scenario.name}`;
        mocks.agentCommand.mockResolvedValueOnce(
          recordAgentRunTerminalOutcome(
            {
              payloads: [],
              meta: {
                durationMs: 1,
                error: {
                  kind: "incomplete_turn",
                  message: scenario.recordedError ? "Agent run failed" : scenario.expectedError,
                },
                ...(scenario.timeout
                  ? { timeoutPhase: "provider", providerStarted: true }
                  : { stopReason: "error" }),
              },
            },
            "failed",
            scenario.recordedError,
          ),
        );
        const onSettled = vi.fn(() => true);
        await dispatchAgentRunFromGateway({
          admittedRunEntry: undefined,
          ingressOpts: {
            message: "Run this request.",
            sessionKey: "agent:main:main",
            allowModelOverride: false,
          },
          runId,
          dedupeKeys: [`agent:${runId}`],
          abortController: new AbortController(),
          cleanupAbortController: vi.fn(),
          io: createAgentTurnIo(vi.fn()),
          context: makeContext(),
          onSettled,
        });
        expect(onSettled).toHaveBeenCalledWith(
          expect.objectContaining({
            terminalOutcome: expect.objectContaining({ error: scenario.expectedError }),
          }),
        );
        await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toMatchObject({
          status: scenario.timeout ? "timeout" : "error",
          error: scenario.expectedError,
        });
      });
    },
  );
});
