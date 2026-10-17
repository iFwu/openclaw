#!/usr/bin/env node
// Advisory commit hint: staged tests with no green local run are not proven by
// review alone. This never blocks; it prints what is missing evidence.
import { listUnverifiedStagedTests } from "../lib/test-run-ledger.mts";

try {
  const unverified = listUnverifiedStagedTests();
  if (unverified.length > 0) {
    const never = unverified.filter((entry) => entry.reason === "never-run");
    const changed = unverified.filter((entry) => entry.reason === "changed-since-run");
    console.error("[pre-commit] staged tests without a local green run:");
    for (const entry of never) {
      console.error(`  - ${entry.path}  (never ran locally)`);
    }
    for (const entry of changed) {
      console.error(`  - ${entry.path}  (changed since its last local run)`);
    }
    console.error(
      "[pre-commit] run them with scripts/run-bounded.sh before pushing; failure to do so is a hint, not a block.",
    );
  }
} catch {
  // A hint must never turn a normal commit into a failure.
}
