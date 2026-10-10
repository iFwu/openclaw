import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectChangedLanes } from "../../scripts/changed-lanes.mts";
import {
  createChangedCheckPlan,
  createChangedCiLintPlan,
  runChangedCheck,
} from "../../scripts/check-changed.mts";
import { createCiCheckPlan } from "../../scripts/ci-check-plan.mts";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import {
  createOxlintShards,
  filterOxlintShards,
  parseShardRunnerArgs,
  selectCoreOxlintStripe,
  selectExtensionOxlintStripe,
} from "../../scripts/run-oxlint-shards.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.clearAllMocks();
});

vi.mock("../../scripts/lib/managed-child-process.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/managed-child-process.mts")>()),
  runManagedCommand: vi.fn(async () => 0),
}));

vi.mock("../../scripts/test-projects.test-support.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/test-projects.test-support.mts")>()),
  resolveImportGraphDependents: () => [],
  hasImportGraphImpactOnTargets: () => false,
}));

async function fullPlan(paths: string[], runnerProfile = "github") {
  const result = detectChangedLanes(paths);
  const plan = await createChangedCiLintPlan(result, {
    runnerProfile,
    materializeFullFallback: true,
  });
  if (!plan) {
    throw new Error("Expected a materialized lint fallback");
  }
  const selections = [
    plan.central,
    ...[...plan.core, ...plan.extensions].map(
      (row) => JSON.parse(row.lint_selection_json) as typeof plan.central,
    ),
  ];
  const commands = selections.flatMap(
    (lintSelection) =>
      createChangedCheckPlan(result, { lintOnly: true, lintSelection, lintThreads: 1 }).commands,
  );
  return { result, plan, selections, commands };
}

function selectedTargets(commands: ReturnType<typeof createChangedCheckPlan>["commands"]) {
  return commands
    .filter(({ args }) => args[2] === "scripts/run-oxlint-shards.mts")
    .flatMap(({ args }) => {
      const parsed = parseShardRunnerArgs(args.slice(3));
      expect(parsed.files).toBeUndefined();
      expect(args).toContain("--threads=1");
      const shards = createOxlintShards({
        splitCore: parsed.splitCore,
        splitExtensions: parsed.extensionStripe !== undefined,
        platform: "linux",
        hostResources: { logicalCpuCount: 16, totalMemoryBytes: 32 * 1024 ** 3 },
      });
      return selectExtensionOxlintStripe(
        selectCoreOxlintStripe(filterOxlintShards(shards, parsed.only), parsed.coreStripe),
        parsed.extensionStripe,
      ).flatMap(({ args: shardArgs }) =>
        shardArgs.slice(2).map((target) => `${shardArgs[1]}:${target}`),
      );
    })
    .toSorted();
}

describe("opt-in CI lint full fallback", () => {
  it.each(["github", "hybrid", "blacksmith"])(
    "partitions complete lint exactly once on the existing %s owners",
    async (runnerProfile) => {
      const paths = [
        ".oxlintrc.json",
        "README.md",
        "ui/src/styles/base.css",
        "test/scripts/ci-changed-lint.test.ts",
      ];
      const { result, plan, selections, commands } = await fullPlan(paths, runnerProfile);
      expect(selections.every(({ fullScope, files }) => fullScope && files.length === 0)).toBe(
        true,
      );
      expect(commands.some(({ args }) => args[0] === "lint")).toBe(false);
      expect(commands.some(({ args }) => args[0] === "lint:core")).toBe(false);
      expect(commands.some(({ args }) => args[0] === "lint:extensions")).toBe(false);
      for (const command of createChangedCheckPlan(result, { lintOnly: true }).commands) {
        if (command.args[0] === "lint") {
          expect(commands.filter(({ args }) => args[0] === "lint:ui:i18n")).toHaveLength(1);
          expect(
            commands.filter(({ args }) => args.includes("scripts/run-stylelint.mts")),
          ).toHaveLength(1);
        } else {
          expect(
            commands.filter(({ args }) => JSON.stringify(args) === JSON.stringify(command.args)),
          ).toHaveLength(command.bin === "node" ? 0 : 1);
          if (command.bin === "node") {
            expect(
              commands.filter(
                ({ args }) =>
                  JSON.stringify(args) === JSON.stringify([...command.args, "--threads=1"]),
              ),
            ).toHaveLength(1);
          }
        }
      }
      const expected = createOxlintShards({
        splitCore: runnerProfile !== "blacksmith",
        splitExtensions: runnerProfile !== "blacksmith",
        platform: "linux",
        hostResources: { logicalCpuCount: 16, totalMemoryBytes: 32 * 1024 ** 3 },
      })
        .flatMap(({ args }) => args.slice(2).map((target) => `${args[1]}:${target}`))
        .toSorted();
      expect(selectedTargets(commands)).toEqual(expected);
      if (runnerProfile === "github") {
        expect(plan.core.map(({ stripe }) => stripe)).toEqual([1, 2, 3, 4, 5]);
        expect(plan.extensions).toEqual([]);
        expect(plan.central.extensionStripes).toEqual([6]);
        expect(plan.central.groups).toEqual(["scripts"]);
        expect(plan.central.coreStripes).toEqual([]);
        for (const [index, row] of plan.core.entries()) {
          const selection = JSON.parse(row.lint_selection_json) as typeof plan.central;
          expect(selection.coreStripes).toEqual([index + 1]);
          expect(selection.extensionStripes).toEqual([index + 1]);
          expect(selection.central).toBe(false);
        }
      }
    },
  );

  it.each([
    ["scripts/deleted-ci-fixture.mts", "scripts", "config/tsconfig/oxlint.scripts.json"],
    ["src/deleted-ci-fixture.ts", "core", "config/tsconfig/oxlint.core.json"],
    ["src/types/node-runtime-globals.d.ts", "core", "config/tsconfig/oxlint.core.json"],
    ["extensions/telegram/deleted-ci-fixture.ts", "extensions", "extensions/tsconfig.json"],
  ] as const)("retains only the owning full lane for %s", async (file, group, config) => {
    const { plan, commands } = await fullPlan([file]);
    const expected = createOxlintShards({
      splitCore: true,
      splitExtensions: true,
      platform: "linux",
    })
      .filter(({ name }) => name === group || name.startsWith(`${group}:`))
      .flatMap(({ args }) => args.slice(2).map((target) => `${args[1]}:${target}`))
      .toSorted();
    const targets = selectedTargets(commands);
    expect(targets).toEqual(expected);
    expect(targets.every((target) => target.startsWith(`${config}:`))).toBe(true);
    if (group === "scripts") {
      expect(plan.core).toEqual([]);
      expect(plan.extensions).toEqual([]);
      expect(plan.central.groups).toEqual(["scripts"]);
      for (const guard of ["lint:docker-e2e", "lint:tmp:no-raw-http2-imports"]) {
        expect(commands.filter(({ args }) => args[0] === guard)).toHaveLength(1);
      }
    }
  });

  it("retains formatter, root-test, and targeted style commands in a mixed fallback", async () => {
    const paths = [
      "scripts/deleted-ci-fixture.mts",
      "ui/src/styles/base.css",
      "README.md",
      "test/scripts/ci-changed-lint.test.ts",
    ];
    const { result, plan } = await fullPlan(paths);
    const original = createChangedCheckPlan(result, { lintOnly: true }).commands;
    const central = createChangedCheckPlan(result, {
      lintOnly: true,
      lintSelection: plan.central,
      lintThreads: 1,
    }).commands;
    for (const command of original.filter(
      ({ args }) => args[0] !== "lint:scripts" && args[0] !== "lint:core",
    )) {
      const args =
        command.args[0] === "scripts/run-oxlint.mjs"
          ? [...command.args, "--threads=1"]
          : command.args;
      expect(central.map((entry) => entry.args)).toContainEqual(args);
    }
    expect(
      central.some(({ args }) => args[0] === "format:check" && args.includes("README.md")),
    ).toBe(true);
    expect(central.some(({ args }) => args.includes("test/tsconfig/tsconfig.test.root.json"))).toBe(
      true,
    );
    expect(central.some(({ args }) => args.includes("scripts/run-stylelint.mts"))).toBe(true);
  });

  it.each([
    ["apps/android/app/src/main/java/ai/openclaw/app/MainActivity.kt"],
    ["apps/android/app/src/main/java/ai/openclaw/app/MainActivity.kt", "src/utils.ts"],
  ])("retains Android lint exactly once in central ownership for %j", async (...paths) => {
    const { result, plan, commands } = await fullPlan(paths);
    expect(
      createChangedCheckPlan(result, { phase: "lint" }).commands.filter(
        ({ args }) => args[0] === "android:lint",
      ),
    ).toHaveLength(1);
    expect(commands.filter(({ args }) => args[0] === "android:lint")).toHaveLength(1);
    expect(
      createChangedCheckPlan(result, { lintOnly: true, lintSelection: plan.central }).commands.some(
        ({ args }) => args[0] === "android:lint",
      ),
    ).toBe(true);
    expect(
      createChangedCheckPlan(result, { lintOnly: true }).commands.some(
        ({ args }) => args[0] === "android:lint",
      ),
    ).toBe(false);
  });

  it("retains available SwiftLint only in the explicit central selection", async () => {
    const { result, plan } = await fullPlan(["apps/macos/Sources/OpenClaw/AppState.swift"]);
    const options = { lintOnly: true, platform: "darwin" as const, swiftlintAvailable: true };
    expect(
      createChangedCheckPlan(result, { ...options, lintSelection: plan.central }).commands.filter(
        ({ args }) => args[0] === "lint:apps",
      ),
    ).toHaveLength(1);
    expect(
      createChangedCheckPlan(result, options).commands.some(({ args }) => args[0] === "lint:apps"),
    ).toBe(false);
  });

  it("keeps changed selections and legacy null fallback when not opted in", async () => {
    const result = detectChangedLanes([".oxlintrc.json"]);
    expect(await createChangedCiLintPlan(result, { runnerProfile: "github" })).toBeNull();
    expect(
      await createChangedCiLintPlan(result, {
        runnerProfile: "github",
        materializeFullFallback: false,
      }),
    ).toBeNull();
    const changed = detectChangedLanes(["src/utils.ts"]);
    expect(
      await createChangedCiLintPlan(changed, {
        runnerProfile: "github",
        materializeFullFallback: true,
      }),
    ).toEqual(await createChangedCiLintPlan(changed, { runnerProfile: "github" }));
  });

  it("executes full selections with empty files without repeating the lint umbrella", async () => {
    const { result, selections, commands } = await fullPlan([".oxlintrc.json"]);
    const env = { ...process.env, CI: "", GITHUB_ACTIONS: "" };
    for (const lintSelection of selections) {
      expect(
        await runChangedCheck(result, { lintOnly: true, lintSelection, lintThreads: 1, env }),
      ).toBe(0);
    }
    expect(vi.mocked(runManagedCommand).mock.calls.map(([command]) => command.args)).toEqual(
      commands.map(({ args }) => args),
    );
    vi.mocked(runManagedCommand).mockClear();
    const empty = detectChangedLanes([]);
    const lintSelection = {
      files: [],
      fullScope: true,
      coreStripes: [1],
      extensionStripes: [],
      groups: [],
      central: false,
    } satisfies (typeof selections)[number];
    expect(
      await runChangedCheck(empty, { lintOnly: true, lintSelection, lintThreads: 1, env }),
    ).toBe(0);
    expect(runManagedCommand).toHaveBeenCalledOnce();
    vi.mocked(runManagedCommand).mockClear();
    expect(await runChangedCheck(empty, { lintOnly: true })).toBe(0);
    expect(runManagedCommand).not.toHaveBeenCalled();
    expect(
      createChangedCheckPlan(result, {
        lintOnly: true,
        lintSelection: { ...lintSelection, fullScope: false },
      }).commands,
    ).toEqual([]);
  });

  it("passes the explicit fallback option through check planning", async () => {
    const input = {
      typeGraphBoundaryOwner: "check-plan" as const,
      changedPaths: [".oxlintrc.json"],
      changedCoreTestPaths: null,
      runnerProfile: "github",
      checkMatrix: { include: [{ check_name: "lint", task: "lint", runner: "unused" }] },
      coreTypeMatrix: { include: [] },
      lintCoreMatrix: { include: [1, 2, 3, 4, 5].map((stripe) => ({ stripe })) },
      lintExtensionMatrix: { include: [] },
    };
    const legacy = await createCiCheckPlan(input);
    expect(legacy.central_lint_selection_json).toBe("");
    const plan = await createCiCheckPlan({ ...input, materializeFullFallback: true });
    expect(JSON.parse(plan.central_lint_selection_json).fullScope).toBe(true);
    expect(plan.lint_core_matrix.include).toHaveLength(5);
    expect(
      plan.lint_core_matrix.include.every(
        ({ lint_selection_json }) => JSON.parse(lint_selection_json!).fullScope,
      ),
    ).toBe(true);
    expect(plan.check_job_count).toBe(6);
  });

  it("rejects a nonboolean fallback option at the JSON entrypoint", () => {
    const output = path.join(tempDirs.make("ci-lint-input-"), "output");
    const result = spawnSync(
      process.execPath,
      ["--import", "./scripts/tsx.mjs", "scripts/ci-check-plan.mts"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          OPENCLAW_CI_CHECK_PLAN_INPUT_JSON: JSON.stringify({
            runnerProfile: "github",
            materializeFullFallback: "true",
          }),
        },
      },
    );
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("boolean materializeFullFallback");
  });
});
