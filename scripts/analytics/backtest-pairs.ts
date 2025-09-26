import 'dotenv/config';
import { Pool } from 'pg';
import fs from 'node:fs';
import path from 'node:path';

function toIso(ymd: string) { return `${ymd.slice(0,4)}-${ymd.slice(4,6)}-${ymd.slice(6,8)}`; }
function fromIso(d: Date) { const y=d.getFullYear(); const m=String(d.getMonth()+1).padStart(2,'0'); const dd=String(d.getDate()).padStart(2,'0'); return `${y}${m}${dd}`; }

async function listColumns(pool: Pool, table: string): Promise<Set<string>> {
  const res = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, [table]);
  return new Set(res.rows.map((r:any)=>String(r.column_name)));
}

function extractCorners(row: any, cols: string[]): number[] {
  const out: number[] = [];
  for (const c of cols) {
    const v = row[c]; if (v==null) continue; const s=String(v).trim(); if (!s) continue;
    if (/^\d+$/.test(s)) { const n=Number(s); if (Number.isFinite(n)) out.push(n); continue; }
    const parts = s.split(/[^0-9]+/).filter(Boolean); for (const p of parts) { const n=Number(p); if (Number.isFinite(n)) out.push(n); }
  }
  return out;
}

function classifyType(corners: number[]): 'A'|'B'|'C'|null {
  const seq = corners.filter(n=>Number.isFinite(n)); if (seq.length<2) return null;
  const all4 = seq.every(n=>n<=4); const all5p = seq.every(n=>n>=5);
  if (all4) return 'A'; if (all5p) return 'B'; return 'C';
}

function groundFromTrackCode(tc: string): string { const s=(tc||'').trim(); const n=Number(s); if (s.startsWith('1')) return '芝'; if ((n>=23&&n<=29)||s.startsWith('2')) return 'ダ'; if (n>=51) return '障'; return ''; }

function pad2(n: number){ return String(n).padStart(2,'0'); }
function makePairCode(i:number,j:number){ const a=Math.min(i,j), b=Math.max(i,j); return `${pad2(a)}${pad2(b)}`; }

type PairType = 'BB'|'BC'|'CC';

function generatePairs(kind: PairType, B: number[], C: number[], bN: number, cN: number): string[] {
  const pickB = B.slice(0, bN);
  const pickC = C.slice(0, cN);
  const out: string[] = [];
  if (kind==='BB') {
    for (let i=0;i<pickB.length;i++) for (let j=i+1;j<pickB.length;j++) out.push(makePairCode(pickB[i], pickB[j]));
  } else if (kind==='BC') {
    for (const i of pickB) for (const j of pickC) out.push(makePairCode(i,j));
  } else if (kind==='CC') {
    for (let i=0;i<pickC.length;i++) for (let j=i+1;j<pickC.length;j++) out.push(makePairCode(pickC[i], pickC[j]));
  }
  return Array.from(new Set(out));
}

async function main(){
  const raw=process.argv.slice(2);
  const anchorYmd = raw[0] && /^\d{8}$/.test(raw[0]) ? raw[0] : fromIso(new Date());
  const years = Math.max(1, Number(raw[1]||'3')||3);
  const toYmd = anchorYmd; const d=new Date(Number(anchorYmd.slice(0,4)), Number(anchorYmd.slice(4,6))-1, Number(anchorYmd.slice(6,8))); d.setFullYear(d.getFullYear()-years); const fromYmd = fromIso(d);
  const pool = new Pool({ connectionString: process.env.PG_DSN });
  try{
    const seCols = await listColumns(pool, 'jvd_se');
    const cornerCols = ['corner_1','corner_2','corner_3','corner_4'].filter(c=>seCols.has(c));
    const finishCandidates = ['kakutei_juni','kakuteijuni','kakutei_jyuni','kettei_juni','chakujun','kakutei_chakujun'];
    const finishCol = finishCandidates.find(c=>seCols.has(c)) || 'chakujun';

    const sql = `
      SELECT ra.keibajo_code, ra.track_code, ra.race_bango,
             se.kaisai_nen, se.kaisai_tsukihi,
             se.umaban, ${cornerCols.length? cornerCols.map(c=>`se.${c}`).join(',') : 'NULL AS corner_1'},
             se.${finishCol} AS __finish
      FROM public.jvd_se se
      JOIN public.jvd_ra ra
        ON TRIM(se.kaisai_nen)=TRIM(ra.kaisai_nen)
       AND TRIM(se.kaisai_tsukihi)=TRIM(ra.kaisai_tsukihi)
       AND TRIM(se.keibajo_code)=TRIM(ra.keibajo_code)
       AND TRIM(se.race_bango)=TRIM(ra.race_bango)
      WHERE se.kaisai_nen ~ '^\\d{4}$' AND se.kaisai_tsukihi ~ '^\\d{4}$'
        AND (CAST(se.kaisai_nen AS INTEGER)*10000 + CAST(se.kaisai_tsukihi AS INTEGER)) BETWEEN $1 AND $2
        AND COALESCE(NULLIF(TRIM(se.data_kubun),''),'') IN ('6','7')
      ORDER BY CAST(se.kaisai_nen AS INTEGER), CAST(se.kaisai_tsukihi AS INTEGER), CAST(ra.keibajo_code AS INTEGER), CAST(ra.race_bango AS INTEGER), CAST(se.umaban AS INTEGER)
    `;
    const res = await pool.query(sql, [Number(fromYmd), Number(toYmd)]);

    // 払戻（馬連・ワイド）
    const hrTable='jvd_hr';
    const hrCols = await listColumns(pool, hrTable);
    const pickPairs = (prefix: string) => {
      const A = Array.from(hrCols).filter(c=>new RegExp(`haraimodoshi_${prefix}_\\d+a$`).test(c));
      const B = Array.from(hrCols).filter(c=>new RegExp(`haraimodoshi_${prefix}_\\d+b$`).test(c));
      const headIdx=(c:string)=>{ const m=c.match(/_(\d+)[a-z]$/i); return m? m[1]:'1'; };
      return A.map(a=>({ a, b: (B.find(b=>headIdx(b)===headIdx(a))||B[0])})).filter(x=>x.b);
    };
    const umarenPairs = pickPairs('umaren');
    const widePairs = pickPairs('wide');

    const payoutSql = `
      SELECT kaisai_nen AS y, kaisai_tsukihi AS md, keibajo_code AS jyo, race_bango AS rc,
             ${[...umarenPairs.map(p=>`COALESCE(${p.a},'') AS ${p.a}`), ...umarenPairs.map(p=>`COALESCE(${p.b},'0') AS ${p.b}`),
                ...widePairs.map(p=>`COALESCE(${p.a},'') AS ${p.a}`), ...widePairs.map(p=>`COALESCE(${p.b},'0') AS ${p.b}`)].join(',')}
      FROM public.${hrTable}
      WHERE kaisai_nen ~ '^\\d{4}$' AND kaisai_tsukihi ~ '^\\d{4}$'
        AND (CAST(kaisai_nen AS INTEGER)*10000 + CAST(kaisai_tsukihi AS INTEGER)) BETWEEN $1 AND $2
    `;
    const hrRes = await pool.query(payoutSql, [Number(fromYmd), Number(toYmd)]);
    const hrMap = new Map<string, { umaren: Map<string,number>, wide: Map<string,number> }>();
    const norm=(s:any)=>String(s||'').replace(/\D/g,'');
    const kf=(y:any,md:any,j:any,rc:any)=>`${String(y).trim()}:${String(md).trim()}:${String(j).replace(/\D/g,'')}:${String(rc).replace(/\D/g,'')}`;
    for (const r of hrRes.rows as any[]) {
      const key = kf(r.y, r.md, r.jyo, r.rc);
      const um = new Map<string, number>();
      for (const p of umarenPairs) { const a=norm(r[p.a]); const b=Number(norm(r[p.b])); if (a && b>0) um.set(a.padStart(4,'0'), b); }
      const wd = new Map<string, number>();
      for (const p of widePairs) { const a=norm(r[p.a]); const b=Number(norm(r[p.b])); if (a && b>0) wd.set(a.padStart(4,'0'), b); }
      hrMap.set(key, { umaren: um, wide: wd });
    }

    type Agg = { stake: number; ret: number; hit: number; races: number };
    const aggUmaren = new Map<string, Agg>();
    const aggWide = new Map<string, Agg>();

    let curKey='';
    const raceHorses: Record<number, { type:'A'|'B'|'C'|null }>= {};
    const rowsAny = res.rows as any[];
    for (let i=0; i<rowsAny.length; i++) {
      const row = rowsAny[i];
      const raceKey = `${row.kaisai_nen}:${row.kaisai_tsukihi}:${row.keibajo_code}:${row.race_bango}`;
      const next = rowsAny[i+1];
      const nextKey = next ? `${next.kaisai_nen}:${next.kaisai_tsukihi}:${next.keibajo_code}:${next.race_bango}` : '';
      if (raceKey !== curKey) { curKey = raceKey; for (const k of Object.keys(raceHorses)) delete raceHorses[Number(k)]; }
      const corners = extractCorners(row, cornerCols.length?cornerCols:['corner_1']);
      raceHorses[Number(row.umaban)] = { type: classifyType(corners) };

      const isLastInRace = raceKey !== nextKey;
      if (!isLastInRace) continue;

      const y=row.kaisai_nen, md=row.kaisai_tsukihi, jyo=row.keibajo_code, rc=row.race_bango;
      const hk = kf(y,md,jyo,rc);
      const payout = hrMap.get(hk);
      const A = Object.entries(raceHorses).filter(([,v])=>v.type==='A').map(([n])=>Number(n)).sort((a,b)=>a-b);
      if (A.length>0) continue; // A不在レースのみ対象
      const B = Object.entries(raceHorses).filter(([,v])=>v.type==='B').map(([n])=>Number(n)).sort((a,b)=>a-b);
      const C = Object.entries(raceHorses).filter(([,v])=>v.type==='C'||v.type===null).map(([n])=>Number(n)).sort((a,b)=>a-b);

      const gridB = [1,2,3,4];
      const gridC = [1,2,3,4];
      const caps = [3,5,10];
      const kinds: PairType[] = ['BB','BC','CC'];
      for (const kind of kinds){
        for (const bN of gridB){
          for (const cN of gridC){
            for (const cap of caps){
              const pairs = generatePairs(kind, B, C, bN, cN).slice(0, cap);
              if (pairs.length===0) continue;
              const key = `${kind}|B${bN}|C${cN}|cap${cap}`;
              const target = (m:Map<string,Agg>)=>{ const a=m.get(key)||{stake:0,ret:0,hit:0,races:0}; a.stake += pairs.length*100; a.races += 1; return a; };
              if (payout){
                // 馬連
                let a = target(aggUmaren);
                let returned = 0; for (const cb of pairs){ const pay=payout.umaren.get(cb); if (pay){ returned += pay; a.hit += 1; break; } }
                a.ret += returned; aggUmaren.set(key,a);
                // ワイド（複数的中もあるが代表的に最初のヒットのみ加算に留める）
                a = target(aggWide);
                let returnedW = 0; for (const cb of pairs){ const pay=payout.wide.get(cb); if (pay){ returnedW += pay; a.hit += 1; /*break;*/ } }
                a.ret += returnedW; aggWide.set(key,a);
              } else {
                // payoutなしでも races/stake はカウント
                aggUmaren.set(key, target(aggUmaren));
                aggWide.set(key, target(aggWide));
              }
            }
          }
        }
      }
    }

    const rows = (m:Map<string, Agg>, market:'umaren'|'wide') => Array.from(m.entries()).map(([key,a])=>{
      const [kind, Bkey, Ckey, capKey] = key.split('|');
      const points = Math.round(a.stake/100);
      return { market, pair: kind, B: Bkey, C: Ckey, cap: capKey, points, stake: a.stake, ret: a.ret, roi: a.stake>0? a.ret/a.stake:0, hit: a.hit, races: a.races };
    }).sort((x,y)=> y.roi - x.roi || y.ret - x.ret);

    const outPath = path.join(process.cwd(),'data','analytics',`pairs-backtest-${toIso(anchorYmd)}.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({ from: toIso(fromYmd), to: toIso(toYmd), rows: [...rows(aggUmaren,'umaren'), ...rows(aggWide,'wide')] }, null, 2));
    console.log(`wrote ${outPath}`);
  } finally { await pool.end(); }
}

main().catch(e=>{ console.error(e); process.exit(1); });


