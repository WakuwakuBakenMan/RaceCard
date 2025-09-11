# EDB(SQLite) 版データ取得 仕様まとめ

本プロジェクトをスクレイピング(Playwright)からSQLite(EveryDB)参照へ段階的に置き換えるための要点と要件定義。

参考: データフォーマット仕様 https://everydb.iwinz.net/edb2_manual/

## 目的 / スコープ

- 目的: 出馬表・近走「通過」データを EveryDB(SQLite) から取得し、現行の展開判定/pace_score 計算と公開フローを維持する。
- スコープ:
  - 取得元を DB に変更（スクレイピングを不要化）。
  - Race/Meeting/RaceDay JSON の構造は現行を踏襲（フロント改修不要）。
  - 公開フロー（`public/data/date{1..4}.json` 生成）も現行を使用。
- 非スコープ:
  - フロントの機能変更（UIは最小限）。
  - EveryDB 自体の整備や取得元の変更。

## 設定 / 実行環境

- DB ファイルパス: 環境変数 `EDB_PATH` で指定（例: `/data/edb/everydb.sqlite`）。
- ライブラリ: `better-sqlite3`（同期・高速・導入容易）。
- Node/TS: 既存と同一（TS で実装）。
- データ公開: 既存の `scripts/publish-latest.mjs` を利用。

## 出力データ（そのまま維持）

- RaceDay JSON（`data/days/YYYY-MM-DD.json`）:
  - `date: YYYY-MM-DD`
  - `meetings: { track, kaiji, nichiji, races[] }[]`
- レース単位 JSON（`data/races/YYYY-MM-DD/<track>/<no>.json`）
  - `race: { no, name, distance_m, ground, course_note?, condition?, start_time?, pace_score?, pace_mark?, horses[] }`
  - `horses[]: { num, draw, name, sex, age, weight, jockey, trainer, pace_type? }`
- 公開: `public/data/date{1..4}.json`（最古→最新）。

## ロジック（現行踏襲）

- 展開タイプ（A/B/C 判定）:
  - A: 逃げ（通過の先頭が1）回数が2回以上。
  - B: 全コーナー4番手以内が2回以上。
  - C: 全コーナー4番手以内が1回。
  - 判定は近走3件（対象日より前）から。
- pace_score 算出（`computePaceScore` 現行維持）:
  - All4>=2: +1.0、All4==1: +0.5 を各馬で加算。
  - 逃げ馬数が0なら -1.5、2頭以上なら +1.5（レース調整）。
  - All4>=2 の馬が2頭以下なら -1.0（レース調整）。
  - pace_mark: しきい値 4.0 以下かつ -3.5 以外で "★"。

## DB→ドメイン マッピング（想定）

EveryDB スキーマに依存するため、以下は対応関係の合意ポイント。

- レース一覧（開催日=YYYYMMDD 指定）
  - 取得項目: `track(場名) / kaiji / nichiji / race_no / race_name / distance_m / ground(芝|ダート|障害) / course_note? / condition? / start_time? / race_id?`
  - トラック表記: 現行の日本語名（例: "中山"）。コード→名称の対応が必要ならテーブル/辞書で吸収。
- 出走表（各レース）
  - 取得項目: `num(馬番) / draw(枠) / horse_id / name / sex / age / weight(斤量) / jockey / trainer`
  - 空欄は空文字/0で補完。
- 近走通過（各馬、対象日より前の最新3件）
  - 形式: 例 "1-2-3-4"（コーナー別列なら結合して作成）。
  - 絞り込み: `date < target` かつ `LIMIT 3`（降順）。

テーブル・カラム名の最終確定は EveryDB の仕様に合わせる（不足があれば reader 側でJOIN/加工）。

## 実装構成（提案）

- 追加: `scripts/edb/reader.ts`
  - `openDb(EDB_PATH)` / `close`
  - `getMeetingsByDate(yyyymmdd): { track, kaiji, nichiji, races[] }[]`
  - `getRaceCard(raceId|track+no+date): { race, horses, _horseIds }`
  - `getHorsePassagesBefore(horseId, yyyymmdd): string[]`
  - 内部クエリは `better-sqlite3` のプリペアドで同期実行。
- 既存差し替え: `scripts/netkeiba/build-cards.ts`
  - データ取得部を reader 経由に置換。
  - 切替環境変数: `DATA_SOURCE=db|scrape`（既定は db に移行予定）。
  - 進捗/ログ/公開の流れは現行を再利用。

## 代表クエリ（雛形）

SQL 名称は仮。実スキーマに応じて調整。

- 開催日→レース一覧
  - `SELECT ... FROM races WHERE date = ? ORDER BY track, race_no`
- レース→出走馬
  - `SELECT ... FROM entries WHERE race_id = ? ORDER BY num`
- 馬→近走通過（対象日より前から3件）
  - `SELECT passage FROM results WHERE horse_id = ? AND date < ? ORDER BY date DESC LIMIT 3`
  - passage が無い場合: `corner_1, corner_2, ...` を `CAST`→文字列で "-" 結合。

## 設定・運用

- 環境変数:
  - `EDB_PATH`: SQLite ファイルのパス（必須）。
  - `DATA_SOURCE=db`（切替用。初期導入時は既定値を db にしておく）。
  - 既存デバッグ系（`DEBUG_PACE`, `DEBUG_PROGRESS` など）は引き続き有効。
- 生成/公開コマンド:
  - 単日: `npm run data:cards:day -- YYYYMMDD`
  - 近日: `npm run data:cards:next`
  - 公開: `node scripts/publish-latest.mjs`

## 性能 / 安定性

- better-sqlite3 による同期クエリで低レイテンシ。
- インデックス確認（必要に応じて）：`results(horse_id, date)`, `races(date, track, race_no)` など。
- ネットワーク不要・リトライ不要（DBアクセス失敗時のみ再試行/メッセージ）。

## エラーハンドリング / ログ

- 取得できない/空のケースは空配列で処理（現行と同様に pace_score=-3.5 へフォールバック）。
- 重要イベントのみ標準出力 + `data/logs/YYYY-MM-DD.log`（現行のログ設計を踏襲）。

## 段階導入計画（提案）

1) `reader.ts` の最小実装（1開催日・1レースでの疎通）
2) 出走馬/近走通過の整合確認（3頭×3件でA/B/C/pace_scoreが現行と一致）
3) `build-cards.ts` のデータ取得差し替え（`DATA_SOURCE=db`）
4) 近日自動更新シェルでの通し確認（2〜3日）
5) スクレイピングコードは切替完了後に整理

## 未確定事項 / 要確認

- EveryDB の実テーブル・カラム名（race/entry/result の対応）
- 場コード→日本語名称の確定方法
- `kaiji`/`nichiji` の算出 or 取得元（DB内にあるか）
- passage の持ち方（1列文字列 or コーナー別）

以上。

