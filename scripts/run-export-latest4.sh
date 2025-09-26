#!/usr/bin/env bash
set -euo pipefail

# リポジトリルートへ移動
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -f .env ]]; then
  echo "[ERROR] .env がありません。PG_DSN を設定してください (.env.example を参照)。" >&2
  exit 1
fi

echo "[1/2] 最新4日分をエクスポート（PG→data）"
npm run -s pg:export -- latest 4

echo "[+] 推奨（EV）を生成（最新4日分）"
# ROI_WIN_MIN / ROI_PLACE_MIN は .env で指定可能
npm run -s reco:latest -- 4 || true

echo "[2/2] public/data へ反映（date1..4.json）"
ls -1 public/data/date*.json 2>/dev/null || echo "public/data に date*.json が見つかりません"

echo "完了"

