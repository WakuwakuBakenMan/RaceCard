/// <reference path="./shims-pg.d.ts" />
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
type PaceBiasTarget = 'A'|'B'|'C'|null;
type DrawBiasTarget = 'inner'|'outer'|null;
type PaceBiasStat = { target: PaceBiasTarget; ratio?: number; n_total?: number };
type DrawBiasStat = { target: DrawBiasTarget; ratio?: number; n_total?: number; race_count?: number };
type PositionBiasForGround = { pace: { win_place?: PaceBiasStat; quinella?: PaceBiasStat; longshot?: PaceBiasStat; }; draw?: DrawBiasStat };
type Meeting = { track: string; kaiji: number; nichiji: number; races: Race[]; position_bias?: Record<string, PositionBiasForGround> };
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

async function listSeColumns(pool: Pool): Promise<Set<string>> {
  const sql = `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'jvd_se'
  `;
  try {
    const res = await pool.query(sql);
    return new Set(res.rows.map((r: any) => String(r.column_name)));
  } catch {
    return new Set<string>();
  }
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
  const seCols = await listSeColumns(pool);
  const finishCandidates = ['kakutei_juni','kakuteijuni','kakutei_jyuni','kettei_juni','chakujun','kakutei_chakujun'];
  const finishCol = finishCandidates.find((c) => seCols.has(c));
  const cornerCols = ['corner_1','corner_2','corner_3','corner_4'].filter(c => seCols.has(c));
  const selectList = [
    'se.wakuban', 'se.umaban', 'se.ketto_toroku_bango',
    'se.futan_juryo', 'se.kishumei_ryakusho', 'se.chokyoshimei_ryakusho',
    'se.kishu_code', 'se.chokyoshi_code',
    'se.tansho_odds', 'se.tansho_ninkijun',
    finishCol ? `se.${finishCol} AS __finish` : null,
    ...cornerCols.map(c => `se.${c}`),
    'um.bamei', 'um.seibetsu_code', 'um.seinengappi'
  ].filter(Boolean).join(', ');
  const sql = `
    SELECT ${selectList}
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
  // ポジションバイアス集計（当日までのDBから、開催×馬場ごとに集計）
  const biasByMeeting = await computePositionBiasForMeetings(pool, yyyymmdd, meetings);
  const meetingsWithBias = meetings.map((m) => ({ ...m, position_bias: biasByMeeting.get(meetingKeyOf(m)) }));
  return { date: toIso(yyyymmdd), meetings: meetingsWithBias };
}

function meetingKeyOf(m: { track: string; kaiji: number; nichiji: number }): string {
  return `${m.track}:${m.kaiji}:${m.nichiji}`;
}

async function computePositionBiasForMeetings(pool: Pool, yyyymmdd: string, meetings: Array<{ track: string; kaiji: number; nichiji: number; races: Race[] }>): Promise<Map<string, Record<string, PositionBiasForGround>>> {
  // 当日の各開催について、当日のレース結果（着順）と通過順/枠を用いて集計する。
  // 閾値: 70%以上を“強”。穴好走は n_total>=6 のときのみ評価。枠は 14頭以上レースが ground ごとに2レース未満の場合は対象外。
  const result = new Map<string, Record<string, PositionBiasForGround>>();

  // 1) 当日全レースの SE + RA を取得
  const year = yyyymmdd.slice(0,4);
  const mmdd = yyyymmdd.slice(4,8);
  const seCols = await listSeColumns(pool);
  const finishCandidates = ['kakutei_juni','kakuteijuni','kakutei_jyuni','kettei_juni','chakujun','kakutei_chakujun'];
  const finishCol = finishCandidates.find((c) => seCols.has(c));
  const cornerCols = ['corner_1','corner_2','corner_3','corner_4'].filter(c => seCols.has(c));
  const sql = `
    SELECT 
      ra.keibajo_code, ra.kaisai_kai, ra.kaisai_nichime, ra.track_code, ra.race_bango,
      se.wakuban, se.umaban, se.tansho_ninkijun,
      ${finishCol ? `se.${finishCol} AS __finish,` : 'NULL AS __finish,'}
      ${cornerCols.length ? cornerCols.map(c=>`se.${c}`).join(',') : 'NULL AS corner_1, NULL AS corner_2, NULL AS corner_3, NULL AS corner_4'}
    FROM public.jvd_se se
    JOIN public.jvd_ra ra
      ON CAST(NULLIF(TRIM(se.kaisai_nen), '') AS INTEGER) = CAST(NULLIF(TRIM(ra.kaisai_nen), '') AS INTEGER)
     AND CAST(NULLIF(TRIM(se.kaisai_tsukihi), '') AS INTEGER) = CAST(NULLIF(TRIM(ra.kaisai_tsukihi), '') AS INTEGER)
     AND CAST(NULLIF(TRIM(se.keibajo_code), '') AS INTEGER) = CAST(NULLIF(TRIM(ra.keibajo_code), '') AS INTEGER)
     AND CAST(NULLIF(TRIM(se.race_bango), '') AS INTEGER) = CAST(NULLIF(TRIM(ra.race_bango), '') AS INTEGER)
    WHERE CAST(NULLIF(TRIM(se.kaisai_nen), '') AS INTEGER) = CAST($1 AS INTEGER)
      AND CAST(NULLIF(TRIM(se.kaisai_tsukihi), '') AS INTEGER) = CAST($2 AS INTEGER)
    ORDER BY CAST(ra.keibajo_code AS INTEGER), CAST(ra.race_bango AS INTEGER), CAST(se.umaban AS INTEGER)
  `;
  const res = await pool.query(sql, [year, mmdd]);

  type Row = {
    keibajo_code: any; kaisai_kai: any; kaisai_nichime: any; track_code: any; race_bango: any;
    wakuban: any; umaban: any; tansho_ninkijun: any; __finish: any;
    corner_1?: any; corner_2?: any; corner_3?: any; corner_4?: any;
  };

  // 2) meeting×ground ごとに集計コンテナを用意
  type PaceBucket = { A: number; B: number; C: number; total: number };
  type PaceAgg = { wp: PaceBucket; q: PaceBucket; ls: PaceBucket };
  type DrawAgg = { inner: number; outer: number; total: number; raceCount: number };
  const agg = new Map<string, Map<string, { pace: PaceAgg; draw: DrawAgg }>>(); // meetingKey -> ground -> agg

  function ensureAgg(meetingKey: string, ground: string) {
    if (!agg.has(meetingKey)) agg.set(meetingKey, new Map());
    const m = agg.get(meetingKey)!;
    if (!m.has(ground)) m.set(ground, {
      pace: { wp: { A:0,B:0,C:0,total:0 }, q: { A:0,B:0,C:0,total:0 }, ls: { A:0,B:0,C:0,total:0 } },
      draw: { inner: 0, outer: 0, total: 0, raceCount: 0 },
    });
  }

  // 3) レース単位の頭数を把握（draw用のレース数条件チェックに使用）
  const raceHeadcount = new Map<string, number>(); // key: jyo:kaiji:nichiji:race
  for (const r of res.rows as Row[]) {
    const k = `${String(r.keibajo_code)}:${String(r.kaisai_kai)}:${String(r.kaisai_nichime)}:${String(r.race_bango)}`;
    raceHeadcount.set(k, (raceHeadcount.get(k) || 0) + 1);
  }
  // 4) 明細を走査して集計
  for (const r of res.rows as Row[]) {
    const track = JYOCD_TO_TRACK[String(r.keibajo_code).padStart(2,'0')] || String(r.keibajo_code);
    const meetingKey = `${track}:${Number(r.kaisai_kai)||0}:${Number(r.kaisai_nichime)||0}`;
    const ground = groundFromTrack(String(r.track_code));
    if (!ground || ground === '障') continue; // 障害は対象外
    ensureAgg(meetingKey, ground);
    const a = agg.get(meetingKey)!.get(ground)!;

    const finish = toInt(String(r.__finish||'').trim());
    const pop = toInt(String(r.tansho_ninkijun||'').trim());
    const wakubanNum = toInt(String(r.wakuban||'').trim()) ?? 0;
    const raceKey = `${String(r.keibajo_code)}:${String(r.kaisai_kai)}:${String(r.kaisai_nichime)}:${String(r.race_bango)}`;
    const headcount = raceHeadcount.get(raceKey) || 0;

    const corners = [r.corner_1, r.corner_2, r.corner_3, r.corner_4].map((x:any)=>toInt(String(x||'').trim())).filter((n)=>Number.isFinite(n)) as number[];
    const posType: 'A'|'B'|'C'|null = classifyPositionTypeForBias(corners);
    const drawKey: 'inner'|'outer'|null = wakubanNum>=1 && wakubanNum<=4 ? 'inner' : (wakubanNum>=5 && wakubanNum<=8 ? 'outer' : null);
    if (!posType) {
      // 角のデータが無い場合はスキップ
    } else {
      if (Number.isFinite(finish) && finish! <= 3) {
        a.pace.wp[posType] += 1; a.pace.wp.total += 1;
        if (drawKey && headcount >= 14) { a.draw[drawKey] += 1; a.draw.total += 1; }
        if (pop && pop >= 4) { a.pace.ls[posType] += 1; a.pace.ls.total += 1; }
      }
      if (Number.isFinite(finish) && finish! <= 2) {
        a.pace.q[posType] += 1; a.pace.q.total += 1;
        if (drawKey && headcount >= 14) { /* 連対でも枠を見る？ → WPに限定: 二重加算防止のためここでは加算しない */ }
      }
    }
  }
  // 5) groundごとに draw の raceCount をカウント（14頭以上のレース数）
  for (const r of res.rows as Row[]) {
    const ground = groundFromTrack(String(r.track_code));
    if (!ground || ground === '障') continue;
    const track = JYOCD_TO_TRACK[String(r.keibajo_code).padStart(2,'0')] || String(r.keibajo_code);
    const meetingKey = `${track}:${Number(r.kaisai_kai)||0}:${Number(r.kaisai_nichime)||0}`;
    const a = agg.get(meetingKey)?.get(ground);
    if (!a) continue;
    const raceKey = `${String(r.keibajo_code)}:${String(r.kaisai_kai)}:${String(r.kaisai_nichime)}:${String(r.race_bango)}`;
    const headcount = raceHeadcount.get(raceKey) || 0;
    if (headcount >= 14) a.draw.raceCount += 1;
  }

  // 6) 判定し、resultに詰める
  for (const [meetingKey, gMap] of agg) {
    const o: Record<string, PositionBiasForGround> = {};
    for (const [ground, a] of gMap) {
      const pace: PositionBiasForGround['pace'] = {};
      const pwp = decidePaceBias(a.pace.wp);
      if (pwp) pace.win_place = pwp;
      const pq = decidePaceBias(a.pace.q);
      if (pq) pace.quinella = pq;
      const pls = decidePaceBias(a.pace.ls, /*minN*/6);
      if (pls) pace.longshot = pls;
      const draw: DrawBiasStat | undefined = decideDrawBias(a.draw);
      o[ground] = { pace, ...(draw ? { draw } : {}) } as PositionBiasForGround;
    }
    result.set(meetingKey, o);
  }

  return result;
}

function toInt(s: string): number | undefined { const n = Number(s); return Number.isFinite(n) ? n : undefined; }
function classifyPositionTypeForBias(corners: number[]): 'A'|'B'|'C'|null {
  if (!corners.length) return null;
  const all4 = corners.every((n)=>n<=4);
  const all5p = corners.every((n)=>n>=5);
  if (all4) return 'A';
  if (all5p) return 'B';
  return 'C';
}
function decidePaceBias(b: { A:number; B:number; C:number; total:number }, minN = 1): PaceBiasStat | undefined {
  const total = b.total;
  if (total < minN || total === 0) return { target: null, n_total: total };
  const maxKey = (['A','B','C'] as const).reduce((best, k) => (b[k] > b[best] ? k : best), 'A' as 'A'|'B'|'C');
  const maxVal = b[maxKey];
  const ratio = total > 0 ? maxVal / total : 0;
  if (ratio >= 0.7) return { target: maxKey, ratio, n_total: total };
  return { target: null, ratio, n_total: total };
}
function decideDrawBias(d: { inner:number; outer:number; total:number; raceCount:number }): DrawBiasStat | undefined {
  if (d.raceCount < 2 || d.total === 0) return { target: null, n_total: d.total, race_count: d.raceCount };
  const target = d.inner >= d.outer ? 'inner' : 'outer';
  const ratio = (d.inner + d.outer) > 0 ? (target==='inner'? d.inner : d.outer) / (d.inner + d.outer) : 0;
  if (ratio >= 0.7) return { target, ratio, n_total: d.inner + d.outer, race_count: d.raceCount };
  return { target: null, ratio, n_total: d.inner + d.outer, race_count: d.raceCount };
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
