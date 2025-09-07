// データURL設定。GitHub Pagesの base (/RaceCard) に対応。
export const DATE_FILES = [
  'date1.json',
  'date2.json',
  'date3.json',
  'date4.json',
] as const;

/**
 * public/data 以下の相対URLを組み立てる。
 * `import.meta.env.BASE_URL` を考慮して、/RaceCard でも動作。
 */
export function dataUrl(file: string): string {
  const base = (import.meta as any).env?.BASE_URL || '/';
  // BASE_URL は常にスラッシュで始まり終わる（例: "/RaceCard/")
  const normalized = base.endsWith('/') ? base : base + '/';
  return `${normalized}data/${file}`;
}
