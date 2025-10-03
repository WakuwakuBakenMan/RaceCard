#!/usr/bin/env bash
set -euo pipefail

# リポジトリルートへ移動
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# 環境変数を読み込む（EDB_PATH / PG_DSN など）
if [[ -f .env ]]; then
  set -a; . ./.env; set +a
else
  echo "[WARN] .env が見つかりません。環境変数はシェルから引き継ぎます。" >&2
fi

if [[ -n "${EDB_PATH:-}" && -f "$EDB_PATH" ]]; then
  echo "[1/2] 最新4日分をエクスポート（SQLite→data）"
  python3 scripts/sqlite/export_raceday.py --db "$EDB_PATH" --latest 4 --publish-latest
else
  echo "[1/2] 最新4日分をエクスポート（PG→data）"
  npm run -s pg:export -- latest 4
fi

echo "[+] 推奨（EV）を生成（最新4日分）"
# ROI_WIN_MIN / ROI_PLACE_MIN は .env で指定可能
npm run -s reco:latest -- 4 || true

echo "[2/2] public/data へ反映（date1..4.json / reco1..4.json）"
ls -1 public/data/date*.json 2>/dev/null || echo "public/data に date*.json が見つかりません"
tsx scripts/publish-reco-latest.ts || true
ls -1 public/data/reco*.json 2>/dev/null || echo "public/data に reco*.json が見つかりません"

echo "完了"

