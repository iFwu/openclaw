import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import type { SessionEntry } from "../config/sessions.js";
import { projectSessionsPatchEntry } from "./sessions-patch.js";

export const MAIN_SESSION_KEY = "agent:main:main";

export function mainStoreEntry(overrides: Partial<SessionEntry>): Record<string, SessionEntry> {
  return {
    [MAIN_SESSION_KEY]: {
      sessionId: "sess",
      updatedAt: 1,
      ...overrides,
    },
  };
}

export async function applySessionsPatchToStore(
  params: Omit<
    Parameters<typeof projectSessionsPatchEntry>[0],
    "existingEntry" | "isLabelInUse"
  > & {
    store: Record<string, SessionEntry>;
    loadGatewayModelCatalog?: () => Promise<ModelCatalogEntry[]>;
  },
) {
  const load = params.loadGatewayModelCatalog;
  const projected = await projectSessionsPatchEntry({
    ...params,
    loadGatewayModelCatalogSnapshot: load
      ? async () => {
          const entries = await load();
          return { entries, routeVariants: entries };
        }
      : undefined,
    existingEntry: params.store[params.storeKey],
    isLabelInUse: (label) =>
      Object.entries(params.store).some(
        ([sessionKey, entry]) => sessionKey !== params.storeKey && entry.label === label,
      ),
  });
  if (projected.ok) {
    params.store[params.storeKey] = projected.entry;
  }
  return projected;
}
