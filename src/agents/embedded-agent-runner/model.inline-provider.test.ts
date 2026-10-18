import { createLlmRuntime } from "@openclaw/ai";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildInlineProviderModels, completeInlineProviderModel } from "./model.inline-provider.js";
import { makeModel } from "./model.test-harness.js";

describe("buildInlineProviderModels", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("executes a configured Codex proxy model through the registered API adapter", async () => {
    const provider = {
      api: "openai-chatgpt-responses" as const,
      baseUrl: "https://proxy.example/v1",
      models: [{ ...makeModel("fixture-model"), compat: { codexProxyMode: true } }],
    };
    const [inline] = buildInlineProviderModels({ "fixture-proxy": provider });
    if (!inline) {
      throw new Error("missing configured proxy model");
    }
    const runtimeModel = completeInlineProviderModel(inline, provider);
    const runtime = createLlmRuntime();
    registerBuiltInApiProviders(runtime.registry);
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          `data: ${JSON.stringify({
            type: "response.completed",
            response: { id: "resp_proxy", status: "completed", output: [] },
          })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await runtime
      .streamSimple(
        runtimeModel,
        {
          messages: [{ role: "user", content: "hello", timestamp: 1 }],
        },
        { apiKey: "fixture-proxy-key", transport: "sse" },
      )
      .result();
    expect(result).toMatchObject({
      stopReason: "stop",
      provider: "fixture-proxy",
      model: "fixture-model",
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://proxy.example/v1/responses");
  });

  it("normalizes bare Google API hosts for custom Google Generative AI providers", () => {
    expect(
      buildInlineProviderModels({
        "google-paid ": {
          baseUrl: "https://generativelanguage.googleapis.com",
          api: "google-generative-ai",
          models: [makeModel("gemini-2.5-pro")],
        },
      }),
    ).toMatchObject([
      {
        provider: "google-paid",
        api: "google-generative-ai",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      },
    ]);
  });

  it("merges provider request headers into inline models", () => {
    const result = buildInlineProviderModels({
      proxy: {
        baseUrl: "https://proxy.example.com/v1",
        api: "openai-completions",
        request: { headers: { "X-Tenant": "acme" } },
        models: [makeModel("proxy-model")],
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.headers).toEqual({ "X-Tenant": "acme" });
  });

  it("drops SecretRef marker headers in inline provider models", () => {
    const result = buildInlineProviderModels({
      custom: {
        headers: {
          Authorization: "secretref-env:OPENAI_HEADER_TOKEN",
          "X-Managed": "secretref-managed",
          "X-Static": "tenant-a",
        },
        models: [makeModel("custom-model")],
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.headers).toEqual({ "X-Static": "tenant-a" });
  });
});
