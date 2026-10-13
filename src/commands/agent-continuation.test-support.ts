import path from "node:path";
import { it, expect, vi } from "vitest";
import * as attemptExecutionRuntime from "../agents/command/attempt-execution.runtime.js";
import { prepareAgentCommandExecution } from "../agents/command/prepare.js";
import { LiveSessionModelSwitchError } from "../agents/live-model-switch-error.js";
import { createAgentRunRestartAbortError } from "../agents/run-termination.js";
import { bindNativeCompletionOwner } from "../agents/subagents/announce/subagent-announce-handoff.js";
import { patchSessionEntryCore, loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { applyModelOverrideToSessionEntry } from "../sessions/model-overrides.js";
import { createDefaultAgentResult, writeSessionStoreSeed } from "./agent-session.test-support.js";
import { agentCommand } from "./agent.js";

export function registerContinuationModelCommandTests({
  withTempHome,
  mockConfig,
  runtime,
  expectLastRunProviderModel,
}: {
  withTempHome: <T>(fn: (home: string) => Promise<T>) => Promise<T>;
  mockConfig: (
    home: string,
    storePath: string,
    overrides?: Partial<NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>>,
  ) => OpenClawConfig;
  runtime: RuntimeEnv;
  expectLastRunProviderModel: (provider: string, model: string) => void;
}) {
  it.each(["main_session_restart_recovery", "subagent_settle"])(
    "inherits a parent model through real command preparation for %s",
    async (sourceTool) => {
      await withTempHome(async (home) => {
        const store = path.join(home, "sessions.json");
        const parentKey = "agent:main:telegram:direct:42";
        const sessionKey = `${parentKey}:thread:42:7`;
        mockConfig(home, store, {
          models: {
            "anthropic/claude-opus-4-6": {},
            "openai/gpt-4.1-mini": {},
          },
        });
        await writeSessionStoreSeed(store, {
          [parentKey]: {
            sessionId: "parent-model-session",
            updatedAt: Date.now(),
            providerOverride: "openai",
            modelOverride: "gpt-4.1-mini",
            modelOverrideSource: "user",
            modelOverrideRouteResolution: "resolved",
          },
          [sessionKey]: {
            sessionId: "thread-model-session",
            updatedAt: Date.now(),
          },
        });

        await agentCommand(
          {
            message: "Continue the existing task",
            sessionKey,
            inputProvenance: { kind: "internal_system", sourceSessionKey: sessionKey, sourceTool },
          },
          runtime,
        );

        expectLastRunProviderModel("openai", "gpt-4.1-mini");
        const child = loadSessionEntry({ storePath: store, sessionKey });
        expect(child?.providerOverride).toBeUndefined();
        expect(child?.modelOverride).toBeUndefined();
      });
    },
  );

  it("retains one-turn primary/options across restart, without fixing a fallback as the next primary", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const sessionKey = "agent:main:continuation-integration";
      mockConfig(home, store, {
        models: { "anthropic/claude-opus-4-6": {}, "openai/gpt-4.1-mini": {} },
      });
      await writeSessionStoreSeed(store, {
        [sessionKey]: { sessionId: "continuation-session", updatedAt: Date.now() },
      });
      let interrupt = true;
      const captured: SessionEntry[] = [];
      const attempt = vi
        .spyOn(attemptExecutionRuntime, "runAgentAttempt")
        .mockImplementation(async (params) => {
          await patchSessionEntryCore({ agentId: "main", sessionKey, storePath: store }, () => ({
            activeWriterRunId: params.runId,
          }));
          await params.preparedRunAdmission.admit("embedded");
          captured.push(loadSessionEntry({ sessionKey, storePath: store }) as SessionEntry);
          if (interrupt) {
            interrupt = false;
            throw createAgentRunRestartAbortError();
          }
          return {
            payloads: [{ text: "ok" }],
            meta: {
              durationMs: 1,
              agentMeta: {
                sessionId: params.sessionId,
                provider: "anthropic",
                model: "claude-opus-4-6",
              },
            },
          };
        });
      try {
        await expect(
          agentCommand(
            {
              message: "Use one-turn model",
              sessionKey,
              runId: "interrupted-turn",
              provider: "openai",
              model: "gpt-4.1-mini",
              allowModelOverride: true,
              thinking: "low",
              fastMode: true,
              modelFallbacksOverride: ["anthropic/claude-opus-4-6"],
            },
            runtime,
          ),
        ).rejects.toThrow();
        const interrupted = loadSessionEntry({ sessionKey, storePath: store }) as SessionEntry;
        expect(interrupted.continuationModelSelection).toMatchObject({
          provider: "openai",
          model: "gpt-4.1-mini",
          runId: "interrupted-turn",
          thinking: "low",
          fastMode: true,
          fallbacks: ["anthropic/claude-opus-4-6"],
        });
        await agentCommand(
          {
            message: "Resume",
            sessionKey,
            runId: "recovery-turn",
            mainRestartRecoveryAdmitted: true,
          },
          runtime,
        );
        expect(attempt.mock.calls.at(-1)?.[0]).toMatchObject({
          providerOverride: "openai",
          modelOverride: "gpt-4.1-mini",
          fastMode: true,
          resolvedThinkLevel: "low",
        });
        expect(captured.at(-1)?.continuationModelSelection).toMatchObject({
          runId: "interrupted-turn",
          ownerRunId: "recovery-turn",
          provider: "openai",
          model: "gpt-4.1-mini",
        });
        expect(
          (loadSessionEntry({ sessionKey, storePath: store }) as SessionEntry)
            .continuationModelSelection,
        ).toBeUndefined();
        await agentCommand(
          { message: "Ordinary next message", sessionKey, runId: "next-turn" },
          runtime,
        );
        expect(attempt.mock.calls.at(-1)?.[0]).toMatchObject({
          providerOverride: "anthropic",
          modelOverride: "claude-opus-4-6",
        });
      } finally {
        attempt.mockRestore();
      }
    });
  });

  it.each([
    { isDefault: false, native: false },
    { isDefault: true, native: false },
    { isDefault: false, native: true },
    { isDefault: true, native: true },
  ])(
    "continues after a real durable live switch from a recovery primary (Default=$isDefault, native=$native)",
    async ({ isDefault, native }) => {
      await withTempHome(async (home) => {
        const storePath = path.join(home, "sessions.json");
        const sessionKey = "agent:main:live-switch-continuation";
        mockConfig(home, storePath, {
          models: { "anthropic/claude-opus-4-6": {}, "openai/gpt-4.1-mini": {} },
        });
        const selection = {
          runId: "source-turn",
          ownerRunId: "source-turn",
          sessionId: "live-switch-session",
          provider: "openai",
          model: "gpt-4.1-mini",
          thinking: "low" as const,
          fastMode: true,
        };
        await writeSessionStoreSeed(storePath, {
          [sessionKey]: {
            sessionId: selection.sessionId,
            updatedAt: Date.now(),
            continuationModelSelection: selection,
            restartRecoveryDeliverySourceRunId: "source-turn",
          },
        });
        const handoff = native
          ? bindNativeCompletionOwner(
              {
                kind: "subagent-completion",
                sourceSessionKey: "agent:main:subagent:live-child",
                targetSessionKey: sessionKey,
                targetSessionId: selection.sessionId,
                provider: "anthropic",
                model: "claude-opus-4-6",
                modelSelection: selection,
                settleBatch: {
                  sourceSessionKeys: ["agent:main:subagent:live-child"],
                  isCurrent: () => true,
                },
              },
              () => true,
            )
          : undefined;
        let switched = false;
        const attempt = vi
          .spyOn(attemptExecutionRuntime, "runAgentAttempt")
          .mockImplementation(async (params) => {
            await patchSessionEntryCore({ sessionKey, storePath }, () => ({
              activeWriterRunId: params.runId,
            }));
            await params.preparedRunAdmission.admit("embedded");
            if (!switched) {
              switched = true;
              await patchSessionEntryCore({ sessionKey, storePath }, (entry) => {
                applyModelOverrideToSessionEntry({
                  entry,
                  selection: { provider: "anthropic", model: "claude-opus-4-6", isDefault },
                  explicitDefaultSelection: isDefault,
                });
                return entry;
              });
              throw new LiveSessionModelSwitchError({
                provider: "anthropic",
                model: "claude-opus-4-6",
              });
            }
            expect(params).toMatchObject({
              providerOverride: "anthropic",
              modelOverride: "claude-opus-4-6",
            });
            const entry = loadSessionEntry({ sessionKey, storePath }) as SessionEntry;
            expect(entry.continuationModelSelection).toMatchObject({
              provider: "anthropic",
              model: "claude-opus-4-6",
            });
            if (handoff) {
              expect(params.opts.trustedInternalHandoff).toBe(handoff);
              expect(handoff).toMatchObject({ provider: "anthropic", model: "claude-opus-4-6" });
            }
            return createDefaultAgentResult({ sessionId: params.sessionId });
          });
        try {
          await agentCommand(
            {
              message: "Resume",
              sessionKey,
              runId: "resume-owner",
              ...(handoff
                ? {
                    trustedInternalHandoff: handoff,
                    inputProvenance: {
                      kind: "inter_session" as const,
                      sourceTool: "subagent_settle",
                      sourceSessionKey: handoff.sourceSessionKey,
                    },
                    preserveUserFacingSessionModelState: true,
                  }
                : { mainRestartRecoveryAdmitted: true }),
            },
            runtime,
          );
        } finally {
          attempt.mockRestore();
        }
      });
    },
  );

  it("keeps native settle private custody when public model state is preserved", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      const sessionKey = "agent:main:private-custody";
      mockConfig(home, storePath, {
        models: { "anthropic/claude-opus-4-6": {}, "openai/gpt-4.1-mini": {} },
      });
      const selection = {
        runId: "source-turn",
        sessionId: "custody-session",
        provider: "openai",
        model: "gpt-4.1-mini",
      };
      await writeSessionStoreSeed(storePath, {
        [sessionKey]: {
          sessionId: selection.sessionId,
          updatedAt: Date.now(),
          modelProvider: "anthropic",
          model: "claude-opus-4-6",
        },
      });
      const handoff = bindNativeCompletionOwner(
        {
          kind: "subagent-completion",
          sourceSessionKey: "agent:main:subagent:child",
          targetSessionKey: sessionKey,
          targetSessionId: selection.sessionId,
          provider: "anthropic",
          model: "claude-opus-4-6",
          modelSelection: selection,
          settleBatch: { sourceSessionKeys: ["agent:main:subagent:child"], isCurrent: () => true },
        },
        () => true,
      );
      const attempt = vi
        .spyOn(attemptExecutionRuntime, "runAgentAttempt")
        .mockImplementation(async (params) => {
          await patchSessionEntryCore({ sessionKey, storePath }, () => ({
            activeWriterRunId: params.runId,
          }));
          await params.preparedRunAdmission.admit("embedded");
          const saved = loadSessionEntry({ sessionKey, storePath }) as SessionEntry;
          expect(saved).toMatchObject({
            modelProvider: "anthropic",
            model: "claude-opus-4-6",
            continuationModelSelection: {
              runId: "source-turn",
              ownerRunId: "settle-successor",
              provider: "openai",
              model: "gpt-4.1-mini",
            },
          });
          expect(params.opts.trustedInternalHandoff).toBe(handoff);
          expect(handoff).toMatchObject({ provider: "openai", model: "gpt-4.1-mini" });
          throw createAgentRunRestartAbortError();
        });
      try {
        await expect(
          agentCommand(
            {
              message: "Settle",
              sessionKey,
              runId: "settle-successor",
              trustedInternalHandoff: handoff,
              inputProvenance: {
                kind: "inter_session",
                sourceTool: "subagent_settle",
                sourceSessionKey: handoff.sourceSessionKey,
              },
              preserveUserFacingSessionModelState: true,
            },
            runtime,
          ),
        ).rejects.toThrow();
      } finally {
        attempt.mockRestore();
      }
      expect(
        (loadSessionEntry({ sessionKey, storePath }) as SessionEntry).continuationModelSelection
          ?.ownerRunId,
      ).toBe("settle-successor");
    });
  });
  it("borrows session lookup data without returning cached mutable store objects", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const sessionKey = "agent:main:cache-borrow";
      await writeSessionStoreSeed(store, {
        [sessionKey]: {
          sessionId: "session-cache-borrow",
          updatedAt: Date.now(),
          thinkingLevel: "low",
        },
        "agent:main:other": {
          sessionId: "session-other",
          updatedAt: Date.now(),
        },
      });
      mockConfig(home, store, { models: {} });

      const prepared = await prepareAgentCommandExecution(
        {
          message: "prepare only",
          sessionKey,
        },
        runtime,
      );
      const cached = loadSessionEntry({ storePath: store, sessionKey, clone: false });

      expect(prepared.sessionStore).not.toBe(cached);
      expect(prepared.sessionEntry).not.toBe(cached);
      expect(prepared).not.toHaveProperty("recoveryCandidateEntry");
      expect(prepared.sessionStore?.[sessionKey]).toBe(prepared.sessionEntry);
      expect(prepared.sessionStore?.["agent:main:other"]).toBeUndefined();
    });
  });
}
