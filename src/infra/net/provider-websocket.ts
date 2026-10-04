// Provider WebSocket connector applies the same auth, proxy, TLS, and SSRF policy as provider HTTP.
import http from "node:http";
import type { Agent as HttpAgent } from "node:http";
import https from "node:https";
import { WebSocket } from "../../../packages/gateway-client/src/websocket.js";
import { resolveProviderTransportSsrFPolicy } from "../../agents/provider-transport-fetch.js";
import { buildTimeoutAbortSignal } from "../../utils/fetch-timeout.js";
import { racePromiseWithAbortSignal } from "../abort-signal.js";
import { isManagedProxyActive } from "./fetch-guard.js";
import { createNodeProxyAgent, resolveEnvNodeProxyUrlForTarget } from "./node-proxy-agent.js";
import { shouldUseEnvHttpProxyForUrl } from "./proxy-env.js";
import { resolveActiveManagedProxyTlsOptions } from "./proxy/active-managed-proxy-tls.js";
import {
  assertHostnameAllowedWithPolicy,
  resolvePinnedHostnameWithPolicy,
  resolveSsrFPolicyForUrl,
  type PinnedDispatcherPolicy,
  type SsrFPolicy,
} from "./ssrf.js";

const DEFAULT_PROVIDER_WEBSOCKET_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

type OpenProviderWebSocketParams = {
  allowPrivateNetwork: boolean;
  baseUrl: string;
  dispatcherPolicy?: PinnedDispatcherPolicy;
  headers?: HeadersInit;
  maxPayloadBytes?: number;
  signal?: AbortSignal;
  timeoutMs: number;
  trustConfiguredBaseUrlOrigin: boolean;
  url: string;
};

type PrepareProviderWebSocketAgentParams = Pick<
  OpenProviderWebSocketParams,
  | "allowPrivateNetwork"
  | "baseUrl"
  | "dispatcherPolicy"
  | "signal"
  | "trustConfiguredBaseUrlOrigin"
  | "url"
>;

function toHttpUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol === "ws:") {
    url.protocol = "http:";
  } else if (url.protocol === "wss:") {
    url.protocol = "https:";
  }
  return url.toString();
}

function targetTlsOptions(policy: PinnedDispatcherPolicy | undefined): Record<string, unknown> {
  return policy?.mode === "direct" || policy?.mode === "env-proxy" ? { ...policy.connect } : {};
}

function proxyPolicy(
  policy: SsrFPolicy | undefined,
  allowPrivateProxy: boolean,
): SsrFPolicy | undefined {
  if (!policy && !allowPrivateProxy) {
    return undefined;
  }
  return {
    ...policy,
    hostnameAllowlist: undefined,
    ...(allowPrivateProxy ? { allowPrivateNetwork: true } : {}),
  };
}

async function createProxyAgent(params: {
  policy: SsrFPolicy | undefined;
  proxyUrl: URL;
  proxyTls?: Record<string, unknown>;
  allowPrivateProxy: boolean;
  signal?: AbortSignal;
}): Promise<HttpAgent> {
  const pinnedProxy = await resolvePinnedHostnameWithPolicy(params.proxyUrl.hostname, {
    policy: proxyPolicy(params.policy, params.allowPrivateProxy),
    signal: params.signal,
  });
  return createNodeProxyAgent({
    mode: "explicit",
    proxyUrl: params.proxyUrl,
    proxyConnect: { ...params.proxyTls, lookup: pinnedProxy.lookup },
  });
}

async function createProviderWebSocketAgent(params: {
  dispatcherPolicy?: PinnedDispatcherPolicy;
  policy: SsrFPolicy | undefined;
  proxySsrFPolicy: SsrFPolicy | undefined;
  url: URL;
  signal?: AbortSignal;
}): Promise<HttpAgent> {
  const { dispatcherPolicy, policy, proxySsrFPolicy, url, signal } = params;
  const canDelegateEnvDns = shouldUseEnvHttpProxyForUrl(toHttpUrl(url.href));
  const useManagedProxy = isManagedProxyActive() && canDelegateEnvDns;
  const envProxyUrl =
    useManagedProxy || dispatcherPolicy?.mode !== "direct"
      ? resolveEnvNodeProxyUrlForTarget(url)
      : undefined;
  let proxyUrl: URL | undefined;
  if (dispatcherPolicy?.mode === "explicit-proxy") {
    try {
      proxyUrl = new URL(dispatcherPolicy.proxyUrl);
    } catch {
      throw new Error("Invalid explicit proxy URL");
    }
    if (proxyUrl.protocol !== "http:" && proxyUrl.protocol !== "https:") {
      throw new Error("Explicit proxy URL must use http or https");
    }
  } else if (dispatcherPolicy?.mode !== "direct") {
    proxyUrl = envProxyUrl;
  }
  if (useManagedProxy) {
    proxyUrl = envProxyUrl;
  }

  if (!proxyUrl) {
    const pinned = await resolvePinnedHostnameWithPolicy(url.hostname, { policy, signal });
    const options = {
      keepAlive: false,
      ...targetTlsOptions(dispatcherPolicy),
      lookup: pinned.lookup,
    };
    return url.protocol === "wss:" ? new https.Agent(options) : new http.Agent(options);
  }

  // Match guarded HTTP: configured proxies stay strict, while applicable
  // managed/ambient HTTP proxy routes own DNS. ALL_PROXY alone grants no trust.
  if (!useManagedProxy && (dispatcherPolicy || !canDelegateEnvDns)) {
    await resolvePinnedHostnameWithPolicy(url.hostname, { policy, signal });
  } else {
    assertHostnameAllowedWithPolicy(url.hostname, policy);
  }
  return await createProxyAgent({
    policy: proxySsrFPolicy,
    proxyUrl,
    proxyTls:
      !useManagedProxy &&
      (dispatcherPolicy?.mode === "explicit-proxy" || dispatcherPolicy?.mode === "env-proxy")
        ? dispatcherPolicy.proxyTls
        : resolveActiveManagedProxyTlsOptions({ proxyUrl: proxyUrl.href }),
    allowPrivateProxy:
      useManagedProxy ||
      dispatcherPolicy?.mode !== "explicit-proxy" ||
      dispatcherPolicy.allowPrivateProxy === true,
    signal,
  });
}

/** Prepares the same pinned provider route for SDKs that construct their own WebSocket. */
export async function prepareProviderWebSocketAgent(
  params: PrepareProviderWebSocketAgentParams,
): Promise<{ agent: HttpAgent; release: () => void }> {
  let url: URL;
  try {
    url = new URL(params.url);
  } catch {
    throw new Error("Invalid provider WebSocket URL");
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("Provider WebSocket URL must use ws or wss");
  }
  const requestUrl = new URL(toHttpUrl(url.toString()));
  const basePolicy = resolveProviderTransportSsrFPolicy({
    baseUrl: toHttpUrl(params.baseUrl),
    url: requestUrl.toString(),
    allowPrivateNetwork: params.allowPrivateNetwork,
    trustConfiguredBaseUrlOrigin: params.trustConfiguredBaseUrlOrigin,
  });
  // Origin trust belongs only to this target, never to a same-host proxy.
  const policy = resolveSsrFPolicyForUrl(requestUrl, basePolicy);
  params.signal?.throwIfAborted();
  const pending = createProviderWebSocketAgent({
    dispatcherPolicy: params.dispatcherPolicy,
    policy,
    proxySsrFPolicy: basePolicy,
    url,
    signal: params.signal,
  }).then((agent) => {
    let released = false;
    return {
      agent,
      release: () => {
        if (!released) {
          released = true;
          agent.destroy();
        }
      },
    };
  });
  void pending.then(
    (prepared) => params.signal?.aborted && prepared.release(),
    () => undefined,
  );
  const prepared = await racePromiseWithAbortSignal(pending, params.signal);
  try {
    params.signal?.throwIfAborted();
    return prepared;
  } catch (error) {
    prepared.release();
    throw error;
  }
}

/** Opens a provider WebSocket through the resolved request and network policy. */
export async function openProviderWebSocket(
  params: OpenProviderWebSocketParams,
): Promise<WebSocket> {
  let url: URL;
  try {
    url = new URL(params.url);
  } catch {
    throw new Error("Invalid provider WebSocket URL");
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("Provider WebSocket URL must use ws or wss");
  }
  // DNS preparation and the opening handshake share one deadline. Proxyline
  // owns pending proxy sockets and closes them when the request or agent ends.
  const { signal, cleanup } = buildTimeoutAbortSignal({
    signal: params.signal,
    timeoutMs: Math.max(1, params.timeoutMs),
    operation: "Provider WebSocket connection",
  });
  let prepared: Awaited<ReturnType<typeof prepareProviderWebSocketAgent>>;
  try {
    prepared = await prepareProviderWebSocketAgent({ ...params, signal });
  } catch (error) {
    cleanup();
    throw error;
  }
  let socket: WebSocket;
  try {
    signal?.throwIfAborted();
    socket = new WebSocket(url, {
      agent: prepared.agent,
      headers: Object.fromEntries(new Headers(params.headers).entries()),
      maxPayload: params.maxPayloadBytes ?? DEFAULT_PROVIDER_WEBSOCKET_MAX_PAYLOAD_BYTES,
      perMessageDeflate: false,
      ...targetTlsOptions(params.dispatcherPolicy),
    });
  } catch (error) {
    cleanup();
    prepared.release();
    throw error;
  }
  const onAbort = () => socket.terminate();
  signal?.addEventListener("abort", onAbort, { once: true });
  socket.once("open", cleanup);
  socket.once("close", () => {
    signal?.removeEventListener("abort", onAbort);
    cleanup();
    prepared.release();
  });
  return socket;
}
