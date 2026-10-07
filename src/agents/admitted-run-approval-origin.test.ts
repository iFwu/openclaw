import { afterEach, describe, expect, it } from "vitest";
import {
  bindAdmittedRunApprovalOrigin,
  captureApprovalOrigin,
  readAdmittedRunApprovalOrigin,
} from "./admitted-run-approval-origin.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "./admitted-run-context.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";

const owners: PreparedAgentRunAdmission[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.close();
  }
});
async function admit(runId = "same-run-id") {
  const owner = prepareAgentRunAdmission({
    cfg: {},
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    facts: {
      runId,
      agentId: "main",
      ingress: { kind: "system", boundary: "approval-origin-test", state: "present" },
    },
  });
  owners.push(owner);
  return { owner, context: await owner.admit("embedded") };
}
const source = {
  provider: "telegram",
  to: "telegram:-100200",
  accountId: "target-account",
  threadId: "7",
};
function snapshot() {
  const value = captureApprovalOrigin(source);
  if (!value) {
    throw new Error("snapshot missing");
  }
  return value;
}

describe("admitted approval origin custody", () => {
  it.each([undefined, true] as const)(
    "keeps captured absent/local source without delivery fallback (%s)",
    async (local) => {
      const { context } = await admit("captured-empty-source");
      bindAdmittedRunApprovalOrigin(context, Object.freeze({ turnSourceLocal: local }), () => {});
      const identity = createAdmittedGatewayToolCallerIdentity({
        admittedRunContext: context,
        agentId: "main",
        sessionKey: "target",
        turnSourceChannel: "telegram",
        turnSourceTo: "wrong-room",
        turnSourceAccountId: "wrong-account",
        turnSourceThreadId: "99",
      });
      expect(identity?.turnSourceChannel).toBeUndefined();
      expect(identity?.turnSourceTo).toBeUndefined();
      expect(identity?.turnSourceAccountId).toBeUndefined();
      expect(identity?.turnSourceThreadId).toBeUndefined();
      expect(identity?.turnSourceLocal).toBe(local);
    },
  );

  it("does not mix caller account, thread or local posture into an absent frozen field", async () => {
    const { context } = await admit();
    const captured = captureApprovalOrigin({ provider: "telegram", to: source.to })!;
    bindAdmittedRunApprovalOrigin(context, captured, () => {});
    const identity = createAdmittedGatewayToolCallerIdentity({
      admittedRunContext: context,
      agentId: "main",
      sessionKey: "target",
      turnSourceChannel: "discord",
      turnSourceTo: "caller-room",
      turnSourceAccountId: "news-account",
      turnSourceThreadId: "223",
      turnSourceLocal: true,
    });
    expect(identity).toMatchObject({ turnSourceChannel: "telegram", turnSourceTo: source.to });
    expect(identity?.turnSourceAccountId).toBeUndefined();
    expect(identity?.turnSourceThreadId).toBeUndefined();
    expect(identity?.turnSourceLocal).toBeUndefined();
  });

  it.each(["same-run", "no-run", "different-run"] as const)(
    "preserves exact owner through %s wrappers",
    async (mode) => {
      const first = await admit("wrapper-first");
      const second = await admit("wrapper-second");
      bindAdmittedRunApprovalOrigin(first.context, snapshot(), () => {});
      const identity = createAdmittedGatewayToolCallerIdentity({
        admittedRunContext: first.context,
        agentId: "main",
        sessionKey: "target",
      });
      await withGatewayToolCallerIdentity(identity, async () => {
        const wrapper = {
          agentId: "main",
          sessionKey: "wrapper",
          ...(mode === "no-run"
            ? {}
            : {
                operationalRunInstance:
                  mode === "same-run"
                    ? first.context.operationalRunInstance
                    : second.context.operationalRunInstance,
              }),
          turnSourceChannel: "discord",
          turnSourceTo: "caller-room",
          turnSourceAccountId: "news-account",
          turnSourceThreadId: "223",
        };
        await withGatewayToolCallerIdentity(wrapper, async () => {
          const caller = getGatewayToolCallerIdentity();
          expect(caller).toMatchObject(
            mode === "different-run"
              ? {
                  turnSourceChannel: "discord",
                  turnSourceTo: "caller-room",
                  turnSourceAccountId: "news-account",
                  turnSourceThreadId: "223",
                }
              : {
                  turnSourceChannel: "telegram",
                  turnSourceTo: source.to,
                  turnSourceAccountId: source.accountId,
                  turnSourceThreadId: source.threadId,
                },
          );
        });
      });
    },
  );

  it.each([
    undefined,
    {},
    { provider: "webchat", to: "telegram:-100200" },
    { provider: "telegram", from: "agent:main:telegram:group:-100200" },
  ])("does not invent an external origin from incomplete or internal facts %j", (value) => {
    expect(captureApprovalOrigin(value)).toBeUndefined();
  });
  it("copies and freezes the route instead of following mutable delivery metadata", async () => {
    const { context } = await admit();
    const mutable = { ...source };
    const captured = captureApprovalOrigin(mutable)!;
    bindAdmittedRunApprovalOrigin(context, captured, () => {});
    mutable.to = "telegram:-100999";
    mutable.accountId = "news-account";
    mutable.threadId = "223";
    expect(Object.isFrozen(captured)).toBe(true);
    expect(readAdmittedRunApprovalOrigin(context)).toEqual({
      turnSourceChannel: "telegram",
      turnSourceTo: source.to,
      turnSourceAccountId: source.accountId,
      turnSourceThreadId: source.threadId,
    });
  });
  it("rejects cloned admission and rebinding rather than upgrading model-supplied fields", async () => {
    const { context } = await admit();
    expect(() => bindAdmittedRunApprovalOrigin({ ...context }, snapshot(), () => {})).toThrow(
      "active admitted run",
    );
    bindAdmittedRunApprovalOrigin(context, snapshot(), () => {});
    expect(readAdmittedRunApprovalOrigin({ ...context })).toBeUndefined();
    expect(() => bindAdmittedRunApprovalOrigin(context, snapshot(), () => {})).toThrow(
      "already bound",
    );
  });
  it("checks the retained source on read and discards revoked run authority", async () => {
    const { context, owner } = await admit();
    let current = true;
    bindAdmittedRunApprovalOrigin(context, snapshot(), () => {
      if (!current) {
        throw new Error("source replaced");
      }
    });
    current = false;
    expect(() => readAdmittedRunApprovalOrigin(context)).toThrow("source replaced");
    owner.close();
    expect(readAdmittedRunApprovalOrigin(context)).toBeUndefined();
  });
  it("does not transfer a closed run's origin to another instance with the same run id", async () => {
    const first = await admit();
    bindAdmittedRunApprovalOrigin(first.context, snapshot(), () => {});
    first.owner.close();
    const second = await admit();
    expect(readAdmittedRunApprovalOrigin(second.context)).toBeUndefined();
  });
});
