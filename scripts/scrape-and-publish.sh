#!/usr/bin/env bash
set -euo pipefail

# Scrape a specific day from netkeiba, publish to public/data, and commit+push.
# Usage:
#   bash scripts/scrape-and-publish.sh YYYYMMDD
# Env (optional):
#   ONLY_TRACK=中山           # Limit to a specific track
#   ONLY_RACE_NO=1           # Limit to a specific race no
#   HORSE_TABLES_MIN=3       # Min tables to consider page ready (default 3)
#   READY_POLL_MS=1000       # Polling interval in ms (default 1000)
#   HORSE_INTERVAL_MS=1500   # Delay between horse pages (default 1500)
#   SCRAPER_INTERVAL_MS=3000 # Delay between races (default 3000)
#   HORSE_MAX_WAIT_MS=22000  # Max wait for horse pages (default 22000)
#   DEBUG_PACE=0/1           # Optional debug logs
#   DEBUG_PACE_ALL=0/1       # Optional per-horse logs
#   DEBUG_PROGRESS=0/1       # Optional progress logs
#   DEBUG_SNAPSHOT=0/1       # Optional HTML/PNG snapshots on failure
#   NO_PUSH=1                # If set, skip git push

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 YYYYMMDD" >&2
  exit 1
fi

YMD="$1"

# Defaults (allow override from env)
: "${HORSE_TABLES_MIN:=3}"
: "${READY_POLL_MS:=1000}"
: "${HORSE_INTERVAL_MS:=1500}"
: "${SCRAPER_INTERVAL_MS:=3000}"
: "${HORSE_MAX_WAIT_MS:=22000}"
: "${DEBUG_PACE:=0}"
: "${DEBUG_PACE_ALL:=0}"
: "${DEBUG_PROGRESS:=0}"
: "${DEBUG_SNAPSHOT:=0}"

echo "[scrape] date=$YMD track=${ONLY_TRACK:-ALL} race=${ONLY_RACE_NO:-ALL}"

# 1) Run scraper for the specified day
HORSE_TABLES_MIN="$HORSE_TABLES_MIN" \
READY_POLL_MS="$READY_POLL_MS" \
HORSE_INTERVAL_MS="$HORSE_INTERVAL_MS" \
SCRAPER_INTERVAL_MS="$SCRAPER_INTERVAL_MS" \
HORSE_MAX_WAIT_MS="$HORSE_MAX_WAIT_MS" \
DEBUG_PACE="$DEBUG_PACE" \
DEBUG_PACE_ALL="$DEBUG_PACE_ALL" \
DEBUG_PROGRESS="$DEBUG_PROGRESS" \
DEBUG_SNAPSHOT="$DEBUG_SNAPSHOT" \
ONLY_TRACK="${ONLY_TRACK:-}" \
ONLY_RACE_NO="${ONLY_RACE_NO:-}" \
npm run -s data:cards:day -- "$YMD"

# 2) Publish latest 4 days to public/data/date{1..4}.json
node scripts/publish-latest.mjs

# 3) Commit public data and push
if ! git diff --quiet -- public/data; then
  ISO="${YMD:0:4}-${YMD:4:2}-${YMD:6:2}"
  git add public/data/date*.json
  git commit -m "data: publish ${ISO} (scraped from ${YMD})"
  if [[ "${NO_PUSH:-0}" != "1" ]]; then
    branch="$(git rev-parse --abbrev-ref HEAD)"
    echo "[git] pushing to origin ${branch}"
    git push origin "$branch"
  else
    echo "[git] NO_PUSH=1 set; skip pushing"
  fi
else
  echo "[git] No changes under public/data to commit"
fi

echo "Done."

