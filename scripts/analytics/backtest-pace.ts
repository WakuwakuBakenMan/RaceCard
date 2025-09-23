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

    const hrTable = await findPayoutTable(pool);
    const hrCols = await listColumns(pool, hrTable);
    const winUmCols = Array.from(hrCols).filter(c=>/tansho.*umaban/i.test(c));
    const winPayCols = Array.from(hrCols).filter(c=>/tansho.*pay|tansho.*haraimodoshi/i.test(c));
    const fukuUmCols = Array.from(hrCols).filter(c=>/fukusho.*umaban/i.test(c)).sort();
    const fukuPayCols = Array.from(hrCols).filter(c=>/fukusho.*pay|fukusho.*haraimodoshi/i.test(c)).sort();

    const sql = `
      SELECT ra.keibajo_code, ra.track_code, ra.race_bango,
             se.kaisai_nen, se.kaisai_tsukihi,
             se.umaban, se.wakuban, se.${finishCol} AS __finish,
             ${cornerCols.length ? cornerCols.map(c=>`se.${c}`).join(',') : 'NULL AS corner_1'}
      FROM public.jvd_se se
      JOIN public.jvd_ra ra ON CAST(se.kaisai_nen AS INTEGER)=CAST(ra.kaisai_nen AS INTEGER)
        AND CAST(se.kaisai_tsukihi AS INTEGER)=CAST(ra.kaisai_tsukihi AS INTEGER)
        AND CAST(se.keibajo_code AS INTEGER)=CAST(ra.keibajo_code AS INTEGER)
        AND CAST(se.race_bango AS INTEGER)=CAST(ra.race_bango AS INTEGER)
      WHERE (CAST(se.kaisai_nen AS INTEGER)*10000 + CAST(se.kaisai_tsukihi AS INTEGER)) BETWEEN $1 AND $2
        AND COALESCE(NULLIF(TRIM(se.data_kubun),''),'') IN ('6','7')
      ORDER BY CAST(ra.keibajo_code AS INTEGER), CAST(ra.race_bango AS INTEGER), CAST(se.umaban AS INTEGER)
    `;
    const res = await pool.query(sql, [Number(fromYmd), Number(toYmd)]);

    // Payouts per race
    const payoutSql = `
      SELECT ${winUmCols.concat(winPayCols).concat(fukuUmCols).concat(fukuPayCols).map(c=>`hr.${c}`).join(',')},
             hr.kaisai_nen, hr.kaisai_tsukihi, hr.keibajo_code, hr.race_bango
      FROM public.${hrTable} hr
      WHERE (CAST(hr.kaisai_nen AS INTEGER)*10000 + CAST(hr.kaisai_tsukihi AS INTEGER)) BETWEEN $1 AND $2
    `;
    const hrRes = await pool.query(payoutSql, [Number(fromYmd), Number(toYmd)]);
    const hrMap = new Map<string, any>();
    for (const r of hrRes.rows as any[]) {
      const k = `${r.kaisai_nen}:${r.kaisai_tsukihi}:${r.keibajo_code}:${r.race_bango}`;
      hrMap.set(k, r);
    }

    // Aggregate by track+ground+type
    const agg = new Map<string, Agg>();
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
      if (finish === 1) a.wins += 1;
      if (finish <= 3) a.places += 1;

      // payout lookup with exact date
      const dkey = `${String(r.kaisai_nen)}:${String(r.kaisai_tsukihi)}:${r.keibajo_code}:${r.race_bango}`;
      const hr = hrMap.get(dkey);
      if (hr) {
        // stake only when payout data exists
        a.winStake += 100;
        a.placeStake += 100;
        // tansho
        const pairs = (cols: string[], payCols: string[]) => {
          // pair by numeric suffix; default '1' for no suffix
          function idxOf(c: string) { const m=c.match(/(\d+)$/); return m? m[1]: '1'; }
          const um = cols.map(c=>({ c, i: idxOf(c) }));
          const py = payCols.map(c=>({ c, i: idxOf(c) }));
          return um.map(u=>({ u: u.c, p: (py.find(x=>x.i===u.i)||py[0])?.c })).filter(x=>x.p);
        };
        const winPairs = pairs(winUmCols, winPayCols);
        for (const pr of winPairs) {
          const u = Number(hr[pr.u]);
          const pay = Number(hr[pr.p]);
          if (Number.isFinite(u) && Number.isFinite(pay) && u === Number(r.umaban)) {
            a.winReturn += pay;
          }
        }
        const fukuPairs = pairs(fukuUmCols, fukuPayCols);
        for (const pr of fukuPairs) {
          const u = Number(hr[pr.u]);
          const pay = Number(hr[pr.p]);
          if (Number.isFinite(u) && Number.isFinite(pay) && u === Number(r.umaban)) {
            a.placeReturn += pay;
          }
        }
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
    fs.writeFileSync(file, JSON.stringify({ from: toIso(fromYmd), to: toIso(toYmd), by: 'track*ground*type', rows: out }, null, 2));
    console.log(`wrote ${file}`);
  } finally {
    await pool.end();
  }
}

main().catch((e)=>{ console.error(e); process.exit(1); });


