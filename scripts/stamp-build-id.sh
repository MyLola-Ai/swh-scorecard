#!/usr/bin/env bash
# Stamps a fresh build id into version.json for the crm and scorecard hosting
# targets, immediately before every deploy (wired as firebase.json's
# "predeploy" hook for both, so this can never be forgotten -- see
# stale-tab guard, functions/nylas.js-adjacent incident 2026-08-05: a
# long-open CRM tab kept running week-old JS across three deploys, silently
# losing a user's writes with no error shown, because nothing told that tab
# a newer version existed).
set -euo pipefail
cd "$(dirname "$0")/.."

BUILD_ID="$(date -u +%Y%m%d%H%M%S)"

for dir in public-crm public-scorecard; do
  printf '{"buildId":"%s"}' "$BUILD_ID" > "$dir/version.json"
  echo "stamped $dir/version.json -> $BUILD_ID"
done
