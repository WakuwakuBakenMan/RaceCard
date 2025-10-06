#!/bin/bash
set -euo pipefail

# nvm を使っている場合はこれを必ず先に読む
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
# 固定したい Node があれば有効化（任意）
# nvm use --silent 20

cd /home/kokob/codex/RaceCard
/usr/bin/flock -n /tmp/racecard-export.lock npm run -s data:update:push >> /home/kokob/codex/RaceCard/logs/cron_export.log 2>&1

