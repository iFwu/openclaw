import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { resolveWorkflowBash } from "../helpers/workflow-bash.js";

type Step = {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  "continue-on-error"?: boolean;
};
type Job = {
  needs?: string | string[];
  steps: Step[];
  "continue-on-error"?: boolean;
};
const workflow = parse(readFileSync(".github/workflows/fork-ci-artifacts.yml", "utf8")) as {
  jobs: { checks: Job; build: Job; "verify-download": Job };
};
const checks = workflow.jobs.checks;

it("runs static checks independently of build and retains artifact-dependent verification", () => {
  for (const job of [checks, workflow.jobs.build]) {
    expect(job.needs ?? []).toHaveLength(0);
    expect(job["continue-on-error"]).not.toBe(true);
    const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.ref).toBe("${{ github.sha }}");
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  }
  expect(workflow.jobs["verify-download"].needs).toBe("build");
  const setup = checks.steps.find((step) => step.uses === "./.github/actions/setup-node-env");
  expect(setup?.with?.["semantic-checks"]).toBe("true");
  const check = checks.steps.find((step) => step.name === "Run changed checks");
  expect(check?.["continue-on-error"]).not.toBe(true);
  expect(check?.run).toBe(
    'node scripts/check-changed.mjs --base "$BASE_SHA" --head "$HEAD_SHA" --timed',
  );
});

describe("fork CI changed-check admission", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterAll);
  const bash = resolveWorkflowBash();
  let cwd: string;
  let base: string;
  let head: string;
  let other: string;
  let attempt = 0;

  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      },
    }).trim();
  const commit = (name: string) => {
    writeFileSync(path.join(cwd, "input.txt"), name);
    git("add", "input.txt");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", name);
    return git("rev-parse", "HEAD");
  };
  beforeAll(() => {
    cwd = tempDirs.make("fork-ci-range-");
    git("init", "--initial-branch=fixture");
    base = commit("base");
    commit("intermediate");
    head = commit("head");
    git("checkout", "--orphan", "other");
    other = commit("unrelated");
    git("checkout", "--detach", head);
  });

  function admit(baseSha: string, headSha = head) {
    const step = checks.steps.find((entry) => entry.id === "scope");
    if (!step?.run) {
      throw new Error("Missing changed-check admission step");
    }
    const output = path.join(cwd, `output-${attempt++}`);
    const result = spawnSync(bash, ["--noprofile", "--norc", "-c", step.run], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        BASE_SHA: baseSha,
        HEAD_SHA: headSha,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: `${output}-summary`,
      },
    });
    return { result, output: existsSync(output) ? readFileSync(output, "utf8") : "" };
  }

  it("records the complete multi-commit range at the checked-out head", () => {
    const admitted = admit(base);
    expect(admitted.result.status, admitted.result.stderr).toBe(0);
    expect(admitted.output).toBe(`base=${base}\nhead=${head}\n`);
  });

  it.each(["", "0".repeat(40), "main", "f".repeat(40)])(
    "rejects missing, symbolic, zero or unavailable base %s without publishing scope",
    (invalid) => {
      const rejected = admit(invalid);
      expect(rejected.result.status).not.toBe(0);
      expect(rejected.output).toBe("");
    },
  );

  it("rejects unrelated or empty comparisons and a mismatched checkout", () => {
    const comparisons: [string, string][] = [
      [other, head],
      [head, head],
      [base, other],
    ];
    for (const [baseSha, headSha] of comparisons) {
      const rejected = admit(baseSha, headSha);
      expect(rejected.result.status).not.toBe(0);
      expect(rejected.output).toBe("");
    }
  });
});
