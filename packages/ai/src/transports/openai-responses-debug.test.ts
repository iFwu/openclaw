import type { Model } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import {
  normalizeResponsesFailedEvent,
  ResponsesStreamFailure,
  summarizeResponsesPayload,
} from "./openai-responses-debug.js";
import { createWebSocketFailureDiagnostics } from "./openai-responses-websocket-diagnostics.js";

const failedEventModel = {
  provider: "openai",
  api: "openai-responses",
  id: "gpt-5.6-luna",
} as unknown as Model;

describe("OpenAI Responses payload debug summary", () => {
  it("reports compaction replay identities without exposing opaque content", () => {
    const summary = summarizeResponsesPayload({
      model: "gpt-5.6-sol",
      input: [
        { type: "message", role: "user", content: "hello" },
        {
          type: "compaction",
          id: "cmp-private-id",
          encrypted_content: "opaque-private-ciphertext",
        },
      ],
      context_management: [{ type: "compaction", compact_threshold: 700_000 }],
      service_tier: "priority",
      stream: true,
      store: true,
    });

    expect(summary).toContain("compactionItems=1");
    expect(summary).toContain("compactionInputIndexes=1");
    expect(summary).toContain("inputItems=2");
    expect(summary).toContain("inputItemShape=message:user,compaction");
    expect(summary).toMatch(/compactionIdHashes=[a-f0-9]{64}/u);
    expect(summary).toMatch(/compactionPayloadHashes=[a-f0-9]{64}/u);
    expect(summary).not.toContain("cmp-private-id");
    expect(summary).not.toContain("opaque-private-ciphertext");
  });

  it("reports an empty replay set for non-array input", () => {
    expect(summarizeResponsesPayload({ input: "hello" })).toContain(
      "compactionItems=0 compactionIdHashes=none compactionPayloadHashes=none compactionInputIndexes=none",
    );
  });
});

describe("normalizeResponsesFailedEvent", () => {
  it("preserves the structured provider error code on the failure and ResponsesStreamFailure (#117609)", () => {
    const summary = normalizeResponsesFailedEvent(
      {
        response: {
          id: "resp_failed",
          status: "failed",
          error: { code: "server_error", message: "provider failed" },
        },
      },
      failedEventModel,
    );
    // The prose message still embeds the code, but the structured code is now
    // preserved so downstream failover classification routes on it instead of
    // guessing from the prose.
    expect(summary.code).toBe("server_error");
    expect(summary.message).toBe("server_error: provider failed");
    expect(summary.responseId).toBe("resp_failed");

    const failure = new ResponsesStreamFailure(summary, undefined);
    expect(failure.code).toBe("server_error");
    expect(failure.message).toBe("server_error: provider failed");
    expect(failure.responseId).toBe("resp_failed");
  });

  it("omits code when the failed response has no error code", () => {
    const summary = normalizeResponsesFailedEvent(
      {
        response: {
          id: "resp_failed",
          status: "failed",
          error: { message: "provider failed" },
        },
      },
      failedEventModel,
    );
    expect(summary.code).toBeUndefined();
    expect(summary.message).toBe("unknown: provider failed");
  });
});

describe("WebSocket failure cause metadata", () => {
  it("keeps nested network codes but never arbitrary messages or error fields", () => {
    const inner = Object.assign(new Error("Bearer private-token https://private.example"), {
      code: "ECONNRESET",
      headers: { authorization: "private-token" },
    });
    const outer = new Error("private-prompt", { cause: inner });
    const snapshot = createWebSocketFailureDiagnostics({ reusedConnection: false }).snapshot(outer);
    expect(snapshot.causes).toEqual([
      { name: "Error", code: undefined },
      { name: "Error", code: "ECONNRESET" },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("private");
  });

  it("preserves CPR server failure code and HTTP status without the error body", () => {
    expect(
      createWebSocketFailureDiagnostics({ reusedConnection: false }).snapshot({
        name: "OpenAIResponsesWebSocketServerError",
        code: "upstream_unavailable",
        status: 502,
        message: "private upstream body",
      }).causes,
    ).toEqual([
      { name: "OpenAIResponsesWebSocketServerError", code: "upstream_unavailable", status: 502 },
    ]);
  });

  it("bounds cyclic causes and treats peer supplied names/codes as untrusted", () => {
    const error: Record<string, unknown> = { name: "private-name", code: "private-code" };
    error.cause = error;
    const snapshot = createWebSocketFailureDiagnostics({ reusedConnection: false }).snapshot(error);
    expect(snapshot.causes).toEqual([{ name: "other", code: "other" }]);
  });
});

describe("bounded WebSocket failure observations", () => {
  it("hashes identifiers and replaces arbitrary event names and free-form close reasons", () => {
    const diagnostics = createWebSocketFailureDiagnostics({
      sessionId: "private-session",
      previousResponseId: "private-previous",
      reusedConnection: true,
      connectionCreatedAt: Date.now() - 50,
    });
    diagnostics.observe({
      type: "message",
      message: {
        type: "private-event",
        response: { id: "private-response" },
        delta: "private-output",
      },
    });
    diagnostics.observe({ type: "close", code: 1006, reason: "private-reason" });
    const snapshot = diagnostics.snapshot(new Error("private-error"));
    expect(snapshot).toMatchObject({
      lastEvent: "other",
      responseObserved: true,
      eventsReceived: 1,
      closeCode: 1006,
      closeReasonPresent: true,
      reusedConnection: true,
    });
    expect(snapshot.sessionIdHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(snapshot.previousResponseIdHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(snapshot.responseIdHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(snapshot)).not.toContain("private");
  });
  it.each([Number.NaN, Infinity, 99, 5000, 1006.5])(
    "does not retain a malformed close code %s",
    (code) => {
      const diagnostics = createWebSocketFailureDiagnostics({ reusedConnection: false });
      diagnostics.observe({ type: "close", code });
      expect(diagnostics.snapshot(undefined).closeCode).toBeUndefined();
    },
  );
  it("bounds nested causes at four and admits only integral HTTP status", () => {
    const cause = { name: "Error", code: "ECONNRESET", status: 502 };
    const nested = {
      name: "Error",
      status: 502.5,
      cause: { name: "Error", cause: { name: "Error", cause: { name: "Error", cause } } },
    };
    const summary = createWebSocketFailureDiagnostics({ reusedConnection: false }).snapshot(nested);
    expect(summary.causes).toHaveLength(4);
    expect(JSON.stringify(summary.causes)).not.toContain("502");
  });
});
