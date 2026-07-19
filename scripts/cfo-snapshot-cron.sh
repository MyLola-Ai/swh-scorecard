#!/bin/bash
# CFO revenue snapshot runner — invoked by launchd (see LaunchAgents
# com.swh.cfo-snapshot-monthly/-weekly). Writes a dated report into
# docs/finance/ and pushes it; the CFO thread reads the repo.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
cd "$(dirname "$0")/.."
MODE="${1:-monthly}"
STAMP="$(date +%Y-%m-%d)"
OUT="docs/finance/${STAMP}-${MODE}-snapshot.md"
if [ "$MODE" = "weekly" ]; then
  node scripts/cfo-revenue-snapshot.mjs --weekly > "$OUT"
else
  node scripts/cfo-revenue-snapshot.mjs > "$OUT"
fi
git add "$OUT"
git commit -m "finance: ${MODE} revenue snapshot ${STAMP} (automated)" --no-verify || exit 0
git push --quiet || true
