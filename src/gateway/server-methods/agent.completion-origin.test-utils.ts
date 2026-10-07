import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareAgentCommandExecutionIdentity } from "../../agents/agent-command-execution-identity.js";
import type { AgentCommandGatewayIngressOpts } from "../../agents/command/types.js";
import { withPreparedEmbeddedGatewayTools } from "../../agents/embedded-agent-runner/run/attempt-gateway-tools.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import {
  mintAgentRuntimeIdentityToken,
  verifyAgentRuntimeIdentityToken,
} from "../agent-runtime-identity-token.js";
import { createGatewayMethodRegistry } from "../methods/registry.js";
import { agentHandlers } from "./agent.js";
import {
  describe1AfterEach1,
  describe1BeforeEach0,
  getAgentTestMocks,
  backendGatewayClient,
  invokeAgent,
  buildExistingMainStoreEntry,
  makeContext,
  prime,
  waitForAssertion,
} from "./agent.test-harness.js";

// Imported by agent.test.ts; preserve its native runtime and isolated state owners.
describe("gateway agent completion approval origin", () => {
  beforeEach(describe1BeforeEach0);
  afterEach(describe1AfterEach1);

  it("preserves frozen parent approval origin through retained native completion custody after foreground ends", async () => {
    // Consumer boundary only: no spawn launch or requester-settle producer is exercised.
    const { subagentRuns } =
      await import("../../agents/subagents/registry/subagent-registry-memory.js");
    const { createInternalAgentTurnFacade } = await import("../agent-turn/internal-facade.js");
    const { captureGatewayOperatorRunAuthority } = await import("../operator-run-authority.js");
    const { captureOperatorToolGatewayContinuationContext, withOperatorToolGatewayAuthority } =
      await import("../server-plugin-in-process-dispatch.js");
    const { createOperatorClient } =
      await import("../server-plugin-in-process-dispatch.test-support.js");
    const { runAnnounceAgentCall } =
      await import("../../agents/subagents/announce/subagent-announce-completion-delivery.js");
    const { isNativeCompletionOwnerForRun } =
      await import("../../agents/subagents/announce/subagent-announce-handoff.js");
    const { getAdmittedRunDelegatedAuthority } =
      await import("../../agents/admitted-run-context.js");
    prime();
    const mocks = getAgentTestMocks();
    const sessionKey = "agent:main:requester";
    const sessionId = "existing-session-id";
    const parentRunId = "frozen-origin-parent";
    const completionRunId = "frozen-origin-native-completion";
    const childSessionKey = "agent:main:subagent:frozen-origin-child";
    const childSessionId = "frozen-origin-child-session";
    // Only the parent's native inbound session fixture carries the external origin.
    const entry = buildExistingMainStoreEntry({
      sessionId,
      lifecycleRevision: "frozen-origin-requester-revision",
      delivery: normalizeSessionDeliveryState({
        context: {
          channel: "telegram",
          to: "telegram:-100200",
          accountId: "target-account",
          threadId: "7",
        },
        origin: {
          provider: "telegram",
          surface: "telegram",
          to: "telegram:-100200",
          accountId: "target-account",
          threadId: "7",
        },
      }),
    });
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: mocks.userTurnStorePath ?? "/tmp/sessions.json",
      entry,
      canonicalKey: sessionKey,
    });
    mocks.updateSessionStore.mockImplementation(
      async (_path, updater) => await updater({ [sessionKey]: entry }),
    );
    const context = makeContext();
    context.resolveGatewayContext = () => context;
    context.getGatewayMethodRegistry = () =>
      createGatewayMethodRegistry([
        {
          name: "agent",
          scope: "operator.write",
          owner: { kind: "core", area: "agents" },
          handler: expectDefined(agentHandlers.agent, "agent handler missing"),
        },
      ]);
    context.createAgentTurnFacade = (principal) =>
      createInternalAgentTurnFacade({
        ...principal,
        getContext: () => context,
        getMethodRegistry: context.getGatewayMethodRegistry,
      });
    const owner = createOperatorClient({
      profileName: "frozen-origin-parent-owner",
      scopes: ["operator.read", "operator.write"],
    });
    const source = expectDefined(
      await captureGatewayOperatorRunAuthority({ client: owner, context }),
      "real parent operator source missing",
    );
    const parentClient = {
      ...expectDefined(backendGatewayClient(), "backend client missing"),
      authenticatedUserId: owner.authenticatedUserId,
      authenticatedUserProfile: owner.authenticatedUserProfile,
      internal: { operatorRunAuthority: source.authority },
    };
    const record: import("../../agents/subagents/registry/subagent-registry.types.js").SubagentRunRecord =
      {
        runId: "frozen-origin-child-run",
        childSessionKey,
        requesterSessionKey: sessionKey,
        requesterDisplayKey: sessionKey,
        requesterAgentId: "main",
        task: "Return a retained child result",
        cleanup: "keep",
        createdAt: Date.now(),
        generation: 1,
        execution: { status: "terminal", outcome: { status: "ok" } },
        completion: { required: true },
      };
    type RetainedCustody = NonNullable<
      Awaited<ReturnType<typeof captureOperatorToolGatewayContinuationContext>>
    >;
    const retainedRef: { value?: RetainedCustody } = {};
    let parentAdmitted:
      | import("../../agents/admitted-run-context.js").AdmittedRunContext
      | undefined;
    let parentProof: Promise<void> | undefined;
    let completionProof: Promise<void> | undefined;
    let parentTransport: string | undefined;
    mocks.agentCommand.mockImplementation((opts: AgentCommandGatewayIngressOpts) => {
      const proof = (async () => {
        const runId = expectDefined(opts.runId, "command run ID missing");
        const admission = prepareAgentCommandExecutionIdentity({
          opts,
          prepared: { cfg: {}, runId, sessionAgentId: "main", sessionId, sessionKey },
          ingress: { kind: "gateway-client", boundary: "agent", state: "present" },
          lifecycleGeneration: expectDefined(opts.lifecycleGeneration, "run generation missing"),
        });
        try {
          const admitted = await admission.admit("embedded");
          await withPreparedEmbeddedGatewayTools(
            {
              admittedRunContext: admitted,
              agentId: "main",
              sessionKey,
              sessionId,
              agentHarnessId: "pi",
              disableTools: true,
              messageChannel: opts.messageChannel,
              currentMessagingTarget: opts.to,
              currentChannelId: opts.runContext?.currentChannelId,
              agentAccountId: opts.runContext?.accountId,
              currentThreadTs: opts.runContext?.currentThreadTs,
            },
            () => true,
            async () => {
              const caller = expectDefined(
                getGatewayToolCallerIdentity(),
                "admitted caller missing",
              );
              const token = await mintAgentRuntimeIdentityToken({
                ...caller,
                operationalRunInstance: admitted.operationalRunInstance,
              });
              const identity = await verifyAgentRuntimeIdentityToken(token);
              const expectedOrigin = {
                sessionKey,
                turnSourceChannel: "telegram",
                turnSourceTo: "telegram:-100200",
                turnSourceAccountId: "target-account",
                turnSourceThreadId: "7",
              };
              if (runId === parentRunId) {
                expect(opts.messageChannel).toBe("webchat");
                expect(identity).toMatchObject(expectedOrigin);
                parentTransport = opts.messageChannel;
                parentAdmitted = admitted;
                retainedRef.value = await withOperatorToolGatewayAuthority(
                  { scopes: source.authority.scopes, operatorRunAuthority: source.authority },
                  async () =>
                    await expectDefined(
                      captureOperatorToolGatewayContinuationContext(),
                      "native continuation capture missing",
                    ),
                );
                subagentRuns.set(record.runId, record);
                subagentRuns.bindCompletionAuthority(
                  record,
                  expectDefined(retainedRef.value, "custody missing"),
                );
                return;
              }
              expect(runId).toBe(completionRunId);
              expect(
                getAdmittedRunDelegatedAuthority(expectDefined(parentAdmitted, "parent missing")),
              ).toBeUndefined();
              expect(context.chatAbortControllers.has(parentRunId)).toBe(false);
              expect(() =>
                expectDefined(retainedRef.value, "custody missing").assertCurrent(),
              ).not.toThrow();
              expect(
                isNativeCompletionOwnerForRun({
                  handoff: opts.trustedInternalHandoff,
                  inputProvenance: opts.inputProvenance,
                  internalEvents: opts.internalEvents,
                  sessionKey,
                  sessionId,
                  provider: opts.trustedInternalHandoff?.provider,
                  model: opts.trustedInternalHandoff?.model,
                }),
              ).toBe(true);
              const { telegramPlugin } = await loadBundledPluginFacade<{
                telegramPlugin: ChannelPlugin;
              }>({
                pluginId: "telegram",
                artifactBasename: "channel-plugin-api.ts",
              });
              const resolveTarget = expectDefined(
                telegramPlugin.approvalCapability?.native?.resolveOriginTarget,
                "native origin planner missing",
              );
              const target = await resolveTarget({
                cfg: {
                  channels: {
                    telegram: {
                      accounts: {
                        "target-account": {
                          botToken: "test-only-token",
                          execApprovals: { enabled: true, approvers: ["42"], target: "channel" },
                        },
                      },
                    },
                  },
                },
                accountId: "target-account",
                approvalKind: "plugin",
                request: {
                  id: `plugin:${runId}`,
                  createdAtMs: 0,
                  expiresAtMs: Date.now() + 60_000,
                  request: {
                    title: "Retained parent approval",
                    description: "Native completion consumer boundary",
                    sessionKey,
                    turnSourceChannel: identity?.turnSourceChannel,
                    turnSourceTo: identity?.turnSourceTo,
                    turnSourceAccountId: identity?.turnSourceAccountId,
                    turnSourceThreadId: identity?.turnSourceThreadId,
                  },
                },
              });
              expect(identity).toMatchObject(expectedOrigin);
              expect(target).toEqual({ to: "-100200", threadId: 7 });
            },
          );
        } finally {
          await admission.finish();
        }
      })();
      if (opts.runId === parentRunId) {
        parentProof = proof;
      } else {
        completionProof = proof;
      }
      return proof.then(() => ({ payloads: [{ text: "done" }], meta: { durationMs: 1 } }));
    });
    try {
      await withPluginRuntimeGatewayRequestScope(
        {
          client: parentClient,
          context,
          resolveGatewayContext: () => context,
          isWebchatConnect: () => false,
        },
        () =>
          invokeAgent(
            {
              message: "Continue the parent task internally",
              sessionKey,
              channel: "webchat",
              deliver: false,
              idempotencyKey: parentRunId,
              inputProvenance: {
                kind: "inter_session",
                sourceSessionKey: "agent:main:sender",
                sourceTool: "sessions_send",
              },
            },
            { context, client: parentClient, reqId: parentRunId },
          ),
      );
      await expectDefined(parentProof, "parent proof missing");
      await waitForAssertion(() => expect(context.chatAbortControllers.size).toBe(0));
      source.release();
      const custody = expectDefined(retainedRef.value, "retained custody missing");
      expect(custody.signal.aborted).toBe(false);
      expect(() => custody.assertCurrent()).not.toThrow();
      await subagentRuns.runWithCompletionAuthority(record, () =>
        runAnnounceAgentCall({
          agentParams: {
            message: "The retained child completed",
            sessionKey,
            channel: parentTransport,
            deliver: false,
            idempotencyKey: completionRunId,
            inputProvenance: {
              kind: "inter_session",
              sourceSessionKey: childSessionKey,
              sourceTool: "subagent_announce",
            },
            internalEvents: [
              {
                type: "task_completion",
                source: "subagent",
                childSessionKey,
                childSessionId,
                announceType: "subagent task",
                taskLabel: "work",
                status: "ok",
                statusLabel: "completed",
                result: "The retained child completed",
                replyInstruction: "Continue from this result.",
              },
            ],
          },
          delegatedToolPolicyHandoff: {
            sourceSessionKey: childSessionKey,
            sourceSessionId: childSessionId,
            targetSessionKey: sessionKey,
            targetSessionId: sessionId,
            idempotencyKey: completionRunId,
            isCurrent: () => subagentRuns.get(record.runId) === record && !custody.signal.aborted,
          },
          expectFinal: true,
          isExecutionAllowed: () =>
            subagentRuns.get(record.runId) === record && !custody.signal.aborted,
          resolveGatewayContext: () => context,
        }),
      );
      await expectDefined(completionProof, "completion consumer proof missing");
      await waitForAssertion(() => expect(context.chatAbortControllers.size).toBe(0));
    } finally {
      subagentRuns.releaseCompletionAuthority(record);
      subagentRuns.delete(record.runId);
      retainedRef.value?.release();
      source.release();
    }
  });
});
