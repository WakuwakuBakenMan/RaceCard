import { chromium } from 'playwright';
import { clusterByAdjacentDays, isFutureJST, toIso, weekdayJST } from './lib/date';

export type UpcomingDate = { yyyymmdd: string; iso: string };

const CAL_URL = 'https://race.netkeiba.com/top/calendar.html';

function pickClusterDays(cluster: string[]): string[] {
  // 通常は土日2日、隣接する金 or 月 or 火があればそれも追加（最大3日）
  const s = new Set(cluster);
  const has = (ymd: string) => s.has(ymd);
  const weekend = cluster.filter((d) => [0, 6].includes(weekdayJST(d))); // Sun(0), Sat(6)
  if (weekend.length >= 2) {
    // 週末2日ベース
    const days = [...weekend].sort();
    const sat = days.find((d) => weekdayJST(d) === 6);
    const sun = days.find((d) => weekdayJST(d) === 0);
    if (sat && sun) {
      // Fri 追加の三連休
      const fri = dayShift(sat, -1);
      if (has(fri)) return [fri, sat, sun];
      // Mon 追加の三連休
      const mon = dayShift(sun, +1);
      if (has(mon)) return [sat, sun, mon];
      // Tue（まれ）
      const tue = dayShift(sun, +2);
      if (has(tue)) return [sat, sun, tue];
    }
    return days.slice(0, 2).sort();
  } else {
    // 週末2日揃っていない場合は、そのクラスター内の最大3日（安全側）
    return cluster.slice(0, 3);
  }
}

function dayShift(yyyymmdd: string, delta: number): string {
  const yyyy = Number(yyyymmdd.slice(0, 4));
  const mm = Number(yyyymmdd.slice(4, 6));
  const dd = Number(yyyymmdd.slice(6, 8));
  const d = new Date(Date.UTC(yyyy, mm - 1, dd));
  d.setUTCDate(d.getUTCDate() + delta);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

export async function getUpcomingDates(nowJST: Date = new Date()): Promise<UpcomingDate[]> {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.goto(CAL_URL, { waitUntil: 'domcontentloaded' });
  const ymdsArr = await page.$$eval('a[href*="kaisai_date="]', (as) => {
    const set = new Set<string>();
    for (const a of as as HTMLAnchorElement[]) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/kaisai_date=(\d{8})/);
      if (m) set.add(m[1]);
    }
    return Array.from(set);
  });
  await browser.close();
  const ymds = new Set<string>(ymdsArr);

  // 未来日のみ
  const future = [...ymds].filter((d) => isFutureJST(d, nowJST)).sort();
  if (future.length === 0) return [];

  // 隣接でクラスタ化し、直近クラスタを選ぶ
  const clusters = clusterByAdjacentDays(future);
  const nearest = clusters[0];
  if (!nearest) return [];
  const picked = pickClusterDays(nearest).sort();

  return picked.map((d) => ({ yyyymmdd: d, iso: toIso(d) }));
}
