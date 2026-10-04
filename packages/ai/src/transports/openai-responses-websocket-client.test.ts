import {
  PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE,
  type Context,
  type Model,
} from "@openclaw/llm-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../../../../src/config/plugin-auto-enable.test-helpers.js";
import { isRetryableAssistantError } from "../../../../src/llm/utils/retry.js";
import { createEmptyPluginRegistry } from "../../../../src/plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../../../../src/plugins/runtime/generation-scope.js";
import { createDeferred, withTestTimeout } from "../../../../test/helpers/promise.js";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { cleanupSessionResources } from "../session-resources.js";
import {
  createOpenAIResponsesClient,
  createOpenAIResponsesTransportStreamFn,
} from "./openai-responses-client.js";
import {
  OpenAIResponsesWebSocketSafeRetryError,
  type ResponsesPromptObservation,
} from "./openai-responses-contracts.js";
import type {
  StreamMessage,
  SdkResponse,
} from "./openai-responses-websocket-client.test-support.js";
import {
  assertCompatibleFastWire,
  initialHost,
  model,
  userMessage,
  completedEvent,
  message,
  wrappedSdkServerError,
  toolCallResponse,
  sdkCompletion,
  sdkEvent,
  run,
} from "./openai-responses-websocket-client.test-support.js";
import { forbidResponsesTestNetwork } from "./openai-responses-websocket-network.test-support.js";
import { createOpenAIResponsesWebSocketStream } from "./openai-responses-websocket.js";

const transportState = vi.hoisted(() => ({
  handshakeMessages: [] as StreamMessage[],
  responseBatches: [] as StreamMessage[][],
  sdkOutcomes: [] as Array<Error | SdkResponse>,
  sdkRequests: [] as Array<Record<string, unknown>>,
  sdkDispatchSignals: [] as Array<AbortSignal | undefined>,
  websocketCloseCount: 0,
  websocketCloseReasons: [] as string[],
  websocketClients: [] as Array<{ apiKey?: string; baseURL?: string }>,
  websocketOptions: [] as Array<{ headers?: Record<string, string> }>,
  websocketRequests: [] as Array<Record<string, unknown>>,
}));

vi.mock("openai", () => {
  class MockOpenAI {
    apiKey: string;
    baseURL: string;
    defaultHeaders: Record<string, string | null>;
    responses = {
      create: (request: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
        transportState.sdkRequests.push(request);
        transportState.sdkDispatchSignals.push(options?.signal);
        const outcome = transportState.sdkOutcomes.shift() ?? new Error("Unexpected SSE request");
        return {
          withResponse: async () => {
            if (outcome instanceof Error) {
              throw outcome;
            }
            return outcome;
          },
        };
      },
    };

    constructor(options: {
      apiKey?: string;
      baseURL?: string;
      defaultHeaders?: Record<string, string | null>;
    }) {
      this.apiKey = options.apiKey ?? "";
      this.baseURL = options.baseURL ?? "https://api.openai.com/v1";
      this.defaultHeaders = options.defaultHeaders ?? {};
    }

    withOptions(options: { apiKey?: string; defaultHeaders?: Record<string, string | null> }) {
      return new MockOpenAI({
        apiKey: options.apiKey ?? this.apiKey,
        baseURL: this.baseURL,
        defaultHeaders: options.defaultHeaders ?? this.defaultHeaders,
      });
    }

    _buildWebSocketHeaders(authHeaders: Record<string, string>) {
      const headers = new Headers(authHeaders);
      for (const [name, value] of Object.entries(this.defaultHeaders)) {
        if (value === null) {
          headers.delete(name);
        } else {
          headers.set(name, value);
        }
      }
      return Object.fromEntries(headers);
    }

    buildURL(path: string) {
      return this.baseURL.replace(/\/+$/, "") + path;
    }
  }

  return { default: MockOpenAI, AzureOpenAI: MockOpenAI };
});

vi.mock("openai/resources/responses/ws.js", () => ({
  ResponsesWS: class MockResponsesWS {
    socket = { readyState: 1 };
    private responseMessages: StreamMessage[] = [];

    constructor(
      client: { apiKey?: string; baseURL?: string },
      options: { headers?: Record<string, string> },
    ) {
      transportState.websocketClients.push(client);
      transportState.websocketOptions.push(options);
    }

    send(request: Record<string, unknown>) {
      transportState.websocketRequests.push(request);
      this.responseMessages = transportState.responseBatches.shift() ?? [];
    }

    close(options?: { reason?: string }) {
      transportState.websocketCloseCount += 1;
      transportState.websocketCloseReasons.push(options?.reason ?? "");
      this.socket.readyState = 3;
    }

    on(_event: string, _listener: (error: Error) => void) {
      return this;
    }

    stream() {
      const handshake = transportState.handshakeMessages.shift() ?? { type: "open" as const };
      const readResponses = () => this.responseMessages;
      return (async function* () {
        yield handshake;
        if (handshake.type !== "open") {
          return;
        }
        for (const streamMessage of readResponses()) {
          if (streamMessage.type === "delay") {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, streamMessage.ms);
            });
            continue;
          }
          yield streamMessage;
        }
      })();
    }
  },
}));

describe("native OpenAI Responses WebSocket client integration", () => {
  it.each(["sse", "websocket-cached"] as const)(
    "preserves compatible Fast opt-in and default-off semantics on %s wire",
    async (transport) => {
      await assertCompatibleFastWire(transport, transportState);
    },
  );
  let verifyNoNetwork: (() => void) | undefined;
  beforeEach(() => {
    verifyNoNetwork = forbidResponsesTestNetwork();
    cleanupSessionResources();
    transportState.handshakeMessages.length = 0;
    transportState.responseBatches.length = 0;
    transportState.sdkOutcomes.length = 0;
    transportState.sdkRequests.length = 0;
    transportState.sdkDispatchSignals.length = 0;
    transportState.websocketCloseCount = 0;
    transportState.websocketCloseReasons.length = 0;
    transportState.websocketClients.length = 0;
    transportState.websocketOptions.length = 0;
    transportState.websocketRequests.length = 0;
    let turn = 0;
    configureAiTransportHost({
      ...initialHost,
      plugin: {
        ...initialHost.plugin,
        resolveTransportTurnState: ({ context }) => {
          turn += 1;
          return {
            headers: {
              "x-openclaw-session-id": context.sessionId ?? "",
              "x-openclaw-turn-id": `turn-${turn}`,
              "x-openclaw-turn-attempt": "1",
            },
            metadata: {
              openclaw_session_id: context.sessionId ?? "",
              openclaw_turn_id: `turn-${turn}`,
              openclaw_turn_attempt: "1",
              openclaw_transport: context.transport,
            },
            websocket: {
              headers: {
                "x-client-request-id": context.sessionId ?? "",
                "x-openclaw-session-id": context.sessionId ?? "",
                "x-provider-route": "route-a",
              },
              degradeCooldownMs: 1_000,
            },
          };
        },
      },
    });
  });

  afterEach(() => {
    cleanupSessionResources();
    configureAiTransportHost(initialHost);
    verifyNoNetwork?.();
  });

  it.each([undefined, "short", "none"] as const)(
    "preserves affinity policy and WebSocket acceptance with %s retention",
    async (cacheRetention) => {
      transportState.responseBatches.push([message(completedEvent("resp_accepted", "ok"))]);
      const acceptanceObserver = vi.fn();

      const result = await run(
        { messages: [userMessage("hello", 1)], tools: [] },
        {
          acceptanceObserver,
          cacheRetention,
          model:
            cacheRetention === undefined
              ? model
              : { ...model, compat: { sendSessionIdHeader: true } },
        },
      );

      expect(result.stopReason).toBe("stop");
      expect(acceptanceObserver).toHaveBeenCalledWith({ kind: "provider_stream_opened" });
      expect(transportState.websocketOptions[0]?.headers?.session_id).toBe(
        cacheRetention === "short" ? "session-1" : undefined,
      );
      expect(transportState.websocketOptions[0]?.headers?.["x-client-request-id"]).toBe(
        "session-1",
      );
    },
  );

  it("preserves nonconflicting turn headers with an explicit OpenCode session", async () => {
    transportState.responseBatches.push([message(completedEvent("resp_accepted", "ok"))]);

    const result = await run(
      { messages: [userMessage("hello", 1)], tools: [] },
      {
        model: {
          ...model,
          headers: { "X-OpenCode-Session": "configured-session" },
        },
      },
    );

    expect(result.stopReason).toBe("stop");
    expect(transportState.websocketOptions[0]?.headers).toMatchObject({
      "X-OpenCode-Session": "configured-session",
      "x-client-request-id": "session-1",
      "x-openclaw-session-id": "session-1",
      "x-provider-route": "route-a",
    });
  });

  it("reports compatible WebSocket acceptance and keeps native Astra steering hooks isolated", async () => {
    const { Agent } = await import("node:http");
    const agent = new Agent();
    const release = vi.fn(() => agent.destroy());
    const acceptanceObserver = vi.fn();
    const onActiveResponse = vi.fn();
    configureAiTransportHost({
      ...getAiTransportHost(),
      prepareResponsesWebSocket: async () => ({ agent, release }),
    });
    transportState.responseBatches.push([message(completedEvent("resp_compatible_acceptance"))]);
    const result = await run(
      { messages: [userMessage("hello", 1)], tools: [] },
      {
        model: {
          ...model,
          id: "gpt-6-astra",
          provider: "compatible-gateway",
          baseUrl: "https://api.openai.com/v1",
          compat: { supportsResponsesWebSocket: true },
        },
        acceptanceObserver,
        onActiveResponse,
      },
    );
    expect(result.stopReason).toBe("stop");
    expect(acceptanceObserver).toHaveBeenCalledWith({ kind: "provider_stream_opened" });
    expect(onActiveResponse).not.toHaveBeenCalled();
    cleanupSessionResources();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("closes the WebSocket when acceptance observation fails", async () => {
    transportState.responseBatches.push([message(completedEvent("resp_rejected", "ignored"))]);
    const hookError = new Error("acceptance observer failed");

    const result = await run(
      { messages: [userMessage("hello", 1)], tools: [] },
      {
        acceptanceObserver: () => {
          throw hookError;
        },
      },
    );

    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "acceptance observer failed",
    });
    expect(transportState.websocketCloseCount).toBe(1);
  });

  it("continues past provider-only output metadata with one socket and only new input", async () => {
    transportState.responseBatches.push(
      [message(completedEvent("resp_1", "first answer"))],
      [message(completedEvent("resp_2", "second answer"))],
    );
    const firstUser = userMessage("first question", 1);
    const first = await run(
      { messages: [firstUser], tools: [] },
      { headers: { traceparent: "00-first-turn" } },
    );
    expect(first.stopReason).toBe("stop");
    expect(transportState.websocketCloseReasons).toEqual([]);

    const second = await run(
      {
        messages: [firstUser, first, userMessage("second question", 2)],
        tools: [],
      },
      { headers: { traceparent: "00-second-turn" } },
    );
    expect(second.stopReason).toBe("stop");

    expect(transportState.sdkRequests).toEqual([]);
    expect(transportState.websocketOptions).toHaveLength(1);
    expect(transportState.websocketOptions[0]?.headers).toMatchObject({
      "x-client-request-id": "session-1",
      "x-openclaw-session-id": "session-1",
    });
    expect(transportState.websocketOptions[0]?.headers).not.toHaveProperty("x-openclaw-turn-id");
    expect(transportState.websocketOptions[0]?.headers).not.toHaveProperty("traceparent");
    expect(transportState.websocketRequests).toHaveLength(2);
    expect(transportState.websocketRequests[1]).toMatchObject({
      previous_response_id: "resp_1",
    });
    expect(transportState.websocketRequests[1]?.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "second question" }],
      },
    ]);
    expect(transportState.websocketRequests[0]).not.toHaveProperty("stream");
  });

  it("continues a tool loop without treating synthetic missing results as provider output", async () => {
    transportState.responseBatches.push(toolCallResponse("resp_tool"), [
      message(completedEvent("resp_answer", "done")),
    ]);
    const user = userMessage("read the file", 1);
    const toolCall = await run({ messages: [user], tools: [] });
    const block = toolCall.content.find((item) => item.type === "toolCall");
    if (!block || block.type !== "toolCall") {
      throw new Error("Expected a tool call");
    }

    const answer = await run({
      messages: [
        user,
        toolCall,
        {
          role: "toolResult",
          toolCallId: block.id,
          toolName: block.name,
          content: [{ type: "text", text: "file contents" }],
          isError: false,
          timestamp: 2,
        },
      ],
      tools: [],
    });

    expect(answer.stopReason).toBe("stop");
    expect(transportState.websocketOptions).toHaveLength(1);
    expect(transportState.websocketRequests[1]).toMatchObject({
      previous_response_id: "resp_tool",
      input: [
        {
          type: "function_call_output",
          call_id: "call_read",
          output: "file contents",
        },
      ],
    });
  });

  it("falls back to SSE only when the WebSocket fails before dispatch", async () => {
    transportState.handshakeMessages.push({ type: "error", error: new Error("connect failed") });
    transportState.sdkOutcomes.push(sdkCompletion("resp_sse"));

    const result = await run({ messages: [userMessage("hello", 1)], tools: [] });

    expect(result.stopReason).toBe("stop");
    expect(transportState.websocketRequests).toEqual([]);
    expect(transportState.sdkRequests).toHaveLength(1);
  });

  it("awaits the SSE response hook before start after a WebSocket fallback", async () => {
    transportState.handshakeMessages.push({ type: "error", error: new Error("connect failed") });
    transportState.sdkOutcomes.push(sdkCompletion("resp_sse"));
    const order: string[] = [];
    let releaseHook!: () => void;
    const hookPending = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    const onResponse = vi.fn(async () => {
      order.push("hook:start");
      await hookPending;
      order.push("hook:end");
    });
    const responseStream = await createOpenAIResponsesTransportStreamFn()(
      model,
      { messages: [userMessage("hello", 1)], tools: [] },
      {
        apiKey: "test-key",
        sessionId: "session-1",
        transport: "auto",
        onResponse,
      },
    );
    const consume = (async () => {
      for await (const event of responseStream) {
        order.push(event.type);
      }
    })();

    await vi.waitFor(() => expect(onResponse).toHaveBeenCalledOnce());
    expect(order).toEqual(["hook:start"]);

    releaseHook();
    await consume;
    expect((await responseStream.result()).stopReason).toBe("stop");
    expect(order.slice(0, 3)).toEqual(["hook:start", "hook:end", "start"]);
  });

  it("skips repeated WebSocket setup during the provider degradation cooldown", async () => {
    transportState.handshakeMessages.push({ type: "error", error: new Error("connect failed") });
    transportState.sdkOutcomes.push(sdkCompletion("resp_sse_1"), sdkCompletion("resp_sse_2"));

    const first = await run({ messages: [userMessage("first", 1)], tools: [] });
    const second = await run({ messages: [userMessage("second", 2)], tools: [] });

    expect(first.stopReason).toBe("stop");
    expect(second.stopReason).toBe("stop");
    expect(transportState.websocketOptions).toHaveLength(1);
    expect(transportState.websocketRequests).toEqual([]);
    expect(transportState.sdkRequests).toHaveLength(2);
  });

  it.each<{ code: string; param?: string; message?: string }>([
    { code: "previous_response_not_found", param: "previous_response_id" },
    { code: "websocket_connection_limit_reached" },
    {
      code: "unsupported_parameter",
      param: "previous_response_id",
      message: "Previous response cannot be used for this organization due to Zero Data Retention.",
    },
  ])(
    "recovers a cached continuation rejected with $code over full-history SSE",
    async ({ code, param, message: rejection }) => {
      transportState.responseBatches.push(
        [message(completedEvent("resp_1", "first answer"))],
        [
          {
            type: "error",
            error: wrappedSdkServerError({
              code,
              message: rejection ?? `safe rejection: ${code}`,
              param,
              status: 400,
            }),
          },
        ],
        [message(completedEvent("resp_3", "third answer"))],
      );
      transportState.sdkOutcomes.push(sdkCompletion("resp_sse"));
      const firstUser = userMessage("first question", 1);
      const first = await run({ messages: [firstUser], tools: [] });

      const secondUser = userMessage("second question", 2);
      const observations: ResponsesPromptObservation[] = [];
      const second = await run(
        { messages: [firstUser, first, secondUser], tools: [] },
        { observations },
      );

      expect(second.stopReason).toBe("stop");
      expect(transportState.websocketRequests[1]).toMatchObject({
        previous_response_id: "resp_1",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "second question" }],
          },
        ],
      });
      expect(transportState.websocketCloseCount).toBe(1);
      expect(transportState.sdkRequests).toHaveLength(1);
      expect(transportState.sdkRequests[0]).not.toHaveProperty("previous_response_id");
      expect(transportState.sdkRequests[0]?.input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "user" }),
          expect.objectContaining({ role: "assistant" }),
          expect.objectContaining({ role: "user" }),
        ]),
      );
      expect(
        observations.map(({ egress, payloadVariant }) => ({ egress, payloadVariant })),
      ).toEqual([
        { egress: "responses-websocket", payloadVariant: "initial" },
        { egress: "responses-sdk", payloadVariant: "continuation-rejected" },
      ]);

      const third = await run({
        messages: [firstUser, first, secondUser, second, userMessage("third question", 3)],
        tools: [],
      });
      expect(third.stopReason).toBe("stop");
      expect(transportState.websocketOptions).toHaveLength(2);
      expect(transportState.sdkRequests).toHaveLength(1);
    },
  );

  it("preserves the wrapped server error details and original SDK cause", async () => {
    const cause = wrappedSdkServerError({
      code: "previous_response_not_found",
      message: "previous response missing",
      param: "previous_response_id",
      status: 400,
    });
    transportState.responseBatches.push([{ type: "error", error: cause }]);
    const response = createOpenAIResponsesWebSocketStream({
      client: createOpenAIResponsesClient(model, "test-key", {}),
      request: { model: model.id, input: [] },
      mode: "websocket",
    });

    let error: unknown;
    try {
      for await (const event of response.stream) {
        void event;
      }
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(OpenAIResponsesWebSocketSafeRetryError);
    expect(error).toMatchObject({
      code: "previous_response_not_found",
      message: "previous response missing",
      param: "previous_response_id",
      status: 400,
    });
    expect((error as Error).cause).toBe(cause);
    expect(transportState.websocketCloseCount).toBe(1);
  });

  it("recovers a rejected WebSocket compaction replay over full-history SSE", async () => {
    const onCompactionRejected = vi.fn();
    transportState.responseBatches.push(
      [
        message(
          completedEvent("resp_checkpoint", [
            {
              type: "compaction",
              id: "cmp_rejected",
              encrypted_content: "opaque-rejected-compaction",
            },
          ]),
        ),
      ],
      [
        {
          type: "error",
          error: wrappedSdkServerError({
            code: "invalid_encrypted_content",
            message: "compaction checkpoint could not be decrypted",
            param: "input[0].encrypted_content",
            status: 400,
          }),
        },
      ],
      [message(completedEvent("resp_next"))],
    );
    transportState.sdkOutcomes.push(sdkCompletion("resp_recovered"));
    const firstUser = userMessage("full history before compaction", 1);
    const checkpoint = await run({ messages: [firstUser], tools: [] }, { transport: "websocket" });
    expect(checkpoint.providerReplay).toMatchObject({ type: "openai-responses-compaction" });
    transportState.websocketRequests.length = 0;
    const observations: ResponsesPromptObservation[] = [];
    const context = {
      messages: [firstUser, checkpoint, userMessage("continue after compaction", 2)],
      tools: [],
    } satisfies Context;

    const result = await run(context, {
      observations,
      transport: "websocket",
      onCompactionRejected,
    });
    const next = await run(
      {
        ...context,
        messages: [...context.messages, result, userMessage("continue again", 3)],
      },
      { observations, transport: "websocket" },
    );

    expect(result).toMatchObject({
      stopReason: "stop",
      providerReplay: {
        type: "openai-responses-compaction-suppression",
        data: "rejected",
      },
    });
    expect(next.stopReason).toBe("stop");
    expect(onCompactionRejected).toHaveBeenCalledOnce();
    expect(transportState.websocketRequests).toHaveLength(2);
    expect(JSON.stringify(transportState.websocketRequests[0]?.input)).toContain(
      '"type":"compaction"',
    );
    expect(JSON.stringify(transportState.websocketRequests[0]?.input)).not.toContain(
      "full history before compaction",
    );
    expect(transportState.sdkRequests).toHaveLength(1);
    expect(JSON.stringify(transportState.sdkRequests[0]?.input)).not.toContain(
      '"type":"compaction"',
    );
    expect(JSON.stringify(transportState.sdkRequests[0]?.input)).toContain(
      "full history before compaction",
    );
    expect(JSON.stringify(transportState.websocketRequests[1]?.input)).not.toContain(
      '"type":"compaction"',
    );
    expect(observations.map(({ egress, payloadVariant }) => ({ egress, payloadVariant }))).toEqual([
      { egress: "responses-websocket", payloadVariant: "initial" },
      { egress: "responses-sdk", payloadVariant: "compaction-stripped" },
      { egress: "responses-websocket", payloadVariant: "initial" },
    ]);
  });

  it.each([
    [
      "invalid_websocket_request",
      "request may have been dispatched",
      PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE,
    ],
    [
      "invalid_encrypted_content",
      "encrypted reasoning was rejected without compaction",
      "invalid_encrypted_content",
    ],
    [
      "thinking_signature_invalid",
      "thinking signature was rejected without replayable reasoning",
      "thinking_signature_invalid",
    ],
  ])(
    "does not replay over SSE after a post-dispatch %s without compaction",
    async (code, text, expectedCode) => {
      transportState.responseBatches.push([
        {
          type: "error",
          error: wrappedSdkServerError({
            code,
            message: text,
            param: "input",
            status: 400,
          }),
        },
      ]);

      const result = await run({ messages: [userMessage("hello", 1)], tools: [] });

      expect(result.stopReason).toBe("error");
      expect(result.errorCode).toBe(expectedCode);
      expect(transportState.websocketRequests).toHaveLength(1);
      expect(transportState.sdkRequests).toEqual([]);
    },
  );

  it("applies the request timeout after dispatch without falling back", async () => {
    transportState.responseBatches.push([{ type: "delay", ms: 25 }]);

    const result = await run({ messages: [userMessage("hello", 1)], tools: [] }, { timeoutMs: 5 });

    expect(result.stopReason).toBe("error");
    expect(transportState.websocketRequests).toHaveLength(1);
    expect(transportState.sdkRequests).toEqual([]);
    expect(transportState.websocketCloseCount).toBe(1);

    transportState.sdkOutcomes.push(sdkCompletion("resp_sse"));
    const next = await run({ messages: [userMessage("next", 2)], tools: [] });
    expect(next.stopReason).toBe("stop");
    expect(transportState.websocketOptions).toHaveLength(1);
    expect(transportState.sdkRequests).toHaveLength(1);
  });

  it("preserves failed terminal semantics across WebSocket and SSE without degradation", async () => {
    const failedEvent = {
      type: "response.failed",
      response: {
        id: "resp_failed",
        status: "failed",
        model: "gpt-5.6-luna-2026-08-01",
        service_tier: "priority",
        error: { code: "server_error", message: "503 temporary provider response" },
        output: [],
        usage: {
          input_tokens: 21,
          output_tokens: 4,
          total_tokens: 25,
          input_tokens_details: { cached_tokens: 6, cache_write_tokens: 2 },
          output_tokens_details: { reasoning_tokens: 3 },
        },
      },
    };
    const pricedModel = {
      ...model,
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
    } satisfies Model<"openai-responses">;
    transportState.responseBatches.push(
      [message(failedEvent)],
      [message(completedEvent("resp_next"))],
    );
    transportState.sdkOutcomes.push(sdkEvent(failedEvent));

    const websocket = await run(
      { messages: [userMessage("websocket", 1)], tools: [] },
      { model: pricedModel },
    );
    const sse = await run(
      { messages: [userMessage("sse", 2)], tools: [] },
      { model: pricedModel, transport: "sse" },
    );

    const terminalFacts = {
      provider: "openai",
      stopReason: "error",
      errorMessage: "server_error: 503 temporary provider response",
      errorCode: "server_error",
      responseId: "resp_failed",
      responseModel: "gpt-5.6-luna-2026-08-01",
      usage: {
        input: 13,
        output: 4,
        cacheRead: 6,
        cacheWrite: 2,
        reasoningTokens: 3,
        totalTokens: 25,
      },
    };
    expect(websocket).toMatchObject(terminalFacts);
    expect(sse).toMatchObject(terminalFacts);
    expect(websocket.usage.cost.total).toBeCloseTo(0.000401, 10);
    expect(sse.usage.cost.total).toBeCloseTo(0.000401, 10);
    const classifyFailoverReason = vi.fn(() => undefined);
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.providers.push({
      pluginId: "openai",
      source: "test",
      provider: { id: "openai", label: "OpenAI fixture", auth: [], classifyFailoverReason },
    });
    // Agent runs prepare a provider owner before retry classification. Keep that boundary
    // here so the transport fixture exercises core retry policy without plugin discovery.
    withPluginRuntimeGenerationScope(
      {
        metadataSnapshot: createPluginMetadataSnapshot({
          manifestRegistry: makeRegistry([{ id: "openai", channels: [], providers: ["openai"] }]),
        }),
        pluginRegistry,
      },
      () => {
        expect(isRetryableAssistantError(websocket)).toBe(true);
        expect(isRetryableAssistantError(sse)).toBe(true);
      },
    );
    const expectedProviderSignal = {
      provider: "openai",
      code: "server_error",
      errorMessage: terminalFacts.errorMessage,
      errorType: undefined,
      status: undefined,
    };
    expect(classifyFailoverReason.mock.calls).toEqual([
      [expectedProviderSignal],
      [expectedProviderSignal],
    ]);

    const next = await run(
      { messages: [userMessage("next", 3)], tools: [] },
      { model: pricedModel },
    );
    expect(next.stopReason).toBe("stop");
    expect(transportState.websocketOptions).toHaveLength(2);
    expect(transportState.websocketRequests[1]).not.toHaveProperty("previous_response_id");
    expect(transportState.sdkRequests).toHaveLength(1);
  });

  it("keeps a true post-dispatch connection loss replay-unsafe", async () => {
    transportState.responseBatches.push([{ type: "close", code: 1006 }]);

    const result = await run({ messages: [userMessage("hello", 1)], tools: [] });

    expect(result).toMatchObject({
      stopReason: "error",
      errorCode: PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE,
    });
    expect(isRetryableAssistantError(result)).toBe(false);
    expect(transportState.websocketRequests).toHaveLength(1);
    expect(transportState.sdkRequests).toEqual([]);
  });

  it.each(["websocket", "websocket-cached", "auto"] as const)(
    "uses a guarded compatible route for %s without granting native Astra steering",
    async (transport) => {
      const { Agent } = await import("node:http");
      const agent = new Agent();
      const release = vi.fn(() => agent.destroy());
      const prepare = vi.fn(async () => ({ agent, release }));
      configureAiTransportHost({ ...getAiTransportHost(), prepareResponsesWebSocket: prepare });
      transportState.responseBatches.push([
        { type: "message", message: completedEvent("resp_custom", "compatible answer") },
      ]);
      const compatibleModel = {
        ...model,
        id: "gpt-6-astra",
        provider: "compatible-gateway",
        baseUrl: "https://compatible.example/v1",
        compat: { supportsResponsesWebSocket: true },
      };
      const result = await run(
        { messages: [userMessage("hello", 1)], tools: [] },
        { model: compatibleModel, transport },
      );
      expect(result.stopReason).toBe("stop");
      expect(prepare).toHaveBeenCalledWith(
        expect.objectContaining({
          model: compatibleModel,
          url: "wss://compatible.example/v1/responses",
          signal: expect.any(AbortSignal),
        }),
      );
      expect(transportState.websocketOptions[0]).toMatchObject({ agent });
      expect(transportState.sdkRequests).toEqual([]);
      cleanupSessionResources();
      expect(release).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["missing", "rejected"])(
    "never opens a bare compatible socket when the host route is %s",
    async (routeStatus) => {
      configureAiTransportHost({
        ...getAiTransportHost(),
        prepareResponsesWebSocket:
          routeStatus === "missing"
            ? undefined
            : async () => {
                throw new Error("synthetic SSRF rejection");
              },
      });
      transportState.sdkOutcomes.push(sdkCompletion("resp_guarded_sse"));
      const result = await run(
        { messages: [userMessage("hello", 1)], tools: [] },
        {
          model: {
            ...model,
            baseUrl: "https://compatible.example/v1",
            compat: { supportsResponsesWebSocket: true },
          },
        },
      );
      expect(result.stopReason).toBe("stop");
      expect(transportState.websocketClients).toEqual([]);
      expect(transportState.sdkRequests).toHaveLength(1);
    },
  );

  it("releases a route aborted during preparation without attempting WS or fallback SSE", async () => {
    const { Agent } = await import("node:http");
    const agent = new Agent();
    const release = vi.fn(() => agent.destroy());
    const controller = new AbortController();
    configureAiTransportHost({
      ...getAiTransportHost(),
      prepareResponsesWebSocket: async () => {
        controller.abort();
        return { agent, release };
      },
    });
    const result = await run(
      { messages: [userMessage("hello", 1)], tools: [] },
      {
        signal: controller.signal,
        model: {
          ...model,
          baseUrl: "https://compatible.example/v1",
          compat: { supportsResponsesWebSocket: true },
        },
      },
    );
    expect(result.stopReason).not.toBe("stop");
    expect(release).toHaveBeenCalledTimes(1);
    expect(transportState.websocketClients).toEqual([]);
    expect(transportState.sdkRequests).toEqual([]);
  });

  it("keeps host-managed compatible routes on guarded SSE even with opt-in", async () => {
    const prepare = vi.fn();
    configureAiTransportHost({
      ...getAiTransportHost(),
      requiresManagedTransport: () => true,
      prepareResponsesWebSocket: prepare,
    });
    transportState.sdkOutcomes.push(sdkCompletion("resp_managed"));
    const result = await run(
      { messages: [userMessage("hello", 1)], tools: [] },
      {
        model: {
          ...model,
          baseUrl: "https://compatible.example/v1",
          compat: { supportsResponsesWebSocket: true },
        },
      },
    );
    expect(result.stopReason).toBe("stop");
    expect(prepare).not.toHaveBeenCalled();
    expect(transportState.websocketClients).toEqual([]);
  });

  it.each(["deadline", "caller"] as const)(
    "does not dispatch SSE after %s abort while SafeRetry rebuild awaits",
    async (abortKind) => {
      const { Agent } = await import("node:http");
      const agent = new Agent();
      const release = vi.fn(() => agent.destroy());
      let routeSignal: AbortSignal | undefined;
      configureAiTransportHost({
        ...getAiTransportHost(),
        prepareResponsesWebSocket: async ({ signal }) => {
          routeSignal = signal;
          return { agent, release };
        },
      });
      transportState.responseBatches.push([
        {
          type: "error",
          error: wrappedSdkServerError({
            code: "websocket_connection_limit_reached",
            message: "synthetic safe rejection",
            status: 400,
          }),
        },
      ]);
      transportState.sdkOutcomes.push(sdkCompletion("resp_should_not_dispatch"));
      const entered = createDeferred();
      const resume = createDeferred();
      const controller = new AbortController();
      let payloadCalls = 0;
      const resultPromise = run(
        { messages: [userMessage("hello", 1)], tools: [] },
        {
          model: {
            ...model,
            provider: "compatible-gateway",
            baseUrl: "https://compatible.example/v1",
            compat: { supportsResponsesWebSocket: true },
          },
          timeoutMs: 500,
          signal: controller.signal,
          onPayload: async (payload) => {
            if (++payloadCalls === 2) {
              entered.resolve();
              await resume.promise;
            }
            return payload;
          },
        },
      );
      await withTestTimeout(entered.promise, 3000, "SafeRetry did not enter payload rebuild");
      if (!routeSignal) {
        throw new Error("missing route signal");
      }
      if (abortKind === "caller") {
        controller.abort();
      }
      if (!routeSignal.aborted) {
        await withTestTimeout(
          new Promise<void>((resolve) => {
            routeSignal?.addEventListener("abort", () => resolve(), { once: true });
          }),
          3000,
          "route deadline did not abort",
        );
      }
      resume.resolve();
      const result = await resultPromise;
      expect(transportState.sdkDispatchSignals.filter((signal) => !signal?.aborted)).toHaveLength(
        0,
      );
      expect(result.stopReason).not.toBe("stop");
      expect(release).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps custom OpenAI-compatible endpoints on guarded SSE", async () => {
    transportState.sdkOutcomes.push(sdkCompletion("resp_sse"));
    const compatibleModel = { ...model, baseUrl: "https://compatible.example/v1" };

    const result = await run(
      { messages: [userMessage("hello", 1)], tools: [] },
      { model: compatibleModel },
    );

    expect(result.stopReason).toBe("stop");
    expect(transportState.websocketClients).toEqual([]);
    expect(transportState.sdkRequests).toHaveLength(1);
  });

  it("keeps host-managed proxy and TLS models on guarded SSE", async () => {
    configureAiTransportHost({
      ...getAiTransportHost(),
      requiresManagedTransport: () => true,
    });
    transportState.sdkOutcomes.push(sdkCompletion("resp_sse"));

    const result = await run({ messages: [userMessage("hello", 1)], tools: [] });

    expect(result.stopReason).toBe("stop");
    expect(transportState.websocketClients).toEqual([]);
    expect(transportState.sdkRequests).toHaveLength(1);
  });
});
