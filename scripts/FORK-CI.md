# Public fork CI artifacts

The fork has one maintained source branch, `ifwu-fork`. Private operator setup,
real machine endpoints, and verification records belong outside this repository.
The one-time private history backup is recovery material, not a second development
branch. Keep upstream attribution and the MIT license.

## Publishing source

Before the first public push, sanitize the commits that introduced operator data,
not just the current tree. Publish only the reviewed branch; private historical tags,
backup refs, and source bundles stay private. Rewriting a commit also changes every
descendant SHA. Verify the rewritten tip against the original candidate, allowing
only the reviewed documentation and CI changes.

For later commits, configure the existing pre-commit guard with a private newline-
delimited literal file:

```bash
git config --local hooks.blockedLiteralsFile /path/to/private-blocked-literals.txt
git config --local openclaw.operatorDocs /path/to/private-operator-instructions.md
```

The literal file contains identifying hostnames, paths, and IDs; keep credentials
in their protected store, not in that file. The existing hook checks staged content
before and after formatting without printing matched values. Before publishing,
inspect the outgoing commit range and run a credential scanner without online
credential verification. A staged-content check is not a historical scan, and
scanners cannot guarantee that every private fact is recognized.

Read private operator instructions before remote validation when the Git setting
is present. A new checkout must configure these local settings independently;
they are intentionally not part of the public Git tree.

## Build and retrieve

`.github/workflows/fork-ci-artifacts.yml` runs on pushes to `ifwu-fork` in this
GitHub fork and can also be manually dispatched. It uses standard `ubuntu-24.04`
GitHub-hosted runners, not a third-party or larger runner, with no production
secrets or live model tests. Node is pinned to 26.8.1; `package.json` owns pnpm.

The workflow starts `build` and `check-plan` independently at the same immutable
SHA. It reuses `setup-node-env` for the toolchain and enables semantic-check
containment for the planner and check runners. No job uses the operator's
shared-host wrapper or headroom reservation, and none changes the runner's swap
configuration. Job timeouts remain enforced; OOM or timeout is a failed run.
Local and shared-host checks retain the existing `run-bounded.sh` policy.

`scripts/fork-ci-checks.mts plan` admits check families from the original
`check-changed` plan, then materializes the existing `createCiCheckPlan` selectors:

- Compiler membership and boundary validation belong to the canonical planner.
  Selected core-test graphs retain their five stripe owners. Shorter graphs share
  the canonical `prod-types` and `test-types` rows to amortize runner setup; only
  selected graphs enter each row. Within `test-types`, the existing runner still
  serially executes all four memory-bounded `test-root` partitions.
- Lint uses the existing consumer closure and GitHub stripe layout: up to five
  combined core/extension rows, plus a central row for the sixth extension stripe,
  scripts, formatting, changed root tests, and other selected lint checks. A broad
  fallback is explicitly materialized on the same owners, not run again centrally.
- Guards and broad audits retain their original commands, including hard-zero
  unused-export checks. The planner owns the compiler boundary; guards do not run
  it a second time.

Only nonempty selected rows enter the `checks` matrix. A narrow change does not
start every possible stripe; shared/ambient/configuration changes retain the
native broader fallback. One matrix limits total check concurrency to eight,
subject to account capacity; build remains independent. Each runner executes one
type graph or lint Program at a time. Fail-fast is disabled, and `check-gate`
requires the plan and every admitted row to succeed, refusing failed/cancelled
plans and unexpectedly skipped checks. No failed result is converted to success.

The local `--phase all` default and `guards-types` entrypoint remain unchanged.
The additional `guards` and `types` partitions split that phase without dropping
commands; `types` keeps its boundary/typecheck pair when run directly. Use separate
checkouts/runners for overlap, not concurrent writers in one validation checkout.
No second path classifier or custom compiler graph is introduced.

Pushes use the event's `before` commit; manual dispatch requires an exact `base_sha`. The base must be a distinct ancestor of the checked-out head. Missing,
zero, or unrelated bases fail instead of producing an empty or guessed check.
Filtered history retains ancestry without downloading every historical blob.
Use the same base/head locally; inspect the job summary to confirm the range.
These static-check jobs do not replace task-specific regression tests or native
platform validation.

SDK total-export and callable-export counts are informational in this fork, not
growth caps. The surface report still checks entrypoint inventory, private/forbidden
subpath exposure, deprecated facades, and the separate entrypoint, deprecation, and
wildcard rules. Typechecking, unused-export scans, and behavioral tests remain
required by their existing scope rules.

Use small, fast targeted tests locally for immediate feedback while editing.
After review, lightweight formatting/workflow checks, and privacy scanning,
freeze and publish the candidate for cloud acceptance. Do not require the same
expensive type/lint checks to finish locally before starting them on GitHub.
Publishing a candidate is not accepting or deploying it: all required checks must
still pass at the final join.

Manual dispatch accepts `regression_tests`, a JSON array of up to 32 explicitly
selected, tracked repository test files. Unique files share one `regressions` row
of the same eight-runner matrix and run through the native `run-vitest.mjs`
entrypoint with one worker/project at a time, avoiding per-file runner setup.
Failures block `check-gate` just like static-check failures. The default empty
array adds no tests. Test targets are data, never shell commands, and must exist at the exact
head. Use this to move task-specific regression acceptance off a contended local
host without broadening to the complete functional suite. For example:

```bash
gh workflow run fork-ci-artifacts.yml --ref ifwu-fork \
  -f base_sha=<exact-reviewed-base> \
  -f regression_tests='["test/scripts/fork-ci-checks.test.ts","test/scripts/fork-ci-artifacts.test.ts"]'
```

Independent candidate branches can be dispatched at their own refs; workflow
concurrency is per ref, not a global repository queue. GitHub account runner
capacity still limits actual overlap. Platform-specific or genuinely local
boundary proofs remain on their required hosts and can overlap the cloud jobs.
Keep any active validation checkout unchanged until its commands finish. Reuse
completed evidence only when its source, configuration, toolchain, and dependency
inputs remain valid. A new commit invalidates affected evidence, not unrelated
checks.

`pnpm build` produces the default `ciArtifacts` profile. The producer verifies
package import closure and the built CLI, then uploads:

- `ci-artifacts.tar.gz`: generated dist, runtime overlay, workspace package dist,
  and declared generated plugin assets; no Git history, dependencies, or state.
- `manifest.json`: source commit/tree, runtime identity, build metadata, output
  roots, and the archive SHA-256.
- Build timing and process resource measurements from `/usr/bin/time -v`.
  Maximum RSS is a process measurement, not whole-command cgroup memory peak.

Normal pushes run `build` and `checks` concurrently, subject to runner availability.
The independent `verify-download` job is manual opt-in: dispatch the workflow with
`verify_download=true` (the default is false). It uses a fresh runner to download
the artifact, verify source/runtime identity and checksum, restore outputs, check
SDK runtime/type exports and UI, then verify import closure and the built CLI
without rebuilding. Use it when changing build, packaging, or restore behavior.

A normal successful run requires `build`, `check-plan`, every selected `checks`
row, and `check-gate` to pass; `verify-download` is intentionally skipped, not a
verification pass. If explicitly
enabled, it must also pass. An uploaded build artifact is not a successful
candidate while `checks` or required local validation is pending or failed.
Destination-side identity, checksum, dependency, and artifact checks remain
required before deployment regardless of this option. Logs and artifacts are
public; retain only necessary non-private material. Artifacts expire after seven
days.

Once `build` succeeds and its artifact upload is complete, retrieve that exact
run's artifact with the native GitHub CLI even if `checks` is still running.
Identity/checksum validation and extraction into a separate staging directory
can overlap static checks, local regressions, and read-only dependency/recovery
preflight. Do not extract into an active validation checkout or the live install.
This is prefetching, not candidate acceptance: all required CI/local checks must
pass before deployment, and mutable destination facts must be rechecked then.
Keep installation and artifact-dependent closure/CLI checks after their inputs
are ready, under the destination's existing resource and ownership rules.

```bash
gh run list --repo iFwu/openclaw --workflow fork-ci-artifacts.yml --branch ifwu-fork
# Optional clean-runner verification; this also runs build and changed checks.
gh workflow run fork-ci-artifacts.yml --repo iFwu/openclaw --ref ifwu-fork -f base_sha=BASE_SHA -f verify_download=true
gh run download RUN_ID --repo iFwu/openclaw --name fork-ci-artifacts-COMMIT_SHA --dir /path/to/output
```

This is an exact-source build transfer, not an npm package or automatic deployment.
Activation, dependency preparation on a destination, and rollback remain with the
existing deployment owner and require their own authorization.
