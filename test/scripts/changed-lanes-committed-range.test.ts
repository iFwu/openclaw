import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";

const temps = useAutoCleanupTempDirTracker(afterAll);
const moduleUrl = pathToFileURL(path.resolve("scripts/changed-lanes.mts")).href;
const loader = path.resolve("scripts/tsx.mjs");
let cwd: string;
let base: string;
let head: string;
const manifest = (script: string) => ({
  name: "fixture",
  version: "1.0.0",
  scripts: { "test:docker:live-fixture": script },
});
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd, env: createNestedGitEnv(), encoding: "utf8" }).trim();
const writePackage = (value: unknown) =>
  writeFileSync(path.join(cwd, "package.json"), JSON.stringify(value));
beforeAll(() => {
  cwd = temps.make("committed-check-range-");
  git("init", "--initial-branch=fixture");
  const commit = (value: unknown) => {
    writePackage(value);
    git("add", "package.json");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "fixture",
    );
    return git("rev-parse", "HEAD");
  };
  base = commit(manifest("old"));
  head = commit(manifest("new"));
  // This metadata change is outside the committed range and must not select another lane.
  writePackage({ ...manifest("new"), name: "dirty-worktree-metadata" });
});

it("classifies exact package bytes independently of WIP while preserving the local default", () => {
  const output = execFileSync(
    resolveTestNodeExecPath(),
    [
      "--import",
      loader,
      "--input-type=module",
      "-e",
      `
    import { detectChangedLanesForPaths, listChangedPathsFromGit } from ${JSON.stringify(moduleUrl)};
    const range = ${JSON.stringify({})};
    range.base = process.env.FIXTURE_BASE;
    range.head = process.env.FIXTURE_HEAD;
    const paths = listChangedPathsFromGit({ ...range, includeWorktree: false });
    const committed = detectChangedLanesForPaths({ ...range, paths, includeWorktree: false });
    const local = detectChangedLanesForPaths({ ...range, paths });
    console.log(JSON.stringify({ paths, committed: committed.lanes, local: local.lanes }));
  `,
    ],
    {
      cwd,
      encoding: "utf8",
      env: { ...createNestedGitEnv(), FIXTURE_BASE: base, FIXTURE_HEAD: head },
    },
  );
  const result = JSON.parse(output);
  expect(result.paths).toEqual(["package.json"]);
  expect(result.committed.liveDockerTooling).toBe(true);
  expect(result.local.liveDockerTooling).toBe(false);
  expect(git("rev-parse", "HEAD")).toBe(head);
});
