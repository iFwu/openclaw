import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { classifyAgentRunTerminalOutcome } from "@openclaw/normalization-core/agent-run-terminal-outcome";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { Selectable } from "kysely";
import {
  isAgentEventLifecycleGenerationCurrent,
  registerAgentEventLifecycleRotationHandler,
} from "../../infra/agent-events.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import type {
  PersistedUserTurnMessage,
  UserTurnProcessingCompletion,
} from "../../sessions/user-turn-transcript.types.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { SessionPendingInputs } from "../../state/openclaw-agent-db.generated.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { hasSessionPendingInputsSchema } from "../../state/openclaw-agent-pending-inputs-schema.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { assertCapturedSessionEntryReadSource } from "./session-accessor.sqlite-exact-read.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { readTranscriptMessageByScopedIdempotencyKey } from "./session-accessor.sqlite-transcript-store.js";
import type { CapturedSessionEntryReadSource } from "./session-accessor.types.js";
import { SessionPendingInputCustodyError } from "./session-pending-input-custody-error.js";
import { normalizeStoreSessionKey } from "./store-entry.js";

export type SessionPendingInputState = "queued" | "interrupted" | "cancelled";
export type SessionPendingInput = {
  id: string;
  runId: string;
  message: PersistedUserTurnMessage;
  acceptedAt: number;
  state: SessionPendingInputState;
};
export type SessionPendingInputPage = {
  items: SessionPendingInput[];
  total: number;
  nextBefore?: number;
};
export type SessionPendingInputRow = Selectable<SessionPendingInputs>;
type PendingInputDatabase = Pick<OpenClawAgentDatabase, "db" | "path">;

export type SessionPendingInputOwner = {
  inputId: string;
  transcriptInputId: string;
  sessionId: string;
  sessionKey: string;
  databasePath: string;
  idempotencyKey: string;
  lifecycleGeneration: string;
  messageJson: string;
  config?: OpenClawConfig;
  assertCurrent: () => void;
  /** Published only after the exact input was consumed by a committed transcript write. */
  consumed?: true;
  consumedTranscriptInputId?: string;
  finish: (disposition: Exclude<SessionPendingInputState, "queued">) => void;
  retainCancelled?: () => boolean;
  restartRecovered?: true;
  /** Aggregate authority is the exact source closures, never persisted source identifiers. */
  sources?: readonly SessionPendingInputOwner[];
};

const owners = resolveGlobalSingleton(Symbol.for("openclaw.sessionPendingInputOwners"), () => ({
  live: new Map<string, SessionPendingInputOwner>(),
  current: new AsyncLocalStorage<SessionPendingInputOwner>(),
  relocation: new AsyncLocalStorage<{
    owner: SessionPendingInputOwner;
    sourceInputId: string;
  }>(),
  transactionRelocations: new WeakMap<DatabaseSync, Map<SessionPendingInputOwner, string>>(),
}));

const recoveredDedupeOwners = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionPendingInputDedupeRecoveries"),
  () => new WeakSet<SessionPendingInputOwner>(),
);

registerAgentEventLifecycleRotationHandler("session-pending-inputs", () => {
  const failures: unknown[] = [];
  for (const owner of owners.live.values()) {
    try {
      owner.finish("interrupted");
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, "Failed to record interrupted pending inputs");
  }
});

export function registerSessionPendingInputOwner(owner: SessionPendingInputOwner): void {
  if (owners.live.has(owner.inputId)) {
    throw new Error("Pending input already has a live owner");
  }
  owners.live.set(owner.inputId, owner);
}

function releaseSessionPendingInputOwner(owner: SessionPendingInputOwner): void {
  if (owners.live.get(owner.inputId) === owner) {
    owners.live.delete(owner.inputId);
  }
}

export function finishSessionPendingInputOwner(
  owner: SessionPendingInputOwner,
  disposition: Exclude<SessionPendingInputState, "queued">,
  source: CapturedSessionEntryReadSource,
  options: OpenClawAgentDatabaseOptions,
): boolean {
  // Release authority even if recording the terminal disposition fails.
  releaseSessionPendingInputOwner(owner);
  if (owner.consumed) {
    return false;
  }
  const capturedOptions = { ...options, agentId: source.agentId, path: source.path };
  assertCapturedSessionEntryReadSource(source, getOpenClawAgentDatabaseIfOpen(capturedOptions));
  return runOpenClawAgentWriteTransaction(
    (current) => {
      assertCapturedSessionEntryReadSource(source, current);
      const db = getSessionKysely(current.db);
      const exactInput = () =>
        db
          .selectFrom("session_pending_inputs")
          .select(["state", "consumed_event_id"])
          .where("input_id", "=", owner.inputId)
          .where("session_key", "=", owner.sessionKey)
          .where("session_id", "=", owner.sessionId)
          .where("lifecycle_generation", "=", owner.lifecycleGeneration)
          .where("message_json", "=", owner.messageJson);
      const before = executeSqliteQueryTakeFirstSync(current.db, exactInput());
      if (!before || before.consumed_event_id != null) {
        return false;
      }
      if (before.state === disposition) {
        return true;
      }
      if (before.state !== "queued") {
        return false;
      }
      executeSqliteQuerySync(
        current.db,
        db
          .updateTable("session_pending_inputs")
          .set({ state: disposition })
          .where("input_id", "=", owner.inputId)
          .where("session_key", "=", owner.sessionKey)
          .where("session_id", "=", owner.sessionId)
          .where("lifecycle_generation", "=", owner.lifecycleGeneration)
          .where("message_json", "=", owner.messageJson)
          .where("state", "=", "queued")
          .where("consumed_event_id", "is", null),
      );
      return executeSqliteQueryTakeFirstSync(current.db, exactInput())?.state === disposition;
    },
    capturedOptions,
    { operationLabel: "session.pending-input.finish-owner" },
  );
}

function assertPendingInputOwnerCurrent(owner: SessionPendingInputOwner): void {
  if (owner.sources) {
    for (const source of owner.sources) {
      assertPendingInputOwnerCurrent(source);
    }
    return;
  }
  if (
    owners.live.get(owner.inputId) !== owner ||
    !isAgentEventLifecycleGenerationCurrent(owner.lifecycleGeneration)
  ) {
    throw new SessionPendingInputCustodyError(
      "Pending input ownership ended; submit a new turn to continue",
    );
  }
  owner.assertCurrent();
}

export function runWithSessionPendingInput<T>(owner: SessionPendingInputOwner, run: () => T): T {
  assertPendingInputOwnerCurrent(owner);
  return owners.current.run(owner, run);
}

/** Promotion does not release execution custody to a different turn's orphan repair. */
export function assertSessionPendingInputTranscriptRepairAllowed(
  database: Pick<PendingInputDatabase, "path">,
  scope: Pick<ResolvedTranscriptScope, "sessionId" | "sessionKey">,
  entryId: string,
): void {
  const current = owners.current.getStore();
  const sessionKey = normalizeStoreSessionKey(scope.sessionKey);
  for (const owner of owners.live.values()) {
    if (
      owner.databasePath === database.path &&
      owner.sessionId === scope.sessionId &&
      owner.sessionKey === sessionKey &&
      owner.consumedTranscriptInputId === entryId &&
      isAgentEventLifecycleGenerationCurrent(owner.lifecycleGeneration) &&
      current !== owner &&
      !current?.sources?.includes(owner)
    ) {
      throw new Error(`Session transcript keyed user is outside the current turn: ${entryId}`);
    }
  }
}

/** Persistence alone may mirror a closed turn; the append owner proves exact committed bytes. */
export function runWithSessionPendingInputPersistence<T>(
  owner: SessionPendingInputOwner,
  persist: () => T,
): T {
  return owners.current.run(owner, persist);
}

/** A transcript rewrite may move only the exact current user owned by the live admitted turn. */
export function withSessionPendingInputRelocation<T>(
  sourceInputId: string,
  message: unknown,
  append: () => T,
): T {
  const owner = owners.current.getStore();
  const record = asOptionalRecord(message);
  const ownsSource = owner?.transcriptInputId === sourceInputId;
  const claimsOwner = record?.role === "user" && record.idempotencyKey === owner?.idempotencyKey;
  if (!owner || (!ownsSource && !claimsOwner)) {
    return append();
  }
  assertPendingInputOwnerCurrent(owner);
  if (JSON.stringify(message) !== owner.messageJson) {
    throw new Error("Pending input relocation does not match its admitted transcript entry");
  }
  return owners.relocation.run({ owner, sourceInputId }, append);
}

/** Registration owns disposition; execution and promotion check the private operational predicates. */
export function readSessionPendingInputOwnerIds(
  database: PendingInputDatabase,
  rows: readonly Pick<
    SessionPendingInputRow,
    "input_id" | "session_key" | "session_id" | "lifecycle_generation"
  >[],
): Set<string> {
  const candidates = rows.filter((row) => {
    const owner = owners.live.get(row.input_id);
    return (
      owner?.databasePath === database.path &&
      owner.sessionId === row.session_id &&
      owner.sessionKey === row.session_key &&
      owner.lifecycleGeneration === row.lifecycle_generation &&
      isAgentEventLifecycleGenerationCurrent(owner.lifecycleGeneration)
    );
  });
  if (!candidates.length) {
    return new Set();
  }
  const sessions = executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("session_nodes")
      .select(["session_key", "current_session_id"])
      .where("session_key", "in", [...new Set(candidates.map((row) => row.session_key))]),
  ).rows;
  const current = new Map(sessions.map((row) => [row.session_key, row.current_session_id]));
  return new Set(
    candidates
      .filter((row) => current.get(row.session_key) === row.session_id)
      .map((row) => row.input_id),
  );
}

export function parseSessionPendingInputMessage(messageJson: string): PersistedUserTurnMessage {
  const value: unknown = JSON.parse(messageJson);
  if (asOptionalRecord(value)?.role !== "user") {
    throw new Error("Pending input has an invalid persisted user message");
  }
  // SAFETY: only typed admission writes this JSON; parsing preserves its canonical message shape.
  return value as PersistedUserTurnMessage;
}

export function isFinalInputCompletion(outcome: UserTurnProcessingCompletion): boolean {
  return (
    outcome.reason === "completed" ||
    (outcome.reason === "superseded" && outcome.inputConsumed === true) ||
    (outcome.reason === "cancelled" && outcome.stopReason !== "restart")
  );
}

type SessionInputCompletionScope = Pick<ResolvedTranscriptScope, "sessionId" | "sessionKey"> & {
  idempotencyKey: string;
};

export function readSessionInputCompletion(
  database: PendingInputDatabase,
  scope: SessionInputCompletionScope,
) {
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("session_input_completions")
      .selectAll()
      .where("session_key", "=", scope.sessionKey)
      .where("session_id", "=", scope.sessionId)
      .where("idempotency_key", "=", scope.idempotencyKey),
  );
  if (!row) {
    return undefined;
  }
  // SAFETY: only writeSessionInputCompletion writes this feature-owned table with typed terminal outcomes.
  const outcome = JSON.parse(row.outcome_json) as UserTurnProcessingCompletion;
  return { ...row, outcome };
}

/** The caller holds the write transaction and has revalidated the exact live admission owner. */
export function writeSessionInputCompletion(
  database: PendingInputDatabase,
  scope: ResolvedTranscriptScope &
    SessionInputCompletionScope & {
      runId: string;
      requestHash: string;
      lifecycleGeneration: string;
    },
  incoming: UserTurnProcessingCompletion,
): UserTurnProcessingCompletion {
  const retained = readSessionInputCompletion(database, scope);
  if (retained && isFinalInputCompletion(retained.outcome)) {
    return retained.outcome;
  }
  // Only committed keyed input can discharge a superseded continuation. A
  // replay receipt may still say queued, and callers cannot assert this fact.
  const outcome: UserTurnProcessingCompletion = {
    ...incoming,
    inputConsumed:
      incoming.reason === "superseded" &&
      readTranscriptMessageByScopedIdempotencyKey(database, scope, scope.idempotencyKey, "scan")
        ? true
        : undefined,
  };
  const succeeded = classifyAgentRunTerminalOutcome(outcome) === "success";
  executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .insertInto("session_input_completions")
      .values({
        session_key: scope.sessionKey,
        session_id: scope.sessionId,
        idempotency_key: scope.idempotencyKey,
        run_id: scope.runId,
        request_hash: scope.requestHash,
        outcome_json: JSON.stringify(outcome),
        succeeded: succeeded ? 1 : 0,
        completed_at: Date.now(),
      })
      .onConflict((conflict) =>
        conflict
          .columns(["session_id", "idempotency_key"])
          .doUpdateSet({
            outcome_json: JSON.stringify(outcome),
            succeeded: succeeded ? 1 : 0,
            completed_at: Date.now(),
          })
          .where("session_input_completions.succeeded", "=", 0),
      ),
  );
  if (isFinalInputCompletion(outcome)) {
    // Handled hooks can finish without appending a user message. The completion
    // receipt retires that exact custody atomically in the caller's transaction.
    executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .deleteFrom("session_pending_inputs")
        .where("session_key", "=", scope.sessionKey)
        .where("session_id", "=", scope.sessionId)
        .where("idempotency_key", "=", scope.idempotencyKey)
        .where("run_id", "=", scope.runId)
        .where("request_hash", "=", scope.requestHash)
        .where("lifecycle_generation", "=", scope.lifecycleGeneration),
    );
  }
  return outcome;
}

export function projectSessionPendingInput(row: SessionPendingInputRow): SessionPendingInput {
  if (row.state !== "queued" && row.state !== "interrupted" && row.state !== "cancelled") {
    throw new Error("Pending input has an invalid disposition");
  }
  return {
    id: row.input_id,
    runId: row.run_id,
    message: parseSessionPendingInputMessage(row.message_json),
    acceptedAt: row.accepted_at,
    state: row.state,
  };
}

/** Only a current recovered source can supersede its previous request receipt, once. */
export function claimCurrentSessionPendingInputDedupeRecovery(
  database: PendingInputDatabase,
  scope: Pick<ResolvedTranscriptScope, "sessionId" | "sessionKey">,
  runId: string,
): boolean {
  const owner = owners.current.getStore();
  if (
    !owner ||
    owner.sources ||
    owner.restartRecovered !== true ||
    recoveredDedupeOwners.has(owner) ||
    owner.databasePath !== database.path ||
    owner.sessionId !== scope.sessionId ||
    owner.sessionKey !== scope.sessionKey ||
    owner.idempotencyKey !== `${runId}:user`
  ) {
    return false;
  }
  assertPendingInputOwnerCurrent(owner);
  const row = readSessionPendingInputByKey(database, scope, owner.idempotencyKey);
  const current = Boolean(
    row &&
    row.input_id === owner.inputId &&
    row.run_id === runId &&
    row.message_json === owner.messageJson &&
    row.state === "queued" &&
    row.consumed_event_id == null &&
    readSessionPendingInputOwnerIds(database, [row]).has(owner.inputId),
  );
  if (current) {
    recoveredDedupeOwners.add(owner);
  }
  return current;
}

/** Query only the exact physical transcript; copied keys cannot adopt another generation. */
export function readSessionPendingInputByKey(
  database: PendingInputDatabase,
  scope: Pick<ResolvedTranscriptScope, "sessionId" | "sessionKey">,
  idempotencyKey: string,
): SessionPendingInputRow | undefined {
  if (!hasSessionPendingInputsSchema(database.db)) {
    return undefined;
  }
  return executeSqliteQueryTakeFirstSync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("session_pending_inputs")
      .selectAll()
      .where("session_id", "=", scope.sessionId)
      .where("session_key", "=", scope.sessionKey)
      .where("idempotency_key", "=", idempotencyKey),
  );
}

export type SessionPendingInputAppend = {
  inputId: string;
  message: PersistedUserTurnMessage;
  alreadyPromoted: boolean;
  sourceInputIds?: readonly string[];
  stageRelocation?: (destinationInputId: string) => void;
};

/** The private call-path owner, not a copied id or durable row, permits promotion. */
export function resolveSessionPendingInputAppend(
  database: PendingInputDatabase,
  scope: ResolvedTranscriptScope,
  message: unknown,
): SessionPendingInputAppend | undefined {
  const record = asOptionalRecord(message);
  if (record?.role !== "user" || typeof record.idempotencyKey !== "string") {
    return undefined;
  }
  const idempotencyKey = record.idempotencyKey.trim();
  const row = readSessionPendingInputByKey(database, scope, idempotencyKey);
  const owner = owners.current.getStore();
  // A bound-session mirror shares source correlation, never its pending custody.
  const ownsInput =
    owner?.idempotencyKey === idempotencyKey &&
    owner.databasePath === database.path &&
    owner.sessionId === scope.sessionId &&
    owner.sessionKey === scope.sessionKey;
  if (!row && !ownsInput) {
    return undefined;
  }
  if (
    !owner ||
    !ownsInput ||
    (row &&
      (row.input_id !== owner.inputId ||
        row.consumed_event_id != null ||
        row.state !== "queued" ||
        row.lifecycle_generation !== owner.lifecycleGeneration))
  ) {
    throw new SessionPendingInputCustodyError(
      "Pending input cannot be appended outside its admitted turn",
    );
  }
  const relocation = owners.relocation.getStore();
  const transactionRelocations = owners.transactionRelocations.get(database.db);
  const transcriptInputId = transactionRelocations?.get(owner) ?? owner.transcriptInputId;
  if (relocation?.owner === owner && relocation.sourceInputId !== transcriptInputId) {
    throw new Error("Pending input relocation does not match its admitted transcript entry");
  }
  const stageRelocation =
    relocation?.owner === owner
      ? (destinationInputId: string) => {
          let staged = owners.transactionRelocations.get(database.db);
          const hadPrevious = staged?.has(owner) ?? false;
          const previous = staged?.get(owner);
          if (
            !stageSqliteTransactionState(database.db, {
              stage: () => {
                staged ??= new Map();
                owners.transactionRelocations.set(database.db, staged);
                staged.set(owner, destinationInputId);
              },
              rollback: () => {
                if (hadPrevious && previous !== undefined) {
                  staged?.set(owner, previous);
                } else {
                  staged?.delete(owner);
                }
                if (staged?.size === 0) {
                  owners.transactionRelocations.delete(database.db);
                }
              },
              commit: () => {
                owner.transcriptInputId = destinationInputId;
                for (const source of owner.sources ?? [owner]) {
                  source.consumedTranscriptInputId = destinationInputId;
                }
                if (staged?.get(owner) === destinationInputId) {
                  staged.delete(owner);
                }
                if (staged?.size === 0) {
                  owners.transactionRelocations.delete(database.db);
                }
              },
            })
          ) {
            throw new Error("Pending input relocation requires a transcript write transaction");
          }
        }
      : undefined;
  if (owner.sources) {
    const acceptedByKey = new Map(
      executeSqliteQuerySync(
        database.db,
        getSessionKysely(database.db)
          .selectFrom("session_pending_inputs")
          .selectAll()
          .where("session_id", "=", scope.sessionId)
          .where("session_key", "=", scope.sessionKey)
          .where(
            "idempotency_key",
            "in",
            owner.sources.map((source) => source.idempotencyKey),
          ),
      ).rows.map((sourceRow) => [sourceRow.idempotency_key, sourceRow]),
    );
    const sources = owner.sources.map((source) => {
      const accepted = acceptedByKey.get(source.idempotencyKey);
      if (
        !accepted ||
        accepted.input_id !== source.inputId ||
        accepted.lifecycle_generation !== source.lifecycleGeneration ||
        accepted.message_json !== source.messageJson
      ) {
        throw new SessionPendingInputCustodyError(
          "Collected input custody changed before transcript promotion",
        );
      }
      return accepted;
    });
    const alreadyPromoted = sources.every((source) => source.consumed_event_id === owner.inputId);
    if (!alreadyPromoted) {
      if (sources.some((source) => source.consumed_event_id != null || source.state !== "queued")) {
        throw new SessionPendingInputCustodyError(
          "Collected input custody ended before transcript promotion",
        );
      }
      assertPendingInputOwnerCurrent(owner);
    }
    return {
      inputId: transcriptInputId,
      message: parseSessionPendingInputMessage(owner.messageJson),
      alreadyPromoted,
      sourceInputIds: sources.map((source) => source.input_id),
      ...(alreadyPromoted && stageRelocation ? { stageRelocation } : {}),
    };
  }
  // Terminal mirroring may replay a consumed input after cancellation. The caller
  // must prove the existing message; this never permits a new append.
  if (row) {
    assertPendingInputOwnerCurrent(owner);
  }
  return {
    inputId: transcriptInputId,
    message: parseSessionPendingInputMessage(row?.message_json ?? owner.messageJson),
    alreadyPromoted: !row,
    ...(!row && stageRelocation ? { stageRelocation } : {}),
  };
}

export function consumeSessionPendingInput(
  database: PendingInputDatabase,
  pending: SessionPendingInputAppend,
): void {
  if (pending.alreadyPromoted) {
    return;
  }
  const owner = owners.current.getStore();
  const inputIds = new Set(pending.sourceInputIds ?? [pending.inputId]);
  const consumedOwners = (owner?.sources ?? (owner ? [owner] : [])).filter(
    (candidate) =>
      owners.live.get(candidate.inputId) === candidate &&
      candidate.databasePath === database.path &&
      inputIds.has(candidate.inputId),
  );
  if (pending.sourceInputIds) {
    const updated = executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .updateTable("session_pending_inputs")
        .set({ consumed_event_id: pending.inputId })
        .where("input_id", "in", [...pending.sourceInputIds])
        .where("state", "=", "queued")
        .where("consumed_event_id", "is", null),
    );
    if (updated.numAffectedRows !== BigInt(pending.sourceInputIds.length)) {
      throw new SessionPendingInputCustodyError(
        "Collected input custody changed during transcript promotion",
      );
    }
  } else {
    const deleted = executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .deleteFrom("session_pending_inputs")
        .where("input_id", "=", pending.inputId)
        .where("state", "=", "queued"),
    );
    if (deleted.numAffectedRows !== 1n) {
      return;
    }
  }
  // Outer commit publishes this fact before observers; rollback leaves finish responsible.
  stageSqliteTransactionState(database.db, {
    stage: () => {},
    rollback: () => {},
    commit: () => {
      for (const consumedOwner of consumedOwners) {
        consumedOwner.consumed = true;
        consumedOwner.consumedTranscriptInputId = pending.inputId;
      }
    },
  });
}

/** Logical deletion also clears custody when transcript windows are retained. */
export function deleteSessionPendingInputs(
  database: PendingInputDatabase,
  sessionKey: string,
): void {
  if (hasSessionPendingInputsSchema(database.db)) {
    executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .deleteFrom("session_pending_inputs")
        .where("session_key", "=", sessionKey),
    );
  }
}
