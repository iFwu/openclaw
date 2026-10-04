import { describe, expect, it } from "vitest";
import type { Model, SimpleStreamOptions } from "../../llm/types.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import {
  attachModelProviderRuntimePluginHandle,
  type ProviderRuntimePluginHandle,
} from "../../plugins/provider-hook-runtime.js";
import type { ProviderPlugin } from "../../plugins/types.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { applyExtraParamsToAgent, resolvePreparedExtraParams } from "./extra-params.js";

describe("prepared provider extra-param lifecycle", () => {
  it("uses each prepared owner for params and stream wrapping with shared config", () => {
    const cfg = { agents: { defaults: { params: { temperature: 0.1 } } } };
    const model = makeProviderModelFixture({
      provider: "fixture-provider",
      id: "fixture-model",
      api: "fixture-api",
      baseUrl: "https://fixture.invalid",
    });
    const observed: Array<SimpleStreamOptions | undefined> = [];
    for (const owner of ["first", "replacement", "updated"]) {
      if (owner === "updated") {
        cfg.agents.defaults.params.temperature = 0.7;
      }
      const plugin: ProviderPlugin = {
        id: model.provider,
        label: "Fixture",
        auth: [],
        prepareExtraParams: ({ extraParams }) => ({ ...extraParams, owner }),
        extraParamsForTransport: ({ extraParams }) => ({
          patch: { preparedBy: extraParams.owner },
        }),
        wrapStreamFn:
          ({ streamFn, extraParams }) =>
          (requestModel, context, options) =>
            streamFn!(requestModel, context, {
              ...options,
              headers: { owner, preparedBy: String(extraParams?.preparedBy) },
            }),
      };
      const providerRuntimeHandle: ProviderRuntimePluginHandle = {
        provider: model.provider,
        modelId: model.id,
        config: cfg,
        plugin,
      };
      const preparedExtraParams = resolvePreparedExtraParams({
        cfg,
        provider: model.provider,
        modelId: model.id,
        providerRuntimeHandle,
      });
      const agent = {
        streamFn: (_model: Model, _context: unknown, options?: SimpleStreamOptions) => {
          observed.push(options);
          return createAssistantMessageEventStream();
        },
      };
      const preparedModel = attachModelProviderRuntimePluginHandle(model, providerRuntimeHandle);
      applyExtraParamsToAgent(
        agent,
        cfg,
        model.provider,
        model.id,
        undefined,
        undefined,
        undefined,
        undefined,
        preparedModel,
        undefined,
        undefined,
        { preparedExtraParams },
      );
      agent.streamFn(model, { messages: [] });
    }
    expect(
      observed.map((options) => ({ temperature: options?.temperature, headers: options?.headers })),
    ).toEqual([
      { temperature: 0.1, headers: { owner: "first", preparedBy: "first" } },
      { temperature: 0.1, headers: { owner: "replacement", preparedBy: "replacement" } },
      { temperature: 0.7, headers: { owner: "updated", preparedBy: "updated" } },
    ]);
  });
});

describe("compatible Responses fast mode", () => {
  it.each([
    { optIn: true, fastMode: true, tier: undefined, expected: "priority" },
    { optIn: true, fastMode: false, tier: undefined, expected: undefined },
    { optIn: true, fastMode: undefined, tier: undefined, expected: undefined },
    { optIn: false, fastMode: true, tier: undefined, expected: undefined },
    ...["auto", "default", "flex", "priority"].map((tier) => ({
      optIn: true,
      fastMode: true,
      tier,
      expected: tier,
    })),
  ])("applies opt-in=$optIn fast=$fastMode tier=$tier", ({ optIn, fastMode, tier, expected }) => {
    const model = makeProviderModelFixture({
      provider: "cpr",
      id: "gpt-6.1-sol",
      api: "openai-responses",
      baseUrl: "http://127.0.0.1:8187/v1",
      compat: { supportsServiceTier: optIn },
    });
    const preparedModel = attachModelProviderRuntimePluginHandle(model, {
      provider: model.provider,
      modelId: model.id,
      config: undefined,
      plugin: undefined,
    });
    const payloads: Record<string, unknown>[] = [];
    const agent = {
      streamFn: (requestModel: Model, _context: unknown, options?: SimpleStreamOptions) => {
        const payload = { model: requestModel.id };
        options?.onPayload?.(payload, requestModel);
        payloads.push(payload);
        return createAssistantMessageEventStream();
      },
    };
    applyExtraParamsToAgent(
      agent,
      undefined,
      model.provider,
      model.id,
      undefined,
      undefined,
      undefined,
      undefined,
      preparedModel,
      undefined,
      undefined,
      { preparedExtraParams: { fastMode, ...(tier ? { serviceTier: tier } : {}) } },
    );
    agent.streamFn(model, { messages: [] });
    expect(payloads[0]?.service_tier).toBe(expected);
  });
});

it("samples the prepared Fast callback on each model call without enabling it by capability alone", () => {
  const model = makeProviderModelFixture({
    provider: "cpr",
    id: "fixture",
    api: "openai-responses",
    baseUrl: "https://proxy.example/v1",
    compat: { supportsServiceTier: true },
  });
  const preparedModel = attachModelProviderRuntimePluginHandle(model, {
    provider: model.provider,
    modelId: model.id,
    config: undefined,
    plugin: undefined,
  });
  const payloads: Record<string, unknown>[] = [];
  let enabled = true;
  const agent = {
    streamFn: (requestModel: Model, _context: unknown, options?: SimpleStreamOptions) => {
      const payload = { model: requestModel.id };
      options?.onPayload?.(payload, requestModel);
      payloads.push(payload);
      return createAssistantMessageEventStream();
    },
  };
  applyExtraParamsToAgent(
    agent,
    undefined,
    model.provider,
    model.id,
    undefined,
    undefined,
    undefined,
    undefined,
    preparedModel,
    undefined,
    undefined,
    { preparedExtraParams: { fastMode: () => enabled } },
  );
  for (const state of [true, false, true]) {
    enabled = state;
    agent.streamFn(model, { messages: [] });
  }
  expect(payloads.map((p) => p.service_tier)).toEqual(["priority", undefined, "priority"]);
});
