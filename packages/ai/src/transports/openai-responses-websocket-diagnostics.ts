import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sha256Hex } from "./transport-utils.js";

const diagnosticErrorNames = new Set([
  "Error",
  "TypeError",
  "AbortError",
  "TimeoutError",
  "APIConnectionError",
  "APIConnectionTimeoutError",
  "OpenAIError",
  "OpenAIResponsesWebSocketServerError",
  "OpenAIResponsesWebSocketSafeRetryError",
]);
const diagnosticErrorCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "ABORT_ERR",
  "previous_response_not_found",
  "websocket_connection_limit_reached",
  "invalid_encrypted_content",
  "thinking_signature_invalid",
  "server_error",
  "upstream_unavailable",
  "upstream_timeout",
  "concurrency_queue_full",
  "concurrency_queue_timeout",
  "rate_limit_exceeded",
]);

export function summarizeWebSocketFailureCause(error: unknown): Record<string, unknown> {
  const causes: Array<{ name: string; code?: string; status?: number }> = [];
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 4 && isRecord(current) && !seen.has(current); depth++) {
    seen.add(current);
    const diagnostic: (typeof causes)[number] = {
      name:
        typeof current.name === "string" && diagnosticErrorNames.has(current.name)
          ? current.name
          : "other",
      code:
        typeof current.code === "string"
          ? diagnosticErrorCodes.has(current.code)
            ? current.code
            : "other"
          : undefined,
    };
    const status = current.status;
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
      diagnostic.status = status;
    }
    causes.push(diagnostic);
    current = current.cause;
  }
  return { causes };
}

const knownDiagnosticEvents = new Set([
  "response.created",
  "response.queued",
  "response.in_progress",
  "response.completed",
  "response.incomplete",
  "response.failed",
  "response.output_item.added",
  "response.output_item.done",
  "response.content_part.added",
  "response.content_part.done",
  "response.output_text.delta",
  "response.output_text.done",
  "response.reasoning_summary_text.delta",
  "response.reasoning_summary_text.done",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
  "response.steer.accepted",
  "response.steer.rejected",
  "error",
]);

export function createWebSocketFailureDiagnostics(params: {
  sessionId?: string;
  previousResponseId?: string;
  reusedConnection: boolean;
  connectionCreatedAt?: number;
}) {
  const startedAt = Date.now();
  const identity = {
    sessionIdHash: params.sessionId ? sha256Hex(params.sessionId) : undefined,
    previousResponseIdHash: params.previousResponseId
      ? sha256Hex(params.previousResponseId)
      : undefined,
    reusedConnection: params.reusedConnection,
  };
  let lastEventAt: number | undefined;
  let lastEvent: string | undefined;
  let responseIdHash: string | undefined;
  let responseObserved = false;
  let eventsReceived = 0;
  let closeCode: number | undefined;
  let closeReasonPresent = false;
  return {
    observe(message: { type: string; code?: number; reason?: string; message?: unknown }) {
      if (message.type === "close") {
        closeCode =
          typeof message.code === "number" &&
          Number.isInteger(message.code) &&
          message.code >= 1000 &&
          message.code <= 4999
            ? message.code
            : undefined;
        closeReasonPresent = Boolean(message.reason);
      }
      if (message.type === "error") {
        lastEvent = "error";
      }
      const event = message.type === "message" ? message.message : undefined;
      if (isRecord(event) && typeof event.type === "string") {
        eventsReceived++;
        lastEventAt = Date.now();
        // Peer-supplied strings never become unbounded diagnostic text.
        lastEvent = knownDiagnosticEvents.has(event.type) ? event.type : "other";
        if (isRecord(event.response)) {
          responseObserved = true;
          if (typeof event.response.id === "string") {
            responseIdHash = sha256Hex(event.response.id);
          }
        }
      }
    },
    snapshot(error: unknown) {
      const now = Date.now();
      return {
        ...identity,
        responseIdHash,
        responseObserved,
        eventsReceived,
        lastEvent,
        elapsedMs: now - startedAt,
        idleMs: now - (lastEventAt ?? startedAt),
        closeCode,
        closeReasonPresent,
        connectionAgeMs:
          params.connectionCreatedAt === undefined ? undefined : now - params.connectionCreatedAt,
        ...summarizeWebSocketFailureCause(error),
      };
    },
  };
}
