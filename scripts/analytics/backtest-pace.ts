import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';

function toIso(ymd: string) { return `${ymd.slice(0,4)}-${ymd.slice(4,6)}-${ymd.slice(6,8)}`; }
function fromIso(d: Date) { const y=d.getFullYear(); const m=String(d.getMonth()+1).padStart(2,'0'); const dd=String(d.getDate()).padStart(2,'0'); return `${y}${m}${dd}`; }

async function listColumns(pool: Pool, table: string): Promise<Set<string>> {
  const sql = `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`;
  const res = await pool.query(sql, [table]);
  return new Set(res.rows.map((r:any)=>String(r.column_name)));
}

async function findPayoutTable(pool: Pool): Promise<string> {
  const sql = `
    SELECT table_name, string_agg(column_name, ',') AS cols
    FROM information_schema.columns
    WHERE table_schema='public'
      AND (column_name ILIKE '%tansho%' OR column_name ILIKE '%fukusho%')
    GROUP BY table_name
  `;
  const res = await pool.query(sql);
  // prefer jvd_hr if present
  for (const r of res.rows) { if (String(r.table_name) === 'jvd_hr') return 'jvd_hr'; }
  // otherwise, pick one with both tansho & fukusho columns
  for (const r of res.rows) {
    const cols = String(r.cols).toLowerCase();
    if (cols.includes('tansho') && cols.includes('fukusho')) return String(r.table_name);
  }
  return 'jvd_hr';
}

async function findHrKeyColumns(pool: Pool, table: string): Promise<{ y: string; md: string; jyo: string; race: string }> {
  const cols = Array.from(await listColumns(pool, table)).map(c=>c.toLowerCase());
  function pick(cands: string[], def: string) {
    for (const c of cands) { if (cols.includes(c.toLowerCase())) return c; }
    return def;
  }
  const y = pick(['kaisai_nen','kaisaienen','year'], 'kaisai_nen');
  const md = pick(['kaisai_tsukihi','kaisaitsukihi','tsukihi','mmdd'], 'kaisai_tsukihi');
  const jyo = pick(['keibajo_code','keibajo_cd','jyo_cd','jyo','keibajo'], 'keibajo_code');
  const race = pick(['race_bango','race_no','raceno','race'], 'race_bango');
  return { y, md, jyo, race };
}

function extractCorners(row: any, colNames: string[]): number[] {
  const out: number[] = [];
  for (const c of colNames) {
    const v = row[c]; if (v == null) continue;
    const s = String(v).trim(); if (!s) continue;
    if (/^\d+$/.test(s)) { const n=Number(s); if (Number.isFinite(n)) out.push(n); continue; }
    const parts = s.split(/[^0-9]+/).filter(Boolean);
    for (const p of parts) { const n=Number(p); if (Number.isFinite(n)) out.push(n); }
  }
  return out;
}

function classifyPaceTypeForRace(corners: number[]): 'A'|'B'|'C'|null {
  const seq = corners.filter((n)=>Number.isFinite(n));
  if (seq.length < 2) return null;
  const all4 = seq.every((n)=>n<=4);
  const all5p = seq.every((n)=>n>=5);
  if (all4) return 'A';
  if (all5p) return 'B';
  return 'C';
}

type Agg = { starters: number; wins: number; places: number; winStake: number; winReturn: number; placeStake: number; placeReturn: number };

async function main() {
  const raw = process.argv.slice(2);
  const anchorYmd = raw[0] && /^\d{8}$/.test(raw[0]) ? raw[0] : fromIso(new Date());
  const years = Math.max(1, Number(raw[1]||'3')||3);
  const toYmd = anchorYmd;
  const d = new Date(Number(anchorYmd.slice(0,4)), Number(anchorYmd.slice(4,6))-1, Number(anchorYmd.slice(6,8)));
  d.setFullYear(d.getFullYear()-years);
  const fromYmd = fromIso(d);

  const pool = new Pool({ connectionString: process.env.PG_DSN });
  try {
    const seCols = await listColumns(pool, 'jvd_se');
    const cornerCols = ['corner_1','corner_2','corner_3','corner_4'].filter(c=>seCols.has(c));
    const finishCandidates = ['kakutei_juni','kakuteijuni','kakutei_jyuni','kettei_juni','chakujun','kakutei_chakujun'];
    const finishCol = finishCandidates.find(c=>seCols.has(c)) || 'chakujun';

    const hrTable = 'jvd_hr';
    const hrCols = await listColumns(pool, hrTable);
    // 明示指定（ユーザー指定）
    const hrKeys = { y: 'kaisai_nen', md: 'kaisai_tsukihi', jyo: 'keibajo_code', race: 'race_bango' } as const;
    // 払戻スキーマ（定義書準拠）
    // 単勝: haraimodoshi_tansho_1a(馬番) / _1b(払戻) / _1c(人気) ... 1..3
    // 複勝: haraimodoshi_fukusho_1a(馬番) / _1b(払戻) / _1c(人気) ... 1..5
    const winUmCols = ['haraimodoshi_tansho_1a','haraimodoshi_tansho_2a','haraimodoshi_tansho_3a'].filter(c=>hrCols.has(c));
    const winPayCols = ['haraimodoshi_tansho_1b','haraimodoshi_tansho_2b','haraimodoshi_tansho_3b'].filter(c=>hrCols.has(c));
    const fukuUmCols = ['haraimodoshi_fukusho_1a','haraimodoshi_fukusho_2a','haraimodoshi_fukusho_3a','haraimodoshi_fukusho_4a','haraimodoshi_fukusho_5a'].filter(c=>hrCols.has(c));
    const fukuPayCols = ['haraimodoshi_fukusho_1b','haraimodoshi_fukusho_2b','haraimodoshi_fukusho_3b','haraimodoshi_fukusho_4b','haraimodoshi_fukusho_5b'].filter(c=>hrCols.has(c));

    const sql = `
      SELECT ra.keibajo_code, ra.track_code, ra.race_bango,
             se.kaisai_nen, se.kaisai_tsukihi,
             se.umaban, se.wakuban, se.${finishCol} AS __finish,
             ${cornerCols.length ? cornerCols.map(c=>`se.${c}`).join(',') : 'NULL AS corner_1'}
      FROM public.jvd_se se
      JOIN public.jvd_ra ra
        ON TRIM(se.kaisai_nen) = TRIM(ra.kaisai_nen)
       AND TRIM(se.kaisai_tsukihi) = TRIM(ra.kaisai_tsukihi)
       AND TRIM(se.keibajo_code) = TRIM(ra.keibajo_code)
       AND TRIM(se.race_bango) = TRIM(ra.race_bango)
      WHERE se.kaisai_nen ~ '^\\d{4}$' AND ra.kaisai_nen ~ '^\\d{4}$'
        AND se.kaisai_tsukihi ~ '^\\d{4}$'
        AND ra.kaisai_tsukihi ~ '^\\d{4}$'
        AND se.keibajo_code ~ '^\\d+$' AND ra.keibajo_code ~ '^\\d+$'
        AND se.race_bango ~ '^\\d+$' AND ra.race_bango ~ '^\\d+$'
        AND se.umaban ~ '^\\d+$'
        AND (CAST(NULLIF(TRIM(se.kaisai_nen), '') AS INTEGER)*10000 + CAST(NULLIF(TRIM(se.kaisai_tsukihi), '') AS INTEGER)) BETWEEN $1 AND $2
        AND COALESCE(NULLIF(TRIM(se.data_kubun),''),'') IN ('6','7')
      ORDER BY 
        CAST(NULLIF(REGEXP_REPLACE(ra.keibajo_code,'\\D','','g'),'') AS INTEGER),
        CAST(NULLIF(REGEXP_REPLACE(ra.race_bango,'\\D','','g'),'') AS INTEGER),
        CAST(NULLIF(REGEXP_REPLACE(se.umaban,'\\D','','g'),'') AS INTEGER)
    `;
    const res = await pool.query(sql, [Number(fromYmd), Number(toYmd)]);

    // Payouts per race
    const payoutColsAll = winUmCols.concat(winPayCols).concat(fukuUmCols).concat(fukuPayCols);
    function makeKey(y:any, md:any, j:any, r:any) {
      const yv = String(y).trim();
      const mdv = String(md).trim();
      const jv = String(j).replace(/\D/g, '');
      const rv = String(r).replace(/\D/g, '');
      return `${yv}:${mdv}:${jv}:${rv}`;
    }
    const hrMap = new Map<string, any>();
    if (payoutColsAll.length > 0) {
      const payoutSql = `
        SELECT ${payoutColsAll.map(c=>`hr.${c}`).join(', ')},
               hr.${hrKeys.y} AS k_y, hr.${hrKeys.md} AS k_md, hr.${hrKeys.jyo} AS k_jyo, hr.${hrKeys.race} AS k_r
        FROM public.${hrTable} hr
        WHERE hr.${hrKeys.y} ~ '^\\d{4}$' AND hr.${hrKeys.md} ~ '^\\d{4}$'
          AND (${hrKeys.jyo} IS NOT NULL) AND (${hrKeys.race} IS NOT NULL)
          AND (CAST(NULLIF(TRIM(hr.${hrKeys.y}), '') AS INTEGER)*10000 + CAST(NULLIF(TRIM(hr.${hrKeys.md}), '') AS INTEGER)) BETWEEN $1 AND $2
      `;
      const hrRes = await pool.query(payoutSql, [Number(fromYmd), Number(toYmd)]);
      for (const r of hrRes.rows as any[]) {
        const k = makeKey(r.k_y, r.k_md, r.k_jyo, r.k_r);
        hrMap.set(k, r);
      }
    }

    // Aggregate by track+ground+type
    const agg = new Map<string, Agg>();
    let statTotalStarters = 0;
    let statHrJoinHits = 0;
    let statHrJoinMiss = 0;
    function key(trackCode: string, ground: string, t: 'A'|'B'|'C') { return `${trackCode}:${ground}:${t}`; }
    function groundFromTrackCode(tc: string) {
      const s = (tc||'').trim(); const n=Number(s);
      if (s.startsWith('1')) return '芝'; if ((n>=23 && n<=29)||s.startsWith('2')) return 'ダ'; if (n>=51) return '障'; return '';
    }

    type Row = any;
    let curKey = '';
    let raceCorners: Record<number, number[]> = {};
    for (const r of res.rows as Row[]) {
      const raceKey = `${r.keibajo_code}:${r.race_bango}`;
      if (raceKey !== curKey) { raceCorners = {}; curKey = raceKey; }
      const corners = extractCorners(r, cornerCols.length ? cornerCols : ['corner_1']);
      raceCorners[r.umaban] = corners;
      const finish = Number(String(r.__finish||'').trim());
      const tc = String(r.track_code||'').trim();
      const ground = groundFromTrackCode(tc);
      if (!ground || ground==='障') continue;
      const type = classifyPaceTypeForRace(corners);
      if (!type) continue;

      const k = key(String(r.keibajo_code).padStart(2,'0'), ground, type);
      const a = agg.get(k) || { starters:0,wins:0,places:0,winStake:0,winReturn:0,placeStake:0,placeReturn:0 };
      a.starters += 1;
      statTotalStarters += 1;
      if (finish === 1) a.wins += 1;
      if (finish <= 3) a.places += 1;

      // payout lookup with exact date
      const dkey = makeKey(r.kaisai_nen, r.kaisai_tsukihi, r.keibajo_code, r.race_bango);
      const hr = hrMap.get(dkey);
      if (hr) {
        statHrJoinHits += 1;
        // stake only when payout data exists
        a.winStake += 100;
        a.placeStake += 100;
        // tansho
        const pairs = (cols: string[], payCols: string[]) => {
          // pair by head index before alpha suffix (e.g., _1a ↔ _1b)
          function headIdx(c: string) { const m=c.match(/_(\d+)[a-z]$/i); return m? m[1]: '1'; }
          const um = cols.map(c=>({ c, i: headIdx(c) }));
          const py = payCols.map(c=>({ c, i: headIdx(c) }));
          return um.map(u=>({ u: u.c, p: (py.find(x=>x.i===u.i)||py[0])?.c })).filter(x=>x.p);
        };
        const winPairs = pairs(winUmCols, winPayCols);
        for (const pr of winPairs) {
          const u = Number(String(hr[pr.u]).replace(/\D/g,''));
          const pay = Number(String(hr[pr.p]).replace(/\D/g,''));
          if (Number.isFinite(u) && Number.isFinite(pay) && u === Number(r.umaban)) {
            a.winReturn += pay;
          }
        }
        const fukuPairs = pairs(fukuUmCols, fukuPayCols);
        for (const pr of fukuPairs) {
          const u = Number(String(hr[pr.u]).replace(/\D/g,''));
          const pay = Number(String(hr[pr.p]).replace(/\D/g,''));
          if (Number.isFinite(u) && Number.isFinite(pay) && u === Number(r.umaban)) {
            a.placeReturn += pay;
          }
        }
      } else {
        statHrJoinMiss += 1;
      }
      agg.set(k, a);
    }

    const out: any[] = [];
    for (const [k, a] of agg) {
      const [jyo, ground, t] = k.split(':');
      out.push({ track_code: jyo, ground, type: t, starters: a.starters, win_rate: a.wins/a.starters, place_rate: a.places/a.starters, win_roi: a.winReturn/Math.max(1,a.winStake), place_roi: a.placeReturn/Math.max(1,a.placeStake) });
    }
    const outDir = path.join(process.cwd(), 'data', 'analytics'); fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `pace-backtest-${toIso(anchorYmd)}.json`);
    const stats = { starters: statTotalStarters, hr_join_hit: statHrJoinHits, hr_join_miss: statHrJoinMiss };
    fs.writeFileSync(file, JSON.stringify({ from: toIso(fromYmd), to: toIso(toYmd), by: 'track*ground*type', stats, rows: out }, null, 2));
    console.log(`wrote ${file}`);
  } finally {
    await pool.end();
  }
}

main().catch((e)=>{ console.error(e); process.exit(1); });


