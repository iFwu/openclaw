import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  mintAgentRuntimeIdentityToken,
  verifyAgentRuntimeIdentityToken,
} from "../../gateway/agent-runtime-identity-token.js";
import {
  bindAdmittedRunApprovalOrigin,
  captureApprovalOrigin,
} from "../admitted-run-approval-origin.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../admitted-run-context.js";
import { setActiveEmbeddedRun } from "../embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle, testing } from "../embedded-agent-runner/runs.test-support.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import { trySessionsSendActiveRunDelivery } from "./sessions-send-tool.delivery.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const owners: PreparedAgentRunAdmission[] = [];
afterEach(() => {
  testing.resetActiveEmbeddedRuns();
  for (const owner of owners.splice(0)) {
    owner.close();
  }
});
async function admit(runId: string) {
  const owner = prepareAgentRunAdmission({
    cfg: {},
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    facts: {
      runId,
      agentId: "main",
      ingress: { kind: "system", boundary: "steer-origin-test", state: "present" },
    },
  });
  owners.push(owner);
  return { owner, context: await owner.admit("embedded") };
}

describe("sessions_send active target approval origin", () => {
  it.each(["accepted", "replaced", "stopped"] as const)(
    "keeps the receiving incarnation's owner when %s",
    async (scenario) => {
      const target = await admit(`target-${scenario}`);
      const sender = await admit(`news-${scenario}`);
      const targetKey = "agent:main:telegram:group:-100200:topic:7";
      const senderKey = "agent:main:telegram:group:-100999:topic:223";
      const targetId = `target-session-${scenario}`;
      const origin = captureApprovalOrigin({
        provider: "telegram",
        to: "telegram:-100200",
        accountId: "target-account",
        threadId: "7",
      })!;
      bindAdmittedRunApprovalOrigin(target.context, origin, () => {});
      const targetCaller = createAdmittedGatewayToolCallerIdentity({
        admittedRunContext: target.context,
        agentId: "main",
        sessionKey: targetKey,
      });
      const senderCaller = createAdmittedGatewayToolCallerIdentity({
        admittedRunContext: sender.context,
        agentId: "main",
        sessionKey: senderKey,
        turnSourceChannel: "telegram",
        turnSourceTo: "telegram:-100999",
        turnSourceAccountId: "news-account",
        turnSourceThreadId: "223",
      });
      const queueMessage = vi.fn(async () => {});
      const handle = createEmbeddedRunHandle({
        runId: `target-${scenario}`,
        queueMessage,
        isStopped: () => scenario === "stopped",
      });
      await withGatewayToolCallerIdentity(targetCaller, async () => {
        setActiveEmbeddedRun(targetId, handle, targetKey, undefined, "main");
      });
      if (scenario === "stopped") {
        target.owner.close();
      }
      const storePath = path.join(tempDirs.make("steer-origin-"), "sessions.json");
      const callGateway = vi.fn(async () => {
        throw new Error("steering must not create a new admission");
      });
      const result = await withGatewayToolCallerIdentity(senderCaller, () =>
        trySessionsSendActiveRunDelivery(
          {
            cfg: { session: { store: storePath } },
            callGateway,
            runId: `input-${scenario}`,
            mode: "steer",
            sessionKey: targetKey,
            expectedSessionId: scenario === "replaced" ? "prior-incarnation" : targetId,
            sessionStoreTarget: { agentId: "main", canonicalKey: targetKey, storePath },
            sendParams: {
              message: "continue target work",
              agentId: "main",
              sourceReplyDeliveryMode: "message_tool_only",
              inputProvenance: {
                kind: "inter_session",
                sourceSessionKey: senderKey,
                sourceChannel: "telegram",
                sourceTool: "sessions_send",
              },
            },
          },
          false,
        ),
      );
      expect(callGateway).not.toHaveBeenCalled();
      if (scenario === "accepted") {
        expect(result).toMatchObject({ ok: true, targetDisposition: "steered" });
        expect(queueMessage).toHaveBeenCalledOnce();
      } else {
        expect(result).toMatchObject({ ok: false });
        expect(queueMessage).not.toHaveBeenCalled();
      }
      const token = mintAgentRuntimeIdentityToken({
        ...targetCaller!,
        operationalRunInstance: target.context.operationalRunInstance,
      });
      if (scenario === "stopped") {
        await expect(token).rejects.toThrow(
          "agent runtime identity requires active delegated run authority",
        );
      } else {
        const identity = await verifyAgentRuntimeIdentityToken(await token);
        expect(identity).toMatchObject({
          sessionKey: targetKey,
          turnSourceChannel: "telegram",
          turnSourceTo: "telegram:-100200",
          turnSourceAccountId: "target-account",
          turnSourceThreadId: "7",
        });
      }
    },
  );
});
