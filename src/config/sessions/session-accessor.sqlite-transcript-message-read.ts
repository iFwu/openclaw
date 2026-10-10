import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { TranscriptMessageAppendOptions } from "./session-accessor.sqlite-contract.js";
import {
  findAssistantTranscriptEventInDatabase,
  readTranscriptEventId,
  readTranscriptEventMessage,
  readTranscriptIdentityByEventId,
} from "./session-accessor.sqlite-read.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { transcriptEventJsonSql } from "./transcript-payload.js";

// Committed keyed reads must not depend on append, repair, or CLI-history writers.
export function readIdempotencyKeyOwner(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
  idempotencyKey: string,
): { eventId: string; seq: number } | undefined {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_event_identities")
      .select(["event_id", "seq"])
      .where("session_id", "=", sessionId)
      .where("message_idempotency_key", "=", idempotencyKey)
      .orderBy("seq", "desc")
      .limit(1),
  );
  return row ? { eventId: row.event_id, seq: row.seq } : undefined;
}

export function readTranscriptMessageByScopedIdempotencyKey(
  database: Pick<OpenClawAgentDatabase, "db">,
  scope: ResolvedTranscriptScope,
  idempotencyKey: string,
  lookup: TranscriptMessageAppendOptions<unknown>["idempotencyLookup"],
): { messageId: string; message: unknown } | undefined {
  if (lookup !== "scan-assistant") {
    const identity = readIdempotencyKeyOwner(database, scope.sessionId, idempotencyKey);
    return identity ? readTranscriptMessageByIdentity(database, scope, identity) : undefined;
  }
  const found = findAssistantTranscriptEventInDatabase(database, scope.sessionId, idempotencyKey);
  if (!found) {
    return undefined;
  }
  const message = readTranscriptEventMessage(found.event);
  return message
    ? { messageId: readTranscriptEventId(found.event) ?? idempotencyKey, message }
    : undefined;
}

export function readTranscriptMessageByEventId(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  eventId: string,
): { messageId: string; message: unknown } | undefined {
  const identity = readTranscriptIdentityByEventId(database, scope.sessionId, eventId);
  return identity ? readTranscriptMessageByIdentity(database, scope, identity) : undefined;
}

function readTranscriptMessageByIdentity(
  database: Pick<OpenClawAgentDatabase, "db">,
  scope: ResolvedTranscriptScope,
  identity: { eventId: string; seq: number },
): { messageId: string; message: unknown } | undefined {
  const db = getSessionKysely(database.db);
  const eventRow = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select(transcriptEventJsonSql(database.db).as("event_json"))
      .where("session_id", "=", scope.sessionId)
      .where("seq", "=", identity.seq),
  );
  if (!eventRow) {
    return undefined;
  }
  // SAFETY: Canonical transcript identities index record envelopes; the message value stays unknown.
  const event = JSON.parse(eventRow.event_json) as { message?: unknown };
  return { messageId: identity.eventId, message: event.message };
}
