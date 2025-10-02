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

function classifyTypesFromPassages(passages: string[]): Array<'A'|'B'|'C'> {
  let all4 = 0, nige = 0;
  for (const p of passages) {
    const parts = String(p).split('-').map((s)=>Number(s)).filter((n)=>Number.isFinite(n));
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

function groundFromTrackCode(tc: string): string { const s=(tc||'').trim(); const n=Number(s); if (s.startsWith('1')) return '芝'; if ((n>=23&&n<=29)||s.startsWith('2')) return 'ダ'; if (n>=51) return '障'; return ''; }

function pad2(n: number){ return String(n).padStart(2,'0'); }
function makePairCode(i:number,j:number){ const a=Math.min(i,j), b=Math.max(i,j); return `${pad2(a)}${pad2(b)}`; }

type PairType = 'AA'|'AB'|'BB';

function generatePairs(kind: PairType, A: number[], B: number[], _C: number[], aN: number, bN: number, _cN: number): string[] {
  const pickA = A.slice(0, aN);
  const pickB = B.slice(0, bN);
  const out: string[] = [];
  if (kind==='AA') {
    for (let i=0;i<pickA.length;i++) for (let j=i+1;j<pickA.length;j++) out.push(makePairCode(pickA[i], pickA[j]));
  } else if (kind==='AB') {
    for (const i of pickA) for (const j of pickB) out.push(makePairCode(i,j));
  } else if (kind==='BB') {
    for (let i=0;i<pickB.length;i++) for (let j=i+1;j<pickB.length;j++) out.push(makePairCode(pickB[i], pickB[j]));
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
        AND COALESCE(NULLIF(TRIM(se.data_kubun),''),'') IN ('6','7')
        AND ra.keibajo_code ~ '^\\d+$' AND ra.race_bango ~ '^\\d+$'
      ORDER BY CAST(se.kaisai_nen AS INTEGER), CAST(se.kaisai_tsukihi AS INTEGER),
               CAST(REGEXP_REPLACE(ra.keibajo_code, '\\D+', '', 'g') AS INTEGER),
               CAST(REGEXP_REPLACE(ra.race_bango, '\\D+', '', 'g') AS INTEGER),
               CAST(REGEXP_REPLACE(se.umaban::text, '\\D+', '', 'g') AS INTEGER)
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
    const toUmarenCode = (raw:any): string | undefined => {
      const s = String(raw||'').trim();
      if (!s) return undefined;
      // パターン1: 区切り文字あり（例: 1-2, 01=02, 1 / 2）
      const m = s.match(/(\d{1,2})\D+(\d{1,2})/);
      if (m) {
        const a = Number(m[1]); const b = Number(m[2]);
        if (a>0 && b>0) return makePairCode(a,b);
      }
      // パターン2: 数字のみ（例: 0102, 1203 など2桁+2桁）
      const digits = s.replace(/\D/g,'');
      if (digits.length === 4) {
        const a = Number(digits.slice(0,2));
        const b = Number(digits.slice(2,4));
        if (a>0 && b>0) return makePairCode(a,b);
      }
      // パターン3: 3桁（例: 112 → 1と12 とみなす）
      if (digits.length === 3) {
        const a = Number(digits.slice(0,1));
        const b = Number(digits.slice(1,3));
        if (a>0 && b>0) return makePairCode(a,b);
      }
      return undefined;
    };
    const kf=(y:any,md:any,j:any,rc:any)=>`${String(y).trim()}:${String(md).trim()}:${String(j).replace(/\D/g,'')}:${String(rc).replace(/\D/g,'')}`;
    for (const r of hrRes.rows as any[]) {
      const key = kf(r.y, r.md, r.jyo, r.rc);
      const um = new Map<string, number>();
      for (const p of umarenPairs) {
        const code = toUmarenCode(r[p.a]);
        const pay = Number(norm(r[p.b]));
        if (code && pay>0) um.set(code, pay);
      }
      const wd = new Map<string, number>();
      for (const p of widePairs) { const a=norm(r[p.a]); const b=Number(norm(r[p.b])); if (a && b>0) wd.set(a.padStart(4,'0'), b); }
      hrMap.set(key, { umaren: um, wide: wd });
    }

    type Agg = { stake: number; ret: number; hit: number; races: number };
    const aggUmaren = new Map<string, Agg>();
    const aggWide = new Map<string, Agg>();

    let curKey='';
    const raceHorseIds: Record<number, string> = {};
    const rowsAny = res.rows as any[];
    for (let i=0; i<rowsAny.length; i++) {
      const row = rowsAny[i];
      const raceKey = `${row.kaisai_nen}:${row.kaisai_tsukihi}:${row.keibajo_code}:${row.race_bango}`;
      const next = rowsAny[i+1];
      const nextKey = next ? `${next.kaisai_nen}:${next.kaisai_tsukihi}:${next.keibajo_code}:${next.race_bango}` : '';
      if (raceKey !== curKey) { curKey = raceKey; for (const k of Object.keys(raceHorseIds)) delete raceHorseIds[Number(k)]; }
      raceHorseIds[Number(row.umaban)] = String(row.ketto_toroku_bango||'');

      const isLastInRace = raceKey !== nextKey;
      if (!isLastInRace) continue;

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
      // ここではA不在フィルタを外し、ABC全組み合わせを評価

      const gridA = [1,2,3];
      const gridB = [1,2,3,4];
      const gridC = [1,2,3,4];
      const caps = [Number.POSITIVE_INFINITY];
      // 条件: Aがいる場合 → A軸（AA/AB/AC）。Aが不在 → B軸（BB/BC）。Cのみは対象外。
      const kinds: PairType[] = A.length>0 ? ['AA','AB'] : (B.length>0 ? ['BB'] : []);
      if (kinds.length===0) continue; // Cのみのレースは対象外
      // 層別キー: 競馬場コード、馬場、展開バイアス
      const jyoCode = String(jyo).replace(/\D/g,'');
      const ground = groundFromTrackCode(String(row.track_code||''));
      // 展開バイアス指標: C:+0.5, B:+1.0, A不在:-2.5, A≥2:+1.5, B≤2:-1.0
      const paceScore = (C.length * 0.5) + (B.length * 1.0)
        + (A.length===0 ? -2.5 : 0) + (A.length>=2 ? 1.5 : 0) + (B.length<=2 ? -1.0 : 0);
      const biasFlag = (paceScore <= 4.0) && (paceScore !== -3.5);
      for (const kind of kinds){
        for (const aN of gridA){
          for (const bN of gridB){
            for (const cN of gridC){
              for (const cap of caps){
                if (kind.includes('A') && A.length < (kind==='AA'?2:aN)) continue;
                if (kind.includes('B') && B.length < (kind==='BB'?2:bN)) continue;
                // C軸は扱わない
                const pairs = generatePairs(kind, A, B, C, aN, bN, cN).slice(0, cap);
                if (pairs.length===0) continue;
                const capTag = 'cap∞';
                const key = `${kind}|A${aN}|B${bN}|${capTag}|j:${jyoCode}|g:${ground}|b:${biasFlag ? '1' : '0'}`;
                const target = (m:Map<string,Agg>)=>{ const a=m.get(key)||{stake:0,ret:0,hit:0,races:0}; a.stake += pairs.length*100; a.races += 1; return a; };
                if (payout){
                  // 馬連
                  let a = target(aggUmaren);
                  let returned = 0; for (const cb of pairs){ const pay=payout.umaren.get(cb); if (pay){ returned += pay; a.hit += 1; break; } }
                  a.ret += returned; aggUmaren.set(key,a);
                  // ワイド（複数的中もあるが代表的に最初のヒットのみ加算に留める）
                  a = target(aggWide);
                  let returnedW = 0; for (const cb of pairs){ const pay=payout.wide.get(cb); if (pay){ returnedW += pay; a.hit += 1; } }
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
    }

    const rows = (m:Map<string, Agg>, market:'umaren'|'wide') => Array.from(m.entries()).map(([key,a])=>{
      const parts = key.split('|');
      const kind = parts[0] as PairType;
      // 期待フォーマット: kind|A#|B#|cap#
      let Akey = '';
      let Bkey = '';
      let capKey = '';
      let jyoOut = '';
      let groundOut = '';
      let biasOut: string | undefined = undefined;
      for (const p of parts.slice(1)) {
        if (p.startsWith('A')) Akey = p;
        else if (p.startsWith('B')) Bkey = p;
        else if (p.startsWith('cap')) capKey = p;
        else if (p.startsWith('j:')) jyoOut = p.slice(2);
        else if (p.startsWith('g:')) groundOut = p.slice(2);
        else if (p.startsWith('b:')) biasOut = p.slice(2);
      }
      const points = Math.round(a.stake/100);
      return { market, pair: kind, A: Akey || undefined, B: Bkey, C: '', cap: capKey, points, stake: a.stake, ret: a.ret, roi: a.stake>0? a.ret/a.stake:0, hit: a.hit, races: a.races, jyo: jyoOut, ground: groundOut, bias_flag: biasOut ? (biasOut==='1') : undefined } as any;
    }).sort((x,y)=> y.roi - x.roi || y.ret - x.ret);

    const outPath = path.join(process.cwd(),'data','analytics',`pairs-backtest-${toIso(anchorYmd)}.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    // 馬連のみを出力（ワイドは現状不採用）
    fs.writeFileSync(outPath, JSON.stringify({ from: toIso(fromYmd), to: toIso(toYmd), rows: rows(aggUmaren,'umaren') }, null, 2));
    console.log(`wrote ${outPath}`);
  } catch (err) {
    console.error(err);
    throw err;
  } finally { await pool.end(); }
}

main().catch(e=>{ console.error(e); process.exit(1); });


