import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { detectChangedLanes } from "../../scripts/changed-lanes.mts";
import { createChangedCheckPlan } from "../../scripts/check-changed.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";

const phases = ["guards", "types", "lint", "audits"] as const;
const inputs = [
  ["README.md"],
  ["src/agents/model-fallback.test.ts"],
  ["src/infra/sqlite-worker-operation-admission.ts"],
  ["extensions/telegram/src/bot-message-dispatch-delivery.ts"],
  ["scripts/check-changed.mts"],
  ["pnpm-lock.yaml"],
  [".github/workflows/fork-ci-artifacts.yml", "test/scripts/fork-ci-artifacts.test.ts"],
];

function commandKey(command: ReturnType<typeof createChangedCheckPlan>["commands"][number]) {
  return JSON.stringify(command);
}

describe("changed-check phases", () => {
  it.each(inputs.map((paths) => ({ paths })))(
    "partitions every original command exactly once for $paths",
    ({ paths }) => {
      const lanes = detectChangedLanes(paths);
      const full = createChangedCheckPlan(lanes);
      const partitioned = phases.flatMap((phase) =>
        createChangedCheckPlan(lanes, { phase }).commands.map(commandKey),
      );
      expect(partitioned.toSorted()).toEqual(full.commands.map(commandKey).toSorted());
      expect(createChangedCheckPlan(lanes, { phase: "all" })).toEqual(full);
      const legacy = createChangedCheckPlan(lanes, { phase: "guards-types" }).commands;
      const split = ["guards", "types"] as const;
      const splitKeys = new Set(
        split.flatMap((phase) => createChangedCheckPlan(lanes, { phase }).commands.map(commandKey)),
      );
      expect(legacy).toEqual(full.commands.filter((command) => splitKeys.has(commandKey(command))));
      expect(legacy.map(commandKey).toSorted()).toEqual(
        split
          .flatMap((phase) => createChangedCheckPlan(lanes, { phase }).commands.map(commandKey))
          .toSorted(),
      );
      for (const phase of phases) {
        const selected = createChangedCheckPlan(lanes, { phase }).commands.map(commandKey);
        const membership = new Set(selected);
        expect(selected).toEqual(
          full.commands.map(commandKey).filter((key) => membership.has(key)),
        );
      }
    },
  );

  it("keeps compiler boundary discovery with its consuming typecheck", () => {
    const lanes = detectChangedLanes(["src/agents/model-fallback.test.ts"]);
    const validation = createChangedCheckPlan(lanes, { phase: "types" }).commands;
    expect(validation.flatMap((command) => command.coreTestCheck ?? [])).toEqual([
      "checkBoundary",
      "checkTypes",
    ]);
    for (const phase of ["guards", "lint", "audits"] as const) {
      expect(createChangedCheckPlan(lanes, { phase }).commands.every((c) => !c.coreTestCheck)).toBe(
        true,
      );
    }
  });

  it("keeps erasability and noncompiler guards outside the type phase", () => {
    const lanes = detectChangedLanes(["scripts/check-changed.mts"]);
    const guards = createChangedCheckPlan(lanes, { phase: "guards" }).commands;
    const types = createChangedCheckPlan(lanes, { phase: "types" }).commands;
    expect(guards.some(({ args }) => args[0] === "check:script-erasability")).toBe(true);
    expect(guards.some(({ args }) => args[0] === "check:no-conflict-markers")).toBe(true);
    expect(guards.some(({ args }) => args[0]?.startsWith("tsgo:"))).toBe(false);
    expect(guards.some(({ args }) => args[0] === "lint:tmp:tsgo-core-boundary")).toBe(false);
    expect(types.some(({ args }) => args[0] === "check:script-erasability")).toBe(false);
    expect(types.some(({ args }) => args[0] === "lint:tmp:tsgo-core-boundary")).toBe(true);
    expect(types.some(({ args }) => args[0] === "tsgo:scripts")).toBe(true);
  });

  it("retains hard-zero export audits without serializing lint behind them", () => {
    const lanes = detectChangedLanes(["test/scripts/fork-ci-artifacts.test.ts"]);
    const audits = createChangedCheckPlan(lanes, { phase: "audits" }).commands;
    expect(
      audits.some((command) => command.args.includes("scripts/check-deadcode-exports.mts")),
    ).toBe(true);
    const lint = createChangedCheckPlan(lanes, { phase: "lint" }).commands;
    expect(lint.some((command) => command.args.includes("scripts/run-oxlint.mjs"))).toBe(true);
    expect(
      lint.some((command) => command.args.includes("scripts/check-deadcode-exports.mts")),
    ).toBe(false);
  });

  it("rejects mixing a phase with the separate CI lint selector", () => {
    expect(() =>
      createChangedCheckPlan(detectChangedLanes(["README.md"]), {
        lintOnly: true,
        phase: "guards-types",
      }),
    ).toThrow("cannot be combined");
  });

  it.each(["lint", "guards", "types"] as const)("routes the CLI dry-run to only %s", (phase) => {
    const paths = ["scripts/e2e/parallels/filesystem.ts"];
    const result = spawnSync(
      resolveTestNodeExecPath(),
      ["scripts/check-changed.mjs", "--phase", phase, "--dry-run", "--", ...paths],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    const output = result.stdout + result.stderr;
    const selected = createChangedCheckPlan(detectChangedLanes(paths), { phase }).commands;
    const full = createChangedCheckPlan(detectChangedLanes(paths)).commands;
    for (const command of full) {
      const invocation = [command.bin ?? "pnpm", ...command.args].join(" ");
      if (selected.some((entry) => entry.name === command.name)) {
        expect(output).toContain(`would run: ${invocation}`);
      } else {
        expect(output).not.toContain(`would run: ${invocation}`);
      }
    }
  });

  it("rejects an unknown CLI phase before running any check", () => {
    const result = spawnSync(
      resolveTestNodeExecPath(),
      ["scripts/check-changed.mjs", "--phase", "unknown", "--no-changes"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--phase must be");
    expect(result.stdout + result.stderr).not.toContain("nothing to run");
  });
});
