import {
  configureAiTransportHost,
  getAiTransportHost,
  type AiProviderRequestCapabilities,
} from "@openclaw/ai";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import "../llm/ai-transport-host.js";
import { prepareProviderWebSocketAgent } from "../infra/net/provider-websocket.js";
import { getModelProviderRuntimePluginHandle } from "../plugins/provider-hook-runtime.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import {
  resolveProviderStreamFn,
  resolveProviderTransportTurnStateWithPlugin,
  wrapProviderSimpleCompletionStreamFn,
} from "../plugins/provider-runtime.js";
import { createAnthropicVertexStreamFnForModel } from "./anthropic-vertex-stream.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./copilot-dynamic-headers.js";
import { ensureCustomApiRegistered } from "./custom-api-registry.js";
import { resolveModelExtraParamSources } from "./model-extra-params.js";
import { createOpenAIPayloadPolicyWrapper } from "./openai-payload-policy.js";
import { resolveProviderRequestCapabilities } from "./provider-attribution.js";
import {
  attachModelProviderLocalService,
  getModelProviderLocalService,
} from "./provider-local-service.js";
import {
  attachModelProviderRequestTransport,
  buildProviderRequestDispatcherPolicy,
  getModelProviderRequestTransport,
  getModelProviderRequestRouteFacts,
  inheritModelProviderRequestRouteFacts,
  resolveProviderRequestPolicyConfig,
} from "./provider-request-config.js";
import { transformTransportMessages } from "./transport-message-transform.js";

let configured = false;

/** Installs the agent and plugin ports only on paths that execute provider runtime. */
export function configureAiTransportRuntimeHost(): void {
  if (configured) {
    return;
  }
  const host = getAiTransportHost();
  configureAiTransportHost({
    ...host,
    plugin: {
      ...host.plugin,
      resolveProviderStream: (params) =>
        resolveProviderStreamFn({
          ...params,
          config: params.config as OpenClawConfig | undefined,
          runtimeHandle: getModelProviderRuntimePluginHandle(params.context.model),
          context: {
            ...params.context,
            config: params.context.config as OpenClawConfig | undefined,
            model: params.context.model as ProviderRuntimeModel,
          },
        }),
      resolveTransportTurnState: (params) =>
        resolveProviderTransportTurnStateWithPlugin({
          ...params,
          config: params.config as OpenClawConfig | undefined,
          runtimeHandle: getModelProviderRuntimePluginHandle(params.context.model),
          context: {
            ...params.context,
            model: params.context.model as ProviderRuntimeModel | undefined,
          },
        }),
      wrapSimpleCompletionStream: (params) => {
        const config = params.config as OpenClawConfig | undefined;
        const providerStreamFn = wrapProviderSimpleCompletionStreamFn({
          ...params,
          config,
          runtimeHandle: getModelProviderRuntimePluginHandle(params.context.model),
          context: {
            ...params.context,
            config: params.context.config as OpenClawConfig | undefined,
            model: params.context.model as ProviderRuntimeModel,
          },
        });
        const baseStreamFn = providerStreamFn ?? params.context.streamFn;
        const sourceApi = params.context.sourceApi ?? params.context.model.api;
        if (sourceApi !== "openai-completions" && sourceApi !== "openai-responses") {
          return providerStreamFn;
        }
        const { defaultParams, modelParams, agentModelParams, agentParams } =
          resolveModelExtraParamSources({
            config,
            provider: params.provider,
            modelId: params.context.modelId,
            agentId: params.context.agentId,
          });
        return createOpenAIPayloadPolicyWrapper(baseStreamFn, [
          defaultParams,
          modelParams,
          agentModelParams,
          agentParams,
        ]);
      },
      createAnthropicVertexStream: createAnthropicVertexStreamFnForModel,
    },
    buildCopilotDynamicHeaders: (messages) =>
      buildCopilotDynamicHeaders({ messages, hasImages: hasCopilotVisionInput(messages) }),
    resolveProviderRequestCapabilities: (input) =>
      (getModelProviderRequestRouteFacts(input.model ?? {})?.capabilities ??
        resolveProviderRequestCapabilities(input)) as AiProviderRequestCapabilities,
    resolveProviderRequestHeaders: (input) =>
      resolveProviderRequestPolicyConfig({
        ...input,
        routeFacts: getModelProviderRequestRouteFacts(input.model ?? {}),
        capability: "llm",
        transport: "stream",
      }).headers,
    requiresManagedTransport: (model) => {
      const request = getModelProviderRequestTransport(model);
      return Boolean(request?.proxy || request?.tls || getModelProviderLocalService(model));
    },
    prepareResponsesWebSocket: ({ model, url, signal }) => {
      const requestConfig = resolveProviderRequestPolicyConfig({
        provider: model.provider,
        api: model.api,
        baseUrl: model.baseUrl,
        routeFacts: getModelProviderRequestRouteFacts(model),
        request: getModelProviderRequestTransport(model),
        capability: "llm",
        transport: "websocket",
      });
      return prepareProviderWebSocketAgent({
        baseUrl: model.baseUrl,
        url,
        allowPrivateNetwork: requestConfig.allowPrivateNetwork,
        trustConfiguredBaseUrlOrigin: requestConfig.trustConfiguredBaseUrlOrigin,
        dispatcherPolicy: buildProviderRequestDispatcherPolicy(requestConfig),
        signal,
      });
    },
    inheritManagedTransport: (source, target) =>
      inheritModelProviderRequestRouteFacts(
        source,
        attachModelProviderLocalService(
          attachModelProviderRequestTransport(target, getModelProviderRequestTransport(source)),
          getModelProviderLocalService(source),
        ),
      ),
    transformTransportMessages,
    registerCustomApi: ensureCustomApiRegistered,
  });
  configured = true;
}

configureAiTransportRuntimeHost();
