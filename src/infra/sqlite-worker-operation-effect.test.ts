import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasSqliteWorkerOutcomeUnknown } from "./sqlite-worker-contract.js";
import {
  createSqliteWorkerOperationAdmission,
  requestSqliteWorkerOperationEffect,
  requestSqliteWorkerOperationAdmission,
  settleSqliteWorkerOperationContext,
  withSqliteWorkerOperationAdmission,
} from "./sqlite-worker-operation-admission.js";

afterEach(() => vi.restoreAllMocks());

describe("retained SQLite guarded host effects", () => {
  it.each([
    "ok",
    "domain-revoke",
    "physical-revoke",
    "request-revoke",
    "ordinary-grant",
    "domain-physical-revoke",
    "domain-close",
  ] as const)("keeps final authority and the synchronous outcome in one handoff (%s)", (mode) => {
    let current = true;
    const effect = vi.fn(() => ({ queued: true, key: "event-1" }));
    const revoked = new Error("synthetic revocation");
    const admission = createSqliteWorkerOperationAdmission((request, grant, grantEffect) => {
      expect(request.stage).toBe("effect");
      expect(request.facts).toEqual({ key: "event-1" });
      if (mode === "ordinary-grant") {
        grant();
        return;
      }
      if (mode === "physical-revoke" || mode === "request-revoke") {
        current = false;
      }
      if (!grantEffect) {
        throw new Error("effect control missing");
      }
      grantEffect(() => {
        if (mode === "domain-physical-revoke") {
          current = false;
        }
        if (mode === "domain-close") {
          admission.finish();
        }
        if (mode === "domain-revoke") {
          throw revoked;
        }
      }, effect);
    });
    admission.bindDatabaseAuthority({
      databasePath: path.resolve("effect-test.sqlite"),
      assertAccess() {
        if ((mode === "physical-revoke" || mode === "domain-physical-revoke") && !current) {
          throw revoked;
        }
      },
      assertRequest() {
        if (mode === "request-revoke" && !current) {
          throw revoked;
        }
      },
      acquireSchema() {
        throw new Error("effect cannot acquire schema");
      },
    });
    vi.spyOn(Atomics, "wait").mockImplementation(() => {
      admission.service();
      return "ok";
    });
    const call = () =>
      withSqliteWorkerOperationAdmission({ port: admission.port }, () =>
        requestSqliteWorkerOperationEffect({ key: "event-1" }),
      );
    try {
      if (mode === "ok") {
        expect(call()).toEqual({ queued: true, key: "event-1" });
        expect(effect).toHaveBeenCalledOnce();
        expect(admission.effects).toEqual([
          { status: "completed", outcome: { queued: true, key: "event-1" } },
        ]);
        expect(admission.committed).toBeUndefined();
      } else {
        expect(call).toThrow("effect admission was refused");
        expect(effect).not.toHaveBeenCalled();
        expect(admission.effects).toEqual([]);
      }
    } finally {
      admission.finish();
    }
  });

  it.each(["throw", "async", "uncloneable", "close-during-effect"] as const)(
    "retains an entered effect as unknown rather than claiming no effect (%s)",
    (mode) => {
      const entered = vi.fn();
      const admission = createSqliteWorkerOperationAdmission((_request, _grant, grantEffect) => {
        if (!grantEffect) {
          throw new Error("effect control missing");
        }
        grantEffect(
          () => {},
          () => {
            entered();
            if (mode === "throw") {
              throw new Error("after effect entry");
            }
            if (mode === "async") {
              return Promise.resolve(true);
            }
            if (mode === "uncloneable") {
              return () => true;
            }
            admission.finish();
            return true;
          },
        );
      });
      vi.spyOn(Atomics, "wait").mockImplementation(() => {
        admission.service();
        return "ok";
      });
      try {
        let workerError: unknown;
        try {
          withSqliteWorkerOperationAdmission({ port: admission.port }, () =>
            requestSqliteWorkerOperationEffect({}),
          );
        } catch (error) {
          workerError = error;
        }
        expect.soft(hasSqliteWorkerOutcomeUnknown(workerError)).toBe(true);
        expect.soft(hasSqliteWorkerOutcomeUnknown(admission.failure)).toBe(true);
        expect
          .soft(
            hasSqliteWorkerOutcomeUnknown(
              new AggregateError([admission.failure, new Error("cleanup")], "cleanup"),
            ),
          )
          .toBe(true);
        expect(entered).toHaveBeenCalledOnce();
        expect(admission.effects).toEqual([expect.objectContaining({ status: "unknown" })]);
        expect(admission.committed).toBeUndefined();
      } finally {
        admission.finish();
      }
    },
  );

  it("does not begin a second effect after the first reenters domain lifecycle", () => {
    let current = true;
    const effect = vi.fn(() => {
      current = false;
      return { accepted: true };
    });
    const admission = createSqliteWorkerOperationAdmission((_request, _grant, grantEffect) => {
      if (!grantEffect) {
        throw new Error("effect control missing");
      }
      grantEffect(() => {
        if (!current) {
          throw new Error("generation stopped");
        }
      }, effect);
    });
    vi.spyOn(Atomics, "wait").mockImplementation(() => {
      admission.service();
      return "ok";
    });
    try {
      withSqliteWorkerOperationAdmission({ port: admission.port }, () => {
        expect(requestSqliteWorkerOperationEffect({})).toEqual({ accepted: true });
        let refused: unknown;
        try {
          requestSqliteWorkerOperationEffect({});
        } catch (error) {
          refused = error;
        }
        expect(hasSqliteWorkerOutcomeUnknown(refused)).toBe(true);
      });
      expect(effect).toHaveBeenCalledOnce();
      expect(admission.effects).toEqual([{ status: "completed", outcome: { accepted: true } }]);
    } finally {
      admission.finish();
    }
  });
});

it("consumes a rejected native Promise without accepting an async host effect", async () => {
  const rejection = Promise.reject(new Error("rejected host effect"));
  const consume = vi.spyOn(rejection, "catch");
  const admission = createSqliteWorkerOperationAdmission((_request, _grant, grantEffect) => {
    if (!grantEffect) {
      throw new Error("effect control missing");
    }
    grantEffect(
      () => {},
      () => rejection,
    );
  });
  vi.spyOn(Atomics, "wait").mockImplementation(() => {
    admission.service();
    return "ok";
  });
  try {
    expect(() =>
      withSqliteWorkerOperationAdmission({ port: admission.port }, () =>
        requestSqliteWorkerOperationEffect({}),
      ),
    ).toThrow();
    expect(consume).toHaveBeenCalledOnce();
    expect(admission.effects).toEqual([expect.objectContaining({ status: "unknown" })]);
  } finally {
    // Keep the RED test itself from manufacturing an unhandled rejection.
    void Promise.prototype.catch.call(rejection, () => {});
    admission.finish();
    await Promise.resolve();
  }
});

it("does not classify a completed rollback after an accepted host effect as safe cancellation", () => {
  const admission = createSqliteWorkerOperationAdmission((request, _grant, grantEffect) => {
    if (request.stage !== "effect" || !grantEffect) {
      throw new Error("commit authority revoked");
    }
    grantEffect(
      () => {},
      () => true,
    );
  });
  vi.spyOn(Atomics, "wait").mockImplementation(() => {
    admission.service();
    return "ok";
  });
  const context = { port: admission.port };
  try {
    withSqliteWorkerOperationAdmission(context, () => {
      expect(requestSqliteWorkerOperationEffect({})).toBe(true);
      expect(() =>
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined }),
      ).toThrow();
      settleSqliteWorkerOperationContext(context, "completed");
    });
    admission.service();
    expect(admission.settlement).toEqual({ kind: "completed" });
    expect(admission.committed).toBeUndefined();
    expect(hasSqliteWorkerOutcomeUnknown(admission.failure)).toBe(true);
    expect(admission.effects).toEqual([{ status: "completed", outcome: true }]);
  } finally {
    admission.finish();
  }
});

it("does not let an earlier handled domain refusal mask a later entered-effect physical close", () => {
  const prior = new Error("prior handled domain refusal");
  const admission = createSqliteWorkerOperationAdmission((request, _grant, grantEffect) => {
    if (request.stage !== "effect" || !grantEffect) {
      throw prior;
    }
    grantEffect(
      () => {},
      () => {
        admission.finish();
        return true;
      },
    );
  });
  vi.spyOn(Atomics, "wait").mockImplementation(() => {
    admission.service();
    return "ok";
  });
  try {
    withSqliteWorkerOperationAdmission({ port: admission.port }, () => {
      expect(() =>
        requestSqliteWorkerOperationAdmission({ stage: "prepare", facts: undefined }),
      ).toThrow();
      let error: unknown;
      try {
        requestSqliteWorkerOperationEffect({});
      } catch (failure) {
        error = failure;
      }
      expect(hasSqliteWorkerOutcomeUnknown(error)).toBe(true);
    });
    expect(admission.failureSource).toBe("authority");
    expect(hasSqliteWorkerOutcomeUnknown(admission.failure)).toBe(true);
    expect(admission.failure).toMatchObject({
      cause: { message: "SQLite worker admission is closed" },
    });
  } finally {
    admission.finish();
  }
});

it.each(["result", "throw", "finish"] as const)(
  "keeps the real worker blocked until host outcome or unknown (%s)",
  async (mode) => {
    const entered = vi.fn();
    const admission = createSqliteWorkerOperationAdmission((_request, _grant, grantEffect) => {
      if (!grantEffect) {
        throw new Error("effect control missing");
      }
      grantEffect(
        () => {},
        () => {
          entered();
          if (mode === "throw") {
            throw new Error("entered effect failed");
          }
          if (mode === "finish") {
            admission.finish();
          }
          return { ack: "actual-private-port" };
        },
      );
    });
    const worker = new Worker(
      `
    const {workerData, parentPort, MessageChannel, receiveMessageOnPort} = require("node:worker_threads");
    const {port1, port2} = new MessageChannel();
    const decision = new Int32Array(new SharedArrayBuffer(4));
    workerData.port.postMessage({stage:"effect", facts:{}, effectPort:port2, decision:decision.buffer}, [port2]);
    while (Atomics.load(decision,0) === 0) {Atomics.wait(decision,0,0);}
    const state = Atomics.load(decision,0);
    const reply = state === 1 ? receiveMessageOnPort(port1)?.message : undefined;
    parentPort.postMessage({state, reply});
    port1.close(); workerData.port.close(); parentPort.close();
  `,
      { eval: true, workerData: { port: admission.port }, transferList: [admission.port] },
    );
    const result = new Promise<unknown>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    const joined = new Promise<number>((resolve, reject) => {
      worker.once("exit", resolve);
      worker.once("error", reject);
    });
    try {
      expect(await result).toEqual(
        mode === "result"
          ? {
              state: 1,
              reply: { kind: "sqlite-effect-outcome", outcome: { ack: "actual-private-port" } },
            }
          : { state: 3, reply: undefined },
      );
      expect(await joined).toBe(0);
      expect(entered).toHaveBeenCalledOnce();
      expect(admission.committed).toBeUndefined();
      if (mode !== "result") {
        expect(hasSqliteWorkerOutcomeUnknown(admission.failure)).toBe(true);
      }
    } finally {
      admission.finish();
      await worker.terminate();
      await joined.catch(() => {});
    }
  },
);
