import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const wrapper = path.resolve("scripts/run-bounded.sh");

describe.skipIf(process.platform !== "linux")("bounded resource ownership", () => {
  it.each([
    { available: 12.9, requested: undefined, budget: 8, code: 0 },
    { available: 16, requested: undefined, budget: 10, code: 0 },
    { available: 10, requested: undefined, budget: 6, code: 0 },
    { available: 9.9, requested: undefined, budget: 5, code: 0 },
    { available: 5, requested: undefined, budget: 1, code: 0 },
    { available: 4.9, requested: undefined, budget: undefined, code: 75 },
    { available: 12, requested: "10", budget: undefined, code: 75 },
    { available: 14, requested: "10", budget: 10, code: 0 },
    { available: 12, requested: "4", budget: 4, code: 0 },
    { available: 16, requested: "11", budget: 11, code: 0 },
    { available: 5.5, requested: "1.5", budget: 1.5, code: 0 },
    { available: 16, requested: "11.5", budget: 11.5, code: 0 },
    { available: 12.5, requested: "11.5", reserve: "1", budget: 11.5, code: 0 },
    { available: 12.49, requested: "11.5", reserve: "1", budget: undefined, code: 75 },
    ...["0", "0.5", "12", "11.6", "11.50", "1.25", "1e1", "NaN", "Infinity", "-1"].map(
      (requested) => ({ available: 16, requested, budget: undefined, code: 2 }),
    ),
    { available: 12, requested: "10", reserve: "1", budget: 10, code: 0 },
    { available: 10.9, requested: "10", reserve: "1", budget: undefined, code: 75 },
    { available: 16, requested: "10", reserve: "0", budget: undefined, code: 2 },
    { available: 30, requested: undefined, largeMemory: "27", budget: undefined, code: 2 },
    { available: 30, requested: undefined, fitAvailable: true, budget: undefined, code: 2 },
    { available: 16, requested: undefined, budget: 10, code: 1, loadState: "loaded" },
    ...[
      {
        state:
          "LoadState=loaded\nActiveState=failed\nSubState=failed\nControlGroup=\nResult=oom-kill\nMemoryPeak=67108864",
        commandExit: 137,
        code: 137,
        cleanup: true,
      },
      {
        state: "LoadState=loaded\nActiveState=failed\nSubState=failed\nControlGroup=",
        commandExit: 0,
        code: 1,
        cleanup: true,
      },
      {
        state: "LoadState=loaded\nActiveState=inactive\nSubState=dead\nControlGroup=",
        commandExit: 37,
        code: 37,
        cleanup: true,
      },
      {
        state: "LoadState=loaded\nActiveState=active\nSubState=running\nControlGroup=",
        code: 1,
        cleanup: false,
      },
      {
        state:
          "LoadState=loaded\nActiveState=failed\nSubState=failed\nControlGroup=/retained-scope",
        code: 1,
        cleanup: false,
      },
      { state: "LoadState=loaded\nActiveState=failed\nSubState=failed", code: 1, cleanup: false },
      { state: "", code: 1, cleanup: false },
      { state: "LoadState=not-found", observationExit: 1, code: 1, cleanup: false },
      { state: "LoadState=not-found", wrongUnit: true, code: 1, cleanup: false },
    ].map((scope) => Object.assign({ available: 16, requested: undefined, budget: 10 }, scope)),
  ])("admits $requested with $available GiB available", (scenario) => {
    const root = createTempDir("openclaw-bounded-admission-");
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const tools = {
      awk: `#!/bin/sh
if flock -n "$XDG_RUNTIME_DIR/openclaw-bounded-check.lock" true; then
  exit 90
fi
echo "$BOUNDED_TEST_AVAILABLE_KIB"
`,
      systemctl: `#!/bin/sh
if [ "$5" = Id ]; then
  printf 'Id=%s\\n%s\\n' "\${BOUNDED_TEST_UNIT:-$3}" "$BOUNDED_TEST_STATE"
  exit "$BOUNDED_TEST_OBSERVATION_EXIT"
fi
`,
      "systemd-run": `#!${process.execPath}
require("node:fs").writeFileSync(process.env.BOUNDED_TEST_RECEIPT + ".started", "");
console.log(JSON.stringify({
  args: process.argv.slice(2),
  goMemory: process.env.GOMEMLIMIT,
  goProcs: process.env.GOMAXPROCS,
  goGc: process.env.GOGC,
  nodeOptions: process.env.NODE_OPTIONS,
  workers: process.env.OPENCLAW_VITEST_MAX_WORKERS,
}));
process.exit(Number(process.env.BOUNDED_TEST_COMMAND_EXIT));
`,
      free: "#!/bin/sh\nexit 0\n",
      ps: "#!/bin/sh\nexit 0\n",
    };
    for (const [name, source] of Object.entries(tools)) {
      fs.writeFileSync(path.join(bin, name), source, { mode: 0o755 });
    }
    const receipt = path.join(root, "receipt.json");
    const result = spawnSync(
      "bash",
      [
        wrapper,
        "--receipt",
        receipt,
        ...(scenario.requested ? ["--memory-gib", scenario.requested] : []),
        ...("reserve" in scenario && typeof scenario.reserve === "string"
          ? ["--reserve-gib", scenario.reserve]
          : []),
        ...("largeMemory" in scenario && typeof scenario.largeMemory === "string"
          ? ["--large-memory-gib", scenario.largeMemory]
          : []),
        ...("fitAvailable" in scenario && scenario.fitAvailable ? ["--fit-available"] : []),
        "true",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          XDG_RUNTIME_DIR: root,
          BOUNDED_TEST_AVAILABLE_KIB: String(Math.floor(scenario.available * 1048576)),
          BOUNDED_TEST_STATE:
            "state" in scenario
              ? scenario.state
              : `LoadState=${"loadState" in scenario ? scenario.loadState : "not-found"}`,
          BOUNDED_TEST_OBSERVATION_EXIT: String(
            "observationExit" in scenario ? scenario.observationExit : 0,
          ),
          BOUNDED_TEST_COMMAND_EXIT: String("commandExit" in scenario ? scenario.commandExit : 0),
          BOUNDED_TEST_UNIT:
            "wrongUnit" in scenario && scenario.wrongUnit ? "another.scope" : undefined,
          BOUNDED_TEST_RECEIPT: receipt,
          GOGC: undefined,
          NODE_OPTIONS: undefined,
        },
      },
    );

    expect(result.status, result.stderr).toBe(scenario.code);
    if (scenario.budget === undefined) {
      expect(result.stdout).toBe("");
      expect(result.stderr.trimEnd()).toMatch(/\[bounded\] FAILED \(exit (2|75)\)$/);
      return;
    }
    if ("cleanup" in scenario) {
      expect(JSON.parse(fs.readFileSync(receipt, "utf8"))).toMatchObject({
        status: scenario.cleanup ? "failed" : "unknown",
        exitCode: scenario.code,
        commandStarted: true,
        cleanupConfirmed: scenario.cleanup,
      });
    }
    const invocation = JSON.parse(result.stdout);
    const budgetBytes = scenario.budget === 11.5 ? 12348030976 : scenario.budget * 1073741824;
    const softBudgetMiB = scenario.budget === 11.5 ? 5888 : scenario.budget * 512;
    expect(invocation.args).toContain(`--property=MemoryMax=${budgetBytes}`);
    expect(invocation.args).toContain(String(budgetBytes));
    expect(invocation.args).toContain("--property=MemorySwapMax=0");
    expect(invocation).toMatchObject({
      goMemory: `${softBudgetMiB}MiB`,
      goProcs: scenario.budget >= 6 ? "2" : "1",
      goGc: "100",
      nodeOptions: `--max-old-space-size=${softBudgetMiB}`,
      workers: "1",
    });
  });
});
