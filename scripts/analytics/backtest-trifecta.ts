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

// 展開タイプ（過去3走）判定に必要なユーティリティ
function classifyTypesFromPassages(passages: string[]): Array<'A'|'B'|'C'> {
  let all4 = 0, nige = 0;
  for (const p of passages) {
    const raw = String(p).split('-').map((s)=>Number(s)).filter((n)=>Number.isFinite(n));
    const parts = raw.filter((n)=> n > 0); // 0 は未計測扱いで除外
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

async function fetchPassagesForHorsesBefore(pool: Pool, horseIds: string[], yyyymmdd: string) {
  if (horseIds.length === 0) return new Map<string, string[]>();
  const targetNum = Number(`${yyyymmdd.slice(0,4)}${yyyymmdd.slice(4,8)}`);
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
    const present = c.filter((x) => x && /^\d+$/.test(x)).map((x) => Number(x)).filter((n)=>n>0);
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

function groundFromTrackCode(tc: string): string { const s=(tc||'').trim(); const n=Number(s); if (s.startsWith('1')) return '芝'; if ((n>=23&&n<=29)||s.startsWith('2')) return 'ダ'; if (n>=51) return '障'; return ''; }

type PatternKey = 'A-A-BC'|'A-BC-ABC'|'BC-A-BC'|'B-B-BC'|'B-BC-BC'|'BC-B-BC'|'C-C-C';

function generateTrifecta(pattern: PatternKey, A: number[], B: number[], C: number[]): string[] {
  const BC = Array.from(new Set([...B,...C]));
  const ABC = Array.from(new Set([...A,...B,...C]));
  const fmt=(n:number)=>String(n).padStart(2,'0');
  const out: string[] = [];
  const add=(i:number,j:number,k:number)=>{ if (i!==j&&j!==k&&i!==k) out.push(`${fmt(i)}${fmt(j)}${fmt(k)}`); };
  const each=(arr:number[], fn:(x:number)=>void)=>{ for(const x of arr) fn(x); };
  switch(pattern){
    case 'A-A-BC': each(A,x=>each(A,y=>{ if (y!==x) each(BC,z=>add(x,y,z)); })); break;
    case 'A-BC-ABC': each(A,x=>each(BC,y=>each(ABC,z=>add(x,y,z)))); break;
    case 'BC-A-BC': each(BC,x=>each(A,y=>each(BC,z=>add(x,y,z)))); break;
    case 'B-B-BC': each(B,x=>each(B,y=>{ if (y!==x) each(BC,z=>add(x,y,z)); })); break;
    case 'B-BC-BC': each(B,x=>each(BC,y=>each(BC,z=>add(x,y,z)))); break;
    case 'BC-B-BC': each(BC,x=>each(B,y=>each(BC,z=>add(x,y,z)))); break;
    case 'C-C-C': const L=C.slice(0,5); for(let i of L) for(let j of L) for(let k of L) add(i,j,k); break;
  }
  // 去重
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

    // 払戻（3連単）
    const hrTable='jvd_hr';
    const hrCols = await listColumns(pool, hrTable);
    const sanColsA = ['haraimodoshi_sanrentan_1a','haraimodoshi_sanrentan_2a','haraimodoshi_sanrentan_3a','haraimodoshi_sanrentan_4a','haraimodoshi_sanrentan_5a','haraimodoshi_sanrentan_6a'].filter(c=>hrCols.has(c));
    const sanColsB = ['haraimodoshi_sanrentan_1b','haraimodoshi_sanrentan_2b','haraimodoshi_sanrentan_3b','haraimodoshi_sanrentan_4b','haraimodoshi_sanrentan_5b','haraimodoshi_sanrentan_6b'].filter(c=>hrCols.has(c));
    function headIdx(c:string){ const m=c.match(/_(\d+)[a-z]$/i); return m? m[1]:'1'; }
    const pairs = sanColsA.map(a=>({a, b: (sanColsB.find(b=>headIdx(b)===headIdx(a))||sanColsB[0])})).filter(x=>x.b);

    const sql = `
      SELECT ra.keibajo_code, ra.track_code, ra.race_bango,
             se.kaisai_nen, se.kaisai_tsukihi,
             se.ketto_toroku_bango,
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
        AND ra.keibajo_code ~ '^\\d+$' AND ra.race_bango ~ '^\\d+$'
      ORDER BY CAST(se.kaisai_nen AS INTEGER), CAST(se.kaisai_tsukihi AS INTEGER),
               CAST(REGEXP_REPLACE(ra.keibajo_code, '\\D+', '', 'g') AS INTEGER),
               CAST(REGEXP_REPLACE(ra.race_bango, '\\D+', '', 'g') AS INTEGER),
               CAST(REGEXP_REPLACE(se.umaban::text, '\\D+', '', 'g') AS INTEGER)
    `;
    const res = await pool.query(sql, [Number(fromYmd), Number(toYmd)]);

    // 3連単払戻をレースキーでロード
    const payoutSql = `
      SELECT kaisai_nen AS y, kaisai_tsukihi AS md, keibajo_code AS jyo, race_bango AS rc,
             ${[...pairs.map(p=>`COALESCE(${p.a},'') AS ${p.a}`), ...pairs.map(p=>`COALESCE(${p.b},'0') AS ${p.b}`)].join(',')}
      FROM public.${hrTable}
      WHERE kaisai_nen ~ '^\\d{4}$' AND kaisai_tsukihi ~ '^\\d{4}$'
        AND (CAST(kaisai_nen AS INTEGER)*10000 + CAST(kaisai_tsukihi AS INTEGER)) BETWEEN $1 AND $2
    `;
    const hrRes = await pool.query(payoutSql, [Number(fromYmd), Number(toYmd)]);
    const hrMap = new Map<string, { combos:Set<string>; pay: Map<string,number> }>();
    const norm=(s:any)=>String(s||'').replace(/\D/g,'');
    const kf=(y:any,md:any,j:any,rc:any)=>`${String(y).trim()}:${String(md).trim()}:${String(j).replace(/\D/g,'')}:${String(rc).replace(/\D/g,'')}`;
    for (const r of hrRes.rows as any[]) {
      const key = kf(r.y, r.md, r.jyo, r.rc);
      const combos = new Set<string>();
      const pay = new Map<string, number>();
      for (const p of pairs) {
        const a=norm(r[p.a]); const b=Number(norm(r[p.b])); if (a && b>0) { combos.add(a.padStart(6,'0')); pay.set(a.padStart(6,'0'), b); }
      }
      hrMap.set(key, { combos, pay });
    }

    type Agg = { stake: number; ret: number; hit: number; races: number };
    const agg = new Map<string, Agg>();
    const stat = { races:0 };

    let curKey='';
    const raceHorseIds: Record<number, string> = {};
    const rowsAny = res.rows as any[];
    for (let i=0; i<rowsAny.length; i++) {
      const row = rowsAny[i];
      const raceKey = `${row.kaisai_nen}:${row.kaisai_tsukihi}:${row.keibajo_code}:${row.race_bango}`;
      const next = rowsAny[i+1];
      const nextKey = next ? `${next.kaisai_nen}:${next.kaisai_tsukihi}:${next.keibajo_code}:${next.race_bango}` : '';

      if (raceKey !== curKey) {
        curKey = raceKey;
        for (const k of Object.keys(raceHorseIds)) delete raceHorseIds[Number(k)];
      }
      // 馬IDを保持
      raceHorseIds[Number(row.umaban)] = String(row.ketto_toroku_bango||'');

      const isLastInRace = raceKey !== nextKey;
      if (!isLastInRace) continue;

      // レース単位で1回だけ集計
      stat.races += 1;
      const y=row.kaisai_nen, md=row.kaisai_tsukihi, jyo=row.keibajo_code, rc=row.race_bango;
      const hk = kf(y,md,jyo,rc);
      const payout = hrMap.get(hk);
      const ymd = String(y).padStart(4,'0') + String(md).padStart(4,'0');
      const idList = Object.values(raceHorseIds).filter(Boolean);
      const passMap = await fetchPassagesForHorsesBefore(pool, idList, ymd);
      const A: number[] = []; const B: number[] = []; const C: number[] = [];
      for (const [umastr, id] of Object.entries(raceHorseIds)) {
        const passages = passMap.get(id) || [];
        const types = classifyTypesFromPassages(passages);
        const uma = Number(umastr);
        if (types.includes('A')) A.push(uma);
        if (types.includes('B')) B.push(uma);
        if (types.includes('C')) C.push(uma);
      }
      A.sort((a,b)=>a-b); B.sort((a,b)=>a-b); C.sort((a,b)=>a-b);
      const patterns: PatternKey[] = A.length>0 ? ['A-A-BC','A-BC-ABC','BC-A-BC'] : (B.length>0 ? ['B-B-BC','B-BC-BC','BC-B-BC'] : []);
      const gridA = [1,2];
      const gridB = [1,2];
      const gridC = [1,2];
      const caps = [50,100];
      for (const p of patterns){
        for (const aN of gridA){
          for (const bN of gridB){
            for (const cN of gridC){
              for (const cap of caps){
                // 必要頭数が満たないパターンはスキップ
                if ((/A/.test(p) && A.length < aN) || (/B/.test(p) && B.length < bN) || (/C/.test(p) && C.length < cN)) { continue; }
                const combosFull = generateTrifecta(p, A.slice(0,aN), B.slice(0,bN), C.slice(0,cN));
                const combos = combosFull.slice(0, cap);
                const key = `${p}|A${aN}|B${bN}|C${cN}|cap${cap}`;
                const ag = agg.get(key)||{stake:0,ret:0,hit:0,races:0};
                if (combos.length === 0) { continue; }
                ag.stake += combos.length*100; ag.races += 1;
                if (payout){
                  let returned = 0; for (const cb of combos){ const pay=payout.pay.get(cb); if (pay){ returned += pay; ag.hit += 1; break; } }
                  ag.ret += returned;
                }
                agg.set(key,ag);
              }
            }
          }
        }
      }
    }

    const rows = Array.from(agg.entries()).map(([key,a])=>{
      const [pattern, Akey, Bkey, Ckey, capKey] = key.split('|');
      const points = Math.round(a.stake/100);
      return { pattern, A: Akey, B: Bkey, C: Ckey, cap: capKey, points, stake: a.stake, ret: a.ret, roi: a.stake>0? a.ret/a.stake:0, hit: a.hit, races: a.races };
    });
    const outPath = path.join(process.cwd(),'data','analytics',`trifecta-backtest-${toIso(anchorYmd)}.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({ from: toIso(fromYmd), to: toIso(toYmd), rows: rows.sort((a,b)=>b.roi-a.roi) }, null, 2));
    console.log(`wrote ${outPath}`);
  } finally { await pool.end(); }
}

main().catch(e=>{ console.error(e); process.exit(1); });


