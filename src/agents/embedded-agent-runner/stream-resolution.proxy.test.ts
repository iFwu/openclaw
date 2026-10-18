import { configureAiTransportHost, createLlmRuntime, getAiTransportHost } from "@openclaw/ai";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";
import {
  createBoundaryAwareStreamFnForModel,
  createTransportAwareStreamFnForModel,
} from "@openclaw/ai/transports";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketStateForTest,
} from "../../../packages/ai/src/providers/openai-chatgpt-responses.js";
import { bindStreamLlmRuntime } from "../../llm/model-runtime-binding.js";
import type { Context, Model, StreamFn } from "../../llm/types.js";
import { mintSecretSentinel } from "../../secrets/sentinel.js";
import { resolveEmbeddedAgentStream } from "./stream-resolution.js";

const host = getAiTransportHost();
const model: Model<"openai-chatgpt-responses"> = {
  api: "openai-chatgpt-responses",
  provider: "fixture-proxy",
  id: "fixture-model",
  name: "Fixture Model",
  baseUrl: "https://proxy.example/v1",
  reasoning: true,
  compat: { codexProxyMode: true },
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 256,
};
const context: Context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

function installSocket() {
  const handshakes: Array<{ url: string; headers: Headers }> = [];
  const requests: Array<Record<string, unknown>> = [];
  class ProxySocket extends EventTarget {
    readyState = 1;
    constructor(url: string, options?: { headers?: Record<string, string> }) {
      super();
      handshakes.push({ url, headers: new Headers(options?.headers) });
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(payload: string) {
      requests.push(JSON.parse(payload) as Record<string, unknown>);
      queueMicrotask(() =>
        this.dispatchEvent(
          Object.assign(new Event("message"), {
            data: JSON.stringify({
              type: "response.completed",
              response: {
                id: `resp_${requests.length}`,
                status: "completed",
                output: [],
                usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
              },
            }),
          }),
        ),
      );
    }
    close() {
      this.readyState = 3;
    }
  }
  vi.stubGlobal("WebSocket", ProxySocket);
  const fetchMock = vi.fn(() => {
    throw new Error("Codex proxy WS must not fall back to HTTP");
  });
  vi.stubGlobal("fetch", fetchMock);
  return { handshakes, requests, fetchMock };
}

describe("embedded Codex proxy stream selection", () => {
  afterEach(() => {
    closeOpenAICodexWebSocketSessions();
    resetOpenAICodexWebSocketStateForTest();
    configureAiTransportHost(host);
    vi.unstubAllGlobals();
  });

  it.each([
    { baseUrl: "https://proxy.example/v1", owned: false },
    { baseUrl: "https://proxy.example/v1/responses", owned: false },
    { baseUrl: "https://proxy.example/v1", owned: true },
    { baseUrl: "https://proxy.example/v1/responses", owned: true },
  ])(
    "runs Codex WS and cached continuation through the runner ($baseUrl, owned=$owned)",
    async ({ baseUrl, owned }) => {
      const runtime = createLlmRuntime();
      registerBuiltInApiProviders(runtime.registry);
      const fixture = { ...model, baseUrl };
      const { handshakes, requests, fetchMock } = installSocket();
      const currentStreamFn: StreamFn | undefined = owned
        ? (requestModel, requestContext, options) =>
            runtime.streamSimple(requestModel, requestContext, options)
        : undefined;
      if (currentStreamFn) {
        bindStreamLlmRuntime(currentStreamFn, runtime);
      }
      const assertCurrent = vi.fn();
      const { streamFn, strategy } = resolveEmbeddedAgentStream({
        llmRuntime: runtime,
        currentStreamFn,
        model: fixture,
        sessionId: "proxy-runner",
        resolvedApiKey: mintSecretSentinel("fixture-proxy-key", { label: "proxy-runner-auth" }),
        assertCurrent,
      });
      expect(strategy).toBe("openclaw-native-codex-responses");
      const first = await (
        await streamFn(fixture, context, { transport: "websocket-cached" })
      ).result();
      expect(first.stopReason).toBe("stop");
      const second = await (
        await streamFn(
          fixture,
          {
            messages: [
              ...context.messages,
              first,
              { role: "user", content: "continue", timestamp: 2 },
            ],
          },
          { transport: "websocket-cached" },
        )
      ).result();
      expect(second.stopReason).toBe("stop");
      expect(handshakes).toHaveLength(1);
      expect(handshakes[0]?.url).toBe("wss://proxy.example/v1/responses");
      expect(handshakes[0]?.headers.get("authorization")).toBe("Bearer fixture-proxy-key");
      expect(handshakes[0]?.headers.has("chatgpt-account-id")).toBe(false);
      expect(requests[1]).toMatchObject({
        type: "response.create",
        previous_response_id: "resp_1",
        input: [expect.objectContaining({ role: "user" })],
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(assertCurrent).toHaveBeenCalled();
    },
  );

  it("keeps unopted custom providers on their existing boundary-aware path", () => {
    const runtime = createLlmRuntime();
    registerBuiltInApiProviders(runtime.registry);
    expect(
      resolveEmbeddedAgentStream({
        llmRuntime: runtime,
        currentStreamFn: undefined,
        model: { ...model, compat: { codexProxyMode: false } },
        sessionId: "proxy-unopted",
      }).strategy,
    ).toBe("boundary-aware:openai-chatgpt-responses");
  });

  it("keeps an explicit provider-owned stream authoritative", () => {
    const runtime = createLlmRuntime();
    const providerStreamFn = vi.fn<StreamFn>();
    expect(
      resolveEmbeddedAgentStream({
        llmRuntime: runtime,
        currentStreamFn: undefined,
        providerStreamFn,
        model,
        sessionId: "provider-owned-proxy",
      }).strategy,
    ).toBe("provider");
  });

  it("does not silently replace Codex proxy mode with a generic managed transport", async () => {
    configureAiTransportHost({ ...host, requiresManagedTransport: () => true });
    expect(() => createTransportAwareStreamFnForModel(model)).toThrow(/codexProxyMode.*managed/i);
    expect(() => createBoundaryAwareStreamFnForModel(model)).toThrow(/codexProxyMode.*managed/i);
    const runtime = createLlmRuntime();
    registerBuiltInApiProviders(runtime.registry);
    const { handshakes, fetchMock } = installSocket();
    const { streamFn } = resolveEmbeddedAgentStream({
      llmRuntime: runtime,
      currentStreamFn: undefined,
      model,
      sessionId: "managed-proxy",
      resolvedApiKey: "fixture-proxy-key",
    });
    const result = await (
      await streamFn(model, context, { transport: "websocket-cached" })
    ).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(/codexProxyMode.*managed/i);
    expect(handshakes).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps explicit boundary-aware proxy callers on the Codex adapter", async () => {
    const { handshakes, requests, fetchMock } = installSocket();
    const stream = createBoundaryAwareStreamFnForModel(model);
    if (!stream) {
      throw new Error("missing proxy stream");
    }
    const result = await (
      await stream(model, context, {
        apiKey: "***",
        transport: "websocket-cached",
        sessionId: "boundary-proxy",
      })
    ).result();
    expect(result.stopReason).toBe("stop");
    expect(handshakes[0]?.url).toBe("wss://proxy.example/v1/responses");
    expect(requests[0]?.type).toBe("response.create");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
