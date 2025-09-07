import fs from 'node:fs';
import path from 'node:path';
import { getUpcomingDates } from './calendar';
import { getRaceList } from './raceList';
import { sleep } from './lib/http';

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

async function cmdDates() {
  const dates = await getUpcomingDates();
  const out = { fetched_at: new Date().toISOString(), dates };
  const p = path.join(process.cwd(), 'data', 'scraped');
  ensureDir(p);
  const f = path.join(p, 'next_dates.json');
  fs.writeFileSync(f, JSON.stringify(out, null, 2));
  console.log(`wrote ${f}`);
}

async function cmdDay(ymd: string) {
  const list = await getRaceList(ymd);
  const p = path.join(process.cwd(), 'data', 'scraped');
  ensureDir(p);
  const f = path.join(p, `race_list_${ymd}.json`);
  fs.writeFileSync(f, JSON.stringify(list, null, 2));
  console.log(`wrote ${f}`);
}

async function cmdNext() {
  const p = path.join(process.cwd(), 'data', 'scraped', 'next_dates.json');
  if (!fs.existsSync(p)) {
    console.error('next_dates.json not found. Run: npm run fetch:dates');
    process.exit(1);
  }
  const json = JSON.parse(fs.readFileSync(p, 'utf8')) as { dates: { yyyymmdd: string }[] };
  for (const d of json.dates) {
    try {
      await cmdDay(d.yyyymmdd);
      await sleep(Number(process.env.SCRAPER_INTERVAL_MS || 3100)); // 3秒以上の間隔を確保
    } catch (e) {
      console.error(`Failed to fetch day ${d.yyyymmdd}:`, e);
    }
  }
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'dates') return cmdDates();
  if (cmd === 'day') {
    const ymd = process.argv[3];
    if (!ymd) {
      console.error('Usage: npm run fetch:day -- YYYYMMDD');
      process.exit(1);
    }
    return cmdDay(ymd);
  }
  if (cmd === 'next') return cmdNext();
  console.error('Usage: cli.ts [dates|day YYYYMMDD|next]');
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
