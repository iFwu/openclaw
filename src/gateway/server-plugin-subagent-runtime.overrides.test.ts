import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizeAgentCommandModelRef,
  parseAgentCommandModelRef,
} from "../agents/command/model-ref.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection-config.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginRuntimePluginScope } from "../plugins/runtime/gateway-request-scope.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  createGatewaySubagentRuntime,
  resolvePluginSubagentOverridePolicies,
} from "./server-plugin-subagent-runtime.js";

const dispatch = vi.hoisted(() =>
  vi.fn(
    async (
      _method: string,
      _params: Record<string, unknown>,
      _options?: { sessionMutationCommitGuard?: () => void },
    ) => ({ runId: "override-run" }),
  ),
);
vi.mock("./server-plugin-in-process-dispatch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./server-plugin-in-process-dispatch.js")>()),
  dispatchGatewayMethodInProcess: dispatch,
}));
vi.mock("../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: (params: {
    provider: string;
    context: { modelId: string };
  }) =>
    params.provider !== "fixture"
      ? undefined
      : params.context.modelId === "literal"
        ? "permitted"
        : params.context.modelId === "permitted"
          ? "different"
          : undefined,
}));

let config: OpenClawConfig;

beforeEach(() => {
  dispatch.mockClear();
  config = {
    agents: { entries: { worker: { model: "fixture/literal" } } },
    models: {
      providers: {
        fixture: {
          baseUrl: "https://fixture.invalid/v1",
          models: [
            {
              id: "literal",
              name: "Literal",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              maxTokens: 8192,
            },
          ],
        },
      },
    },
    plugins: {
      entries: {
        "override-fixture": {
          subagent: { allowModelOverride: true, allowedModels: ["fixture/permitted"] },
        },
      },
    },
  };
  setRuntimeConfigSnapshot(config);
});

afterEach(() => {
  resetConfigRuntimeState();
  vi.restoreAllMocks();
});

function run(override: { provider?: string; model?: string | null; persistModel?: boolean }) {
  const context = { getRuntimeConfig: () => config } as GatewayRequestContext;
  const runtime = createGatewaySubagentRuntime(
    () => context,
    resolvePluginSubagentOverridePolicies(config),
  );
  return withPluginRuntimePluginScope({ pluginId: "override-fixture" }, () =>
    runtime.run({
      sessionKey: "agent:worker:subagent:override",
      message: "Use the selected model",
      ...override,
    }),
  );
}

describe("plugin subagent initial override policy", () => {
  it.each([
    { primary: "fixture/fast", alias: "fast", target: "fast", profile: undefined },
    { primary: "gpt@prod", alias: "gpt@prod", target: "real", profile: "prod" },
  ])(
    "inherits the canonical agent default rather than explicit parsing: $primary",
    async ({ primary, alias, target, profile }) => {
      config.agents = {
        entries: { worker: { model: primary } },
        defaults: {
          models: { "fixture/fast": {}, "fixture/real": { alias } },
        },
      };
      const provider = config.models!.providers!.fixture!;
      const original = provider.models[0]!;
      provider.models = [
        { ...original, id: "fast", name: "Fast" },
        { ...original, id: "real", name: "Real" },
      ];
      config.plugins!.entries!["override-fixture"]!.subagent!.allowedModels = [
        `fixture/${target}${profile ? `@${profile}` : ""}`,
      ];
      expect(resolveDefaultModelForAgent({ cfg: config, agentId: "worker" })).toEqual({
        provider: "fixture",
        model: target,
      });
      await run({ model: null, persistModel: true });
      expect(dispatch.mock.calls.map(([method]) => method)).toEqual(["sessions.patch", "agent"]);
      expect(dispatch.mock.calls[0]?.[1]).toMatchObject({
        model: null,
        modelSelectionScope: "session",
      });
      expect(dispatch.mock.calls[1]?.[1]).not.toHaveProperty("model");
      expect(dispatch.mock.calls[1]?.[1]).not.toHaveProperty("provider");
    },
  );
  it.each([
    { model: "model-a", suffix: "@work" },
    { model: "model-a@20260920", suffix: "@work" },
    { model: "model-a@q8_0", suffix: "@work" },
    { model: "model-a@20260920", suffix: "" },
    { model: "model-a@q8_0", suffix: "" },
  ])(
    "authorizes the native default model/profile tuple: $model$suffix",
    async ({ model, suffix }) => {
      config.agents!.entries!.worker!.model = `fixture/${model}${suffix}`;
      config.models!.providers!.fixture!.api = "openai-completions";
      config.models!.providers!.fixture!.models[0]!.id = model;
      config.plugins!.entries!["override-fixture"]!.subagent!.allowedModels = [
        `fixture/${model}${suffix}`,
      ];
      await run({ model: null, persistModel: true });
      expect(dispatch.mock.calls.map(([method]) => method)).toEqual(["sessions.patch", "agent"]);
      expect(dispatch.mock.calls[0]?.[1]).toMatchObject({
        model: null,
        modelSelectionScope: "session",
      });
      expect(dispatch.mock.calls[1]?.[1]).not.toHaveProperty("model");
    },
  );
  it.each(["fixture/model-a", "fixture/model-a@personal"])(
    "rejects a different default profile authorization: %s",
    async (allowed) => {
      config.agents!.entries!.worker!.model = "fixture/model-a@work";
      config.models!.providers!.fixture!.api = "openai-completions";
      config.models!.providers!.fixture!.models[0]!.id = "model-a";
      config.plugins!.entries!["override-fixture"]!.subagent!.allowedModels = [allowed];
      await expect(run({ model: null, persistModel: true })).rejects.toThrow(/not allowlisted/u);
      expect(dispatch).not.toHaveBeenCalled();
    },
  );
  it("does not authorize default inheritance when model override policy is disabled", async () => {
    config.plugins!.entries!["override-fixture"]!.subagent!.allowModelOverride = false;
    await expect(run({ model: null, persistModel: true })).rejects.toThrow(/not trusted/u);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("checks the inherited default against the plugin allowlist before clearing a pin", async () => {
    config.plugins!.entries!["override-fixture"]!.subagent!.allowedModels = ["fixture/other"];
    await expect(run({ model: null, persistModel: true })).rejects.toThrow(/not allowlisted/u);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("rechecks the default configuration after clearing the prior pin", async () => {
    config.plugins!.entries!["override-fixture"]!.subagent!.allowedModels = ["fixture/permitted"];
    dispatch.mockImplementationOnce(async () => {
      config = { ...config };
      return { runId: "patch-result" };
    });
    await expect(run({ model: null, persistModel: true })).rejects.toThrow(
      /configuration changed/u,
    );
    expect(dispatch.mock.calls.map(([method]) => method)).toEqual(["sessions.patch"]);
  });
  it("rejects ambiguous default inheritance and an unpersisted null request", async () => {
    await expect(run({ model: null })).rejects.toThrow(/session-only/u);
    await expect(run({ provider: "fixture", model: null, persistModel: true })).rejects.toThrow(
      /without a provider/u,
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rechecks the exact configuration owner after persistence before starting", async () => {
    config.plugins!.entries!["override-fixture"]!.subagent!.allowedModels = ["fixture/literal"];
    dispatch.mockImplementationOnce(async () => {
      config = { ...config };
      return { runId: "patch-result" };
    });
    await expect(
      run({ provider: "fixture", model: "literal", persistModel: true }),
    ).rejects.toThrow(/configuration changed before admission/u);
    expect(dispatch.mock.calls.map(([method]) => method)).toEqual(["sessions.patch"]);
  });
  it("keeps a normal authorized override single-run without persistence", async () => {
    config.plugins!.entries!["override-fixture"]!.subagent!.allowedModels = ["fixture/literal"];
    await run({ provider: "fixture", model: "literal" });
    expect(dispatch.mock.calls.map(([method]) => method)).toEqual(["agent"]);
  });
  it("pins an authorized model for continuation before starting the worker", async () => {
    config.plugins!.entries!["override-fixture"]!.subagent!.allowedModels = ["fixture/literal"];
    await run({ provider: "fixture", model: "literal", persistModel: true });
    expect(dispatch.mock.calls.map(([method]) => method)).toEqual(["sessions.patch", "agent"]);
    expect(dispatch.mock.calls[0]?.[1]).toEqual({
      key: "agent:worker:subagent:override",
      model: "fixture/literal",
      modelSelectionScope: "session",
    });
  });

  it("does not persist a model rejected by the plugin allowlist", async () => {
    await expect(run({ model: "fixture/literal", persistModel: true })).rejects.toThrow(
      /not allowlisted/u,
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects persistence without an explicit model", async () => {
    await expect(run({ persistModel: true })).rejects.toThrow(/explicit model/u);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not start when continuation model persistence fails", async () => {
    config.plugins!.entries!["override-fixture"]!.subagent!.allowedModels = ["fixture/literal"];
    dispatch.mockRejectedValueOnce(new Error("session model persistence failed"));
    await expect(run({ model: "fixture/literal", persistModel: true })).rejects.toThrow(
      /persistence failed/u,
    );
    expect(dispatch.mock.calls.map(([method]) => method)).toEqual(["sessions.patch"]);
  });
  it.each([{ provider: "fixture", model: "literal" }, { model: "fixture/literal" }])(
    "checks the exact configured execution target for %j",
    async (override) => {
      // An operator-authored model row intentionally bypasses the provider's runtime alias.
      expect(normalizeAgentCommandModelRef(config, "fixture", "literal", {})).toEqual({
        provider: "fixture",
        model: "literal",
      });
      await expect(run(override)).rejects.toThrow(/not allowlisted/u);
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it.each([{ provider: "fixture", model: "literal" }, { model: "fixture/literal" }])(
    "preserves an explicit API owner without configured model rows for %j",
    async (override) => {
      config.models!.providers!.fixture!.api = "openai-completions";
      config.models!.providers!.fixture!.models = [];
      await expect(run(override)).rejects.toThrow(/not allowlisted/u);
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it.each([{ provider: "fixture", model: "literal" }, { model: "fixture/literal" }])(
    "preserves command selection for %j with chained aliases",
    async (override) => {
      config.models!.providers!.fixture!.models = [];
      await expect(run(override)).resolves.toMatchObject({ runId: "override-run" });
      const request = dispatch.mock.calls[0]?.[1];
      expect(request).toMatchObject(override);
      const model = request?.model as string;
      const selected = request?.provider
        ? normalizeAgentCommandModelRef(config, request.provider as string, model, {})
        : parseAgentCommandModelRef(config, "worker", model, "", {});
      expect(selected).toEqual({ provider: "fixture", model: "permitted" });
    },
  );

  it("allows an explicitly permitted configured literal without applying its runtime alias", async () => {
    config.plugins!.entries!["override-fixture"]!.subagent!.allowedModels = ["fixture/literal"];
    await expect(run({ provider: "fixture", model: "literal" })).resolves.toMatchObject({
      runId: "override-run",
    });
    expect(dispatch.mock.calls[0]?.[1]).toMatchObject({ provider: "fixture", model: "literal" });
  });

  it("rejects a replaced configuration before admitting its prepared override", async () => {
    config.models!.providers!.fixture!.models = [];
    const pending = run({ provider: "fixture", model: "literal" });
    config = { ...config };
    await expect(pending).rejects.toThrow(/configuration changed before admission/u);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
