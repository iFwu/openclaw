import { vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";

export function createTestSessionResolver(state: {
  sessionEntryMock: SessionEntry | undefined;
  resolvedSessionKeyMock: string | undefined;
  storePathMock: string | undefined;
}) {
  return () => {
    const sessionEntry: SessionEntry = (state.sessionEntryMock ??= {
      sessionId: "session-1",
      updatedAt: Date.now(),
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
    });
    const sessionKey = state.resolvedSessionKeyMock ?? "agent:main:main";
    return {
      sessionId: "session-1",
      sessionKey,
      sessionEntry,
      sessionAgentId: resolveAgentIdFromSessionKey(sessionKey, "default"),
      storePath: state.storePathMock ?? "/tmp/openclaw-sessions.json",
      isNewSession: false,
      persistedThinking:
        typeof sessionEntry.thinkingLevel === "string" ? sessionEntry.thinkingLevel : undefined,
      persistedVerbose: undefined,
    };
  };
}

export function createTestSessionEntryReader(
  readInWorker: typeof import("../config/sessions/session-entry-read-runtime.js").withSessionEntryReadOnlyInWorker,
  readEntry: (scope: Parameters<typeof readInWorker>[0]) => SessionEntry | undefined,
): typeof readInWorker {
  return async (scope, assertCurrent, consume) => {
    // These two logical stores are backed by the fixture's in-memory entries.
    // Real temporary-database cases retain the native worker and its custody.
    if (
      scope.storePath !== "/tmp/openclaw-sessions.json" &&
      scope.storePath !== "/tmp/openclaw-session-store.json"
    ) {
      return readInWorker(scope, assertCurrent, consume);
    }
    assertCurrent();
    const result = await consume(
      { ok: true, value: readEntry(scope) },
      { kind: "native", assertCurrent },
    );
    assertCurrent();
    return result;
  };
}

export function createTestAgentDeliveryPlan(
  resolveContext: typeof import("../utils/delivery-context.read.js").deliveryContextFromSession,
) {
  return (params: {
    accountId?: string;
    explicitThreadId?: string | number;
    explicitTo?: string;
    requestedChannel?: string;
    sessionEntry?: SessionEntry;
  }) => {
    const context = resolveContext(params.sessionEntry);
    const channel = params.requestedChannel ?? context?.channel ?? "internal";
    const to = params.explicitTo ?? context?.to;
    const accountId = params.accountId ?? context?.accountId;
    const threadId = params.explicitThreadId ?? context?.threadId;
    return {
      baseDelivery: {},
      resolvedChannel: channel,
      resolvedTo: to,
      resolvedAccountId: accountId,
      resolvedThreadId: threadId,
      deliveryTargetMode: params.explicitTo ? "explicit" : to ? "implicit" : undefined,
    };
  };
}

export function createTestThinkingPolicy(state: {
  isThinkingLevelSupportedMock: (args: unknown) => boolean;
  resolveSupportedThinkingLevelMock: (args: { level?: string }) => string | undefined;
  resolveThinkingDefaultMock: (args: unknown) => string;
}) {
  return {
    formatThinkingLevels: () => "low, medium, high",
    normalizeThinkLevel: (v?: string) => v || undefined,
    normalizeVerboseLevel: (v?: string) => v || undefined,
    isThinkingLevelSupported: (args: unknown) => state.isThinkingLevelSupportedMock(args),
    resolveSupportedThinkingLevel: (args: { level?: string }) =>
      state.resolveSupportedThinkingLevelMock(args),
    resolveThinkingSelectionForModel: (args: { level?: string }) => {
      const requestedLevel = args.level ?? state.resolveThinkingDefaultMock(args);
      const policy = { ...args, level: requestedLevel };
      return {
        requestedLevel,
        level: state.resolveSupportedThinkingLevelMock(policy),
        supported: state.isThinkingLevelSupportedMock(policy),
      };
    },
    supportsXHighThinking: () => false,
  };
}

export function createTestAgentScope(
  params: {
    hasLegacyAutoFallbackWithoutOriginMock: (entry: unknown) => boolean;
    resolveAutoFallbackPrimaryProbeMock: (params: unknown) => unknown;
    resolveModelFallbackAvailabilityMock: (...args: unknown[]) => unknown;
  },
  native: Pick<
    typeof import("./agent-scope.js"),
    | "resolveAgentModelFallbacksOverride"
    | "resolveSubagentSpawnModelFallbacksOverride"
    | "resolveModelFallbackAvailability"
    | "modelFallbackOverrideFromAvailability"
  >,
) {
  return {
    resolveAgentModelFallbacksOverride: native.resolveAgentModelFallbacksOverride,
    resolveModelFallbackAvailability: (
      ...args: Parameters<typeof native.resolveModelFallbackAvailability>
    ) => {
      params.resolveModelFallbackAvailabilityMock(...args);
      return native.resolveModelFallbackAvailability(...args);
    },
    modelFallbackOverrideFromAvailability: native.modelFallbackOverrideFromAvailability,
    resolveSubagentSpawnModelFallbacksOverride: native.resolveSubagentSpawnModelFallbacksOverride,
    clearAutoFallbackPrimaryProbeSelection: vi.fn(),
    entryMatchesAutoFallbackPrimaryProbe: () => true,
    hasLegacyAutoFallbackWithoutOrigin: (entry: unknown) =>
      params.hasLegacyAutoFallbackWithoutOriginMock(entry),
    hasSessionAutoModelFallbackProvenance: () => false,
    listAgentEntries: () => [],
    listAgentIds: () => ["default"],
    markAutoFallbackPrimaryProbe: vi.fn(),
    resolveAutoFallbackPrimaryProbe: (args: unknown) =>
      params.resolveAutoFallbackPrimaryProbeMock(args),
    resolveAgentConfig: () => undefined,
    resolveAgentDir: () => "/tmp/agent",
    resolveNativeModelPrimary: (cfg: unknown) => {
      const raw = (cfg as { agents?: { defaults?: { model?: string | { primary?: string } } } })
        ?.agents?.defaults?.model;
      return typeof raw === "string" ? raw : raw?.primary;
    },
    resolveDefaultAgentId: () => "default",
    resolveSessionAgentIds: () => ({ defaultAgentId: "default", sessionAgentId: "default" }),
    resolveSessionAgentId: () => "default",
    resolveAgentSkillsFilter: () => undefined,
    resolveAgentWorkspaceDir: () => "/tmp/workspace",
  };
}

export function createTestRuntimePlugins(
  createEmptyPluginRegistry: typeof import("../plugins/registry-empty.js").createEmptyPluginRegistry,
) {
  return {
    withAgentPluginRegistry: ({ run }: { run: () => unknown }) => run(),
    loadAgentRuntimePluginRegistryHandle: () => createEmptyPluginRegistry(),
    acquireAgentRuntimePluginRegistry: async () => {
      const registry = createEmptyPluginRegistry();
      return { registry, primaryRegistry: registry };
    },
  };
}
