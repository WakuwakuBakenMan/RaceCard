/*
  任意のCSV -> public/data/date{1..4}.json 生成スクリプト。
  - CSVが存在しなければ何もしない(no-op)
  - 簡易パーサで最低限のフィールドのみ対応
*/
import fs from 'node:fs';
import path from 'node:path';

type Row = Record<string, string>;

function readCsvIfExists(csvPath: string): Row[] | undefined {
  if (!fs.existsSync(csvPath)) return undefined;
  const raw = fs.readFileSync(csvPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return [];
  const headers = lines[0].split(',').map((s) => s.trim());
  return lines.slice(1).map((line) => {
    const cols = line.split(',');
    const row: Row = {};
    headers.forEach((h, i) => (row[h] = (cols[i] ?? '').trim()));
    return row;
  });
}

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function writeJson(p: string, data: unknown) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

// 期待するCSV: data/csv/date{n}.csv
// カラム例:
// date,track,kaiji,nichiji,race_no,race_name,distance_m,ground,course_note,condition,start_time,pace_score,pace_mark,num,draw,name,sex,age,weight,jockey,trainer,odds,popularity,pace_type

const root = process.cwd();
for (let i = 1; i <= 4; i++) {
  const csvPath = path.join(root, 'data', 'csv', `date${i}.csv`);
  const rows = readCsvIfExists(csvPath);
  if (!rows) continue; // 無ければスキップ
  const meetingsMap = new Map<string, any>();
  let date = '';
  for (const r of rows) {
    date = r.date || date;
    const key = `${r.track}:${r.kaiji}:${r.nichiji}`;
    if (!meetingsMap.has(key)) {
      meetingsMap.set(key, {
        track: r.track || '不明',
        kaiji: Number(r.kaiji || 0),
        nichiji: Number(r.nichiji || 0),
        races: [] as any[]
      });
    }
    const meeting = meetingsMap.get(key);
    const raceNo = Number(r.race_no || 0);
    let race = meeting.races.find((x: any) => x.no === raceNo);
    if (!race) {
      race = {
        no: raceNo,
        name: r.race_name || '',
        distance_m: Number(r.distance_m || 0),
        ground: r.ground || '',
        course_note: r.course_note || undefined,
        condition: r.condition || undefined,
        start_time: r.start_time || undefined,
        pace_score: r.pace_score ? Number(r.pace_score) : undefined,
        pace_mark: r.pace_mark || undefined,
        horses: [] as any[]
      };
      meeting.races.push(race);
    }
    race.horses.push({
      num: Number(r.num || 0),
      draw: Number(r.draw || 0),
      name: r.name || '',
      sex: r.sex || '',
      age: Number(r.age || 0),
      weight: Number(r.weight || 0),
      jockey: r.jockey || '',
      trainer: r.trainer || '',
      odds: r.odds ? Number(r.odds) : undefined,
      popularity: r.popularity ? Number(r.popularity) : undefined,
      pace_type: r.pace_type ? (r.pace_type.split('/').filter(Boolean) as any) : undefined
    });
  }
  const out = {
    date: date || '1970-01-01',
    meetings: Array.from(meetingsMap.values()).map((m) => ({
      ...m,
      races: m.races.sort((a: any, b: any) => a.no - b.no)
    }))
  };
  const outPath = path.join(root, 'public', 'data', `date${i}.json`);
  writeJson(outPath, out);
  console.log(`wrote ${outPath}`);
}

