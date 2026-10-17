import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listUnverifiedStagedTests,
  recordPassingTestFiles,
} from "../../scripts/lib/test-run-ledger.mts";

const temporaryDirs: string[] = [];

function createRepository() {
  const root = mkdtempSync(path.join(tmpdir(), "test-ledger-"));
  temporaryDirs.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
      },
    });
  git("init", "--quiet", "--initial-branch=main");
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "a.test.ts"), "export {};\n");
  git("add", "--", "src/a.test.ts");
  git("commit", "--quiet", "-m", "init");
  return { root, git };
}

function stage(root: string, relativePath: string, contents: string) {
  const file = path.join(root, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
  execFileSync("git", ["add", "--", relativePath], {
    cwd: root,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

afterEach(() => {
  while (temporaryDirs.length) {
    rmSync(temporaryDirs.pop()!, { recursive: true, force: true });
  }
});

describe("test run ledger", () => {
  it("treats a never-run staged test as unverified", () => {
    const { root } = createRepository();
    stage(root, "src/a.test.ts", "export const staged = true;\n");
    const unverified = listUnverifiedStagedTests({ cwd: root });
    expect(unverified).toEqual([{ path: "src/a.test.ts", reason: "never-run" }]);
  });

  it("only inspects staged content, not the committed baseline", () => {
    const { root } = createRepository();
    // Nothing is staged after the initial commit, so there is nothing to warn about.
    expect(listUnverifiedStagedTests({ cwd: root })).toEqual([]);
  });

  it("accepts a staged test whose exact bytes passed locally", () => {
    const { root } = createRepository();
    expect(recordPassingTestFiles(["src/a.test.ts"], { cwd: root })).toBe(1);
    expect(listUnverifiedStagedTests({ cwd: root })).toEqual([]);
  });

  it("reports a test that changed after its green run", () => {
    const { root } = createRepository();
    recordPassingTestFiles(["src/a.test.ts"], { cwd: root });
    stage(root, "src/a.test.ts", "export const changed = true;\n");
    expect(listUnverifiedStagedTests({ cwd: root })).toEqual([
      { path: "src/a.test.ts", reason: "changed-since-run" },
    ]);
  });

  it("hashes the bytes that ran, not an older staged copy", () => {
    const { root } = createRepository();
    // Stage one version, then edit the working tree and rerun only the new bytes.
    stage(root, "src/a.test.ts", "export const stagedVersion = 1;\n");
    writeFileSync(path.join(root, "src/a.test.ts"), "export const workingVersion = 2;\n");
    expect(recordPassingTestFiles(["src/a.test.ts"], { cwd: root })).toBe(1);
    // The staged copy still differs from what passed, so the commit needs a rerun.
    expect(listUnverifiedStagedTests({ cwd: root })).toEqual([
      { path: "src/a.test.ts", reason: "changed-since-run" },
    ]);
  });

  it("ignores non-test files and untracked targets", () => {
    const { root } = createRepository();
    stage(root, "src/plain.ts", "export {};\n");
    expect(recordPassingTestFiles(["src/untracked.test.ts"], { cwd: root })).toBe(0);
    expect(listUnverifiedStagedTests({ cwd: root })).toEqual([]);
  });

  it("keeps the ledger outside the working tree", () => {
    const { root } = createRepository();
    recordPassingTestFiles(["src/a.test.ts"], { cwd: root });
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(status.trim()).toBe("");
  });
});
