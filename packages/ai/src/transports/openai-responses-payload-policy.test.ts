import { describe, expect, it } from "vitest";
import {
  resolveOpenAIResponsesPayloadPolicy,
  resolveOpenAIResponsesServerCompactionPlan,
} from "./openai-responses-payload-policy.js";

describe("OpenAI Responses compact threshold", () => {
  it.each([
    {
      name: "uses the active runtime cap for the direct Sol route",
      model: { contextWindow: 1_050_000, contextTokens: 272_000 },
      expected: 190_400,
    },
    {
      name: "keeps window-only behavior",
      model: { contextWindow: 400_000 },
      expected: 280_000,
    },
    {
      name: "honors an explicit threshold",
      model: { contextWindow: 1_050_000, contextTokens: 272_000 },
      extraParams: { responsesCompactThreshold: 123_456 },
      expected: 123_456,
    },
    {
      name: "uses the fallback without a known budget",
      model: {},
      expected: 80_000,
    },
    {
      name: "floors a positive numeric threshold",
      model: {},
      extraParams: { responsesCompactThreshold: 123_456.9 },
      expected: 123_456,
    },
    {
      name: "accepts a strict positive integer string threshold",
      model: {},
      extraParams: { responsesCompactThreshold: "123456" },
      expected: 123_456,
    },
    {
      name: "rejects a fractional string threshold",
      model: {},
      extraParams: { responsesCompactThreshold: "123456.9" },
      expected: 80_000,
    },
    {
      name: "rejects a nonfinite threshold",
      model: {},
      extraParams: { responsesCompactThreshold: Number.POSITIVE_INFINITY },
      expected: 80_000,
    },
  ])("$name", ({ model, extraParams, expected }) => {
    expect(
      resolveOpenAIResponsesServerCompactionPlan(
        {
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          ...model,
        },
        extraParams,
      ).threshold,
    ).toBe(expected);
  });
});

describe("compatible Responses service tier policy", () => {
  it.each([undefined, false, true])("only permits explicit opt-in %s", (supportsServiceTier) => {
    const policy = resolveOpenAIResponsesPayloadPolicy(
      {
        provider: "cpr",
        api: "openai-responses",
        baseUrl: "http://127.0.0.1:8187/v1",
        compat: { supportsServiceTier },
      },
      { storeMode: "disable" },
    );
    expect(policy.allowsServiceTier).toBe(supportsServiceTier === true);
  });
});

it.each(["openai-completions", "anthropic-messages"])(
  "does not grant a service tier to %s by a Responses capability",
  (api) => {
    expect(
      resolveOpenAIResponsesPayloadPolicy({
        provider: "proxy",
        api,
        baseUrl: "https://proxy.example/v1",
        compat: { supportsServiceTier: true },
      }).allowsServiceTier,
    ).toBe(false);
  },
);
