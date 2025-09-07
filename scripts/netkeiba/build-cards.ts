import fs from 'node:fs';
import path from 'node:path';
import { getRaceList } from './raceList';
import { sleep } from './lib/http';
import { toIso } from './lib/date';
// puppeteer は環境依存のため未使用（fetch + cheerio ベースで実装）
import { chromium } from 'playwright';

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

// Playwrightに一本化したためHTTPデコード関数は不要

async function fetchRaceCardPlaywright(page: import('playwright').Page, raceId: string, no: number): Promise<Omit<Race, 'horses'> & { horses: Horse[] }> {
  const url = `https://race.netkeiba.com/race/shutuba.html?race_id=${raceId}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body');
  const data = await page.evaluate(() => {
    const getText = (sel: string) => document.querySelector(sel)?.textContent?.trim() || '';
    const raceName = getText('h1.RaceName');
    const data01 = document.querySelector('div.RaceData01 span')?.textContent?.trim() || '';
    const distance_m = Number((data01.match(/(\d{3,4})m/) || [])[1] || 0);
    let ground = '';
    if (data01.includes('芝')) ground = '芝';
    else if (data01.includes('ダート') || /\bダ\b/.test(data01)) ground = 'ダート';
    else if (data01.includes('障')) ground = '障害';
    const start_time = (document.querySelector('div.RaceData02')?.textContent || '').match(/発走\s*(\d{1,2}:\d{2})/)?.[1] || '';
    const rows = Array.from(document.querySelectorAll('tr.HorseList')) as HTMLTableRowElement[];
    const horses = rows.map((tr) => {
      const q = (s: string) => tr.querySelector(s) as HTMLElement | null;
      const drawTxt = q('td.Waku')?.textContent?.trim() || q('td:nth-child(1)')?.textContent?.trim() || '';
      const numTxt = q('td.Umaban')?.textContent?.trim() || q('td:nth-child(2)')?.textContent?.trim() || '';
      const infoTd = q('td.HorseInfo');
      const name = infoTd?.querySelector('.HorseName')?.textContent?.trim() || infoTd?.textContent?.trim() || '';
      const sexAge = q('td.Age')?.textContent?.trim() || '';
      const jockey = q('td.Jockey a')?.textContent?.trim() || q('td.Jockey')?.textContent?.trim() || '';
      const trainer = q('td.Trainer a')?.textContent?.trim() || q('td.Trainer')?.textContent?.trim() || '';
      const weightTxt = q('td.Weight')?.textContent?.trim() || '';
      const sex = sexAge.slice(0, 1) || '';
      const age = Number(sexAge.slice(1) || 0) || 0;
      let weight = Number((weightTxt.match(/\d+(?:\.\d+)?/) || [])[0] || 0) || 0;
      if (weight > 100) weight = 0;
      return {
        num: Number(numTxt || 0) || 0,
        draw: Number(drawTxt || 0) || 0,
        name,
        sex,
        age,
        weight,
        jockey,
        trainer
      } as any;
    });
    return { raceName, distance_m, ground, start_time, horses };
  });
  return { no, name: data.raceName || `${no}R`, distance_m: data.distance_m, ground: data.ground, start_time: data.start_time, horses: data.horses as Horse[] };
}

async function buildDay(ymd: string): Promise<RaceDay> {
  const list = await getRaceList(ymd);
  const meetings: Meeting[] = [];
  const interval = Number(process.env.SCRAPER_INTERVAL_MS || 3000);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  for (const m of list.meetings) {
    const races: Race[] = [];
    for (const r of m.races) {
      if (!r.race_id) continue; // 安全側
      try {
        const card = await fetchRaceCardPlaywright(page, r.race_id, r.no);
        races.push(card);
        await sleep(interval);
      } catch (e) {
        console.error(`race card fetch failed ${ymd} ${m.track} ${r.no}:`, e);
      }
    }
    races.sort((a, b) => a.no - b.no);
    meetings.push({ track: m.track, kaiji: m.kaiji, nichiji: m.nichiji, races });
  }
  const result: RaceDay = { date: toIso(ymd), meetings };
  await browser.close();
  return result;
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
      console.error('Usage: tsx scripts/netkeiba/build-cards.ts day YYYYMMDD');
      process.exit(1);
    }
    const day = await buildDay(ymd);
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
        const day = await buildDay(d.yyyymmdd);
        writeRaceDay(day);
      } catch (e) {
        console.error(`build-cards failed for ${d.yyyymmdd}`, e);
      }
    }
    return;
  }
  console.error('Usage: build-cards.ts [day YYYYMMDD|next]');
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
