import { describe, expect, it } from "vitest";
import { matchesContextOverflowMessage } from "../../../packages/ai/src/utils/overflow.js";
import { classifyEmbeddedAgentRunResultForModelFallback } from "../embedded-agent-runner/result-fallback-classifier.js";
import { runWithModelFallback } from "../model-fallback-runner.js";
import { classifyFailoverReason, classifyFailoverSignal } from "./classify.js";

const codes = ["gateway_concurrency_limit", "gateway_queue_full", "concurrency_limit_exceeded"];
describe("precise provider failure policy", () => {
  it.each(codes)("reads a structured %s code even after HTTP 200", (code) => {
    expect(
      classifyFailoverSignal({ status: 200, code, message: "Account slot unavailable" }),
    ).toEqual({ kind: "reason", reason: "rate_limit" });
  });
  it.each(codes)("preserves %s in JSON failure evidence", (code) => {
    expect(
      classifyFailoverReason(
        JSON.stringify({ error: { code, message: "Account slot unavailable" } }),
      ),
    ).toBe("rate_limit");
  });
  it("does not turn a local queue failure into provider throttling", () => {
    expect(
      classifyFailoverSignal({
        status: 200,
        code: "LOCAL_QUEUE_FAILED",
        message: "Queue operation failed",
      }),
    ).toBeNull();
  });
  it.each(["context length exceeded", "context_length_exceeded: input cannot fit"])(
    "recognizes explicit overflow in both owner scopes: %s",
    (message) => {
      expect(matchesContextOverflowMessage(message, "assistant-error")).toBe(true);
      expect(matchesContextOverflowMessage(message, "failover-explicit")).toBe(true);
    },
  );
  it.each([
    { text: "Upstream request failed", reason: "server_error" },
    { text: "LLM request failed. upstream stream idle for 3m0s", reason: "timeout" },
    {
      text: "400 tools.18.custom.input_schema.required: Input should be a valid list [trace_id=example code=30000]",
      reason: "timeout",
    },
  ])(
    "advances the configured ladder for exact provider evidence: $text",
    async ({ text, reason }) => {
      const attempted: string[] = [];
      const result = await runWithModelFallback({
        cfg: undefined,
        provider: "compatible",
        model: "primary",
        fallbacksOverride: ["compatible/secondary"],
        skipAuthProfileRuntime: true,
        run: async (_provider, model) => {
          attempted.push(model);
          return {
            meta: { durationMs: 1 },
            payloads: model === "primary" ? [{ isError: true, text }] : [{ text: "recovered" }],
          };
        },
        classifyResult: ({ provider, model, result: runResult }) =>
          classifyEmbeddedAgentRunResultForModelFallback({ provider, model, result: runResult }),
      });
      expect(attempted).toEqual(["primary", "secondary"]);
      expect(result.attempts[0]).toMatchObject({ reason, code: "embedded_error_payload" });
    },
  );
  it.each([
    "LLM request failed.",
    "exec timed out after 30 seconds",
    "tool request timeout",
    "input_schema.required: Input should be a valid list",
    "400 input_schema.required: Input should be a valid list [code=30001]",
    "400 input_schema.required: Input should be a valid list [code=300001]",
    "Upstream request failed: schema rejected",
    "upstream stream idle for 3months",
  ])("does not infer replay permission from generic or tool failure copy: %s", (text) => {
    expect(
      classifyEmbeddedAgentRunResultForModelFallback({
        provider: "compatible",
        model: "primary",
        result: { meta: { durationMs: 1 }, payloads: [{ isError: true, text }] },
      }),
    ).toBeNull();
  });
  it("keeps a precise failure terminal after outbound delivery committed", () => {
    expect(
      classifyEmbeddedAgentRunResultForModelFallback({
        provider: "compatible",
        model: "primary",
        result: {
          meta: { durationMs: 1 },
          payloads: [{ isError: true, text: "LLM request failed. upstream stream idle for 3m0s" }],
          messagingToolSentTexts: ["already delivered"],
        },
      }),
    ).toBeNull();
  });
  it("keeps explicit schema rejection ahead of transient copy", () => {
    expect(
      classifyFailoverSignal({
        status: 502,
        code: "UNKNOWN_PARAMETER",
        errorType: "invalid_request_error",
        message: "LLM request failed. upstream stream idle for 3m0s",
      }),
    ).toEqual({ kind: "reason", reason: "format" });
  });
});

describe("gateway rejection keeps upstream replay eligibility", () => {
  it.each(codes)("does not replay a rejected request from the %s code alone", (code) => {
    expect(
      classifyFailoverSignal(
        { status: 400, code, message: "400 Request rejected" },
        { providerPlugin: null },
      ),
    ).toEqual({ kind: "reason", reason: "rate_limit", sameModelRetry: false });
  });
});
