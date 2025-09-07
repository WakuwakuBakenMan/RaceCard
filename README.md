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
            { "num": 1, "draw": 1, "name": "馬名", "sex": "牡", "age": 3, "weight": 57, "jockey": "騎手", "trainer": "厩舎", "odds": 3.2, "popularity": 1, "pace_type": ["A"] }
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
