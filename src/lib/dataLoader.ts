import { DATE_FILES, dataUrl } from '@/lib/dataConfig';
import type { RaceDay } from '@/lib/types';

// fetch オプション（常に最新を読みに行く）
const fetchOpts: RequestInit = { cache: 'no-store' };

export async function loadAllDays(): Promise<RaceDay[]> {
  const results: RaceDay[] = [];
  for (const f of DATE_FILES) {
    try {
      const res = await fetch(dataUrl(f), fetchOpts);
      if (!res.ok) continue;
      const json = (await res.json()) as RaceDay;
      if (json && typeof json.date === 'string') results.push(json);
    } catch {
      // 存在しない/壊れているファイルはスキップ
    }
  }
  return results;
}

export async function loadDayByDate(date: string): Promise<RaceDay | undefined> {
  const days = await loadAllDays();
  return days.find((d) => d.date === date);
}

