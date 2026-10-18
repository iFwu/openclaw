import type * as NodeOs from "node:os";
import { getAiTransportHost } from "../host.js";
import type { Model } from "../types.js";

function loadNodeOs(): typeof NodeOs | null {
  if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) {
    return null;
  }
  return process.getBuiltinModule?.("node:os") ?? null;
}

// NEVER convert to top-level runtime imports - breaks browser/Vite builds
const os = loadNodeOs();

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";

export function assertCodexProxyTransportSupported(model: Model): void {
  if (getAiTransportHost().requiresManagedTransport(model)) {
    throw new Error(
      "codexProxyMode does not support managed request.proxy, request.tls, or localService; keep openai-responses for those routes",
    );
  }
}

export function resolveCodexUrl(baseUrl?: string, proxyMode = false): string {
  const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl.trim() : DEFAULT_CODEX_BASE_URL;
  if (proxyMode) {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase().replace(/\.+$/, "");
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      host === "chatgpt.com" ||
      host.endsWith(".chatgpt.com") ||
      host === "openai.com" ||
      host.endsWith(".openai.com")
    ) {
      throw new Error(
        "codexProxyMode requires a custom HTTP(S) baseUrl without credentials, query, or fragment; official OpenAI/ChatGPT hosts require OAuth mode",
      );
    }
    const path = url.pathname.replace(/\/+$/, "");
    url.pathname = path.endsWith("/responses") ? path : `${path}/responses`;
    return url.toString();
  }
  const normalized = raw.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) {
    return normalized;
  }
  if (normalized.endsWith("/codex")) {
    return `${normalized}/responses`;
  }
  return `${normalized}/codex/responses`;
}

export function resolveCodexWebSocketUrl(requestUrl: string): string {
  const url = new URL(requestUrl);
  if (url.protocol === "https:") {
    url.protocol = "wss:";
  }
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  }
  return url.toString();
}

export function createCodexRequestId(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto?.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `codex_${suffix}`;
  }
  throw new Error("Secure random request id generation is unavailable");
}

function buildBaseCodexHeaders(
  initHeaders: Record<string, string> | undefined,
  additionalHeaders: Record<string, string> | undefined,
  accountId: string | undefined,
  token: string,
): Headers {
  const headers = new Headers(initHeaders);
  for (const [key, value] of Object.entries(additionalHeaders || {})) {
    headers.set(key, value);
  }
  headers.set("Authorization", `Bearer ${token}`);
  if (accountId) {
    headers.set("chatgpt-account-id", accountId);
  } else {
    headers.delete("chatgpt-account-id");
  }
  headers.set("originator", "openclaw");
  const userAgent = os
    ? `openclaw (${os.platform()} ${os.release()}; ${os.arch()})`
    : "openclaw (browser)";
  headers.set("User-Agent", userAgent);
  return headers;
}

export function buildSSEHeaders(
  initHeaders: Record<string, string> | undefined,
  additionalHeaders: Record<string, string> | undefined,
  accountId: string | undefined,
  token: string,
  sessionId?: string,
): Headers {
  const headers = buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token);
  headers.set("OpenAI-Beta", "responses=experimental");
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");

  if (sessionId) {
    headers.set("session_id", sessionId);
    headers.set("x-client-request-id", sessionId);
  }

  return headers;
}

export function buildWebSocketHeaders(
  initHeaders: Record<string, string> | undefined,
  additionalHeaders: Record<string, string> | undefined,
  accountId: string | undefined,
  token: string,
  requestId: string,
): Headers {
  const headers = buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token);
  headers.delete("accept");
  headers.delete("content-type");
  headers.delete("OpenAI-Beta");
  headers.delete("openai-beta");
  headers.set("OpenAI-Beta", OPENAI_BETA_RESPONSES_WEBSOCKETS);
  headers.set("x-client-request-id", requestId);
  headers.set("session_id", requestId);
  return headers;
}
