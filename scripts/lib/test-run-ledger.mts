import { execFileSync } from "node:child_process";
// Records which test files this checkout has actually run green, for the commit hint.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveValidationStateDir } from "./changed-check-plan-estimate.mts";

const LEDGER_FILE = "test-run-ledger.json";
const MAX_ENTRIES = 4000;

type LedgerEntry = { path: string; sha256: string; passedAt: string };

type Ledger = { version: 1; entries: Record<string, LedgerEntry> };

export type UnverifiedTest = { path: string; reason: "never-run" | "changed-since-run" };

function ledgerPath(cwd: string) {
  return path.join(resolveValidationStateDir(cwd), LEDGER_FILE);
}

function readLedger(file: string): Ledger {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Ledger>;
    if (parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") {
      return { version: 1, entries: parsed.entries };
    }
  } catch {
    // A missing or corrupt ledger only removes evidence; it never blocks a commit.
  }
  return { version: 1, entries: {} };
}

function writeLedger(file: string, ledger: Ledger) {
  const entries = Object.entries(ledger.entries)
    .toSorted(([, left], [, right]) => left.passedAt.localeCompare(right.passedAt))
    .slice(-MAX_ENTRIES);
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp.${process.pid}`;
  writeFileSync(
    temporary,
    `${JSON.stringify({ version: 1, entries: Object.fromEntries(entries) }, null, 2)}\n`,
  );
  renameSync(temporary, file);
}

/** Hash a path's staged blob so the ledger tracks content, not timestamps. */
export function hashFileBytes(bytes: Buffer | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Record test files that actually finished green in this run. Only explicit
 * targets qualify: a project-wide run cannot prove which files executed.
 */
export function recordPassingTestFiles(
  files: readonly string[],
  options: { cwd?: string; now?: Date } = {},
) {
  const cwd = options.cwd ?? process.cwd();
  const unique = [...new Set(files)].filter((file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file));
  if (unique.length === 0) {
    return 0;
  }
  const file = ledgerPath(cwd);
  const ledger = readLedger(file);
  const passedAt = (options.now ?? new Date()).toISOString();
  let recorded = 0;
  for (const relativePath of unique) {
    try {
      // Hash the bytes the runner actually read, not the index copy: the index
      // may hold an older or newer version than what executed.
      const bytes = readFileSync(path.resolve(cwd, relativePath));
      ledger.entries[relativePath] = { path: relativePath, sha256: hashFileBytes(bytes), passedAt };
      recorded += 1;
    } catch {
      // A path that cannot be read cannot be claimed as proven; skip it.
    }
  }
  if (recorded > 0) {
    writeLedger(file, ledger);
  }
  return recorded;
}

/** List staged test files whose current bytes have no green local run. */
export function listUnverifiedStagedTests(options: { cwd?: string } = {}): UnverifiedTest[] {
  const cwd = options.cwd ?? process.cwd();
  let staged: string[];
  try {
    staged = execFileSync(
      "git",
      ["diff", "--cached", "--name-only", "--no-renames", "--diff-filter=AM", "-z"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    )
      .split("\0")
      .filter(Boolean);
  } catch {
    return [];
  }
  const tests = staged.filter((file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file));
  if (tests.length === 0) {
    return [];
  }
  const { entries } = readLedger(ledgerPath(cwd));
  const unverified: UnverifiedTest[] = [];
  for (const relativePath of tests) {
    let bytes: Buffer;
    try {
      bytes = execFileSync("git", ["show", `:${relativePath}`], {
        cwd,
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch {
      continue;
    }
    const entry = entries[relativePath];
    if (!entry) {
      unverified.push({ path: relativePath, reason: "never-run" });
    } else if (entry.sha256 !== hashFileBytes(bytes)) {
      unverified.push({ path: relativePath, reason: "changed-since-run" });
    }
  }
  return unverified;
}
