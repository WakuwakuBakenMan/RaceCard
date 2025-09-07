import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault('Asia/Tokyo');

export function toYmd(d: Date | string): string {
  const dd = dayjs(d).tz();
  return dd.format('YYYYMMDD');
}

export function toIso(yyyymmdd: string): string {
  return dayjs.tz(yyyymmdd, 'YYYYMMDD', 'Asia/Tokyo').format('YYYY-MM-DD');
}

export function isFutureJST(d: string | Date, now: Date = new Date()): boolean {
  return dayjs(d).tz().isAfter(dayjs(now).tz(), 'day');
}

export function weekdayJST(yyyymmdd: string): number {
  return dayjs.tz(yyyymmdd, 'YYYYMMDD', 'Asia/Tokyo').day(); // 0=Sun .. 6=Sat
}

export function clusterByAdjacentDays(ymds: string[]): string[][] {
  const sorted = [...new Set(ymds)].sort();
  const clusters: string[][] = [];
  let cur: string[] = [];
  const asDate = (s: string) => dayjs.tz(s, 'YYYYMMDD', 'Asia/Tokyo');
  for (let i = 0; i < sorted.length; i++) {
    if (i === 0) {
      cur = [sorted[i]];
      continue;
    }
    const prev = asDate(sorted[i - 1]);
    const thisd = asDate(sorted[i]);
    if (thisd.diff(prev, 'day') === 1) {
      cur.push(sorted[i]);
    } else {
      clusters.push(cur);
      cur = [sorted[i]];
    }
  }
  if (cur.length) clusters.push(cur);
  return clusters;
}

