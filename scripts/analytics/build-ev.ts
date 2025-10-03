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
  // trifecta は現状非表示
  trifecta_summary?: undefined;
  trifecta_picks?: undefined;
  notes?: string[];
};
type DayReco = { date: string; races: RaceReco[] };

function ensureDir(p: string) { fs.mkdirSync(p, { recursive: true }); }
type PaceBackRow = { track_code: string; ground: string; type: 'A'|'B'|'C'; win_roi: number; place_roi: number };
type PaceBack = { rows: PaceBackRow[] };
type TriRow = { pattern: string; A: string; B: string; C: string; cap: string; roi: number };

type PairRow = {
  market: 'umaren'|'wide';
  pair: 'AA'|'AB'|'BB';
  A?: string;
  B: string;
  cap: string;
  roi: number;
  races: number;
  jyo?: string;
  ground?: string;
  bias_flag?: boolean;
};

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

// trifecta backtest は未使用（非表示）
function loadTrifectaBacktest(_minRoi = 1.0) { return [] as any[]; }

function findLatestAnalytics(prefix: string): string | null {
  const dir = path.join(process.cwd(), 'data', 'analytics');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f=>new RegExp(`^${prefix}-\\d{4}-\\d{2}-\\d{2}\\.json$`).test(f)).sort();
  if (files.length === 0) return null;
  return path.join(dir, files[files.length-1]);
}

function loadPairsBacktestAll(): Map<string, PairRow[]> {
  const latest = findLatestAnalytics('pairs-backtest');
  const out = new Map<string, PairRow[]>();
  if (!latest) return out;
  try{
    const j = JSON.parse(fs.readFileSync(latest, 'utf8')) as { rows: PairRow[] };
    const rows = (j.rows||[]).filter(r=>r.market==='umaren' && typeof r.roi==='number');
    for (const r of rows) {
      const key = `${r.jyo??''}:${r.ground??''}:${r.bias_flag ? '1' : '0'}`;
      const arr = out.get(key) || [];
      arr.push(r);
      out.set(key, arr);
    }
    for (const [k, arr] of out) arr.sort((a,b)=> (b.roi - a.roi) || (b.races - a.races));
  } catch {}
  return out;
}

function parseN(tag?: string): number { return Number(String(tag||'').replace(/^[A-Z]/i,'').trim()) || 0; }

function isPairFeasible(row: PairRow, aCount: number, bCount: number): boolean {
  const aN = parseN(row.A);
  const bN = parseN(row.B);
  if (row.pair === 'AA') return aCount >= 2;
  if (row.pair === 'AB') return aCount >= aN && bCount >= bN;
  if (row.pair === 'BB') return bCount >= 2 && bCount >= bN;
  return false;
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
  const pairsMap = loadPairsBacktestAll();
  // Win odds band configuration
  const WIN_ODDS_MIN = Number(process.env.ROI_WIN_ODDS_MIN ?? '2.0');
  const WIN_ODDS_MAX = Number(process.env.ROI_WIN_ODDS_MAX ?? '25');
  const NO_WIN_ODDS_CUT = process.env.WIN_ODDS_NO_CUT === '1';
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
          const oddsOk = ((): boolean => {
            if (typeof x.h.odds !== 'number') return false;
            if (NO_WIN_ODDS_CUT) return true; // no band cut
            return x.h.odds >= WIN_ODDS_MIN && x.h.odds <= WIN_ODDS_MAX;
          })();
          if (oddsOk && win.length < 2) win.push(x.h.num);
        }
        if (x.score >= 1.5 && place.length < 3) place.push(x.h.num);
      }
      // Quinella: 上位スコアから最大3頭ボックス
      const quinella_box = scored.filter(x=>x.score>=1.5).slice(0,3).map(x=>x.h.num);

      // ROIしきい値による推奨ゲーティング（>1.00厳格）。フォールバックは行わない。
      const winOk = roi ? roi.win > Math.max(1.0, ROI_WIN_MIN) : false;
      const placeOk = roi ? roi.place > Math.max(1.0, ROI_PLACE_MIN) : false;
      const finalWin = winOk ? win : undefined;
      const finalPlace = placeOk ? place : undefined;
      const showAny = (finalWin && finalWin.length>0) || (finalPlace && finalPlace.length>0);
      // 馬連BOXは ROI>1.00 の推奨がある場合のみ表示
      let finalBox: number[] | undefined = undefined;

      // 三連単は非表示
      const finalTrifectaSummary = undefined;

      // 馬連（ペア）推奨メモ: (jyo, ground, bias) 層別の最上位を適用
      const jyoCode = trackCodeOf(m.track);
      const ground = r.ground;
      const biasFlag = (typeof r.pace_score === 'number') && (r.pace_score <= 4.0) && (r.pace_score !== -3.5);
      const key = `${jyoCode}:${ground}:${biasFlag ? '1' : '0'}`;
      const cand = pairsMap.get(key) || [];
      const aCount = r.horses.filter(h=>h.pace_type?.includes('A')).length;
      const bCount = r.horses.filter(h=>h.pace_type?.includes('B')).length;
      const feasible = cand.filter(row=>isPairFeasible(row, aCount, bCount));
      const bestReco = feasible.find(row=>row.roi > 1.0);
      if (bestReco) {
        const roiStr = bestReco.roi.toFixed(2);
        const aTag = bestReco.A ? `${bestReco.A}/` : '';
        notes.push(`推奨: 馬連 ${bestReco.pair} ${aTag}${bestReco.B} ${bestReco.cap} ROI${roiStr} n=${bestReco.races}`);
        if (quinella_box.length>=2) finalBox = quinella_box;
      }
      // 準推奨・参考BOXは出さない（bestRecoが無い場合はBOX非表示）

      if (showAny) {
        if (typeof r.pace_score === 'number') notes.push(`展開カウント: ${r.pace_score}${r.pace_mark ?? ''}`);
        if (fav.length) notes.push(`展開タイプ: ${fav.join('/')}`);
        if (roi && favType) notes.push(`過去3年ROI(${m.track}/${r.ground}/${favType}): 単${roi.win.toFixed(2)} 複${roi.place.toFixed(2)}`);
      }

      const trifecta_picks = undefined;
      out.push({ track: m.track, no: r.no, win: finalWin && finalWin.length?finalWin:undefined, place: finalPlace && finalPlace.length?finalPlace:undefined, quinella_box: finalBox, trifecta_summary: finalTrifectaSummary, trifecta_picks, notes: (notes.length?notes:undefined) });
    }
  }
  return { date: day.date, races: out };
}

function writeReco(day: DayReco) {
  // 要件: 出馬表と同様に data/days 配下へ reco-YYYY-MM-DD.json として保存
  const outDir = path.join(process.cwd(), 'data', 'days');
  ensureDir(outDir);
  const file = path.join(outDir, `reco-${day.date}.json`);
  fs.writeFileSync(file, JSON.stringify(day, null, 2));
  console.log(`wrote ${file}`);
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
    const files = fs.readdirSync(daysDir).filter(f=>/^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(-n);
    for (const f of files) {
      const day = readDay(path.basename(f, '.json'));
      if (!day || !Array.isArray((day as any).meetings)) {
        // 予期しない構造（念のため保険）
        continue;
      }
      const reco = buildRecommendations(day);
      writeReco(reco);
    }
    return;
  }
  console.error('Usage: build-ev.ts [day YYYYMMDD|latest N]');
  process.exit(1);
}

main().catch((e)=>{ console.error(e); process.exit(1); });


