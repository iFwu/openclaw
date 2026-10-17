import { afterEach, expect, it, vi } from "vitest";
import * as sessions from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import {
  withAgentSessionModelPatchOrigin,
  withSessionStatusModelPatchOrigin,
} from "../session-model-patch-origin.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import type { GatewayClient, RespondFn } from "./types.js";

vi.mock("../../agents/model-runtime-choice.js", () => ({
  preparePublishedModelRuntimeChoice: vi.fn(async () => ({
    kind: "ready",
    runtimeId: "openclaw",
    validate: () => undefined,
  })),
}));
vi.mock("../../plugins/provider-thinking.js", () => ({
  resolveEffectiveThinkingProfile: () => undefined,
}));

afterEach(() => vi.restoreAllMocks());

it.each(["manual", "session-only", "agent", "status", "non-admin", "revoked"])(
  "remembers only an authorized manual topic selection (%s)",
  async (origin) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const models = [
        { provider: "fixture", id: "original", name: "Original" },
        { provider: "fixture", id: "selected", name: "Selected" },
      ];
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: "fixture/original", modelPolicy: { allow: ["fixture/*"] } } },
        models: {
          providers: {
            fixture: {
              api: "openai-completions",
              baseUrl: "https://fixture.invalid/v1",
              models: models.map(({ id, name }) => ({ id, name })),
            },
          },
        },
      };
      const parentKey = "agent:main:telegram:direct:123";
      const sessionKey = `${parentKey}:thread:123:42`;
      const storePath = state.path("sessions.json");
      cfg.session = { store: storePath };
      const scope = { agentId: "main", storePath };
      await sessions.replaceSessionEntry(
        { ...scope, sessionKey: parentKey },
        {
          sessionId: "parent",
          updatedAt: 1,
          providerOverride: "fixture",
          modelOverride: "original",
        },
      );
      await sessions.replaceSessionEntry(
        { ...scope, sessionKey },
        { sessionId: "topic", updatedAt: 1 },
      );
      let current = true;
      if (origin === "revoked") {
        const patch = sessions.patchSessionEntryCore;
        vi.spyOn(sessions, "patchSessionEntryCore").mockImplementation(async (target, ...args) => {
          if (target.sessionKey === parentKey) current = false;
          return await patch(target, ...args);
        });
      }
      const context = {
        ...createDirectChatContext({ getRuntimeConfig: () => cfg }),
        loadGatewayModelCatalogSnapshot: async () => ({
          entries: models,
          routeVariants: models,
          agentId: "main",
          agentDir: state.agentDir("main"),
          workspaceDir: state.workspaceDir,
          config: cfg,
          catalogComplete: true,
        }),
      };
      const client: GatewayClient = {
        connId: "dm-model-test",
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
          role: "operator",
          scopes: [origin === "non-admin" ? "operator.write" : "operator.admin"],
        },
      };
      const params = {
        key: sessionKey,
        model: "fixture/selected",
        ...(origin === "session-only" ? { modelSelectionScope: "session" } : {}),
      };
      const responses: Parameters<RespondFn>[] = [];
      const run = () =>
        sessionMutationHandlers["sessions.patch"]?.({
          req: { type: "req", id: "patch-dm-model", method: "sessions.patch", params },
          params,
          context,
          client,
          hasCurrentClientAuthority: () => current,
          isWebchatConnect: () => true,
          respond: (...value) => responses.push(value),
        });
      if (origin === "agent") await withAgentSessionModelPatchOrigin(run);
      else if (origin === "status") await withSessionStatusModelPatchOrigin(run);
      else await run();
      expect(responses).toHaveLength(1);
      expect(responses[0]?.[0]).toBe(origin !== "revoked");
      expect(sessions.loadSessionEntry({ ...scope, sessionKey })?.modelOverride).toBe("selected");
      expect(sessions.loadSessionEntry({ ...scope, sessionKey: parentKey })?.modelOverride).toBe(
        origin === "manual" ? "selected" : "original",
      );
      expect(cfg.agents?.defaults?.model).toBe("fixture/original");
    });
  },
);
