import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';

type Horse = { num: number; pace_type?: Array<'A'|'B'|'C'>; ketto?: string };
type Race = { no: number; ground: string; horses: Horse[]; pace_score?: number };
type Meeting = { track: string; kaiji: number; nichiji: number; races: Race[] };
type RaceDay = { date: string; meetings: Meeting[] };

const JYOCD_TO_TRACK: Record<string, string> = {
  '01': '札幌','02': '函館','03': '福島','04': '新潟','05': '東京','06': '中山','07': '中京','08': '京都','09': '阪神','10': '小倉',
};

function ensureDir(p: string) { fs.mkdirSync(p, { recursive: true }); }

async function getPool() {
  const dsn = process.env.PG_DSN || '';
  if (!dsn) throw new Error('PG_DSN is not set');
  return new Pool({ connectionString: dsn });
}

function listLatestDayFiles(n = 4): string[] {
  const inDir = path.join(process.cwd(), 'data', 'days');
  if (!fs.existsSync(inDir)) return [];
  const files = fs.readdirSync(inDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  return files.slice(-n).map((f) => path.join(inDir, f));
}

function readDay(file: string): RaceDay { return JSON.parse(fs.readFileSync(file, 'utf8')) as RaceDay; }
function writeDay(file: string, day: RaceDay) { ensureDir(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(day, null, 2)); }

function classifyTypes(passages: string[]): Array<'A'|'B'|'C'> {
  let all4 = 0, nige = 0;
  for (const p of passages) {
    const partsRaw = p.split('-').map((s) => Number(s)).filter((n) => Number.isFinite(n));
    const parts = partsRaw.filter((n) => n > 0); // 0は未計測とみなし除外
    if (!parts.length) continue;
    if (Math.max(...parts) <= 4) all4 += 1;
    const first = parts[0];
    const second = parts[1];
    if (first === 1 || (first === 2 && second === 1)) nige += 1;
  }
  const t: Array<'A'|'B'|'C'> = [];
  if (nige >= 2) t.push('A');
  if (all4 >= 2) t.push('B');
  else if (all4 === 1) t.push('C');
  return t;
}

function computePaceScore(allTypes: Array<Array<'A'|'B'|'C'>>): number {
  let plcOnCnt = 0, target2 = 0, nigeUma = 0;
  for (const t of allTypes) {
    if (t.includes('B')) { plcOnCnt += 1.0; target2 += 1; }
    else if (t.includes('C')) plcOnCnt += 0.5;
    if (t.includes('A')) nigeUma += 1;
  }
  if (nigeUma === 0) plcOnCnt -= 2.5; else if (nigeUma >= 2) plcOnCnt += 1.5;
  if (target2 <= 2) plcOnCnt -= 1.0;
  return plcOnCnt;
}

// no longer needed: we'll use ketto from day JSON

async function fetchPassagesBefore(pool: Pool, kettoIds: string[], yyyymmdd: string): Promise<Map<string, string[]>> {
  if (kettoIds.length === 0) return new Map();
  const targetNum = Number(`${yyyymmdd.slice(0,4)}${yyyymmdd.slice(4,8)}`);
  const sql = `
    WITH target_ids AS (
      SELECT unnest($1::text[]) AS ketto_toroku_bango
    ), se_all AS (
      SELECT 'J' AS src, se.ketto_toroku_bango::text AS ketto_toroku_bango, se.kaisai_nen, se.kaisai_tsukihi,
             se.corner_1, se.corner_2, se.corner_3, se.corner_4
      FROM public.jvd_se se
      JOIN target_ids t ON t.ketto_toroku_bango = se.ketto_toroku_bango::text
      WHERE (CAST(se.kaisai_nen AS INTEGER)*10000 + CAST(se.kaisai_tsukihi AS INTEGER)) < $2
        AND COALESCE(NULLIF(TRIM(se.data_kubun),''),'') IN ('6','7')
      UNION ALL
      SELECT 'N' AS src, se.ketto_toroku_bango::text AS ketto_toroku_bango, se.kaisai_nen, se.kaisai_tsukihi,
             se.corner_1, se.corner_2, se.corner_3, se.corner_4
      FROM public.nvd_se se
      JOIN target_ids t ON t.ketto_toroku_bango = se.ketto_toroku_bango::text
      WHERE (CAST(se.kaisai_nen AS INTEGER)*10000 + CAST(se.kaisai_tsukihi AS INTEGER)) < $2
        AND COALESCE(NULLIF(TRIM(se.data_kubun),''),'') IN ('6','7')
    )
    SELECT * FROM se_all
    ORDER BY ketto_toroku_bango, CAST(kaisai_nen AS INTEGER) DESC, CAST(kaisai_tsukihi AS INTEGER) DESC
  `;
  const res = await pool.query(sql, [kettoIds, targetNum]);
  const tmp = new Map<string, { d: number; pass: string }[]>();
  for (const r of res.rows as any[]) {
    const id = String(r.ketto_toroku_bango);
    // 仕様: コーナーが2箇所しかない場合、corner_3/4 のみに格納されることがある
    // → 1..4全ての数値を集約し、存在するものをすべて評価対象にする
    const rawCorners = [r.corner_1, r.corner_2, r.corner_3, r.corner_4];
    const corners = rawCorners
      .map((x:any)=>String(x||'').trim())
      .filter(Boolean)
      .flatMap((s:string)=> s.split(/[^0-9]+/).filter(Boolean).map((p)=>Number(p)).filter((n)=>Number.isFinite(n) && n>0));
    if (!corners.length) continue;
    const d = Number(String(r.kaisai_nen).padStart(4,'0') + String(r.kaisai_tsukihi).padStart(4,'0'));
    const pass = corners.join('-');
    const arr = tmp.get(id) || [];
    arr.push({ d, pass });
    tmp.set(id, arr);
  }
  const out = new Map<string, string[]>();
  for (const [id, list] of tmp) {
    list.sort((a,b)=>b.d-a.d);
    out.set(id, list.slice(0,3).map(x=>x.pass));
  }
  return out;
}

async function augmentDay(file: string, pool: Pool) {
  const day = readDay(file);
  const ymd = day.date.replace(/-/g, '');
  for (const m of day.meetings || []) {
    for (const r of m.races || []) {
      if (!Array.isArray(r.horses) || r.horses.length===0) continue;
      // Skip Niigata芝1000m
      if (m.track === '新潟' && r.ground === '芝' && r.distance_m === 1000) { continue; }
      const kettoIds = r.horses.map((h)=> (h as any).ketto ).filter((s): s is string => !!s);
      const passMap = await fetchPassagesBefore(pool, kettoIds, ymd);
      const types = r.horses.map((h)=>{
        const ketto = (h as any).ketto as string | undefined;
        const passes = ketto ? (passMap.get(ketto)||[]) : [];
        const t = classifyTypes(passes);
        return t.length ? t : undefined;
      });
      r.horses = r.horses.map((h, i)=> ({ ...h, ...(types[i] ? { pace_type: types[i] } : {}) }));
      const allTypes = types.map((t)=> t || []);
      const score = computePaceScore(allTypes);
      r.pace_score = score;
      // pace_markは既存判定に合わせる
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      (r as any).pace_mark = score <= 4.0 && score !== -3.5 ? '★' : undefined;
    }
  }
  writeDay(file, day);
  console.log(`[augment-pace] wrote ${file}`);
}

async function main() {
  const args = process.argv.slice(2);
  const dates = args.filter((a)=>/^\d{4}-\d{2}-\d{2}$/.test(a));
  const files = dates.length ? dates.map((d)=> path.join('data','days',`${d}.json`)) : listLatestDayFiles(4);
  if (files.length===0) { console.error('No day files'); process.exit(0); }
  const pool = await getPool();
  try {
    for (const f of files) await augmentDay(f, pool);
  } finally { await pool.end(); }
}

main().catch((e)=>{ console.error(e); process.exit(1); });


