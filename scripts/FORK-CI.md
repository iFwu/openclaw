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

The workflow reuses `setup-node-env` for the toolchain, without shared-host
cgroup provisioning. Installation, build, and verification run directly on the
exclusive disposable runner: no artificial 10 GiB task cap, no shared-host
headroom reservation, and no changes to the runner's swap configuration.
Job timeouts remain enforced; system OOM or timeout is a failed run. Local and
shared-host checks still use the existing `run-bounded.sh` policy unchanged.

`pnpm build` produces the default `ciArtifacts` profile. The producer verifies
package import closure and the built CLI, then uploads:

- `ci-artifacts.tar.gz`: generated dist, runtime overlay, workspace package dist,
  and declared generated plugin assets; no Git history, dependencies, or state.
- `manifest.json`: source commit/tree, runtime identity, build metadata, output
  roots, and the archive SHA-256.
- Build timing and process resource measurements from `/usr/bin/time -v`.
  Maximum RSS is a process measurement, not whole-command cgroup memory peak.

A separate fresh runner downloads that artifact, verifies its source/runtime and
checksum, restores outputs, checks SDK runtime/type exports and UI, then performs
import-closure and built-CLI verification without rebuilding. Success means both
jobs passed. Logs and artifacts are public; retain only necessary non-private
material. Artifacts expire after seven days.

Retrieve a completed run with the native GitHub CLI:

```bash
gh run list --repo iFwu/openclaw --workflow fork-ci-artifacts.yml --branch ifwu-fork
gh run download RUN_ID --repo iFwu/openclaw --name fork-ci-artifacts-COMMIT_SHA --dir /path/to/output
```

This is an exact-source build transfer, not an npm package or automatic deployment.
Activation, dependency preparation on a destination, and rollback remain with the
existing deployment owner and require their own authorization.
