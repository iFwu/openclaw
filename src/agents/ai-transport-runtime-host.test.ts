// Verifies package transports consume the route generation prepared on the model.
import { getAiTransportHost } from "@openclaw/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as ssrf from "../infra/net/ssrf.js";
import type { PluginMetadataSnapshotOwnerMaps } from "../plugins/plugin-metadata-snapshot.types.js";
import "./ai-transport-runtime-host.js";
import {
  attachModelProviderRequestRouteFacts,
  getModelProviderRequestRouteFacts,
  resolveProviderRequestPolicyConfig,
} from "./provider-request-config.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

function buildOwners(): PluginMetadataSnapshotOwnerMaps {
  const empty = new Map<string, readonly string[]>();
  return {
    channels: empty,
    channelConfigs: empty,
    providers: empty,
    modelCatalogProviders: empty,
    cliBackends: empty,
    setupProviders: empty,
    commandAliases: empty,
    contracts: empty,
    providerAuthContributions: [],
    modelIdNormalizationPolicies: new Map(),
    providerEndpoints: [
      { endpointClass: "openai-public", hosts: ["prepared.example"] },
      { endpointClass: "anthropic-public", hosts: ["projected.example"] },
    ],
    providerRequests: new Map([["openai", { family: "prepared-openai-family" }]]),
  };
}

describe("AI transport prepared provider routes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("prepares a configured compatible loopback origin without granting other private origins", async () => {
    for (const name of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
    ]) {
      vi.stubEnv(name, "");
    }
    vi.stubEnv("NO_PROXY", "*");
    vi.stubEnv("no_proxy", "*");
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", undefined);
    const model = makeProviderModelFixture<"openai-responses">({
      id: "fixture-model",
      provider: "compatible-gateway",
      api: "openai-responses",
      baseUrl: "http://127.0.0.1:8187/v1",
    });
    const prepare = getAiTransportHost().prepareResponsesWebSocket;
    if (!prepare) {
      throw new Error("missing guarded SDK WebSocket route owner");
    }
    const pin = vi.spyOn(ssrf, "resolvePinnedHostnameWithPolicy");
    const route = await prepare({ model, url: "ws://127.0.0.1:8187/v1/responses" });
    expect(pin).toHaveBeenCalledWith("127.0.0.1", expect.anything());
    expect(pin).toHaveBeenCalledTimes(1);
    const destroy = vi.spyOn(route.agent, "destroy");
    route.release();
    route.release();
    expect(destroy).toHaveBeenCalledTimes(1);
    await expect(prepare({ model, url: "ws://127.0.0.1:8188/v1/responses" })).rejects.toThrow(
      /private|loopback|blocked/iu,
    );
  });

  it("keeps headers, capabilities, and SSRF posture on the prepared metadata generation", () => {
    const model = attachModelProviderRequestRouteFacts(
      makeProviderModelFixture<"openai-responses">({
        id: "gpt-5.6-luna",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://prepared.example/v1",
      }),
      buildOwners(),
    );
    const host = getAiTransportHost();
    const headers = host.resolveProviderRequestHeaders({
      model,
      provider: model.provider,
      api: model.api,
      baseUrl: model.baseUrl,
    });
    const capabilities = host.resolveProviderRequestCapabilities({
      model,
      provider: model.provider,
      api: model.api,
      baseUrl: model.baseUrl,
      capability: "llm",
      transport: "stream",
    });
    const requestPolicy = resolveProviderRequestPolicyConfig({
      provider: model.provider,
      api: model.api,
      baseUrl: model.baseUrl,
      routeFacts: getModelProviderRequestRouteFacts(model),
      capability: "llm",
      transport: "stream",
    });

    expect(headers).toMatchObject({ originator: "openclaw" });
    expect(capabilities).toMatchObject({
      endpointClass: "openai-public",
      knownProviderFamily: "prepared-openai-family",
    });
    expect(requestPolicy.trustConfiguredBaseUrlOrigin).toBe(false);
  });

  it("re-resolves projected transport routes against the same metadata generation", () => {
    const owners = buildOwners();
    const source = attachModelProviderRequestRouteFacts(
      makeProviderModelFixture<"openai-responses">({
        id: "gpt-5.6-luna",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://prepared.example/v1",
      }),
      owners,
    );
    const projected = getAiTransportHost().inheritManagedTransport(source, {
      ...source,
      baseUrl: "https://projected.example/v1",
    });
    const routeFacts = getModelProviderRequestRouteFacts(projected);

    expect(routeFacts?.providerMetadataOwners).toBe(owners);
    expect(routeFacts?.capabilities.endpointClass).toBe("anthropic-public");
    expect(routeFacts?.providerOwner).toBe("anthropic-public");
  });
});
