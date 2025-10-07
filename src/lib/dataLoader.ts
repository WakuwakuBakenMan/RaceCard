import { DATE_FILES, RECO_FILES, dataUrl } from '@/lib/dataConfig';
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
      if (!json || typeof json.date !== 'string') continue;
      // meetings の簡易バリデーション/ガード
      const meetings = Array.isArray(json.meetings)
        ? json.meetings.filter((m) => m && Array.isArray((m as any).races) && (m as any).races.length > 0)
        : [];
      if (meetings.length === 0) {
        if (isDev) console.warn('[loadAllDays] skip due to empty meetings', json.date);
        continue;
      }
      results.push({ ...json, meetings });
      if (isDev) console.debug('[loadAllDays] loaded', json?.date);
    } catch {
      // 存在しない/壊れているファイルはスキップ
      if (isDev) console.warn('[loadAllDays] failed to load', f);
    }
  }
  // 重複日付の除去（最後に現れたものを優先）
  const map = new Map<string, RaceDay>();
  for (const d of results) map.set(d.date, d);
  const deduped = Array.from(map.values()).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (isDev) console.debug('[loadAllDays] total days', deduped.map((d) => d.date));
  return deduped;
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
    // 新運用: public には reco1..4.json のみ。日付指定は data/days の日次ファイルが存在しないため、最新4から一致する日付を探す。
    const latest = await loadLatestReco();
    return latest.find((d) => d.date === date);
  } catch { return undefined; }
}

export async function loadLatestReco(): Promise<DayReco[]> {
  const results: DayReco[] = [];
  const isDev = (import.meta as any).env?.DEV;
  for (const f of RECO_FILES) {
    try {
      const url = dataUrl(f);
      if (isDev) console.debug('[loadLatestReco] fetching', url);
      const res = await fetch(url, fetchOpts);
      if (!res.ok) continue;
      const json = (await res.json()) as DayReco;
      if (json && typeof json.date === 'string') results.push(json);
      if (isDev) console.debug('[loadLatestReco] loaded', json?.date);
    } catch {
      if (isDev) console.warn('[loadLatestReco] failed to load', f);
    }
  }
  return results;
}
