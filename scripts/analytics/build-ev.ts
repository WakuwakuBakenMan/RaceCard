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
type PositionBiasForGround = {
  pace: {
    win_place?: { target: 'A'|'B'|'C'|null };
    quinella?: { target: 'A'|'B'|'C'|null };
    longshot?: { target: 'A'|'B'|'C'|null };
  };
  draw?: { target: 'inner'|'outer'|null };
};
type Meeting = {
  track: string;
  kaiji: number;
  nichiji: number;
  races: Race[];
  position_bias?: Record<string, PositionBiasForGround>;
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

function drawKey(draw: number): 'inner'|'outer'|null {
  if (draw >= 1 && draw <= 4) return 'inner';
  if (draw >= 5 && draw <= 8) return 'outer';
  return null;
}

function pickPaceTarget(b?: PositionBiasForGround['pace']): 'A'|'B'|'C'|null {
  if (!b) return null;
  return (b.win_place?.target ?? b.quinella?.target ?? b.longshot?.target ?? null) as any;
}

function scoreHorse(r: Race, h: Horse, bias?: PositionBiasForGround): { score: number; reasons: string[] } {
  let s = 0;
  const reasons: string[] = [];
  // 1) 脚質バイアス一致
  const t = pickPaceTarget(bias?.pace);
  if (t && h.pace_type && h.pace_type.includes(t)) { s += 2; reasons.push(`脚質一致(${t})`); }
  // 2) 枠バイアス一致
  const dk = drawKey(h.draw);
  if (bias?.draw?.target && dk && bias.draw.target === dk) { s += 1; reasons.push(`枠一致(${dk==='inner'?'内':'外'})`); }
  // 3) 極端な展開カウント（低いほど波乱寄りと仮定）
  if (typeof r.pace_score === 'number') {
    if (r.pace_score <= 2.0) { s += 0.5; reasons.push('展開カウント低め'); }
    if (r.pace_mark) { s += 0.5; reasons.push('展開★'); }
  }
  return { score: s, reasons };
}

function buildRecommendations(day: RaceDay): DayReco {
  const out: RaceReco[] = [];
  for (const m of day.meetings) {
    for (const r of m.races) {
      if (!r.horses || r.horses.length === 0) continue;
      const bias = m.position_bias?.[r.ground];
      const scored = r.horses.map((h) => {
        const sc = scoreHorse(r, h, bias);
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
      if (bias?.pace?.win_place?.target) notes.push(`当日バイアス: 脚${bias.pace.win_place.target}`);
      if (bias?.draw?.target) notes.push(`当日バイアス: ${bias.draw.target==='inner'?'内':'外'}`);

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


