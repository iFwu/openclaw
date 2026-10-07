import { createOpenAIResponsesTransportStreamFn } from "@openclaw/ai/transports";
import type { Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { sleepWithAbort } from "../../../infra/backoff.js";
import {
  closeResponsesSseServer,
  createResponsesSseServer,
} from "../../test-helpers/responses-sse-server.test-support.js";
import {
  handleAssistantFailureAfterRecovery,
  recoverAfterTransportDrop,
  type TransportDropScenario,
} from "./attempt-recovery.test-support.js";

vi.mock("../../../infra/backoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/backoff.js")>()),
  sleepWithAbort: vi.fn(async () => {}),
}));

describe("recoverEmbeddedRunAttempt provider capacity", () => {
  it.each([
    { name: "rate-limited", code: undefined, message: undefined },
    {
      name: "HTTP 200 gateway_concurrency_limit",
      code: "gateway_concurrency_limit",
      message: "Concurrency limit exceeded for account, please retry later",
    },
    {
      name: "HTTP 200 gateway_queue_full",
      code: "gateway_queue_full",
      message: "Too many pending requests, please retry later",
    },
  ])(
    "exhausts ten $name attempts before profile rotation and model failover",
    async ({ code, message }) => {
      const responseServer = code
        ? await createResponsesSseServer({
            type: "response.failed",
            sequence_number: 0,
            response: {
              id: "resp-gateway-slot-limit",
              object: "response",
              created_at: 0,
              model: "synthetic-model",
              status: "failed",
              error: { code, message },
              output: [],
            },
          })
        : undefined;
      const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
      vi.mocked(sleepWithAbort).mockClear();
      try {
        let requestAssistant: TransportDropScenario["requestAssistant"];
        if (responseServer) {
          const model = {
            id: "synthetic-model",
            name: "Synthetic Model",
            api: "openai-responses",
            provider: "openai",
            baseUrl: responseServer.baseUrl,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 4_096,
          } satisfies Model;
          const streamResponse = createOpenAIResponsesTransportStreamFn();
          requestAssistant = async () => {
            const stream = await streamResponse(
              model,
              {
                messages: [
                  { role: "user", content: "Reply when capacity is available", timestamp: 0 },
                ],
                tools: [],
              },
              { apiKey: "test-key" },
            );
            const assistant = await stream.result();
            expect(assistant).toMatchObject({ stopReason: "error", errorCode: code });
            return assistant;
          };
        }
        const fixture = await recoverAfterTransportDrop({
          requestAssistant,
          ...(responseServer ? { noTools: true } : {}),
          errorMessage: "429 provider rate limit",
          diagnostics: [],
          content: [],
          replaySafe: true,
        });
        const { failoverRetryController: failover } = fixture;
        expect(fixture.recovery).toMatchObject({
          action: "retry",
          lastRetryFailoverReason: "rate_limit",
        });
        for (let retry = 2; retry <= 9; retry++) {
          expect(await fixture.recover()).toMatchObject({
            action: "retry",
            lastRetryFailoverReason: "rate_limit",
          });
          if (responseServer) {
            expect(responseServer.requestPaths).toHaveLength(retry);
          }
          expect(failover.advanceAuthProfile).not.toHaveBeenCalled();
        }
        expect(await fixture.recover()).toEqual({ action: "proceed" });
        expect(failover.advanceAuthProfile).not.toHaveBeenCalled();
        expect(fixture.continueFromCurrentTranscript).toHaveBeenCalledTimes(9);
        expect(fixture.onAgentEvent.mock.calls.map(([event]) => event.data)).toEqual(
          Array.from({ length: 9 }, (_, index) =>
            expect.objectContaining({
              phase: "retrying",
              reason: "rate_limit",
              attempt: index + 2,
              maxAttempts: 10,
            }),
          ),
        );
        expect(vi.mocked(sleepWithAbort).mock.calls.map(([delayMs]) => delayMs)).toEqual([
          1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000,
        ]);
        await expect(
          handleAssistantFailureAfterRecovery(fixture, "rate_limit"),
        ).rejects.toMatchObject({
          name: "FailoverError",
          reason: "rate_limit",
          status: 429,
        });
        expect(failover.advanceAuthProfile).toHaveBeenCalledOnce();
        if (responseServer) {
          expect(responseServer.requestPaths).toEqual(
            Array.from({ length: 10 }, () => "/v1/responses"),
          );
        }
      } finally {
        random.mockRestore();
        if (responseServer) {
          await closeResponsesSseServer(responseServer.server);
        }
      }
    },
  );

  it.each([
    { errorMessage: "WebSocket error" },
    {
      errorMessage: "WebSocket closed: reason included ECONNRESET",
      errorCode: "ERR_WEBSOCKET_TRANSPORT",
      diagnostics: [],
    },
    { errorMessage: "Responses stream ended with unresolved tool calls", diagnostics: [] },
  ])("continues a settled exec batch after $errorMessage", async (scenario) => {
    const {
      recovery,
      markOwnedTranscriptRetry,
      continueFromCurrentTranscript,
      failoverRetryController,
    } = await recoverAfterTransportDrop(scenario);

    expect(recovery).toMatchObject({ action: "retry" });
    expect(failoverRetryController.transientRetryCount).toBe(1);
    expect(markOwnedTranscriptRetry).toHaveBeenCalledTimes(1);
    expect(continueFromCurrentTranscript).toHaveBeenCalledTimes(1);
    expect(failoverRetryController.advanceAuthProfile).not.toHaveBeenCalled();
    expect(failoverRetryController.maybeMarkAuthProfileFailure).not.toHaveBeenCalled();
  });
});
