#!/bin/bash

echo "--- データ更新処理を開始します ---"
# 1. Pythonスクリプトを実行してレースデータを更新
python3 scripts/sqlite/export_raceday.py --db "/mnt/c/everydb230/Application Files/EveryDB2.3_2_3_0_0/ecore.db" --latest 4 --publish-latest

# 直前のコマンドが失敗したらスクリプトを停止
if [ $? -ne 0 ]; then
  echo "エラー: データ更新に失敗しました。"
  exit 1
fi
echo "--- データ更新が完了しました ---"
echo ""
echo "--- Git処理を開始します ---"

# 2. 全ての変更をステージング
git add .

# 3. 固定のメッセージでコミット
git commit -m "chore: public/dataを更新"

# 4. 現在のブランチをプッシュ
echo "--- プッシュを開始します ---"
git push origin $(git rev-parse --abbrev-ref HEAD)

# プッシュが失敗した場合のエラー表示
if [ $? -ne 0 ]; then
  echo "エラー: プッシュに失敗しました。ssh-agentが正しく設定されているか確認してください。"
  exit 1
fi

echo "--- 全ての処理が正常に完了しました ---"
