#!/usr/bin/env bash
set -euo pipefail
: "${PROJECT_ROOT:?PROJECT_ROOT is required}"
: "${PROJECT_SOURCE:?PROJECT_SOURCE is required}"
: "${PROJECT_OUTPUT_DIR:?PROJECT_OUTPUT_DIR is required}"
mkdir -p "$PROJECT_OUTPUT_DIR" /data/.cache/tectonic
export TECTONIC_CACHE_DIR="${TECTONIC_CACHE_DIR:-/data/.cache/tectonic}"
cd "$PROJECT_ROOT"
tectonic "$PROJECT_SOURCE" --outdir "$PROJECT_OUTPUT_DIR"
