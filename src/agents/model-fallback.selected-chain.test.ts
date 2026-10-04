import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { AgentModelSchema } from "../config/zod-schema.agent-model.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resolveModelFallbackAvailability } from "./agent-scope.js";
import { resolveModelCandidateChain } from "./model-fallback-candidates.js";

function config(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: {
          primary: "alpha/main",
          fallbacks: ["global/tail"],
          fallbackChains: {
            "alpha/main": ["beta/backup"],
            "beta/backup": ["gamma/last"],
            "empty/main": [],
          },
        },
      },
    },
  };
}

function chain(cfg: OpenClawConfig, provider: string, model: string, fallbacksOverride?: string[]) {
  return resolveModelCandidateChain({
    cfg,
    provider,
    model,
    fallbacksOverride,
    requestedRouteResolution: "resolved",
    manifestPlugins: [],
  }).map((candidate) => `${candidate.provider}/${candidate.model}`);
}

describe("selected model fallback policy", () => {
  it("admits per-model maps in the canonical schema", () => {
    expect(AgentModelSchema.safeParse(config().agents?.defaults?.model).success).toBe(true);
  });

  it("appends the global tail only for the global primary", () => {
    expect(chain(config(), "alpha", "main")).toEqual(["alpha/main", "beta/backup", "global/tail"]);
    expect(chain(config(), "beta", "backup")).toEqual(["beta/backup", "gamma/last"]);
  });

  it("does not recurse through the fallback model's own chain", () => {
    expect(chain(config(), "alpha", "main")).not.toContain("gamma/last");
  });

  it.each(["empty", "unlisted"])("keeps %s selection isolated from global defaults", (provider) => {
    expect(chain(config(), provider, "main")).toEqual([`${provider}/main`]);
  });

  it("preserves explicit empty and explicit list overrides", () => {
    expect(chain(config(), "alpha", "main", [])).toEqual(["alpha/main"]);
    expect(chain(config(), "beta", "backup", ["explicit/next"])).toEqual([
      "beta/backup",
      "explicit/next",
    ]);
  });

  it("reports the manually selected model's own chain instead of disabling fallback", () => {
    expect(
      resolveModelFallbackAvailability({
        cfg: config(),
        agentId: "main",
        hasSessionModelOverride: true,
        modelOverrideSource: "user",
        provider: "beta",
        model: "backup",
      }),
    ).toEqual({ kind: "active", source: "per-model", models: ["gamma/last"] });
  });

  it("keeps a selection lock stronger than any configured chain", () => {
    expect(
      resolveModelFallbackAvailability({
        cfg: config(),
        agentId: "main",
        hasSessionModelOverride: true,
        provider: "alpha",
        model: "main",
        modelSelectionLocked: true,
      }),
    ).toEqual({ kind: "disabled_by_model_selection_lock" });
  });

  it("resolves each new turn from the original selection, not the prior successful fallback", () => {
    const cfg = config();
    expect(chain(cfg, "alpha", "main")).toEqual(["alpha/main", "beta/backup", "global/tail"]);
    expect(chain(cfg, "alpha", "main")).toEqual(["alpha/main", "beta/backup", "global/tail"]);
    expect(chain(cfg, "beta", "backup")).toEqual(["beta/backup", "gamma/last"]);
  });
});

describe("selected policy review regressions", () => {
  it("does not borrow the global ladder when no per-model map was authored", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "alpha/main",
            fallbacks: ["global/tail"],
          },
        },
      },
    };
    expect(chain(cfg, "beta", "manual")).toEqual(["beta/manual"]);
    expect(chain(cfg, "alpha", "main")).toEqual(["alpha/main", "global/tail"]);
    expect(
      resolveModelFallbackAvailability({
        cfg,
        agentId: "main",
        provider: "beta",
        model: "manual",
        hasSessionModelOverride: true,
        modelOverrideSource: "user",
      }),
    ).toEqual({ kind: "none_configured", source: "per-model" });
  });
  it("uses the same captured manifest view for the global tail and the actual ladder", () => {
    const snapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "candidate",
          providers: ["candidate"],
          modelIdNormalization: { providers: { candidate: { aliases: { latest: "release" } } } },
        },
      ],
    });
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "candidate/latest",
            fallbacks: ["tail/main"],
            fallbackChains: {},
          },
        },
      },
    };
    expect(
      resolveModelCandidateChain({
        cfg,
        provider: "candidate",
        model: "release",
        requestedRouteResolution: "resolved",
        manifestPlugins: snapshot.plugins,
      }).map(({ provider, model }) => `${provider}/${model}`),
    ).toEqual(["candidate/release", "tail/main"]);
  });
});

describe("fallback key canonical identity", () => {
  it("matches an authored built-in alias to the resolved selected model", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "alpha/main",
            fallbacks: ["global/tail"],
            fallbackChains: { "google/gemini-3-pro": ["selected/backup"] },
          },
        },
      },
    };
    expect(chain(cfg, "google", "gemini-3.1-pro-preview")).toEqual([
      "google/gemini-3.1-pro-preview",
      "selected/backup",
    ]);
  });
  it("prefers an authored canonical key over a converging alias regardless of order", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "alpha/main",
            fallbackChains: {
              "google/gemini-3-pro": ["alias/tail"],
              "google/gemini-3.1-pro-preview": ["canonical/tail"],
            },
          },
        },
      },
    };
    expect(chain(cfg, "google", "gemini-3.1-pro-preview")).toEqual([
      "google/gemini-3.1-pro-preview",
      "canonical/tail",
    ]);
  });
  it("matches configured aliases without borrowing an unrelated global tail", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: { "beta/backup": { alias: "chosen" } },
          model: {
            primary: "alpha/main",
            fallbacks: ["global/tail"],
            fallbackChains: { chosen: ["own/tail"] },
          },
        },
      },
    };
    expect(chain(cfg, "beta", "backup")).toEqual(["beta/backup", "own/tail"]);
  });
});
