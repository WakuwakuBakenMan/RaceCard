#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# 1) Export latest 4 days and publish to public/data
bash scripts/run-export-latest4.sh

# 2) Prepare git identity if missing
if ! git config user.name >/dev/null; then
  git config user.name "automation"
fi
if ! git config user.email >/dev/null; then
  git config user.email "automation@local"
fi

# 3) Stage outputs
git add public/data/date*.json || true
git add public/data/reco*.json || true

# 3.1) Remove old per-day reco files in public (now deprecated)
if compgen -G "public/data/reco-*.json" > /dev/null; then
  git rm -f public/data/reco-*.json || true
fi

# Optionally include data snapshots (ignored by .gitignore). Enable via COMMIT_DAYS=1
if [[ "${COMMIT_DAYS:-0}" == "1" ]]; then
  git add -f data/days/*.json || true
  git add -f data/races/*/*.json || true
fi

# 4) Commit if there are changes
if git diff --cached --quiet; then
  echo "No changes to commit."
  exit 0
fi

git commit -m "データ更新"

# 5) Rebase onto remote and push
default_remote="$(git remote 2>/dev/null | head -n1 || true)"
remote="${GIT_REMOTE:-$default_remote}"
branch="${GIT_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"

if [[ -n "$remote" ]]; then
  git pull --rebase "$remote" "$branch" || true
  git push "$remote" "$branch"
else
  # Fallback: simple push without explicit remote (uses upstream if set)
  git pull --rebase || true
  git push
fi

echo "Pushed updates to ${remote:-upstream-default}/${branch}"

