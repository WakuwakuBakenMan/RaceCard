import fs from 'fs';
import path from 'path';

type RaceDay = { date: string; meetings?: Array<{ track: string; races?: Array<unknown> }>; };
type DayReco = { date: string; races?: Array<{ track: string; no: number }>; };

function readJson<T>(p: string): T | undefined {
  try {
    const s = fs.readFileSync(p, 'utf8');
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function validateRaceDay(file: string, obj: RaceDay) {
  assert(obj && typeof obj === 'object', `${file}: not an object`);
  assert(typeof obj.date === 'string' && /\d{4}-\d{2}-\d{2}/.test(obj.date), `${file}: invalid date`);
  assert(Array.isArray(obj.meetings), `${file}: meetings missing`);
  assert((obj.meetings || []).length > 0, `${file}: meetings empty`);
  // basic shape per meeting
  for (const m of obj.meetings || []) {
    assert(typeof m.track === 'string' && m.track.length > 0, `${file}: meeting.track invalid`);
    assert(Array.isArray(m.races), `${file}: meeting.races missing`);
    assert((m.races || []).length > 0, `${file}: meeting.races empty`);
  }
}

function validateReco(file: string, obj: DayReco) {
  assert(obj && typeof obj === 'object', `${file}: not an object`);
  assert(typeof obj.date === 'string' && /\d{4}-\d{2}-\d{2}/.test(obj.date), `${file}: invalid date`);
  assert(Array.isArray(obj.races), `${file}: races missing`);
}

function checkUniqueness(items: Array<{ file: string; date: string }>, kind: string) {
  const seen = new Map<string, string>();
  for (const it of items) {
    if (seen.has(it.date)) {
      throw new Error(`${kind}: duplicate date ${it.date} in ${seen.get(it.date)} and ${it.file}`);
    }
    seen.set(it.date, it.file);
  }
}

function main() {
  const outDir = path.join(process.cwd(), 'public', 'data');
  if (!fs.existsSync(outDir)) {
    throw new Error(`public/data not found: ${outDir}`);
  }

  const dateFiles = ['date1.json', 'date2.json', 'date3.json', 'date4.json'];
  const recoFiles = ['reco1.json', 'reco2.json', 'reco3.json', 'reco4.json'];

  const dateItems: Array<{ file: string; date: string }> = [];
  for (const f of dateFiles) {
    const full = path.join(outDir, f);
    if (!fs.existsSync(full)) continue; // 欠番は許容（例えば2件しか無いとき）。重複は別途検出。
    const obj = readJson<RaceDay>(full);
    if (!obj) throw new Error(`${f}: unreadable`);
    validateRaceDay(f, obj);
    dateItems.push({ file: f, date: obj.date });
  }
  assert(dateItems.length > 0, 'date files: none found');
  checkUniqueness(dateItems, 'date files');

  const recoItems: Array<{ file: string; date: string }> = [];
  for (const f of recoFiles) {
    const full = path.join(outDir, f);
    if (!fs.existsSync(full)) continue; // recoは存在しない場合も許容
    const obj = readJson<DayReco>(full);
    if (!obj) throw new Error(`${f}: unreadable`);
    validateReco(f, obj);
    recoItems.push({ file: f, date: obj.date });
  }
  if (recoItems.length > 0) checkUniqueness(recoItems, 'reco files');

  // Cross-check: If both present, dates should be subset-compatible (not required to align by index)
  const dateSet = new Set(dateItems.map((d) => d.date));
  const recoSet = new Set(recoItems.map((r) => r.date));
  for (const r of recoSet) {
    if (!dateSet.has(r)) {
      console.warn(`[WARN] reco date without matching date file: ${r}`);
    }
  }

  console.log('Validation OK');
}

try {
  main();
} catch (e) {
  console.error(String(e));
  process.exit(1);
}


