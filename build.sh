#!/bin/bash
# On-demand LaTeX build, invoked by POST /api/apps/{id}/run-job (app_id is $1).
#
# The platform's run-job handler spawns this script with ONLY the app id — it
# binds no query params, so no run id or project id reaches us (a client's
# ?runId=/?projectId= on the POST is silently dropped by FastAPI). We therefore
# discover WHAT to build from the app's own storage: the UI writes
# build/runs/<id>.target.txt (and build/target.txt) immediately before POSTing,
# and each browser tab polls build/runs/<id>.json for its own verdict.
#
# Because every POST spawns a separate build.sh with no run id, two tabs building
# in the same project close together spawn two subprocesses that would otherwise
# scan the same pending runs and invoke tectonic concurrently against the SAME
# per-project tectonic-cache and files/*.pdf. Two coordination steps prevent
# that: (1) an exclusive per-project lock serializes the whole compile so only
# one build.sh touches this project's cache/output at a time, and (2) an atomic
# per-run claim marker means each pending target is compiled exactly once. A trap
# writes a verdict for any run this process claimed but couldn't finish, so a
# polling tab never waits on a run that will never get an answer.
set -uo pipefail
APP_ID="${1:-}"
BASE_STORAGE_DIR="/data/apps/${APP_ID}"
PROJECT_ID="${APP_PROJECT_ID:-${MOBIUS_PROJECT_ID:-${2:-}}}"
project_storage_dir() {
  if [ -z "$1" ] || [ "$1" = "default" ]; then
    printf '%s\n' "$BASE_STORAGE_DIR"
  elif [[ "$1" =~ ^[A-Za-z0-9_-]{1,64}$ ]]; then
    printf '%s/projects/%s\n' "$BASE_STORAGE_DIR" "$1"
  else
    return 1
  fi
}
if ! STORAGE_DIR="$(project_storage_dir "$PROJECT_ID")"; then
  STORAGE_DIR="$BASE_STORAGE_DIR"
fi

# Current platform run-job invokes build.sh with only APP_ID. When no project
# id is passed, pick the newest target file across the default root and project
# subtrees; the UI writes its target immediately before POSTing run-job, so this
# selects the project that requested the build while preserving legacy default
# behavior.
if [ -z "$PROJECT_ID" ]; then
  newest=""
  for candidate in "$BASE_STORAGE_DIR/build/target.txt" "$BASE_STORAGE_DIR"/projects/*/build/target.txt; do
    [ -f "$candidate" ] || continue
    if [ -z "$newest" ] || [ "$candidate" -nt "$newest" ]; then
      newest="$candidate"
    fi
  done
  if [ -n "$newest" ]; then
    STORAGE_DIR="$(dirname "$(dirname "$newest")")"
  fi
fi
mkdir -p "$STORAGE_DIR/build/runs" "$STORAGE_DIR/tectonic-cache"
RUNS_DIR="$STORAGE_DIR/build/runs"

sanitize_run_id() {
  case "$1" in
    *[!A-Za-z0-9_-]* | "" ) printf '%s\n' "legacy" ;;
    * ) printf '%s\n' "$1" ;;
  esac
}

write_status() {  # $1=run_id $2=target $3=status $4=pdf(or empty) $5=log
  # Echo the target this verdict was built FROM ($TARGET, set below). target.txt
  # + status.json are a single shared pair per app, so the app-side poller uses
  # this to ignore a verdict produced by a concurrent build of a DIFFERENT doc
  # (another tab/device) instead of mapping its PDF onto the wrong source.
  python3 - "$3" "$4" "$5" "$2" "$1" "$STORAGE_DIR/build/runs/${1}.json" "$STORAGE_DIR/build/status.json" <<'PY'
import json, sys, datetime
status, pdf, log, target, run_id, run_out, latest_out = sys.argv[1:8]
payload = {
  "status": status,
  "pdf": pdf or None,
  "log": log,
  "target": target or None,
  "run_id": run_id or None,
  "built_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
for out in (run_out, latest_out):
    json.dump(payload, open(out, "w"))
PY
}

compile_one() {
  local run_id="$1"
  local target tex stem src log
  target="$(cat "$STORAGE_DIR/build/runs/${run_id}.target.txt" 2>/dev/null || cat "$STORAGE_DIR/build/target.txt" 2>/dev/null || echo "")"
  if [ -z "$target" ]; then
    write_status "$run_id" "$target" error "" "No build target set."
    return 0
  fi
  tex="${target#files/}"
  # target.txt is app-written but treated as untrusted: reject parent-dir
  # traversal, absolute paths, and a leading dash (which tectonic would read as
  # a flag — argv smuggling), and require a .tex. Subdirectories stay valid.
  case "$tex" in
    -* | */-* | *..* | /*) write_status "$run_id" "$target" error "" "invalid build target"; return 0 ;;
  esac
  case "$tex" in
    *.tex) : ;;
    *) write_status "$run_id" "$target" error "" "build target must be a .tex file"; return 0 ;;
  esac
  stem="${tex%.tex}"
  # Empty-source guard. A file that was never written, truncated, or contains
  # only whitespace makes tectonic fail with a raw "no input" error.
  src="$STORAGE_DIR/files/$tex"
  if [ ! -s "$src" ] || ! grep -q '[^[:space:]]' "$src" 2>/dev/null; then
    write_status "$run_id" "$target" error "" "Nothing to compile — this file is empty."
    return 0
  fi
  log="$(cd "$STORAGE_DIR/files" && TECTONIC_CACHE_DIR="$STORAGE_DIR/tectonic-cache" \
    tectonic --keep-logs --outfmt=pdf -- "$tex" 2>&1)"
  if [ $? -eq 0 ]; then
    write_status "$run_id" "$target" done "files/${stem}.pdf" "$log"
  else
    write_status "$run_id" "$target" error "" "$log"
  fi
}

# Serialize builds for THIS project. Hold an exclusive lock for the whole
# compile so only one build.sh runs tectonic against this project's shared cache
# and files/*.pdf at a time. Prefer flock; fall back to an atomic mkdir lock with
# a stale-age escape when flock is unavailable so a build.sh that died holding it
# can't wedge the project forever.
LOCK_FILE="$STORAGE_DIR/build/.compile.lock"
LOCK_DIR="$STORAGE_DIR/build/.compile.lock.d"
USING_MKDIR_LOCK=0
acquire_lock() {
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$LOCK_FILE" || return 1
    # Wait for a sibling build to finish, then hold the lock for the whole
    # compile; fd 9 closes (releasing it) when this process exits. The wait bound
    # exceeds the app's 120s poll timeout, so a wedged holder degrades to the
    # tab's own timeout rather than a hang.
    flock -w 180 9 || return 1
    return 0
  fi
  local waited=0 age
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    age=$(( $(date +%s) - $(stat -c %Y "$LOCK_DIR" 2>/dev/null || echo 0) ))
    if [ "$age" -ge 300 ]; then rm -rf "$LOCK_DIR" 2>/dev/null; continue; fi
    [ "$waited" -ge 180 ] && return 1
    sleep 1; waited=$((waited + 1))
  done
  USING_MKDIR_LOCK=1
  return 0
}

CLAIMED_RUNS=()
# Guarantee a verdict for every run we CLAIMED, even if we're killed mid-compile,
# so a polling tab never waits out its full timeout on a run that never gets an
# answer. Runs we already finished have a .json and are skipped. Also releases
# the mkdir lock if we used that fallback (flock releases itself on exit).
finalize() {
  local r target
  for r in "${CLAIMED_RUNS[@]:-}"; do
    [ -n "$r" ] || continue
    [ -e "$RUNS_DIR/${r}.json" ] && continue
    target="$(cat "$RUNS_DIR/${r}.target.txt" 2>/dev/null || cat "$STORAGE_DIR/build/target.txt" 2>/dev/null || echo "")"
    write_status "$r" "$target" error "" "Build was interrupted. Try again."
  done
  [ "$USING_MKDIR_LOCK" = 1 ] && rm -rf "$LOCK_DIR" 2>/dev/null
}
# EXIT covers normal/`exit` paths; route the termination signals through `exit`
# so a killed build.sh (e.g. earlyoom SIGTERM) still runs finalize and leaves a
# verdict instead of orphaning the run. SIGKILL can't be trapped — that case is
# recovered by the next trigger's stale-claim reclaim in claim_run.
trap 'exit 143' TERM
trap 'exit 130' INT
trap 'exit 129' HUP
trap finalize EXIT

# Atomically claim a pending run so a double-trigger compiles each target exactly
# once. Returns 0 if we now own the run, 1 to skip it. We hold the project lock,
# so a claim marker WITHOUT a verdict was left by a build.sh that has since died;
# clear it and take the claim ourselves rather than orphaning the run.
claim_run() {
  local run_id="$1"
  [ -e "$RUNS_DIR/${run_id}.json" ] && return 1
  if ! mkdir "$RUNS_DIR/${run_id}.claimed" 2>/dev/null; then
    [ -e "$RUNS_DIR/${run_id}.json" ] && return 1
    rm -rf "$RUNS_DIR/${run_id}.claimed" 2>/dev/null
    mkdir "$RUNS_DIR/${run_id}.claimed" 2>/dev/null || return 1
  fi
  CLAIMED_RUNS+=("$run_id")
  return 0
}

if ! acquire_lock; then
  # A sibling build held the project lock past our wait (or it's wedged). Exit
  # cleanly: our target is still pending, and the sibling — or the user's next
  # build — compiles it, while the polling tab bounds itself with its own
  # timeout. We claimed nothing, so finalize writes no verdict.
  exit 0
fi

# Discover pending runs from the per-run target files the UI wrote before POSTing
# run-job. Compile every currently-pending target under the lock, so whichever
# build.sh runs last still clears anything an earlier one missed.
RUN_IDS=()
for target_file in "$RUNS_DIR"/*.target.txt; do
  [ -f "$target_file" ] || continue
  run_id="$(basename "$target_file" .target.txt)"
  RUN_IDS+=("$(sanitize_run_id "$run_id")")
done
if [ "${#RUN_IDS[@]}" -eq 0 ]; then
  # Legacy state: an older client wrote build/target.txt without a per-run target
  # file. Recompile that single latest target under run id "legacy"; clear any
  # stale legacy verdict/claim first so a repeat build isn't skipped.
  rm -rf "$RUNS_DIR/legacy.json" "$RUNS_DIR/legacy.claimed" 2>/dev/null
  RUN_IDS+=("legacy")
fi

for run_id in "${RUN_IDS[@]}"; do
  claim_run "$run_id" || continue
  compile_one "$run_id"
done
