import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { detectChangedLanes } from "../../scripts/changed-lanes.mts";
import { createForkCiCheckPlan, runForkCiCheckTask } from "../../scripts/fork-ci-checks.mts";
import { TSGO_CI_GRAPHS } from "../../scripts/lib/tsgo-core-test-shards.mts";

const mocks = vi.hoisted(() => ({
  types: vi.fn(),
  run: vi.fn(),
  command: vi.fn(),
}));
vi.mock("../../scripts/run-tsgo-core-test-shards.mts", () => ({
  createChangedCiTypeCheckPlan: mocks.types,
}));
vi.mock("../../scripts/lib/managed-child-process.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/managed-child-process.mts")>()),
  runManagedCommand: mocks.command,
}));
vi.mock("../../scripts/check-changed.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/check-changed.mts")>()),
  runChangedCheck: mocks.run,
}));

const range = { base: "1".repeat(40), head: "2".repeat(40) };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.types.mockResolvedValue({ mode: "changed", graphs: TSGO_CI_GRAPHS });
  mocks.run.mockResolvedValue(0);
  mocks.command.mockResolvedValue(0);
});

describe("fork canonical check dispatch", () => {
  it("keeps five core stripes and amortizes shorter graphs in canonical family rows", async () => {
    const plan = await createForkCiCheckPlan(detectChangedLanes(["pnpm-lock.yaml"]), range);
    const types = plan.include.filter((row) => row.kind === "types");
    const selected = types.flatMap((row) => row.graphs);
    expect(selected.toSorted()).toEqual(TSGO_CI_GRAPHS.map(({ name }) => name).toSorted());
    expect(new Set(selected).size).toBe(selected.length);
    expect(types.filter(({ id }) => id.startsWith("types-core-tests-"))).toHaveLength(5);
    expect(types.filter(({ id }) => !id.startsWith("types-core-tests-"))).toEqual([
      { id: "prod-types", kind: "types", graphs: ["core", "ui", "extensions"] },
      { id: "test-types", kind: "types", graphs: ["extensions-test", "scripts", "test-root"] },
    ]);
    const lint = plan.include.filter((row) => row.kind === "lint");
    expect(lint).toHaveLength(6);
    expect(lint.flatMap((row) => row.selection.coreStripes).toSorted((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(lint.flatMap((row) => row.selection.extensionStripes).toSorted((a, b) => a - b)).toEqual(
      [1, 2, 3, 4, 5, 6],
    );
    expect(lint.filter((row) => row.selection.central)).toHaveLength(1);
    expect(plan.include.filter((row) => row.kind === "phase").map((row) => row.phase)).toEqual([
      "guards",
      "audits",
    ]);
  });

  it("removes empty type stripes using canonical compiler membership", async () => {
    const graph = TSGO_CI_GRAPHS.find(({ name }) => name === "core-test-agents-root")!;
    mocks.types.mockResolvedValue({ mode: "changed", graphs: [graph] });
    const plan = await createForkCiCheckPlan(
      detectChangedLanes(["src/agents/model-fallback.test.ts"]),
      range,
    );
    const types = plan.include.filter((row) => row.kind === "types");
    expect(types).toHaveLength(1);
    const shard = expectDefined(types[0], "selected core-test shard");
    expect(shard.graphs).toEqual([graph.name]);
    expect(shard.id).toBe("types-core-tests-1");
  });

  it("bundles only selected shorter graphs without introducing their unselected siblings", async () => {
    mocks.types.mockResolvedValue({
      mode: "changed",
      graphs: TSGO_CI_GRAPHS.filter(({ name }) => name === "scripts"),
    });
    const plan = await createForkCiCheckPlan(
      detectChangedLanes(["scripts/ci-check-plan.mts"]),
      range,
    );
    expect(plan.include.filter((row) => row.kind === "types")).toEqual([
      { id: "test-types", kind: "types", graphs: ["scripts"] },
    ]);
  });

  it("keeps docs-only and truly empty ranges free of compiler and full lint rows", async () => {
    const docs = await createForkCiCheckPlan(detectChangedLanes(["README.md"]), range);
    expect(docs.include.some((row) => row.kind === "types")).toBe(false);
    expect(
      docs.include.filter((row) => row.kind === "lint").every((row) => row.selection.central),
    ).toBe(true);
    expect(mocks.types).not.toHaveBeenCalled();
    expect(await createForkCiCheckPlan(detectChangedLanes([]), range)).toEqual({ include: [] });
  });

  it("preserves committed package-script classification through canonical lint planning", async () => {
    const result = detectChangedLanes(["package.json"], { packageJsonChangeKind: "tooling" });
    const plan = await createForkCiCheckPlan(result, range);
    const lint = plan.include.filter((row) => row.kind === "lint");
    expect(lint).toHaveLength(1);
    const selection = expectDefined(lint[0], "scripts-only lint row").selection;
    expect(selection).toMatchObject({
      fullScope: true,
      groups: ["scripts"],
      central: true,
    });
    expect(selection.coreStripes).toEqual([]);
    expect(selection.extensionStripes).toEqual([]);
  });

  it("shares setup across explicit regressions without duplicates or invented static work", async () => {
    const testFile = "test/scripts/fork-ci-checks.test.ts";
    const plan = await createForkCiCheckPlan(detectChangedLanes([]), range, [
      testFile,
      testFile,
      "test/scripts/fork-ci-artifacts.test.ts",
    ]);
    expect(plan.include).toEqual([
      {
        id: "regressions",
        kind: "test",
        testFiles: [testFile, "test/scripts/fork-ci-artifacts.test.ts"],
      },
    ]);
    expect(mocks.types).not.toHaveBeenCalled();
    mocks.command.mockResolvedValue(7);
    expect(await runForkCiCheckTask(detectChangedLanes([]), range, plan.include[0])).toBe(7);
    expect(mocks.command).toHaveBeenCalledWith({
      bin: process.execPath,
      args: ["scripts/run-vitest.mjs", testFile, "test/scripts/fork-ci-artifacts.test.ts"],
      env: {
        ...process.env,
        OPENCLAW_TEST_PROJECTS_PARALLEL: "1",
        OPENCLAW_VITEST_MAX_WORKERS: "1",
      },
    });
  });

  it.each(["--watch", "test/../outside.test.ts", "src/production.ts"])(
    "rejects invalid explicit regression target %s",
    async (testFile) => {
      await expect(
        createForkCiCheckPlan(detectChangedLanes([]), range, [testFile]),
      ).rejects.toThrow();
      await expect(
        runForkCiCheckTask(detectChangedLanes([]), range, {
          id: "regressions",
          kind: "test",
          testFiles: [testFile],
        }),
      ).rejects.toThrow();
      expect(mocks.command).not.toHaveBeenCalled();
    },
  );

  it("does not turn failed boundary/type discovery into an empty successful plan", async () => {
    mocks.types.mockRejectedValue(new Error("compiler boundary violated"));
    await expect(
      createForkCiCheckPlan(detectChangedLanes(["src/agents/model-fallback.test.ts"]), range),
    ).rejects.toThrow("compiler boundary violated");
  });

  it("rejects a duplicate canonical compiler assignment", async () => {
    const graph = TSGO_CI_GRAPHS.find(({ name }) => name === "core")!;
    mocks.types.mockResolvedValue({ mode: "changed", graphs: [graph, graph] });
    await expect(
      createForkCiCheckPlan(detectChangedLanes(["pnpm-lock.yaml"]), range),
    ).rejects.toThrow("unique");
  });

  it("runs serial canonical graphs through their existing process owner and preserves failure", async () => {
    mocks.command.mockResolvedValue(2);
    const result = await runForkCiCheckTask(detectChangedLanes(["tsconfig.json"]), range, {
      id: "test-types",
      kind: "types",
      graphs: ["extensions-test", "scripts", "test-root"],
    });
    expect(result).toBe(2);
    expect(mocks.command).toHaveBeenCalledWith(
      expect.objectContaining({
        bin: process.execPath,
        args: [
          "scripts/run-tsgo-core-test-shards.mjs",
          "--ci-graphs-json",
          '["extensions-test","scripts","test-root"]',
          "--concurrency",
          "1",
        ],
      }),
    );
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("passes the exact lint selection and range without discovering a second plan", async () => {
    const selection = {
      files: [],
      fullScope: true,
      coreStripes: [1],
      extensionStripes: [1],
      groups: [],
      central: false,
    };
    const result = detectChangedLanes(["pnpm-lock.yaml"]);
    mocks.run.mockResolvedValue(3);
    expect(await runForkCiCheckTask(result, range, { id: "lint-1", kind: "lint", selection })).toBe(
      3,
    );
    expect(mocks.run).toHaveBeenCalledWith(result, {
      ...range,
      lintOnly: true,
      lintSelection: selection,
      lintThreads: 1,
      env: { ...process.env, OPENCLAW_OXLINT_SHARDS_SERIAL: "1" },
      timed: true,
    });
    expect(mocks.types).not.toHaveBeenCalled();
    expect(mocks.command).not.toHaveBeenCalled();
  });

  it.each(["guards", "audits"] as const)("retains the original %s check owner", async (phase) => {
    const result = detectChangedLanes(["scripts/fork-ci-checks.mts"]);
    await runForkCiCheckTask(result, range, { id: phase, kind: "phase", phase });
    expect(mocks.run).toHaveBeenCalledWith(result, { ...range, phase, timed: true });
  });

  it.each([
    { id: "types", kind: "types", graphs: ["unknown"] },
    { id: "types", kind: "types", graphs: ["core", "core"] },
    { id: "types", kind: "types", graphs: [] },
    { id: "regressions", kind: "test", testFiles: [] },
    { id: "shell", kind: "shell", command: "true" },
    { id: "phase", kind: "phase", phase: "guards-types" },
  ])("rejects invalid or broad injected task $id/$kind before execution", async (task) => {
    await expect(
      runForkCiCheckTask(detectChangedLanes(["README.md"]), range, task),
    ).rejects.toThrow();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.command).not.toHaveBeenCalled();
  });
});
