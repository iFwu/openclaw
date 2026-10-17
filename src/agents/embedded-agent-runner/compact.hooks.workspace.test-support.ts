import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createTestSession,
  testModel,
} from "../sessions/agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "../sessions/agent-session-loop-resource-loader.test-support.js";
import { createEventBus } from "../sessions/event-bus.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "../sessions/extensions/loader.js";
import { SessionManager } from "../sessions/session-manager.js";
import { SettingsManager } from "../sessions/settings-manager.js";
import {
  limitHistoryTurnsMock,
  resolveEffectiveCompactionModeMock,
} from "./compact.hooks.harness.js";

/** The enclosing harness owns session lifecycle and restores history/mock state. */
export function registerExplicitWorkspaceCompactionTest(input: {
  getWorkspaceDir: () => string;
  getSafeguard: () => typeof import("../agent-hooks/compaction-safeguard.js").default;
  compact: (
    config: OpenClawConfig,
  ) => ReturnType<typeof import("./compact.js").compactEmbeddedAgentSessionDirect>;
}) {
  it("keeps workspace rules in explicit compaction when the Gateway cwd differs", async () => {
    const workspaceDir = input.getWorkspaceDir();
    const safeguard = input.getSafeguard();
    const { createAgentSessionForEmbeddedRunner } = await import("../sessions/sdk.js");
    const { guardSessionManager } = await import("../session-tool-result-guard-wrapper.js");
    const { buildEmbeddedExtensionFactories } = await import("./extensions.js");
    const actualExtensions =
      await vi.importActual<typeof import("./extensions.js")>("./extensions.js");
    await writeFile(
      join(workspaceDir, "AGENTS.md"),
      "## Compaction fixture\nWORKSPACE_RULE_MARKER\n",
    );
    const sessionManager = SessionManager.inMemory(workspaceDir);
    for (const content of ["Start the task.", "Preserve workspace rules.", "Continue the task."]) {
      sessionManager.appendMessage({ role: "user", content, timestamp: 1 });
    }
    const extension = await loadExtensionFromFactory(
      safeguard,
      workspaceDir,
      createEventBus(),
      createExtensionRuntime(),
    );
    const factory = vi.mocked(buildEmbeddedExtensionFactories);
    const createSession = vi.mocked(createAgentSessionForEmbeddedRunner);
    const previousHistory = limitHistoryTurnsMock.getMockImplementation();
    if (!previousHistory) {
      throw new Error("Expected the history-limit fixture implementation");
    }
    const previousFactory = factory.getMockImplementation();
    const previousSession = createSession.getMockImplementation();
    factory.mockImplementation(actualExtensions.buildEmbeddedExtensionFactories);
    vi.mocked(guardSessionManager).mockReturnValue(sessionManager);
    limitHistoryTurnsMock.mockImplementation((messages) => messages);
    resolveEffectiveCompactionModeMock.mockReturnValue("safeguard");
    createSession.mockImplementation(async () =>
      createTestSession({
        model: testModel,
        sessionManager,
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: false, reserveTokens: 1_024, keepRecentTokens: 1 },
          retry: { enabled: false },
        }),
        resourceLoader: createResourceLoader(extension.handlers),
      }),
    );
    try {
      const result = await input.compact({
        agents: {
          defaults: {
            compaction: {
              mode: "safeguard",
              postCompactionSections: ["Compaction fixture"],
              recentTurnsPreserve: 0,
              qualityGuard: { enabled: false },
            },
          },
        },
      });
      expect(result, result.reason).toMatchObject({ ok: true, compacted: true });
      expect(result.result?.summary).toContain(
        "<workspace-critical-rules>\n## Compaction fixture\nWORKSPACE_RULE_MARKER\n</workspace-critical-rules>",
      );
    } finally {
      factory.mockReset();
      if (previousFactory) {
        factory.mockImplementation(previousFactory);
      }
      createSession.mockReset();
      if (previousSession) {
        createSession.mockImplementation(previousSession);
      }
      limitHistoryTurnsMock.mockImplementation(previousHistory);
    }
  });
}
