#!/usr/bin/env bash
set -euo pipefail

unit=""
cache_dir=""
receipt=""
admission_refused=false
finish() {
  local code=$? group state cleanup_confirmed=true command_started=false status
  trap - EXIT INT TERM
  if [[ -n "$unit" ]]; then
    group=$(systemctl --user show "$unit" -p ControlGroup --value 2>/dev/null) || group=""
    if [[ -n "$group" && -r "/sys/fs/cgroup${group}/cgroup.events" ]] &&
      grep -qx 'populated 1' "/sys/fs/cgroup${group}/cgroup.events"; then
      echo "[bounded] command left descendants; stopping only $unit" >&2
      systemctl --user stop "$unit" || { code=1; cleanup_confirmed=false; }
      [[ "$code" != 0 ]] || code=1
    fi
  fi
  if [[ -n "$unit" ]]; then
    group=$(systemctl --user show "$unit" -p ControlGroup --value 2>/dev/null) || group=""
    if [[ -n "$group" && -r "/sys/fs/cgroup${group}/cgroup.events" ]]; then
      grep -qx 'populated 0' "/sys/fs/cgroup${group}/cgroup.events" || cleanup_confirmed=false
    else
      state=$(systemctl --user show "$unit" -p Id -p LoadState -p ActiveState -p SubState -p ControlGroup -p Result -p MemoryPeak 2>/dev/null) || state=""
      if ! grep -Fqx "Id=$unit" <<< "$state"; then
        cleanup_confirmed=false
      elif grep -Fqx 'LoadState=not-found' <<< "$state"; then
        :
      elif grep -Fqx 'LoadState=loaded' <<< "$state" &&
        grep -Eqx 'ActiveState=(inactive|failed)' <<< "$state" &&
        grep -Eqx 'SubState=(dead|failed)' <<< "$state" &&
        grep -Fqx 'ControlGroup=' <<< "$state"; then
        # A failed scope can outlive its already-destroyed cgroup.
        if grep -Fqx 'ActiveState=failed' <<< "$state"; then
          [[ "$code" != 0 ]] || code=1
          echo "[bounded] terminal scope $unit:" >&2
          grep -E '^(Result|MemoryPeak)=' <<< "$state" >&2 || true
        fi
      else
        cleanup_confirmed=false
      fi
    fi
  fi
  [[ "$cleanup_confirmed" == true ]] || code=1
  if [[ -n "$receipt" ]]; then
    [[ ! -f "$receipt.started" ]] || command_started=true
    status=failed
    if [[ "$cleanup_confirmed" != true ]]; then status=unknown
    elif [[ "$admission_refused" == true && "$command_started" == false ]]; then status=admission-refused
    elif [[ "$code" == 0 ]]; then status=completed
    fi
    printf '{"status":"%s","exitCode":%s,"commandStarted":%s,"cleanupConfirmed":%s,"unit":"%s"}\n' \
      "$status" "$code" "$command_started" "$cleanup_confirmed" "$unit" > "$receipt.tmp.$$"
    mv -- "$receipt.tmp.$$" "$receipt"
  fi
  [[ -z "$cache_dir" ]] || rm -rf -- "$cache_dir"
  if [[ "$code" != 0 ]]; then
    echo "[bounded] FAILED (exit $code)" >&2
  else
    echo "[bounded] completed (exit 0)" >&2
  fi
  exit "$code"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

memory_gib=auto
reserve_gib=4
large_memory_gib=24
large_memory_override=false
fit_available=false
profile=shared-host
if [[ "${1:-}" == --help || $# == 0 ]]; then
  printf '%s\n' \
    'Usage: bash scripts/run-bounded.sh [--profile shared-host|dedicated-test|dedicated-heavy|dedicated-large] [--memory-gib 1..10] [--reserve-gib 1..4] [--large-memory-gib 24..28] [--fit-available] [--receipt path] [--] command [args...]' \
    'Linux + systemd user manager + cgroup v2 required; never runs uncapped.' \
    'Default shared-host: min(10 GiB, available memory minus 4 GiB), rounded down; no swap.' \
    'Shared-host: one test worker/project and an exclusive host-user lock.' \
    'Dedicated profiles require active openclaw-tests.slice: 16 GiB, no swap, CPUQuota=1200%.' \
    'Dedicated-test: two concurrent 6 GiB tasks, two workers/one project, unique Vitest caches.' \
    'Dedicated-heavy: one exclusive 14 GiB task in the same slice; one worker/project.' \
    'Dedicated-large: one exclusive 24 GiB task, four workers/project, Go parallelism 4.' \
    'Dedicated-large requires openclaw-large-tests.slice: 26 GiB by default, no swap, CPUQuota=800%.' \
    'All profiles retain 4 GiB headroom by default; --reserve-gib explicitly selects 1..4 GiB.' \
    '--large-memory-gib selects 24..28 GiB only for dedicated-large; its configured slice must have task budget plus 2 GiB.' \
    '--fit-available caps dedicated-large tasks at min(ceiling, available minus reserve), with a 14 GiB minimum; the slice still follows the ceiling.' \
    'Use reduced reserve only on an operator-authorized disposable validation host; shared defaults are unchanged.' \
    '--memory-gib applies only to shared-host.' \
    'Node/Go soft limits: half the budget; Go parallelism at most 2 (4 for dedicated-large), GOGC 100.' \
    'tsdown owns its child heap budget and can override the inherited Node heap; the cgroup hard cap remains.' \
    'Examples: pnpm test:bounded src/agents/model-fallback.test.ts' \
    '          pnpm bounded --profile dedicated-test node scripts/run-vitest.mjs src/utils.test.ts' \
    '          pnpm bounded --profile dedicated-heavy pnpm build'
  exit 0
fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      profile=${2:-}
      [[ "$profile" == shared-host || "$profile" == dedicated-test || "$profile" == dedicated-heavy || "$profile" == dedicated-large ]] || {
        echo '[bounded] --profile must be shared-host, dedicated-test, dedicated-heavy, or dedicated-large' >&2; exit 2;
      }
      shift 2 ;;
    --receipt)
      receipt=${2:-}
      [[ "$receipt" == /* && -O "$(dirname "$receipt")" && ! -e "$receipt" && ! -L "$receipt" ]] || {
        receipt=""; echo '[bounded] --receipt requires a new file in a user-owned directory' >&2; exit 2;
      }
      shift 2 ;;
    --fit-available)
      fit_available=true
      shift ;;
    --reserve-gib)
      reserve_gib=${2:-}
      [[ "$reserve_gib" =~ ^[1-4]$ ]] || { echo '[bounded] --reserve-gib must be 1..4' >&2; exit 2; }
      shift 2 ;;
    --large-memory-gib)
      large_memory_gib=${2:-}
      [[ "$large_memory_gib" =~ ^(2[4-8])$ ]] || { echo '[bounded] --large-memory-gib must be 24..28' >&2; exit 2; }
      large_memory_override=true
      shift 2 ;;
    --memory-gib)
      memory_gib=${2:-}
      [[ "$memory_gib" =~ ^([1-9]|10)$ ]] || { echo '[bounded] --memory-gib must be 1..10' >&2; exit 2; }
      shift 2 ;;
    --) shift; break ;;
    --*) echo "[bounded] unknown option: $1" >&2; exit 2 ;;
    *) break ;;
  esac
done
[[ $# -gt 0 ]] || { echo '[bounded] missing command; use --help' >&2; exit 2; }
if [[ "$fit_available" == true && "$profile" != dedicated-large ]]; then
  echo '[bounded] --fit-available requires --profile dedicated-large' >&2
  exit 2
fi
if [[ "$large_memory_override" == true && "$profile" != dedicated-large ]]; then
  echo '[bounded] --large-memory-gib requires --profile dedicated-large' >&2
  exit 2
fi
if [[ "$profile" != shared-host && "$memory_gib" != auto ]]; then
  echo '[bounded] dedicated profiles have fixed budgets; --memory-gib applies only to shared-host' >&2
  exit 2
fi
[[ "$(uname -s)" == Linux && -r /sys/fs/cgroup/cgroup.controllers ]] || {
  echo '[bounded] Linux with cgroup v2 is required' >&2; exit 2;
}
for dependency in systemd-run systemctl flock; do
  command -v "$dependency" >/dev/null || { echo "[bounded] missing $dependency" >&2; exit 2; }
done
[[ -n "${XDG_RUNTIME_DIR:-}" && -d "$XDG_RUNTIME_DIR" && -O "$XDG_RUNTIME_DIR" ]] || {
  echo '[bounded] a user-owned XDG_RUNTIME_DIR is required' >&2; exit 2;
}

slice_group=""
slice_args=()
slice_name=openclaw-tests.slice
slice_memory=17179869184
slice_cpus=12
if [[ "$profile" == dedicated-large ]]; then
  slice_name=openclaw-large-tests.slice
  slice_memory=$(((large_memory_gib + 2) * 1073741824))
  slice_cpus=8
fi
if [[ "$profile" != shared-host ]]; then
  slice_group=$(systemctl --user show "$slice_name" -p ControlGroup --value)
  if [[ "$slice_group" != /*/"$slice_name" ||
    ! -r "/sys/fs/cgroup${slice_group}/memory.max" ]]; then
    echo "[bounded] dedicated profile requires an active, configured $slice_name on this host" >&2
    exit 2
  fi
  read -r quota period < "/sys/fs/cgroup${slice_group}/cpu.max"
  if [[ "$(<"/sys/fs/cgroup${slice_group}/memory.max")" != "$slice_memory" ||
    "$(<"/sys/fs/cgroup${slice_group}/memory.swap.max")" != 0 ||
    ! "$quota" =~ ^[1-9][0-9]*$ || ! "$period" =~ ^[1-9][0-9]*$ ]] ||
    (( quota != slice_cpus * period )); then
    echo "[bounded] $slice_name must enforce memory.max=$slice_memory, memory.swap.max=0, CPUQuota=$((slice_cpus * 100))%; refusing command" >&2
    exit 2
  fi
  slice_args=(--slice="$slice_name")
  memory_gib=14
  [[ "$profile" != dedicated-test ]] || memory_gib=6
  [[ "$profile" != dedicated-large ]] || memory_gib=$large_memory_gib
fi

# One lock across worktrees; retain it and any slot through scope cleanup.
exec 9>"$XDG_RUNTIME_DIR/openclaw-bounded-check.lock"
lock_mode=--exclusive
[[ "$profile" != dedicated-test ]] || lock_mode=--shared
flock --nonblock "$lock_mode" 9 || { echo '[bounded] a conflicting bounded check is running; retry after it exits' >&2; admission_refused=true; exit 75; }
if [[ "$profile" == dedicated-test ]]; then
  slot_acquired=0
  for slot in 1 2; do
    exec 8>"$XDG_RUNTIME_DIR/openclaw-bounded-test-$slot.lock"
    if flock --nonblock 8; then
      slot_acquired=1
      break
    fi
    exec 8>&-
  done
  (( slot_acquired )) || { echo '[bounded] both dedicated test slots are busy; retry after one exits' >&2; admission_refused=true; exit 75; }
fi
available_kib=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
if [[ "$fit_available" == true ]]; then
  fitted_gib=$((available_kib / 1048576 - reserve_gib))
  if (( fitted_gib < 14 )); then
    echo "[bounded] available ${available_kib} KiB cannot fit the 14 GiB large-task minimum plus ${reserve_gib} GiB reserve" >&2
    admission_refused=true
    exit 75
  fi
  (( memory_gib <= fitted_gib )) || memory_gib=$fitted_gib
fi
if [[ "$memory_gib" == auto ]]; then
  memory_gib=$((available_kib / 1048576 - reserve_gib))
  if (( memory_gib > 10 )); then
    memory_gib=10
  fi
fi
if (( memory_gib < 1 || available_kib < (memory_gib + reserve_gib) * 1048576 )); then
  echo "[bounded] insufficient available memory for the task plus ${reserve_gib} GiB reserve; wait or narrow the workload (shared-host also accepts an explicit budget)" >&2
  admission_refused=true
  exit 75
fi
echo "[bounded] profile $profile, available ${available_kib} KiB, selected ${memory_gib} GiB, reserve ${reserve_gib} GiB" >&2
free -h
echo '[bounded] largest current processes (KiB RSS):' >&2
ps -eo pid,rss,comm --sort=-rss | sed -n '1,8p'

heap_mib=$((memory_gib * 512))
go_mib=$heap_mib
go_procs=1
if (( memory_gib >= 6 )); then
  go_procs=2
fi
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=$heap_mib"
export GOMEMLIMIT="${go_mib}MiB" GOGC="${GOGC:-100}"
# Oxlint's --threads flag does not constrain its Go type-aware helper.
if [[ "$profile" == dedicated-large ]]; then
  go_procs=4
  export OPENCLAW_LOCAL_CHECK_MODE="${OPENCLAW_LOCAL_CHECK_MODE:-full}"
fi
export GOMAXPROCS=$go_procs
workers=1
[[ "$profile" != dedicated-test ]] || workers=2
[[ "$profile" != dedicated-large ]] || workers=4
export OPENCLAW_TEST_PROJECTS_PARALLEL=1 OPENCLAW_VITEST_MAX_WORKERS=$workers
if [[ "$profile" != shared-host ]]; then
  cache_dir=$(mktemp -d "$XDG_RUNTIME_DIR/openclaw-vitest.XXXXXXXX")
  export OPENCLAW_VITEST_FS_MODULE_CACHE_PATH="$cache_dir"
fi
unit="openclaw-check-$(date +%s)-$$.scope"
echo "[bounded] $unit: ${memory_gib} GiB, swap 0, workers $workers/project 1" >&2
echo "[bounded] Node heap ${heap_mib} MiB, Go memory ${go_mib} MiB, GOMAXPROCS=$GOMAXPROCS GOGC=$GOGC" >&2
systemd-run --user --scope --quiet --expand-environment=no --unit="$unit" "${slice_args[@]}" \
  --property="MemoryMax=${memory_gib}G" --property=MemorySwapMax=0 \
  bash -euo pipefail -c '
    expected=$1
    unit=$2
    slice=$3
    receipt=$4
    slice_memory=$5
    slice_cpus=$6
    shift 6
    group=$(awk -F: '\''$1 == "0" {print $3}'\'' /proc/self/cgroup)
    [[ -n "$group" && "$group" == */"$unit" ]] || exit 1
    if [[ -n "$slice" ]]; then
      [[ "$group" == "$slice/$unit" ]] || exit 1
      read -r quota period < "/sys/fs/cgroup${slice}/cpu.max"
      if [[ "$(<"/sys/fs/cgroup${slice}/memory.max")" != "$slice_memory" ||
        "$(<"/sys/fs/cgroup${slice}/memory.swap.max")" != 0 ||
        ! "$quota" =~ ^[1-9][0-9]*$ || ! "$period" =~ ^[1-9][0-9]*$ ]] ||
        (( quota != slice_cpus * period )); then
        echo "[bounded] dedicated slice boundaries changed; refusing command" >&2
        exit 1
      fi
      echo "[bounded] verified slice memory.max=$slice_memory memory.swap.max=0 cpu.max=$quota $period" >&2
    fi
    actual=$(<"/sys/fs/cgroup${group}/memory.max")
    swap=$(<"/sys/fs/cgroup${group}/memory.swap.max")
    if [[ "$actual" != "$expected" || "$swap" != 0 ]]; then
      echo "[bounded] effective cgroup limits do not match; refusing command" >&2
      exit 1
    fi
    systemctl --user show "$unit" -p MemoryMax -p MemorySwapMax -p ControlGroup
    echo "[bounded] verified memory.max=$actual memory.swap.max=$swap" >&2
    [[ -z "$receipt" ]] || touch "$receipt.started"
    exec "$@"
  ' bounded "$((memory_gib * 1073741824))" "$unit" "$slice_group" "$receipt" "$slice_memory" "$slice_cpus" "$@"
