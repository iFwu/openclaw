import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamOpenAIResponses } from "../../packages/ai/src/providers/openai-responses.js";
import type { Model } from "../llm/types.js";
import { applyExtraParamsToAgent } from "./embedded-agent-runner/extra-params.js";
import { testing as extraParamsTesting } from "./embedded-agent-runner/extra-params.test-support.js";
import type { StreamFn } from "./runtime/index.js";

const sdk = vi.hoisted(() => ({ requests: [] as Record<string, unknown>[] }));
vi.mock("openai", () => ({
  default: class {
    responses = {
      create: (request: Record<string, unknown>) => {
        sdk.requests.push(structuredClone(request));
        throw new Error("Captured synthetic request at SDK boundary");
      },
    };
  },
}));

const model: Model<"openai-responses"> = {
  id: "test-model",
  name: "Test model",
  api: "openai-responses",
  provider: "test-proxy",
  baseUrl: "https://proxy.example.test/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
};

const underlying: StreamFn = (selected, context, options) =>
  streamOpenAIResponses({ ...selected, api: "openai-responses" }, context, options);

beforeEach(() => {
  extraParamsTesting.setProviderRuntimeDepsForTest();
});

afterEach(() => {
  sdk.requests.length = 0;
  extraParamsTesting.resetProviderRuntimeDepsForTest();
});

describe("Responses configured payload policy", () => {
  it.each(["extra_body", "extraBody"])(
    "sends %s fields through the real Responses builder",
    async (alias) => {
      const agent = { streamFn: underlying };
      applyExtraParamsToAgent(
        agent,
        {
          agents: {
            defaults: {
              models: {
                "test-proxy/test-model": {
                  params: { transport: "sse", [alias]: { use_websocket: false } },
                },
              },
            },
          },
        },
        model.provider,
        model.id,
      );
      await (
        await agent.streamFn(
          model,
          { messages: [{ role: "user", content: "Hello", timestamp: 0 }] },
          { apiKey: "test-key", transport: "sse", serviceTier: "priority" },
        )
      ).result();
      expect(sdk.requests).toHaveLength(1);
      expect(sdk.requests[0]).toMatchObject({
        model: model.id,
        stream: true,
        use_websocket: false,
        service_tier: "priority",
        input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
      });
      expect(sdk.requests[0]).not.toHaveProperty("extra_body");
      expect(sdk.requests[0]).not.toHaveProperty("extraBody");
    },
  );
  it("leaves other model requests untouched", async () => {
    const agent = { streamFn: underlying };
    applyExtraParamsToAgent(
      agent,
      {
        agents: {
          defaults: {
            models: {
              "another-proxy/test-model": { params: { extra_body: { use_websocket: false } } },
            },
          },
        },
      },
      model.provider,
      model.id,
    );
    await (
      await agent.streamFn(
        model,
        { messages: [{ role: "user", content: "Hello", timestamp: 0 }] },
        { apiKey: "test-key", transport: "sse" },
      )
    ).result();
    expect(sdk.requests).toHaveLength(1);
    expect(sdk.requests[0]).not.toHaveProperty("use_websocket");
  });
});
