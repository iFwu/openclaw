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

The workflow runs `build` and three independent `checks` matrix jobs on separate
runners at the same immutable SHA. It reuses `setup-node-env` for the toolchain.
The check jobs also enable that action's semantic-check containment required by
the native compiler wrappers. No job uses the operator's shared-host wrapper or
headroom reservation, and none changes the runner's swap configuration.
Job timeouts remain enforced; OOM or timeout is a failed run. Local and shared-host
checks still use the existing `run-bounded.sh` policy unchanged.

`checks` uses `scripts/check-changed.mjs --base BASE_SHA --head HEAD_SHA --phase PHASE --timed`:

- `guards-types`: guards and the existing serial type graphs.
- `lint`: formatting and the same targeted or fallback lint commands selected by the planner.
- `audits`: the same broad audits, including hard-zero unused-export checks.

The three phases partition the original plan without dropping or duplicating
commands. The default `--phase all` preserves the serial local entrypoint. Core
type boundary discovery stays with its consuming typecheck, and each phase
preserves command order. Use separate checkouts/runners for overlap, not concurrent
writers in one validation checkout. Matrix fail-fast is disabled so one failed
audit cannot cancel the other independent evidence. Phase selection does not
narrow type graphs, suppress findings, or maintain another path classifier.

Pushes use the event's `before` commit; manual dispatch requires an exact `base_sha`. The base must be a distinct ancestor of the checked-out head. Missing,
zero, or unrelated bases fail instead of producing an empty or guessed check.
Filtered history retains ancestry without downloading every historical blob.
Use the same base/head locally; inspect the job summary to confirm the range.
These static-check jobs do not replace task-specific regression tests or native
platform validation.

After review, required prepublication checks, and privacy scanning, freeze and
publish the candidate. Start the remaining local regressions while the CI jobs
run; do not wait for the cloud build before launching independent local work.
Keep the validation checkout unchanged until its commands finish. Reuse completed
evidence only when its source, configuration, toolchain, and dependency inputs
remain valid. A new commit invalidates affected evidence, not unrelated checks.

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

A normal successful run requires `build` and all three `checks` phases to pass;
`verify-download` is intentionally skipped, not a verification pass. If explicitly
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
