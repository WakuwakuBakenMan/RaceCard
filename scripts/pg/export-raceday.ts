/*
  PostgreSQL → RaceDay(JSON) エクスポート

  - 対象スキーマ: public（PC-KEIBA定義に準拠）
  - 主要テーブル: jvd_ra(レース詳細), jvd_se(馬毎レース情報), jvd_um(競走馬マスタ)
  - コード表: 競馬場コード(01..10), トラックコード, 馬場状態コード

  使い方例:
    PG_DSN=postgres://user:pass@host:5432/db?sslmode=disable \
    tsx scripts/pg/export-raceday.ts day 20240915 --publish-latest

  オプション:
    - day YYYYMMDD            : 単日日のRaceDay JSONを書き出す
    - latest N                : DB内の最新N日を書き出す
    --publish-latest          : data/days から最新4件を public/data/date1..4.json に反映
    --dsn <DSN>               : 接続文字列（PG_DSN 環境変数でも可）
*/
import 'dotenv/config';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Pool } from 'pg';

type Horse = {
  num: number;
  draw: number;
  name: string;
  sex: string;
  age: number;
  weight: number;
  jockey: string;
  trainer: string;
  odds?: number;
  popularity?: number;
  pace_type?: Array<'A'|'B'|'C'>;
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

function ensureDir(p: string) { fs.mkdirSync(p, { recursive: true }); }
function writeJson(p: string, data: unknown) { ensureDir(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(data, null, 2)); }

const JYOCD_TO_TRACK: Record<string, string> = {
  '01': '札幌','02': '函館','03': '福島','04': '新潟','05': '東京','06': '中山','07': '中京','08': '京都','09': '阪神','10': '小倉',
};

function toIso(yyyymmdd: string): string { return `${yyyymmdd.slice(0,4)}-${yyyymmdd.slice(4,6)}-${yyyymmdd.slice(6,8)}`; }
function hhmmToTime(v?: string | null): string | undefined {
  if (!v) return undefined;
  const s = String(v).trim();
  if (/^\d{4}$/.test(s)) return `${s.slice(0,2)}:${s.slice(2,4)}`;
  if (/^\d{1,2}:\d{2}$/.test(s)) return s;
  return undefined;
}
function groundFromTrack(track_code?: string | null): string {
  const s = (track_code || '').trim();
  if (!s) return '';
  const n = Number(s);
  if (s.startsWith('1')) return '芝';
  if ((n >= 23 && n <= 29) || s.startsWith('2')) return 'ダ';
  if (n >= 51) return '障';
  return '';
}
function conditionFromCodes(ground: string, shiba?: string | null, dirt?: string | null): string | undefined {
  const pick = ground === '芝' ? (shiba || '') : ground === 'ダ' ? (dirt || '') : '';
  const m: Record<string,string> = { '1':'良','2':'稍重','3':'重','4':'不良' };
  return m[pick] || undefined;
}
function sexFromCode(code?: string | null): string { const m: Record<string,string> = { '1':'牡','2':'牝','3':'セ' }; return m[String(code||'').trim()] || ''; }
function calcAge(yyyymmdd: string, seinengappi?: string | null): number {
  if (!seinengappi || !/^\d{8}$/.test(seinengappi)) return 0;
  const yBorn = Number(seinengappi.slice(0,4));
  const yRace = Number(yyyymmdd.slice(0,4));
  return Math.max(0, yRace - yBorn);
}

function classifyTypes(passages: string[]): Array<'A'|'B'|'C'> {
  let all4 = 0, nige = 0;
  for (const p of passages) {
    const parts = p.split('-').map((s) => Number(s)).filter((n) => Number.isFinite(n));
    if (!parts.length) continue;
    if (Math.max(...parts) <= 4) all4 += 1;
    if (parts[0] === 1) nige += 1;
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

async function getPool(dsn?: string) {
  const conn = dsn || process.env.PG_DSN || 'postgres://postgre:postgre@localhost:5432/pckeiba?sslmode=disable';
  const pool = new Pool({ connectionString: conn });
  return pool;
}

async function listRaColumns(pool: Pool): Promise<Set<string>> {
  const sql = `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'jvd_ra'
  `;
  try {
    const res = await pool.query(sql);
    return new Set(res.rows.map((r: any) => String(r.column_name)));
  } catch {
    return new Set<string>();
  }
}

async function fetchRacesForDay(pool: Pool, yyyymmdd: string) {
  const year = yyyymmdd.slice(0,4);
  const mmdd = yyyymmdd.slice(4,8);
  const cols = await listRaColumns(pool);
  const optionalCandidates = [
    'jyoken_name','jyokenname','jyoken_disp','jyoken_hyoji','jyokenname_disp',
    'ryakusyo_10','ryakusyo10','ryakusyo',
    'kyosomei_ryakusho_10','kyosomei_ryakusho_6','kyosomei_ryakusho_3',
    'kigo_code','kigo_cd','kigocd','syubetsu_kigo_bunrui_code','syubetsu_kigobunrui_code',
    'kyoso_kigo_code','kyoso_joken_code','kyoso_joken_meisho',
    'grade_code','tokubetsu_kubun','tokubetsu_kbn','kyosomei_kubun'
  ];
  const pickedOptional = optionalCandidates.filter(c => cols.has(c));
  const selectList = [
    'kaisai_nen','kaisai_tsukihi','keibajo_code',
    "COALESCE(NULLIF(kaisai_kai,''), '0') AS kaisai_kai",
    "COALESCE(NULLIF(kaisai_nichime,''), '0') AS kaisai_nichime",
    'race_bango','kyosomei_hondai','kyori','track_code',
    'babajotai_code_shiba','babajotai_code_dirt','hasso_jikoku',
    ...pickedOptional
  ].join(', ');
  const sql = `
    SELECT ${selectList}
    FROM public.jvd_ra
    WHERE CAST(NULLIF(TRIM(kaisai_nen), '') AS INTEGER) = CAST($1 AS INTEGER)
      AND CAST(NULLIF(TRIM(kaisai_tsukihi), '') AS INTEGER) = CAST($2 AS INTEGER)
    ORDER BY CAST(keibajo_code AS INTEGER), CAST(race_bango AS INTEGER)
  `;
  const res = await pool.query(sql, [year, mmdd]);
  return res.rows as Array<any>;
}

async function fetchEntriesForRace(pool: Pool, row: any) {
  const sql = `
    SELECT 
      se.wakuban, se.umaban, se.ketto_toroku_bango,
      se.futan_juryo, se.kishumei_ryakusho, se.chokyoshimei_ryakusho,
      se.kishu_code, se.chokyoshi_code,
      se.tansho_odds, se.tansho_ninkijun,
      um.bamei, um.seibetsu_code, um.seinengappi
    FROM public.jvd_se se
    LEFT JOIN public.jvd_um um ON um.ketto_toroku_bango = se.ketto_toroku_bango
    WHERE CAST(NULLIF(TRIM(se.kaisai_nen), '') AS INTEGER) = CAST($1 AS INTEGER)
      AND CAST(NULLIF(TRIM(se.kaisai_tsukihi), '') AS INTEGER) = CAST($2 AS INTEGER)
      AND CAST(NULLIF(TRIM(se.keibajo_code), '') AS INTEGER) = CAST($3 AS INTEGER)
      AND CAST(NULLIF(TRIM(se.race_bango), '') AS INTEGER) = CAST($4 AS INTEGER)
    ORDER BY CAST(se.umaban AS INTEGER)
  `;
  const res = await pool.query(sql, [row.kaisai_nen, row.kaisai_tsukihi, row.keibajo_code, row.race_bango]);
  return res.rows as Array<any>;
}

function fetchOddsFromSqliteIfAvailable(yyyymmdd: string, row: any): Map<number, { odds?: number; popularity?: number }> {
  const edb = process.env.EDB_PATH || process.env.SQLITE_DB || process.env.EDB || '';
  if (!edb) return new Map();
  try {
    const year = yyyymmdd.slice(0,4);
    const mmdd = yyyymmdd.slice(4,8);
    const jyo = String(row.keibajo_code || '').padStart(2,'0');
    const kaiji = String(row.kaisai_kai || '0');
    const nichiji = String(row.kaisai_nichime || '0');
    const race = String(row.race_bango || '0');
    const out = execFileSync('python3', [
      'scripts/sqlite/query_odds_pop.py',
      '--db', edb,
      '--year', year,
      '--mmdd', mmdd,
      '--jyo', jyo,
      '--kaiji', kaiji,
      '--nichiji', nichiji,
      '--race', race,
    ], { encoding: 'utf8' });
    const obj = JSON.parse(out || '{}') as Record<string, { odds?: number; popularity?: number }>;
    const m = new Map<number, { odds?: number; popularity?: number }>();
    for (const [k,v] of Object.entries(obj)) m.set(Number(k), v);
    return m;
  } catch {
    return new Map();
  }
}

async function fetchPassagesForHorsesBefore(pool: Pool, horseIds: string[], yyyymmdd: string) {
  if (horseIds.length === 0) return new Map<string, string[]>();
  const targetNum = Number(`${yyyymmdd.slice(0,4)}${yyyymmdd.slice(4,8)}`);
  // 1) JRA(jvd_se) + 2) 地方(nvd_se) を UNION ALL で取得し、馬IDごとに日付降順で3件まで採用
  const sql = `
    WITH target_ids AS (
      SELECT unnest($1::text[]) AS ketto_toroku_bango
    ), se_all AS (
      SELECT 'J' AS src, se.ketto_toroku_bango, se.kaisai_nen, se.kaisai_tsukihi,
             se.corner_1, se.corner_2, se.corner_3, se.corner_4
      FROM public.jvd_se se
      JOIN target_ids t USING (ketto_toroku_bango)
      WHERE (CAST(se.kaisai_nen AS INTEGER)*10000 + CAST(se.kaisai_tsukihi AS INTEGER)) < $2
      UNION ALL
      SELECT 'N' AS src, se.ketto_toroku_bango, se.kaisai_nen, se.kaisai_tsukihi,
             se.corner_1, se.corner_2, se.corner_3, se.corner_4
      FROM public.nvd_se se
      JOIN target_ids t USING (ketto_toroku_bango)
      WHERE (CAST(se.kaisai_nen AS INTEGER)*10000 + CAST(se.kaisai_tsukihi AS INTEGER)) < $2
    )
    SELECT * FROM se_all
    ORDER BY ketto_toroku_bango,
             CAST(kaisai_nen AS INTEGER) DESC,
             CAST(kaisai_tsukihi AS INTEGER) DESC
  `;
  const res = await pool.query(sql, [horseIds, targetNum]);
  const map = new Map<string, { d: number; pass: string }[]>();
  for (const r of res.rows as any[]) {
    const id = String(r.ketto_toroku_bango);
    const c = [r.corner_1, r.corner_2, r.corner_3, r.corner_4].map((x: any) => (x==null? '': String(x).trim()));
    const present = c.filter((x) => x && /^\d+$/.test(x)).map((x) => Number(x));
    if (!present.length) continue;
    const arr = map.get(id) || [];
    const d = Number(String(r.kaisai_nen).padStart(4,'0') + String(r.kaisai_tsukihi).padStart(4,'0'));
    arr.push({ d, pass: present.join('-') });
    map.set(id, arr);
  }
  const out = new Map<string, string[]>();
  for (const [id, list] of map) {
    list.sort((a,b)=>b.d-a.d);
    out.set(id, list.slice(0,3).map(x=>x.pass));
  }
  return out;
}

async function buildRaceDay(pool: Pool, yyyymmdd: string): Promise<RaceDay> {
  const races = await fetchRacesForDay(pool, yyyymmdd);
  const meetingsMap = new Map<string, Meeting>();
  for (const r of races) {
    const track = JYOCD_TO_TRACK[String(r.keibajo_code).padStart(2,'0')] || String(r.keibajo_code);
    const kaiji = Number(r.kaisai_kai || 0) || 0;
    const nichiji = Number(r.kaisai_nichime || 0) || 0;
    const meetingKey = `${track}:${kaiji}:${nichiji}`;
    if (!meetingsMap.has(meetingKey)) meetingsMap.set(meetingKey, { track, kaiji, nichiji, races: [] });

    const ground = groundFromTrack(r.track_code);
    const condition = conditionFromCodes(ground, r.babajotai_code_shiba, r.babajotai_code_dirt);
    const distance_m = Number(r.kyori || 0) || 0;
    const start_time = hhmmToTime(r.hasso_jikoku);

    const entries = await fetchEntriesForRace(pool, r);
    const oddsMap = fetchOddsFromSqliteIfAvailable(yyyymmdd, r);
    const horses: Horse[] = entries.map((e) => ({
      num: Number(e.umaban || 0) || 0,
      draw: Number(e.wakuban || 0) || 0,
      name: (e.bamei || '').trim() || '',
      sex: sexFromCode(e.seibetsu_code),
      age: calcAge(yyyymmdd, e.seinengappi),
      weight: (() => {
        const n = Number(e.futan_juryo);
        return Number.isFinite(n) ? Math.round((n / 10) * 10) / 10 : 0; // 1桁小数に丸め
      })(),
      jockey: (e.kishumei_ryakusho || '').trim() || (e.kishu_code || '') || '',
      trainer: (e.chokyoshimei_ryakusho || '').trim() || (e.chokyoshi_code || '') || '',
      odds: ((): number | undefined => {
        const o = oddsMap.get(Number(e.umaban||0));
        return o?.odds;
      })(),
      popularity: ((): number | undefined => {
        const o = oddsMap.get(Number(e.umaban||0));
        return o?.popularity;
      })(),
    }));

    // pace_type 計算
    const horseIds = entries.map((e) => String(e.ketto_toroku_bango || '')).filter(Boolean);
    const passMap = await fetchPassagesForHorsesBefore(pool, horseIds, yyyymmdd);
    const types = horseIds.map((id) => classifyTypes(passMap.get(id) || []));
    const horsesWithType: Horse[] = horses.map((h, i) => ({ ...h, pace_type: types[i] && types[i].length ? types[i] : undefined }));
    const paceScore = ((): number => {
      const validCnt = horseIds.reduce((a, id) => a + ((passMap.get(id)||[]).length>0 ? 1:0), 0);
      if (validCnt === 0) return -3.5;
      return computePaceScore(types);
    })();
    const paceMark = paceScore <= 4.0 && paceScore !== -3.5 ? '★' : undefined;

    // レース名決定（優先: 本題名/略称 → 年齢帯+クラス → 距離/馬場）
    // 1) 公式レース名（本題）を最優先。なければ略称/条件名。
    const rawName = String(r.kyosomei_hondai ?? '').trim();
    const jn = String((r.jyoken_name ?? r.jyokenname ?? r.jyoken_disp ?? r.jyoken_hyoji ?? r.jyokenname_disp ?? r.kyoso_joken_meisho) ?? '').trim();
    const rk = String((r.ryakusyo_10 ?? r.ryakusyo10 ?? r.ryakusyo ?? r.kyosomei_ryakusho_10 ?? r.kyosomei_ryakusho_6 ?? r.kyosomei_ryakusho_3) ?? '').trim();
    const sourceText = `${jn} ${rk} ${rawName}`;
    const ageLabelFromText = ((): string | undefined => {
      const m = sourceText.match(/([2-9])歳(?:以上|上)?/);
      if (!m) return undefined;
      const n = m[1];
      if (n === '2') return '2歳';
      return `${n}歳以上`;
    })();
    const ages = horses.map((h)=>h.age).filter((a)=>Number.isFinite(a) && a>0) as number[];
    const ageLabelFromHorses = ((): string | undefined => {
      if (!ages.length) return undefined;
      return ages.every((a)=>a===2) ? '2歳' : '3歳以上';
    })();
    const classLabel = ((): string | undefined => {
      const pick = (v?: any) => String(v ?? '').trim();
      const kigos = [pick(r.kyoso_kigo_code), pick(r.kyoso_kigo_code), pick(r.kigo_code), pick(r.kigo_cd), pick(r.kigocd), pick(r.syubetsu_kigo_bunrui_code), pick(r.syubetsu_kigobunrui_code)];
      for (const kigo of kigos) {
        if (!kigo) continue;
        const tail2 = kigo.slice(-2);
        if (/^A0?/.test(kigo)) {
          if (tail2 === '03') return '1勝クラス';
          if (tail2 === '04') return '2勝クラス';
          if (tail2 === '05') return '3勝クラス';
        }
        if (tail2 === '01' || /^01/.test(kigo)) return '新馬';
        if (['02','03','23','00'].includes(tail2) || /^02/.test(kigo) || kigo === '000') return '未勝利';
        if (/^N/.test(kigo) && tail2 === '04') return 'オープン';
      }
      // 文字列から推測（条件名/本題/略称）
      const src = sourceText;
      if (/新馬/.test(src)) return '新馬';
      if (/未勝利/.test(src)) return '未勝利';
      if (/(?:1|１)勝/.test(src)) return '1勝クラス';
      if (/(?:2|２)勝/.test(src)) return '2勝クラス';
      if (/(?:3|３)勝/.test(src)) return '3勝クラス';
      if (/(?:OP\b|オープン|OPEN|L(isted)?\b|G[1-3]\b)/i.test(src)) return 'オープン';
      return undefined;
    })();
    let name: string | undefined;
    // まずはレース名（本題/略称）を優先
    if (rawName) name = rawName;
    else if (jn || rk) name = jn || rk;
    else {
      // 次に年齢帯+クラスを合成
      const ageLabel = ageLabelFromText || ageLabelFromHorses;
      if (ageLabel && classLabel) name = ground === '障' ? `${ageLabel}障害${classLabel}` : `${ageLabel}${classLabel}`;
      else if (!ageLabel && classLabel) {
        // 年齢帯が取れない場合は 3歳以上 をデフォルト
        const fallbackAge = '3歳以上';
        name = ground === '障' ? `${fallbackAge}障害${classLabel}` : `${fallbackAge}${classLabel}`;
      } else {
        // 最後の保険
        name = `${ground}${distance_m}m`;
      }
    }

    const raceObj: Race = {
      no: Number(r.race_bango || 0) || 0,
      name,
      distance_m,
      ground,
      condition,
      start_time,
      pace_score: paceScore,
      pace_mark: paceMark,
      horses: horsesWithType,
    };

    meetingsMap.get(meetingKey)!.races.push(raceObj);

    // レース単位JSONも保存
    try {
      const outDir = path.join(process.cwd(), 'data', 'races', toIso(yyyymmdd), track);
      ensureDir(outDir);
      const payload = { date: toIso(yyyymmdd), track, kaiji, nichiji, race: raceObj };
      writeJson(path.join(outDir, `${raceObj.no}.json`), payload);
    } catch {}
  }

  const meetings = Array.from(meetingsMap.values()).map((m) => ({ ...m, races: m.races.sort((a,b)=>a.no-b.no) }))
    .sort((a,b)=> a.track===b.track ? (a.kaiji===b.kaiji ? a.nichiji-b.nichiji : a.kaiji-b.kaiji) : a.track.localeCompare(b.track));
  return { date: toIso(yyyymmdd), meetings };
}

function writeRaceDay(day: RaceDay) {
  const outDir = path.join(process.cwd(), 'data', 'days');
  ensureDir(outDir);
  const file = path.join(outDir, `${day.date}.json`);
  writeJson(file, day);
  console.log(`wrote ${file}`);
}

function publishLatest(latestN = 4) {
  const inDir = path.join(process.cwd(), 'data', 'days');
  const outDir = path.join(process.cwd(), 'public', 'data');
  ensureDir(outDir);
  const files = fs.readdirSync(inDir).filter((f) => f.endsWith('.json')).sort();
  const selected = files.slice(-latestN);
  if (selected.length === 0) return;
  const padded = selected.length < latestN ? Array(latestN - selected.length).fill(selected[0]).concat(selected) : selected;
  padded.forEach((f, i) => {
    fs.copyFileSync(path.join(inDir, f), path.join(outDir, `date${i+1}.json`));
    console.log(`copied ${f} -> public/data/date${i+1}.json`);
  });
}

async function getLatestDates(pool: Pool, n: number): Promise<string[]> {
  const sql = `
    SELECT DISTINCT (CAST(kaisai_nen AS INTEGER)*10000 + CAST(kaisai_tsukihi AS INTEGER)) AS ymd
    FROM public.jvd_ra
    WHERE kaisai_nen ~ '^\\d{4}$' AND kaisai_tsukihi ~ '^\\d{4}$'
    ORDER BY ymd
  `;
  const res = await pool.query(sql);
  const all = res.rows.map((r: any) => String(r.ymd));
  return all.slice(-n);
}

async function main() {
  const raw = process.argv.slice(2);
  let publish = false;
  let dsn: string | undefined;
  const args: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === '--publish-latest') { publish = true; continue; }
    if (a === '--dsn') { dsn = raw[i+1]; i++; continue; }
    args.push(a);
  }
  const pool = await getPool(dsn);
  try {
    const cmd = args[0];
    if (cmd === 'day') {
      const ymd = args[1];
      if (!ymd || !/^\d{8}$/.test(ymd)) {
        console.error('Usage: tsx scripts/pg/export-raceday.ts day YYYYMMDD [--publish-latest] [--dsn <DSN>]');
        process.exit(1);
      }
      const day = await buildRaceDay(pool, ymd);
      writeRaceDay(day);
      if (publish) publishLatest(4);
      return;
    }
    if (cmd === 'latest') {
      const nStr = args[1] || '1';
      const n = Math.max(1, Number(nStr) || 1);
      const ymds = await getLatestDates(pool, n);
      for (const ymd of ymds) {
        const day = await buildRaceDay(pool, ymd);
        writeRaceDay(day);
      }
      if (publish) publishLatest(4);
      return;
    }
    console.error('Usage: export-raceday.ts [day YYYYMMDD|latest N] [--publish-latest] [--dsn <DSN>]');
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
