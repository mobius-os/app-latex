#!/bin/bash
# On-demand LaTeX build, invoked by POST /api/apps/{id}/run-job (app_id is $1).
# Reads the selected file from build/target.txt, compiles it with tectonic,
# and writes the verdict to build/status.json. A stray scheduled run with no
# target is a harmless no-op (writes an error status the app ignores).
set -uo pipefail
APP_ID="${1:-}"
STORAGE_DIR="/data/apps/${APP_ID}"
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
LOG="$(cd "$STORAGE_DIR/files" && TECTONIC_CACHE_DIR="$STORAGE_DIR/tectonic-cache" \
  tectonic --keep-logs --outfmt=pdf -- "$TEX" 2>&1)"
if [ $? -eq 0 ]; then
  write_status done "files/${STEM}.pdf" "$LOG"
else
  write_status error "" "$LOG"
fi
