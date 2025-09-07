import fs from 'node:fs';
import path from 'node:path';
import { toIso } from './lib/date';
import type { RaceDayList, Meeting as SrcMeeting, RaceLink } from './raceList';

type Horse = {
  num: number;
  draw: number;
  name: string;
  sex: string;
  age: number;
  weight: number;
  jockey: string;
  trainer: string;
};
type Race = {
  no: number;
  name: string;
  distance_m: number;
  ground: string;
  course_note?: string;
  condition?: string;
  start_time?: string;
  pace_score?: number;
  pace_mark?: string;
  horses: Horse[];
};
type Meeting = { track: string; kaiji: number; nichiji: number; races: Race[] };
type RaceDay = { date: string; meetings: Meeting[] };

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function sanitizeText(t?: string | null): string {
  return (t || '').replace(/[\t\n\r]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function parseRace(link: RaceLink): Omit<Race, 'horses'> {
  const raw = sanitizeText(link.name || '');
  let name = raw;
  // 先頭の "\d+R" を除去
  name = name.replace(/^\d+\s*R\s*/i, '').trim();
  const timeM = name.match(/(\d{1,2}:\d{2})/);
  const start_time = timeM ? timeM[1] : undefined;
  // 距離（例: 芝1600m / ダ1200m / 障2880m）
  const distM = name.match(/(\d{3,4})\s*m/i);
  const distance_m = distM ? Number(distM[1]) : 0;
  // 馬場
  let ground = '';
  if (/芝/.test(name)) ground = '芝';
  else if (/ダート|ダ\b/.test(name)) ground = 'ダート';
  else if (/障/.test(name)) ground = '障害';
  // 表示用のレース名
  // 時刻・距離・頭数表記を除去
  name = name
    .replace(/\d{1,2}:\d{2}/, '')
    .replace(/\d{3,4}\s*m/i, '')
    .replace(/\d+\s*頭/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!name) name = `${link.no}R`;
  return { no: link.no, name, distance_m, ground, start_time };
}

function convert(day: RaceDayList): RaceDay {
  const meetings: Meeting[] = day.meetings.map((m: SrcMeeting) => ({
    track: m.track,
    kaiji: m.kaiji,
    nichiji: m.nichiji,
    races: m.races
      .map((r) => ({ ...parseRace(r), horses: [] as Horse[] }))
      .sort((a, b) => a.no - b.no)
  }));
  return { date: toIso(day.date), meetings };
}

function readRaceList(yyyymmdd: string): RaceDayList {
  const p = path.join(process.cwd(), 'data', 'scraped', `race_list_${yyyymmdd}.json`);
  if (!fs.existsSync(p)) throw new Error(`Race list not found: ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8')) as RaceDayList;
}

function writeRaceDay(day: RaceDay) {
  const outDir = path.join(process.cwd(), 'data', 'days');
  ensureDir(outDir);
  const file = path.join(outDir, `${day.date}.json`);
  fs.writeFileSync(file, JSON.stringify(day, null, 2));
  console.log(`wrote ${file}`);
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'day') {
    const ymd = process.argv[3];
    if (!ymd) {
      console.error('Usage: tsx scripts/netkeiba/convert-to-raceday.ts day YYYYMMDD');
      process.exit(1);
    }
    const list = readRaceList(ymd);
    const day = convert(list);
    writeRaceDay(day);
    return;
  }
  if (cmd === 'next') {
    const nextPath = path.join(process.cwd(), 'data', 'scraped', 'next_dates.json');
    if (!fs.existsSync(nextPath)) {
      console.error('next_dates.json not found. Run fetch:dates first.');
      process.exit(1);
    }
    const next = JSON.parse(fs.readFileSync(nextPath, 'utf8')) as { dates: { yyyymmdd: string }[] };
    for (const d of next.dates) {
      try {
        const list = readRaceList(d.yyyymmdd);
        const day = convert(list);
        writeRaceDay(day);
      } catch (e) {
        console.error(`convert failed for ${d.yyyymmdd}`, e);
      }
    }
    return;
  }
  console.error('Usage: convert-to-raceday.ts [day YYYYMMDD|next]');
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

