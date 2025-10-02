import fs from 'node:fs';
import path from 'node:path';

type Row = {
  market: 'umaren'|'wide';
  pair: 'AA'|'AB'|'AC'|'BB'|'BC'|'CC';
  A?: string; // e.g., A2
  B: string;  // e.g., B3
  C: string;  // e.g., C3
  cap: string; // capN
  points: number;
  stake: number;
  ret: number;
  roi: number;
  hit: number;
  races: number;
  jyo?: string;
  ground?: string;
  bias_flag?: boolean;
};

function findLatestFile(dir: string, prefix: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter((f) => new RegExp(`^${prefix}-\\d{4}-\\d{2}-\\d{2}\\.json$`).test(f))
    .sort((a, b) => (a < b ? 1 : -1));
  return files[0] ? path.join(dir, files[0]) : null;
}

function formatNumber(n: number): string { return n.toLocaleString('ja-JP'); }
function formatRoi(n: number): string { return (Math.round(n * 1000) / 1000).toFixed(3); }

function toMarkdown(rows: Row[]): string {
  const header = ['market','pair','A','B','C','cap','jyo','ground','bias','points','stake','ret','roi','hit','races'];
  const lines: string[] = [];
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`| ${header.map(()=>'-').join(' | ')} |`);
  for (const r of rows) {
    const bias = typeof r.bias_flag === 'boolean' ? (r.bias_flag ? '1' : '0') : '';
    lines.push(`| ${r.market} | ${r.pair} | ${r.A??''} | ${r.B} | ${r.C} | ${r.cap} | ${r.jyo??''} | ${r.ground??''} | ${bias} | ${formatNumber(r.points)} | ${formatNumber(r.stake)} | ${formatNumber(r.ret)} | ${formatRoi(r.roi)} | ${formatNumber(r.hit)} | ${formatNumber(r.races)} |`);
  }
  return lines.join('\n');
}

function main() {
  const outDir = path.join(process.cwd(), 'data', 'analytics');
  const latest = findLatestFile(outDir, 'pairs-backtest');
  if (!latest) {
    console.error('No pairs-backtest-YYYY-MM-DD.json found in data/analytics');
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(latest, 'utf-8')) as { rows: Row[] };
  // Sort by ROI desc then ret desc
  const rows = [...(raw.rows || [])].sort((a, b) => (b.roi - a.roi) || (b.ret - a.ret));
  const md = toMarkdown(rows);
  const outPath = path.join(outDir, 'pairs-backtest-latest.md');
  fs.writeFileSync(outPath, md + '\n');
  console.log(`# Source: ${path.basename(latest)}`);
  console.log(md);
}

main();


