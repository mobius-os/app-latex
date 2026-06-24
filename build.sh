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
mkdir -p "$STORAGE_DIR/build" "$STORAGE_DIR/tectonic-cache"
TARGET="$(cat "$STORAGE_DIR/build/target.txt" 2>/dev/null || echo "")"
write_status() {  # $1=status $2=pdf(or empty) $3=log
  # Echo the target this verdict was built FROM ($TARGET, set below). target.txt
  # + status.json are a single shared pair per app, so the app-side poller uses
  # this to ignore a verdict produced by a concurrent build of a DIFFERENT doc
  # (another tab/device) instead of mapping its PDF onto the wrong source.
  python3 - "$1" "$2" "$3" "$TARGET" "$STORAGE_DIR/build/status.json" <<'PY'
import json, sys, datetime
status, pdf, log, target, out = sys.argv[1:6]
json.dump({
  "status": status,
  "pdf": pdf or None,
  "log": log,
  "target": target or None,
  "built_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
}, open(out, "w"))
PY
}
if [ -z "$TARGET" ]; then
  write_status error "" "No build target set."
  exit 0
fi
TEX="${TARGET#files/}"
# target.txt is app-written but treated as untrusted: reject parent-dir
# traversal, absolute paths, and a leading dash (which tectonic would read as a
# flag — argv smuggling), and require a .tex. Subdirectories (files/sub/x.tex)
# stay valid. The `--` below ends option parsing as belt-and-suspenders.
case "$TEX" in
  -* | */-* | *..* | /*) write_status error "" "invalid build target"; exit 0 ;;
esac
case "$TEX" in
  *.tex) : ;;
  *) write_status error "" "build target must be a .tex file"; exit 0 ;;
esac
STEM="${TEX%.tex}"
# Empty-source guard. A file that was never written, truncated, or contains only
# whitespace makes tectonic fail with a raw "no input" error that the app
# surfaces as an opaque "can't preview". Catch it here and write a friendly
# status BEFORE invoking tectonic. The path checks above already guarantee $TEX
# is traversal-free, so resolving it under files/ is safe.
SRC="$STORAGE_DIR/files/$TEX"
if [ ! -s "$SRC" ] || ! grep -q '[^[:space:]]' "$SRC" 2>/dev/null; then
  write_status error "" "Nothing to compile — this file is empty."
  exit 0
fi
LOG="$(cd "$STORAGE_DIR/files" && TECTONIC_CACHE_DIR="$STORAGE_DIR/tectonic-cache" \
  tectonic --keep-logs --outfmt=pdf -- "$TEX" 2>&1)"
if [ $? -eq 0 ]; then
  write_status done "files/${STEM}.pdf" "$LOG"
else
  write_status error "" "$LOG"
fi
