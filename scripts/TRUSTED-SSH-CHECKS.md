# Trusted checks over SSH

Use the persistent validation checkout over SSH for routine private-fork lint,
focused tests, typechecks, and builds. Reuse its dependencies and the repository's
check commands. One operator owns source changes and checks in that checkout.
The resource owner remains [run-bounded.sh](run-bounded.sh); no extra scheduler is
needed. Direct SSH builds do not require Crabbox leases, release hooks, or its
static-provider connection cleanup. A Crabbox transport failure is not proof
that this independent trusted-host build path is unavailable.

Use [remote-checks](REMOTE-CHECKS.md) when a batch needs frozen uncommitted source,
multiple source/lane dependencies, or machine-readable batch results. Keep Crabbox
for those batches and its supported clean-machine, cloud, and cross-platform
workflows. A personal SSH host is for trusted source; neither SSH nor Crabbox's
static SSH provider isolates untrusted contributor code from the owner's account.

## Host and checkout

Resolve actual host aliases and paths from operator documentation outside this
repository (`git config --path --get openclaw.operatorDocs`, when configured).
The following are placeholders, not provisioned endpoints. Verify availability
and resolve the current checkout before each authorized run.

| Purpose                          | Location                                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Linux checks                     | `ssh linux-build-host`, user `build-user`, Ubuntu 24.04 / WSL2                                                                                 |
| Windows host inspection          | `ssh windows-build-host` (Git Bash; invoke PowerShell explicitly if needed)                                                                   |
| Persistent verification checkout | `/home/build-user/openclaw-validation` on WSL                                                                                           |
| Editing candidate on dev         | `/path/to/openclaw-candidate`                                                                  |
| Crabbox tooling                  | Independently prepared candidate/toolroot; see [prerequisites](REMOTE-CHECKS.md#tooling-checkout-and-package-boundary-prerequisites) |
| Static Crabbox TCP endpoint      | Operator-owned TCP tunnel; resolve its endpoint outside this repository                                                                                           |

Prepare the candidate or an isolated toolroot through the maintained
package-boundary owners linked above; do not reuse unrelated worktrees.

The persistent path may refer to a validation checkout through a symlink.
Resolve it with `readlink -f`; do not reuse its former Crabbox lease to mutate it.
Other manifest batches keep their separate generated lane paths. The WSL checkout
is a verification target, not the production Gateway checkout or the release
source. Record source SHA/tree separately from the machine and tooling identity.

The operator-owned SSH alias supplies any required ProxyCommand. Native `ssh` and `scp`
use that alias. Keep both the outer connection and any SSH hop non-multiplexed;
inspect the effective `ControlMaster`/`ControlPersist` settings for the hop alias
before execution. Pass job-local options rather than editing shared SSH config
or closing an existing master. The examples explicitly disable outer connection
reuse and leave persistent infrastructure tunnels untouched. Crabbox's generic rsync path does not inherit that route;
its documented TCP tunnel remains necessary for that path. A successful SSH
probe alone does not prove Crabbox synchronization will work.

Keep Windows awake and logged in for long jobs. Inspect the host before dispatch:

```bash
SSH_OPTIONS=(-o BatchMode=yes -o RequestTTY=no -o ConnectTimeout=10 -o ConnectionAttempts=1 -o ControlMaster=no -o ControlPath=none -o ControlPersist=no)
ssh -n "${SSH_OPTIONS[@]}" linux-build-host 'hostname; node --version; corepack pnpm --version; free -h; systemctl --user show openclaw-tests.slice -p TasksCurrent -p MemoryCurrent -p MemoryMax'
```

Define the same `SSH_OPTIONS` array in each local shell used for the following
recipes. `scp` accepts these `-o` options too. Do not add `-n` when sending a
remote script on stdin.

Resolve toolchain versions from the candidate's `package.json` and lockfile.
The 9.7 preparation used Node 26.8.1 and pnpm 12.5.1; verify the target versions
before execution. Do not install into a live Gateway checkout.

## Run an already synchronized candidate

The examples use Bash. Set `SOURCE_SHA` to the exact committed candidate on dev,
then use one SSH shell. The repository lock covers dependency changes, execution,
and final source checks; fd 7 leaves the bounded owner's fds 8/9 available.
The lock uses the real Git common directory, so path aliases share it.

```bash
set -euo pipefail
test -z "$(git -C /path/to/openclaw-candidate status --porcelain --untracked-files=normal)"
SOURCE_SHA=$(git -C /path/to/openclaw-candidate rev-parse HEAD)
ssh "${SSH_OPTIONS[@]}" linux-build-host bash -s -- "$SOURCE_SHA" <<'REMOTE'
set -euo pipefail
cd /home/build-user/openclaw-validation
exec 7>"$(git rev-parse --path-format=absolute --git-common-dir)/openclaw-validation.lock"
flock -n 7 || { echo 'Validation checkout is busy' >&2; exit 75; }
expected=$1
test "$(git rev-parse HEAD)" = "$expected"
test -z "$(git status --porcelain --untracked-files=normal)"
proof=$(mktemp -d /tmp/openclaw-check.XXXXXXXX)
printf 'source=%s tree=%s host=%s\n' "$expected" "$(git rev-parse HEAD^{tree})" "$(hostname)" | tee "$proof/source.txt"
code=0
bash scripts/run-bounded.sh --profile dedicated-heavy --receipt "$proof/receipt.json"   node scripts/run-vitest.mjs src/agents/model-fallback.test.ts   >"$proof/check.log" 2>&1 || code=$?
cat "$proof/check.log"
cat "$proof/receipt.json"
printf 'Evidence: %s\n' "$proof"
test "$(git rev-parse HEAD)" = "$expected"
test -z "$(git status --porcelain --untracked-files=normal)"
exit "$code"
REMOTE
```

On a dedicated host with at least 28 GiB currently available, `dedicated-large`
uses an exclusive 24 GiB scope, four test workers per project, and Go parallelism
four. It requires an active `openclaw-large-tests.slice` with 26 GiB memory,
zero swap, and CPUQuota=800%; the wrapper verifies both parent and child limits.
The same host-user lock excludes every other bounded profile. Node and Go soft
budgets are each 12 GiB. This explicitly provisioned profile defaults the existing
local-check mode to `full` so the conservative auto policy does not add single-threaded
compiler flags; an operator-authored mode still takes precedence. Start the configured
slice in the same SSH session as the check, and retain receipts and exact source
identity as above. On a host with both slices configured, run
`OPENCLAW_TEST_LARGE_PROFILE=1 bash scripts/test-run-bounded.sh` for the resource
contract suite, including existing profiles, exclusion, failure receipts and cleanup. This profile does
not change the existing shared-host or WSL/dedicated budgets, and does not promise
that a workload will fit or be CPU-parallel.

Use `dedicated-test` for a focused workload known to fit 6 GiB. Two such commands
can overlap only in separate owned checkouts. A shared checkout stays exclusive,
including installation and artifact preparation. Never switch source, reconcile
`node_modules`, or sync files while another caller uses the checkout.

A clean checkout's HEAD must match the candidate. A Crabbox capsule initially has
a synthesized carrier HEAD: its `sourceSha` and frozen tree are recorded in
`results.json`. Do not call that carrier the candidate commit. Perform the explicit
Git synchronization below before treating the persistent checkout as committed
source. Do not silently omit WIP because HEAD looks correct.

## Refresh committed source

Use a Git bundle to transfer private committed history without publishing a
branch. This recipe requires a clean candidate. For the minimal direct-SSH path,
first make a local reviewed checkpoint commit; it need not be pushed or treated
as an accepted release. Record that checkpoint's exact SHA and tree. Never send
only HEAD while silently dropping staged/uncommitted files. If uncommitted source
must remain uncommitted, use [the existing frozen capsule workflow](REMOTE-CHECKS.md#plan-and-execute)
instead; that optional path retains its own transport acceptance requirements.

On dev, choose the exact public base already present on the target:

```bash
set -euo pipefail
SOURCE=/path/to/openclaw-candidate
BASE=$(git -C "$SOURCE" rev-parse v2026.9.4^{commit})
test -z "$(git -C "$SOURCE" status --porcelain --untracked-files=normal)"
SOURCE_SHA=$(git -C "$SOURCE" rev-parse HEAD)
STAGE=$(mktemp -d /tmp/openclaw-source.XXXXXXXX)
git -C "$SOURCE" bundle create "$STAGE/source.bundle" "$BASE..HEAD"
test "$(git -C "$SOURCE" rev-parse HEAD)" = "$SOURCE_SHA"
test -z "$(git -C "$SOURCE" status --porcelain --untracked-files=normal)"
test "$(git bundle list-heads "$STAGE/source.bundle" HEAD | cut -d' ' -f1)" = "$SOURCE_SHA"
REMOTE_STAGE=$(ssh -n "${SSH_OPTIONS[@]}" linux-build-host 'mktemp -d /tmp/openclaw-source.XXXXXXXX')
scp "${SSH_OPTIONS[@]}" "$STAGE/source.bundle" "linux-build-host:$REMOTE_STAGE/source.bundle"
ssh "${SSH_OPTIONS[@]}" linux-build-host bash -s -- "$REMOTE_STAGE/source.bundle" "$SOURCE_SHA" <<'REMOTE'
set -euo pipefail
cd /home/build-user/openclaw-validation
exec 7>"$(git rev-parse --path-format=absolute --git-common-dir)/openclaw-validation.lock"
flock -n 7 || { echo 'Validation checkout is busy' >&2; exit 75; }
test -z "$(git status --porcelain --untracked-files=normal)"
git bundle verify "$1"
git -c core.hooksPath=/dev/null fetch "$1" HEAD
test "$(git rev-parse FETCH_HEAD)" = "$2"
git -c core.hooksPath=/dev/null switch --detach "$2"
bash scripts/run-bounded.sh --profile dedicated-heavy   corepack pnpm install --frozen-lockfile
test "$(git rev-parse HEAD)" = "$2"
test -z "$(git status --porcelain --untracked-files=normal)"
REMOTE
```

The command-scoped hook override applies only to transport checkout operations;
commits and validation retain repository hooks and checks. No `reset --hard`,
`clean`, or broad rsync deletion is needed. If bundle prerequisites are missing,
acquire the exact public base first; do not substitute a moving branch.
A later check must reacquire the same repository lock and recheck the expected SHA.
Keep the same lock open to combine source refresh, install, and checks in one shell.

Reuse ignored dependencies/artifacts while their input contracts remain valid.
Dependency inputs changed: install under the exclusive bounded profile first.
Generated declarations and dist freshness remain with their canonical preparation
scripts. Do not hand-edit them or copy another checkout's `node_modules`.

## Choose the check

Replace the payload in the first example while retaining the lock, bounded
profile, receipt, and before/after source checks.

| Work           | Payload inside the bounded command                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused tests  | `node scripts/run-vitest.mjs <test-file> [-t <selector>]`                                                                                    |
| Core lint      | `env OPENCLAW_OXLINT_SHARDS_SERIAL=1 node --import ./scripts/tsx.mjs scripts/run-oxlint-shards.mts --only=core --split-core`                 |
| Extension lint | `env OPENCLAW_OXLINT_SHARDS_SERIAL=1 node --import ./scripts/tsx.mjs scripts/run-oxlint-shards.mts --only=extensions --extension-stripe=1/1` |
| Scripts lint   | `env OPENCLAW_OXLINT_SHARDS_SERIAL=1 node --import ./scripts/tsx.mjs scripts/run-oxlint-shards.mts --only=scripts`                           |
| Core types     | `corepack pnpm tsgo:core`                                                                                                                    |
| Build          | `corepack pnpm build`                                                                                                                        |

Run the three lint categories separately to retain each result. Repeated `--only`
flags can combine categories, but stripe flags require their corresponding
core-only or extension-only selection. Core stripes require `--split-core --core-stripe=I/N`; extension stripes use
`--extension-stripe=I/N`. Cover every stripe before claiming complete lint.
The extension runner groups eight plugins and includes root source files.
Use the existing shard planner/heartbeat/timeout owner instead of a new batching
or heartbeat script. For one/few files, use `scripts/run-oxlint.mjs --tsconfig
<matching-config> <files...>` as specified in [the scripts guide](AGENTS.md).

If a native core shard still exceeds the cap, preserve completed shards and use
the targeted command builder in `check-changed.mts` for the failing file inventory.
Keep the same nearest tsconfig, rule set, and transitive imports; record exact
coverage. Fewer argv entries alone do not necessarily shrink the loaded type graph.
Extension declaration preparation is a separate phase: its failure means lint has
not started. Nested checkouts can resolve declaration inputs from an ancestor's
installation; use this independent WSL checkout instead of weakening that guard.

When narrowing a test typecheck, extend its canonical `test/tsconfig/` config
and retain the ambient declaration inputs from that config. TypeScript replaces
`include` instead of merging it: selecting only a test file can omit declarations
such as the repository's `qrcode` module declaration and report a misleading
TS7016. Keep the canonical `src/**/*.d.ts`, `ui/**/*.d.ts`,
`extensions/**/*.d.ts`, and `packages/**/*.d.ts` inputs alongside the selected
tests, using paths resolved from the temporary config. Store that derived config
under the ignored `.artifacts/tsgo-cache/` directory, and invoke
`node scripts/run-tsgo.mjs -p <derived-config>`. Preserve the original rules,
transitive imports, and recorded file scope; do not add a stub or weaken types to
compensate for omitted declarations.

## E2E and final release builds

Run E2E checks in the isolated validation checkout before the final release build in
its source candidate. The E2E runner prepares private QA entrypoints that the
normal full build omits; its `qaRuntime` preparation can replace `dist/` and remove
release metadata. A previous successful build receipt does not describe those
replacement artifacts. After all E2E work, run the final full build and verify
its source SHA, build ID, import closure, and Control UI assets before activation.
Use the existing build cache, and keep passing source checks whose inputs have
not changed. Do not run another artifact writer concurrently in either checkout.

## Memory and failure recovery

Host memory and swap are operator-owned settings. Test commands have swap
disabled. The required parent `openclaw-tests.slice` is 16 GiB; profiles
are two 6 GiB tests or one exclusive 14 GiB job. These limits and the 4 GiB admission
headroom are enforced by [run-bounded.sh](run-bounded.sh) and the root
[resource policy](../AGENTS.md#local-fork-resource-limits).

More WSL memory alone does not raise a task's cgroup limit. Prefer native lint
shards at the current limit. Increasing a dedicated profile requires changing and
verifying both its parent slice and wrapper contract, checking Windows/WSL headroom,
and measuring the same workload; do not disable the cap or change host swap.

| Observation                                                          | Interpretation and next action                                                                                                                           |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lint diagnostics and nonzero exit                                    | Fix the reported source contract; rerun affected checks.                                                                                                 |
| `Result=oom-kill`, peak near `MemoryMax`                             | Task cgroup OOM. Confirm descendants stopped, then narrow the relevant shard. Longer SSH timeout or heartbeat does not fix it.                           |
| Failed unit, empty `ControlGroup`, confirmed cleanup                 | The command failed, but the scope is settled. Preserve FAIL and permit later admission.                                                                  |
| Missing/failed observation, surviving cgroup, transport interruption | Completion is unknown. Inspect the exact task before another sync or retry; no automatic PASS or blind reclaim.                                          |
| Receipt `admission-refused`, `commandStarted=false`, exit 75         | No payload ran; retry after the conflicting owner releases the lock or the required memory headroom returns. A payload returning 75 is a normal failure. |
| Crabbox `finish rsync workspace witness`, exit 74, `commandMs=0`     | Transport ownership failed before lint. Preserve that UNKNOWN result; inspect its exact lease. Do not describe it as a lint failure.                     |

Inspect only the exact unit named in the receipt/log:

```bash
ssh -n linux-build-host 'systemctl --user show <unit.scope> -p Id -p Result -p ActiveState -p SubState -p ControlGroup -p MemoryMax -p MemoryPeak'
```

The bounded owner recognizes a matching terminal systemd unit with an empty
control group even when the failed unit remains loaded after OOM. It reports the
failed scope's `Result` and `MemoryPeak`; nonzero exit remains failure. Inconclusive
queries remain UNKNOWN. Do not erase failed units or old results to make a batch green.

After resource-owner changes, run `bash scripts/test-run-bounded.sh` directly on
an idle configured WSL host, without an outer bounded scope. It tests competing
locks, two slots, exit propagation, descendants, OOM cleanup and subsequent
admission. Its OOM injection lowers only its own scope to 64 MiB and touches
256 MiB; this is a deliberate small fault-injection budget, not a new lint default.

Keep per-check logs, exact source/tree, tooling identity, receipt and exit result.
Reuse passing evidence with unchanged inputs. A transfer exit, an empty process
list, or a launched command alone is not test acceptance. Real Gateway identity,
state migration and Telegram operator acceptance remain separate deployment gates.
