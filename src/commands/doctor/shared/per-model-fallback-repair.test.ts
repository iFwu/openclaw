import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { rewriteModelReferenceSlot } from "./codex-route-model-slots.js";
import { repairRetiredConfigModelRefs } from "./retired-model-ref-repair.js";
import { repairStaleAgentModelRefs } from "./stale-agent-model-ref-repair.js";

describe("Doctor per-model fallback repair", () => {
  it("materializes an inherited chain only for the retiring agent auth route", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "alpha/main",
            fallbackChains: { "alpha/main": ["beta/old"] },
          },
        },
        entries: { worker: {} },
      },
    };
    const repaired = repairRetiredConfigModelRefs(cfg, ({ modelRef, agentId }) =>
      agentId === "worker" && modelRef === "beta/old"
        ? { kind: "replace", modelRef: "beta/new", reason: "retirement", retirementScope: "route" }
        : { kind: "unchanged" },
    );
    expect(repaired.config.agents?.defaults?.model).toEqual(cfg.agents?.defaults?.model);
    expect(repaired.config.agents?.entries?.worker?.model).toEqual({
      fallbackChains: { "alpha/main": ["beta/new"] },
    });
  });

  it("preserves a shared selector when changing the global identity would grant an unrelated agent its tail", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "alpha/old",
            fallbacks: ["tail/model"],
            fallbackChains: { "beta/new": [] },
          },
        },
        entries: { worker: { model: "beta/new" } },
      },
    };
    const warnings: string[] = [];
    const repaired = repairRetiredConfigModelRefs(
      cfg,
      ({ modelRef }) =>
        modelRef === "alpha/old"
          ? {
              kind: "replace",
              modelRef: "beta/new",
              reason: "retirement",
              retirementScope: "provider",
            }
          : { kind: "unchanged" },
      warnings,
    );
    expect(repaired.config.agents?.defaults?.model).toEqual(cfg.agents?.defaults?.model);
    expect(warnings).toEqual(expect.arrayContaining([expect.stringContaining("global fallbacks")]));
  });

  it("keeps an authored canonical chain when a retired key converges on it", () => {
    const owner = {
      model: {
        fallbackChains: {
          "alpha/old": ["old/tail"],
          "beta/new": ["canonical/tail"],
        },
      },
    };
    rewriteModelReferenceSlot({
      container: owner,
      key: "model",
      path: "agents.defaults.model",
      resolve: (ref, _path, role) =>
        role === "chain-key" && ref === "alpha/old" ? "beta/new" : undefined,
    });
    expect(owner.model.fallbackChains).toEqual({ "beta/new": ["canonical/tail"] });
  });
});

describe("stale repair global-tail ownership without a chain map", () => {
  const providers = {
    beta: { api: "openai-completions" as const, baseUrl: "https://beta.invalid", models: [] },
    tail: { api: "openai-completions" as const, baseUrl: "https://tail.invalid", models: [] },
  };
  const options = {
    pluginProviderIds: new Set<string>(),
    persistedProviderIdsByAgentId: new Map([["worker", new Set<string>()]]),
  };
  it("preserves a global primary rather than granting a healthy agent the remaining tail", () => {
    const cfg: OpenClawConfig = {
      models: { mode: "replace", providers },
      agents: {
        defaults: { model: { primary: "dead/old", fallbacks: ["beta/new", "tail/model"] } },
        entries: { worker: { model: "beta/new" } },
      },
    };
    const result = repairStaleAgentModelRefs(cfg, options);
    expect(result.config.agents?.defaults?.model).toEqual(cfg.agents?.defaults?.model);
    expect(result.config.agents?.entries?.worker?.model).toBe("beta/new");
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("global fallbacks")]),
    );
  });
  it.each(["dead/old", { primary: "dead/old" }])(
    "preserves the stale agent selector %j rather than silently gaining the healthy global tail",
    (model) => {
      const cfg: OpenClawConfig = {
        models: { mode: "replace", providers },
        agents: {
          defaults: { model: { primary: "beta/new", fallbacks: ["tail/model"] } },
          entries: { worker: { model } },
        },
      };
      const result = repairStaleAgentModelRefs(cfg, options);
      expect(result.config.agents?.entries?.worker?.model).toEqual(model);
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining("global fallback tail")]),
      );
    },
  );
  it("still repairs an agent whose explicit empty list prevents gaining a global tail", () => {
    const cfg: OpenClawConfig = {
      models: { mode: "replace", providers },
      agents: {
        defaults: { model: { primary: "beta/new", fallbacks: ["tail/model"] } },
        entries: { worker: { model: { primary: "dead/old", fallbacks: [] } } },
      },
    };
    const result = repairStaleAgentModelRefs(cfg, options);
    expect(result.config.agents?.entries?.worker?.model).toEqual({ fallbacks: [] });
  });
});
