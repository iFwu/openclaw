import { describe, expect, it } from "vitest";
import { isNativeCompletionOwnerForRun } from "../agents/subagents/announce/subagent-announce-handoff.js";
import {
  captureContinuationApprovalOrigin,
  withContinuationApprovalOrigin,
} from "./continuation-approval-origin.js";
import {
  cancelSubagentCompletionToolHandoff,
  consumeSubagentCompletionToolHandoff,
  registerSubagentCompletionToolHandoff,
  readSubagentCompletionApprovalOrigin,
} from "./subagent-completion-tool-handoff.js";

const registration = {
  sourceSessionKey: "agent:main:subagent:child",
  sourceSessionId: "child-session",
  targetSessionKey: "agent:main:main",
  targetSessionId: "requester-session",
  idempotencyKey: "announce-1",
} as const;

function consume(handoffId: string | undefined, overrides: Record<string, unknown> = {}) {
  return consumeSubagentCompletionToolHandoff({
    handoffId,
    sourceTool: "subagent_announce",
    ...registration,
    provider: "openai",
    model: "glm-4.5",
    ...overrides,
  });
}

describe("subagent completion tool handoff", () => {
  it("retains only frozen parent source on the exact redeemed object", () => {
    const caller = {
      sessionKey: registration.targetSessionKey,
      turnSourceChannel: "telegram",
      turnSourceTo: "telegram:-100200",
      turnSourceAccountId: "parent-account",
      turnSourceThreadId: "7",
    };
    const snapshot = captureContinuationApprovalOrigin(caller);
    caller.turnSourceTo = "telegram:-100999";
    const id = withContinuationApprovalOrigin(
      snapshot,
      () => {},
      () => registerSubagentCompletionToolHandoff(registration),
    );
    const handoff = consume(id);
    expect(handoff).toBeDefined();
    const held = readSubagentCompletionApprovalOrigin(handoff);
    expect(held?.snapshot.origin).toMatchObject({
      turnSourceChannel: "telegram",
      turnSourceTo: "telegram:-100200",
      turnSourceAccountId: "parent-account",
      turnSourceThreadId: "7",
    });
    expect(Object.isFrozen(held?.snapshot.origin)).toBe(true);
    expect(
      readSubagentCompletionApprovalOrigin(handoff ? { ...handoff } : undefined),
    ).toBeUndefined();
    expect(handoff).not.toHaveProperty("approvalOrigin");
  });

  it("does not borrow another target's ambient source or accept JSON origin fields", () => {
    const snapshot = captureContinuationApprovalOrigin({
      sessionKey: "agent:main:other",
      turnSourceChannel: "telegram",
      turnSourceTo: "telegram:-100999",
    });
    const id = withContinuationApprovalOrigin(
      snapshot,
      () => {},
      () => registerSubagentCompletionToolHandoff(registration),
    );
    expect(readSubagentCompletionApprovalOrigin(consume(id))).toBeUndefined();
    const forged = { ...registration, approvalOrigin: snapshot };
    expect(
      readSubagentCompletionApprovalOrigin(consume(registerSubagentCompletionToolHandoff(forged))),
    ).toBeUndefined();
  });

  it.each(["before", "after"] as const)(
    "rejects retained source revocation %s redemption",
    (when) => {
      let current = true;
      const assertCurrent = () => {
        if (!current) {
          throw new Error("parent source revoked");
        }
      };
      const snapshot = captureContinuationApprovalOrigin({
        sessionKey: registration.targetSessionKey,
        turnSourceChannel: "telegram",
        turnSourceTo: "telegram:-100200",
      });
      const id = withContinuationApprovalOrigin(snapshot, assertCurrent, () =>
        registerSubagentCompletionToolHandoff(registration),
      );
      if (when === "before") {
        current = false;
        expect(consume(id)).toBeUndefined();
        cancelSubagentCompletionToolHandoff(id);
      } else {
        const held = readSubagentCompletionApprovalOrigin(consume(id));
        expect(held).toBeDefined();
        current = false;
        expect(() => held?.assertCurrent()).toThrow("parent source revoked");
      }
    },
  );

  it("keeps native source liveness private and rejects a cloned or mismatched handoff", () => {
    let current = true;
    const handoffId = registerSubagentCompletionToolHandoff({
      ...registration,
      isCurrent: () => current,
    });
    const handoff = consume(handoffId);
    const params = {
      handoff,
      inputProvenance: {
        kind: "inter_session" as const,
        sourceTool: "subagent_announce",
        sourceSessionKey: registration.sourceSessionKey,
      },
      sessionKey: registration.targetSessionKey,
      sessionId: registration.targetSessionId,
      provider: "openai",
      model: "glm-4.5",
    };
    expect(isNativeCompletionOwnerForRun(params)).toBe(true);
    expect(
      isNativeCompletionOwnerForRun({ ...params, handoff: handoff ? { ...handoff } : undefined }),
    ).toBe(false);
    expect(isNativeCompletionOwnerForRun({ ...params, sessionId: "successor-instance" })).toBe(
      false,
    );
    expect(isNativeCompletionOwnerForRun({ ...params, model: "other-model" })).toBe(false);
    current = false;
    expect(isNativeCompletionOwnerForRun(params)).toBe(false);
  });

  it("cannot redeem a revoked original native producer", () => {
    let current = true;
    const handoffId = registerSubagentCompletionToolHandoff({
      ...registration,
      isCurrent: () => current,
    });
    current = false;
    expect(consume(handoffId)).toBeUndefined();
    cancelSubagentCompletionToolHandoff(handoffId);
  });

  it("consumes the exact capability once and binds it to the admitted route", () => {
    const handoffId = registerSubagentCompletionToolHandoff(registration);
    expect(consume(handoffId)).toEqual({
      kind: "subagent-completion",
      sourceSessionKey: registration.sourceSessionKey,
      sourceSessionId: registration.sourceSessionId,
      targetSessionKey: registration.targetSessionKey,
      targetSessionId: registration.targetSessionId,
      provider: "openai",
      model: "glm-4.5",
    });
    expect(consume(handoffId)).toBeUndefined();
  });

  it.each([
    ["source session", { sourceSessionKey: "agent:main:subagent:forged" }],
    ["source run", { sourceSessionId: "forged-child-session" }],
    ["target session", { targetSessionKey: "agent:main:other" }],
    ["target run", { targetSessionId: "replaced-requester-session" }],
    ["idempotency key", { idempotencyKey: "announce-forged" }],
    ["source tool", { sourceTool: "subagent_settle" }],
  ])("rejects a mismatched %s without burning the valid capability", (_name, overrides) => {
    const handoffId = registerSubagentCompletionToolHandoff(registration);
    expect(consume(handoffId, overrides)).toBeUndefined();
    expect(consume(handoffId)).toBeDefined();
  });

  it("rejects missing and forged capability ids", () => {
    expect(consume(undefined)).toBeUndefined();
    expect(consume("forged")).toBeUndefined();
  });

  it("revalidates the settle owner's authority before consuming a capability", () => {
    let current = true;
    const handoffId = registerSubagentCompletionToolHandoff({
      ...registration,
      settleBatch: {
        sourceSessionKeys: [registration.sourceSessionKey],
        isCurrent: () => current,
      },
    });
    expect(handoffId).toBeDefined();
    expect(consume(handoffId)).toBeUndefined();
    current = false;
    expect(consume(handoffId, { sourceTool: "subagent_settle" })).toBeUndefined();
    expect(cancelSubagentCompletionToolHandoff(handoffId)).toBe(true);
  });

  it("binds an accepted replay source only within the registered settle cohort", () => {
    const acceptedSource = "agent:main:subagent:sibling";
    const handoffId = registerSubagentCompletionToolHandoff({
      ...registration,
      settleBatch: {
        sourceSessionKeys: [registration.sourceSessionKey, acceptedSource],
        isCurrent: () => true,
      },
    });
    expect(
      consume(handoffId, {
        sourceTool: "subagent_settle",
        sourceSessionKey: "agent:main:subagent:outside-batch",
      }),
    ).toBeUndefined();
    const accepted = { sourceTool: "subagent_settle", sourceSessionKey: acceptedSource };
    expect(consume(handoffId, accepted)?.sourceSessionKey).toBe(acceptedSource);
    expect(consume(handoffId, accepted)).toBeUndefined();
  });

  it("expires capabilities and removes cancelled capabilities", () => {
    const expiredId = registerSubagentCompletionToolHandoff({ ...registration, nowMs: 1_000 });
    expect(consume(expiredId, { nowMs: 301_001 })).toBeUndefined();

    const cancelledId = registerSubagentCompletionToolHandoff(registration);
    expect(cancelSubagentCompletionToolHandoff(cancelledId)).toBe(true);
    expect(consume(cancelledId)).toBeUndefined();
  });
});
