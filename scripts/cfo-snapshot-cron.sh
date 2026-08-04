#!/bin/bash
# CFO revenue snapshot runner — invoked by launchd (see LaunchAgents
# com.swh.cfo-snapshot-monthly/-weekly). Writes a dated report into
# docs/finance/ and pushes it; the CFO thread reads the repo.
#
# Failure handling (2026-08-04): the previous version redirected stdout
# straight to the final dated filename, so a crash (e.g. dead gcloud ADC)
# still left a real, empty, uncommitted file behind with no visible signal
# anywhere but a /tmp stderr log nobody watches. Now: write to a temp file
# first, only promote it to the real filename on success, and on failure
# commit+push a *-FAILED.md marker with the actual error instead of going
# silent.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
cd "$(dirname "$0")/.."
MODE="${1:-monthly}"
STAMP="$(date +%Y-%m-%d)"
OUT="docs/finance/${STAMP}-${MODE}-snapshot.md"
FAILOUT="docs/finance/${STAMP}-${MODE}-snapshot-FAILED.md"
TMP="$(mktemp)"
ERRTMP="$(mktemp)"

if [ "$MODE" = "weekly" ]; then
  ARGS=(--weekly)
else
  ARGS=()
fi

if node scripts/cfo-revenue-snapshot.mjs "${ARGS[@]}" >"$TMP" 2>"$ERRTMP"; then
  mv "$TMP" "$OUT"
  rm -f "$ERRTMP"
  git add "$OUT"
  git commit -m "finance: ${MODE} revenue snapshot ${STAMP} (automated)" --no-verify || exit 0
  git push --quiet || true
else
  {
    echo "# ${MODE} revenue snapshot FAILED — ${STAMP}"
    echo "Generated $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo
    echo '```'
    cat "$ERRTMP"
    echo '```'
  } > "$FAILOUT"
  rm -f "$TMP" "$ERRTMP"
  git add "$FAILOUT"
  git commit -m "finance: ${MODE} revenue snapshot ${STAMP} FAILED (automated)" --no-verify || true
  git push --quiet || true
  exit 1
fi
