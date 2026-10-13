import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import {
  captureGatewayToolCallerAssertion,
  withGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn }),
}));

beforeEach(() => {
  warn.mockReset();
});

const caller = {
  agentId: "test",
  sessionKey: "agent:test:private-conversation",
  operationalRunInstance: { instanceId: "instance-test", runId: "run-test" },
};

describe("caller authority rejection diagnostics", () => {
  it.each(["missing_receipt", "aborted_signal", "stale_receipt"] as const)(
    "reports %s once without conversation or abort text",
    async (reason) => {
      const controller = new AbortController();
      const receipt = vi.fn(() => reason !== "stale_receipt");
      if (reason === "aborted_signal") {
        controller.abort(new Error("private abort reason"));
      }
      await withGatewayToolCallerIdentity(
        {
          ...caller,
          receiptAuthority: reason === "missing_receipt" ? undefined : receipt,
          approvalSignals: [controller.signal],
        },
        async () => {
          const assertion = captureGatewayToolCallerAssertion();
          expect(assertion).toBeTypeOf("function");
          for (let count = 0; count < 2; count++) {
            expect(() => assertion?.("private.method")).toThrow(
              "agent tool caller authority is no longer active",
            );
          }
          expect(warn).toHaveBeenCalledTimes(1);
          expect(warn).toHaveBeenCalledWith(expect.stringContaining(`reason=${reason}`));
          expect(warn).toHaveBeenCalledWith(expect.stringContaining("runId=run-test"));
          expect(JSON.stringify(warn.mock.calls)).not.toContain("private");
          expect(receipt).toHaveBeenCalledTimes(reason === "stale_receipt" ? 2 : 0);
        },
      );
    },
  );

  it("keeps active checks silent and reports the later loss of the captured owner", async () => {
    let active = true;
    await withGatewayToolCallerIdentity({ ...caller, receiptAuthority: () => active }, async () => {
      const assertion = captureGatewayToolCallerAssertion();
      assertion?.();
      assertion?.();
      expect(warn).not.toHaveBeenCalled();
      active = false;
      expect(() => assertion?.()).toThrow("agent tool caller authority is no longer active");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("reason=stale_receipt"));
    });
  });

  it("preserves the original operator error without logging its private message", async () => {
    const error = new Error("private operator details");
    const receipt = vi.fn(() => true);
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "test-profile",
      scopes: [],
      assertCurrent: () => {
        throw error;
      },
    });
    await withGatewayToolCallerIdentity(
      { ...caller, receiptAuthority: receipt, operatorAuthority },
      async () => {
        const assertion = captureGatewayToolCallerAssertion();
        let rejected: unknown;
        try {
          assertion?.();
        } catch (caught) {
          rejected = caught;
        }
        expect(rejected).toBe(error);
        expect(receipt).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("reason=operator_inactive"));
        expect(JSON.stringify(warn.mock.calls)).not.toContain("private");
      },
    );
  });

  it("preserves rejection when logging fails", async () => {
    warn.mockImplementation(() => {
      throw new Error("logger failure");
    });
    await withGatewayToolCallerIdentity(caller, async () => {
      const assertion = captureGatewayToolCallerAssertion();
      expect(() => assertion?.()).toThrow("agent tool caller authority is no longer active");
    });
  });
});
