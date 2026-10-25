import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context, Model } from "../types.js";
import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketStateForTest,
  streamSimpleOpenAICodexResponses,
} from "./openai-chatgpt-responses.js";

const model: Model<"openai-chatgpt-responses"> = {
  id: "test-model",
  name: "Test Model",
  api: "openai-chatgpt-responses",
  provider: "fixture-proxy",
  baseUrl: "https://proxy.example/v1",
  compat: { codexProxyMode: true },
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 256,
};
const context: Context = {
  systemPrompt: "Be concise.",
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
};
const options = { apiKey: "fixture-proxy-key", sessionId: "fixture-session" };

function completion(id = "resp_proxy") {
  return {
    type: "response.completed",
    response: {
      id,
      status: "completed",
      output: [],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    },
  };
}

function installSocket(action?: (socket: EventTarget) => void, handshakeFailures = 0) {
  const sockets: ScriptedSocket[] = [];
  const requests: Record<string, unknown>[] = [];
  class ScriptedSocket extends EventTarget {
    readonly readyState = 1;
    closed = false;
    headers: Headers;
    constructor(
      readonly url: string,
      init?: { headers?: Record<string, string> },
    ) {
      super();
      this.headers = new Headers(init?.headers);
      sockets.push(this);
      const failHandshake = sockets.length <= handshakeFailures;
      queueMicrotask(() => this.dispatchEvent(new Event(failHandshake ? "error" : "open")));
    }
    send(payload: string) {
      requests.push(JSON.parse(payload) as Record<string, unknown>);
      queueMicrotask(() => {
        if (action) {
          action(this);
        } else {
          this.dispatchEvent(
            Object.assign(new Event("message"), {
              data: JSON.stringify(completion(`resp_${requests.length}`)),
            }),
          );
        }
      });
    }
    close() {
      this.closed = true;
    }
  }
  vi.stubGlobal("WebSocket", ScriptedSocket);
  return { sockets, requests };
}

function installFetch() {
  const fetchMock = vi.fn<typeof fetch>(
    async () =>
      new Response(`data: ${JSON.stringify(completion())}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ChatGPT Responses explicit proxy mode", () => {
  afterEach(() => {
    closeOpenAICodexWebSocketSessions();
    resetOpenAICodexWebSocketStateForTest();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    "https://proxy.example/v1",
    "https://proxy.example/v1/",
    "https://proxy.example/v1/responses",
  ])("uses an opaque key and a standard Responses endpoint over SSE (%s)", async (baseUrl) => {
    const fetchMock = installFetch();
    const result = await streamSimpleOpenAICodexResponses(
      { ...model, baseUrl, headers: { "chatgpt-account-id": "must-not-leak" } },
      context,
      { ...options, transport: "sse" },
    ).result();
    expect(result.stopReason).toBe("stop");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0];
    if (!request) {
      throw new Error("missing proxy HTTP request");
    }
    const [url, init] = request;
    expect(url).toBe("https://proxy.example/v1/responses");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer fixture-proxy-key");
    expect(headers.has("chatgpt-account-id")).toBe(false);
    expect(JSON.parse(init?.body as string)).toMatchObject({
      instructions: "Be concise.",
      store: false,
    });
  });

  it.each([undefined, false])(
    "keeps OAuth required without explicit proxy opt-in (%s)",
    async (codexProxyMode) => {
      const fetchMock = installFetch();
      const result = await streamSimpleOpenAICodexResponses(
        { ...model, compat: { codexProxyMode } },
        context,
        { ...options, transport: "sse" },
      ).result();
      expect(result).toMatchObject({
        stopReason: "error",
        errorMessage: "Failed to extract accountId from token",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    "https://chatgpt.com/backend-api",
    "https://chatgpt.com./backend-api",
    "https://api.openai.com/v1",
    "https://eu.api.openai.com/v1",
    "ftp://proxy.example/v1",
    "https://proxy.example/v1?key=fixture",
    "https://proxy.example/v1#fragment",
    "https://user:pass@proxy.example/v1",
  ])("rejects proxy mode on an official or ambiguous endpoint (%s)", async (baseUrl) => {
    const fetchMock = installFetch();
    const result = await streamSimpleOpenAICodexResponses({ ...model, baseUrl }, context, {
      ...options,
      transport: "sse",
    }).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("codexProxyMode");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps cached WS continuation when request traceparent changes", async () => {
    const { sockets, requests } = installSocket();
    const first = await streamSimpleOpenAICodexResponses(model, context, {
      ...options,
      transport: "websocket-cached",
      headers: { traceparent: "00-11111111111111111111111111111111-2222222222222222-01" },
    }).result();
    expect(first.stopReason).toBe("stop");
    const second = await streamSimpleOpenAICodexResponses(
      model,
      {
        ...context,
        messages: [...context.messages, first, { role: "user", content: "next", timestamp: 2 }],
      },
      {
        ...options,
        transport: "websocket-cached",
        headers: { Traceparent: "00-11111111111111111111111111111111-3333333333333333-01" },
      },
    ).result();
    expect(second.stopReason).toBe("stop");
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.url).toBe("wss://proxy.example/v1/responses");
    expect(sockets[0]?.headers.get("authorization")).toBe("Bearer fixture-proxy-key");
    expect(sockets[0]?.headers.has("chatgpt-account-id")).toBe(false);
    expect(requests[1]).toMatchObject({
      previous_response_id: "resp_1",
      input: [expect.objectContaining({ role: "user" })],
    });
    closeOpenAICodexWebSocketSessions(options.sessionId);
    expect(sockets[0]?.closed).toBe(true);
  });

  it("continues tool results on the same proxy connection without replaying prior input", async () => {
    const { sockets, requests } = installSocket((socket) => {
      const events =
        requests.length === 1
          ? [
              {
                type: "response.output_item.added",
                output_index: 0,
                item: {
                  id: "fc_lookup",
                  call_id: "call_lookup",
                  type: "function_call",
                  name: "lookup",
                  arguments: "",
                  status: "in_progress",
                },
              },
              {
                type: "response.function_call_arguments.delta",
                output_index: 0,
                item_id: "fc_lookup",
                delta: '{"q":"fixture"}',
              },
              {
                type: "response.output_item.done",
                output_index: 0,
                item: {
                  id: "fc_lookup",
                  call_id: "call_lookup",
                  type: "function_call",
                  name: "lookup",
                  arguments: '{"q":"fixture"}',
                  status: "completed",
                },
              },
              completion("resp_tool"),
            ]
          : [completion("resp_tool_result")];
      for (const event of events) {
        socket.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(event) }));
      }
    });
    const requestOptions = { ...options, transport: "websocket-cached" as const };
    const toolContext: Context = {
      ...context,
      tools: [
        {
          name: "lookup",
          description: "Look up a fixture",
          parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
        },
      ],
    };
    const first = await streamSimpleOpenAICodexResponses(
      model,
      toolContext,
      requestOptions,
    ).result();
    expect(first.stopReason).toBe("toolUse");
    const call = first.content.find((block) => block.type === "toolCall");
    if (!call || call.type !== "toolCall") {
      throw new Error("missing tool call");
    }
    const result = await streamSimpleOpenAICodexResponses(
      model,
      {
        ...toolContext,
        messages: [
          ...toolContext.messages,
          first,
          {
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text", text: "fixture result" }],
            isError: false,
            timestamp: 2,
          },
        ],
      },
      requestOptions,
    ).result();
    expect(result.stopReason).toBe("stop");
    expect(sockets).toHaveLength(1);
    expect(requests[1]).toMatchObject({
      previous_response_id: "resp_tool",
      input: [
        expect.objectContaining({
          type: "function_call_output",
          call_id: "call_lookup",
          output: "fixture result",
        }),
      ],
    });
  });

  it("scopes sticky SSE fallback to the connection identity", async () => {
    const fetchMock = installFetch();
    const { requests } = installSocket(undefined, 1);
    const requestOptions = {
      ...options,
      transport: "auto" as const,
      headers: { traceparent: "00-11111111111111111111111111111111-2222222222222222-01" },
    };
    expect(
      (await streamSimpleOpenAICodexResponses(model, context, requestOptions).result()).stopReason,
    ).toBe("stop");
    expect(
      (
        await streamSimpleOpenAICodexResponses(model, context, {
          ...requestOptions,
          headers: { traceparent: "00-11111111111111111111111111111111-3333333333333333-01" },
        }).result()
      ).stopReason,
    ).toBe("stop");
    expect(requests).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      (
        await streamSimpleOpenAICodexResponses(model, context, {
          ...requestOptions,
          apiKey: "new-fixture-key",
        }).result()
      ).stopReason,
    ).toBe("stop");
    expect(requests).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["credential", "endpoint", "model", "headers"])(
    "does not reuse a session socket after changing %s",
    async (change) => {
      const { sockets, requests } = installSocket();
      const requestOptions = { ...options, transport: "websocket-cached" as const };
      expect(
        (await streamSimpleOpenAICodexResponses(model, context, requestOptions).result())
          .stopReason,
      ).toBe("stop");
      const nextModel = {
        ...model,
        ...(change === "endpoint" ? { baseUrl: "https://other.example/v1" } : {}),
        ...(change === "model" ? { id: "other-model" } : {}),
        ...(change === "headers" ? { headers: { "x-tenant": "other" } } : {}),
      };
      const result = await streamSimpleOpenAICodexResponses(nextModel, context, {
        ...requestOptions,
        ...(change === "credential" ? { apiKey: "other-fixture-key" } : {}),
      }).result();
      expect(result.stopReason).toBe("stop");
      expect(sockets).toHaveLength(2);
      expect(sockets[0]?.closed).toBe(true);
      expect(requests[1]?.previous_response_id).toBeUndefined();
    },
  );

  it("inherits close-1000 transport classification without retrying after streamed output", async () => {
    const fetchMock = installFetch();
    const { requests } = installSocket((socket) => {
      socket.dispatchEvent(
        Object.assign(new Event("message"), {
          data: JSON.stringify({ type: "response.created", response: { id: "resp_pending" } }),
        }),
      );
      socket.dispatchEvent(Object.assign(new Event("close"), { code: 1000, wasClean: true }));
    });
    const result = await streamSimpleOpenAICodexResponses(model, context, {
      ...options,
      transport: "auto",
    }).result();
    expect(result).toMatchObject({
      stopReason: "error",
      errorCode: "ERR_WEBSOCKET_TRANSPORT",
      errorMessage: "WebSocket closed 1000",
    });
    expect(requests).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not replay a dispatched request with unknown outcome before the first event", async () => {
    const fetchMock = installFetch();
    const { requests } = installSocket((socket) => {
      socket.dispatchEvent(Object.assign(new Event("close"), { code: 1000, wasClean: true }));
    });
    const result = await streamSimpleOpenAICodexResponses(model, context, {
      ...options,
      transport: "auto",
    }).result();
    expect(result).toMatchObject({ stopReason: "error", errorCode: "ERR_WEBSOCKET_TRANSPORT" });
    expect(requests).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts the proxy stream without SSE replay", async () => {
    const controller = new AbortController();
    const fetchMock = installFetch();
    const { sockets, requests } = installSocket(() => controller.abort());
    const result = await streamSimpleOpenAICodexResponses(model, context, {
      ...options,
      transport: "auto",
      signal: controller.signal,
    }).result();
    expect(result.stopReason).toBe("aborted");
    expect(requests).toHaveLength(1);
    expect(sockets[0]?.closed).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
