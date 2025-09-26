import fs from 'node:fs';
import path from 'node:path';

type Row = {
  pattern: string;
  A: string;
  B: string;
  C: string;
  cap: string;
  points: number;
  stake: number;
  ret: number;
  roi: number;
  hit: number;
  races: number;
};

function findLatestBacktestFile(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter((f) => /^trifecta-backtest-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort((a, b) => (a < b ? 1 : -1));
  return files[0] ? path.join(dir, files[0]) : null;
}

function formatNumber(n: number): string { return n.toLocaleString('ja-JP'); }
function formatRoi(n: number): string { return (Math.round(n * 1000) / 1000).toFixed(3); }

function toMarkdown(rows: Row[]): string {
  const header = ['pattern','A','B','C','cap','points','stake','ret','roi','hit','races'];
  const lines: string[] = [];
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`| ${header.map(()=>'-').join(' | ')} |`);
  for (const r of rows) {
    lines.push(`| ${r.pattern} | ${r.A} | ${r.B} | ${r.C} | ${r.cap} | ${formatNumber(r.points)} | ${formatNumber(r.stake)} | ${formatNumber(r.ret)} | ${formatRoi(r.roi)} | ${formatNumber(r.hit)} | ${formatNumber(r.races)} |`);
  }
  return lines.join('\n');
}

function main() {
  const outDir = path.join(process.cwd(), 'data', 'analytics');
  const latest = findLatestBacktestFile(outDir);
  if (!latest) {
    console.error('No trifecta-backtest-YYYY-MM-DD.json found in data/analytics');
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(latest, 'utf-8')) as { rows: Row[] };
  // Sort by ROI desc, then stake desc
  const rows = [...(raw.rows || [])].sort((a, b) => (b.roi - a.roi) || (b.stake - a.stake));
  const md = toMarkdown(rows);
  const outPath = path.join(outDir, 'trifecta-backtest-latest.md');
  fs.writeFileSync(outPath, md + '\n');
  console.log(`# Source: ${path.basename(latest)}`);
  console.log(md);
}

main();


