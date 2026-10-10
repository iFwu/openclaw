import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  createAdmittedRunOperatorAuthority,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import {
  createEmbeddedRunHandle,
  testing as embeddedTesting,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import { QuestionAnswerUnconfirmedError } from "../../agents/harness/gateway-question-dispatch.js";
import { withPreparedEmbeddedRunToolAuthority } from "../../agents/harness/tool-authority.runtime.js";
import { runReplyAgent } from "./agent-runner-run.js";
import { clearSessionQueues } from "./queue.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { beginReplyMessageInjectionTarget, replyRunRegistry } from "./reply-run-registry.js";
import { testing as replyTesting } from "./reply-run-registry.test-support.js";
import { resolveFollowupRunToolAuthorityFingerprint } from "./reply-tool-authority.js";
import { createMockTypingController } from "./test-helpers.js";

vi.mock("./followup-runner.js", () => ({ createFollowupRunner: () => vi.fn(async () => {}) }));

const keys: string[] = [];

afterEach(() => {
  clearSessionQueues(keys.splice(0));
  embeddedTesting.resetActiveEmbeddedRuns();
  replyTesting.resetReplyRunRegistry();
  vi.restoreAllMocks();
});

describe("channel steering into an admitted direct command", () => {
  it.each([
    {
      terminalHistory: false,
      authenticated: false,
      writable: false,
      uncertain: false,
      expiredTarget: false,
    },
    {
      terminalHistory: true,
      authenticated: false,
      writable: false,
      uncertain: false,
      expiredTarget: false,
    },
    {
      terminalHistory: true,
      authenticated: true,
      writable: true,
      uncertain: false,
      expiredTarget: false,
    },
    {
      terminalHistory: true,
      authenticated: true,
      writable: false,
      uncertain: false,
      expiredTarget: false,
    },
    {
      terminalHistory: true,
      authenticated: true,
      writable: true,
      uncertain: true,
      expiredTarget: false,
    },
    {
      terminalHistory: true,
      authenticated: true,
      writable: true,
      uncertain: false,
      expiredTarget: true,
    },
  ])(
    "admits Telegram input to a direct command (terminal=$terminalHistory, authenticated=$authenticated, writable=$writable, uncertain=$uncertain, expiredTarget=$expiredTarget)",
    async ({ terminalHistory, authenticated, writable, uncertain, expiredTarget }) => {
      const key = `agent:main:telegram:group:direct-steering-${terminalHistory}-${authenticated}-${writable}-${uncertain}-${expiredTarget}`;
      keys.push(key);
      const run = createQueueTestRun({
        prompt: "Use the corrected requirements.",
        messageId: `telegram-correction-${terminalHistory}-${authenticated}-${writable}`,
        originatingChannel: "telegram",
        originatingTo: "synthetic-group",
        currentInboundEventKind: "user_request",
      });
      Object.assign(run.run, {
        agentId: "main",
        sessionId: `direct-steering-session-${terminalHistory}-${authenticated}-${writable}`,
        sessionKey: key,
        messageProvider: "telegram",
        senderId: "synthetic-owner",
        senderIsOwner: true,
        inputProvenance: { kind: "external_user" },
      });
      if (uncertain) {
        run.images = [{ type: "image", data: "AA==", mimeType: "image/png" }];
      }
      const sourceLifetime = new AbortController();
      if (authenticated) {
        run.operatorAuthority = createAdmittedRunOperatorAuthority({
          profileId: "synthetic-owner",
          scopes: writable ? ["operator.write"] : ["operator.read"],
          source: {},
          signal: sourceLifetime.signal,
          assertCurrent: () => {},
        });
      }
      const runId = "direct-command";
      const admission = prepareAgentRunAdmission({
        cfg: {},
        operationalRunInstance: createOperationalRunInstanceRef(runId),
        facts: {
          agentId: "main",
          runId,
          ingress: { kind: "system", state: "present", boundary: "direct-steering-test" },
        },
      });
      try {
        const admittedRunContext = await admission.admit("embedded", "direct-steering-test");
        await withPreparedEmbeddedRunToolAuthority(
          { admittedRunContext },
          {
            ...run.run,
            runId,
            modelId: run.run.model,
            sandboxSessionKey: key,
            messageChannel: "webchat",
            messageProvider: "webchat",
            inputProvenance: { kind: "inter_session", sourceTool: "sessions_send" },
          },
          undefined,
          async (prepared) => {
            const delivered: string[] = [];
            const requestYield = vi.fn((_isSourceCurrent: () => boolean) => true);
            const handle = {
              requestYieldToVisibleTurn: requestYield,
              ...createEmbeddedRunHandle({
                runId,
                toolAuthorityFingerprint: prepared.toolAuthorityFingerprint,
                supportsTranscriptCommitWait: true,
              }),
              terminalReplyExpectation: "required" as const,
              messageInjectionV2: {
                version: 2 as const,
                isAvailable: () => true,
                cancelPendingUserInput: async () => {
                  if (uncertain) {
                    throw new QuestionAnswerUnconfirmedError(
                      "Synthetic uncertain question cancellation",
                    );
                  }
                  return false;
                },
                queueMessage: vi.fn(
                  async (text: string, _options: unknown, assertCurrent: () => void) => {
                    assertCurrent();
                    delivered.push(text);
                  },
                ),
              },
            };
            setActiveEmbeddedRun(run.run.sessionId, handle, key, run.run.sessionFile);
            expect(replyRunRegistry.get(key)).toBeUndefined();
            expect(replyRunRegistry.resolveCurrentMessageInjectionTarget(key)).toMatchObject({
              runId,
              sourceTurnId: runId,
            });
            const state: ReplyOperationRunState = {};
            try {
              if (expiredTarget) {
                const target = expectDefined(
                  replyRunRegistry.resolveCurrentMessageInjectionTarget(key),
                  "captured peer target",
                );
                const correction = beginReplyMessageInjectionTarget(target, run.prompt, {
                  isInboundUserMessage: true,
                  toolAuthorityFingerprint: resolveFollowupRunToolAuthorityFingerprint(run),
                  personalToolParticipant: { operatorAuthority: run.operatorAuthority },
                });
                admission.close();
                await expect(correction.outcome).resolves.toMatchObject({
                  status: "rejected",
                  reason: "tool_authority_mismatch",
                });
                await expect(correction.acceptance).resolves.toBe(false);
                expect(requestYield).not.toHaveBeenCalled();
                return;
              }
              if (authenticated && writable && !uncertain) {
                const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(key);
                expect(target).toBeDefined();
                const statusControl = beginReplyMessageInjectionTarget(
                  expectDefined(target, "direct target"),
                  "Refresh progress only",
                  {
                    isInboundUserMessage: true,
                    allowPendingUserInputAnswer: false,
                    toolAuthorityFingerprint: resolveFollowupRunToolAuthorityFingerprint(run),
                    personalToolParticipant: { operatorAuthority: run.operatorAuthority },
                  },
                );
                await expect(statusControl.outcome).resolves.toMatchObject({ status: "rejected" });
                expect(requestYield).not.toHaveBeenCalled();
              }
              await runReplyAgent({
                commandBody: run.prompt,
                followupRun: run,
                opts: { runId: run.messageId, [REPLY_OPERATION_RUN_STATE]: state },
                queueKey: key,
                resolvedQueue: { mode: "steer", debounceMs: 0 },
                shouldSteer: true,
                shouldFollowup: true,
                isActive: true,
                typing: createMockTypingController(),
                sessionCtx: {
                  Provider: "telegram",
                  OriginatingChannel: "telegram",
                  SenderId: run.run.senderId,
                  MessageSid: run.messageId,
                },
                sessionKey: key,
                sessionEntry: {
                  sessionId: run.run.sessionId,
                  updatedAt: 1,
                  status: "running",
                  ...(terminalHistory
                    ? { restartRecoveryTerminalRunIds: ["older-finished-run"] }
                    : {}),
                },
                defaultModel: "gpt-test",
                resolvedVerboseLevel: "off",
                isNewSession: false,
                blockStreamingEnabled: false,
                resolvedBlockStreamingBreak: "text_end",
                shouldInjectGroupIntro: false,
                typingMode: "never",
              });
              expect(state.admission).toEqual(
                uncertain
                  ? { status: "skipped", reason: "question-response-indeterminate" }
                  : { status: "accepted", mode: authenticated ? "followup" : "steer" },
              );
              expect(delivered).toEqual(authenticated ? [] : [run.prompt]);
              expect(requestYield).toHaveBeenCalledTimes(
                authenticated && writable && !uncertain ? 1 : 0,
              );
              if (authenticated && writable && !uncertain) {
                const sourceCheck = requestYield.mock.calls[0]?.[0];
                expect(sourceCheck).toBeTypeOf("function");
                expect(sourceCheck?.()).toBe(true);
                sourceLifetime.abort();
                expect(sourceCheck?.()).toBe(false);
              }
            } finally {
              clearActiveEmbeddedRun(run.run.sessionId, handle, key);
            }
          },
        );
      } finally {
        admission.close();
      }
    },
  );
});
