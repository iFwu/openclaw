import type { Agent as HttpAgent } from "node:http";
import type { Model } from "@openclaw/llm-core";
import type OpenAI from "openai";
import { ResponsesWS } from "openai/resources/responses/ws.js";
import { getAiTransportHost, resolveAiTransportHeaderSentinels } from "../host.js";
import {
  supportsNativeOpenAIResponsesEndpoint,
  supportsOpenAIResponsesWebSocketEndpoint,
} from "./openai-responses-websocket-endpoint.js";
import { sha256Hex } from "./transport-utils.js";

export function combineWebSocketTimeoutSignal(
  signal: AbortSignal,
  model: Model,
  timeoutMs: number | undefined,
) {
  const resolvedTimeoutMs =
    timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : getAiTransportHost().resolveModelRequestTimeoutMs(model);
  if (resolvedTimeoutMs === undefined || !Number.isFinite(resolvedTimeoutMs)) {
    return signal;
  }
  return AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, resolvedTimeoutMs))]);
}

export type PreparedResponsesWebSocketRoute = {
  agent: HttpAgent;
  url: string;
  release(): void;
};

const socketRouteReleases = new WeakMap<ResponsesWS, () => void>();

export function closeWebSocketSilently(socket: ResponsesWS, reason = "done"): void {
  try {
    socket.close({ code: 1000, reason });
  } catch {}
  socketRouteReleases.get(socket)?.();
  socketRouteReleases.delete(socket);
}

export type PreparedWebSocketConnection = {
  client: OpenAI;
  headers: Record<string, string>;
  identity: string;
  route?: PreparedResponsesWebSocketRoute;
};

export function prepareWebSocketConnection(
  client: OpenAI,
  headers: Record<string, string> | undefined,
  route?: PreparedResponsesWebSocketRoute,
): PreparedWebSocketConnection {
  if (route) {
    if (
      !supportsOpenAIResponsesWebSocketEndpoint({
        provider: "compatible",
        api: "openai-responses",
        baseUrl: client.baseURL,
        compat: { supportsResponsesWebSocket: true },
      })
    ) {
      throw new Error("Invalid guarded Responses WebSocket endpoint");
    }
    const effective = new URL(client.buildURL("/responses", {}, undefined));
    if (
      !supportsOpenAIResponsesWebSocketEndpoint({
        provider: "compatible",
        api: "openai-responses",
        baseUrl: effective.href,
        compat: { supportsResponsesWebSocket: true },
      })
    ) {
      throw new Error("Invalid effective guarded Responses WebSocket endpoint");
    }
    effective.protocol = effective.protocol === "https:" ? "wss:" : "ws:";
    if (effective.href !== route.url) {
      throw new Error("Prepared Responses WebSocket route does not match the SDK endpoint");
    }
  } else if (
    !supportsNativeOpenAIResponsesEndpoint({
      provider: "openai",
      api: "openai-responses",
      baseUrl: client.baseURL,
    })
  ) {
    throw new Error(
      "OpenAI Responses WebSocket requires the official API endpoint or a guarded route",
    );
  }
  if (typeof client.apiKey !== "string" || client.apiKey.length === 0) {
    throw new Error("OpenAI Responses WebSocket requires an API key");
  }
  const resolvedApiKey = getAiTransportHost().resolveSecretSentinel(client.apiKey);
  const resolvedHeaders = { ...resolveAiTransportHeaderSentinels(headers) };
  for (const key of Object.keys(resolvedHeaders)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === "authorization" || normalizedKey === "traceparent") {
      delete resolvedHeaders[key];
    }
  }
  if (!resolvedApiKey) {
    throw new Error("OpenAI Responses WebSocket requires a resolved API key");
  }
  // The SDK's default headers can override API-key auth. Snapshot its final
  // handshake policy, resolve protected values, and use that same snapshot for
  // both the cloned client and socket identity.
  const resolvedClientBase = client.withOptions({ apiKey: resolvedApiKey });
  const finalHeaders = new Headers(
    resolveAiTransportHeaderSentinels(
      // The installed OpenAI SDK exposes its handshake merge contract under this exact name.
      // eslint-disable-next-line no-underscore-dangle
      resolvedClientBase._buildWebSocketHeaders({ Authorization: `Bearer ${resolvedApiKey}` }),
    ),
  );
  for (const [name, value] of Object.entries(resolvedHeaders)) {
    finalHeaders.set(name, value);
  }
  finalHeaders.delete("traceparent");
  const handshakeHeaders = Object.fromEntries(finalHeaders);
  const resolvedClient = client.withOptions({
    apiKey: resolvedApiKey,
    defaultHeaders: { ...handshakeHeaders, traceparent: null },
  });
  return {
    client: resolvedClient,
    headers: resolvedHeaders,
    route,
    identity: sha256Hex(
      JSON.stringify([
        resolvedApiKey,
        client.baseURL,
        Object.entries(handshakeHeaders).toSorted(([a], [b]) => a.localeCompare(b)),
      ]),
    ),
  };
}

export function createWebSocket(
  connection: PreparedWebSocketConnection,
  onError: (socket: ResponsesWS) => void,
): ResponsesWS {
  // openai's dual ESM declaration paths give the same runtime client two nominal
  // private-field types under NodeNext resolution. The SDK constructor receives
  // the actual OpenAI instance; bridge only that declaration mismatch here.
  let released = false;
  const releaseRoute = () => {
    if (!released) {
      released = true;
      connection.route?.release();
    }
  };
  let socket: ResponsesWS;
  try {
    socket = new ResponsesWS(
      connection.client as unknown as ConstructorParameters<typeof ResponsesWS>[0],
      {
        headers: connection.headers,
        maxQueueSize: 1,
        ...(connection.route ? { agent: connection.route.agent } : {}),
      },
    );
  } catch (error) {
    releaseRoute();
    throw error;
  }
  socketRouteReleases.set(socket, releaseRoute);
  if (connection.route) {
    socket.on("close", releaseRoute);
  }
  // The SDK async iterator removes its own listeners after every response while
  // cached sockets remain open. Keep one lifetime listener so an idle socket
  // failure is handled rather than becoming an unhandled SDK rejection.
  socket.on("error", () => onError(socket));
  return socket;
}

export function retainResponsesWebSocketRoute(
  route: PreparedResponsesWebSocketRoute | undefined,
): PreparedResponsesWebSocketRoute | undefined {
  if (!route) {
    return undefined;
  }
  let released = false;
  return {
    ...route,
    release: () => {
      if (!released) {
        released = true;
        route.release();
      }
    },
  };
}

export async function prepareCompatibleResponsesWebSocketRoute(
  client: OpenAI,
  model: Model,
  signal: AbortSignal,
): Promise<PreparedResponsesWebSocketRoute> {
  const prepare = getAiTransportHost().prepareResponsesWebSocket;
  if (!prepare) {
    throw new Error("Missing host-guarded Responses WebSocket route");
  }
  const url = new URL(client.buildURL("/responses", {}, undefined));
  if (!supportsOpenAIResponsesWebSocketEndpoint({ ...model, baseUrl: url.href })) {
    throw new Error("Invalid effective compatible Responses WebSocket endpoint");
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const route = await prepare({ model, url: url.href, signal });
  const retained = retainResponsesWebSocketRoute({ ...route, url: url.href });
  if (!retained) {
    throw new Error("Missing prepared Responses route");
  }
  try {
    signal.throwIfAborted();
    return retained;
  } catch (error) {
    retained.release();
    throw error;
  }
}

export function resolveOpenAIResponsesWebSocketMode(
  model: Model,
  transport: "sse" | "websocket" | "websocket-cached" | "auto" | undefined,
): "websocket" | "websocket-cached" | "auto" | undefined {
  if (transport !== "websocket" && transport !== "websocket-cached" && transport !== "auto") {
    return undefined;
  }
  if (getAiTransportHost().requiresManagedTransport(model)) {
    return undefined;
  }
  return supportsOpenAIResponsesWebSocketEndpoint(model) ? transport : undefined;
}
