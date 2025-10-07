import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { computePositionBiasForMeetings, meetingKeyOf } from '../pg/export-raceday';

type Race = { no: number };
type Meeting = { track: string; kaiji: number; nichiji: number; races: Race[]; position_bias?: unknown };
type RaceDay = { date: string; meetings: Meeting[] };

function ensureDir(p: string) { fs.mkdirSync(p, { recursive: true }); }

async function getPool(dsn?: string) {
  const conn = dsn || process.env.PG_DSN || '';
  if (!conn) throw new Error('PG_DSN not set');
  const pool = new Pool({ connectionString: conn });
  return pool;
}

function listLatestDayFiles(n = 4): string[] {
  const inDir = path.join(process.cwd(), 'data', 'days');
  if (!fs.existsSync(inDir)) return [];
  const files = fs.readdirSync(inDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  return files.slice(-n).map((f) => path.join(inDir, f));
}

function readDay(file: string): RaceDay {
  const json = JSON.parse(fs.readFileSync(file, 'utf8')) as RaceDay;
  return json;
}

function writeDay(file: string, day: RaceDay) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(day, null, 2));
}

async function augmentOne(file: string, pool: Pool) {
  const day = readDay(file);
  const meetings: Meeting[] = Array.isArray(day.meetings) ? day.meetings : [];
  if (meetings.length === 0) return;
  // compute PB from PG (DataKubun 6/7 inside the function)
  const ymd = day.date.replace(/-/g, '');
  const pbMap = await computePositionBiasForMeetings(pool, ymd, meetings);
  const outMeetings = meetings.map((m) => ({ ...m, position_bias: pbMap.get(meetingKeyOf(m)) }));
  const out: RaceDay = { ...day, meetings: outMeetings };
  writeDay(file, out);
  console.log(`[augment] wrote PB to ${file}`);
}

async function main() {
  const args = process.argv.slice(2);
  const dsnIdx = args.indexOf('--dsn');
  const dsn = dsnIdx >= 0 ? args[dsnIdx + 1] : undefined;
  let files: string[] = [];
  const explicitDates = args.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  if (explicitDates.length) {
    files = explicitDates.map((d) => path.join(process.cwd(), 'data', 'days', `${d}.json`)).filter((p) => fs.existsSync(p));
  } else {
    files = listLatestDayFiles(4);
  }
  if (files.length === 0) {
    console.error('No day files to augment.');
    process.exit(0);
  }
  const pool = await getPool(dsn);
  try {
    for (const f of files) {
      await augmentOne(f, pool);
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });


