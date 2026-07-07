#!/bin/bash
# On-demand LaTeX build, invoked by POST /api/apps/{id}/run-job (app_id is $1).
# Reads the selected file from the active project's build/target.txt, compiles
# it with tectonic, and writes the verdict to that same project's
# build/status.json. A stray scheduled run with no target is a harmless no-op
# (writes an error status the app ignores).
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
sanitize_run_id() {
  case "$1" in
    *[!A-Za-z0-9_-]* | "" ) printf '%s\n' "legacy" ;;
    * ) printf '%s\n' "$1" ;;
  esac
}
REQUESTED_RUN_ID="${MOBIUS_BUILD_RUN_ID:-${APP_BUILD_RUN_ID:-${3:-}}}"
RUN_IDS=()
if [ -n "$REQUESTED_RUN_ID" ]; then
  RUN_IDS+=("$(sanitize_run_id "$REQUESTED_RUN_ID")")
else
  for target_file in "$STORAGE_DIR"/build/runs/*.target.txt; do
    [ -f "$target_file" ] || continue
    run_id="$(basename "$target_file" .target.txt)"
    run_id="$(sanitize_run_id "$run_id")"
    [ -f "$STORAGE_DIR/build/runs/${run_id}.json" ] && continue
    RUN_IDS+=("$run_id")
  done
  if [ "${#RUN_IDS[@]}" -eq 0 ]; then
    RUN_IDS+=("$(sanitize_run_id "$(cat "$STORAGE_DIR/build/run-id.txt" 2>/dev/null || echo legacy)")")
  fi
fi

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

for run_id in "${RUN_IDS[@]}"; do
  compile_one "$run_id"
done
