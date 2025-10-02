import fs from 'node:fs';
import path from 'node:path';

type Row = {
  market: 'umaren'|'wide';
  pair: 'AA'|'AB'|'AC'|'BB'|'BC'|'CC';
  A?: string;
  B: string;
  C?: string;
  cap: string;
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
    .sort();
  return files.length ? path.join(dir, files[files.length-1]) : null;
}

function toCsv(rows: Row[]): string {
  const header = ['market','pair','A','B','C','cap','jyo','ground','bias','points','stake','ret','roi','hit','races'];
  const esc = (v: any) => {
    const s = v==null ? '' : String(v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const lines: string[] = [];
  lines.push(header.join(','));
  for (const r of rows) {
    const bias = typeof r.bias_flag === 'boolean' ? (r.bias_flag ? '1' : '0') : '';
    const rowVals = [
      r.market,
      r.pair,
      r.A ?? '',
      r.B ?? '',
      r.C ?? '',
      r.cap,
      r.jyo ?? '',
      r.ground ?? '',
      bias,
      String(r.points ?? ''),
      String(r.stake ?? ''),
      String(r.ret ?? ''),
      String(r.roi ?? ''),
      String(r.hit ?? ''),
      String(r.races ?? ''),
    ];
    lines.push(rowVals.map(esc).join(','));
  }
  return lines.join('\n') + '\n';
}

function main() {
  const outDir = path.join(process.cwd(), 'data', 'analytics');
  const latest = findLatestFile(outDir, 'pairs-backtest');
  if (!latest) {
    console.error('No pairs-backtest-YYYY-MM-DD.json found in data/analytics');
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(latest, 'utf-8')) as { rows: Row[] };
  const rows = [...(raw.rows || [])];
  const csv = toCsv(rows);
  const outPath = path.join(outDir, 'pairs-backtest-latest.csv');
  fs.writeFileSync(outPath, csv);
  console.log(`# Wrote: ${outPath}`);
}

main();


