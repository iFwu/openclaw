import { expect, it, vi } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveStoredModelOverride } from "./stored-model-overrides.js";
import {
  rememberTelegramDmModelSelection,
  withTelegramDmModelSelection,
} from "./telegram-dm-model-selection.js";

it("serializes same-millisecond topic choices through durable preference completion and supports Default", async () => {
  await withOpenClawTestState({ layout: "state-only" }, async (state) => {
    const parentKey = "agent:main:telegram:direct:123";
    const scope = {
      agentId: "main",
      storePath: state.path("sessions.json"),
      sessionKey: parentKey,
    };
    const remember = (topic: number, model: string, isDefault = false) =>
      rememberTelegramDmModelSelection({
        ...scope,
        sessionKey: `${parentKey}:thread:123:${topic}`,
        selection: { provider: "fixture", model, isDefault },
      });
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const order: string[] = [];
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      const first = withTelegramDmModelSelection([`${parentKey}:thread:123:20`], async () => {
        order.push("first");
        entered.resolve();
        await release.promise;
        await remember(20, "first");
      });
      await entered.promise;
      const second = withTelegramDmModelSelection([`${parentKey}:thread:123:21`], async () => {
        order.push("second");
        await remember(21, "newest");
      });
      expect(order).toEqual(["first"]);
      release.resolve();
      await Promise.all([first, second]);
      expect(order).toEqual(["first", "second"]);
    } finally {
      release.resolve();
      clock.mockRestore();
    }
    const parent = loadSessionEntry(scope);
    if (!parent) {
      throw new Error("Expected the remembered DM parent");
    }
    expect(parent.modelOverride).toBe("newest");
    expect(
      resolveStoredModelOverride({
        sessionKey: `${parentKey}:thread:123:next`,
        sessionStore: { [parentKey]: parent },
        defaultProvider: "fixture",
      }),
    ).toMatchObject({ model: "newest", source: "parent" });
    await remember(30, "configured", true);
    expect(loadSessionEntry(scope)).toMatchObject({ modelOverrideSource: "default" });
    expect(loadSessionEntry(scope)?.modelOverride).toBeUndefined();
    await replaceSessionEntry(scope, {
      sessionId: "locked",
      updatedAt: 1,
      modelSelectionLocked: true,
      modelOverride: "locked-model",
    });
    expect(await remember(40, "ignored")).toBe(false);
    expect(loadSessionEntry(scope)?.modelOverride).toBe("locked-model");
  });
});

it.each([
  "agent:main:telegram:group:-123:topic:42",
  "agent:main:discord:channel:123:thread:42",
  "agent:main:subagent:123",
  "agent:main:telegram:direct:123",
])("does not write a DM preference for %s", async (sessionKey) => {
  expect(
    await rememberTelegramDmModelSelection({
      agentId: "main",
      sessionKey,
      selection: { provider: "fixture", model: "selected" },
    }),
  ).toBe(false);
});

it.each([
  ["agent:main:telegram:work:direct:123:thread:123:42", "agent:main:telegram:work:direct:123"],
  [
    "agent:main:telegram:direct:linked-person:thread:123:42",
    "agent:main:telegram:direct:linked-person",
  ],
])("retains account and linked identity for %s", async (sessionKey, parentKey) => {
  const sessionStore: Record<string, import("../config/sessions/types.js").SessionEntry> = {};
  expect(
    await rememberTelegramDmModelSelection({
      agentId: "main",
      sessionKey,
      sessionStore,
      selection: { provider: "fixture", model: "selected" },
    }),
  ).toBe(true);
  expect(sessionStore[parentKey]).toMatchObject({
    providerOverride: "fixture",
    modelOverride: "selected",
  });
});
