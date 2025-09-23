import { DATE_FILES, dataUrl } from '@/lib/dataConfig';
import type { RaceDay } from '@/lib/types';

// fetch オプション（常に最新を読みに行く）
const fetchOpts: RequestInit = { cache: 'no-store' };

export async function loadAllDays(): Promise<RaceDay[]> {
  const results: RaceDay[] = [];
  const isDev = (import.meta as any).env?.DEV;
  for (const f of DATE_FILES) {
    try {
      const url = dataUrl(f);
      if (isDev) console.debug('[loadAllDays] fetching', url);
      const res = await fetch(url, fetchOpts);
      if (!res.ok) continue;
      const json = (await res.json()) as RaceDay;
      if (json && typeof json.date === 'string') results.push(json);
      if (isDev) console.debug('[loadAllDays] loaded', json?.date);
    } catch {
      // 存在しない/壊れているファイルはスキップ
      if (isDev) console.warn('[loadAllDays] failed to load', f);
    }
  }
  if (isDev) console.debug('[loadAllDays] total days', results.map((d) => d.date));
  return results;
}

export async function loadDayByDate(
  date: string
): Promise<RaceDay | undefined> {
  const days = await loadAllDays();
  return days.find((d) => d.date === date);
}

export type RaceReco = { track: string; no: number; win?: number[]; place?: number[]; quinella_box?: number[]; notes?: string[] };
export type DayReco = { date: string; races: RaceReco[] };

export async function loadRecoByDate(date: string): Promise<DayReco | undefined> {
  try {
    const url = dataUrl(`reco-${date}.json`);
    const res = await fetch(url, fetchOpts);
    if (!res.ok) return undefined;
    return (await res.json()) as DayReco;
  } catch { return undefined; }
}
