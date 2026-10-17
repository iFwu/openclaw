import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { resolveSessionTranscriptFile } from "../../config/sessions/transcript-file-resolve.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import * as authProfiles from "../auth-profiles/store-runtime.js";
import * as harnessRuntime from "../harness/runtime-plugin.js";
import { loadProviderScopedThinkingCatalog } from "../model-catalog.runtime.js";
import type { ModelCatalogEntry } from "../model-catalog.types.js";
import { prepareOperatorModelPolicy } from "../operator-model-policy.js";
import { bindNativeCompletionOwner } from "../subagents/announce/subagent-announce-handoff.js";
import * as sessionPersistence from "./attempt-execution.shared.js";
import {
  automaticEntry,
  catalogEntry,
  configuredModel,
  sessionKey,
  setupConfiguredModelSelectionTests,
} from "./model-selection.configured.test-support.js";
import * as runtimeLoaders from "./runtime-loaders.js";

vi.mock("../model-catalog.js", { spy: true });
vi.mock("../model-catalog.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../model-catalog.runtime.js")>();
  return {
    ...actual,
    loadProviderScopedThinkingCatalog: vi.fn().mockResolvedValue([]),
  };
});

const createFixture = setupConfiguredModelSelectionTests();

function createRestrictedFixture() {
  const fixture = createFixture();
  fixture.defaults.model = { primary: "custom/child", fallbacks: ["custom/manual"] };
  fixture.defaults.modelPolicy = { allow: ["custom/*"] };
  fixture.defaults.models = {
    "custom/child": { alias: "blocked" },
    "custom/manual": { alias: "permitted" },
  };
  fixture.inventory.mockReturnValue([
    catalogEntry("custom", "base"),
    catalogEntry("custom", "child"),
    catalogEntry("custom", "manual"),
  ]);
  const operatorAuthority = createAdmittedRunOperatorAuthority({
    profileId: "limited-operator",
    scopes: ["operator.write"],
    assertCurrent: () => {},
    modelPolicy: prepareOperatorModelPolicy({
      cfg: fixture.cfg,
      policy: { sourceAgent: "main", deny: ["custom/child"] },
    }),
  });
  return { ...fixture, operatorAuthority };
}

describe("command selection with configured model facts", () => {
  it.each(["restart", "subagent_announce", "subagent_settle"])(
    "retains a temporary primary with its turn options for %s",
    async (kind) => {
      const fixture = createFixture();
      fixture.defaults.modelPolicy = { allow: ["custom/*"] };
      fixture.inventory.mockReturnValue([
        catalogEntry("custom", "base"),
        catalogEntry("custom", "manual"),
      ]);
      const selection = {
        runId: "original",
        ownerRunId: "original",
        sourceTurnId: "source",
        sessionId: "configured-child",
        lifecycleRevision: "generation",
        modelSelectionRevision: "choice",
        turnRevision: "turn",
        provider: "custom",
        model: "manual",
        thinking: "high" as const,
        fastMode: true,
        fallbacks: ["custom/base"],
      };
      fixture.store[sessionKey] = {
        sessionId: selection.sessionId,
        lifecycleRevision: "generation",
        updatedAt: 1,
        modelSelectionRevision: "choice",
        continuationTurnRevision: "turn",
        continuationModelSelection: selection,
        restartRecoveryDeliverySourceRunId: "source",
        modelProvider: "custom",
        model: "base",
      };
      const handoff = bindNativeCompletionOwner(
        {
          kind: "subagent-completion",
          sourceSessionKey: "agent:main:subagent:child",
          sourceSessionId: "child",
          targetSessionKey: sessionKey,
          targetSessionId: selection.sessionId,
          provider: "custom",
          model: "base",
          modelSelection: selection,
          ...(kind === "subagent_settle"
            ? {
                settleBatch: {
                  sourceSessionKeys: ["agent:main:subagent:child"],
                  isCurrent: () => true,
                },
              }
            : {}),
        },
        () => true,
      );
      const opts =
        kind === "restart"
          ? { message: "Resume", mainRestartRecoveryAdmitted: true }
          : {
              message: "Resume",
              trustedInternalHandoff: handoff,
              inputProvenance: {
                kind: "inter_session" as const,
                sourceTool: kind,
                sourceSessionKey: handoff.sourceSessionKey,
              },
            };
      const selected = await fixture.select({ opts });
      expect(selected).toMatchObject({
        provider: "custom",
        model: "manual",
        continuationSelection: selection,
        immutableThinkLevel: "high",
      });
      expect(selected.autoFallbackPrimaryProbe).toBeUndefined();
      if (kind !== "restart") {
        expect(handoff).toMatchObject({ provider: "custom", model: "manual" });
      }
      expect(await fixture.select({ opts: { message: "Normal new message" } })).toMatchObject({
        provider: "custom",
        model: "base",
        continuationSelection: undefined,
      });
      expect(
        await fixture.select({
          opts: { ...opts, provider: "custom", model: "base", allowModelOverride: true },
        }),
      ).toMatchObject({ provider: "custom", model: "base", continuationSelection: undefined });
      fixture.entry().modelSelectionRevision = "new-choice";
      expect(await fixture.select({ opts })).toMatchObject({
        provider: "custom",
        model: "base",
        continuationSelection: undefined,
      });
    },
  );

  it("does not use a revoked native completion carrier or bypass current model policy", async () => {
    const fixture = createRestrictedFixture();
    const selection = {
      runId: "original",
      sessionId: "configured-child",
      provider: "custom",
      model: "child",
    };
    fixture.store[sessionKey] = {
      sessionId: selection.sessionId,
      updatedAt: 1,
      continuationModelSelection: selection,
    };
    const handoff = bindNativeCompletionOwner(
      {
        kind: "subagent-completion",
        sourceSessionKey: "agent:main:subagent:child",
        targetSessionKey: sessionKey,
        targetSessionId: selection.sessionId,
        provider: "custom",
        model: "base",
        modelSelection: selection,
      },
      () => false,
    );
    expect(
      (
        await fixture.select({
          opts: {
            message: "Resume",
            trustedInternalHandoff: handoff,
            inputProvenance: {
              kind: "inter_session",
              sourceTool: "subagent_announce",
              sourceSessionKey: handoff.sourceSessionKey,
            },
          },
        })
      ).continuationSelection,
    ).toBeUndefined();
    fixture.entry().restartRecoveryDeliverySourceRunId = "original";
    await expect(
      fixture.select({
        opts: {
          message: "Resume",
          mainRestartRecoveryAdmitted: true,
          operatorAuthority: fixture.operatorAuthority,
        },
      }),
    ).rejects.toThrow("Your operator role cannot use this model");
    fixture.defaults.modelPolicy = { allow: ["custom/base"] };
    await expect(
      fixture.select({ opts: { message: "Resume", mainRestartRecoveryAdmitted: true } }),
    ).rejects.toThrow("no longer allowed");
  });
  it.each([
    { previous: null, observed: "max", configured: undefined, supported: true },
    { previous: "max", observed: null, configured: undefined, supported: false },
    { previous: null, observed: "max", configured: null, supported: false },
    { previous: "max", observed: null, configured: "max", supported: true },
    { previous: "max", observed: undefined, configured: undefined, supported: true },
  ])(
    "uses observed max support ($supported) over stale catalog facts",
    async ({ previous, observed, configured, supported }) => {
      const fixture = createFixture();
      fixture.custom.models.forEach((model) => {
        model.reasoning = true;
        if (model.id === "child" && configured !== undefined) {
          model.thinkingLevelMap = { max: configured };
        }
      });
      fixture.defaults.modelPolicy = { allow: ["custom/*"] };
      const stale = {
        ...catalogEntry("custom", "child"),
        reasoning: true,
        thinkingLevelMap: { max: previous },
      };
      fixture.inventory.mockReturnValue([stale]);
      vi.mocked(loadProviderScopedThinkingCatalog).mockResolvedValue(
        observed === undefined ? [] : [{ ...stale, thinkingLevelMap: { max: observed } }],
      );
      const selection = fixture.select({
        configuredThinkingCatalog: [stale],
        requestedThinkLevel: "max",
        thinkOnce: "max",
        isSubagentLane: false,
      });
      if (supported) {
        await expect(selection).resolves.toMatchObject({ provider: "custom", model: "child" });
      } else {
        await expect(selection).rejects.toThrow('Thinking level "max" is not supported');
      }
    },
  );

  it("does not probe a primary excluded by the original operator policy", async () => {
    const fixture = createRestrictedFixture();
    fixture.store[sessionKey] = {
      ...automaticEntry("manual"),
      modelOverrideFallbackOriginModel: "child",
    };
    const selected = await fixture.select({
      opts: { message: "Continue", operatorAuthority: fixture.operatorAuthority },
    });
    expect(selected).toMatchObject({ provider: "custom", model: "manual" });
    expect(selected.autoFallbackPrimaryProbe).toBeUndefined();
  });

  it("keeps an incompatible shared account pin when role policy selects another provider", async () => {
    const fixture = createRestrictedFixture();
    fixture.defaults.model = { primary: "other/default", fallbacks: ["custom/manual"] };
    fixture.defaults.modelPolicy = { allow: ["custom/*", "other/*"] };
    fixture.cfg.models!.providers!.other = {
      ...fixture.custom,
      models: [configuredModel("default")],
    };
    fixture.store[sessionKey] = {
      sessionId: "configured-child",
      updatedAt: 1,
      providerOverride: "other",
      modelOverride: "default",
      modelOverrideSource: "user",
      authProfileOverride: "other:shared",
      authProfileOverrideSource: "user",
    };
    vi.spyOn(authProfiles, "ensureAuthProfileStore").mockReturnValue({
      version: 1,
      profiles: {
        "other:shared": { type: "api_key", provider: "other", key: "synthetic-model-policy-key" },
      },
    });
    const before = structuredClone(fixture.store);

    const selected = await fixture.select({
      opts: { message: "Continue", operatorAuthority: fixture.operatorAuthority },
    });
    expect(selected).toMatchObject({ provider: "custom", model: "manual" });
    expect(selected.sessionEntryForAttempt?.authProfileOverride).toBeUndefined();
    expect(fixture.store).toEqual(before);
  });

  it.each(["custom/child", "blocked"])(
    "rejects a role-denied explicit %s before selection or runtime effects",
    async (model) => {
      const fixture = createRestrictedFixture();
      const before = structuredClone(fixture.store);

      await expect(
        fixture.select({
          opts: {
            message: "Use requested model",
            model,
            allowModelOverride: true,
            operatorAuthority: fixture.operatorAuthority,
          },
        }),
      ).rejects.toThrow("Your operator role cannot use this model");

      expect(fixture.store).toEqual(before);
      expect(sessionPersistence.persistAgentSession).not.toHaveBeenCalled();
      expect(harnessRuntime.ensureSelectedAgentHarnessPlugin).not.toHaveBeenCalled();
    },
  );

  it("constrains stored automatic selection for a restricted caller", async () => {
    const fixture = createRestrictedFixture();
    const selected = await fixture.select({
      opts: { message: "Continue", operatorAuthority: fixture.operatorAuthority },
    });

    expect(selected).toMatchObject({ provider: "custom", model: "manual" });
    expect(sessionPersistence.persistAgentSession).not.toHaveBeenCalled();
  });

  it("allows an explicit permitted alias without weakening the agent's manual policy", async () => {
    const fixture = createRestrictedFixture();
    const opts = {
      message: "Use permitted model",
      model: "permitted",
      allowModelOverride: true,
      operatorAuthority: fixture.operatorAuthority,
    };
    expect(await fixture.select({ opts })).toMatchObject({ provider: "custom", model: "manual" });

    fixture.defaults.modelPolicy = { allow: ["custom/base"] };
    await expect(fixture.select({ opts })).rejects.toThrow(
      'Model override "custom/manual" is not allowed',
    );
  });

  it("does not let a model lock bypass the original caller's model policy", async () => {
    const fixture = createRestrictedFixture();
    fixture.entry().modelSelectionLocked = true;
    const before = structuredClone(fixture.store);

    await expect(
      fixture.select({
        opts: { message: "Continue", operatorAuthority: fixture.operatorAuthority },
      }),
    ).rejects.toThrow("Your operator role cannot use this model");

    expect(fixture.store).toEqual(before);
    expect(harnessRuntime.ensureSelectedAgentHarnessPlugin).not.toHaveBeenCalled();
  });

  it("preserves an explicit CLI route across resumed command turns and a later API selection", async () => {
    const fixture = createFixture();
    fixture.defaults.modelPolicy = { allow: ["custom-cli/child", "custom/child"] };
    const select = () => fixture.select({ pluginsEnabled: false, requestedThinkLevel: "off" });
    fixture.registry.cliBackends.push({
      pluginId: "custom",
      source: "fixture",
      backend: {
        id: "custom-cli",
        modelProvider: "custom",
        config: { command: "custom-cli" },
      },
    });
    fixture.inventory.mockReturnValue([catalogEntry("custom-cli", "child")]);
    fixture.store[sessionKey] = {
      sessionId: "configured-child",
      updatedAt: 1,
      providerOverride: "custom-cli",
      modelOverride: "child",
      modelOverrideSource: "user",
      modelOverrideRouteResolution: "resolved",
    };

    expect(await select()).toMatchObject({ provider: "custom-cli", model: "child" });
    fixture.entry().cliSessionBindings = { "custom-cli": { sessionId: "native-command-session" } };
    expect(await select()).toMatchObject({ provider: "custom-cli", model: "child" });
    fixture.entry().providerOverride = "custom";
    expect(await select()).toMatchObject({ provider: "custom", model: "child" });
  });

  it("retains a resolved self-origin child outside manual policy without manifest inventory", async () => {
    const fixture = createFixture();
    const before = structuredClone({ cfg: fixture.cfg, store: fixture.store });
    const selected = await fixture.select();

    expect(selected).toMatchObject({
      provider: "custom",
      model: "child",
      requestedRouteResolution: "resolved",
      storedModelOverrideSource: "auto",
      effectiveTurnThinkLevel: "off",
      sessionEntry: automaticEntry(),
      sessionEntryForAttempt: automaticEntry(),
    });
    expect(selected.autoFallbackPrimaryProbe).toBeUndefined();
    expect(selected.thinkingCatalog).toContainEqual(
      expect.objectContaining({
        provider: "custom",
        id: "child",
        reasoning: false,
        configuredReasoning: false,
        api: "openai-completions",
        baseUrl: "https://custom.invalid/v1",
      }),
    );
    expect({ cfg: fixture.cfg, store: fixture.store }).toEqual(before);
    expect(sessionPersistence.persistAgentSession).not.toHaveBeenCalled();
  });

  it("retains declared capabilities for an unrestricted unconfigured selection", async () => {
    const fixture = createFixture();
    delete fixture.defaults.modelPolicy;
    fixture.defaults.model = { primary: "remote/unconfigured" };
    delete fixture.cfg.models;
    fixture.store[sessionKey] = { sessionId: "configured-child", updatedAt: 1 };
    const declared: ModelCatalogEntry = {
      ...catalogEntry("remote", "unconfigured"),
      input: ["text", "image"],
    };
    fixture.inventory.mockReturnValue([declared]);
    const before = structuredClone({ cfg: fixture.cfg, store: fixture.store });

    const selected = await fixture.select({
      configuredThinkingCatalog: [],
      requestedThinkLevel: "off",
    });

    expect(selected).toMatchObject({
      provider: "remote",
      model: "unconfigured",
      effectiveTurnThinkLevel: "off",
    });
    expect(selected.thinkingCatalog).toContainEqual(expect.objectContaining(declared));
    expect({ cfg: fixture.cfg, store: fixture.store }).toEqual(before);
    expect(sessionPersistence.persistAgentSession).not.toHaveBeenCalled();
  });

  it.each(["raw", "resolved"] as const)(
    "keeps a literal configured model that collides with an alias (%s stored route)",
    async (route) => {
      const fixture = createFixture();
      fixture.defaults.modelPolicy = {
        allow: ["custom/base", "custom/alias", "custom/actual"],
      };
      fixture.defaults.models = { "custom/actual": { alias: "alias" } };
      fixture.custom.models.push(configuredModel("alias"), configuredModel("actual"));
      fixture.store[sessionKey] =
        route === "raw"
          ? {
              sessionId: "configured-child",
              updatedAt: 1,
              providerOverride: "custom",
              modelOverride: "alias",
              modelOverrideSource: "user",
              modelSelectionLocked: true,
            }
          : automaticEntry("alias");
      fixture.inventory.mockReturnValue([catalogEntry("custom", "alias")]);
      const before = structuredClone({ cfg: fixture.cfg, store: fixture.store });

      const selected = await fixture.select();

      expect(selected).toMatchObject({
        provider: "custom",
        model: "alias",
        requestedRouteResolution: "resolved",
      });
      expect({ cfg: fixture.cfg, store: fixture.store }).toEqual(before);
    },
  );

  it.each([
    { permission: false, error: "Model override is not authorized for this caller." },
    { permission: true, error: 'Model override "custom/child" is not allowed' },
  ])(
    "does not convert automatic child provenance into explicit override permission ($permission)",
    async ({ permission, error }) => {
      const fixture = createFixture();
      fixture.inventory.mockReturnValue([catalogEntry("custom", "child")]);
      const before = structuredClone({ cfg: fixture.cfg, store: fixture.store });

      await expect(
        fixture.select({
          opts: {
            message: "Explicit override",
            provider: "custom",
            model: "child",
            allowModelOverride: permission,
          },
        }),
      ).rejects.toThrow(error);

      expect({ cfg: fixture.cfg, store: fixture.store }).toEqual(before);
    },
  );

  it("keeps wildcard replacement in catalog order rather than alphabetical order", async () => {
    const fixture = createFixture();
    fixture.defaults.modelPolicy = { allow: ["remote/*"] };
    fixture.store[sessionKey] = { sessionId: "configured-child", updatedAt: 1 };
    fixture.inventory.mockReturnValue([
      catalogEntry("remote", "z-first"),
      catalogEntry("remote", "a-second"),
    ]);
    const before = structuredClone({ cfg: fixture.cfg, store: fixture.store });

    const selected = await fixture.select();

    expect(selected).toMatchObject({
      provider: "remote",
      model: "z-first",
      requestedRouteResolution: "resolved",
    });
    expect({ cfg: fixture.cfg, store: fixture.store }).toEqual(before);
  });

  it("retains unqualified policy inference from the manifest catalog", async () => {
    const fixture = createFixture();
    delete fixture.defaults.modelPolicy;
    fixture.defaults.models = { shared: {} };
    fixture.store[sessionKey] = {
      sessionId: "configured-child",
      updatedAt: 1,
      providerOverride: "remote",
      modelOverride: "shared",
      modelOverrideSource: "user",
      modelOverrideRouteResolution: "resolved",
    };
    fixture.inventory.mockReturnValue([catalogEntry("remote", "shared")]);
    const before = structuredClone({ cfg: fixture.cfg, store: fixture.store });

    const selected = await fixture.select();

    expect(selected).toMatchObject({
      provider: "remote",
      model: "shared",
      requestedRouteResolution: "resolved",
    });
    expect({ cfg: fixture.cfg, store: fixture.store }).toEqual(before);
  });

  it.each(["incomplete", "inherited"] as const)(
    "does not grant the child's automatic-policy exemption to %s provenance",
    async (provenance) => {
      const fixture = createFixture();
      fixture.inventory.mockReturnValue([
        catalogEntry("custom", "base"),
        catalogEntry("custom", "child"),
      ]);
      if (provenance === "incomplete") {
        delete fixture.entry().modelOverrideFallbackOriginModel;
      } else {
        const parentKey = "agent:main:parent";
        fixture.store[parentKey] = { ...automaticEntry(), sessionId: "parent" };
        fixture.store[sessionKey] = {
          sessionId: "configured-child",
          updatedAt: 1,
          parentSessionKey: parentKey,
        };
      }
      const configBefore = structuredClone(fixture.cfg);
      const parentBefore = structuredClone(fixture.store["agent:main:parent"]);

      const selected = await fixture.select();

      expect(selected).toMatchObject({
        provider: "custom",
        model: "base",
        requestedRouteResolution: "resolved",
      });
      expect(selected.sessionEntry?.modelOverride).toBeUndefined();
      expect(fixture.entry().modelOverride).toBeUndefined();
      expect(fixture.store["agent:main:parent"]).toEqual(parentBefore);
      expect(fixture.cfg).toEqual(configBefore);
    },
  );

  it("retains manifest-owned donor facts for a configured automatic child", async () => {
    const fixture = createFixture({ manifestOwner: true });
    fixture.inventory.mockReturnValue([
      {
        ...catalogEntry("custom", "child"),
        baseUrl: "https://donor.invalid/v1",
        contextWindow: 32_768,
      },
    ]);
    const before = structuredClone({ cfg: fixture.cfg, store: fixture.store });

    const selected = await fixture.select();

    expect(selected).toMatchObject({
      provider: "custom",
      model: "child",
      requestedRouteResolution: "resolved",
      effectiveTurnThinkLevel: "off",
    });
    expect(selected.thinkingCatalog).toContainEqual(
      expect.objectContaining({
        provider: "custom",
        id: "child",
        baseUrl: "https://donor.invalid/v1",
        contextWindow: 32_768,
        configuredReasoning: false,
      }),
    );
    expect({ cfg: fixture.cfg, store: fixture.store }).toEqual(before);
  });
});

describe("command selection with real transcript routing", () => {
  it.each([
    [sessionKey, true, false, "store"],
    [sessionKey, true, true, "suppressed"],
    [sessionKey, false, true, "fallback"],
    [undefined, true, true, "fallback"],
    ["", true, true, "fallback"],
  ] as const)(
    "routes key=%j, store=%s, suppressed=%s through the real resolver",
    async (key, withStore, suppressVisibleSessionEffects, route) => {
      const fixture = createFixture();
      fixture.defaults.modelPolicy = { allow: ["custom/*"] };
      fixture.inventory.mockReturnValue([catalogEntry("custom", "base")]);
      const sessionId = "routing-session";
      const storedEntry: SessionEntry = { sessionId: "stored-session", updatedAt: 2 };
      const store = {
        [sessionKey]: storedEntry,
        [sessionId]: { sessionId: "not-a-keyed-session", updatedAt: 3 },
        "": { sessionId: "not-an-empty-key-session", updatedAt: 4 },
      };
      const storePath = path.join(fixture.cfg.agents!.entries!.main!.workspace!, "sessions.json");
      const resolver = vi.fn(resolveSessionTranscriptFile);
      vi.mocked(runtimeLoaders.loadTranscriptResolveRuntime).mockResolvedValue({
        resolveSessionTranscriptFile: resolver,
      });

      const selected = await fixture.select({
        opts: { message: "Resolve transcript routing", threadId: 42 },
        sessionId,
        sessionKey: key,
        sessionEntry: undefined,
        sessionStore: withStore ? store : undefined,
        storePath,
        suppressVisibleSessionEffects,
      });

      expect(selected.sessionFile).toBe(key === undefined ? sessionId : key);
      expect(selected.sessionEntry).toBe(route === "store" ? storedEntry : undefined);
      expect(selected.sessionEntryForAttempt).toBeUndefined();
      expect(resolver).toHaveBeenCalledTimes(1);
      const forwarded = expectDefined(resolver.mock.calls[0], "transcript resolution call")[0];
      expect(forwarded).toMatchObject({
        sessionId,
        sessionKey: key === undefined ? sessionId : key,
        agentId: "main",
        threadId: 42,
      });
      expect(forwarded.sessionEntry).toBeUndefined();
      expect(forwarded.sessionStore).toBe(route === "store" ? store : undefined);
      expect(forwarded.storePath).toBe(route === "suppressed" ? undefined : storePath);
      expect(sessionPersistence.persistAgentSession).not.toHaveBeenCalled();
    },
  );

  it("keeps the explicit entry ahead of the store and preserves the attempt entry", async () => {
    const fixture = createFixture();
    fixture.defaults.modelPolicy = { allow: ["custom/*"] };
    fixture.inventory.mockReturnValue([catalogEntry("custom", "base")]);
    const explicitEntry: SessionEntry = { sessionId: "explicit-session", updatedAt: 1 };
    const storedEntry = fixture.entry();
    const resolver = vi.fn(resolveSessionTranscriptFile);
    vi.mocked(runtimeLoaders.loadTranscriptResolveRuntime).mockResolvedValue({
      resolveSessionTranscriptFile: resolver,
    });

    const selected = await fixture.select({ sessionEntry: explicitEntry });

    expect(selected.sessionFile).toBe(sessionKey);
    expect(selected.sessionEntry).toBe(explicitEntry);
    expect(selected.sessionEntryForAttempt).toBe(explicitEntry);
    expect(fixture.entry()).toBe(storedEntry);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(sessionPersistence.persistAgentSession).not.toHaveBeenCalled();
  });

  it("rechecks operator authority after loading transcript routing", async () => {
    const fixture = createFixture();
    const lifetime = new AbortController();
    const denied = new Error("operator authority ended during transcript loading");
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "transcript-operator",
      scopes: ["operator.write"],
      assertCurrent: () => {},
      signal: lifetime.signal,
    });
    const resolver = vi.fn(resolveSessionTranscriptFile);
    vi.mocked(runtimeLoaders.loadTranscriptResolveRuntime).mockImplementation(async () => {
      lifetime.abort(denied);
      return { resolveSessionTranscriptFile: resolver };
    });

    await expect(
      fixture.select({ opts: { message: "Resolve transcript routing", operatorAuthority } }),
    ).rejects.toBe(denied);

    expect(runtimeLoaders.loadTranscriptResolveRuntime).toHaveBeenCalledTimes(1);
    expect(resolver).not.toHaveBeenCalled();
    expect(sessionPersistence.persistAgentSession).not.toHaveBeenCalled();
  });
});
