import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

type Horse = {
  num: number;
  draw: number;
  name: string;
  odds?: number;
  popularity?: number;
  pace_type?: Array<'A'|'B'|'C'>;
};
type Race = {
  no: number;
  name: string;
  distance_m: number;
  ground: string; // '芝' | 'ダ' | '障' など
  pace_score?: number;
  pace_mark?: string;
  horses: Horse[];
};
type Meeting = {
  track: string;
  kaiji: number;
  nichiji: number;
  races: Race[];
};
type RaceDay = { date: string; meetings: Meeting[] };

type RaceReco = {
  track: string;
  no: number;
  win?: number[];
  place?: number[];
  quinella_box?: number[]; // 2-3頭
  trifecta_summary?: Array<{ pattern: string; points: number }>; // 三連単の要約
  trifecta_picks?: { A?: number[]; B?: number[]; C?: number[] }; // 採用馬要約
  notes?: string[];
};
type DayReco = { date: string; races: RaceReco[] };

function ensureDir(p: string) { fs.mkdirSync(p, { recursive: true }); }
type PaceBackRow = { track_code: string; ground: string; type: 'A'|'B'|'C'; win_roi: number; place_roi: number };
type PaceBack = { rows: PaceBackRow[] };
type TriRow = { pattern: string; A: string; B: string; C: string; cap: string; roi: number };

function loadBacktest(): Map<string, { win: number; place: number }> {
  // 最新の pace-backtest-*.json を読み込み、キー: jyo-ground-type で ROI を返す
  const dir = path.join(process.cwd(), 'data', 'analytics');
  if (!fs.existsSync(dir)) return new Map();
  const files = fs.readdirSync(dir).filter(f=>/^pace-backtest-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  if (files.length === 0) return new Map();
  const j = JSON.parse(fs.readFileSync(path.join(dir, files[files.length-1]), 'utf8')) as PaceBack;
  const m = new Map<string, { win: number; place: number }>();
  for (const r of (j.rows||[])) {
    const k = `${r.track_code}:${r.ground}:${r.type}`;
    m.set(k, { win: Number(r.win_roi||0), place: Number(r.place_roi||0) });
  }
  return m;
}

function loadTrifectaBacktest(minRoi = 1.0): Array<{ pattern: 'A-A-BC'|'A-BC-ABC'|'BC-A-BC'|'B-B-BC'|'B-BC-BC'|'BC-B-BC'|'C-C-C'; aN: number; bN: number; cN: number; cap: number }> {
  const dir = path.join(process.cwd(), 'data', 'analytics');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f=>/^trifecta-backtest-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort() : [];
  if (files.length === 0) return [];
  const j = JSON.parse(fs.readFileSync(path.join(dir, files[files.length-1]), 'utf8')) as { rows: TriRow[] };
  const out: Array<{ pattern: any; aN: number; bN: number; cN: number; cap: number }> = [];
  for (const r of (j.rows||[])) {
    if (typeof r.roi !== 'number' || r.roi < minRoi) continue;
    const parseN = (s: string) => Number(String(s||'').replace(/^[A-C]/i,'').trim()) || 0;
    const parseCap = (s: string) => Number(String(s||'').replace(/^cap/i,'').trim()) || 0;
    out.push({ pattern: r.pattern as any, aN: parseN(r.A), bN: parseN(r.B), cN: parseN(r.C), cap: parseCap(r.cap) });
  }
  return out;
}


function toIso(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0,4)}-${yyyymmdd.slice(4,6)}-${yyyymmdd.slice(6,8)}`;
}

function impliedProb(odds?: number): number | undefined {
  if (typeof odds !== 'number' || !(odds > 0)) return undefined;
  return 1 / odds;
}

function favoredTypesByPace(r: Race): Array<'A'|'B'|'C'> {
  const s = typeof r.pace_score === 'number' ? r.pace_score : undefined;
  if (s == null) return [];
  // ざっくり: 低ければ差し寄り(B/C)、高ければ先行(A)
  if (s <= 2.0) return ['B','C'];
  if (s >= 3.5) return ['A'];
  // 中間帯は弱いバイアス
  if (s < 2.5) return ['B'];
  if (s > 3.0) return ['A'];
  return [];
}

function scoreHorse(r: Race, h: Horse, roi?: { win: number; place: number }): { score: number; reasons: string[] } {
  let s = 0;
  const reasons: string[] = [];
  const fav = favoredTypesByPace(r);
  if (h.pace_type && fav.length) {
    if (fav.includes('A') && h.pace_type.includes('A')) { s += 2; reasons.push('展開=先行追い風'); }
    if (fav.includes('B') && h.pace_type.includes('B')) { s += 2; reasons.push('展開=差し追い風'); }
    if (fav.includes('C') && h.pace_type.includes('C')) { s += 1; reasons.push('展開=その他追い風'); }
  }
  if (typeof r.pace_score === 'number') {
    if (r.pace_score <= 2.0) { s += 0.5; reasons.push('展開カウント低め'); }
    if (r.pace_score >= 3.5) { s += 0.25; reasons.push('展開カウント高め'); }
    if (r.pace_mark) { s += 0.5; reasons.push('展開★'); }
  }
  // ROI重み（場×馬場×タイプ）: place優先で0.2〜0.6加点
  if (roi) {
    const w = Math.max(0, Math.min(1, (roi.place - 1))); // 1.0をフラットにして超過分を加点
    const add = 0.2 + Math.min(0.4, w * 0.6);
    if (add > 0) { s += add; reasons.push(`ROI補正(+${add.toFixed(2)})`); }
  }
  return { score: s, reasons };
}

function buildRecommendations(day: RaceDay): DayReco {
  const out: RaceReco[] = [];
  const ROI_WIN_MIN = Number(process.env.ROI_WIN_MIN ?? '1.0');
  const ROI_PLACE_MIN = Number(process.env.ROI_PLACE_MIN ?? '1.0');
  const bt = loadBacktest();
  for (const m of day.meetings) {
    for (const r of m.races) {
      if (!r.horses || r.horses.length === 0) continue;
      const fav = favoredTypesByPace(r);
      const favType = fav[0];
      const roiKey = `${trackCodeOf(m.track)}:${r.ground}:${favType??''}`;
      const roi = favType ? bt.get(roiKey) : undefined;
      const scored = r.horses.map((h) => {
        const sc = scoreHorse(r, h, roi);
        const p = impliedProb(h.odds);
        const vi = typeof p === 'number' ? (sc.score > 0 ? sc.score / Math.max(p, 0.01) : 0) : 0;
        return { h, score: sc.score, reasons: sc.reasons, vi };
      });
      // ソート（まずscore、次にVI、最後に人気の低い方を優先）
      scored.sort((a,b)=> (b.score - a.score) || (b.vi - a.vi) || ((a.h.popularity ?? 999) - (b.h.popularity ?? 999)) );

      const notes: string[] = [];
      const win: number[] = [];
      const place: number[] = [];
      const top = scored.slice(0, 5);
      for (const x of top) {
        if (x.score >= 2) {
          const oddsOk = typeof x.h.odds === 'number' ? (x.h.odds >= 2.0 && x.h.odds <= 25) : false;
          if (oddsOk && win.length < 2) win.push(x.h.num);
        }
        if (x.score >= 1.5 && place.length < 3) place.push(x.h.num);
      }
      // Quinella: 上位スコアから最大3頭ボックス
      const quinella_box = scored.filter(x=>x.score>=1.5).slice(0,3).map(x=>x.h.num);

      // ROIしきい値による推奨ゲーティング（満たさない場合は完全に無表示）
      const winOk = roi ? roi.win >= ROI_WIN_MIN : false;
      const placeOk = roi ? roi.place >= ROI_PLACE_MIN : false;
      const finalWin = winOk ? win : undefined;
      const finalPlace = placeOk ? place : undefined;
      const showAny = (finalWin && finalWin.length>0) || (finalPlace && finalPlace.length>0);
      const finalBox = showAny ? (quinella_box.length>=2 ? quinella_box : undefined) : undefined;

      // 三連単は「Aが不在のときは空欄」。Aが1頭以上いる時だけ計算・表示
      const allowed = loadTrifectaBacktest(1.0);
      const tfCounts = new Map<string, number>();
      const A = scored.filter(x=>x.h.pace_type?.includes('A')).sort((a,b)=>b.score-a.score).slice(0,3).map(x=>x.h.num);
      const B = scored.filter(x=>x.h.pace_type?.includes('B')).sort((a,b)=>b.score-a.score).slice(0,4).map(x=>x.h.num);
      const C = scored.filter(x=>x.h.pace_type?.includes('C') || !x.h.pace_type).sort((a,b)=>b.score-a.score).slice(0,4).map(x=>x.h.num);
      const hasA = A.length > 0;
      if (hasA) {
        const BC = Array.from(new Set([...B, ...C]));
        const ABC = Array.from(new Set([...A, ...B, ...C]));
        const addCount = (tag: string, i:number,j:number,k:number) => { if (i!==j && j!==k && i!==k) tfCounts.set(tag, (tfCounts.get(tag)||0)+1); };
        const capTag = (tag: string, max=100) => { const v=tfCounts.get(tag)||0; if (v>max) tfCounts.set(tag, max); };
        for (const row of allowed) {
          if (A.length < row.aN && /A/.test(row.pattern)) continue;
          if (B.length < row.bN && /B/.test(row.pattern)) continue;
          if (C.length < row.cN && /C/.test(row.pattern)) continue;
          const tag = `${row.pattern}`;
          const cap = row.cap || 100;
          if (row.pattern==='A-A-BC') { for (let x of A.slice(0,row.aN)) for (let y of A.slice(0,row.aN)) if (y!==x) for (let z of BC.slice(0,row.cN)) addCount(tag,x,y,z); capTag(tag,cap); }
          else if (row.pattern==='A-BC-ABC') { for (let x of A.slice(0,row.aN)) for (let y of BC.slice(0,row.bN)) for (let z of ABC.slice(0, Math.max(row.aN,row.bN,row.cN))) addCount(tag,x,y,z); capTag(tag,cap); }
          else if (row.pattern==='BC-A-BC') { for (let x of BC.slice(0,row.bN)) for (let y of A.slice(0,row.aN)) for (let z of BC.slice(0,row.cN)) addCount(tag,x,y,z); capTag(tag,cap); }
          // B系やC系は推奨しない方針のため集計しない
        }
      }
      const trifecta_summary = Array.from(tfCounts.entries()).filter(([,v])=>v>0).map(([pattern,points])=>({pattern,points}));
      const finalTrifectaSummary = hasA && trifecta_summary.length>0 ? trifecta_summary : undefined;

      if (showAny) {
        if (typeof r.pace_score === 'number') notes.push(`展開カウント: ${r.pace_score}${r.pace_mark ?? ''}`);
        if (fav.length) notes.push(`展開タイプ: ${fav.join('/')}`);
        if (roi && favType) notes.push(`過去3年ROI(${m.track}/${r.ground}/${favType}): 単${roi.win.toFixed(2)} 複${roi.place.toFixed(2)}`);
      }

      const trifecta_picks = hasA && finalTrifectaSummary ? { A: A.length?A:undefined, B: B.length?B:undefined, C: C.length?C:undefined } : undefined;
      out.push({ track: m.track, no: r.no, win: finalWin && finalWin.length?finalWin:undefined, place: finalPlace && finalPlace.length?finalPlace:undefined, quinella_box: finalBox, trifecta_summary: finalTrifectaSummary, trifecta_picks, notes: showAny && notes.length?notes:undefined });
    }
  }
  return { date: day.date, races: out };
}

function writeReco(day: DayReco) {
  const outDir = path.join(process.cwd(), 'data', 'reco');
  ensureDir(outDir);
  const file = path.join(outDir, `${day.date}.json`);
  fs.writeFileSync(file, JSON.stringify(day, null, 2));
  // 公開用にも反映
  const pubDir = path.join(process.cwd(), 'public', 'data');
  ensureDir(pubDir);
  fs.copyFileSync(file, path.join(pubDir, `reco-${day.date}.json`));
  console.log(`wrote ${file} and public/data/reco-${day.date}.json`);
}

function readDay(isoDate: string): RaceDay {
  const p = path.join(process.cwd(), 'data', 'days', `${isoDate}.json`);
  const j = JSON.parse(fs.readFileSync(p, 'utf8')) as RaceDay;
  return j;
}

function trackCodeOf(trackName: string): string {
  // JYOコード: 01札幌,02函館,03福島,04新潟,05東京,06中山,07中京,08京都,09阪神,10小倉
  const m: Record<string,string> = { '札幌':'01','函館':'02','福島':'03','新潟':'04','東京':'05','中山':'06','中京':'07','京都':'08','阪神':'09','小倉':'10' };
  return m[trackName] || trackName;
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (cmd === 'day') {
    const ymd = args[1];
    if (!ymd || !/^\d{8}$/.test(ymd)) {
      console.error('Usage: tsx scripts/analytics/build-ev.ts day YYYYMMDD');
      process.exit(1);
    }
    const iso = toIso(ymd);
    const day = readDay(iso);
    const reco = buildRecommendations(day);
    writeReco(reco);
    return;
  }
  if (cmd === 'latest') {
    // 最新N件（data/daysから）
    const n = Math.max(1, Number(args[1]||'1')||1);
    const daysDir = path.join(process.cwd(), 'data', 'days');
    const files = fs.readdirSync(daysDir).filter(f=>/\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(-n);
    for (const f of files) {
      const day = readDay(path.basename(f, '.json'));
      const reco = buildRecommendations(day);
      writeReco(reco);
    }
    return;
  }
  console.error('Usage: build-ev.ts [day YYYYMMDD|latest N]');
  process.exit(1);
}

main().catch((e)=>{ console.error(e); process.exit(1); });


