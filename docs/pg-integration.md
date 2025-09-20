# PostgreSQL Integration (PC-KEIBA schema)

目的: PC-KEIBA（public スキーマ）の `jvd_ra`/`jvd_se`/`jvd_um` から RaceDay(JSON) を生成し、フロントが参照する `public/data/date{1..4}.json` を更新する。

## 使い方

前提: PostgreSQL に接続可能、スキーマは `public`。

```
# 単日（生成 + 公開）
PG_DSN="postgres://pckeiba:Change_Me_Please@localhost:5432/pckeiba?sslmode=disable" \
npm run pg:export -- day 20240915 --publish-latest

# DB内の最新N日（生成のみ）
PG_DSN=... npm run pg:export -- latest 4

# DSNを引数で渡すことも可能
npm run pg:export -- day 20240915 --dsn "postgres://..."
```

出力:
- 日次: `data/days/YYYY-MM-DD.json`
- レース単位（参考）: `data/races/YYYY-MM-DD/<track>/<no>.json`
- 公開（最新4件）: `public/data/date1.json`（最古）〜`date4.json`（最新）

## マッピング概要

- Meeting
  - `track`: `jvd_ra.keibajo_code` → JRA名称（01..10）。
  - `kaiji`: `jvd_ra.kaisai_kai` 数値化
  - `nichiji`: `jvd_ra.kaisai_nichime` 数値化
- Race
  - `no`: `jvd_ra.race_bango`
  - `name`: `jvd_ra.kyosomei_hondai`
  - `distance_m`: `jvd_ra.kyori`
  - `ground`: `jvd_ra.track_code` → 芝/ダ/障（コード表に準拠）
  - `condition`: `babajotai_code_shiba` or `babajotai_code_dirt`（groundに応じ選択）
  - `start_time`: `jvd_ra.hasso_jikoku` → `HH:mm`
- Horse
  - `num/draw`: `jvd_se.umaban / jvd_se.wakuban`
  - `name`: `jvd_um.bamei`（JOIN）
  - `sex`: `jvd_um.seibetsu_code` → 牡/牝/セ
  - `age`: `kaisai_nen - seinengappi(YYYY)` の簡易計算
  - `weight`: `jvd_se.futan_juryo`
  - `jockey/trainer`: `jvd_se.kishumei_ryakusho / chokyoshimei_ryakusho`（不足時はコード）
  - `odds/popularity`: `jvd_se.tansho_odds / tansho_ninkijun`
- 展開（pace）
- 近走通過: `jvd_se`（JRA）に加え `nvd_se`（地方）も合算。対象日より前の通過を日付降順で混在ソートし、最大3件採用。
  - A/B/C 付与: 逃げ2回以上=A、全角4以内2回以上=B、同1回=C（Bと排他）。
  - `pace_score`: 既存ロジック（B:+1.0, C:+0.5, 逃げ0:-1.5, 逃げ2+:+1.5, B頭数<=2:-1.0、全無:-3.5）。
  - `pace_mark`: しきい値4.0以下かつ≠-3.5で "★"。

## 環境変数

- `PG_DSN`: PostgreSQL DSN（例: `postgres://user:pass@host:5432/db?sslmode=disable`）

## 注意

- データ欠損時は空/0/undefinedで補完。通過が全く取れないレースは `pace_score=-3.5`。
- 年齢計算は簡易（年差）。必要ならJST基準の満年齢に精密化。
- 大量日付を一括処理する場合は、`jvd_se(ketto_toroku_bango, kaisai_nen, kaisai_tsukihi)` の索引確認を推奨。
