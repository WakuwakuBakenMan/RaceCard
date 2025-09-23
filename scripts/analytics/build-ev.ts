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
  notes?: string[];
};
type DayReco = { date: string; races: RaceReco[] };

function ensureDir(p: string) { fs.mkdirSync(p, { recursive: true }); }

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

function scoreHorse(r: Race, h: Horse): { score: number; reasons: string[] } {
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
  return { score: s, reasons };
}

function buildRecommendations(day: RaceDay): DayReco {
  const out: RaceReco[] = [];
  for (const m of day.meetings) {
    for (const r of m.races) {
      if (!r.horses || r.horses.length === 0) continue;
      const scored = r.horses.map((h) => {
        const sc = scoreHorse(r, h);
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
          // Win 候補: 一致強め + 妙味（ざっくり）
          const oddsOk = typeof x.h.odds === 'number' ? (x.h.odds >= 2.0 && x.h.odds <= 25) : false;
          if (oddsOk && win.length < 2) win.push(x.h.num);
        }
        if (x.score >= 1.5 && place.length < 3) place.push(x.h.num);
      }
      // Quinella: 上位スコアから最大3頭ボックス
      const quinella_box = scored.filter(x=>x.score>=1.5).slice(0,3).map(x=>x.h.num);
      if (typeof r.pace_score === 'number') notes.push(`展開カウント: ${r.pace_score}${r.pace_mark ?? ''}`);
      const fav = favoredTypesByPace(r);
      if (fav.length) notes.push(`展開タイプ: ${fav.join('/')}`);

      out.push({ track: m.track, no: r.no, win: win.length?win:undefined, place: place.length?place:undefined, quinella_box: quinella_box.length>=2?quinella_box:undefined, notes: notes.length?notes:undefined });
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


