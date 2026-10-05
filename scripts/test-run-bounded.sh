#!/usr/bin/env bash
# Run on a dedicated test host with openclaw-tests.slice already configured.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
runner="$root/scripts/run-bounded.sh"
tmp=$(mktemp -d)
pids=()
cleanup() {
  local code=$?
  trap - EXIT
  touch "$tmp/release"
  for pid in "${pids[@]}"; do
    wait "$pid" || true
  done
  if (( code )); then
    cat "$tmp"/*.log >&2
  fi
  rm -rf -- "$tmp"
  exit "$code"
}
trap cleanup EXIT
await_file() {
  local path=$1
  for ((i=0; i<200; i++)); do
    [[ ! -f "$path" ]] || return 0
    sleep 0.05
  done
  echo "Timed out waiting for $path" >&2
  return 1
}
expect_exit() {
  local expected=$1 actual=0
  shift
  "$@" > "$tmp/rejected.log" 2>&1 || actual=$?
  [[ "$actual" == "$expected" ]] || {
    echo "Expected exit $expected; got $actual" >&2
    return 1
  }
}
start_hold() {
  local profile=$1 name=$2
  bash "$runner" --profile "$profile" bash -euo pipefail -c '
    printf "%s\n" "$OPENCLAW_VITEST_FS_MODULE_CACHE_PATH" > "$1/$2.cache"
    printf "%s %s\n" "$OPENCLAW_VITEST_MAX_WORKERS" "$OPENCLAW_TEST_PROJECTS_PARALLEL" > "$1/$2.workers"
    touch "$1/$2.ready"
    for ((i=0; i<400; i++)); do
      [[ ! -f "$1/release" ]] || exit 0
      sleep 0.05
    done
    exit 1
  ' test "$tmp" "$name" > "$tmp/$name.log" 2>&1 &
  pids+=("$!")
  await_file "$tmp/$name.ready"
}
release_holds() {
  touch "$tmp/release"
  for pid in "${pids[@]}"; do
    wait "$pid"
  done
  pids=()
  rm "$tmp/release"
}
expect_exit 2 bash "$runner" --profile invalid true
expect_exit 2 bash "$runner" --profile dedicated-test --memory-gib 4 true

start_hold dedicated-test first
start_hold dedicated-test second
[[ "$(<"$tmp/first.workers")" == '2 1' && "$(<"$tmp/second.workers")" == '2 1' ]]
first_cache=$(<"$tmp/first.cache")
second_cache=$(<"$tmp/second.cache")
[[ "$first_cache" != "$second_cache" && -d "$first_cache" && -d "$second_cache" ]]
expect_exit 75 bash "$runner" --profile dedicated-test --receipt "$tmp/admission.json" true
node -e 'const r=require(process.argv[1]);if(r.status!=="admission-refused"||r.commandStarted||!r.cleanupConfirmed||r.exitCode!==75)process.exit(1)' "$tmp/admission.json"
expect_exit 75 bash "$runner" --profile dedicated-heavy true
expect_exit 75 bash "$runner" --memory-gib 1 true
release_holds
[[ ! -e "$first_cache" && ! -e "$second_cache" ]]

start_hold dedicated-heavy heavy
[[ "$(<"$tmp/heavy.workers")" == '1 1' ]]
expect_exit 75 bash "$runner" --profile dedicated-test true
expect_exit 75 bash "$runner" --profile dedicated-heavy true
release_holds
expect_exit 75 bash "$runner" --profile dedicated-test --receipt "$tmp/payload.json" bash -c 'exit 75'
node -e 'const r=require(process.argv[1]);if(r.status!=="failed"||!r.commandStarted||!r.cleanupConfirmed||r.exitCode!==75)process.exit(1)' "$tmp/payload.json"
expect_exit 37 bash "$runner" --profile dedicated-test bash -c 'exit 37'
expect_exit 1 bash "$runner" --profile dedicated-test bash -c 'sleep 30 & echo $! > "$1/descendant.pid"' test "$tmp"
descendant=$(<"$tmp/descendant.pid")
if kill -0 "$descendant" 2>/dev/null && [[ "$(ps -p "$descendant" -o stat=)" != Z* ]]; then
  echo "Descendant $descendant survived scope cleanup" >&2
  exit 1
fi
# Lower only the owned scope for a small, deterministic OOM fault injection.
oom_code=0
bash "$runner" --profile dedicated-heavy --receipt "$tmp/oom.json" bash -euo pipefail -c '
  group=$(awk -F: '\''$1 == "0" {print $3}'\'' /proc/self/cgroup)
  unit=${group##*/}
  systemctl --user set-property --runtime "$unit" MemoryMax=64M
  [[ "$(<"/sys/fs/cgroup${group}/memory.max")" == 67108864 ]]
  exec python3 -c "data = bytearray(256 * 1024 * 1024)"
' > "$tmp/oom.log" 2>&1 || oom_code=$?
(( oom_code != 0 )) || { echo 'OOM payload unexpectedly succeeded' >&2; exit 1; }
node -e 'const r=require(process.argv[1]);if(r.status!=="failed"||!r.commandStarted||!r.cleanupConfirmed||r.exitCode===0)process.exit(1)' "$tmp/oom.json"
oom_unit=$(node -e 'console.log(require(process.argv[1]).unit)' "$tmp/oom.json")
oom_state=$(systemctl --user show "$oom_unit" -p Result -p ActiveState -p ControlGroup)
grep -qx 'Result=oom-kill' <<< "$oom_state"
grep -qx 'ActiveState=failed' <<< "$oom_state"
grep -qx 'ControlGroup=' <<< "$oom_state"
bash "$runner" --profile dedicated-test true > "$tmp/recovery.log" 2>&1
if [[ "${OPENCLAW_TEST_LARGE_PROFILE:-}" == 1 ]]; then
  expect_exit 2 bash "$runner" --profile dedicated-large --memory-gib 24 true
  start_hold dedicated-large large
  [[ "$(<"$tmp/large.workers")" == '4 1' ]]
  expect_exit 75 bash "$runner" --profile dedicated-heavy true
  expect_exit 75 bash "$runner" --profile dedicated-test true
  expect_exit 75 bash "$runner" --profile dedicated-large true
  release_holds
  bash "$runner" --profile dedicated-large --receipt "$tmp/large.json" bash -euo pipefail -c '
    group=$(awk -F: '\''$1 == "0" {print $3}'\'' /proc/self/cgroup)
    [[ "$(<"/sys/fs/cgroup${group}/memory.max")" == 25769803776 ]]
    [[ "$(<"/sys/fs/cgroup${group}/memory.swap.max")" == 0 ]]
    [[ "$GOMAXPROCS" == 4 && "$GOMEMLIMIT" == 12288MiB ]]
    [[ "$NODE_OPTIONS" == *--max-old-space-size=12288* ]]
    [[ "$OPENCLAW_LOCAL_CHECK_MODE" == full ]]
  ' > "$tmp/large-proof.log" 2>&1
  node -e 'const r=require(process.argv[1]);if(r.status!=="completed"||!r.commandStarted||!r.cleanupConfirmed||r.exitCode!==0)process.exit(1)' "$tmp/large.json"
  OPENCLAW_LOCAL_CHECK_MODE=throttled bash "$runner" --profile dedicated-large bash -euo pipefail -c '
    [[ "$OPENCLAW_LOCAL_CHECK_MODE" == throttled ]]
  ' > "$tmp/large-explicit-policy.log" 2>&1
  echo 'PASS: dedicated-large 24 GiB boundary, zero swap, soft budgets, worker policy, explicit mode preservation, cross-profile exclusion'
fi
echo 'PASS: two task slots, heavy/shared exclusion, unique cache cleanup, admission receipts, payload exit 75, exit propagation, descendant cleanup, OOM failure receipt, lock recovery'
