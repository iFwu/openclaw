import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { WorkboardNotificationSubscription } from "@openclaw/workboard-contract";
import {
  compileSqliteQueryBindings,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
  runSqliteImmediateTransactionSync,
  requestSqliteWorkerOperationAdmission,
  requestSqliteWorkerOperationEffect,
  deferSqliteWorkerCommitReceipt,
  withSqlitePostCommitPublications,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import type {
  PersistedWorkboardNotificationSubscription,
  WorkboardNotificationCursor,
  WorkboardNotificationWakeBatch,
  WorkboardNotificationWakeResult,
  WorkboardSubscriptionStore,
} from "./persistence-types.js";
import {
  definedFields,
  jsonValue,
  numberValue,
  parseJson,
  requiredNumber,
  requiredString,
  stringValue,
  type Row,
} from "./sqlite-store-records.js";
import { bindNull } from "./sqlite-store-write.js";

function readSubscription(row: Row): PersistedWorkboardNotificationSubscription {
  // SAFETY: Subscription registration serializes eventKinds unchanged.
  const eventKinds = parseJson(row.event_kinds_json) as
    | PersistedWorkboardNotificationSubscription["subscription"]["eventKinds"]
    | undefined;
  // SAFETY: Subscription registration serializes deliveredEventIds unchanged.
  const deliveredEventIds = parseJson(row.delivered_event_ids_json) as
    | PersistedWorkboardNotificationSubscription["subscription"]["deliveredEventIds"]
    | undefined;
  return {
    version: 1,
    subscription: definedFields({
      id: requiredString(row, "id"),
      boardId: requiredString(row, "board_id"),
      cardId: stringValue(row, "card_id"),
      sessionKey: stringValue(row, "session_key"),
      runId: stringValue(row, "run_id"),
      target: stringValue(row, "target"),
      wakeSessionKey: stringValue(row, "wake_session_key"),
      ...(eventKinds ? { eventKinds } : {}),
      lastEventAt: numberValue(row, "last_event_at"),
      lastEventId: stringValue(row, "last_event_id"),
      lastEventSequence: numberValue(row, "last_event_sequence"),
      ...(deliveredEventIds ? { deliveredEventIds } : {}),
      createdAt: requiredNumber(row, "created_at"),
      updatedAt: requiredNumber(row, "updated_at"),
    }),
  };
}

export class WorkboardSqliteSubscriptionStore {
  private readonly rowsQuery;

  constructor(private readonly db: DatabaseSync) {
    this.rowsQuery = getNodeSqliteKysely<{ workboard_notification_subscriptions: Row }>(db)
      .selectFrom("workboard_notification_subscriptions")
      .selectAll();
  }

  register(key: string, value: PersistedWorkboardNotificationSubscription): void {
    if (value.version !== 1 || value.subscription.id !== key) {
      throw new Error("invalid workboard notification subscription payload");
    }
    const subscription = value.subscription;
    // Cursor fields must bind NULL when omitted, after native preparation succeeds.
    const { compiled, bind } = compileSqliteQueryBindings<void>((parameter) =>
      getNodeSqliteKysely<{ workboard_notification_subscriptions: Row }>(this.db)
        .insertInto("workboard_notification_subscriptions")
        .values({
          id: parameter(() => subscription.id),
          board_id: parameter(() => subscription.boardId),
          card_id: parameter(() => bindNull(subscription.cardId)),
          session_key: parameter(() => bindNull(subscription.sessionKey)),
          run_id: parameter(() => bindNull(subscription.runId)),
          target: parameter(() => bindNull(subscription.target)),
          wake_session_key: parameter(() => bindNull(subscription.wakeSessionKey)),
          event_kinds_json: parameter(() => jsonValue(subscription.eventKinds)),
          last_event_at: parameter(() => bindNull(subscription.lastEventAt)),
          last_event_id: parameter(() => bindNull(subscription.lastEventId)),
          last_event_sequence: parameter(() => bindNull(subscription.lastEventSequence)),
          delivered_event_ids_json: parameter(() => jsonValue(subscription.deliveredEventIds)),
          created_at: parameter(() => subscription.createdAt),
          updated_at: parameter(() => subscription.updatedAt),
        })
        .onConflict((conflict) =>
          conflict.column("id").doUpdateSet((eb) => ({
            board_id: eb.ref("excluded.board_id"),
            card_id: eb.ref("excluded.card_id"),
            session_key: eb.ref("excluded.session_key"),
            run_id: eb.ref("excluded.run_id"),
            target: eb.ref("excluded.target"),
            wake_session_key: eb.ref("excluded.wake_session_key"),
            event_kinds_json: eb.ref("excluded.event_kinds_json"),
            last_event_at: eb.ref("excluded.last_event_at"),
            last_event_id: eb.ref("excluded.last_event_id"),
            last_event_sequence: eb.ref("excluded.last_event_sequence"),
            delivered_event_ids_json: eb.ref("excluded.delivered_event_ids_json"),
            created_at: eb.ref("excluded.created_at"),
            updated_at: eb.ref("excluded.updated_at"),
          })),
        ),
    );
    this.db.prepare(compiled.sql).run(...bind());
  }

  deliverWakesIfCurrent(
    batch: WorkboardNotificationWakeBatch,
    nonce?: string,
  ): WorkboardNotificationWakeResult {
    if (!nonce) {
      throw new Error("Workboard wake requires its admitted worker operation.");
    }
    let matched = false;
    return withSqlitePostCommitPublications(this.db, () =>
      runSqliteImmediateTransactionSync(
        this.db,
        () => {
          const current = this.lookup(batch.expected.id)?.subscription;
          if (!current?.wakeSessionKey || !isDeepStrictEqual(current, batch.expected)) {
            return { matched: false, deliveredEventIds: [], unknownEventIds: [] };
          }
          requestSqliteWorkerOperationAdmission({
            stage: "transaction",
            facts: { nonce, subscription: current },
          });
          matched = true;
          const retained = new Set(batch.retainedEventKeys);
          const delivered = new Set(
            (current.deliveredEventIds ?? []).filter((key) => retained.has(key)),
          );
          const successful: string[] = [];
          for (const { key, notification } of batch.events) {
            if (delivered.has(key)) {
              continue;
            }
            const outcome = requestSqliteWorkerOperationEffect({ nonce, key, notification });
            if (typeof outcome !== "boolean") {
              throw new Error("Invalid Workboard wake effect outcome.");
            }
            if (outcome) {
              delivered.add(key);
              successful.push(key);
            }
          }
          const next = [...delivered];
          if (!isDeepStrictEqual(next, current.deliveredEventIds ?? [])) {
            executeSqliteQuerySync(
              this.db,
              getNodeSqliteKysely<{ workboard_notification_subscriptions: Row }>(this.db)
                .updateTable("workboard_notification_subscriptions")
                .set({ delivered_event_ids_json: jsonValue(next), updated_at: Date.now() })
                .where("id", "=", current.id),
            );
          }
          deferSqliteWorkerCommitReceipt(this.db, { nonce, deliveredEventIds: successful });
          return { matched: true, deliveredEventIds: successful, unknownEventIds: [] };
        },
        {
          withCommit: (commit) => {
            if (matched) {
              requestSqliteWorkerOperationAdmission({ stage: "commit", facts: { nonce } });
            }
            commit();
          },
        },
      ),
    );
  }

  advanceCursorIfCurrent(
    expected: WorkboardNotificationSubscription,
    cursor: WorkboardNotificationCursor,
  ): WorkboardNotificationSubscription | undefined {
    return runSqliteImmediateTransactionSync(this.db, () => {
      const entry = this.lookup(expected.id);
      if (!entry || !isDeepStrictEqual(entry.subscription, expected)) {
        return undefined;
      }
      const subscription = { ...entry.subscription, ...cursor, updatedAt: Date.now() };
      if (cursor.lastEventSequence === undefined) {
        delete subscription.lastEventSequence;
      }
      executeSqliteQuerySync(
        this.db,
        getNodeSqliteKysely<{ workboard_notification_subscriptions: Row }>(this.db)
          .updateTable("workboard_notification_subscriptions")
          .set({
            last_event_at: cursor.lastEventAt ?? null,
            last_event_id: cursor.lastEventId ?? null,
            last_event_sequence: cursor.lastEventSequence ?? null,
            updated_at: subscription.updatedAt,
          })
          .where("id", "=", expected.id),
      );
      return subscription;
    });
  }

  lookup(key: string): PersistedWorkboardNotificationSubscription | undefined {
    const row = executeSqliteQueryTakeFirstSync(this.db, this.rowsQuery.where("id", "=", key));
    return row ? readSubscription(row) : undefined;
  }

  delete(key: string): boolean {
    const result = this.db
      .prepare("DELETE FROM workboard_notification_subscriptions WHERE id = ?")
      .run(key);
    return result.changes > 0;
  }

  entries(
    options: Parameters<WorkboardSubscriptionStore["entries"]>[0] = {},
  ): Array<{ key: string; value: PersistedWorkboardNotificationSubscription }> {
    let query = this.rowsQuery;
    if (options.boardId) {
      query = query.where("board_id", "=", options.boardId);
    }
    if (options.cardId) {
      query = query.where("card_id", "=", options.cardId);
    }
    return Array.from(
      iterateSqliteQuerySync(this.db, query.orderBy("created_at", "asc").orderBy("id", "asc")),
      (row) => ({
        key: requiredString(row, "id"),
        value: readSubscription(row),
      }),
    );
  }
}
