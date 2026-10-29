#!/usr/bin/env bash
set -euo pipefail
: "${PROJECT_ROOT:?PROJECT_ROOT is required}"
: "${PROJECT_SOURCE:?PROJECT_SOURCE is required}"
: "${PROJECT_OUTPUT_DIR:?PROJECT_OUTPUT_DIR is required}"
mkdir -p "$PROJECT_OUTPUT_DIR"
# Share one package cache on the persistent volume when this build may write
# there; otherwise Tectonic keeps its default per-user cache.
SHARED_CACHE=/data/.cache/tectonic
if [ -z "${TECTONIC_CACHE_DIR:-}" ] && mkdir -p "$SHARED_CACHE" 2>/dev/null && [ -w "$SHARED_CACHE" ]; then
  export TECTONIC_CACHE_DIR="$SHARED_CACHE"
fi
cd "$PROJECT_ROOT"
tectonic "$PROJECT_SOURCE" --outdir "$PROJECT_OUTPUT_DIR"
