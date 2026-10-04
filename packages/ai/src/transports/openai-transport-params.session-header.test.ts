import type { Context, Model, SimpleStreamOptions } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH } from "../providers/openai-prompt-cache.js";
import {
  buildOpenAIClientHeaders,
  buildOpenAISdkRequestOptions,
} from "./openai-transport-params.js";

const codexModel = {
  id: "gpt-5.6-luna",
  provider: "openai",
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
} as Model;

const context = { messages: [] } satisfies Context;

const proxyResponsesModel = {
  id: "gpt-5.5",
  provider: "openai-proxy",
  api: "openai-responses",
  baseUrl: "https://responses-proxy.example.test/v1",
  compat: { sendSessionIdHeader: true },
} as Model;

describe("buildOpenAIClientHeaders session_id affinity header", () => {
  it.each(["short", "none"] as const)(
    "keeps custom reset-aware transport affinity with %s body caching",
    (cacheRetention) => {
      const headers = buildOpenAIClientHeaders(
        { ...proxyResponsesModel, compat: undefined },
        context,
        undefined,
        undefined,
        "canonical-session",
        cacheRetention,
        "canonical-session:reset-2",
      );
      expect(headers).toMatchObject({
        session_id: "canonical-session:reset-2",
        "x-client-request-id": "canonical-session:reset-2",
        "x-openclaw-session-id": "canonical-session:reset-2",
      });
    },
  );

  it("retains custom request identity when session_id is explicitly disabled", () => {
    const headers = buildOpenAIClientHeaders(
      { ...proxyResponsesModel, compat: { sendSessionIdHeader: false } },
      context,
      undefined,
      undefined,
      "canonical-session",
      "none",
      "reset-key",
    );
    expect(headers).not.toHaveProperty("session_id");
    expect(headers).toMatchObject({
      "x-client-request-id": "reset-key",
      "x-openclaw-session-id": "reset-key",
    });
  });

  it("preserves case-insensitive caller and model affinity overrides", () => {
    const headers = buildOpenAIClientHeaders(
      { ...proxyResponsesModel, headers: { "X-OpenClaw-Session-ID": "model-id" } },
      context,
      { SeSsIoN_Id: "caller-session" },
      { "X-Client-Request-ID": "turn-id" },
      "canonical-session",
      "none",
      "reset-key",
    );
    const normalized = new Headers(headers);
    expect(normalized.get("session_id")).toBe("caller-session");
    expect(normalized.get("x-client-request-id")).toBe("turn-id");
    expect(normalized.get("x-openclaw-session-id")).toBe("model-id");
    expect(Object.keys(headers)).toHaveLength(3);
  });

  it("clamps and cleans custom affinity while OpenCode keeps canonical session identity", () => {
    const headers = buildOpenAIClientHeaders(
      { ...proxyResponsesModel, baseUrl: "https://opencode.ai/zen/v1" },
      context,
      undefined,
      undefined,
      "canonical-session",
      "none",
      `reset\r\n${"x".repeat(100)}`,
    );
    expect(headers["x-opencode-session"]).toBe("canonical-session");
    expect(headers.session_id).not.toMatch(/[\r\n]/);
    expect(Array.from(headers.session_id ?? "").length).toBeLessThanOrEqual(64);
    expect(headers["x-client-request-id"]).toBe(headers.session_id);
    expect(headers["x-openclaw-session-id"]).toBe(headers.session_id);
  });

  it("does not invent custom transport identity without a session or reset key", () => {
    expect(buildOpenAIClientHeaders(proxyResponsesModel, context)).toEqual({});
  });

  it("clamps long internal session ids to the backend's 64-char cache key limit", () => {
    const longSessionId = `internal-session-effects-session-companion-${"a".repeat(50)}`;
    const headers = buildOpenAIClientHeaders(
      codexModel,
      context,
      undefined,
      undefined,
      longSessionId,
    );
    const sessionHeader = headers.session_id;
    expect(Array.from(sessionHeader ?? "").length).toBeLessThanOrEqual(
      OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH,
    );
    expect(sessionHeader?.startsWith("internal-session-effects-session-companion-")).toBe(true);
  });

  it.each(["short", "none"] as const)(
    "preserves a mixed-case caller header with %s retention",
    (cacheRetention) => {
      const headers = buildOpenAIClientHeaders(
        proxyResponsesModel,
        context,
        { SeSsIoN_Id: "caller-affinity" },
        undefined,
        "generated-affinity",
        cacheRetention,
      );
      expect(new Headers(headers).get("session_id")).toBe("caller-affinity");
      expect(
        Object.keys(headers).filter((name) => name.toLowerCase() === "session_id"),
      ).toHaveLength(1);
    },
  );

  it("honors an explicit native Responses session header opt-out", () => {
    const headers = buildOpenAIClientHeaders(
      { ...codexModel, compat: { sendSessionIdHeader: false } },
      context,
      undefined,
      undefined,
      "native-session-123",
    );

    expect(headers.session_id).toBeUndefined();
  });

  it("omits native generated Responses session headers when caching is disabled", () => {
    const headers = buildOpenAIClientHeaders(
      codexModel,
      context,
      undefined,
      undefined,
      "proxy-session-123",
      "none",
    );

    expect(headers.session_id).toBeUndefined();
  });
});

describe("buildOpenAISdkRequestOptions turn controls", () => {
  const model = {
    id: "gpt-5.6-luna",
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
  } as Model;

  it.each([7])("keeps SDK retries at zero for legacy maxRetries=%s", (maxRetries) => {
    const signal = new AbortController().signal;
    const options: SimpleStreamOptions = { timeoutMs: 1_234, maxRetries };

    expect(buildOpenAISdkRequestOptions(model, signal, options)).toEqual({
      signal,
      timeout: 1_234,
      maxRetries: 0,
    });
  });

  it("does not add a retry policy when the turn does not specify one", () => {
    expect(buildOpenAISdkRequestOptions(model)).toBeUndefined();
  });
});
