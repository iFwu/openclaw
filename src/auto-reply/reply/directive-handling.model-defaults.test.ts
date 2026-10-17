import { expect, it, vi } from "vitest";
import { persistStickyModelSelectionBestEffort } from "../../agents/sticky-model-selection.js";
import { rememberTelegramDmModelSelection } from "../../sessions/telegram-dm-model-selection.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { persistDirectiveModelDefaults } from "./directive-handling.model-defaults.js";
import { parseInlineSessionDirectives } from "./directive-handling.parse.js";

vi.mock("../../agents/sticky-model-selection.js", () => ({
  persistStickyModelSelectionBestEffort: vi.fn(),
}));
vi.mock("../../sessions/telegram-dm-model-selection.js", () => ({
  rememberTelegramDmModelSelection: vi.fn(),
}));

it("revalidates authority after the parent write before dispatching configured defaults", async () => {
  const entered = createDeferredCore<void>();
  const completion = createDeferredCore<boolean>();
  let revoked = false;
  vi.mocked(rememberTelegramDmModelSelection).mockImplementation(async () => {
    entered.resolve();
    return await completion.promise;
  });
  const sessionEntry = { sessionId: "topic", updatedAt: 1 };
  const sessionKey = "agent:main:telegram:direct:123:thread:123:42";
  const work = persistDirectiveModelDefaults({
    cfg: {},
    agentId: "main",
    sessionKey,
    sessionEntry,
    sessionStore: { [sessionKey]: sessionEntry },
    directives: parseInlineSessionDirectives("/model fixture/selected -g"),
    modelSelection: { provider: "fixture", model: "selected" },
    messageProvider: "telegram",
    commandAuthorized: true,
    canPersistStickyModelSelection: true,
    stickyModelSelectionTarget: "defaults",
    validateSelection: () => (revoked ? "authority revoked" : undefined),
    elevatedEnabled: false,
    elevatedAllowed: false,
    defaultProvider: "fixture",
    defaultModel: "original",
    provider: "fixture",
    model: "original",
    aliasIndex: { byAlias: new Map(), byKey: new Map() },
    allowedModelKeys: new Set(),
    allowedModelCatalog: [],
    resetModelOverride: false,
    initialModelLabel: "fixture/original",
    formatModelSwitchEvent: (label) => label,
  });
  await entered.promise;
  revoked = true;
  completion.resolve(true);
  expect(await work).toMatchObject({ errorText: "authority revoked" });
  expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
});
