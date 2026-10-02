import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { AgentDefaultsBaseSchema } from "../config/zod-schema.agent-defaults-base.js";
import { AgentEntryBaseSchema } from "../config/zod-schema.agent-entry-base.js";
import {
  clearInternalHooks,
  registerInternalHook,
  type AgentBootstrapHookContext,
} from "../hooks/internal-hooks.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resolveBootstrapContextForRun } from "./bootstrap-files.js";
import { resetLegacyWorkspaceStateCheckForTest } from "./workspace-legacy-state.test-support.js";
import { DEFAULT_MEMORY_FILENAME } from "./workspace.js";

vi.mock("../plugins/memory-runtime.js", () => ({
  classifyActiveMemoryWorkspacePaths: async () => ({ status: "unavailable" }),
}));

describe("group memory bootstrap", () => {
  it.each(["defaults", "entry"] as const)(
    "keeps the %s opt-in as a strict boolean config field",
    (owner) => {
      const schema = owner === "defaults" ? AgentDefaultsBaseSchema : AgentEntryBaseSchema;
      const input = (value: unknown) => ({
        ...(owner === "entry" ? { id: "personal" } : {}),
        bootstrapMemoryInGroups: value,
      });
      for (const value of [true, false]) {
        const result = schema.safeParse(input(value));
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.bootstrapMemoryInGroups).toBe(value);
        }
      }
      for (const value of ["true", 1, null]) {
        expect(schema.safeParse(input(value)).success).toBe(false);
      }
    },
  );

  let testState: OpenClawTestState;
  beforeEach(async () => {
    clearInternalHooks();
    resetLegacyWorkspaceStateCheckForTest();
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-group-memory-",
    });
  });
  afterEach(async () => {
    clearInternalHooks();
    closeOpenClawStateDatabaseForTest();
    resetLegacyWorkspaceStateCheckForTest();
    await testState.cleanup();
  });

  it.each([
    { label: "default group", chatType: "group", included: false },
    { label: "default channel", chatType: "channel", included: false },
    { label: "enabled group", chatType: "group", override: true, included: true },
    { label: "enabled channel", chatType: "channel", override: true, included: true },
    { label: "inherited opt-in", chatType: "group", defaults: true, included: true },
    {
      label: "explicit opt-out",
      chatType: "group",
      defaults: true,
      override: false,
      included: false,
    },
    {
      label: "override default off",
      chatType: "group",
      defaults: false,
      override: true,
      included: true,
    },
    {
      label: "another agent",
      chatType: "group",
      override: true,
      agentId: "other",
      included: false,
    },
    { label: "direct unchanged", chatType: "direct", override: false, included: true },
    {
      label: "topic key",
      sessionKey: "agent:personal:telegram:group:-100:topic:42",
      override: true,
      included: true,
    },
    {
      label: "authoritative group",
      sessionKey: "agent:personal:telegram:direct:123",
      chatType: "group",
      included: false,
    },
    {
      label: "cron",
      sessionKey: "agent:personal:cron:daily:run:1",
      chatType: "group",
      override: true,
      included: false,
    },
    {
      label: "subagent",
      sessionKey: "agent:personal:subagent:worker",
      chatType: "group",
      override: true,
      included: false,
    },
  ] as const)("resolves group-memory bootstrap policy: $label", async (scenario) => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-group-memory-");
    const memoryPath = path.join(workspaceDir, DEFAULT_MEMORY_FILENAME);
    await fs.writeFile(memoryPath, "private memory", "utf8");
    let hookReceivedMemory = false;
    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as AgentBootstrapHookContext;
      hookReceivedMemory = context.bootstrapFiles.some((file) => file.path === memoryPath);
    });
    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as AgentBootstrapHookContext;
      context.bootstrapFiles.push({
        name: DEFAULT_MEMORY_FILENAME,
        path: memoryPath,
        content: "hook memory",
        missing: false,
      });
    });
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          bootstrapMemoryInGroups: "defaults" in scenario ? scenario.defaults : undefined,
        },
        entries: {
          personal: {
            bootstrapMemoryInGroups: "override" in scenario ? scenario.override : undefined,
          },
          other: {},
        },
      },
    };
    const { contextFiles } = await resolveBootstrapContextForRun({
      workspaceDir,
      config,
      agentId: "agentId" in scenario ? scenario.agentId : "personal",
      sessionKey: "sessionKey" in scenario ? scenario.sessionKey : "opaque-binding",
      chatType: "chatType" in scenario ? scenario.chatType : undefined,
    });

    expect(hookReceivedMemory).toBe(scenario.included);
    const memory = contextFiles.filter((file) => file.path === memoryPath);
    expect(memory).toEqual(
      scenario.included ? [{ path: memoryPath, content: "private memory" }] : [],
    );
  });

  it("keeps enabled group memory within bootstrap context modes and budgets", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-group-budget-");
    const memoryPath = path.join(workspaceDir, DEFAULT_MEMORY_FILENAME);
    await fs.writeFile(memoryPath, "private memory ".repeat(1000), "utf8");
    const params = {
      workspaceDir,
      agentId: "personal",
      chatType: "group" as const,
      config: {
        agents: {
          entries: {
            personal: {
              bootstrapMemoryInGroups: true,
              bootstrapMaxChars: 512,
              bootstrapTotalMaxChars: 2048,
            },
          },
        },
      },
    };
    const { contextFiles } = await resolveBootstrapContextForRun(params);
    const memory = contextFiles.find((file) => file.path === memoryPath);
    expect(memory?.content).toContain("private memory");
    expect(memory!.content.length).toBeLessThanOrEqual(512);
    expect(
      contextFiles.reduce((total, file) => total + file.content.length, 0),
    ).toBeLessThanOrEqual(2048);
    expect(
      (await resolveBootstrapContextForRun({ ...params, contextMode: "lightweight" })).contextFiles,
    ).toEqual([]);
  });
});
