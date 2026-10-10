#!/usr/bin/env node
// Dispatch the existing check owners on independent hosted runners.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { z } from "zod";
import {
  detectChangedLanesForPaths,
  getChangedCoreTestPaths,
  listChangedPathsFromGit,
  type ChangedLaneResult,
} from "./changed-lanes.mts";
import { createChangedCheckPlan, runChangedCheck } from "./check-changed.mts";
import { createCiCheckPlan } from "./ci-check-plan.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { runWithFailedTrailer } from "./lib/failed-trailer.mts";
import { runManagedCommand } from "./lib/managed-child-process.mts";
import { resolveCiTsgoGraphs } from "./lib/tsgo-core-test-shards.mts";

const lintSelectionSchema = z
  .object({
    files: z.array(z.string()),
    rootTestFiles: z.array(z.string()).optional(),
    coreStripes: z.array(z.number().int().min(1).max(5)),
    extensionStripes: z.array(z.number().int().min(1).max(6)),
    groups: z.array(z.enum(["core", "extensions", "scripts"])),
    central: z.boolean(),
    fullScope: z.boolean().optional(),
  })
  .strict();
const regressionTestSchema = z
  .string()
  .max(4096)
  .regex(/^(?:src|extensions|packages|test|ui)\/[A-Za-z0-9_./-]+\.test\.[cm]?[jt]sx?$/u)
  .refine((file) => !file.split("/").includes(".."), "Test paths must stay in the repository");
const taskSchema = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), kind: z.literal("test"), testFile: regressionTestSchema }).strict(),
  z
    .object({ id: z.string(), kind: z.literal("phase"), phase: z.enum(["guards", "audits"]) })
    .strict(),
  z
    .object({ id: z.string(), kind: z.literal("types"), graphs: z.array(z.string()).min(1) })
    .strict(),
  z.object({ id: z.string(), kind: z.literal("lint"), selection: lintSelectionSchema }).strict(),
]);
type ForkCiTask = z.infer<typeof taskSchema>;
type SourceRange = { base: string; head: string };

/** Plan once after dependency setup; executor rows never rediscover compiler membership. */
export async function createForkCiCheckPlan(
  result: ChangedLaneResult,
  range: SourceRange,
  regressionTests: string[] = [],
) {
  const tests = z.array(regressionTestSchema).max(32).parse(regressionTests);
  const regressionRows: ForkCiTask[] = [...new Set(tests)].map((testFile, index) => ({
    id: `regression-${index + 1}`,
    kind: "test",
    testFile,
  }));
  if (result.paths.length === 0) {
    return { include: regressionRows };
  }
  const originalTypes = createChangedCheckPlan(result, { ...range, phase: "types" }).commands;
  const originalLint = createChangedCheckPlan(result, { ...range, phase: "lint" }).commands;
  const types = originalTypes.length > 0;
  const lint = originalLint.length > 0;
  const stripes = [1, 2, 3, 4, 5].map((stripe) => ({ stripe }));
  const native = await createCiCheckPlan(
    {
      typeGraphBoundaryOwner: "check-plan",
      changedPaths: result.paths,
      changedCoreTestPaths: getChangedCoreTestPaths(result) ?? null,
      runnerProfile: "github",
      materializeFullFallback: true,
      checkMatrix: {
        include: [...(types ? ["prod-types", "test-types"] : []), ...(lint ? ["lint"] : [])].map(
          (task) => ({ check_name: task, task, runner: "ubuntu-24.04" }),
        ),
      },
      coreTypeMatrix: { include: types ? stripes : [] },
      lintCoreMatrix: { include: lint ? stripes : [] },
      lintExtensionMatrix: { include: [] },
    },
    result,
  );
  const tasks: ForkCiTask[] = regressionRows;
  for (const phase of ["guards", "audits"] as const) {
    if (createChangedCheckPlan(result, { ...range, phase }).commands.length) {
      tasks.push({ id: phase, kind: "phase", phase });
    }
  }
  const addTypes = (id: string, encoded: string | undefined, split: boolean) => {
    const names = z.array(z.string()).parse(JSON.parse(encoded ?? "[]"));
    if (names.length === 0) {
      return;
    }
    resolveCiTsgoGraphs(names);
    if (split) {
      tasks.push(
        ...names.map((name): ForkCiTask => ({
          id: `types-${name}`,
          kind: "types",
          graphs: [name],
        })),
      );
    } else {
      tasks.push({ id, kind: "types", graphs: names });
    }
  };
  for (const row of native.core_type_matrix.include) {
    addTypes(`types-core-tests-${row.stripe}`, row.type_graph_names_json, false);
  }
  // Start independent production graphs separately; none waits behind the core-test stripes.
  for (const row of native.check_matrix.include) {
    if (row.task === "prod-types" || row.task === "test-types") {
      addTypes(row.check_name, row.type_graph_names_json, true);
      if (z.array(z.string()).parse(JSON.parse(row.core_type_graph_names_json ?? "[]")).length) {
        throw new Error("Hosted core-test graphs must use their canonical stripe owners");
      }
    }
  }
  const addLint = (id: string, encoded: string | undefined) => {
    if (!encoded) {
      throw new Error("Fork lint rows require a materialized selection, including full fallback");
    }
    tasks.push({ id, kind: "lint", selection: lintSelectionSchema.parse(JSON.parse(encoded)) });
  };
  for (const row of native.lint_core_matrix.include) {
    addLint(`lint-${row.stripe}`, row.lint_selection_json);
  }
  if (native.lint_extension_matrix.include.length) {
    throw new Error("GitHub lint rows must retain the combined core/extension ownership");
  }
  if (lint) {
    addLint("lint-central", native.central_lint_selection_json);
  }
  const graphNames = tasks.flatMap((task) => (task.kind === "types" ? task.graphs : []));
  if (new Set(graphNames).size !== graphNames.length) {
    throw new Error("A compiler graph has more than one fork CI execution owner");
  }
  if (new Set(tasks.map(({ id }) => id)).size !== tasks.length) {
    throw new Error("Fork CI task IDs must be unique");
  }
  // Actions limits each job's outputs to 1 MiB, approximately measured in UTF-16.
  const matrix = { include: tasks };
  if (Buffer.byteLength(JSON.stringify(matrix), "utf16le") > 900_000) {
    throw new Error("Fork CI matrix exceeds the Actions output budget; never truncate coverage");
  }
  return matrix;
}

/** Execute only canonical tasks emitted by the plan job, never arbitrary shell arguments. */
export async function runForkCiCheckTask(
  result: ChangedLaneResult,
  range: SourceRange,
  input: unknown,
) {
  const task = taskSchema.parse(input);
  console.log(`[fork-ci] ${task.id} base=${range.base} head=${range.head}`);
  if (task.kind === "phase") {
    return await runChangedCheck(result, { ...range, phase: task.phase, timed: true });
  }
  if (task.kind === "lint") {
    return await runChangedCheck(result, {
      ...range,
      lintOnly: true,
      lintSelection: task.selection,
      lintThreads: 1,
      env: { ...process.env, OPENCLAW_OXLINT_SHARDS_SERIAL: "1" },
      timed: true,
    });
  }
  if (task.kind === "test") {
    return await runManagedCommand({
      bin: process.execPath,
      args: ["scripts/run-vitest.mjs", task.testFile],
      env: {
        ...process.env,
        OPENCLAW_TEST_PROJECTS_PARALLEL: "1",
        OPENCLAW_VITEST_MAX_WORKERS: "1",
      },
    });
  }
  resolveCiTsgoGraphs(task.graphs);
  return await runManagedCommand({
    bin: process.execPath,
    args: [
      "scripts/run-tsgo-core-test-shards.mjs",
      "--ci-graphs-json",
      JSON.stringify(task.graphs),
      "--concurrency",
      "1",
    ],
    env: process.env,
  });
}

function readSourceRange(): { range: SourceRange; result: ChangedLaneResult } {
  const base = process.env.BASE_SHA ?? "";
  const head = process.env.HEAD_SHA ?? "";
  if (
    ![base, head].every((sha) => /^[0-9a-f]{40}$/u.test(sha) && !/^0+$/u.test(sha)) ||
    base === head
  ) {
    throw new Error("Fork CI requires distinct concrete base/head SHAs");
  }
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
  if (git("rev-parse", "HEAD") !== head) {
    throw new Error("Fork CI checkout does not match the planned head");
  }
  git("merge-base", "--is-ancestor", base, head);
  const paths = listChangedPathsFromGit({ base, head, includeWorktree: false });
  return {
    range: { base, head },
    result: detectChangedLanesForPaths({ paths, base, head, includeWorktree: false }),
  };
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  await runWithFailedTrailer("fork-ci-checks", async () => {
    const { range, result } = readSourceRange();
    if (process.argv[2] === "plan") {
      const output = process.env.GITHUB_OUTPUT;
      if (!output) {
        throw new Error("Fork CI planning requires GITHUB_OUTPUT");
      }
      const regressionTests = z
        .array(regressionTestSchema)
        .max(32)
        .parse(JSON.parse(process.env.FORK_CI_REGRESSION_TESTS_JSON || "[]"));
      for (const testFile of regressionTests) {
        execFileSync("git", ["cat-file", "-e", `${range.head}:${testFile}`], { stdio: "pipe" });
      }
      const matrix = await createForkCiCheckPlan(result, range, regressionTests);
      appendFileSync(
        output,
        `matrix=${JSON.stringify(matrix)}\nhas_checks=${matrix.include.length > 0}\n`,
      );
      const summary = process.env.GITHUB_STEP_SUMMARY;
      if (summary) {
        appendFileSync(
          summary,
          `\n### Check plan (${matrix.include.length} rows)\n${matrix.include.map((row) => `- ${row.id}${row.kind === "types" ? `: ${row.graphs.join(", ")}` : row.kind === "test" ? `: ${row.testFile}` : ""}`).join("\n")}\n`,
        );
      }
    } else if (process.argv[2] === "run") {
      process.exitCode = await runForkCiCheckTask(
        result,
        range,
        JSON.parse(process.env.FORK_CI_TASK_JSON ?? "null"),
      );
    } else {
      throw new Error("Usage: fork-ci-checks.mts plan|run (BASE_SHA and HEAD_SHA required)");
    }
  });
}
