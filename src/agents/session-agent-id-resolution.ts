/** Session id selection uses existing roster/fixed-store admission, without model policy imports. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolvePersistedSessionStoreOwnerForKey } from "../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../config/types.js";
import {
  classifySessionKeyShape,
  normalizeAgentId,
  normalizeAgentIdStrict,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import {
  AgentSelectionRequiredError,
  listAgentIds,
  resolveDefaultAgentId,
  tryResolveLegacyDataOwnerAgentId,
} from "./agent-scope-config.js";

export type SessionAgentResolutionParams = {
  sessionKey?: string;
  config?: OpenClawConfig;
  agentId?: string | undefined;
  fallbackAgentId?: string;
};

const SESSION_AGENT_SELECTION_CONTEXT = {
  surface: "session agent resolution",
  hint: "Pass an agentId, an agent-scoped session key, or a prepared fallbackAgentId.",
};

function resolveSelectedSessionAgentId(params: SessionAgentResolutionParams): string | undefined {
  if (classifySessionKeyShape(params.sessionKey) === "malformed_agent") {
    throw new Error("Malformed agent session key; refusing default-agent resolution.");
  }
  const explicit = params.agentId === undefined ? null : normalizeAgentIdStrict(params.agentId);
  if (explicit && !explicit.ok) {
    throw new Error("Invalid explicit agent id; refusing default-agent resolution.");
  }
  const explicitAgentId = explicit?.value;
  const fallbackAgentIdRaw = normalizeLowercaseStringOrEmpty(params.fallbackAgentId);
  const fallbackAgentId = fallbackAgentIdRaw ? normalizeAgentId(fallbackAgentIdRaw) : null;
  const sessionKey = params.sessionKey?.trim();
  const parsed = parseAgentSessionKey(sessionKey);
  const sessionKeyAgentId = parsed?.agentId ? normalizeAgentId(parsed.agentId) : null;
  const cfg = params.config ?? {};
  const persistedStoreOwner = resolvePersistedSessionStoreOwnerForKey(cfg, sessionKey);
  if (sessionKeyAgentId && explicitAgentId && explicitAgentId !== sessionKeyAgentId) {
    throw new AgentSelectionRequiredError(listAgentIds(cfg), {
      surface: "session agent resolution",
      hint: `The agent-scoped session key belongs to "${sessionKeyAgentId}", not "${explicitAgentId}".`,
    });
  }
  const requestedUnscopedAgentId = explicitAgentId ?? fallbackAgentId;
  if (!sessionKeyAgentId && persistedStoreOwner.kind === "retired") {
    throw new AgentSelectionRequiredError(listAgentIds(cfg), {
      surface: "session agent resolution",
      hint: `The shared fixed-store row belongs to retired agent "${persistedStoreOwner.agentId}".`,
    });
  }
  if (
    !sessionKeyAgentId &&
    persistedStoreOwner.kind === "configured" &&
    requestedUnscopedAgentId &&
    requestedUnscopedAgentId !== persistedStoreOwner.agentId
  ) {
    throw new AgentSelectionRequiredError(listAgentIds(cfg), {
      surface: "session agent resolution",
      hint: `The shared fixed-store row belongs to "${persistedStoreOwner.agentId}", not "${requestedUnscopedAgentId}".`,
    });
  }
  return (
    sessionKeyAgentId ??
    (persistedStoreOwner.kind === "configured" ? persistedStoreOwner.agentId : undefined) ??
    requestedUnscopedAgentId ??
    undefined
  );
}

/** Strict session selection uses explicit context and legacy data ownership. */
export function resolveSessionAgentIdsStrict(params: SessionAgentResolutionParams): {
  defaultAgentId: string;
  sessionAgentId: string;
} {
  const selectedAgentId = resolveSelectedSessionAgentId(params);
  const cfg = params.config ?? {};
  const compatibilityAgentId = tryResolveLegacyDataOwnerAgentId(cfg);
  const sessionAgentId =
    selectedAgentId ??
    compatibilityAgentId ??
    resolveDefaultAgentId(cfg, SESSION_AGENT_SELECTION_CONTEXT);
  const defaultAgentId = compatibilityAgentId ?? sessionAgentId;
  return { defaultAgentId, sessionAgentId };
}

export const resolveSessionAgentIds = resolveSessionAgentIdsStrict;

export function resolveSessionAgentIdStrict(params: SessionAgentResolutionParams): string {
  const selectedAgentId = resolveSelectedSessionAgentId(params);
  const cfg = params.config ?? {};
  return (
    selectedAgentId ??
    tryResolveLegacyDataOwnerAgentId(cfg) ??
    resolveDefaultAgentId(cfg, SESSION_AGENT_SELECTION_CONTEXT)
  );
}

export const resolveSessionAgentId = resolveSessionAgentIdStrict;
