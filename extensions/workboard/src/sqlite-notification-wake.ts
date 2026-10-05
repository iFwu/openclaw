import { isDeepStrictEqual } from "node:util";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionFactory,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  WorkboardNotificationWakeAuthority,
  WorkboardNotificationWakeBatch,
  WorkboardNotificationWakeResult,
} from "./persistence-types.js";

export type WorkboardNotificationWakeScope = {
  active: boolean;
  assertCurrent: Parameters<WorkboardNotificationWakeAuthority>[0];
  deliver: Parameters<WorkboardNotificationWakeAuthority>[1];
};

export function createWorkboardNotificationWakeOwner(
  batch: WorkboardNotificationWakeBatch,
  nonce: string,
  databasePath: string,
  scope: WorkboardNotificationWakeScope,
) {
  let phase: "pending" | "locked" | "commit" = "pending";
  const attempted = new Set<string>();
  const seen = new Set<string>();
  const expectedEvents = new Map(batch.events.map((event) => [event.key, event.notification]));
  const assertCurrent = () => {
    if (!scope.active) {
      throw new Error("Workboard notification authority has settled.");
    }
    scope.assertCurrent();
  };
  const admission = createSqliteWorkerOperationAdmission((request, grant, grantEffect) => {
    const facts = request.facts;
    if (!isRecord(facts) || facts.nonce !== nonce) {
      throw new Error("Invalid Workboard wake operation facts.");
    }
    if (
      request.stage === "transaction" &&
      phase === "pending" &&
      isDeepStrictEqual(facts.subscription, batch.expected)
    ) {
      assertCurrent();
      phase = "locked";
      grant();
      return;
    }
    if (
      request.stage === "effect" &&
      phase === "locked" &&
      grantEffect &&
      typeof facts.key === "string" &&
      !seen.has(facts.key)
    ) {
      const key = facts.key;
      const notification = expectedEvents.get(key);
      if (!notification || !isDeepStrictEqual(notification, facts.notification)) {
        throw new Error("Invalid Workboard wake event.");
      }
      seen.add(key);
      grantEffect(assertCurrent, () => {
        attempted.add(key);
        return scope.deliver(batch.expected, notification);
      });
      return;
    }
    if (request.stage === "commit" && phase === "locked") {
      assertCurrent();
      phase = "commit";
      grant();
      return;
    }
    throw new Error("Workboard notification wake phase is not current.");
  });
  const createAdmission: SqliteWorkerAdmissionFactory = () => ({
    admission,
    nativeLocations: [databasePath],
  });
  return {
    assertCurrent,
    createAdmission,
    recover(error: unknown): WorkboardNotificationWakeResult {
      const facts = admission.committed?.facts;
      if (isRecord(facts) && facts.nonce === nonce && Array.isArray(facts.deliveredEventIds)) {
        const deliveredEventIds = facts.deliveredEventIds.filter(
          (key: unknown): key is string => typeof key === "string" && attempted.has(key),
        );
        if (deliveredEventIds.length === facts.deliveredEventIds.length) {
          return { matched: true, deliveredEventIds, unknownEventIds: [] };
        }
      }
      if (extractErrorCode(error) !== "outcome-unknown" || attempted.size === 0) {
        throw error;
      }
      // No replay: completed host calls do not establish that the IDs committed.
      return { matched: false, deliveredEventIds: [], unknownEventIds: [...attempted] };
    },
  };
}
