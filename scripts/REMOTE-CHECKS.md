# Run trusted checks across remote hosts

For routine checks on an operator-owned persistent Linux checkout, start with
[trusted SSH checks](TRUSTED-SSH-CHECKS.md). Use this manifest workflow when frozen
uncommitted source, multiple lanes, or structured batch evidence is required.

Use `remote-checks.mjs` to freeze an existing source worktree and run a manifest of
checks on configured SSH hosts. Each batch owns its remote lanes, source snapshots,
logs, and results. Two focused checks can overlap on one configured host; separate
hosts can run their own checks concurrently.

## Prepare the hosts and inputs

The controller needs the repository's supported Node version and ready tooling
checkout dependencies. The bundled Crabbox plugin owns binary selection for source
capture and execution. It accepts a supported binary on `PATH` and uses its managed
installation when that binary is missing or outdated. Run the entrypoint
from the tooling checkout, or use its absolute path. The manifest's `source`
selects the candidate independently of the tooling checkout and current directory.

### Tooling checkout and package-boundary prerequisites

Use a maintained, independently owned 9.7 candidate/tooling checkout. Do not
install dependencies, create SDK links, or repair exports in a live Gateway tree
or an unrelated worktree merely to start this command. An unrelated or retired controller checkout is not a prerequisite or fallback.

The JavaScript entrypoint uses the repository's `tsx-cli-shim.mjs` /
`scripts/tsx.mjs` preload and needs the selected checkout's installed workspace
dependencies, including `tsx`, Zod, and the normalization-core workspace package.
The 9.7 `extensions/crabbox/cli-runtime-api.ts` defers loading the managed binary
implementation until execution. A successful `--help`, `plan`, or `run --dry-run`
therefore does **not** certify runtime SDK resolution or remote execution.

Real `run` loads `crabbox-managed-binary.ts`, whose runtime imports include the
public `openclaw/plugin-sdk/process-runtime` and `state-paths` subpaths. Managed
acquisition also uses the public extension-shared, SSRF, error, file-lock,
file-access and archive subpaths. These must resolve through the maintained
source-tooling preload/path configuration or a complete host package and its
public runtime exports. If Node reports `ERR_MODULE_NOT_FOUND` for `openclaw`,
repair the selected isolated toolroot's package boundary through its normal
setup/build owners; do not replace SDK imports with relative core imports or
add an ad-hoc resolver/self-link in this scheduler.

Type-boundary preparation is separate: the maintained owner is
`node --import ./scripts/tsx.mjs scripts/prepare-extension-package-boundary-artifacts.mts --mode=package-boundary`,
which produces `packages/plugin-sdk/dist` declarations under artifact ownership.
`test:extensions:package-boundary` consumes that boundary. Declaration preparation
alone neither installs a runtime host package nor produces the root
`dist/plugin-sdk/*.js` runtime exports. Where runtime exports are needed, the
maintained owner is the candidate's normal `build` / `scripts/build-all.mts`
pipeline, not `build:plugin-sdk:dts` alone. Serialize preparation/build through
that checkout's existing artifact owner and bounded policy.

This migration has only statically validated the scheduler and checked the
candidate's `--help`; the main owner must establish the isolated toolroot's
runtime/package boundary before unified WSL fixture and remote validation.

Targets must already provide SSH access, Node/Corepack, Git, GNU `timeout`, and a
systemd user manager with cgroup v2. Their active `openclaw-tests.slice` must enforce
16 GiB memory, no swap, and CPUQuota=1200%. The wrapper verifies those values before
each command. It does not provision hosts or change their limits.

Start with [remote-targets.example.json](remote-targets.example.json), replacing
its reachable SSH address, user, and work root in a local registry outside the source checkout.
Add another entry to use another host; execution code contains no machine names.
The registry supports `version: 1` and a `targets` array. Each target has `id`,
`host`, `user`, `workRoot`, and optional `port` (default `22`). IDs must be unique.
Keep endpoint configuration and credentials out of published evidence.

The generic static SSH path rebuilds the rsync SSH
configuration without inheriting a local `ProxyCommand` alias. Use a directly
reachable TCP endpoint, including an operator-established tunnel. A passing SSH preflight does not prove that source
synchronization can use the same route.

Personal SSH hosts can access their owner's environment. Use only reviewed,
trusted source; `--no-hydrate` is not an isolation boundary for contributor code.
The controller forwards only `CI` through the Crabbox environment allowlist.
Windows-backed targets must remain online, awake, and logged in throughout the
batch. Inspect free memory and existing workloads before dispatch.

## Describe the checks

Create a manifest outside the source worktree. Use an absolute Git top-level for
`source` and a public upstream commit/tag for `base`; the receiver acquires that
base from the canonical OpenClaw repository. A private fork head remains valid as
`sourceSha`, but cannot serve as an unavailable public base. If `base` is omitted,
the planner uses the merge base with local `upstream/main`, then `origin/main`.
No fetch occurs during planning.

Trusted SSH runs reuse the public base at
`<workRoot>/.openclaw-public-bases/v1/<canonical-url-sha256>/depth-2/<baseSha>`.
The seed contains only canonical Git objects and their shallow boundary. It is
published atomically and never updated; concurrent cold misses may each fetch
before one complete seed wins publication. Private source capsules are imported
only after the public objects have been copied into each job's independent Git
directory. No alternates, hardlinks, promisor objects, or symlinks are accepted.
Each copy undergoes full Git object validation and a depth-2 history check before
source materialization and the existing source verification. Corrupt or unrelated
cached objects stop the job before its payload; they do not trigger a silent
refetch. Other Crabbox wrapper paths retain their existing base acquisition.

This cache has no automatic pruning. Stop jobs reading an affected seed before
inspecting or removing it; completed copies no longer depend on the seed. A killed
cold fetch can leave an unpublished temporary directory, which later jobs ignore.
Cleanup of those directories requires confirming their builder has stopped.

Logs contain `OPENCLAW_SOURCE_PHASE` JSON events for public-base fetch, copy and
verification, source materialization and verification, and payload execution.
Each phase emits `started` before its operation and `completed` or `failed` with
`elapsedMs` afterward. The payload phase starts only after source verification;
a timeout with no payload start belongs to receiver preparation. A payload start
records entry into launch, while the command result and its own evidence prove
execution. Warm cache hits omit the fetch phase. Cache work remains inside the
same resource scope and timeout as the job.

This example installs separate dependency lanes, then runs two focused tests:

```json
{
  "version": 1,
  "jobs": [
    {
      "id": "install-one",
      "source": "/path/to/existing/candidate",
      "base": "<public-upstream-commit>",
      "target": "linux-checks",
      "lane": 1,
      "profile": "exclusive",
      "kind": "install",
      "argv": ["corepack", "pnpm", "install", "--frozen-lockfile"]
    },
    {
      "id": "install-two",
      "source": "/path/to/existing/candidate",
      "base": "<public-upstream-commit>",
      "target": "linux-checks",
      "lane": 2,
      "profile": "exclusive",
      "kind": "install",
      "argv": ["corepack", "pnpm", "install", "--frozen-lockfile"]
    },
    {
      "id": "first-tests",
      "source": "/path/to/existing/candidate",
      "base": "<public-upstream-commit>",
      "target": "linux-checks",
      "lane": 1,
      "profile": "parallel",
      "dependsOn": ["install-one", "install-two"],
      "argv": ["node", "scripts/run-vitest.mjs", "src/agents/model-fallback.test.ts"]
    },
    {
      "id": "second-tests",
      "source": "/path/to/existing/candidate",
      "base": "<public-upstream-commit>",
      "target": "linux-checks",
      "lane": 2,
      "profile": "parallel",
      "dependsOn": ["install-one", "install-two"],
      "argv": ["node", "scripts/run-vitest.mjs", "<another-focused-test>"]
    }
  ]
}
```

Each job has a unique `id`, `source`, `target`, `profile`, and exact `argv` array.
Optional fields are `base`, `lane` (`1` or `2`, default `1`), `kind` (`check`,
`install`, `build`, or `full-types`; default `check`), `dependsOn` (default empty),
and `timeoutSeconds` (`1..21600`, default `1800`). Unknown fields and dependency
cycles are rejected. Manifests contain at most 256 jobs.

For sources containing `pnpm-lock.yaml`, every check must depend, directly or
transitively, on an `install` job in the same source/target/lane. Dependencies
release a job only after `PASS`. The receiver uses `install=none` for every manifest
job: only an explicit install job may install dependencies; a parallel check never
implicitly hydrates a lockfile. Install, build, and complete type graphs require
`exclusive`; narrowly scoped lint/typecheck graphs may use `parallel` after
reviewing their scope and memory needs. Use repository-native test/lint/typecheck
wrappers with exact selectors. If shell syntax is necessary, explicitly supply
`bash -c` in `argv` and review the whole command's resource profile.

## Plan and execute

```bash
node scripts/remote-checks.mjs plan \
  --registry /tmp/openclaw/targets.json \
  --manifest /tmp/openclaw/checks.json

node scripts/remote-checks.mjs run \
  --registry /tmp/openclaw/targets.json \
  --manifest /tmp/openclaw/checks.json \
  --results /tmp/openclaw/check-results-new
```

`plan` and `run --dry-run` validate the graph and report source/tooling identities
without contacting targets. `run` requires a new results directory. It freezes all
sources before dispatch using the existing Crabbox privacy-selection owner. Keep
source edits serialized during capture. Later edits do not affect the frozen
batch and are not covered by its results. Keep the tooling checkout unchanged
until the controller exits. The scheduler invokes the selected native Crabbox
binary from the frozen capsule directory; it does not use the tooling-root
wrapper or re-prepare the source. The process does not create Git
worktrees or write candidate files.

The result identifies the candidate by source SHA, frozen tree, and capsule
digest. Dirty source can share a HEAD with another candidate while having a
different tree. The tooling commit and script hashes are recorded separately.
The selected tooling's bounded script travels with each command; an older
candidate cannot silently select its own resource wrapper.

## Resource and lifecycle boundaries

| Profile     | Per-command memory | Per-target overlap | Vitest workers / projects |
| ----------- | ------------------ | ------------------ | ------------------------- |
| `parallel`  | 6 GiB              | At most two jobs   | 2 / 1                     |
| `exclusive` | 14 GiB             | One job            | 1 / 1                     |

Both profiles require the task budget plus 4 GiB of `MemAvailable` at admission.
Node/Go soft limits remain half the cgroup budget. Host-user shared/exclusive locks
and two slot locks are the final admission owner across worktrees, controllers,
and aliases for the same physical host. Startup headroom is not a reservation
against unrelated services growing later. Do not bypass an admission failure or
reduce memory simply to claim more concurrency.

Each batch uses a unique lease namespace. A lane is exclusive to that scheduler
through sync and command execution. Different controllers and older
`run-wsl.sh` copies use different remote lane paths. Jobs within a batch reuse a
lane's dependencies only after the previous command has settled. After Crabbox
transports the files, the receiver applies and verifies the frozen source inside
the bounded scope. Explicit installation and the exact command share that scope.
Source bytes are checked again after the command. Receiver staging uses a private
sibling directory outside the checked source inventory and on the same filesystem
as the execution checkout, so replacing `.git` remains an atomic rename. The
parent must be writable and must protect private entries from other writers (an
owned directory or a sticky temporary directory). Normal completion removes only
that receiver's staging directory. A killed receiver can leave its sibling behind;
later jobs can reuse the lane without admitting unexpected source or deleting
unknown directories. Remove such leftovers only after verifying their command has
stopped and their task ownership.

GNU `timeout` covers the receiver and command inside that scope. Deadline expiry
returns failure (normally exit `124`); the bounded owner cleans up descendants.
The controller also bounds transport to the job deadline plus 120 seconds. Transport timeout, interruption, missing receipt,
or unconfirmed local child-tree / remote scope cleanup produces `UNKNOWN`, freezes queued work on that target,
and preserves the source snapshot and lease for inspection. Other already-running
lanes may finish. There is no automatic recovery or TTL-based reclaim.

A confirmed, pre-command admission refusal can be requeued. `--wait-seconds`
bounds that wait (`1..86400`, default `900`). Admission requires a matching bounded
receipt, confirmed cleanup, remote timing exit `75`, and the corresponding caller
failure. An executed command returning `75` fails once and blocks dependents.
Identical receipt echoes from Crabbox failure summaries count as one receipt;
conflicting receipts remain `UNKNOWN`. The controller never treats an SSH exit or
HTTP success as remote test success.

The controller retains static SSH lease records and remote lane directories.
It never invokes provider `stop`: SSH stop can terminate host-wide
egress workers, affecting other callers on a shared target. Matching bounded
receipts and successful native run completion prove command cleanup. Any later
provider stop needs operator review of its host-wide effects.
Dependency reuse is within a batch; a later batch owns fresh lane paths. Remove
old execution directories only through a separately reviewed cleanup operation.

## Inspect results and verify the mechanism

`results.json` records each job's command, target, lease, profile, attempt times,
caller and remote exit codes, bounded receipt, Crabbox timing, and log path.
Statuses are `PASS`, `FAIL`, `SKIPPED`, or `UNKNOWN` after settling. Process exit
zero requires every job to pass with confirmed scope cleanup. Static leases are
recorded as `leaseDisposition: retained`. Source snapshots
are removed after confirmed cleanup; uncertain snapshots remain for diagnosis.
Recorded staging is admitted before native dispatch and settled only after all
users of that source finish. Uncertain snapshots receive the upstream writer hold,
so orphan discovery cannot reinterpret controller exit as permission to delete them.
Logs and uploaded script captures may contain private source or test output;
inspect them before sharing.

Use two independent necessary checks to demonstrate useful overlap. Record their
actual start/end intervals, scope limits, results, and batch elapsed time. A
passing lock harness proves admission behavior, not the speed of real tests.

After changing bounded resource handling, the host owner can run
`bash scripts/test-run-bounded.sh` directly on a configured target from a copy
containing the matching `scripts/run-bounded.sh`. Do not wrap that integration
check in another bounded command: it deliberately acquires competing locks.
It verifies two slots, heavy/shared exclusion, cache cleanup, admission receipts,
payload exit `75`, failure propagation, descendant cleanup, and lock recovery.
The focused controller check is
`node scripts/run-vitest.mjs test/scripts/remote-checks.test.ts`; it mocks the
external Crabbox boundary while exercising the real scheduler, source capsule,
and native dispatch. Run `node scripts/run-vitest.mjs test/scripts/crabbox-public-base.test.ts`
for the Linux receiver contract; canonical fetches are replaced by local fixture
Git transport, without contacting real targets. The capsule keeps the upstream
staging/fsync, witness, and optional mirror-reuse lifecycle; the scheduler only
adds an explicit source-selection environment, not a second staging owner.

This entrypoint replaces the machine-specific `run-wsl.sh` and its per-invocation
lane setup. Migrate commands to explicit manifest jobs before running this
checkout's remote workflow. See [run-bounded.sh](run-bounded.sh),
[Crabbox config](../.crabbox.remote.yaml), and the
[local resource rules](../AGENTS.md).
