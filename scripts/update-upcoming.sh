#!/usr/bin/env bash
set -euo pipefail

# Update next 2–3 race days in one command.
# 1) Fetch upcoming dates to data/scraped/next_dates.json
# 2) Scrape cards for the first N days (default: 3)
# 3) Publish to public/data/date{1..4}.json
# 4) Commit and (optionally) push
#
# Usage:
#   bash scripts/update-upcoming.sh [DAYS]
# Env (optional):
#   NEXT_DAYS=3               # If DAYS arg is omitted
#   ONLY_TRACK=中山           # Limit track
#   HORSE_TABLES_MIN=3        # Page readiness threshold
#   READY_POLL_MS=1000        # Poll interval
#   HORSE_INTERVAL_MS=1500    # Delay between horse pages
#   SCRAPER_INTERVAL_MS=3000  # Delay between races
#   HORSE_MAX_WAIT_MS=22000   # Max wait per horse page
#   DEBUG_PACE=0/1            # Logs
#   DEBUG_PACE_ALL=0/1        # Logs (per-horse)
#   DEBUG_PROGRESS=0/1        # Logs
#   DEBUG_SNAPSHOT=0/1        # Save page/html/png on failure
#   NO_PUSH=1                 # Skip git push

ARG_DAYS="${1:-}"

echo "[next] fetching upcoming dates…"
npm run -s fetch:dates

NEXT_FILE="$(pwd)/data/scraped/next_dates.json"
if [[ ! -f "$NEXT_FILE" ]]; then
  echo "next_dates.json not found: $NEXT_FILE" >&2
  exit 1
fi

echo "[next] reading upcoming dates from $NEXT_FILE"
mapfile -t ALL_DATES < <(node - <<'NODE'
const fs=require('fs');
const p=process.argv[1];
const j=JSON.parse(fs.readFileSync(p,'utf8'));
const arr=(j.dates||[]).map(x=>x.yyyymmdd).filter(Boolean);
for (const d of arr) console.log(d);
NODE
"$NEXT_FILE")

# Decide N_DAYS: if provided as arg, honor it; otherwise derive 2 or 3 from contiguous block
if [[ -n "$ARG_DAYS" ]]; then
  N_DAYS="$ARG_DAYS"
else
  N_DAYS=$(node - <<'NODE'
function ymdToDate(s){
  return new Date(Number(s.slice(0,4)), Number(s.slice(4,6))-1, Number(s.slice(6,8)));
}
function addDays(d,n){ const x=new Date(d); x.setDate(d.getDate()+n); return x; }
function toYmd(d){ const y=d.getFullYear(); const m=String(d.getMonth()+1).padStart(2,'0'); const dd=String(d.getDate()).padStart(2,'0'); return `${y}${m}${dd}`; }
const dates = (process.argv[1]||'').split(',').filter(Boolean);
if (dates.length===0){ console.log('2'); process.exit(0); }
const first = dates[0];
let want = [first];
for (let i=1;i<dates.length && want.length<3;i++){
  const prev = ymdToDate(want[want.length-1]);
  const expected = toYmd(addDays(prev,1));
  if (dates[i]===expected) want.push(dates[i]); else break;
}
const result = want.length===1 && dates.length>=2 ? 2 : want.length; // prefer 2 if only single-day contiguous but multiple exist
console.log(String(result));
NODE
"${ALL_DATES[*]// /,}")
fi

if ! [[ "$N_DAYS" =~ ^[0-9]+$ ]] || [[ "$N_DAYS" -le 0 ]]; then
  echo "Invalid DAYS: $N_DAYS" >&2; exit 1
fi

echo "[next] will scrape ${N_DAYS} day(s) based on upcoming schedule"

# Slice the dates to the decided count
mapfile -t DATES < <(printf '%s\n' "${ALL_DATES[@]}" | head -n "$N_DAYS")

if [[ ${#DATES[@]} -eq 0 ]]; then
  echo "[next] no upcoming dates found" >&2
  exit 0
fi

echo "[scrape] target dates: ${DATES[*]}"
for YMD in "${DATES[@]}"; do
  echo "[scrape] date=$YMD track=${ONLY_TRACK:-ALL}"
  HORSE_TABLES_MIN="${HORSE_TABLES_MIN:-3}" \
  READY_POLL_MS="${READY_POLL_MS:-1000}" \
  HORSE_INTERVAL_MS="${HORSE_INTERVAL_MS:-1500}" \
  SCRAPER_INTERVAL_MS="${SCRAPER_INTERVAL_MS:-3000}" \
  HORSE_MAX_WAIT_MS="${HORSE_MAX_WAIT_MS:-22000}" \
  DEBUG_PACE="${DEBUG_PACE:-0}" \
  DEBUG_PACE_ALL="${DEBUG_PACE_ALL:-0}" \
  DEBUG_PROGRESS="${DEBUG_PROGRESS:-0}" \
  DEBUG_SNAPSHOT="${DEBUG_SNAPSHOT:-0}" \
  ONLY_TRACK="${ONLY_TRACK:-}" \
  npm run -s data:cards:day -- "$YMD"
done

echo "[publish] copying latest 4 days to public/data/"
node scripts/publish-latest.mjs

if ! git diff --quiet -- public/data; then
  MSG="data: publish next ${N_DAYS} day(s): ${DATES[*]}"
  git add public/data/date*.json
  git commit -m "$MSG"
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
