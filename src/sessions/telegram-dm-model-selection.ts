import { randomUUID } from "node:crypto";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { createKeyedFifoLeaseRegistry } from "../shared/keyed-fifo-lease.js";
import {
  applyModelOverrideToSessionEntry,
  type ModelOverrideSelection,
} from "./model-overrides.js";
import { parseSessionDeliveryRoute, parseThreadSessionSuffix } from "./session-key-utils.js";
import { emitSessionLifecycleEvent } from "./session-lifecycle-events.js";

const selections = createKeyedFifoLeaseRegistry(Symbol.for("openclaw.telegramDmModelSelections"));

export function resolveTelegramDmModelParent(sessionKey: string): string | undefined {
  const route = parseSessionDeliveryRoute(sessionKey);
  const thread = parseThreadSessionSuffix(sessionKey);
  return route?.channel === "telegram" && route.peerKind === "direct" && thread.threadId
    ? thread.baseSessionKey
    : undefined;
}

/** Keep a manual choice and its DM default in one ordered operation across topics. */
export async function withTelegramDmModelSelection<T>(
  sessionKeys: readonly string[],
  run: () => Promise<T>,
): Promise<T> {
  const keys = sessionKeys.flatMap((key) => resolveTelegramDmModelParent(key) ?? []);
  const lease = selections.reserve(keys);
  if (!lease) return await run();
  try {
    await lease.wait();
    return await run();
  } finally {
    lease.release();
  }
}

/** A topic's explicit model choice also seeds future topics in the same DM. */
export async function rememberTelegramDmModelSelection(params: {
  agentId: string;
  sessionKey: string;
  storePath?: string;
  sessionStore?: Record<string, SessionEntry>;
  selection: ModelOverrideSelection;
  assertCurrent?: () => void;
}): Promise<boolean> {
  const parentKey = resolveTelegramDmModelParent(params.sessionKey);
  if (!parentKey) return false;
  const fallbackEntry: SessionEntry = { sessionId: randomUUID(), updatedAt: Date.now() };
  let remembered = false;
  const update = (entry: SessionEntry) => {
    if (entry.modelSelectionLocked) {
      return null;
    }
    const next = { ...entry };
    applyModelOverrideToSessionEntry({
      entry: next,
      selection: params.selection,
      explicitDefaultSelection: params.selection.isDefault,
      preserveAuthProfileOverride: true,
    });
    remembered = true;
    return next;
  };
  params.assertCurrent?.();
  const parent = params.storePath
    ? await patchSessionEntryCore(
        { agentId: params.agentId, sessionKey: parentKey, storePath: params.storePath },
        update,
        {
          fallbackEntry,
          replaceEntry: true,
          assertCommitAllowed: params.assertCurrent,
          requireWriteSuccess: true,
        },
      )
    : update(params.sessionStore?.[parentKey] ?? fallbackEntry);
  if (parent && params.sessionStore) {
    params.sessionStore[parentKey] = parent;
  }
  if (remembered) {
    emitSessionLifecycleEvent({
      sessionKey: parentKey,
      agentId: params.agentId,
      reason: "patch",
      catalogChanged: true,
    });
  }
  return remembered;
}
