import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyPlannedCommand,
  describePlanCost,
  estimateChangedCheckPlan,
  formatEstimatedDuration,
  recordPlanCommandTiming,
} from "../../scripts/lib/changed-check-plan-estimate.mts";

const temporaryDirs: string[] = [];

function temporaryHistoryFile() {
  const dir = mkdtempSync(path.join(tmpdir(), "plan-estimate-"));
  temporaryDirs.push(dir);
  return path.join(dir, "plan-timings.json");
}

afterEach(() => {
  while (temporaryDirs.length) {
    rmSync(temporaryDirs.pop()!, { recursive: true, force: true });
  }
});

describe("classifyPlannedCommand", () => {
  it("puts type graphs on the exclusive heavy lane", () => {
    expect(classifyPlannedCommand({ name: "typecheck core", args: ["tsgo:core"] })).toEqual({
      costClass: "typecheck",
      profile: "dedicated-heavy",
      minBudgetGiB: 14,
    });
  });

  it("treats type-aware oxlint as a heavy lane", () => {
    const cost = classifyPlannedCommand({
      name: "lint core changed file",
      bin: "node",
      args: ["scripts/run-oxlint.mjs", "--tsconfig", "config/tsconfig/oxlint.core.json", "a.ts"],
    });
    expect(cost.costClass).toBe("lint");
    expect(cost.minBudgetGiB).toBe(14);
  });

  it("fits one or two explicit test files in the dedicated-test lane", () => {
    expect(
      classifyPlannedCommand({
        name: "test changed file",
        args: ["test:bounded", "src/a.test.ts"],
      }),
    ).toEqual({ costClass: "test", profile: "dedicated-test", minBudgetGiB: 6 });
  });

  it("keeps project-wide test runs on the headroom-derived budget", () => {
    const cost = classifyPlannedCommand({ name: "test suite", args: ["test:bounded"] });
    expect(cost).toEqual({ costClass: "test", profile: "shared-host", minBudgetGiB: null });
  });

  it("classifies guards and audits as light commands", () => {
    expect(
      classifyPlannedCommand({ name: "conflict markers", args: ["check:no-conflict-markers"] })
        .costClass,
    ).toBe("guard");
    expect(
      classifyPlannedCommand({ name: "deprecated API usage", args: ["check:deprecated-api-usage"] })
        .costClass,
    ).toBe("audit");
  });
});

describe("estimateChangedCheckPlan", () => {
  it("reports unknown instead of a guess when no history exists", () => {
    const estimate = estimateChangedCheckPlan([{ name: "typecheck core", args: ["tsgo:core"] }], {
      historyFile: temporaryHistoryFile(),
    });
    expect(estimate.estimatedMs).toBeNull();
    expect(estimate.unknownCommands).toBe(1);
    expect(describePlanCost(estimate.commands[0]!)).toContain("est unknown");
  });

  it("uses the median of recorded runs and sums the serial plan", () => {
    const historyFile = temporaryHistoryFile();
    const slow = { name: "typecheck core", args: ["tsgo:core"] };
    const fast = { name: "conflict markers", args: ["check:no-conflict-markers"] };
    for (const durationMs of [900_000, 1_000_000, 1_100_000]) {
      recordPlanCommandTiming(slow, durationMs, { historyFile });
    }
    recordPlanCommandTiming(fast, 400, { historyFile });
    const estimate = estimateChangedCheckPlan([slow, fast], { historyFile });
    expect(estimate.commands[0]!.estimatedMs).toBe(1_000_000);
    expect(estimate.commands[0]!.samples).toBe(3);
    expect(estimate.estimatedMs).toBe(1_000_400);
    expect(estimate.unknownCommands).toBe(0);
  });

  it("keeps only the most recent samples", () => {
    const historyFile = temporaryHistoryFile();
    const command = { name: "conflict markers", args: ["check:no-conflict-markers"] };
    for (let index = 0; index < 15; index += 1) {
      recordPlanCommandTiming(command, index, { historyFile });
    }
    const estimate = estimateChangedCheckPlan([command], { historyFile });
    expect(estimate.commands[0]!.samples).toBe(10);
  });

  it("records nothing without a history file", () => {
    expect(recordPlanCommandTiming({ name: "x", args: ["y"] }, 10)).toBe(false);
  });

  it("formats durations without rounding a subsecond check to zero", () => {
    expect(formatEstimatedDuration(null)).toBe("unknown");
    expect(formatEstimatedDuration(250)).toBe("~250ms");
    expect(formatEstimatedDuration(12_300)).toBe("~12.3s");
    expect(formatEstimatedDuration(125_000)).toBe("~2m5s");
  });

  it("writes a parseable file even when the directory is new", () => {
    const historyFile = temporaryHistoryFile();
    recordPlanCommandTiming({ name: "a", args: ["b"] }, 5, { historyFile });
    writeFileSync(`${historyFile}.marker`, "");
    expect(
      estimateChangedCheckPlan([{ name: "a", args: ["b"] }], { historyFile }).estimatedMs,
    ).toBe(5);
  });
});
