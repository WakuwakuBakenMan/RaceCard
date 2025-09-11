# 競馬の出馬表サイト（Astro + React）

日本語UIの出馬表サイトです。常に最新4日分のデータのみを表示します。

- 技術: Astro + React + TypeScript + TailwindCSS
- Lint/Format: ESLint + Prettier
- Node: 22
- ルーティング: React Router（SPA）。`/` → `/d/[date]` → `/r/[date]/[track]/[no]`
- データ: `public/data/date1.json`〜`date4.json`（最古→最新）。クライアント側で `cache: 'no-store'` で取得。
- GitHub Pages: `/RaceCard` 配信想定（`astro.config.mjs` の `base` 設定済み）

## 開発

```bash
npm ci
npm run dev
```

- ブラウザで `http://localhost:4321/RaceCard/` を開く（`base` 設定のため）。
- SPA ルーティングの直リンク用に `src/pages/404.astro` を同一アプリで出力しています。

## ビルド/プレビュー

```bash
npm run build
npm run preview
```

## Lint/Format

```bash
npm run lint
npm run format
```

## データの差し替え

- `public/data/date1.json`〜`date4.json` を更新するだけで表示が変わります（トップ、日付ページ、出馬表すべて）。
- JSON 仕様（抜粋）: `src/lib/types.ts` を参照。
- 任意で、`data/csv/*.csv` から `npm run data:build` で JSON を再生成できます。

### DBエクスポート（SQLite → RaceDay JSON）

EveryDB2形式のSQLiteからアプリのJSONを生成できます。

- 事前: SQLite DBファイルを用意（テーブル例: `N_RACE`, `N_UMA_RACE`, `N_KISYU`, `N_CHOKYO`）。
- 実行例:
  - 最新4日ぶんを出力＋公開用にも反映:
    - `npm run db:export -- --db /path/to/everydb2.sqlite --latest 4 --publish-latest`
  - 特定日を指定（複数可）:
    - `npm run db:export -- --db /path/to/everydb2.sqlite --date 20240914 --date 20240915`

出力先:
- 日次JSON: `data/days/YYYY-MM-DD.json`
- 公開用(最新4件): `public/data/date1.json`（最古）〜`date4.json`（最新）

備考:
- 確定データのみ（`DataKubun IN ('5','7')`）。
- 騎手・調教師は `N_KISYU`/`N_CHOKYO` からコード→氏名を解決。
- 競馬場名・馬場状態等はスクリプト内の最小マップで補完（必要に応じて拡張してください）。

## スクレイピング（Playwright 版）

サンプルの Python 実装を参考に、Playwright(Chromium) によるスクレイパーを同梱しています。

- 事前準備（初回のみ）
  - `npm ci`
  - ブラウザの取得: `npx playwright install chromium`
- 近日開催日の一覧保存: `npm run fetch:dates`
- 特定日（YYYYMMDD）のレース一覧保存: `npm run fetch:day -- YYYYMMDD`
- 出馬表＋近走通過→展開スコア生成（単日）: `npm run data:cards:day -- YYYYMMDD`
- 近日分まとめて生成: `npm run data:cards:next`
- 生成した日次JSONを公開用に反映（最新4件）:
  - 基本: `npm run data:publish`
  - 代替: `node scripts/publish-latest.mjs`

出力先:
- レース単位: `data/races/YYYY-MM-DD/<track>/<no>.json`（取得できたものから逐次保存）
- 日次JSON: `data/days/YYYY-MM-DD.json`（全レース揃ったら集約して保存）
- 公開データ: `public/data/date{1..4}.json`（最古→最新）

注意: 対象サイトの利用規約順守、アクセス間隔の遵守、実行環境のネットワーク/ヘッドレスブラウザ準備が必要です。

### 展開バイアス（ロジック概要）

- 近3走の各レース「通過」を解析（`1-2-3-...` 形式）。
- 各馬:
  - 全コーナー4番手以内（All4）: 2回以上=+1.0、1回=+0.5（race加算）
  - 逃げ（1コーナー=1番手）: 2回以上の馬がいれば +1.5、ゼロなら -1.5（race調整）
  - 先行馬（All4>=2）の頭数が2頭以下なら -1.0（race調整）
- `pace_score` がしきい値以下（標準: 4.0）で `pace_mark: "★"` を付与。通過が全く取れない場合は `-3.5`（特殊値）。

### 実行時の環境変数

- `SCRAPER_INTERVAL_MS`: アクセス間隔ミリ秒（既定: 3000）
- `NAV_TIMEOUT_MS`: ページ遷移/待機のタイムアウト（ms、既定: 60000）
- `ONLY_TRACK`: 特定の開催名のみ処理（例: `中山`）
- `ONLY_RACE_NO`: 特定レース番号のみ処理（例: `1`）
- `DEBUG_PROGRESS=1`: 進捗を `data/progress.json` と標準出力に記録
- `DEBUG_PACE=1`: レースごとの通過取得サマリ/pace計算のデバッグログを出力
- `DEBUG_PACE_DETAIL=1`: 各馬ごとの通過件数/タイプまで詳細に出力（冗長）
- `UA`: 任意の User-Agent（指定が無い場合はPC Chrome相当を使用）
- `HEADFUL=1`: ブラウザを表示して実行（確認用）。`HEADFUL_DEVTOOLS=1` でDevToolsを開く
- `HORSE_MAX_WAIT_MS`: 馬ページで通過抽出にかける最大待機時間（ms、既定: 22000）
- `DEBUG_SNAPSHOT=1`: 必要DOMが取れない場合に HTML/スクショを `data/snapshots/` に保存
- `USE_SP_FALLBACK=1`: PC版で通過が取れない時にスマートフォン版(db.sp.netkeiba.com)へ1回だけ切替えて再試行（既定: 無効）

### JSON 例（RaceDay）

```json
{
  "date": "YYYY-MM-DD",
  "meetings": [
    {
      "track": "新潟",
      "kaiji": 3,
      "nichiji": 3,
      "races": [
        {
          "no": 1,
          "name": "レース名",
          "distance_m": 1600,
          "ground": "芝",
          "pace_score": -2.5,
          "pace_mark": "★",
          "horses": [
            {
              "num": 1,
              "draw": 1,
              "name": "馬名",
              "sex": "牡",
              "age": 3,
              "weight": 57,
              "jockey": "騎手",
              "trainer": "厩舎",
              "odds": 3.2,
              "popularity": 1,
              "pace_type": ["A"]
            }
          ]
        }
      ]
    }
  ]
}
```

## GitHub Pages デプロイ

- `main`（または `master`）に push で自動ビルド/デプロイします。
- 初回はリポジトリの Settings → Pages で `GitHub Actions` を選択。

## 注意

- UI/文言は日本語。識別子・設定キーは英語。
- BASE は `/RaceCard` 固定想定。別パスで配信する場合は `astro.config.mjs` の `site`/`base` を調整してください。
- 旧 `scripts/scrape-netkeiba.ts`（Puppeteerベース）は参考サンプルです。実運用は `scripts/netkeiba/*` を利用してください。
