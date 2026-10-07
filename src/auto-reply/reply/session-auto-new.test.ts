import { describe, expect, it, vi } from "vitest";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import { buildGetReplyGroupCtx } from "./get-reply.test-fixtures.js";
import {
  evaluateJevSessionDependency,
  isSessionAutoNewCandidateCurrent,
  prepareSessionAutoNewCandidate,
  testing as sessionAutoNewTesting,
  type SessionAutoNewDependencies,
} from "./session-auto-new.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("evaluateJevSessionDependency", () => {
  it.each([
    { probability: 0.9, expected: "continue" },
    { probability: 0.5, expected: "uncertain" },
    { probability: 0.1, expected: "new" },
    { probability: 0.8, expected: "continue" },
    { probability: 0.2, expected: "new" },
  ] as const)("maps probability $probability to $expected", async ({ probability, expected }) => {
    const fetchFn = vi.fn<typeof globalThis.fetch>(async () =>
      response({
        model: "jev-1.13.0",
        answers: { dependsOnPreviousTask: { type: "noul", noul: probability } },
      }),
    );

    await expect(
      evaluateJevSessionDependency({ apiKey: "test-key", state: "{}", fetchFn }),
    ).resolves.toBe(expected);

    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.typesafe.ai/v1/systemone",
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
          "content-type": "application/json",
        },
      }),
    );
    const body = fetchFn.mock.calls[0]?.[1]?.body;
    if (typeof body !== "string") {
      throw new Error("Expected a JSON request body string");
    }
    const request = JSON.parse(body);
    expect(request).toMatchObject({
      model: "jev-1.13.0",
      state: {},
      questions: { dependsOnPreviousTask: { type: "noul" } },
    });
  });

  it.each([
    { name: "HTTP error", fetchFn: async () => response({}, 503) },
    { name: "malformed answer", fetchFn: async () => response({ answers: {} }) },
    {
      name: "transport error",
      fetchFn: async () => {
        throw new Error("offline");
      },
    },
  ])("continues conservatively on $name", async ({ fetchFn }) => {
    await expect(
      evaluateJevSessionDependency({ apiKey: "test-key", state: "{}", fetchFn }),
    ).resolves.toBe("uncertain");
  });

  it("returns uncertain for an already-aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      evaluateJevSessionDependency({
        apiKey: "test-key",
        state: "{}",
        signal: controller.signal,
        fetchFn: vi.fn(async () => {
          throw new Error("aborted");
        }),
      }),
    ).resolves.toBe("uncertain");
  });
  it.each([
    { model: "other-model", answers: { dependsOnPreviousTask: { type: "noul", noul: 0.1 } } },
    { model: "jev-1.13.0", answers: { dependsOnPreviousTask: { type: "noul", noul: -0.1 } } },
    { model: "jev-1.13.0", answers: { dependsOnPreviousTask: { type: "noul", noul: 1.1 } } },
    { model: "jev-1.13.0", answers: { dependsOnPreviousTask: { type: "noul", noul: "0.1" } } },
  ])("rejects an unexpected model or invalid probability", async (body) => {
    await expect(
      evaluateJevSessionDependency({
        apiKey: "test-key",
        state: "{}",
        fetchFn: async () => response(body),
      }),
    ).resolves.toBe("uncertain");
  });

  it("rejects malformed JSON and responses exceeding the byte limit", async () => {
    for (const body of ["{invalid", "x".repeat(65_537)]) {
      await expect(
        evaluateJevSessionDependency({
          apiKey: "test-key",
          state: "{}",
          fetchFn: async () => new Response(body),
        }),
      ).resolves.toBe("uncertain");
    }
  });

  it("does not transmit its credential in conversation state", async () => {
    const fetchFn = vi.fn();
    await expect(
      evaluateJevSessionDependency({
        apiKey: "test-key",
        state: "message contains test-key",
        fetchFn,
      }),
    ).resolves.toBe("uncertain");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("Jev evaluation diagnostics", () => {
  it.each([
    { body: null, classification: "malformed_response" },
    { body: 42, classification: "malformed_response" },
    { body: { model: "wrong" }, classification: "malformed_response" },
  ])(
    "classifies malformed schemas without logging response bodies",
    async ({ body, classification }) => {
      const logger = { info: vi.fn(), warn: vi.fn() };
      await expect(
        evaluateJevSessionDependency({
          apiKey: "synthetic-jev-key",
          state: "{}",
          logger,
          fetchFn: async () => response(body),
        }),
      ).resolves.toBe("uncertain");
      expect(logger.warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ classification }),
      );
    },
  );

  it("distinguishes HTTP failure and masks untrusted exception names", async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    await evaluateJevSessionDependency({
      apiKey: "synthetic-jev-key",
      state: "{}",
      logger,
      fetchFn: async () => response({ private: "PRIVATE_RESPONSE" }, 503),
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ classification: "http_error", status: 503 }),
    );
    await evaluateJevSessionDependency({
      apiKey: "synthetic-jev-key",
      state: "{}",
      logger,
      fetchFn: async () => {
        const e = new Error("PRIVATE_EXCEPTION");
        e.name = "PRIVATE_NAME";
        throw e;
      },
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ classification: "network_error", errorName: "Error" }),
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/PRIVATE_|synthetic-jev-key/);
  });

  it("distinguishes the evaluator timeout from an external abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const logger = { info: vi.fn(), warn: vi.fn() };
    try {
      await evaluateJevSessionDependency({
        apiKey: "synthetic-jev-key",
        state: "{}",
        logger,
        fetchFn: async () => {
          throw new Error("private failure");
        },
      });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ classification: "timeout" }),
      );
    } finally {
      timeout.mockRestore();
    }
  });
});

describe("prepareSessionAutoNewCandidate", () => {
  const entry: SessionEntry = {
    sessionId: "session-1",
    lifecycleRevision: "revision-1",
    updatedAt: 1,
  };

  function dependencies(
    overrides: Partial<SessionAutoNewDependencies> = {},
  ): SessionAutoNewDependencies {
    return {
      apiKey: () => "test-key",
      evaluate: vi.fn<SessionAutoNewDependencies["evaluate"]>(async () => "new"),
      hasActiveWork: () => false,
      hasPendingApproval: async () => false,
      hasPendingQuestion: async () => false,
      hasPendingChildWork: async () => false,
      readRecentConversation: async () => [
        { id: "old-user", role: "user", text: "Fix the notification task" },
        { id: "old-assistant", role: "assistant", text: "The notification fix is complete" },
      ],
      ...overrides,
    };
  }

  function context(overrides: Parameters<typeof buildGetReplyGroupCtx>[0] = {}) {
    return buildGetReplyGroupCtx({
      AutoNewSession: "jev",
      InboundEventKind: "user_request",
      Body: "Draft a daily report",
      RawBody: "Draft a daily report",
      CommandBody: "Draft a daily report",
      BodyForCommands: "Draft a daily report",
      MessageSid: "current-message",
      ...overrides,
    });
  }

  it("protects native pending questions until the actual owner releases them", async () => {
    const { registerPendingAgentQuestion } =
      await import("../../agents/harness/gateway-question.js");
    const deps = dependencies();
    sessionAutoNewTesting.setDependencies({
      apiKey: deps.apiKey,
      evaluate: deps.evaluate,
      hasActiveWork: deps.hasActiveWork,
      hasPendingApproval: deps.hasPendingApproval,
      hasPendingChildWork: deps.hasPendingChildWork,
      readRecentConversation: deps.readRecentConversation,
    });
    const params = {
      agentId: "main",
      ctx: context(),
      entry,
      sessionKey: "agent:main:telegram:group:-100123",
      storePath: "/tmp/isolated-test.sqlite",
    };
    const pending = registerPendingAgentQuestion({
      sessionKey: params.sessionKey,
      questionId: "auto-new-protection",
      questions: [],
    });
    try {
      await expect(prepareSessionAutoNewCandidate(params)).resolves.toBeUndefined();
      expect(deps.evaluate).not.toHaveBeenCalled();
      pending.dispose();
      await expect(prepareSessionAutoNewCandidate(params)).resolves.toMatchObject({
        sessionKey: params.sessionKey,
        sessionId: entry.sessionId,
      });
      expect(deps.evaluate).toHaveBeenCalledOnce();
    } finally {
      pending.dispose();
      sessionAutoNewTesting.setDependencies();
    }
  });

  it("sends dated history and the real conversation gap through the HTTP evaluator", async () => {
    const now = Date.parse("2026-09-28T06:29:00Z");
    const gap = 6 * 86_400_000;
    const logger = { info: vi.fn(), warn: vi.fn() };
    const fetchFn = vi.fn<typeof globalThis.fetch>(async () =>
      response({
        model: "jev-1.13.0",
        answers: { dependsOnPreviousTask: { type: "noul", noul: 0.1 } },
      }),
    );
    const deps = dependencies({
      logger,
      now: () => now + 1_000,
      evaluate: (params) => evaluateJevSessionDependency({ ...params, fetchFn }),
      readRecentConversation: async () => [
        { role: "user", text: "Finish the old maintenance task", timestampMs: now - gap - 1000 },
        { role: "assistant", text: "Old task complete", timestampMs: now - gap },
      ],
    });
    const candidate = await prepareSessionAutoNewCandidate(
      {
        agentId: "main",
        ctx: context({ Timestamp: now }),
        entry: { ...entry, lastInteractionAt: now + 200, updatedAt: now + 200 },
        sessionKey: "agent:main:telegram:group:-100123",
        storePath: "/tmp/isolated-test.sqlite",
      },
      deps,
    );
    expect(candidate).toBeDefined();
    const body = fetchFn.mock.calls[0]?.[1]?.body;
    if (typeof body !== "string") {
      throw new Error("Expected a JSON request body string");
    }
    const request = JSON.parse(body);
    expect(request.state).toMatchObject({
      currentMessageAtMs: now,
      priorInteractionGapMs: gap,
      currentSessionTaskHistory: [
        { role: "user", atMs: now - gap - 1000 },
        { role: "assistant", atMs: now - gap },
      ],
    });
    expect(request.questions.dependsOnPreviousTask.instructions).toContain("not a rule");
    expect(logger.info).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        classification: "decision",
        decision: "new",
        probability: 0.1,
        messageId: "current-message",
      }),
    );
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("Finish the old maintenance task");
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("test-key");
  });

  it.each(["missing-current", "same-second", "future", "invalid"])(
    "does not invent a gap for %s timestamps",
    async (kind) => {
      const now = Date.parse("2026-09-28T06:29:00Z");
      const timestampMs =
        kind === "same-second" ? now : kind === "future" ? now + 1000 : Number.NaN;
      const deps = dependencies({
        now: () => now + 2000,
        logger: { info: vi.fn(), warn: vi.fn() },
        readRecentConversation: async () => [
          { role: "user", text: "old task", timestampMs },
          { role: "assistant", text: "done", timestampMs },
        ],
      });
      await prepareSessionAutoNewCandidate(
        {
          agentId: "main",
          ctx: context({ Timestamp: kind === "missing-current" ? undefined : now }),
          entry,
          sessionKey: "agent:main:test",
          storePath: "/tmp/isolated-test.sqlite",
        },
        deps,
      );
      const state = JSON.parse(vi.mocked(deps.evaluate).mock.calls[0]![0].state);
      expect(state).not.toHaveProperty("priorInteractionGapMs");
    },
  );

  it.each([
    { reason: "active_work", changes: { hasActiveWork: () => true } },
    { reason: "credential_unavailable", changes: { apiKey: () => undefined } },
    { reason: "pending_interaction", changes: { hasPendingApproval: async () => true } },
    { reason: "pending_interaction", changes: { hasPendingQuestion: async () => true } },
    { reason: "pending_interaction", changes: { hasPendingChildWork: async () => true } },
  ])("logs a safe $reason without calling the evaluator", async ({ reason, changes }) => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const deps = dependencies({ ...changes, logger });
    await prepareSessionAutoNewCandidate(
      {
        agentId: "main",
        ctx: context(),
        entry,
        sessionKey: "agent:main:test",
        storePath: "/tmp/isolated-test.sqlite",
      },
      deps,
    );
    expect(deps.evaluate).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason, messageId: "current-message" }),
    );
  });

  it("stays silent for opt-out messages and survives a throwing diagnostics sink", async () => {
    const logger = {
      info: vi.fn(() => {
        throw new Error("logger offline");
      }),
      warn: vi.fn(),
    };
    const deps = dependencies({ logger });
    const params = {
      agentId: "main",
      entry,
      sessionKey: "agent:main:test",
      storePath: "/tmp/isolated-test.sqlite",
    };
    await prepareSessionAutoNewCandidate(
      { ...params, ctx: context({ AutoNewSession: undefined }) },
      deps,
    );
    expect(logger.info).not.toHaveBeenCalled();
    await expect(
      prepareSessionAutoNewCandidate({ ...params, ctx: context() }, deps),
    ).resolves.toBeDefined();
  });

  it("returns an identity-bound candidate only for a confident independent task", async () => {
    const deps = dependencies();
    const candidate = await prepareSessionAutoNewCandidate(
      {
        agentId: "main",
        ctx: context({
          ReplyToBody: "Earlier reference",
          InboundHistory: [{ sender: "Alice", body: "Recent room message" }],
        }),
        entry,
        sessionKey: "agent:main:telegram:group:-100123",
        storePath: "/tmp/isolated-test.sqlite",
      },
      deps,
    );

    expect(candidate).toEqual({
      sessionKey: "agent:main:telegram:group:-100123",
      sessionId: "session-1",
      lifecycleRevision: "revision-1",
    });
    expect(deps.evaluate).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.evaluate).mock.calls[0]?.[0].state).toContain(
      '"currentMessage":"Draft a daily report"',
    );
  });

  it("keeps oversized Jev state valid JSON after applying bounds", async () => {
    const states: string[] = [];
    const deps = dependencies({
      evaluate: vi.fn<SessionAutoNewDependencies["evaluate"]>(async ({ state }) => {
        states.push(state);
        return "continue";
      }),
      readRecentConversation: async () =>
        Array.from({ length: 6 }, (_, index) => ({
          role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
          text: "history ".repeat(1_000),
          timestampMs: 1_000 + index,
        })),
    });
    await prepareSessionAutoNewCandidate(
      {
        agentId: "main",
        ctx: context({
          Timestamp: 10_000,
          Body: "current ".repeat(1_000),
          RawBody: "current ".repeat(1_000),
          InboundHistory: Array.from({ length: 4 }, () => ({
            sender: "sender ".repeat(1_000),
            body: "room ".repeat(1_000),
          })),
        }),
        entry,
        sessionKey: "agent:main:telegram:group:-100123",
        storePath: "/tmp/isolated-test.sqlite",
      },
      deps,
    );
    expect(states).toHaveLength(1);
    expect(states[0]?.length).toBeLessThanOrEqual(16_000);
    expect(() => JSON.parse(states[0] ?? "")).not.toThrow();
    expect(JSON.parse(states[0]!)).toMatchObject({
      currentMessageAtMs: 10_000,
      priorInteractionGapMs: 8_995,
    });
    expect(
      JSON.parse(states[0]!).currentSessionTaskHistory.every(
        (row: { atMs?: number }) => row.atMs !== undefined,
      ),
    ).toBe(true);
  });

  it.each([
    { name: "not opted in", ctx: { AutoNewSession: undefined } },
    { name: "command", ctx: { CommandSource: "text" } },
    { name: "bot sender", ctx: { SenderIsBot: true } },
    { name: "automation", ctx: { InternalTurnSource: "cron" } },
  ] as const)("skips $name", async ({ ctx }) => {
    const deps = dependencies();
    await expect(
      prepareSessionAutoNewCandidate(
        {
          agentId: "main",
          ctx: context(ctx),
          entry,
          sessionKey: "agent:main:telegram:group:-100123",
          storePath: "/tmp/isolated-test.sqlite",
        },
        deps,
      ),
    ).resolves.toBeUndefined();
    expect(deps.evaluate).not.toHaveBeenCalled();
  });

  it.each([
    { name: "active work", overrides: { hasActiveWork: () => true } },
    { name: "pending approval", overrides: { hasPendingApproval: async () => true } },
    { name: "pending question", overrides: { hasPendingQuestion: async () => true } },
    { name: "pending child work", overrides: { hasPendingChildWork: async () => true } },
    {
      name: "unreadable credential file",
      overrides: {
        apiKey: async () => {
          throw new Error("unreadable");
        },
      },
    },
  ])("protects $name", async ({ overrides }) => {
    const deps = dependencies(overrides);
    await expect(
      prepareSessionAutoNewCandidate(
        {
          agentId: "main",
          ctx: context(),
          entry,
          sessionKey: "agent:main:telegram:group:-100123",
          storePath: "/tmp/isolated-test.sqlite",
        },
        deps,
      ),
    ).resolves.toBeUndefined();
  });

  it.each(["queued", "running"] as const)("protects an unowned %s session", async (status) => {
    const deps = dependencies();
    await expect(
      prepareSessionAutoNewCandidate(
        {
          agentId: "main",
          ctx: context(),
          entry: { ...entry, status },
          sessionKey: "agent:main:telegram:group:-100123",
          storePath: "/tmp/isolated-test.sqlite",
        },
        deps,
      ),
    ).resolves.toBeUndefined();
    expect(deps.evaluate).not.toHaveBeenCalled();
  });

  it("skips evaluation when escaped history exceeds the final byte bound", async () => {
    const deps = dependencies({
      readRecentConversation: async () => [
        { role: "user", text: "\u0001".repeat(2_000) },
        { role: "assistant", text: "\u0001".repeat(2_000) },
      ],
    });
    await expect(
      prepareSessionAutoNewCandidate(
        {
          agentId: "main",
          ctx: context(),
          entry,
          sessionKey: "agent:main:telegram:group:-100123",
          storePath: "/tmp/isolated-test.sqlite",
        },
        deps,
      ),
    ).resolves.toBeUndefined();
    expect(deps.evaluate).not.toHaveBeenCalled();
  });

  it("invalidates a candidate when the lifecycle generation changes", () => {
    expect(
      isSessionAutoNewCandidateCurrent({
        candidate: {
          sessionKey: "agent:main:telegram:group:-100123",
          sessionId: "session-1",
          lifecycleRevision: "revision-1",
        },
        entry: { ...entry, lifecycleRevision: "revision-2" },
        sessionKey: "agent:main:telegram:group:-100123",
        storePath: "/tmp/isolated-test.sqlite",
      }),
    ).toBe(false);
  });
});
