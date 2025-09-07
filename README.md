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

## スクレイピング（netkeiba 参考）

サンプルの `sample/Scraping.py` と `sample/PlaceOnBias.py` を参考に、Node/TypeScript 版の簡易スクレイパーを用意しました。

- コマンド: `npm run data:scrape -- --date YYYYMMDD`
- 期間指定: `npm run data:scrape -- --from YYYYMMDD --to YYYYMMDD`
- 生成物: 取得した日付の `RaceDay` を既存データとマージし、最新4件を `public/data/date{1..4}.json` に出力します（古→新）。

注意: 対象サイトの利用規約順守、適切なアクセス間隔、実行環境のネットワーク/ヘッドレスブラウザの準備が必要です。初回は `npm i` で Puppeteer を取得してください。

### 展開バイアス（簡易実装の概要）

Python サンプルのロジックに準拠しています。

- 近3走のうち各レースの「通過」を解析（通過順を `1-2-3-...` 形式で取得）。
- 各馬について:
  - 全コーナーが4番手以内ならカウント（All4）。
  - 1コーナーが1番手なら逃げカウント（Nige）。
- レース全体のスコア（PlcOnCnt 相当）を算出:
  - All4が2回以上: +1.0、1回: +0.5
  - Nigeが2回以上: +1.5、0回: -1.5
  - 先行馬（All4>=2）が少ない（<=2頭）: さらに -1.0
- バイアス判定（★）は距離でしきい値を変更:
  - 1600m以下: スコア <= 4.0 をバイアス
  - 1600m超: スコア <= 3.0 をバイアス
  - 特別値 -2.5 は「無効」扱い（未使用）。

実装: `scripts/scrape-netkeiba.ts`

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
-
