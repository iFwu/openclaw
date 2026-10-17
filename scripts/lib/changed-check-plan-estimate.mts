// Reports planned changed-check cost from local history; never gates or reroutes execution.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ChangedCheckCommand } from "./changed-ci-lint-commands.mts";

/** Resource profile a planned command needs to complete on this host. */
export type PlanBudgetProfile = "shared-host" | "dedicated-test" | "dedicated-heavy";

export type PlanCostClass = "guard" | "audit" | "lint" | "typecheck" | "test" | "build";

export type PlanCommandCost = {
  costClass: PlanCostClass;
  profile: PlanBudgetProfile;
  // Null means the wrapper derives the budget from current headroom.
  minBudgetGiB: number | null;
};

export type PlanCommandEstimate = PlanCommandCost & {
  estimatedMs: number | null;
  samples: number;
};

export type PlanEstimate = {
  commands: PlanCommandEstimate[];
  estimatedMs: number | null;
  unknownCommands: number;
};

// Single-file vitest lanes complete inside the dedicated-test lane; type graphs
// and type-aware lint need the exclusive heavy lane; audits and guards are light.
const PROFILE_BUDGETS: Readonly<Record<PlanBudgetProfile, number | null>> = {
  "shared-host": null,
  "dedicated-test": 6,
  "dedicated-heavy": 14,
};

const HISTORY_LIMIT = 10;

// The budget table is the single source of truth for both the estimate and its label.
function costWith(costClass: PlanCostClass, profile: PlanBudgetProfile): PlanCommandCost {
  return { costClass, profile, minBudgetGiB: PROFILE_BUDGETS[profile] };
}

type TimingHistoryEntry = { durationMs: number; at: string };

type TimingHistory = Record<string, TimingHistoryEntry[]>;

const TYPECHECK_ARG_RE = /^tsgo:/u;
const TEST_ARG_RE = /^test:/u;
const BUILD_ARG_RE = /^(?:build|build:ci-artifacts|build:full|build:package)$/u;
// Guards are local scans over the diff; pnpm script names starting with these
// prefixes run generators, reports, or baseline comparisons over the repo.
const GUARD_SCRIPT_RE = /^check:no-conflict-markers$/u;
const AUDIT_SCRIPT_RE =
  /^(?:check|lint|deps|dup|prompt|runtime-sidecars|config|sqlite|plugin-sdk|plugins|changelog|android|release|doc)[:-]/u;

function commandKey(command: ChangedCheckCommand) {
  // Env is excluded: the same check under a different runner keeps one history.
  return JSON.stringify([command.bin ?? "pnpm", command.name, command.args]);
}

/** Classify a planned command into a cost class and its minimum budget profile. */
export function classifyPlannedCommand(command: ChangedCheckCommand): PlanCommandCost {
  const argv = command.args;
  const first = argv[0] ?? "";
  if (TYPECHECK_ARG_RE.test(first)) {
    return costWith("typecheck", "dedicated-heavy");
  }
  if (command.bin === "node" && argv[0] === "scripts/run-oxlint.mjs") {
    return costWith("lint", "dedicated-heavy");
  }
  if (BUILD_ARG_RE.test(first)) {
    return costWith("build", "dedicated-heavy");
  }
  if (TEST_ARG_RE.test(first)) {
    // A whole project or suite fans out; only explicit files fit the 6 GiB lane.
    const explicit = argv.filter((arg) => /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(arg));
    return costWith(
      "test",
      explicit.length > 0 && explicit.length <= 2 ? "dedicated-test" : "shared-host",
    );
  }
  if (GUARD_SCRIPT_RE.test(first)) {
    return costWith("guard", "shared-host");
  }
  if (AUDIT_SCRIPT_RE.test(first)) {
    return costWith("audit", "shared-host");
  }
  return costWith("guard", "shared-host");
}

/** Resolve the per-checkout validation state directory shared by sibling worktrees. */
export function resolveValidationStateDir(cwd = process.cwd()) {
  const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  return path.join(path.resolve(cwd, commonDir), "openclaw-validation");
}

function readHistory(file: string): TimingHistory {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as TimingHistory) : {};
  } catch {
    return {};
  }
}

function median(values: readonly number[]) {
  const sorted = [...values].toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

/**
 * Estimate a plan from recorded local runs. Missing history reports null rather
 * than a guessed duration, so an unknown plan never looks measured.
 */
export function estimateChangedCheckPlan(
  commands: readonly ChangedCheckCommand[],
  options: { historyFile?: string } = {},
): PlanEstimate {
  const history = options.historyFile ? readHistory(options.historyFile) : {};
  const estimates = commands.map((command) => {
    const cost = classifyPlannedCommand(command);
    const samples = history[commandKey(command)] ?? [];
    const durations = samples
      .map((entry) => entry.durationMs)
      .filter((duration) => Number.isFinite(duration) && duration >= 0);
    return {
      ...cost,
      estimatedMs: durations.length > 0 ? median(durations) : null,
      samples: durations.length,
    };
  });
  const known = estimates.filter((estimate) => estimate.estimatedMs !== null);
  return {
    commands: estimates,
    // Planned commands run serially, so the total is the sum, not the maximum.
    estimatedMs:
      known.length === 0 ? null : known.reduce((sum, entry) => sum + (entry.estimatedMs ?? 0), 0),
    unknownCommands: estimates.length - known.length,
  };
}

/** Record one completed command duration; failures never affect the calling check. */
export function recordPlanCommandTiming(
  command: ChangedCheckCommand,
  durationMs: number,
  options: { historyFile?: string; now?: Date } = {},
) {
  if (!options.historyFile || !Number.isFinite(durationMs) || durationMs < 0) {
    return false;
  }
  const history = readHistory(options.historyFile);
  const key = commandKey(command);
  const samples = history[key] ?? [];
  samples.push({
    durationMs: Math.round(durationMs),
    at: (options.now ?? new Date()).toISOString(),
  });
  history[key] = samples.slice(-HISTORY_LIMIT);
  const directory = path.dirname(options.historyFile);
  mkdirSync(directory, { recursive: true });
  const temporary = `${options.historyFile}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(history, null, 2)}\n`);
  renameSync(temporary, options.historyFile);
  return true;
}

/** Format a duration estimate; null stays visibly unknown instead of zero. */
export function formatEstimatedDuration(estimatedMs: number | null) {
  if (estimatedMs === null) {
    return "unknown";
  }
  if (estimatedMs < 1000) {
    return `~${Math.round(estimatedMs)}ms`;
  }
  if (estimatedMs < 60_000) {
    return `~${(estimatedMs / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(estimatedMs / 60_000);
  const seconds = Math.round((estimatedMs % 60_000) / 1000);
  return seconds === 0 ? `~${minutes}m` : `~${minutes}m${seconds}s`;
}

/** Describe one planned command's inferred cost without changing the command. */
export function describePlanCost(estimate: PlanCommandEstimate) {
  const budget =
    PROFILE_BUDGETS[estimate.profile] === null
      ? `${estimate.profile} auto`
      : `${estimate.profile} >=${PROFILE_BUDGETS[estimate.profile]} GiB`;
  const duration = formatEstimatedDuration(estimate.estimatedMs);
  const evidence = estimate.samples === 0 ? "no local history" : `${estimate.samples} local runs`;
  return `${estimate.costClass}, ${budget}, est ${duration} (${evidence})`;
}
